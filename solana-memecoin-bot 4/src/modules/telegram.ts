// ===========================================
// MODULE 5: TELEGRAM ALERT SYSTEM (rossybot)
// Enhanced with new features
// ===========================================

import TelegramBot from 'node-telegram-bot-api';
import express, { Express, Request, Response } from 'express';
import { Server } from 'http';
import { appConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { Database, pool } from '../utils/database.js';
import { createTelegramInlineKeyboard, formatLinksAsMarkdown } from '../utils/trade-links.js';
import { tokenSafetyChecker } from './safety/token-safety-checker.js';
import { convictionTracker } from './signals/conviction-tracker.js';
import { kolAnalytics } from './kol/kol-analytics.js';
import { bondingCurveMonitor } from './pumpfun/bonding-monitor.js';
import { dailyDigestGenerator } from './telegram/daily-digest.js';
import {
  BuySignal,
  KolWalletActivity,
  TokenScore,
  WalletType,
  Position,
  TokenSafetyResult,
  ConvictionLevel,
  KolActivity,
  TradeType,
  DiscoverySignal,
  SignalType,
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
  private app: Express | null = null;
  private server: Server | null = null;
  private chatId: string;
  private signalQueue: BuySignal[] = [];
  private lastKolSignalTime: Map<string, number> = new Map();
  private startTime: Date | null = null;
  private isWebhookMode: boolean = false;

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

    const PORT = parseInt(process.env.PORT || '3000', 10);
    const RAILWAY_PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;

    // Use webhook mode in production (Railway), polling in development
    if (RAILWAY_PUBLIC_DOMAIN) {
      await this.initializeWebhookMode(PORT, RAILWAY_PUBLIC_DOMAIN);
    } else {
      await this.initializePollingMode();
    }

    this.startTime = new Date();

    // Set up command handlers
    this.setupCommands();

    logger.info({ mode: this.isWebhookMode ? 'webhook' : 'polling' }, 'Telegram bot (rossybot) initialized');
  }

  /**
   * Initialize bot in webhook mode (production)
   * This prevents 409 Conflict errors by not polling
   */
  private async initializeWebhookMode(port: number, domain: string): Promise<void> {
    const webhookUrl = `https://${domain}/webhook`;

    // Create bot without polling
    this.bot = new TelegramBot(appConfig.telegramBotToken, { polling: false });

    // Set up Express server
    this.app = express();
    this.app.use(express.json());

    // Health check endpoint
    this.app.get('/health', (_req: Request, res: Response) => {
      res.status(200).json({
        status: 'ok',
        mode: 'webhook',
        uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
      });
    });

    // Root endpoint
    this.app.get('/', (_req: Request, res: Response) => {
      res.status(200).json({
        name: 'rossybot',
        status: 'running',
        mode: 'webhook',
      });
    });

    // Webhook endpoint for Telegram
    this.app.post('/webhook', (req: Request, res: Response) => {
      if (this.bot) {
        this.bot.processUpdate(req.body);
      }
      res.sendStatus(200);
    });

    // Start Express server
    this.server = this.app.listen(port, () => {
      logger.info({ port, webhookUrl }, 'Express server started for webhook');
    });

    // Set webhook with Telegram
    try {
      await this.bot.setWebHook(webhookUrl);
      logger.info({ webhookUrl }, 'Telegram webhook set successfully');
      this.isWebhookMode = true;
    } catch (error) {
      logger.error({ error, webhookUrl }, 'Failed to set Telegram webhook');
      throw error;
    }
  }

  /**
   * Initialize bot in polling mode (local development)
   */
  private async initializePollingMode(): Promise<void> {
    this.bot = new TelegramBot(appConfig.telegramBotToken, { polling: true });
    this.isWebhookMode = false;
    logger.info('Telegram bot started in polling mode (development)');
  }

  /**
   * Stop the bot gracefully
   */
  async stop(): Promise<void> {
    logger.info('Stopping Telegram bot...');

    if (this.bot) {
      if (this.isWebhookMode) {
        // Remove webhook before stopping
        try {
          await this.bot.deleteWebHook();
          logger.info('Telegram webhook removed');
        } catch (error) {
          logger.error({ error }, 'Failed to remove webhook');
        }
      } else {
        // Stop polling
        this.bot.stopPolling();
      }
    }

    // Close Express server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          logger.info('Express server stopped');
          resolve();
        });
      });
    }

    logger.info('Telegram bot stopped');
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
        '*rossybot* initialized!\n\n' +
        'You will receive memecoin buy signals here.\n\n' +
        '*Commands:*\n' +
        '/status - Bot status & connection health\n' +
        '/positions - Open positions\n' +
        '/safety <token> - Run safety check on any token\n' +
        '/conviction - Show high-conviction tokens\n' +
        '/leaderboard - KOL performance rankings\n' +
        '/pumpfun - Tokens approaching migration\n' +
        '/test - Send a test signal\n' +
        '/help - Show all commands',
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
        await this.bot!.sendMessage(chatId, 'Generating test signal...', { parse_mode: 'Markdown' });

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
        await this.bot!.sendMessage(chatId, `Failed to send test signal: ${errorMessage}`);
      }
    });

    // /safety <token> command - Run safety check on any token
    this.bot.onText(/\/safety\s+(\S+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const tokenMint = match?.[1];

      if (!tokenMint) {
        await this.bot!.sendMessage(chatId, 'Usage: /safety <token_address>');
        return;
      }

      try {
        await this.bot!.sendMessage(chatId, `Running safety check on \`${tokenMint.slice(0, 8)}...\``, { parse_mode: 'Markdown' });

        const result = await tokenSafetyChecker.checkTokenSafety(tokenMint);
        const message = this.formatSafetyResult(result);

        await this.bot!.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          reply_markup: createTelegramInlineKeyboard(tokenMint),
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId, tokenMint }, 'Failed to run safety check');
        await this.bot!.sendMessage(chatId, `Failed to run safety check: ${errorMessage}`);
      }
    });

    // /conviction command - Show high-conviction tokens
    this.bot.onText(/\/conviction/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        const highConvictionTokens = await convictionTracker.getHighConvictionTokensWithDetails(2);

        if (highConvictionTokens.length === 0) {
          await this.bot!.sendMessage(chatId, 'No high-conviction tokens (2+ KOLs) in the last 24 hours.');
          return;
        }

        let message = '*HIGH CONVICTION TOKENS*\n\n';

        for (const token of highConvictionTokens.slice(0, 10)) {
          const emoji = token.isUltraConviction ? '' : '';
          const kolNames = token.buyers.map(b => b.kolName).join(', ');
          message += `${emoji} \`${token.tokenAddress.slice(0, 8)}...\`\n`;
          message += `   ${token.level} KOLs: ${kolNames}\n\n`;
        }

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get conviction tokens');
        await this.bot!.sendMessage(chatId, `Failed to get conviction tokens: ${errorMessage}`);
      }
    });

    // /leaderboard command - KOL performance rankings
    this.bot.onText(/\/leaderboard/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        await this.bot!.sendMessage(chatId, 'Calculating KOL leaderboard...', { parse_mode: 'Markdown' });

        const leaderboard = await kolAnalytics.getLeaderboard(10);
        const message = kolAnalytics.formatLeaderboardMessage(leaderboard);

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get leaderboard');
        await this.bot!.sendMessage(chatId, `Failed to get leaderboard: ${errorMessage}`);
      }
    });

    // /pumpfun command - Show tokens approaching migration
    this.bot.onText(/\/pumpfun/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        const tokens = await bondingCurveMonitor.getTokensApproachingMigration(80);
        const message = bondingCurveMonitor.formatTokenList(tokens);

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get pumpfun tokens');
        await this.bot!.sendMessage(chatId, `Failed to get Pump.fun tokens: ${errorMessage}`);
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
        reply_markup: createTelegramInlineKeyboard(signal.tokenAddress),
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
    
    // Trade Links (Feature 6)
    msg += `*Quick Trade:*\n`;
    msg += formatLinksAsMarkdown(signal.tokenAddress);
    msg += `\n\n`;
    
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
  
  // ============ NEW FEATURE METHODS ============

  /**
   * Format safety check result message
   */
  private formatSafetyResult(result: TokenSafetyResult): string {
    const scoreEmoji = result.safetyScore >= 70 ? '' : result.safetyScore >= 40 ? '' : '';

    let msg = `*TOKEN SAFETY CHECK*\n\n`;
    msg += `*Token:* \`${result.tokenAddress.slice(0, 8)}...\`\n`;
    msg += `*Safety Score:* ${scoreEmoji} ${result.safetyScore}/100\n\n`;

    msg += `*Authorities:*\n`;
    msg += `├─ Mint: ${result.mintAuthorityEnabled ? 'ENABLED' : 'Revoked'}\n`;
    msg += `└─ Freeze: ${result.freezeAuthorityEnabled ? 'ENABLED' : 'Revoked'}\n\n`;

    msg += `*Token Info:*\n`;
    msg += `├─ Age: ${result.tokenAgeMins} minutes\n`;
    msg += `├─ Top 10 Holders: ${result.top10HolderConcentration.toFixed(1)}%\n`;
    msg += `├─ Deployer Holding: ${result.deployerHolding.toFixed(1)}%\n`;
    msg += `├─ LP Locked: ${result.lpLocked ? 'Yes' : 'No'}\n`;
    msg += `└─ Honeypot Risk: ${result.honeypotRisk ? 'YES' : 'No'}\n\n`;

    if (result.rugCheckScore !== null) {
      msg += `*RugCheck Score:* ${result.rugCheckScore}/100\n\n`;
    }

    msg += `*Insider Analysis:*\n`;
    msg += `├─ Same-block Buyers: ${result.insiderAnalysis.sameBlockBuyers}\n`;
    msg += `├─ Deployer-funded: ${result.insiderAnalysis.deployerFundedBuyers}\n`;
    msg += `└─ Insider Risk: ${result.insiderAnalysis.insiderRiskScore}/100\n\n`;

    if (result.flags.length > 0) {
      msg += `*Flags:* ${result.flags.join(', ')}\n`;
    }

    return msg;
  }

  /**
   * Send sell alert
   */
  async sendSellAlert(activity: KolActivity): Promise<void> {
    if (!this.bot) return;

    const ticker = activity.tokenTicker || activity.tokenAddress.slice(0, 8);
    let emoji = '';
    let alertType = 'SELL';

    if (activity.isFullExit) {
      emoji = '';
      alertType = 'FULL EXIT';
    } else if (activity.percentSold && activity.percentSold >= 50) {
      emoji = '';
    }

    let msg = `${emoji} *KOL ${alertType}*\n\n`;
    msg += `*KOL:* @${activity.kol.handle}\n`;
    msg += `*Token:* $${ticker}\n`;
    msg += `*Amount Sold:* ${activity.percentSold?.toFixed(1)}%\n`;
    msg += `*SOL Received:* ${activity.solAmount.toFixed(2)} SOL\n`;
    msg += `*Time:* ${activity.timestamp.toISOString().replace('T', ' ').slice(0, 19)} UTC\n`;

    if (activity.isFullExit) {
      msg += `\n*KOL has completely exited this position.*`;
    }

    await this.bot.sendMessage(this.chatId, msg, { parse_mode: 'Markdown' });
  }

  /**
   * Send conviction alert
   */
  async sendConvictionAlert(conviction: ConvictionLevel, tokenTicker?: string): Promise<void> {
    if (!this.bot) return;

    const ticker = tokenTicker || conviction.tokenAddress.slice(0, 8);
    const kolNames = conviction.buyers.map(b => b.kolName).join(', ');

    let emoji = '';
    let level = 'CONVICTION';

    if (conviction.isUltraConviction) {
      emoji = '';
      level = 'ULTRA CONVICTION';
    } else if (conviction.isHighConviction) {
      emoji = '';
      level = 'HIGH CONVICTION';
    }

    let msg = `${emoji} *${level}*\n\n`;
    msg += `*Token:* $${ticker}\n`;
    msg += `*KOL Count:* ${conviction.level}\n`;
    msg += `*KOLs:* ${kolNames}\n`;

    await this.bot.sendMessage(this.chatId, msg, {
      parse_mode: 'Markdown',
      reply_markup: createTelegramInlineKeyboard(conviction.tokenAddress),
    });
  }

  /**
   * Send discovery signal (no KOL - metrics based)
   */
  async sendDiscoverySignal(signal: DiscoverySignal): Promise<boolean> {
    if (!this.bot) {
      logger.warn('Bot not initialized - cannot send discovery signal');
      return false;
    }

    try {
      const message = this.formatDiscoverySignal(signal);

      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: createTelegramInlineKeyboard(signal.tokenAddress),
      });

      // Log the signal
      await Database.logSignal(
        signal.tokenAddress,
        SignalType.DISCOVERY,
        signal.score.compositeScore,
        'DISCOVERY'
      );

      logger.info({
        tokenAddress: signal.tokenAddress,
        ticker: signal.tokenTicker,
        score: signal.score.compositeScore,
        moonshotGrade: signal.moonshotAssessment.grade,
      }, 'Discovery signal sent');

      return true;
    } catch (error) {
      logger.error({ error, signal: signal.tokenAddress }, 'Failed to send discovery signal');
      return false;
    }
  }

  /**
   * Format discovery signal message
   */
  private formatDiscoverySignal(signal: DiscoverySignal): string {
    const { score, tokenMetrics, moonshotAssessment, safetyResult, scamFilter } = signal;

    let msg = `🔍 *ROSSYBOT DISCOVERY SIGNAL*\n\n`;

    // Token info
    msg += `*Token:* \`$${signal.tokenTicker}\` (${this.truncateAddress(signal.tokenAddress)})\n`;
    msg += `*Name:* ${signal.tokenName}\n`;
    msg += `*Chain:* Solana\n\n`;

    // Discovery metrics
    msg += `📊 *DISCOVERY METRICS*\n`;
    msg += `├─ Score: *${score.compositeScore}/100*\n`;
    msg += `├─ Confidence: *${score.confidence}*\n`;
    msg += `├─ Risk Level: *${score.riskLevel}/5*\n`;
    msg += `└─ Signal Type: METRICS\\_DISCOVERY\n\n`;

    // Moonshot assessment
    const gradeEmoji = moonshotAssessment.grade === 'A' ? '🔥' :
                       moonshotAssessment.grade === 'B' ? '✨' :
                       moonshotAssessment.grade === 'C' ? '📈' : '📊';
    msg += `🚀 *MOONSHOT ASSESSMENT*\n`;
    msg += `├─ Grade: ${gradeEmoji} *${moonshotAssessment.grade}* (${moonshotAssessment.score}/100)\n`;
    msg += `├─ Potential: *${moonshotAssessment.estimatedPotential}*\n`;
    msg += `├─ Volume Velocity: ${moonshotAssessment.factors.volumeVelocity.toFixed(0)}/100\n`;
    msg += `├─ Holder Growth: ${moonshotAssessment.factors.holderGrowthRate.toFixed(0)}/100\n`;
    msg += `├─ Narrative: ${moonshotAssessment.factors.narrativeScore.toFixed(0)}/100\n`;
    msg += `└─ Contract Safety: ${moonshotAssessment.factors.contractSafety.toFixed(0)}/100\n\n`;

    // Matched patterns
    if (moonshotAssessment.matchedPatterns.length > 0) {
      msg += `✅ *Matched Patterns:* ${moonshotAssessment.matchedPatterns.slice(0, 5).join(', ')}\n\n`;
    }

    // On-chain data
    msg += `📈 *ON-CHAIN DATA*\n`;
    msg += `├─ Price: $${this.formatPrice(tokenMetrics.price)}\n`;
    msg += `├─ Market Cap: $${this.formatNumber(tokenMetrics.marketCap)}\n`;
    msg += `├─ 24h Volume: $${this.formatNumber(tokenMetrics.volume24h)}\n`;
    msg += `├─ Vol/MCap: ${(tokenMetrics.volumeMarketCapRatio * 100).toFixed(1)}%\n`;
    msg += `├─ Holders: ${tokenMetrics.holderCount} (${tokenMetrics.holderChange1h >= 0 ? '+' : ''}${tokenMetrics.holderChange1h}% 1h)\n`;
    msg += `├─ Top 10: ${tokenMetrics.top10Concentration.toFixed(1)}%\n`;
    msg += `├─ Liquidity: $${this.formatNumber(tokenMetrics.liquidityPool)}\n`;
    msg += `├─ Token Age: ${tokenMetrics.tokenAge} min\n`;
    msg += `└─ LP Locked: ${tokenMetrics.lpLocked ? '✅ Yes' : '❌ No'}\n\n`;

    // Safety check
    msg += `🛡️ *SAFETY CHECK*\n`;
    msg += `├─ Safety Score: ${safetyResult.safetyScore}/100\n`;
    msg += `├─ Mint Authority: ${safetyResult.mintAuthorityEnabled ? '⚠️ ENABLED' : '✅ Revoked'}\n`;
    msg += `├─ Freeze Authority: ${safetyResult.freezeAuthorityEnabled ? '⚠️ ENABLED' : '✅ Revoked'}\n`;
    msg += `├─ Insider Risk: ${safetyResult.insiderAnalysis.insiderRiskScore}/100\n`;
    msg += `└─ Bundle Risk: ${scamFilter.bundleAnalysis.riskLevel === 'LOW' ? '🟢 CLEAR' : scamFilter.bundleAnalysis.riskLevel === 'MEDIUM' ? '🟡 FLAGGED' : '🔴 HIGH'}\n\n`;

    // KOL Status
    msg += `👛 *KOL STATUS*\n`;
    msg += `└─ ⏳ NO KOL ACTIVITY YET\n`;
    msg += `   _Waiting for KOL validation..._\n\n`;

    // Suggested action
    msg += `⚡ *SUGGESTED ACTION*\n`;
    msg += `├─ Position Size: ${signal.suggestedPositionSize}% (reduced for discovery)\n`;
    msg += `└─ Status: WATCH\\_LIST (await KOL or DYOR)\n\n`;

    // Risk warnings
    if (signal.riskWarnings.length > 0) {
      msg += `⚠️ *RISK WARNINGS:*\n`;
      for (const warning of signal.riskWarnings) {
        msg += `• ${warning}\n`;
      }
      msg += `\n`;
    }

    // Flags
    if (score.flags.length > 0) {
      msg += `🏷️ *FLAGS:* ${score.flags.join(', ')}\n\n`;
    }

    // Trade Links
    msg += `*Quick Trade:*\n`;
    msg += formatLinksAsMarkdown(signal.tokenAddress);
    msg += `\n\n`;

    // Footer
    msg += `⏱️ _Discovery: ${signal.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;
    msg += `⚠️ _DISCOVERY SIGNAL: No KOL validation. Higher risk. DYOR._`;

    return msg;
  }

  /**
   * Send on-chain momentum signal (pure metrics, no KOL)
   */
  async sendOnChainSignal(signal: any): Promise<boolean> {
    if (!this.bot) {
      logger.warn('Bot not initialized - cannot send on-chain signal');
      return false;
    }

    try {
      const message = this.formatOnChainSignal(signal);

      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: createTelegramInlineKeyboard(signal.tokenAddress),
      });

      // Log the signal
      await Database.logSignal(
        signal.tokenAddress,
        SignalType.DISCOVERY,
        signal.onChainScore.total,
        'ONCHAIN_MOMENTUM'
      );

      logger.info({
        tokenAddress: signal.tokenAddress,
        ticker: signal.tokenTicker,
        momentumScore: signal.momentumScore.total,
        onChainScore: signal.onChainScore.total,
      }, 'On-chain momentum signal sent');

      return true;
    } catch (error) {
      logger.error({ error, signal: signal.tokenAddress }, 'Failed to send on-chain signal');
      return false;
    }
  }

  /**
   * Format on-chain momentum signal message
   */
  private formatOnChainSignal(signal: any): string {
    const { tokenMetrics, momentumScore, bundleAnalysis, onChainScore, safetyResult, positionRationale } = signal;

    let msg = `⚡ *ROSSYBOT MOMENTUM SIGNAL*\n\n`;

    // Token info
    msg += `*Token:* \`$${signal.tokenTicker}\` (${this.truncateAddress(signal.tokenAddress)})\n`;
    msg += `*Name:* ${signal.tokenName}\n`;
    msg += `*Chain:* Solana\n\n`;

    // Momentum metrics (the key differentiator)
    const buyRatioEmoji = momentumScore.metrics.buySellRatio >= 2.0 ? '🔥' :
                          momentumScore.metrics.buySellRatio >= 1.5 ? '✨' : '📈';
    msg += `📊 *MOMENTUM ANALYSIS*\n`;
    msg += `├─ Total Score: *${momentumScore.total}/100*\n`;
    msg += `├─ ${buyRatioEmoji} Buy/Sell Ratio: *${momentumScore.metrics.buySellRatio.toFixed(2)}x*\n`;
    msg += `├─ Buy Pressure: ${momentumScore.components.buyPressure}/25\n`;
    msg += `├─ Volume Velocity: ${momentumScore.components.volumeVelocity}/25\n`;
    msg += `├─ Trade Quality: ${momentumScore.components.tradeQuality}/25\n`;
    msg += `├─ Holder Growth: ${momentumScore.components.holderGrowth}/25\n`;
    msg += `├─ Unique Buyers (5m): ${momentumScore.metrics.uniqueBuyers5m}\n`;
    msg += `└─ Net Buy Pressure: $${this.formatNumber(momentumScore.metrics.netBuyPressure)}\n\n`;

    // On-chain score
    const gradeEmoji = onChainScore.total >= 70 ? '🔥' : onChainScore.total >= 55 ? '✨' : '📊';
    msg += `🎯 *ON-CHAIN SCORE*\n`;
    msg += `├─ Total: ${gradeEmoji} *${onChainScore.total}/100*\n`;
    msg += `├─ Recommendation: *${onChainScore.recommendation}*\n`;
    msg += `├─ Momentum: ${onChainScore.components.momentum}/30\n`;
    msg += `├─ Safety: ${onChainScore.components.safety}/25\n`;
    msg += `├─ Bundle Safety: ${onChainScore.components.bundleSafety}/20\n`;
    msg += `├─ Market Structure: ${onChainScore.components.marketStructure}/15\n`;
    msg += `└─ Timing: ${onChainScore.components.timing}/10\n\n`;

    // Bullish/bearish signals
    const bullish = onChainScore.signals.filter((s: any) => s.type === 'bullish');
    const bearish = onChainScore.signals.filter((s: any) => s.type === 'bearish');

    if (bullish.length > 0) {
      msg += `✅ *BULLISH SIGNALS:*\n`;
      for (const s of bullish.slice(0, 4)) {
        msg += `• ${s.reason}\n`;
      }
      msg += `\n`;
    }

    if (bearish.length > 0) {
      msg += `⚠️ *BEARISH SIGNALS:*\n`;
      for (const s of bearish.slice(0, 3)) {
        msg += `• ${s.reason}\n`;
      }
      msg += `\n`;
    }

    // Market data
    msg += `📈 *MARKET DATA*\n`;
    msg += `├─ Price: $${this.formatPrice(tokenMetrics.price)}\n`;
    msg += `├─ Market Cap: $${this.formatNumber(tokenMetrics.marketCap)}\n`;
    msg += `├─ 24h Volume: $${this.formatNumber(tokenMetrics.volume24h)}\n`;
    msg += `├─ Holders: ${tokenMetrics.holderCount}\n`;
    msg += `├─ Top 10: ${tokenMetrics.top10Concentration.toFixed(1)}%\n`;
    msg += `├─ Liquidity: $${this.formatNumber(tokenMetrics.liquidityPool)}\n`;
    msg += `└─ Token Age: ${tokenMetrics.tokenAge} min\n\n`;

    // Bundle/Insider analysis
    const bundleEmoji = bundleAnalysis.riskLevel === 'LOW' ? '🟢' :
                        bundleAnalysis.riskLevel === 'MEDIUM' ? '🟡' : '🔴';
    msg += `🔍 *BUNDLE ANALYSIS*\n`;
    msg += `├─ Risk Level: ${bundleEmoji} ${bundleAnalysis.riskLevel}\n`;
    msg += `├─ Risk Score: ${bundleAnalysis.riskScore}/100\n`;
    if (bundleAnalysis.flags.length > 0) {
      msg += `└─ Flags: ${bundleAnalysis.flags.slice(0, 3).join(', ')}\n\n`;
    } else {
      msg += `└─ Flags: None ✅\n\n`;
    }

    // Safety check
    msg += `🛡️ *SAFETY*\n`;
    msg += `├─ Score: ${safetyResult.safetyScore}/100\n`;
    msg += `├─ Mint: ${safetyResult.mintAuthorityEnabled ? '⚠️ ENABLED' : '✅ Revoked'}\n`;
    msg += `└─ Freeze: ${safetyResult.freezeAuthorityEnabled ? '⚠️ ENABLED' : '✅ Revoked'}\n\n`;

    // Position sizing
    msg += `💰 *POSITION SIZING*\n`;
    msg += `├─ Suggested: *${signal.suggestedPositionSize} SOL*\n`;
    msg += `├─ Signal Strength: ${signal.score.confidence}\n`;
    if (positionRationale && positionRationale.length > 0) {
      for (const r of positionRationale.slice(0, 4)) {
        msg += `├─ ${r}\n`;
      }
    }
    msg += `└─ Stop Loss: 40% | Take Profit: 100%\n\n`;

    // KOL Status
    msg += `👛 *KOL STATUS*\n`;
    msg += `└─ ⏳ No KOL activity detected\n`;
    msg += `   _Signal based on on-chain momentum_\n\n`;

    // Risk warnings
    if (signal.riskWarnings && signal.riskWarnings.length > 0) {
      msg += `⚠️ *RISK WARNINGS:*\n`;
      for (const warning of signal.riskWarnings.slice(0, 5)) {
        msg += `• ${warning}\n`;
      }
      msg += `\n`;
    }

    // Trade links
    msg += `*Quick Trade:*\n`;
    msg += formatLinksAsMarkdown(signal.tokenAddress);
    msg += `\n\n`;

    // Footer
    msg += `⏱️ _Signal: ${signal.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;
    msg += `⚡ _MOMENTUM SIGNAL: Based on on-chain metrics. DYOR._`;

    return msg;
  }

  /**
   * Send KOL validation signal (KOL bought a previously discovered token)
   */
  async sendKolValidationSignal(signal: BuySignal, previousDiscovery: DiscoverySignal): Promise<boolean> {
    if (!this.bot) {
      logger.warn('Bot not initialized - cannot send KOL validation signal');
      return false;
    }

    try {
      const message = this.formatKolValidationSignal(signal, previousDiscovery);

      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: createTelegramInlineKeyboard(signal.tokenAddress),
      });

      // Log the signal
      await Database.logSignal(
        signal.tokenAddress,
        SignalType.KOL_VALIDATION,
        signal.score.compositeScore,
        signal.kolActivity.kol.handle
      );

      // Update KOL cooldown
      this.lastKolSignalTime.set(signal.kolActivity.kol.handle, Date.now());

      logger.info({
        tokenAddress: signal.tokenAddress,
        ticker: signal.tokenTicker,
        originalScore: previousDiscovery.score.compositeScore,
        boostedScore: signal.score.compositeScore,
        kol: signal.kolActivity.kol.handle,
      }, 'KOL validation signal sent');

      return true;
    } catch (error) {
      logger.error({ error, signal: signal.tokenAddress }, 'Failed to send KOL validation signal');
      return false;
    }
  }

  /**
   * Format KOL validation signal message
   */
  private formatKolValidationSignal(signal: BuySignal, previousDiscovery: DiscoverySignal): string {
    const { kolActivity, score, tokenMetrics, scamFilter } = signal;
    const wallet = kolActivity.wallet;
    const tx = kolActivity.transaction;
    const perf = kolActivity.performance;

    // Calculate time since discovery
    const timeSinceDiscovery = Math.round(
      (Date.now() - previousDiscovery.discoveredAt.getTime()) / (1000 * 60)
    );

    let msg = `🎯 *KOL VALIDATION SIGNAL*\n\n`;

    // Discovery recap
    msg += `📍 *PREVIOUSLY DISCOVERED*\n`;
    msg += `├─ Discovery Time: ${timeSinceDiscovery} min ago\n`;
    msg += `├─ Original Score: ${previousDiscovery.score.compositeScore}/100\n`;
    msg += `├─ Moonshot Grade: ${previousDiscovery.moonshotAssessment.grade}\n`;
    msg += `└─ Now: *KOL VALIDATED* ✅\n\n`;

    // Token info
    msg += `*Token:* \`$${signal.tokenTicker}\` (${this.truncateAddress(signal.tokenAddress)})\n`;
    msg += `*Chain:* Solana\n\n`;

    // Score boost
    const scoreBoost = signal.score.compositeScore - previousDiscovery.score.compositeScore;
    msg += `📊 *SIGNAL METRICS (BOOSTED)*\n`;
    msg += `├─ Original Score: ${previousDiscovery.score.compositeScore}/100\n`;
    msg += `├─ *Boosted Score: ${score.compositeScore}/100* (+${scoreBoost})\n`;
    msg += `├─ Confidence: *${score.confidence}*\n`;
    msg += `├─ Risk Level: *${score.riskLevel}/5*\n`;
    msg += `└─ Signal Type: KOL\\_VALIDATION\n\n`;

    // KOL Wallet Activity
    msg += `👛 *KOL WALLET ACTIVITY*\n`;
    msg += `├─ Status: ✅ KOL BUY CONFIRMED\n`;
    msg += `├─ KOL: @${kolActivity.kol.handle}\n`;
    msg += `├─ KOL Tier: ${kolActivity.kol.tier}\n`;
    msg += `├─ *Wallet Type: ${wallet.walletType === WalletType.MAIN ? '🟢 MAIN WALLET' : '🟡 SIDE WALLET'}*\n`;
    msg += `├─ Wallet: \`${this.truncateAddress(wallet.address)}\`\n`;
    msg += `├─ Buy Amount: ${tx.solAmount.toFixed(2)} SOL ($${tx.usdValue.toFixed(0)})\n`;
    msg += `├─ Tokens: ${this.formatNumber(tx.tokensAcquired)} (${tx.supplyPercent.toFixed(2)}%)\n`;
    msg += `├─ TX: \`${this.truncateAddress(tx.signature)}\`\n`;
    msg += `├─ Time: ${tx.timestamp.toISOString().replace('T', ' ').slice(0, 19)} UTC\n`;
    msg += `└─ KOL Accuracy: ${(perf.winRate * 100).toFixed(0)}% (${perf.totalTrades} trades)\n\n`;

    // On-chain data
    msg += `📈 *ON-CHAIN DATA*\n`;
    msg += `├─ Price: $${this.formatPrice(tokenMetrics.price)}\n`;
    msg += `├─ Market Cap: $${this.formatNumber(tokenMetrics.marketCap)}\n`;
    msg += `├─ 24h Volume: $${this.formatNumber(tokenMetrics.volume24h)}\n`;
    msg += `├─ Holders: ${tokenMetrics.holderCount}\n`;
    msg += `├─ Top 10: ${tokenMetrics.top10Concentration.toFixed(1)}%\n`;
    msg += `└─ Bundle Risk: ${scamFilter.bundleAnalysis.riskLevel === 'LOW' ? '🟢 CLEAR' : scamFilter.bundleAnalysis.riskLevel === 'MEDIUM' ? '🟡 FLAGGED' : '🔴 HIGH'}\n\n`;

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

    // Trade Links
    msg += `*Quick Trade:*\n`;
    msg += formatLinksAsMarkdown(signal.tokenAddress);
    msg += `\n\n`;

    // Footer
    msg += `⏱️ _Signal: ${signal.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;
    msg += `✅ _KOL validated our discovery! Higher confidence entry._`;

    return msg;
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
