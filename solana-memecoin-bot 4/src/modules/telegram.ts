// ===========================================
// MODULE 5: TELEGRAM ALERT SYSTEM (rossybot)
// ===========================================

import TelegramBot from 'node-telegram-bot-api';
import { appConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { Database } from '../utils/database.js';
import {
  BuySignal,
  KolWalletActivity,
  TokenScore,
  WalletType,
  Position,
} from '../types/index.js';

// ============ RATE LIMITING ============

const RATE_LIMITS = {
  MAX_SIGNALS_PER_HOUR: appConfig.trading.maxSignalsPerHour,
  MAX_SIGNALS_PER_DAY: appConfig.trading.maxSignalsPerDay,
  TOKEN_COOLDOWN_MS: 4 * 60 * 60 * 1000, // 4 hours
  KOL_COOLDOWN_MS: 2 * 60 * 60 * 1000, // 2 hours
} as const;

// ============ TELEGRAM BOT CLASS ============

export class TelegramAlertBot {
  private bot: TelegramBot | null = null;
  private chatId: string;
  private signalQueue: BuySignal[] = [];
  private lastKolSignalTime: Map<string, number> = new Map();
  
  constructor() {
    this.chatId = appConfig.telegramChatId;
  }
  
  /**
   * Initialize the bot
   */
  async initialize(): Promise<void> {
    if (!appConfig.telegramBotToken) {
      logger.warn('Telegram bot token not configured - alerts disabled');
      return;
    }
    
    this.bot = new TelegramBot(appConfig.telegramBotToken, { polling: true });
    
    // Set up command handlers
    this.setupCommands();
    
    logger.info('Telegram bot (rossybot) initialized');
  }
  
  /**
   * Set up bot commands
   */
  private setupCommands(): void {
    if (!this.bot) return;
    
    // /start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot!.sendMessage(chatId, 
        '🤖 *rossybot* initialized!\n\n' +
        'You will receive memecoin buy signals here.\n\n' +
        'Commands:\n' +
        '/status - Current portfolio status\n' +
        '/positions - Open positions\n' +
        '/pause - Pause signals\n' +
        '/resume - Resume signals\n' +
        '/help - Show this help',
        { parse_mode: 'Markdown' }
      );
      
      // Log chat ID for configuration
      logger.info({ chatId }, 'User started bot - save this chat_id');
    });
    
    // /status command
    this.bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      await this.sendStatusUpdate(chatId.toString());
    });
    
    // /positions command
    this.bot.onText(/\/positions/, async (msg) => {
      const chatId = msg.chat.id;
      await this.sendPositionsUpdate(chatId.toString());
    });
    
    // /help command
    this.bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot!.sendMessage(chatId,
        '📖 *rossybot Help*\n\n' +
        '*Commands:*\n' +
        '/status - Portfolio summary and queued signals\n' +
        '/positions - List all open positions with P&L\n' +
        '/pause - Temporarily stop receiving signals\n' +
        '/resume - Resume signal delivery\n' +
        '/help - Show this message\n\n' +
        '*Signal Format:*\n' +
        'Each buy signal includes:\n' +
        '• Token details and metrics\n' +
        '• Confirmed KOL wallet activity\n' +
        '• Entry/exit recommendations\n' +
        '• Risk assessment\n\n' +
        '⚠️ DYOR. Not financial advice.',
        { parse_mode: 'Markdown' }
      );
    });
  }
  
  /**
   * Send a buy signal alert
   */
  async sendBuySignal(signal: BuySignal): Promise<boolean> {
    if (!this.bot) {
      logger.warn('Bot not initialized - cannot send signal');
      return false;
    }
    
    // Check rate limits
    const rateLimitResult = await this.checkRateLimits(signal);
    if (!rateLimitResult.allowed) {
      logger.info({ reason: rateLimitResult.reason, tokenAddress: signal.tokenAddress }, 
        'Signal blocked by rate limit');
      this.signalQueue.push(signal);
      return false;
    }
    
    try {
      const message = this.formatBuySignal(signal);
      
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
      
      // Log the signal
      await Database.logSignal(
        signal.tokenAddress,
        signal.signalType,
        signal.score.compositeScore,
        signal.kolActivity.kol.handle
      );
      
      // Update KOL cooldown
      this.lastKolSignalTime.set(signal.kolActivity.kol.handle, Date.now());
      
      logger.info({
        tokenAddress: signal.tokenAddress,
        ticker: signal.tokenTicker,
        score: signal.score.compositeScore,
        kol: signal.kolActivity.kol.handle,
      }, 'Buy signal sent');
      
      return true;
    } catch (error) {
      logger.error({ error, signal: signal.tokenAddress }, 'Failed to send Telegram alert');
      return false;
    }
  }
  
  /**
   * Format buy signal message
   */
  private formatBuySignal(signal: BuySignal): string {
    const { kolActivity, score, tokenMetrics, socialMetrics, scamFilter } = signal;
    const wallet = kolActivity.wallet;
    const tx = kolActivity.transaction;
    const perf = kolActivity.performance;
    
    // Build the message
    let msg = `🎯 *ROSSYBOT BUY SIGNAL*\n\n`;
    
    // Token info
    msg += `*Token:* \`$${signal.tokenTicker}\` (${this.truncateAddress(signal.tokenAddress)})\n`;
    msg += `*Chain:* Solana\n\n`;
    
    // Signal metrics
    msg += `📊 *SIGNAL METRICS*\n`;
    msg += `├─ Composite Score: *${score.compositeScore}/100*\n`;
    msg += `├─ Confidence: *${score.confidence}*\n`;
    msg += `├─ Risk Level: *${score.riskLevel}/5*\n`;
    msg += `└─ Signal Type: KOL\\_CONFIRMED\n\n`;
    
    // KOL Wallet Activity (MANDATORY)
    msg += `👛 *KOL WALLET ACTIVITY*\n`;
    msg += `├─ Status: ✅ CONFIRMED BUY DETECTED\n`;
    msg += `├─ KOL: @${kolActivity.kol.handle}\n`;
    msg += `├─ KOL Tier: ${kolActivity.kol.tier}\n`;
    msg += `├─ *Wallet Type: ${wallet.walletType === WalletType.MAIN ? '🟢 MAIN WALLET' : '🟡 SIDE WALLET'}*\n`;
    msg += `├─ Wallet: \`${this.truncateAddress(wallet.address)}\`\n`;
    msg += `├─ Buy Amount: ${tx.solAmount.toFixed(2)} SOL ($${tx.usdValue.toFixed(0)})\n`;
    msg += `├─ Tokens: ${this.formatNumber(tx.tokensAcquired)} (${tx.supplyPercent.toFixed(2)}%)\n`;
    msg += `├─ TX: \`${this.truncateAddress(tx.signature)}\`\n`;
    msg += `├─ Time: ${tx.timestamp.toISOString().replace('T', ' ').slice(0, 19)} UTC\n`;
    msg += `└─ KOL Accuracy: ${(perf.winRate * 100).toFixed(0)}% (${perf.totalTrades} trades)\n\n`;
    
    // Side wallet attribution (if applicable)
    if (wallet.walletType === WalletType.SIDE) {
      msg += `🔗 *WALLET ATTRIBUTION*\n`;
      msg += `├─ Confidence: *${wallet.attributionConfidence}*\n`;
      msg += `├─ Link Method: ${wallet.linkMethod}\n`;
      msg += `└─ Notes: ${wallet.notes || 'N/A'}\n\n`;
    }
    
    // On-chain data
    msg += `📈 *ON-CHAIN DATA*\n`;
    msg += `├─ Price: $${this.formatPrice(tokenMetrics.price)}\n`;
    msg += `├─ Market Cap: $${this.formatNumber(tokenMetrics.marketCap)}\n`;
    msg += `├─ 24h Volume: $${this.formatNumber(tokenMetrics.volume24h)}\n`;
    msg += `├─ Holders: ${tokenMetrics.holderCount} (${tokenMetrics.holderChange1h >= 0 ? '+' : ''}${tokenMetrics.holderChange1h}% 1h)\n`;
    msg += `├─ Top 10: ${tokenMetrics.top10Concentration.toFixed(1)}%\n`;
    msg += `├─ Vol Auth: ${signal.volumeAuthenticity.score}/100\n`;
    msg += `└─ Bundle Risk: ${scamFilter.bundleAnalysis.riskLevel === 'LOW' ? '🟢 CLEAR' : scamFilter.bundleAnalysis.riskLevel === 'MEDIUM' ? '🟡 FLAGGED' : '🔴 HIGH'}\n\n`;
    
    // Social signals
    msg += `🐦 *SOCIAL SIGNALS*\n`;
    msg += `├─ X Mentions (1h): ${socialMetrics.mentionVelocity1h}\n`;
    msg += `├─ Other KOLs: ${socialMetrics.kolMentions.length > 0 ? socialMetrics.kolMentions.slice(0, 3).join(', ') : 'None'}\n`;
    msg += `├─ Sentiment: ${socialMetrics.sentimentPolarity > 0.3 ? '🟢 POSITIVE' : socialMetrics.sentimentPolarity > -0.3 ? '🟡 NEUTRAL' : '🔴 NEGATIVE'}\n`;
    msg += `└─ Narrative: ${socialMetrics.narrativeFit || 'N/A'}\n\n`;
    
    // Suggested action
    msg += `⚡ *SUGGESTED ACTION*\n`;
    msg += `├─ Entry Zone: $${this.formatPrice(signal.entryZone.low)} - $${this.formatPrice(signal.entryZone.high)}\n`;
    msg += `├─ Position Size: ${signal.positionSizePercent}% of portfolio\n`;
    msg += `├─ Stop Loss: $${this.formatPrice(signal.stopLoss.price)} (-${signal.stopLoss.percent}%)\n`;
    msg += `├─ Take Profit 1: $${this.formatPrice(signal.takeProfit1.price)} (+${signal.takeProfit1.percent}%)\n`;
    msg += `├─ Take Profit 2: $${this.formatPrice(signal.takeProfit2.price)} (+${signal.takeProfit2.percent}%)\n`;
    msg += `└─ Time Limit: ${signal.timeLimitHours}h max hold\n\n`;
    
    // Flags
    if (score.flags.length > 0) {
      msg += `⚠️ *FLAGS:* ${score.flags.join(', ')}\n\n`;
    }
    
    // Links
    msg += `🔗 *Links:*\n`;
    msg += `[Birdeye](https://birdeye.so/token/${signal.tokenAddress}?chain=solana) | `;
    msg += `[DexScreener](https://dexscreener.com/solana/${signal.tokenAddress}) | `;
    msg += `[Solscan](https://solscan.io/token/${signal.tokenAddress}) | `;
    msg += `[KOL Wallet](https://solscan.io/account/${wallet.address})\n\n`;
    
    // Footer
    msg += `⏱️ _Signal: ${signal.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;
    msg += `⚠️ _DYOR. Not financial advice. KOL buys ≠ guaranteed profits._`;
    
    return msg;
  }
  
  /**
   * Check rate limits before sending
   */
  private async checkRateLimits(signal: BuySignal): Promise<{ allowed: boolean; reason?: string }> {
    // Check hourly limit
    const hourlyCount = await Database.getRecentSignalCount(1);
    if (hourlyCount >= RATE_LIMITS.MAX_SIGNALS_PER_HOUR) {
      return { allowed: false, reason: 'Hourly signal limit reached' };
    }
    
    // Check daily limit
    const dailyCount = await Database.getRecentSignalCount(24);
    if (dailyCount >= RATE_LIMITS.MAX_SIGNALS_PER_DAY) {
      return { allowed: false, reason: 'Daily signal limit reached' };
    }
    
    // Check token cooldown
    const lastTokenSignal = await Database.getLastSignalTime(signal.tokenAddress);
    if (lastTokenSignal) {
      const timeSince = Date.now() - lastTokenSignal.getTime();
      if (timeSince < RATE_LIMITS.TOKEN_COOLDOWN_MS) {
        return { allowed: false, reason: 'Token cooldown active' };
      }
    }
    
    // Check KOL cooldown
    const lastKolTime = this.lastKolSignalTime.get(signal.kolActivity.kol.handle);
    if (lastKolTime) {
      const timeSince = Date.now() - lastKolTime;
      if (timeSince < RATE_LIMITS.KOL_COOLDOWN_MS) {
        return { allowed: false, reason: 'KOL cooldown active' };
      }
    }
    
    return { allowed: true };
  }
  
  /**
   * Send status update
   */
  async sendStatusUpdate(chatId: string): Promise<void> {
    if (!this.bot) return;
    
    const hourlyCount = await Database.getRecentSignalCount(1);
    const dailyCount = await Database.getRecentSignalCount(24);
    const openPositions = await Database.getOpenPositions();
    
    let msg = `📊 *ROSSYBOT STATUS*\n\n`;
    msg += `*Signals Today:* ${dailyCount}/${RATE_LIMITS.MAX_SIGNALS_PER_DAY}\n`;
    msg += `*Signals This Hour:* ${hourlyCount}/${RATE_LIMITS.MAX_SIGNALS_PER_HOUR}\n`;
    msg += `*Queued Signals:* ${this.signalQueue.length}\n`;
    msg += `*Open Positions:* ${openPositions.length}\n\n`;
    
    if (openPositions.length > 0) {
      msg += `*Current Holdings:*\n`;
      for (const pos of openPositions.slice(0, 5)) {
        const pnl = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const emoji = pnl >= 0 ? '🟢' : '🔴';
        msg += `${emoji} $${pos.tokenTicker}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%\n`;
      }
    }
    
    await this.bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  }
  
  /**
   * Send positions update
   */
  async sendPositionsUpdate(chatId: string): Promise<void> {
    if (!this.bot) return;
    
    const positions = await Database.getOpenPositions();
    
    if (positions.length === 0) {
      await this.bot.sendMessage(chatId, '📭 No open positions');
      return;
    }
    
    let msg = `📈 *OPEN POSITIONS*\n\n`;
    
    for (const pos of positions) {
      const pnl = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const emoji = pnl >= 0 ? '🟢' : '🔴';
      const holdTime = Math.round((Date.now() - pos.entryTimestamp.getTime()) / (1000 * 60 * 60));
      
      msg += `${emoji} *$${pos.tokenTicker}*\n`;
      msg += `├─ Entry: $${this.formatPrice(pos.entryPrice)}\n`;
      msg += `├─ Current: $${this.formatPrice(pos.currentPrice)}\n`;
      msg += `├─ P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%\n`;
      msg += `├─ Stop: $${this.formatPrice(pos.stopLoss)}\n`;
      msg += `├─ TP1: $${this.formatPrice(pos.takeProfit1)} ${pos.takeProfit1Hit ? '✅' : ''}\n`;
      msg += `└─ Held: ${holdTime}h\n\n`;
    }
    
    await this.bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  }
  
  /**
   * Send a price alert
   */
  async sendPriceAlert(
    position: Position,
    alertType: 'TP1' | 'TP2' | 'STOP_LOSS' | 'TIME_LIMIT'
  ): Promise<void> {
    if (!this.bot) return;
    
    const pnl = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
    const emoji = alertType.startsWith('TP') ? '🎯' : '🛑';
    
    const msg = `${emoji} *POSITION ALERT: ${alertType}*\n\n` +
      `*Token:* $${position.tokenTicker}\n` +
      `*Entry:* $${this.formatPrice(position.entryPrice)}\n` +
      `*Current:* $${this.formatPrice(position.currentPrice)}\n` +
      `*P&L:* ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%\n\n` +
      `${alertType === 'STOP_LOSS' ? '⚠️ Stop loss triggered - consider exiting' : 
        alertType === 'TIME_LIMIT' ? '⏰ Max hold time reached - review position' :
        '✅ Take profit target reached - consider taking profits'}`;
    
    await this.bot.sendMessage(this.chatId, msg, { parse_mode: 'Markdown' });
  }
  
  /**
   * Send risk alert
   */
  async sendRiskAlert(
    tokenAddress: string,
    ticker: string,
    reason: string
  ): Promise<void> {
    if (!this.bot) return;
    
    const msg = `🚨 *RISK ALERT*\n\n` +
      `*Token:* $${ticker}\n` +
      `*Reason:* ${reason}\n\n` +
      `⚠️ Consider immediate exit`;
    
    await this.bot.sendMessage(this.chatId, msg, { parse_mode: 'Markdown' });
  }
  
  // ============ HELPER METHODS ============
  
  private truncateAddress(address: string): string {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
  
  private formatNumber(num: number): string {
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
    return num.toFixed(2);
  }
  
  private formatPrice(price: number): string {
    if (price >= 1) return price.toFixed(4);
    if (price >= 0.0001) return price.toFixed(6);
    return price.toExponential(4);
  }
}

// ============ EXPORTS ============

export const telegramBot = new TelegramAlertBot();

export default {
  TelegramAlertBot,
  telegramBot,
  RATE_LIMITS,
};
