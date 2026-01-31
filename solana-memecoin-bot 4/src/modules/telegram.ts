// ===========================================
// MODULE 5: TELEGRAM ALERT SYSTEM (rossybot)
// ===========================================

import TelegramBot from 'node-telegram-bot-api';
import { appConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { Database, pool } from '../utils/database.js';
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
  private startTime: Date | null = null;

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
    this.startTime = new Date();

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
        '/status - Bot status & connection health\n' +
        '/positions - Open positions\n' +
        '/test - Send a test signal\n' +
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
        '/status - Bot status, uptime & connection health\n' +
        '/positions - List all open positions with P&L\n' +
        '/test - Send a test signal to verify bot is working\n' +
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

    // /test command - sends a dummy signal to verify bot is working
    this.bot.onText(/\/test/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        // Send initial response
        await this.bot!.sendMessage(chatId, '🔄 Generating test signal...', { parse_mode: 'Markdown' });

        // Send dummy signal
        const testSignal = this.formatTestSignal();
        await this.bot!.sendMessage(chatId, testSignal, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });

        logger.info({ chatId }, 'Test signal sent successfully');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to send test signal');
        await this.bot!.sendMessage(chatId, `❌ Failed to send test signal: ${errorMessage}`);
      }
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
   * Format test signal message
   */
  private formatTestSignal(): string {
    const now = new Date();

    let msg = `🚀 *NEW SIGNAL - TEST*\n\n`;
    msg += `*Token:* DUMMY/SOL\n`;
    msg += `*CA:* \`DuMMyTokenContractAddressHere111111111111\`\n\n`;

    msg += `📊 *Signal Details:*\n`;
    msg += `├─ Action: *BUY*\n`;
    msg += `├─ Entry: $0.00001234\n`;
    msg += `├─ Target: $0.00002468 (+100%)\n`;
    msg += `└─ Stop Loss: $0.00000617 (-50%)\n\n`;

    msg += `💰 *Market Data:*\n`;
    msg += `├─ Market Cap: $50,000\n`;
    msg += `├─ Liquidity: $25,000\n`;
    msg += `└─ 24h Volume: $10,000\n\n`;

    msg += `👛 *Triggered by:* Test Wallet\n`;
    msg += `📈 *KOL Win Rate:* 75%\n\n`;

    msg += `⚠️ _This is a TEST signal - not real trading advice_\n`;
    msg += `⏱️ _Generated: ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC_`;

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

    try {
      const hourlyCount = await Database.getRecentSignalCount(1);
      const dailyCount = await Database.getRecentSignalCount(24);
      const openPositions = await Database.getOpenPositions();
      const trackedWallets = await Database.getAllTrackedWallets();
      const connectionStatus = await this.checkConnections();

      // Calculate uptime
      const uptime = this.startTime ? this.formatUptime(Date.now() - this.startTime.getTime()) : 'Unknown';

      // Get last signal time
      const lastSignalResult = await pool.query(
        'SELECT sent_at FROM signal_log ORDER BY sent_at DESC LIMIT 1'
      );
      const lastSignalTime = lastSignalResult.rows.length > 0
        ? this.formatTimeAgo(lastSignalResult.rows[0].sent_at)
        : 'Never';

      let msg = `📊 *ROSSYBOT STATUS*\n\n`;

      // System info
      msg += `⏱️ *System Info:*\n`;
      msg += `├─ Uptime: ${uptime}\n`;
      msg += `├─ Wallets Tracked: ${trackedWallets.length}\n`;
      msg += `└─ Last Signal: ${lastSignalTime}\n\n`;

      // Connection statuses
      msg += `🔌 *Connections:*\n`;
      msg += `├─ Database: ${connectionStatus.database ? '🟢 Connected' : '🔴 Disconnected'}\n`;
      msg += `├─ Helius: ${connectionStatus.helius ? '🟢 Connected' : '🔴 Disconnected'}\n`;
      msg += `└─ Birdeye: ${connectionStatus.birdeye ? '🟢 Connected' : '🔴 Disconnected'}\n\n`;

      // Signal stats
      msg += `📈 *Signal Stats:*\n`;
      msg += `├─ Signals Today: ${dailyCount}/${RATE_LIMITS.MAX_SIGNALS_PER_DAY}\n`;
      msg += `├─ Signals This Hour: ${hourlyCount}/${RATE_LIMITS.MAX_SIGNALS_PER_HOUR}\n`;
      msg += `├─ Queued Signals: ${this.signalQueue.length}\n`;
      msg += `└─ Open Positions: ${openPositions.length}\n`;

      if (openPositions.length > 0) {
        msg += `\n*Current Holdings:*\n`;
        for (const pos of openPositions.slice(0, 5)) {
          const pnl = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
          const emoji = pnl >= 0 ? '🟢' : '🔴';
          msg += `${emoji} $${pos.tokenTicker}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%\n`;
        }
      }

      await this.bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error, chatId }, 'Failed to get status');
      await this.bot.sendMessage(chatId, `❌ Failed to get status: ${errorMessage}`);
    }
  }

  /**
   * Check connection statuses for external services
   */
  private async checkConnections(): Promise<{ database: boolean; helius: boolean; birdeye: boolean }> {
    const results = { database: false, helius: false, birdeye: false };

    // Check database
    try {
      await pool.query('SELECT 1');
      results.database = true;
    } catch {
      results.database = false;
    }

    // Check Helius
    try {
      const response = await fetch(`${appConfig.heliusRpcUrl}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: AbortSignal.timeout(5000),
      });
      results.helius = response.ok;
    } catch {
      results.helius = false;
    }

    // Check Birdeye
    try {
      const response = await fetch('https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=1', {
        headers: { 'X-API-KEY': appConfig.birdeyeApiKey },
        signal: AbortSignal.timeout(5000),
      });
      results.birdeye = response.ok;
    } catch {
      results.birdeye = false;
    }

    return results;
  }

  /**
   * Format uptime duration
   */
  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Format time ago
   */
  private formatTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - new Date(date).getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
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
