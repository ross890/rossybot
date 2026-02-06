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
import { alphaWalletManager } from './alpha/index.js';
import { bondingCurveMonitor } from './pumpfun/bonding-monitor.js';
import { dailyDigestGenerator } from './telegram/daily-digest.js';
import { dailyReportGenerator, signalPerformanceTracker, thresholdOptimizer, winPredictor, aiQueryInterface } from './performance/index.js';
import { volumeAnomalyScanner } from './discovery/index.js';
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
  DexScreenerTokenInfo,
  CTOAnalysis,
} from '../types/index.js';

// Trading commands (conditionally enabled when wallet key is present)
import { TradingCommands } from './telegram/trading-commands.js';

// ============ RATE LIMITING ============

const RATE_LIMITS = {
  MAX_SIGNALS_PER_HOUR: appConfig.trading.maxSignalsPerHour,
  MAX_SIGNALS_PER_DAY: appConfig.trading.maxSignalsPerDay,
  TOKEN_COOLDOWN_MS: 4 * 60 * 60 * 1000, // 4 hours
  KOL_COOLDOWN_MS: 2 * 60 * 60 * 1000, // 2 hours
} as const;

// ============ TELEGRAM BOT CLASS ============

// Threshold adjustment state for conversational flow
interface ThresholdAdjustmentState {
  threshold: keyof import('./performance/threshold-optimizer.js').ThresholdSet | null;
  awaitingValue: boolean;
}

// Signal snapshot for tracking metrics between signals
interface SignalSnapshot {
  timestamp: number;
  ticker: string;
  price: number;
  marketCap: number;
  volume24h: number;
  holderCount: number;
  compositeScore: number;
  socialMomentum: number;
  mentionVelocity: number;
  kolHandle: string;
  kolCount: number;
  // Enhanced fields for better resend analysis
  buySellRatio?: number;
  uniqueBuyers5m?: number;
  top10Concentration?: number;
  prediction?: {
    winProbability: number;
    confidence: string;
    matchedPatterns?: string[];
    riskFactors?: string[];
  };
  // Track weakening signal count - limit to MAX_WEAKENING_SIGNALS per token
  weakeningSignalCount: number;
}

// Resend classification based on momentum assessment
type ResendClassification =
  | 'MOMENTUM_CONFIRMED'  // Multiple metrics improving, thesis strengthening
  | 'NEW_CATALYST'        // New KOL entry, volume spike, or holder explosion
  | 'MIXED_SIGNALS'       // Some better, some worse
  | 'DETERIORATING'       // Metrics declining but still above thresholds
  | 'SUPPRESS';           // Don't send - momentum clearly dead

// Before/after metric comparison for rich context
interface MetricComparison {
  name: string;
  emoji: string;
  previous: number;
  current: number;
  change: number;
  changePercent: number;
  direction: 'up' | 'down' | 'flat';
  isPositive: boolean; // Whether this direction is good for the trade
}

// Follow-up signal context with enhanced analysis
interface FollowUpContext {
  isFollowUp: boolean;
  timeSinceFirst: number; // minutes
  changes: string[]; // Legacy format for backward compatibility
  // Enhanced fields
  classification?: ResendClassification;
  shouldSuppress?: boolean;
  suppressReason?: string;
  momentumScore?: number; // -5 to +5 based on metric directions
  positiveChanges: number;
  negativeChanges: number;
  metricsComparison?: MetricComparison[];
  narrative?: string; // One-line summary of why this resend matters
  predictionComparison?: {
    previousWinProb: number;
    currentWinProb: number;
    probChange: number;
    newRiskFactors?: string[];
    lostPatterns?: string[];
    gainedPatterns?: string[];
  };
}

export class TelegramAlertBot {
  private bot: TelegramBot | null = null;
  private app: Express | null = null;
  private server: Server | null = null;
  private chatId: string;
  private signalQueue: BuySignal[] = [];
  private lastKolSignalTime: Map<string, number> = new Map();
  private startTime: Date | null = null;
  private isWebhookMode: boolean = false;

  // Signal tracking for follow-up context - stores metrics snapshot for comparison
  // When a token signals again, we can show what changed (momentum building, holder surge, etc.)
  private signalHistory: Map<string, SignalSnapshot> = new Map();
  private readonly SIGNAL_HISTORY_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours - track follow-ups within this window
  private readonly MIN_FOLLOWUP_INTERVAL_MS = 10 * 60 * 1000; // 10 min minimum between follow-ups
  private readonly MAX_WEAKENING_SIGNALS = 3; // Maximum weakening signals before only allowing buy signals

  // RACE CONDITION PROTECTION: Synchronous lock to prevent parallel processes from sending duplicate signals
  // A token is added to this Set IMMEDIATELY when signal processing starts, before any async operations
  // This prevents TOCTOU (Time Of Check To Time Of Use) race conditions where two processes both pass the history check
  private signalsInProgress: Set<string> = new Set();

  // State tracking for conversational threshold adjustment
  private thresholdAdjustmentState: Map<number, ThresholdAdjustmentState> = new Map();

  constructor() {
    this.chatId = appConfig.telegramChatId;
  }

  /**
   * Get the underlying Telegram bot instance
   * Used to share bot with other modules like mature token formatter
   */
  getBot(): TelegramBot | null {
    return this.bot;
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

    // Detect Railway environment more robustly
    const isRailwayEnvironment = !!(
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID ||
      RAILWAY_PUBLIC_DOMAIN
    );

    logger.info({
      isRailwayEnvironment,
      hasPublicDomain: !!RAILWAY_PUBLIC_DOMAIN,
      railwayEnv: process.env.RAILWAY_ENVIRONMENT,
      port: PORT,
    }, 'Detecting deployment environment');

    // Always use polling mode for reliable command handling
    // HTTP server is still started for Railway health checks
    await this.initializePollingMode();

    this.startTime = new Date();

    // Set up command handlers
    this.setupCommands();

    // Initialize performance tracking system
    try {
      await signalPerformanceTracker.initialize();
      await thresholdOptimizer.loadThresholds();

      // Set up milestone notification callback (2x, stop-loss alerts)
      signalPerformanceTracker.setNotifyCallback(async (message: string) => {
        if (this.bot && this.chatId) {
          await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
        }
      });

      // Set up daily report generator with callback to send messages
      dailyReportGenerator.initialize(async (message: string) => {
        if (this.bot) {
          await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
        }
      });

      // Schedule daily report at 9 AM UTC
      dailyReportGenerator.scheduleDaily(9);

      logger.info('Performance tracking and daily reports initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize performance tracking');
    }

    // Initialize trading commands if wallet key is configured
    if (appConfig.trading && process.env.BOT_WALLET_PRIVATE_KEY && this.bot) {
      try {
        const tradingCommands = new TradingCommands(this.bot, this.chatId);
        await tradingCommands.initialize();
        logger.info('Trading commands enabled (wallet key configured)');
      } catch (error) {
        logger.warn({ error }, 'Failed to initialize trading commands - running in signal-only mode');
      }
    } else {
      logger.info('Running in signal-only mode (no wallet key configured)');
    }

    // Initialize alpha wallet manager with notification callback
    try {
      await alphaWalletManager.initialize();
      alphaWalletManager.setNotifyCallback(async (message: string) => {
        if (this.bot && this.chatId) {
          await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
        }
      });
      logger.info('Alpha wallet manager initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize alpha wallet manager');
    }

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
        webhookUrl,
      });
    });

    // Debug endpoint to check webhook info
    this.app.get('/debug/webhook', async (_req: Request, res: Response) => {
      try {
        if (this.bot) {
          const webhookInfo = await this.bot.getWebHookInfo();
          res.status(200).json({
            configured: webhookUrl,
            telegram: webhookInfo,
          });
        } else {
          res.status(500).json({ error: 'Bot not initialized' });
        }
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    });

    // Webhook endpoint for Telegram
    this.app.post('/webhook', (req: Request, res: Response) => {
      const update = req.body;
      logger.info({
        updateId: update?.update_id,
        hasMessage: !!update?.message,
        text: update?.message?.text?.slice(0, 50),
        chatId: update?.message?.chat?.id,
      }, 'Webhook received update');

      if (this.bot) {
        this.bot.processUpdate(update);
      }
      res.sendStatus(200);
    });

    // Start Express server - bind to 0.0.0.0 for Railway
    this.server = this.app.listen(port, '0.0.0.0', () => {
      logger.info({ port, webhookUrl, host: '0.0.0.0' }, 'Express server started for webhook');
    });

    this.server.on('error', (error) => {
      logger.error({ error, port }, 'Express server error');
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
   * Initialize bot in polling mode (local development or Railway without public domain)
   */
  private async initializePollingMode(): Promise<void> {
    const PORT = parseInt(process.env.PORT || '3000', 10);

    // First, create bot without polling to clear any existing webhook
    const tempBot = new TelegramBot(appConfig.telegramBotToken, { polling: false });

    try {
      // Clear any existing webhook to prevent conflicts
      await tempBot.deleteWebHook();
      logger.info('Cleared any existing webhook before starting polling');
    } catch (error) {
      logger.warn({ error }, 'Failed to clear webhook (may not exist)');
    }

    // Now create the bot with polling enabled
    this.bot = new TelegramBot(appConfig.telegramBotToken, {
      polling: {
        autoStart: true,
        params: {
          timeout: 30,
        },
      },
    });

    this.isWebhookMode = false;

    // Always start HTTP server for Railway health checks (required for public domain)
    this.app = express();
    this.app.use(express.json());

    // Health check endpoint
    this.app.get('/health', (_req: Request, res: Response) => {
      res.status(200).json({
        status: 'ok',
        mode: 'polling',
        uptime: this.startTime ? Date.now() - this.startTime.getTime() : 0,
      });
    });

    // Root endpoint
    this.app.get('/', (_req: Request, res: Response) => {
      res.status(200).json({
        name: 'rossybot',
        status: 'running',
        mode: 'polling',
        message: 'Set RAILWAY_PUBLIC_DOMAIN to enable webhook mode',
      });
    });

    this.server = this.app.listen(PORT, '0.0.0.0', () => {
      logger.info({ port: PORT, host: '0.0.0.0' }, 'HTTP server started for health checks (polling mode)');
    });

    this.server.on('error', (error) => {
      logger.error({ error, port: PORT }, 'Express server error');
    });

    // Handle polling errors gracefully
    this.bot.on('polling_error', (error: Error & { code?: string }) => {
      if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
        logger.error(
          '409 Conflict detected - another bot instance is polling. ' +
          'Ensure only ONE instance is running, or configure webhook mode with RAILWAY_PUBLIC_DOMAIN.'
        );
        // Stop polling to prevent repeated errors
        this.bot?.stopPolling();
        logger.info('Stopped polling due to conflict. Bot will only send messages, not receive commands.');
      } else {
        logger.error({ error }, 'Telegram polling error');
      }
    });

    logger.info('Telegram bot started in polling mode');
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

    // Set up Telegram command menu (appears in chat)
    // Updated for Mature Token Strategy V2 with new features
    const SIGNAL_BOT_COMMANDS: TelegramBot.BotCommand[] = [
      { command: 'status', description: 'Bot status & strategy info' },
      { command: 'stats', description: 'Historical performance dashboard' },
      { command: 'recent', description: 'Recent signals & performance' },
      { command: 'tierperf', description: 'Win rate by tier' },
      { command: 'microcap', description: '$200K-$500K opportunity analysis' },
      { command: 'funnel', description: 'Token filtering funnel stats' },
      { command: 'sources', description: 'Discovery source health' },
      { command: 'volumespikes', description: 'Volume anomaly scanner' },
      { command: 'tiers', description: 'Tier requirements' },
      { command: 'safety', description: 'Safety check: /safety <token>' },
      { command: 'thresholds', description: 'View scoring thresholds' },
      { command: 'addwallet', description: 'Track wallet: /addwallet <address>' },
      { command: 'wallets', description: 'List tracked wallets' },
      { command: 'help', description: 'Show all commands' },
    ];

    this.bot.setMyCommands(SIGNAL_BOT_COMMANDS).then(() => {
      logger.info('Bot command menu set up successfully');
    }).catch((error) => {
      logger.error({ error }, 'Failed to set bot commands');
    });

    // /start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot!.sendMessage(chatId,
        '*🤖 rossybot V2 - Mature Token Strategy*\n\n' +
        'Scanning for established tokens:\n' +
        '• 🚀 RISING: $500K-$8M, 500+ holders, 3+ days\n' +
        '• 🌱 EMERGING: $8-20M, 21+ days\n' +
        '• 🎓 GRADUATED: $20-50M, 21+ days\n' +
        '• 🏛️ ESTABLISHED: $50-150M, 21+ days\n\n' +
        '*Quick Commands:*\n' +
        '/status - Bot status\n' +
        '/funnel - Filtering funnel\n' +
        '/sources - API health\n' +
        '/performance - Win rates\n\n' +
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
        '*🤖 rossybot V2 Help*\n\n' +
        '*Performance:*\n' +
        '/stats - Historical dashboard\n' +
        '/recent - Recent signals\n' +
        '/tierperf - Win rate by tier\n' +
        '/performance - Signal stats\n' +
        '/report - AI analysis\n\n' +
        '*Discovery:*\n' +
        '/funnel - Filtering funnel\n' +
        '/sources - API health\n' +
        '/volumespikes - Volume anomalies\n' +
        '/microcap - $200K-$500K analysis\n' +
        '/tiers - Tier requirements\n\n' +
        '*Analysis:*\n' +
        '/safety <token> - Safety check\n' +
        '/thresholds - View thresholds\n' +
        '/optimize - Run optimization\n\n' +
        '*Wallets:*\n' +
        '/addwallet <addr> - Track wallet\n' +
        '/wallets - List wallets\n' +
        '/removewallet <addr> - Remove\n\n' +
        '*ML:*\n' +
        '/learning - Prediction info\n\n' +
        '_Auto-alerts: 2x, 3x, stop-loss_\n' +
        'DYOR. Not financial advice.',
        { parse_mode: 'Markdown' }
      );
    });

    // /funnel command - Show token filtering funnel stats
    this.bot.onText(/\/funnel/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        // Get funnel stats from mature token scanner
        const { matureTokenScanner } = await import('./mature-token/index.js');
        const stats = matureTokenScanner.getFunnelStats();

        const message =
          '*📊 Token Filtering Funnel*\n\n' +
          '*Last Scan Results:*\n' +
          `• Trending tokens fetched: ${stats.fetched}\n` +
          `• Passed age filter: ${stats.passedAge}\n` +
          `• Passed eligibility: ${stats.eligible}\n` +
          `• Tokens evaluated: ${stats.evaluated}\n` +
          `• Signals sent: ${stats.signalsSent}\n\n` +
          '*Rejection Reasons:*\n' +
          `• Too young (<3 days for RISING, <21 days others): ${stats.rejections.tooYoung}\n` +
          `• Market cap out of range: ${stats.rejections.marketCap}\n` +
          `• No tier match ($5-8M gap): ${stats.rejections.noTier}\n` +
          `• Volume too low: ${stats.rejections.volume}\n` +
          `• Holders too low: ${stats.rejections.holders}\n` +
          `• Liquidity issues: ${stats.rejections.liquidity}\n` +
          `• Score below threshold: ${stats.rejections.score}\n\n` +
          '*Tier Distribution:*\n' +
          `🚀 RISING: ${stats.tiers.RISING}\n` +
          `🌱 EMERGING: ${stats.tiers.EMERGING}\n` +
          `🎓 GRADUATED: ${stats.tiers.GRADUATED}\n` +
          `🏛️ ESTABLISHED: ${stats.tiers.ESTABLISHED}\n\n` +
          `_Last updated: ${stats.lastScanTime || 'No scan yet'}_`;

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        await this.bot!.sendMessage(chatId,
          '*📊 Token Filtering Funnel*\n\n' +
          'No funnel data available yet.\n' +
          'Wait for the next scan cycle (every 5 minutes).',
          { parse_mode: 'Markdown' }
        );
      }
    });

    // /sources command - Show discovery source health status
    this.bot.onText(/\/sources/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        // Get funnel stats which includes source counts
        const { matureTokenScanner } = await import('./mature-token/index.js');
        const stats = matureTokenScanner.getFunnelStats();
        const sourceStats = stats.sourceStats as Record<string, number> || {};

        let message = '*🔌 Discovery Source Health*\n\n';

        // Source status with counts
        const sources = [
          { name: 'Jupiter Verified', key: 'jupiter', expected: 100 },
          { name: 'Birdeye Trending', key: 'birdeyeTrending', expected: 20 },
          { name: 'Birdeye Meme', key: 'birdeyeMeme', expected: 100 },
          { name: 'DexScreener', key: 'dexscreener', expected: 40 },
          { name: 'Birdeye Mcap', key: 'birdeyeMcap', expected: 50 },
        ];

        let totalTokens = 0;
        let workingSources = 0;

        for (const source of sources) {
          const count = sourceStats[source.key] || 0;
          totalTokens += count;
          const status = count > 0 ? '✅' : '❌';
          if (count > 0) workingSources++;
          const pct = source.expected > 0 ? Math.round((count / source.expected) * 100) : 0;
          message += `${status} *${source.name}*: ${count} tokens`;
          if (count > 0 && count < source.expected) {
            message += ` (${pct}% of expected)`;
          }
          message += '\n';
        }

        message += `\n*Summary:*\n`;
        message += `• Working sources: ${workingSources}/${sources.length}\n`;
        message += `• Total tokens discovered: ${totalTokens}\n`;
        message += `• Last scan: ${stats.lastScanTime || 'Not yet'}\n\n`;

        // Health assessment
        if (workingSources >= 4) {
          message += '✅ Discovery health: GOOD';
        } else if (workingSources >= 2) {
          message += '⚠️ Discovery health: DEGRADED';
        } else {
          message += '❌ Discovery health: CRITICAL';
        }

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        await this.bot!.sendMessage(chatId,
          '*🔌 Discovery Source Health*\n\n' +
          'No source data available yet.\n' +
          'Wait for the next scan cycle (every 5 minutes).',
          { parse_mode: 'Markdown' }
        );
      }
    });

    // /tiers command - Show tier configuration
    this.bot.onText(/\/tiers/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot!.sendMessage(chatId,
        '*📈 Mature Token Strategy Tiers*\n\n' +
        '*🚀 RISING Tier*\n' +
        '• Market Cap: $500K - $8M\n' +
        '• Min Holders: 500\n' +
        '• Min Age: 3 days (72h)\n' +
        '• Min Volume: $50K/24h\n' +
        '• Stop Loss: 25% initial\n' +
        '• Allocation: 25% of signals\n' +
        '• Risk Level: 5 (highest)\n\n' +
        '*🌱 EMERGING Tier*\n' +
        '• Market Cap: $8M - $20M\n' +
        '• Min Holders: 100\n' +
        '• Min Age: 21 days\n' +
        '• Min Volume: $300K/24h\n' +
        '• Stop Loss: 20% initial\n' +
        '• Allocation: 30% of signals\n' +
        '• Risk Level: 4\n\n' +
        '*🎓 GRADUATED Tier*\n' +
        '• Market Cap: $20M - $50M\n' +
        '• Min Holders: 100\n' +
        '• Min Age: 21 days\n' +
        '• Min Volume: $500K/24h\n' +
        '• Stop Loss: 18% initial\n' +
        '• Allocation: 30% of signals\n' +
        '• Risk Level: 3\n\n' +
        '*🏛️ ESTABLISHED Tier*\n' +
        '• Market Cap: $50M - $150M\n' +
        '• Min Holders: 100\n' +
        '• Min Age: 21 days\n' +
        '• Min Volume: $1M/24h\n' +
        '• Stop Loss: 15% initial\n' +
        '• Allocation: 15% of signals\n' +
        '• Risk Level: 2 (lowest)\n\n' +
        '_Seamless coverage from $500K to $150M_',
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

    // ============ ALPHA WALLET COMMANDS ============

    // /addwallet <address> [label] - Add an alpha wallet for tracking
    this.bot.onText(/\/addwallet\s+(\S+)(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id?.toString() || 'unknown';
      const address = match?.[1];
      const label = match?.[2]?.trim();

      if (!address) {
        await this.bot!.sendMessage(chatId,
          '*Usage:* `/addwallet <address> [label]`\n\n' +
          'Example: `/addwallet 5Ks8fE... Smart Trader`',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      try {
        await this.bot!.sendMessage(chatId, 'Adding wallet...', { parse_mode: 'Markdown' });

        const result = await alphaWalletManager.addWallet(address, userId, label);

        if (result.success) {
          await this.bot!.sendMessage(chatId,
            `✅ *Wallet Added*\n\n` +
            `Address: \`${address.slice(0, 8)}...${address.slice(-6)}\`\n` +
            `${label ? `Label: ${label}\n` : ''}` +
            `Status: PROBATION\n\n` +
            `_${result.message}_`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await this.bot!.sendMessage(chatId,
            `❌ *Failed to add wallet*\n\n${result.message}`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId, address }, 'Failed to add alpha wallet');
        await this.bot!.sendMessage(chatId, `Failed to add wallet: ${errorMessage}`);
      }
    });

    // /wallets - List all tracked alpha wallets
    this.bot.onText(/\/wallets(?:\s+(\S+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const addressArg = match?.[1];

      try {
        // If an address is provided, show details for that wallet
        if (addressArg) {
          const wallet = await alphaWalletManager.getWalletByAddress(addressArg);
          if (wallet) {
            const message = alphaWalletManager.formatWalletDetails(wallet);
            await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          } else {
            await this.bot!.sendMessage(chatId, 'Wallet not found in tracked list.');
          }
          return;
        }

        // Otherwise list all wallets
        const wallets = await alphaWalletManager.getWallets(false);
        const message = alphaWalletManager.formatWalletsList(wallets);

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get wallets');
        await this.bot!.sendMessage(chatId, `Failed to get wallets: ${errorMessage}`);
      }
    });

    // /removewallet <address> - Remove an alpha wallet from tracking
    this.bot.onText(/\/removewallet\s+(\S+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id?.toString() || 'unknown';
      const address = match?.[1];

      if (!address) {
        await this.bot!.sendMessage(chatId,
          '*Usage:* `/removewallet <address>`\n\n' +
          'Example: `/removewallet 5Ks8fE...`',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      try {
        const result = await alphaWalletManager.removeWallet(address, userId);

        if (result.success) {
          await this.bot!.sendMessage(chatId,
            `✅ *Wallet Removed*\n\n` +
            `Address: \`${address.slice(0, 8)}...${address.slice(-6)}\`\n\n` +
            `_${result.message}_`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await this.bot!.sendMessage(chatId,
            `❌ *Failed to remove wallet*\n\n${result.message}`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId, address }, 'Failed to remove alpha wallet');
        await this.bot!.sendMessage(chatId, `Failed to remove wallet: ${errorMessage}`);
      }
    });

    // Handle raw wallet addresses pasted into chat (auto-add feature)
    this.bot.onText(/^([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (msg, match) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id?.toString() || 'unknown';
      const address = match?.[1];

      // Only respond if it's a valid Solana address pattern
      if (!address) return;

      // Check if this is already a KOL wallet or alpha wallet
      const isTracked = await alphaWalletManager.isTracked(address);
      const kolWallet = await Database.getWalletByAddress(address);

      if (kolWallet) {
        await this.bot!.sendMessage(chatId,
          `ℹ️ This wallet is already tracked as a *verified KOL wallet* (${kolWallet.kol.handle})`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (isTracked) {
        const wallet = await alphaWalletManager.getWalletByAddress(address);
        if (wallet) {
          const message = alphaWalletManager.formatWalletDetails(wallet);
          await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        }
        return;
      }

      // Prompt to add the wallet
      await this.bot!.sendMessage(chatId,
        `🔍 *Detected Solana wallet address*\n\n` +
        `\`${address.slice(0, 8)}...${address.slice(-6)}\`\n\n` +
        `Would you like to add this to alpha wallet tracking?\n\n` +
        `Use: \`/addwallet ${address}\`\n` +
        `Or with label: \`/addwallet ${address} My Alpha Trader\``,
        { parse_mode: 'Markdown' }
      );
    });

    // /performance command - Show compact signal performance report for analysis
    this.bot.onText(/\/performance/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        await this.bot!.sendMessage(chatId, 'Generating compact performance report...', { parse_mode: 'Markdown' });

        const compactReport = await this.generateCompactPerformanceReport();
        await this.bot!.sendMessage(chatId, compactReport, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get performance report');
        await this.bot!.sendMessage(chatId, `Failed to get performance report: ${errorMessage}`);
      }
    });

    // /report command - Full AI-powered performance analysis with recommendations
    this.bot.onText(/\/report(?:\s+(\d+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const hours = match?.[1] ? parseInt(match[1]) : 168; // Default 7 days

      try {
        await this.bot!.sendMessage(chatId, `📊 Generating AI performance report (last ${Math.round(hours / 24)} days)...`, { parse_mode: 'Markdown' });

        const report = await aiQueryInterface.getPerformanceReport(hours);
        const formattedReport = this.formatAIReport(report);

        // Split into multiple messages if too long
        const messages = this.splitLongMessage(formattedReport, 4000);
        for (const message of messages) {
          await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to generate AI report');
        await this.bot!.sendMessage(chatId, `Failed to generate report: ${errorMessage}`);
      }
    });

    // /recent command - Show recent signals with current performance
    this.bot.onText(/\/recent(?:\s+(\d+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const limit = match?.[1] ? Math.min(parseInt(match[1]), 10) : 5;

      try {
        const recentSignals = await signalPerformanceTracker.getRecentSignals(limit);

        if (recentSignals.length === 0) {
          await this.bot!.sendMessage(chatId,
            '*📊 Recent Signals*\n\nNo signals recorded yet.',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        let message = '*📊 Recent Signals*\n\n';

        for (const signal of recentSignals) {
          const timeSince = Math.round((Date.now() - new Date(signal.signalTime).getTime()) / (1000 * 60 * 60));
          const timeStr = timeSince < 24 ? `${timeSince}h ago` : `${Math.round(timeSince / 24)}d ago`;

          // Outcome indicator
          let outcomeEmoji = '⏳'; // Pending
          if (signal.outcome === 'WIN') outcomeEmoji = '✅';
          else if (signal.outcome === 'LOSS') outcomeEmoji = '❌';

          // Return indicator
          const returnPct = signal.finalReturn || 0;
          const returnStr = returnPct >= 0 ? `+${returnPct.toFixed(0)}%` : `${returnPct.toFixed(0)}%`;
          const returnEmoji = returnPct >= 100 ? '🚀' : returnPct >= 50 ? '📈' : returnPct >= 0 ? '➡️' : returnPct > -20 ? '📉' : '💀';

          message += `${outcomeEmoji} *$${this.escapeMarkdown(signal.tokenTicker)}*\n`;
          message += `   ${returnEmoji} ${returnStr} | ${timeStr}\n`;
          message += `   Score: ${signal.momentumScore}/${signal.onChainScore}\n\n`;
        }

        message += `_Use /recent 10 to see more_`;

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get recent signals');
        await this.bot!.sendMessage(chatId, `Failed to get recent signals: ${errorMessage}`);
      }
    });

    // /tierperf command - Show performance breakdown by tier
    this.bot.onText(/\/tierperf(?:\s+(\d+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const days = match?.[1] ? parseInt(match[1]) : 7;
      const hours = days * 24;

      try {
        const tierStats = await signalPerformanceTracker.getTierPerformance(hours);

        let message = `*📊 Performance by Tier (${days}d)*\n\n`;

        const tiers = [
          { key: 'RISING', emoji: '🚀', range: '$500K-$8M' },
          { key: 'EMERGING', emoji: '🌱', range: '$8M-$20M' },
          { key: 'GRADUATED', emoji: '🎓', range: '$20M-$50M' },
          { key: 'ESTABLISHED', emoji: '🏛️', range: '$50M-$150M' },
        ];

        let totalSignals = 0;
        let totalWins = 0;

        for (const tier of tiers) {
          const stats = tierStats[tier.key as keyof typeof tierStats];
          totalSignals += stats.count;
          totalWins += stats.wins;

          if (stats.count > 0) {
            const winRateEmoji = stats.winRate >= 60 ? '✅' : stats.winRate >= 40 ? '⚠️' : '❌';
            message += `${tier.emoji} *${tier.key}* (${tier.range})\n`;
            message += `   ${winRateEmoji} Win Rate: ${stats.winRate.toFixed(0)}% (${stats.wins}W/${stats.losses}L)\n`;
            message += `   Avg Return: ${stats.avgReturn >= 0 ? '+' : ''}${stats.avgReturn.toFixed(0)}%\n`;
            message += `   Signals: ${stats.count}\n\n`;
          } else {
            message += `${tier.emoji} *${tier.key}* (${tier.range})\n`;
            message += `   _No completed signals_\n\n`;
          }
        }

        // Summary
        const overallWinRate = totalSignals > 0 ? (totalWins / totalSignals) * 100 : 0;
        message += `*Overall:* ${totalSignals} signals, ${overallWinRate.toFixed(0)}% win rate\n\n`;
        message += `_Use /tierperf 30 for 30-day stats_`;

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get tier performance');
        await this.bot!.sendMessage(chatId, `Failed to get tier performance: ${errorMessage}`);
      }
    });

    // /microcap command - Analyze $200K-$500K opportunity
    this.bot.onText(/\/microcap/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        const { matureTokenScanner } = await import('./mature-token/index.js');
        const analysis = matureTokenScanner.getMicroCapAnalysis();

        let message = '*🔬 Micro-Cap Opportunity Analysis*\n';
        message += '*Range: $200K - $500K*\n\n';

        if (analysis.total < 5) {
          message += '⏳ _Collecting data... Need more scan cycles._\n\n';
          message += `Tokens tracked so far: ${analysis.total}\n`;
          message += '_Check back after a few scans._';
          await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          return;
        }

        // Safety stats
        message += `*📊 Sample Size:* ${analysis.total} tokens\n\n`;

        message += '*Safety Filter Results:*\n';
        const safetyEmoji = analysis.passedSafetyPct >= 30 ? '✅' :
          analysis.passedSafetyPct >= 15 ? '⚠️' : '❌';
        message += `${safetyEmoji} Pass ALL filters: ${analysis.passedSafetyPct.toFixed(0)}% (${analysis.passedSafety}/${analysis.total})\n`;
        message += `   • Concentration ≤75%: ${analysis.passedConcentrationPct.toFixed(0)}% (${analysis.passedConcentration})\n`;
        message += `   • Holders ≥250: ${analysis.passedHoldersPct.toFixed(0)}% (${analysis.passedHolders})\n`;
        message += `   • Liquidity ≥$10K: ${analysis.passedLiquidityPct.toFixed(0)}% (${analysis.passedLiquidity})\n\n`;

        message += '*Averages in this range:*\n';
        message += `   • Avg Concentration: ${analysis.avgConcentration.toFixed(0)}%\n`;
        message += `   • Avg Holders: ${analysis.avgHolderCount.toFixed(0)}\n`;
        message += `   • Avg Liquidity: $${(analysis.avgLiquidity / 1000).toFixed(0)}K\n\n`;

        // Recent samples
        if (analysis.recentSamples.length > 0) {
          message += '*Recent Tokens in Range:*\n';
          for (const sample of analysis.recentSamples.slice(0, 5)) {
            const safeEmoji = sample.concentration <= 75 && sample.holders >= 250 ? '✅' : '❌';
            message += `${safeEmoji} $${this.escapeMarkdown(sample.ticker)} - $${(sample.mcap / 1000).toFixed(0)}K | ${sample.holders} holders | ${sample.concentration.toFixed(0)}% conc\n`;
          }
          message += '\n';
        }

        // Recommendation
        message += '*🎯 Analysis:*\n';
        message += analysis.recommendation;

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get micro-cap analysis');
        await this.bot!.sendMessage(chatId, `Failed to analyze micro-caps: ${errorMessage}`);
      }
    });

    // /volumespikes command - Show tokens with unusual volume activity
    this.bot.onText(/\/volumespikes/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        await this.bot!.sendMessage(chatId, 'Scanning for volume anomalies...', { parse_mode: 'Markdown' });

        const anomalies = await volumeAnomalyScanner.getAnomalies();

        if (anomalies.length === 0) {
          await this.bot!.sendMessage(chatId,
            '*📊 Volume Spike Scanner*\n\n' +
            'No significant volume anomalies detected.\n' +
            '_Tokens need 5x+ normal volume to trigger._',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        let message = '*📊 Volume Spike Alerts*\n\n';
        message += `Found ${anomalies.length} tokens with unusual volume:\n\n`;

        for (const anomaly of anomalies.slice(0, 8)) {
          const multiplierEmoji = anomaly.volumeMultiplier >= 10 ? '🔥' :
            anomaly.volumeMultiplier >= 7 ? '🚨' : '📈';

          const washWarning = anomaly.washTradingAnalysis?.isLikelySpoofed ? ' ⚠️' : '';

          message += `${multiplierEmoji} *$${this.escapeMarkdown(anomaly.ticker)}*${washWarning}\n`;
          message += `   Vol: ${anomaly.volumeMultiplier.toFixed(1)}x normal ($${(anomaly.currentVolume24h / 1000).toFixed(0)}K)\n`;
          message += `   MCap: $${(anomaly.marketCap / 1_000_000).toFixed(1)}M | Liq: $${(anomaly.liquidity / 1000).toFixed(0)}K\n`;

          if (anomaly.washTradingAnalysis && anomaly.washTradingAnalysis.suspicionScore > 30) {
            message += `   ⚠️ Wash score: ${anomaly.washTradingAnalysis.suspicionScore}/100\n`;
          }
          message += '\n';
        }

        if (anomalies.length > 8) {
          message += `_+${anomalies.length - 8} more tokens with volume spikes_\n`;
        }

        message += '\n_⚠️ = potential wash trading_';

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get volume spikes');
        await this.bot!.sendMessage(chatId, `Failed to scan volume: ${errorMessage}`);
      }
    });

    // /stats command - Historical performance dashboard
    this.bot.onText(/\/stats/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        // Get all-time stats (use a large hour value)
        const allTimeStats = await signalPerformanceTracker.getPerformanceStats(8760); // 1 year
        const weekStats = await signalPerformanceTracker.getPerformanceStats(168);     // 7 days
        const dayStats = await signalPerformanceTracker.getPerformanceStats(24);       // 24 hours

        let message = '*📈 Historical Performance Dashboard*\n\n';

        // Today's stats
        message += '*Last 24 Hours:*\n';
        if (dayStats.totalSignals > 0) {
          message += `• Signals: ${dayStats.totalSignals} (${dayStats.pendingSignals} pending)\n`;
          message += `• Win Rate: ${dayStats.winRate.toFixed(0)}% (${dayStats.wins}W/${dayStats.losses}L)\n`;
          message += `• Avg Return: ${dayStats.avgReturn >= 0 ? '+' : ''}${dayStats.avgReturn.toFixed(0)}%\n\n`;
        } else {
          message += `• _No signals in last 24h_\n\n`;
        }

        // Week stats
        message += '*Last 7 Days:*\n';
        if (weekStats.totalSignals > 0) {
          message += `• Signals: ${weekStats.totalSignals} (${weekStats.pendingSignals} pending)\n`;
          message += `• Win Rate: ${weekStats.winRate.toFixed(0)}% (${weekStats.wins}W/${weekStats.losses}L)\n`;
          message += `• Avg Return: ${weekStats.avgReturn >= 0 ? '+' : ''}${weekStats.avgReturn.toFixed(0)}%\n`;
          message += `• Best: +${weekStats.bestReturn.toFixed(0)}% | Worst: ${weekStats.worstReturn.toFixed(0)}%\n\n`;
        } else {
          message += `• _No signals in last 7d_\n\n`;
        }

        // All-time stats
        message += '*All-Time:*\n';
        if (allTimeStats.totalSignals > 0) {
          message += `• Total Signals: ${allTimeStats.totalSignals}\n`;
          message += `• Completed: ${allTimeStats.completedSignals} | Pending: ${allTimeStats.pendingSignals}\n`;
          message += `• Win Rate: ${allTimeStats.winRate.toFixed(0)}% (${allTimeStats.wins}W/${allTimeStats.losses}L)\n`;
          message += `• Avg Win: +${allTimeStats.avgWinReturn.toFixed(0)}% | Avg Loss: ${allTimeStats.avgLossReturn.toFixed(0)}%\n`;
          message += `• Best: +${allTimeStats.bestReturn.toFixed(0)}% | Worst: ${allTimeStats.worstReturn.toFixed(0)}%\n\n`;
        } else {
          message += `• _No signal history_\n\n`;
        }

        // Performance by score
        if (allTimeStats.completedSignals > 5) {
          message += '*By Score Quality:*\n';
          const { high, medium, low } = allTimeStats.byScoreRange;
          if (high.count > 0) message += `• High (70+): ${high.winRate.toFixed(0)}% WR (${high.count} signals)\n`;
          if (medium.count > 0) message += `• Med (50-69): ${medium.winRate.toFixed(0)}% WR (${medium.count} signals)\n`;
          if (low.count > 0) message += `• Low (<50): ${low.winRate.toFixed(0)}% WR (${low.count} signals)\n`;
        }

        message += '\n_Use /tierperf for tier breakdown_';

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get stats');
        await this.bot!.sendMessage(chatId, `Failed to get stats: ${errorMessage}`);
      }
    });

    // /tweaks command - Get AI-suggested threshold adjustments
    this.bot.onText(/\/tweaks/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        await this.bot!.sendMessage(chatId, '🔧 Analyzing performance data for optimization suggestions...', { parse_mode: 'Markdown' });

        const tweaks = await aiQueryInterface.getSuggestedTweaks();

        if (tweaks.length === 0) {
          await this.bot!.sendMessage(chatId, '✅ No tweaks suggested - current thresholds appear optimal or insufficient data.', { parse_mode: 'Markdown' });
          return;
        }

        let message = '🎯 *AI-SUGGESTED TWEAKS*\n\n';
        for (const tweak of tweaks) {
          message += `*${this.escapeMarkdown(tweak.parameter)}*\n`;
          message += `Current: ${this.escapeMarkdown(String(tweak.currentValue))} → Suggested: ${this.escapeMarkdown(String(tweak.suggestedValue))}\n`;
          message += `📝 ${this.escapeMarkdown(tweak.reason)}\n`;
          message += `📈 Expected: ${this.escapeMarkdown(tweak.expectedImpact)}\n\n`;
        }
        message += 'Use /adjust\\_thresholds to apply changes manually';

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get tweaks');
        await this.bot!.sendMessage(chatId, `Failed to get suggestions: ${errorMessage}`);
      }
    });

    // /ask command - Ask a specific question about performance
    this.bot.onText(/\/ask\s+(.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const question = match?.[1];

      if (!question) {
        await this.bot!.sendMessage(chatId, 'Usage: /ask <question>\nExample: /ask What is the win rate?', { parse_mode: 'Markdown' });
        return;
      }

      try {
        await this.bot!.sendMessage(chatId, '🤔 Analyzing...', { parse_mode: 'Markdown' });

        const answer = await aiQueryInterface.answerQuestion(question);
        // Escape markdown in AI-generated answer to prevent parsing errors
        await this.bot!.sendMessage(chatId, this.escapeMarkdown(answer));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to answer question');
        await this.bot!.sendMessage(chatId, `Failed to analyze: ${errorMessage}`);
      }
    });

    // /optimize command - Run threshold optimization
    this.bot.onText(/\/optimize/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        await this.bot!.sendMessage(chatId, 'Running threshold optimization...', { parse_mode: 'Markdown' });

        const result = await thresholdOptimizer.optimize(false);

        let message = '🎯 *THRESHOLD OPTIMIZATION RESULTS*\n\n';
        message += `📊 Data Points: ${result.dataPoints}\n`;
        message += `📈 Current Win Rate: ${result.currentWinRate.toFixed(1)}%\n`;
        message += `🎯 Target Win Rate: ${result.targetWinRate}%\n\n`;

        if (result.recommendations.length === 0) {
          message += '_Insufficient data for recommendations_\n';
        } else {
          message += '*Current Thresholds:*\n';
          message += `• Min Momentum: ${result.currentThresholds.minMomentumScore}\n`;
          message += `• Min OnChain: ${result.currentThresholds.minOnChainScore}\n`;
          message += `• Min Safety: ${result.currentThresholds.minSafetyScore}\n`;
          message += `• Max Bundle Risk: ${result.currentThresholds.maxBundleRiskScore}\n\n`;

          const changes = result.recommendations.filter(r => r.changeDirection !== 'MAINTAIN');
          if (changes.length > 0) {
            message += '*Recommended Changes:*\n';
            for (const rec of changes) {
              const arrow = rec.changeDirection === 'INCREASE' ? '↑' : '↓';
              message += `${arrow} ${this.escapeMarkdown(rec.factor)}: ${rec.currentValue} → ${rec.recommendedValue}\n`;
              message += `   ${this.escapeMarkdown(rec.reason)}\n`;
            }
            message += '\nUse /apply\\_thresholds to apply recommendations';
          } else {
            message += '✅ All thresholds are optimally configured\n';
          }
        }

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to run optimization');
        await this.bot!.sendMessage(chatId, `Failed to run optimization: ${errorMessage}`);
      }
    });

    // /apply_thresholds command - Apply recommended threshold changes
    this.bot.onText(/\/apply_thresholds/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        await this.bot!.sendMessage(chatId, 'Applying threshold optimization...', { parse_mode: 'Markdown' });

        const result = await thresholdOptimizer.optimize(true);

        let message = '✅ *THRESHOLDS UPDATED*\n\n';

        if (result.autoApplied && result.appliedChanges.length > 0) {
          message += '*Applied Changes:*\n';
          for (const change of result.appliedChanges) {
            message += `• ${change}\n`;
          }
          message += '\n*New Thresholds:*\n';
          message += `• Min Momentum: ${result.recommendedThresholds.minMomentumScore}\n`;
          message += `• Min OnChain: ${result.recommendedThresholds.minOnChainScore}\n`;
          message += `• Min Safety: ${result.recommendedThresholds.minSafetyScore}\n`;
          message += `• Max Bundle Risk: ${result.recommendedThresholds.maxBundleRiskScore}\n`;
        } else {
          message += '_No changes were applied._\n';
          message += 'Either thresholds are already optimal or insufficient data.';
        }

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to apply thresholds');
        await this.bot!.sendMessage(chatId, `Failed to apply thresholds: ${errorMessage}`);
      }
    });

    // /thresholds command - View current signal thresholds
    this.bot.onText(/\/thresholds/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        const current = thresholdOptimizer.getCurrentThresholds();
        const defaults = thresholdOptimizer.getDefaultThresholds();

        let message = '🎯 *SIGNAL THRESHOLDS*\n\n';
        message += '*Current Values:*\n';
        message += `• Min Momentum Score: ${current.minMomentumScore}`;
        if (current.minMomentumScore !== defaults.minMomentumScore) {
          message += ` (default: ${defaults.minMomentumScore})`;
        }
        message += '\n';

        message += `• Min OnChain Score: ${current.minOnChainScore}`;
        if (current.minOnChainScore !== defaults.minOnChainScore) {
          message += ` (default: ${defaults.minOnChainScore})`;
        }
        message += '\n';

        message += `• Min Safety Score: ${current.minSafetyScore}`;
        if (current.minSafetyScore !== defaults.minSafetyScore) {
          message += ` (default: ${defaults.minSafetyScore})`;
        }
        message += '\n';

        message += `• Max Bundle Risk: ${current.maxBundleRiskScore}`;
        if (current.maxBundleRiskScore !== defaults.maxBundleRiskScore) {
          message += ` (default: ${defaults.maxBundleRiskScore})`;
        }
        message += '\n';

        message += `• Min Liquidity: $${current.minLiquidity.toLocaleString()}`;
        if (current.minLiquidity !== defaults.minLiquidity) {
          message += ` (default: $${defaults.minLiquidity.toLocaleString()})`;
        }
        message += '\n';

        message += `• Max Top10 Concentration: ${current.maxTop10Concentration}%`;
        if (current.maxTop10Concentration !== defaults.maxTop10Concentration) {
          message += ` (default: ${defaults.maxTop10Concentration}%)`;
        }
        message += '\n\n';

        // Check if any threshold differs from default
        const hasChanges =
          current.minMomentumScore !== defaults.minMomentumScore ||
          current.minOnChainScore !== defaults.minOnChainScore ||
          current.minSafetyScore !== defaults.minSafetyScore ||
          current.maxBundleRiskScore !== defaults.maxBundleRiskScore ||
          current.minLiquidity !== defaults.minLiquidity ||
          current.maxTop10Concentration !== defaults.maxTop10Concentration;

        if (hasChanges) {
          message += '⚠️ Thresholds have been modified from defaults.\n';
          message += 'Use `/reset_thresholds` to restore defaults.\n\n';
        } else {
          message += '✅ Using default thresholds.\n\n';
        }

        message += '_Higher min scores = stricter filtering (fewer signals)_\n';
        message += '_Lower max scores = stricter filtering (fewer signals)_';

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get thresholds');
        await this.bot!.sendMessage(chatId, `Failed to get thresholds: ${errorMessage}`);
      }
    });

    // /reset_thresholds command - Reset to defaults
    this.bot.onText(/\/reset_thresholds/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        const defaults = await thresholdOptimizer.resetThresholds();

        let message = '✅ *THRESHOLDS RESET TO DEFAULTS*\n\n';
        message += `• Min Momentum Score: ${defaults.minMomentumScore}\n`;
        message += `• Min OnChain Score: ${defaults.minOnChainScore}\n`;
        message += `• Min Safety Score: ${defaults.minSafetyScore}\n`;
        message += `• Max Bundle Risk: ${defaults.maxBundleRiskScore}\n`;
        message += `• Min Liquidity: $${defaults.minLiquidity.toLocaleString()}\n`;
        message += `• Max Top10 Concentration: ${defaults.maxTop10Concentration}%\n\n`;
        message += '_Signal filtering restored to original settings._';

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to reset thresholds');
        await this.bot!.sendMessage(chatId, `Failed to reset thresholds: ${errorMessage}`);
      }
    });

    // /adjust_thresholds command - Conversational threshold adjustment
    this.bot.onText(/\/adjust_thresholds/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        const current = thresholdOptimizer.getCurrentThresholds();

        let message = '🎯 *ADJUST THRESHOLDS*\n\n';
        message += 'Select a threshold to adjust:\n\n';
        message += '*Current Values:*\n';
        message += `1️⃣ Min Momentum: ${current.minMomentumScore}\n`;
        message += `2️⃣ Min OnChain: ${current.minOnChainScore}\n`;
        message += `3️⃣ Min Safety: ${current.minSafetyScore}\n`;
        message += `4️⃣ Max Bundle Risk: ${current.maxBundleRiskScore}\n`;
        message += `5️⃣ Min Liquidity: $${current.minLiquidity.toLocaleString()}\n`;
        message += `6️⃣ Max Top10 Concentration: ${current.maxTop10Concentration}%\n\n`;
        message += '_Tap a button below to adjust that threshold_';

        // Create inline keyboard for threshold selection
        const keyboard: TelegramBot.InlineKeyboardMarkup = {
          inline_keyboard: [
            [
              { text: '1️⃣ Momentum', callback_data: 'adjust_minMomentumScore' },
              { text: '2️⃣ OnChain', callback_data: 'adjust_minOnChainScore' },
            ],
            [
              { text: '3️⃣ Safety', callback_data: 'adjust_minSafetyScore' },
              { text: '4️⃣ Bundle Risk', callback_data: 'adjust_maxBundleRiskScore' },
            ],
            [
              { text: '5️⃣ Liquidity', callback_data: 'adjust_minLiquidity' },
              { text: '6️⃣ Top10 Conc.', callback_data: 'adjust_maxTop10Concentration' },
            ],
            [
              { text: '❌ Cancel', callback_data: 'adjust_cancel' },
            ],
          ],
        };

        await this.bot!.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to show threshold adjustment menu');
        await this.bot!.sendMessage(chatId, `Failed to show adjustment menu: ${errorMessage}`);
      }
    });

    // Handle callback queries for threshold adjustment
    this.bot.on('callback_query', async (query) => {
      if (!query.data || !query.message) return;
      const chatId = query.message.chat.id;
      const data = query.data;

      // Handle threshold adjustment callbacks
      if (data.startsWith('adjust_')) {
        const action = data.replace('adjust_', '');

        if (action === 'cancel') {
          // Cancel the adjustment
          this.thresholdAdjustmentState.delete(chatId);
          await this.bot!.answerCallbackQuery(query.id, { text: 'Cancelled' });
          await this.bot!.sendMessage(chatId, '❌ Threshold adjustment cancelled.');
          return;
        }

        // Valid threshold key
        const thresholdKey = action as keyof import('./performance/threshold-optimizer.js').ThresholdSet;
        const current = thresholdOptimizer.getCurrentThresholds();
        const currentValue = current[thresholdKey];

        // Set state for this user
        this.thresholdAdjustmentState.set(chatId, {
          threshold: thresholdKey,
          awaitingValue: true,
        });

        // Get threshold info for the message
        const thresholdInfo = this.getThresholdInfo(thresholdKey);

        let message = `📝 *Adjusting: ${thresholdInfo.name}*\n\n`;
        message += `Current Value: *${thresholdInfo.format(currentValue)}*\n`;
        message += `${thresholdInfo.description}\n\n`;
        message += `*Valid Range:* ${thresholdInfo.min} - ${thresholdInfo.max}\n`;
        message += `${thresholdInfo.higherMeans}\n\n`;
        message += '_Reply with the new value:_';

        await this.bot!.answerCallbackQuery(query.id);
        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      }
    });

    // Handle text messages for threshold value input
    this.bot.on('message', async (msg) => {
      if (!msg.text || msg.text.startsWith('/')) return;
      const chatId = msg.chat.id;

      // Check if user is in threshold adjustment flow
      const state = this.thresholdAdjustmentState.get(chatId);
      if (!state || !state.awaitingValue || !state.threshold) return;

      const inputValue = msg.text.trim();
      const thresholdKey = state.threshold;
      const thresholdInfo = this.getThresholdInfo(thresholdKey);

      // Parse the value
      let newValue: number;
      if (thresholdKey === 'minLiquidity') {
        // Handle liquidity input (may have $ or k/K suffix)
        const cleanedInput = inputValue.replace(/[$,]/g, '').toLowerCase();
        if (cleanedInput.endsWith('k')) {
          newValue = parseFloat(cleanedInput.slice(0, -1)) * 1000;
        } else {
          newValue = parseFloat(cleanedInput);
        }
      } else {
        newValue = parseFloat(inputValue);
      }

      // Validate the value
      if (isNaN(newValue)) {
        await this.bot!.sendMessage(chatId, `❌ Invalid number. Please enter a valid number between ${thresholdInfo.min} and ${thresholdInfo.max}.`);
        return;
      }

      if (newValue < thresholdInfo.min || newValue > thresholdInfo.max) {
        await this.bot!.sendMessage(chatId, `❌ Value out of range. Please enter a number between ${thresholdInfo.min} and ${thresholdInfo.max}.`);
        return;
      }

      // Apply the new threshold
      try {
        const current = thresholdOptimizer.getCurrentThresholds();
        const oldValue = current[thresholdKey];

        // Update the threshold
        thresholdOptimizer.setThresholds({ [thresholdKey]: newValue });

        // Clear the state
        this.thresholdAdjustmentState.delete(chatId);

        let message = `✅ *Threshold Updated*\n\n`;
        message += `*${thresholdInfo.name}*\n`;
        message += `Previous: ${thresholdInfo.format(oldValue)}\n`;
        message += `New: ${thresholdInfo.format(newValue)}\n\n`;
        message += `Use /thresholds to see all current values\n`;
        message += `Use /adjust\\_thresholds to change another threshold`;

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });

        logger.info({ chatId, threshold: thresholdKey, oldValue, newValue }, 'Threshold manually adjusted');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to update threshold');
        await this.bot!.sendMessage(chatId, `❌ Failed to update threshold: ${errorMessage}`);
      }
    });

    // /learning command - ML prediction system info
    this.bot.onText(/\/learning/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        const modelSummary = winPredictor.getModelSummary();

        let message = '🧠 *ML PREDICTION SYSTEM*\n\n';

        // System overview
        message += '*How It Works:*\n';
        message += 'The bot uses machine learning to predict which signals are most likely to hit +100% (WIN).\n\n';

        message += '📚 *Learning Process:*\n';
        message += '• Analyzes historical signal outcomes (WIN/LOSS)\n';
        message += '• Learns which factors correlate with wins\n';
        message += '• Discovers winning and losing patterns\n';
        message += '• Retrains weekly for statistical significance\n\n';

        // Training status
        if (modelSummary.lastTrained) {
          const trainedAgo = Math.round((Date.now() - modelSummary.lastTrained.getTime()) / (1000 * 60));
          message += `⏱️ *Last Trained:* ${trainedAgo < 60 ? `${trainedAgo}m ago` : `${Math.round(trainedAgo / 60)}h ago`}\n\n`;
        } else {
          message += '⏱️ *Last Trained:* Not yet trained\n\n';
        }

        // Feature weights
        if (modelSummary.featureWeights.length > 0) {
          message += '📊 *Top Predictive Features:*\n';
          for (const fw of modelSummary.featureWeights.slice(0, 5)) {
            const direction = fw.weight > 0 ? '↑' : '↓';
            const importance = Math.round(fw.importance * 100);
            message += `• ${this.formatFeatureName(fw.feature)}: ${direction} (${importance}% importance)\n`;
          }
          message += '\n';
        }

        // Winning patterns
        if (modelSummary.winningPatterns.length > 0) {
          message += '✅ *Winning Patterns Discovered:*\n';
          for (const pattern of modelSummary.winningPatterns.slice(0, 4)) {
            message += `• ${pattern.name}: ${pattern.winRate}% WR\n`;
          }
          message += '\n';
        }

        // Losing patterns
        if (modelSummary.losingPatterns.length > 0) {
          message += '⚠️ *Risk Patterns (to avoid):*\n';
          for (const pattern of modelSummary.losingPatterns.slice(0, 3)) {
            message += `• ${pattern.name}: ${pattern.winRate}% WR\n`;
          }
          message += '\n';
        }

        // DUAL-TRACK performance stats
        try {
          const stats = await signalPerformanceTracker.getPerformanceStats(168); // 7 days
          if (stats.byTrack) {
            const provenStats = stats.byTrack.PROVEN_RUNNER;
            const earlyStats = stats.byTrack.EARLY_QUALITY;
            if (provenStats.count > 0 || earlyStats.count > 0) {
              message += '🔀 *Track Performance (7d):*\n';
              if (provenStats.count > 0) {
                message += `• 🏃 Proven Runner: ${provenStats.count} signals, ${provenStats.winRate.toFixed(0)}% WR\n`;
              }
              if (earlyStats.count > 0) {
                message += `• ⚡ Early Quality: ${earlyStats.count} signals, ${earlyStats.winRate.toFixed(0)}% WR\n`;
              }
              message += '\n';
            }
          }
        } catch (trackError) {
          // Ignore track stats errors
        }

        // Prediction output explanation
        message += '🎯 *What Predictions Tell You:*\n';
        message += '• *Win Probability:* 0-100% chance of +100% return\n';
        message += '• *Confidence:* HIGH/MEDIUM/LOW based on pattern matches\n';
        message += '• *Recommendation:* STRONG\\_BUY / BUY / WATCH / SKIP\n';
        message += '• *Optimal Hold Time:* Predicted best duration\n';
        message += '• *Early Exit Risk:* Chance of hitting stop-loss early\n\n';

        message += '💡 *Tips:*\n';
        message += '• Higher win probability = better signal quality\n';
        message += '• HIGH confidence means multiple patterns matched\n';
        message += '• More training data = better predictions\n';
        message += '• System improves as it learns from outcomes';

        await this.bot!.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get learning info');
        await this.bot!.sendMessage(chatId, `Failed to get learning info: ${errorMessage}`);
      }
    });

    // /learningmode command - Show current learning mode status
    this.bot.onText(/\/learningmode/, async (msg) => {
      const chatId = msg.chat.id;

      try {
        const isLearningMode = appConfig.trading.learningMode;
        const modelSummary = winPredictor.getModelSummary();
        const thresholds = thresholdOptimizer.getCurrentThresholds();

        let message = '🎓 LEARNING MODE STATUS\n\n';

        // Current status
        if (isLearningMode) {
          message += '✅ Learning Mode: ENABLED\n\n';
          message += 'What this means:\n';
          message += '• Signal filtering is RELAXED to collect more data\n';
          message += '• Only STRONG AVOID recommendations are blocked\n';
          message += '• ML probability threshold lowered to 15-20%\n';
          message += '• More signals will come through for training\n';
          message += '• Rate limits bypassed for data collection\n\n';
        } else {
          message += '🔒 Learning Mode: DISABLED\n\n';
          message += 'What this means:\n';
          message += '• Signal filtering is STRICT for quality\n';
          message += '• Both AVOID and STRONG AVOID blocked\n';
          message += '• ML probability threshold at 50-55%\n';
          message += '• Fewer but higher quality signals\n\n';
        }

        // Signal thresholds in effect
        message += 'Current Signal Thresholds:\n';
        message += `• Min Momentum Score: ${thresholds.minMomentumScore}\n`;
        message += `• Min OnChain Score: ${thresholds.minOnChainScore}\n`;
        message += `• ML Probability Threshold: ${isLearningMode ? '15-20%' : '50-55%'}\n\n`;

        // Training data status
        message += 'Training Data:\n';
        message += `• Model trained: ${modelSummary.lastTrained ? 'Yes' : 'Not yet'}\n`;
        message += `• Patterns discovered: ${modelSummary.winningPatterns.length + modelSummary.losingPatterns.length}\n\n`;

        // Recommendation
        if (isLearningMode) {
          message += '💡 Recommendation:\n';
          message += 'Keep learning mode ON until you have:\n';
          message += '• At least 30 completed signals\n';
          message += '• At least 5 winning patterns discovered\n';
          message += '• Stable win rate in performance reports\n\n';
          message += 'Set LEARNING_MODE=false in .env to disable';
        } else {
          message += '💡 Recommendation:\n';
          message += 'If you are not receiving signals, consider:\n';
          message += '• Setting LEARNING_MODE=true in .env\n';
          message += '• Lowering minOnChainScore threshold\n';
          message += '• Checking /thresholds for current values';
        }

        await this.bot!.sendMessage(chatId, message);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, chatId }, 'Failed to get learning mode info');
        await this.bot!.sendMessage(chatId, `Failed to get learning mode info: ${errorMessage}`);
      }
    });
  }

  /**
   * Get threshold info for display
   */
  private getThresholdInfo(key: string): {
    name: string;
    description: string;
    min: number;
    max: number;
    higherMeans: string;
    format: (value: number) => string;
  } {
    const infos: Record<string, any> = {
      minMomentumScore: {
        name: 'Min Momentum Score',
        description: 'Minimum momentum score required for a signal. Measures buying pressure, volume velocity, and price action.',
        min: 0,
        max: 100,
        higherMeans: '↑ Higher = stricter filtering (fewer signals)',
        format: (v: number) => `${v}/100`,
      },
      minOnChainScore: {
        name: 'Min OnChain Score',
        description: 'Minimum on-chain health score. Measures holder distribution, liquidity depth, and trading activity.',
        min: 0,
        max: 100,
        higherMeans: '↑ Higher = stricter filtering (fewer signals)',
        format: (v: number) => `${v}/100`,
      },
      minSafetyScore: {
        name: 'Min Safety Score',
        description: 'Minimum safety score. Checks authority status, LP locks, insider activity, and contract risks.',
        min: 0,
        max: 100,
        higherMeans: '↑ Higher = stricter filtering (fewer signals)',
        format: (v: number) => `${v}/100`,
      },
      maxBundleRiskScore: {
        name: 'Max Bundle Risk Score',
        description: 'Maximum acceptable bundle/coordinated wallet risk. Detects potential manipulation and coordinated buys.',
        min: 0,
        max: 100,
        higherMeans: '↓ Lower = stricter filtering (fewer signals)',
        format: (v: number) => `${v}/100`,
      },
      minLiquidity: {
        name: 'Min Liquidity',
        description: 'Minimum liquidity pool size in USD. Higher liquidity = easier to exit positions.',
        min: 1000,
        max: 100000,
        higherMeans: '↑ Higher = stricter filtering (fewer signals)',
        format: (v: number) => `$${v.toLocaleString()}`,
      },
      maxTop10Concentration: {
        name: 'Max Top10 Concentration',
        description: 'Maximum token concentration allowed in top 10 holders. High concentration = whale manipulation risk.',
        min: 30,
        max: 90,
        higherMeans: '↓ Lower = stricter filtering (fewer signals)',
        format: (v: number) => `${v}%`,
      },
    };

    return infos[key] || {
      name: key,
      description: 'Signal threshold',
      min: 0,
      max: 100,
      higherMeans: '',
      format: (v: number) => String(v),
    };
  }

  /**
   * Format feature name for display
   */
  private formatFeatureName(name: string): string {
    return name
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  }

  /**
   * Send a buy signal alert
   */
  async sendBuySignal(signal: BuySignal): Promise<boolean> {
    if (!this.bot) {
      logger.warn('Bot not initialized - cannot send signal');
      return false;
    }

    // RACE CONDITION PROTECTION: Synchronous check BEFORE any async operations
    if (this.signalsInProgress.has(signal.tokenAddress)) {
      logger.debug({
        tokenAddress: signal.tokenAddress,
      }, 'Buy signal already in progress (race condition prevented)');
      return false;
    }

    // Immediately mark as in-progress (synchronous)
    this.signalsInProgress.add(signal.tokenAddress);

    try {
      // Check rate limits
      const rateLimitResult = await this.checkRateLimits(signal);
      if (!rateLimitResult.allowed) {
        logger.info({ reason: rateLimitResult.reason, tokenAddress: signal.tokenAddress },
          'Signal blocked by rate limit');
        this.signalQueue.push(signal);
        return false;
      }

      // Get prediction if available (for ML comparison in follow-ups)
      const prediction = (signal as any).prediction;

      // Analyze follow-up context BEFORE recording (so we compare to previous state)
      const followUpContext = this.analyzeFollowUpContext(signal, prediction);

      // QUALITY GATE: Suppress resends with clearly negative momentum
      if (followUpContext.isFollowUp && followUpContext.shouldSuppress) {
        logger.info({
          tokenAddress: signal.tokenAddress,
          ticker: signal.tokenTicker,
          classification: followUpContext.classification,
          suppressReason: followUpContext.suppressReason,
          positiveChanges: followUpContext.positiveChanges,
          negativeChanges: followUpContext.negativeChanges,
          timeSinceFirst: followUpContext.timeSinceFirst,
        }, 'Follow-up signal SUPPRESSED - momentum clearly negative');

        // Still record in history to track the decline, but don't send
        this.recordSignalHistory(signal, prediction);
        return false;
      }

      const message = this.formatBuySignal(signal, followUpContext);

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

      // Record signal in history for follow-up tracking
      this.recordSignalHistory(signal, prediction);

      logger.info({
        tokenAddress: signal.tokenAddress,
        ticker: signal.tokenTicker,
        score: signal.score.compositeScore,
        kol: signal.kolActivity.kol.handle,
        isFollowUp: followUpContext.isFollowUp,
        classification: followUpContext.classification,
        narrative: followUpContext.narrative,
        momentumScore: followUpContext.momentumScore,
      }, followUpContext.isFollowUp ? `Follow-up signal sent (${followUpContext.classification})` : 'Buy signal sent');

      return true;
    } catch (error) {
      logger.error({ error, signal: signal.tokenAddress }, 'Failed to send Telegram alert');
      return false;
    } finally {
      // Always remove from in-progress set when done
      this.signalsInProgress.delete(signal.tokenAddress);
    }
  }

  /**
   * Format buy signal message
   */
  private formatBuySignal(signal: BuySignal, followUpContext?: FollowUpContext): string {
    const { kolActivity, score, tokenMetrics, socialMetrics, scamFilter, dexScreenerInfo, ctoAnalysis } = signal;
    const wallet = kolActivity.wallet;
    const tx = kolActivity.transaction;
    const perf = kolActivity.performance;

    // Build the message with clear visual hierarchy
    let msg = `\n`;
    msg += `═══════════════════════════════\n`;

    // Different header for follow-up signals
    if (followUpContext?.isFollowUp) {
      // Classification-based header with visual cue
      const classificationHeader = this.getClassificationHeader(followUpContext.classification);
      msg += `${classificationHeader.emoji}  *${classificationHeader.title}*\n`;
      msg += `    Score: *${score.compositeScore}/100* · ${score.confidence}\n`;
      msg += `═══════════════════════════════\n\n`;

      // Momentum indicator
      const momentumIndicator = this.getMomentumIndicator(followUpContext);
      msg += `${momentumIndicator}\n\n`;

      // Narrative summary - the key insight
      if (followUpContext.narrative) {
        msg += `💡 *${followUpContext.narrative}*\n\n`;
      }

      // Rich before/after comparison
      if (followUpContext.metricsComparison && followUpContext.metricsComparison.length > 0) {
        msg += `📊 *METRICS COMPARISON* (${followUpContext.timeSinceFirst}min)\n`;
        for (const m of followUpContext.metricsComparison) {
          if (m.direction === 'flat') continue; // Skip unchanged metrics
          const arrow = m.direction === 'up' ? '↑' : '↓';
          const sentiment = m.isPositive ? '✅' : '⚠️';
          const prevStr = this.formatMetricValue(m.name, m.previous);
          const currStr = this.formatMetricValue(m.name, m.current);
          const changeStr = m.changePercent >= 0 ? `+${m.changePercent.toFixed(0)}%` : `${m.changePercent.toFixed(0)}%`;
          msg += `├─ ${sentiment} ${m.emoji} ${m.name}: ${prevStr} → ${currStr} (${arrow}${changeStr})\n`;
        }
        msg += `\n`;
      }

      // ML Prediction comparison (if available)
      if (followUpContext.predictionComparison) {
        const pc = followUpContext.predictionComparison;
        const probArrow = pc.probChange >= 0 ? '↑' : '↓';
        const probEmoji = pc.probChange >= 0 ? '🎯' : '⚠️';
        msg += `${probEmoji} *ML Win Prob:* ${pc.previousWinProb}% → ${pc.currentWinProb}% (${probArrow}${pc.probChange >= 0 ? '+' : ''}${pc.probChange.toFixed(0)}%)\n`;

        if (pc.newRiskFactors && pc.newRiskFactors.length > 0) {
          msg += `🚨 *New Risks:* ${pc.newRiskFactors.slice(0, 2).join(', ')}\n`;
        }
        if (pc.lostPatterns && pc.lostPatterns.length > 0) {
          msg += `❌ *Lost Patterns:* ${pc.lostPatterns.slice(0, 2).join(', ')}\n`;
        }
        if (pc.gainedPatterns && pc.gainedPatterns.length > 0) {
          msg += `✅ *New Patterns:* ${pc.gainedPatterns.slice(0, 2).join(', ')}\n`;
        }
        msg += `\n`;
      }
    } else {
      msg += `🎯  *KOL CONFIRMED BUY SIGNAL*\n`;
      msg += `    Score: *${score.compositeScore}/100* · ${score.confidence}\n`;
      msg += `═══════════════════════════════\n\n`;
    }

    // Token info
    msg += `*Token:* \`$${signal.tokenTicker}\` (${this.truncateAddress(signal.tokenAddress)})\n`;
    msg += `*Chain:* Solana\n\n`;

    
        // DexScreener & CTO Status
        msg += this.formatDexScreenerCTOStatus(dexScreenerInfo, ctoAnalysis);
        msg += `\n`;
    msg += `───────────────────────────────\n`;
    // Signal metrics
    msg += `📊 *SIGNAL METRICS*\n`;
    msg += `├─ Composite Score: *${score.compositeScore}/100*\n`;
    msg += `├─ Confidence: *${score.confidence}*\n`;
    msg += `├─ Risk Level: *${score.riskLevel}/5*\n`;
    msg += `└─ Signal Type: KOL\\_CONFIRMED\n\n`;
    
    msg += `───────────────────────────────\n`;
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

    msg += `───────────────────────────────\n`;
    // On-chain data
    msg += `📈 *ON-CHAIN DATA*\n`;
    msg += `├─ Price: $${this.formatPrice(tokenMetrics.price)}\n`;
    msg += `├─ Market Cap: $${this.formatNumber(tokenMetrics.marketCap)}\n`;
    msg += `├─ 24h Volume: $${this.formatNumber(tokenMetrics.volume24h)}\n`;
    msg += `├─ Holders: ${tokenMetrics.holderCount} (${tokenMetrics.holderChange1h >= 0 ? '+' : ''}${tokenMetrics.holderChange1h}% 1h)\n`;
    msg += `├─ Top 10: ${tokenMetrics.top10Concentration.toFixed(1)}%\n`;
    msg += `├─ Vol Auth: ${signal.volumeAuthenticity.score}/100\n`;
    msg += `└─ Bundle Risk: ${scamFilter.bundleAnalysis.riskLevel === 'LOW' ? '🟢 CLEAR' : scamFilter.bundleAnalysis.riskLevel === 'MEDIUM' ? '🟡 FLAGGED' : '🔴 HIGH'}\n\n`;

    msg += `───────────────────────────────\n`;
    // Social signals - X Integration
    msg += `𝕏 *X/SOCIAL SIGNALS*\n`;

    // Social velocity with visual indicator
    const velocityEmoji = socialMetrics.mentionVelocity1h >= 50 ? '🔥' :
                          socialMetrics.mentionVelocity1h >= 20 ? '📈' :
                          socialMetrics.mentionVelocity1h >= 5 ? '📊' : '📉';
    const velocityLabel = socialMetrics.mentionVelocity1h >= 50 ? 'VIRAL' :
                          socialMetrics.mentionVelocity1h >= 20 ? 'HIGH' :
                          socialMetrics.mentionVelocity1h >= 5 ? 'MODERATE' : 'LOW';
    msg += `├─ Velocity: ${velocityEmoji} *${socialMetrics.mentionVelocity1h}* mentions/hr (${velocityLabel})\n`;

    // Engagement quality score
    const engagementPercent = Math.round(socialMetrics.engagementQuality * 100);
    const engagementEmoji = engagementPercent >= 70 ? '🟢' : engagementPercent >= 40 ? '🟡' : '🔴';
    msg += `├─ Engagement: ${engagementEmoji} ${engagementPercent}/100\n`;

    // Account authenticity
    const authPercent = Math.round(socialMetrics.accountAuthenticity * 100);
    const authEmoji = authPercent >= 70 ? '✅' : authPercent >= 40 ? '⚠️' : '🚨';
    msg += `├─ Authenticity: ${authEmoji} ${authPercent}/100\n`;

    // KOL mentions with tiers
    if (socialMetrics.kolMentions.length > 0) {
      const kolDisplay = socialMetrics.kolMentions.slice(0, 3).map(k => {
        const tierBadge = k.tier ? `[${k.tier}]` : '';
        return `@${k.handle}${tierBadge}`;
      }).join(', ');
      msg += `├─ KOL Mentions: 👑 ${kolDisplay}\n`;
    } else {
      msg += `├─ KOL Mentions: None yet\n`;
    }

    // Sentiment
    msg += `├─ Sentiment: ${socialMetrics.sentimentPolarity > 0.3 ? '🟢 POSITIVE' : socialMetrics.sentimentPolarity > -0.3 ? '🟡 NEUTRAL' : '🔴 NEGATIVE'}\n`;
    msg += `└─ Narrative: ${socialMetrics.narrativeFit || 'N/A'}\n\n`;

    msg += `───────────────────────────────\n`;
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
    
    msg += `───────────────────────────────\n`;
    // Trade Links (Feature 6)
    msg += `*Quick Trade:*\n`;
    msg += formatLinksAsMarkdown(signal.tokenAddress);
    msg += `\n\n`;

    // Footer
    msg += `⏱️ _Signal: ${signal.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;
    msg += `⚠️ _DYOR. Not financial advice. KOL buys ≠ guaranteed profits._\n`;
    msg += `═══════════════════════════════\n`;

    return msg;
  }

  /**
   * Generate compact performance report for analysis
   * Format optimized for pasting to Claude for threshold tuning
   * Enhanced with granular score bands and full signal details
   */
  private async generateCompactPerformanceReport(): Promise<string> {
    const stats = await signalPerformanceTracker.getPerformanceStats(168); // Last 7 days
    const correlations = await signalPerformanceTracker.getFactorCorrelations();
    const thresholds = thresholdOptimizer.getCurrentThresholds();
    const rawData = await this.getRawSignalData();

    let msg = '📊 *PERFORMANCE REPORT (7d)*\n\n';

    // Summary
    msg += `*Summary*\n`;
    msg += `Signals: ${stats.totalSignals} (${stats.completedSignals} done, ${stats.pendingSignals} pending)\n`;
    msg += `Win Rate: ${stats.winRate.toFixed(1)}% (${stats.wins}W/${stats.losses}L)\n`;
    msg += `Avg Return: ${stats.avgReturn.toFixed(1)}%\n`;
    msg += `Best: ${stats.bestReturn.toFixed(1)}% | Worst: ${stats.worstReturn.toFixed(1)}%\n\n`;

    // Score Bands (condensed)
    const scoreBands = this.calculateScoreBands(rawData);
    const activeBands = scoreBands.filter(b => b.count > 0);
    if (activeBands.length > 0) {
      msg += `*By Score*\n`;
      for (const band of activeBands) {
        msg += `${band.range}: ${band.count} signals, ${band.winRate.toFixed(0)}% WR\n`;
      }
      msg += '\n';
    }

    // By Strength (condensed)
    const activeStrengths = Object.entries(stats.byStrength).filter(([_, d]) => d.count > 0);
    if (activeStrengths.length > 0) {
      msg += `*By Strength*\n`;
      for (const [strength, data] of activeStrengths) {
        msg += `${strength}: ${data.count} signals, ${data.winRate.toFixed(0)}% WR\n`;
      }
      msg += '\n';
    }

    // By Track (DUAL-TRACK system)
    const activeTracks = Object.entries(stats.byTrack).filter(([_, d]) => d.count > 0);
    if (activeTracks.length > 0) {
      msg += `*By Track*\n`;
      for (const [track, data] of activeTracks) {
        const trackLabel = track === 'PROVEN_RUNNER' ? '🏃 Proven' : '⚡ Early';
        msg += `${trackLabel}: ${data.count} signals, ${data.winRate.toFixed(0)}% WR\n`;
      }
      msg += '\n';
    }

    // Time Analysis (condensed)
    const timeAnalysis = this.analyzeTimeToOutcome(rawData);
    if (timeAnalysis.avgWinTime > 0 || timeAnalysis.avgLossTime > 0) {
      msg += `*Timing*\n`;
      msg += `Win avg: ${timeAnalysis.avgWinTime.toFixed(1)}h | Loss avg: ${timeAnalysis.avgLossTime.toFixed(1)}h\n\n`;
    }

    // Top Correlations (only top 5)
    if (correlations.length > 0) {
      msg += `*Top Factors*\n`;
      for (const c of correlations.slice(0, 5)) {
        const sign = c.correlation >= 0 ? '+' : '';
        msg += `${c.factor}: ${sign}${c.correlation.toFixed(2)}\n`;
      }
      msg += '\n';
    }

    // Current Thresholds
    msg += `*Thresholds*\n`;
    msg += `Mom≥${thresholds.minMomentumScore} OC≥${thresholds.minOnChainScore} Safe≥${thresholds.minSafetyScore}\n`;
    msg += `Bundle≤${thresholds.maxBundleRiskScore} Liq≥$${thresholds.minLiquidity} Top10≤${thresholds.maxTop10Concentration}%`;

    return msg;
  }

  /**
   * Calculate statistics for granular score bands
   */
  private calculateScoreBands(rawData: any[]): {
    range: string;
    count: number;
    wins: number;
    losses: number;
    winRate: number;
    avgReturn: number;
  }[] {
    const bands = [
      { min: 75, max: 100, range: '75-100' },
      { min: 65, max: 74, range: '65-74 ' },
      { min: 55, max: 64, range: '55-64 ' },
      { min: 45, max: 54, range: '45-54 ' },
      { min: 35, max: 44, range: '35-44 ' },
      { min: 0, max: 34, range: '0-34  ' },
    ];

    return bands.map(band => {
      const inBand = rawData.filter(s => {
        const score = parseFloat(s.onchain_score || 0);
        return score >= band.min && score <= band.max;
      });

      const completed = inBand.filter(s => s.final_outcome !== 'PENDING');
      const wins = completed.filter(s => s.final_outcome === 'WIN');
      const losses = completed.filter(s => s.final_outcome === 'LOSS');
      const returns = completed.map(s => parseFloat(s.final_return || 0));

      return {
        range: band.range,
        count: inBand.length,
        wins: wins.length,
        losses: losses.length,
        winRate: completed.length > 0 ? (wins.length / completed.length) * 100 : 0,
        avgReturn: returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0,
      };
    });
  }

  /**
   * Analyze time-to-outcome patterns
   */
  private analyzeTimeToOutcome(rawData: any[]): {
    avgWinTime: number;
    avgLossTime: number;
    winsViaTP: number;
    winsViaTimeout: number;
    lossesViaSL: number;
    lossesViaTimeout: number;
  } {
    const wins = rawData.filter(s => s.final_outcome === 'WIN');
    const losses = rawData.filter(s => s.final_outcome === 'LOSS');

    // Calculate average time to outcome (approximated from last_update - signal_time)
    const calcAvgTime = (signals: any[]): number => {
      if (signals.length === 0) return 0;
      const times = signals.map(s => {
        const signalTime = new Date(s.signal_time).getTime();
        const lastUpdate = new Date(s.last_update || s.signal_time).getTime();
        return (lastUpdate - signalTime) / (1000 * 60 * 60); // hours
      });
      return times.reduce((a, b) => a + b, 0) / times.length;
    };

    // Count TP hits vs timeout wins
    const winsViaTP = wins.filter(s => s.hit_take_profit === true).length;
    const winsViaTimeout = wins.length - winsViaTP;

    // Count SL hits vs timeout losses
    const lossesViaSL = losses.filter(s => s.hit_stop_loss === true).length;
    const lossesViaTimeout = losses.length - lossesViaSL;

    return {
      avgWinTime: calcAvgTime(wins),
      avgLossTime: calcAvgTime(losses),
      winsViaTP,
      winsViaTimeout,
      lossesViaSL,
      lossesViaTimeout,
    };
  }

  /**
   * Get raw signal data from database
   * Includes all fields needed for comprehensive analysis
   */
  private async getRawSignalData(): Promise<any[]> {
    try {
      const result = await pool.query(`
        SELECT token_ticker, signal_type, momentum_score, onchain_score, safety_score,
               bundle_risk_score, signal_strength, entry_liquidity, entry_token_age,
               entry_holder_count, entry_top10_concentration, entry_buy_sell_ratio,
               entry_unique_buyers, final_outcome, final_return, return_1h, return_4h,
               return_24h, max_return, min_return, signal_time, last_update,
               hit_stop_loss, hit_take_profit, entry_price, entry_mcap
        FROM signal_performance
        ORDER BY signal_time DESC
        LIMIT 100
      `);
      return result.rows;
    } catch (error) {
      logger.error({ error }, 'Failed to get raw signal data');
      return [];
    }
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
   * LEARNING MODE: Allows follow-up signals with 10 min minimum interval
   * Follow-ups are now valuable - they show momentum building
   */
  private async checkRateLimits(signal: BuySignal): Promise<{ allowed: boolean; reason?: string }> {
    // Clean up old entries from signal history
    this.cleanupSignalHistory();

    // Check minimum interval between signals for the same token (prevents spam)
    const previousSnapshot = this.signalHistory.get(signal.tokenAddress);
    if (previousSnapshot) {
      const timeSince = Date.now() - previousSnapshot.timestamp;

      // Always enforce minimum 10 min between follow-ups to prevent spam
      if (timeSince < this.MIN_FOLLOWUP_INTERVAL_MS) {
        logger.debug({
          tokenAddress: signal.tokenAddress,
          timeSinceMs: timeSince,
          minIntervalMs: this.MIN_FOLLOWUP_INTERVAL_MS,
        }, 'Follow-up too soon - minimum 10 min between signals');
        return { allowed: false, reason: 'Follow-up too soon (10 min minimum)' };
      }
    }

    // LEARNING MODE: Allow more signals, follow-ups provide valuable data
    if (appConfig.trading.learningMode) {
      logger.debug({
        tokenAddress: signal.tokenAddress,
        isFollowUp: !!previousSnapshot,
      }, 'Learning mode: signal allowed');
      return { allowed: true };
    }

    // PRODUCTION MODE: Full rate limiting
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

    // Check token cooldown from database (for follow-ups after bot restart)
    if (!previousSnapshot) {
      const lastTokenSignal = await Database.getLastSignalTime(signal.tokenAddress);
      if (lastTokenSignal) {
        const timeSince = Date.now() - lastTokenSignal.getTime();
        if (timeSince < RATE_LIMITS.TOKEN_COOLDOWN_MS) {
          return { allowed: false, reason: 'Token cooldown active' };
        }
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
   * Clean up old entries from signal history cache
   */
  private cleanupSignalHistory(): void {
    const now = Date.now();
    for (const [address, snapshot] of this.signalHistory) {
      if (now - snapshot.timestamp > this.SIGNAL_HISTORY_TTL_MS) {
        this.signalHistory.delete(address);
      }
    }
  }

  /**
   * Create a snapshot of signal metrics for comparison
   * Enhanced to capture additional fields for rich resend analysis
   */
  private createSignalSnapshot(signal: BuySignal, prediction?: any): SignalSnapshot {
    return {
      timestamp: Date.now(),
      ticker: signal.tokenTicker,
      price: signal.tokenMetrics.price,
      marketCap: signal.tokenMetrics.marketCap,
      volume24h: signal.tokenMetrics.volume24h,
      holderCount: signal.tokenMetrics.holderCount,
      compositeScore: signal.score.compositeScore,
      socialMomentum: signal.score.factors.socialMomentum,
      mentionVelocity: signal.socialMetrics.mentionVelocity1h,
      kolHandle: signal.kolActivity.kol.handle,
      kolCount: 1,
      // Enhanced fields - use optional chaining for momentum data
      buySellRatio: (signal as any).momentumData?.buySellRatio,
      uniqueBuyers5m: (signal as any).momentumData?.uniqueBuyers,
      top10Concentration: signal.tokenMetrics.top10Concentration,
      prediction: prediction ? {
        winProbability: prediction.winProbability,
        confidence: prediction.confidence,
        matchedPatterns: prediction.matchedPatterns,
        riskFactors: prediction.riskFactors,
      } : undefined,
      weakeningSignalCount: 0,
    };
  }

  /**
   * Analyze if this is a follow-up signal and what changed
   * Enhanced with momentum quality gate, classification, and rich context
   */
  private analyzeFollowUpContext(signal: BuySignal, currentPrediction?: any): FollowUpContext {
    const previous = this.signalHistory.get(signal.tokenAddress);

    if (!previous) {
      return { isFollowUp: false, timeSinceFirst: 0, changes: [], positiveChanges: 0, negativeChanges: 0 };
    }

    const timeSinceFirst = Math.round((Date.now() - previous.timestamp) / 60000); // minutes
    const current = this.createSignalSnapshot(signal, currentPrediction);

    // Build comprehensive metrics comparison
    const metricsComparison: MetricComparison[] = [];
    let positiveChanges = 0;
    let negativeChanges = 0;

    // Helper to add metric comparison
    const addMetric = (
      name: string,
      emoji: string,
      prev: number,
      curr: number,
      positiveDirection: 'up' | 'down' = 'up',
      significantThreshold: number = 10 // percent change to be considered significant
    ) => {
      const change = curr - prev;
      const changePercent = prev > 0 ? (change / prev) * 100 : (curr > 0 ? 100 : 0);
      const direction: 'up' | 'down' | 'flat' =
        changePercent > 5 ? 'up' : changePercent < -5 ? 'down' : 'flat';
      const isPositive = direction === positiveDirection || direction === 'flat';

      // Only count significant changes
      if (Math.abs(changePercent) >= significantThreshold) {
        if (isPositive && direction !== 'flat') positiveChanges++;
        else if (!isPositive) negativeChanges++;
      }

      metricsComparison.push({
        name, emoji, previous: prev, current: curr, change, changePercent, direction, isPositive
      });
    };

    // Core metrics (all tracked for comparison)
    addMetric('MC', '💰', previous.marketCap, current.marketCap, 'up', 15);
    addMetric('Score', '📊', previous.compositeScore, current.compositeScore, 'up', 5);
    addMetric('Holders', '👥', previous.holderCount, current.holderCount, 'up', 10);
    addMetric('Volume', '📈', previous.volume24h, current.volume24h, 'up', 20);
    addMetric('Social', '🔊', previous.mentionVelocity, current.mentionVelocity, 'up', 25);

    // Buy pressure (if available)
    if (previous.buySellRatio !== undefined && current.buySellRatio !== undefined) {
      addMetric('Buy/Sell', '⚖️', previous.buySellRatio, current.buySellRatio || 0, 'up', 15);
    }

    // Check for new KOL entry (strong catalyst)
    const newKolEntry = current.kolHandle !== previous.kolHandle;
    if (newKolEntry) {
      positiveChanges += 2; // New KOL is worth 2 positive points
    }

    // ML Prediction comparison
    let predictionComparison: FollowUpContext['predictionComparison'] | undefined;
    if (previous.prediction && currentPrediction) {
      const probChange = currentPrediction.winProbability - previous.prediction.winProbability;
      const prevPatterns = new Set<string>(previous.prediction.matchedPatterns || []);
      const currPatterns = new Set<string>(currentPrediction.matchedPatterns || []);
      const prevRisks = new Set<string>(previous.prediction.riskFactors || []);
      const currRisks = new Set<string>(currentPrediction.riskFactors || []);

      predictionComparison = {
        previousWinProb: previous.prediction.winProbability,
        currentWinProb: currentPrediction.winProbability,
        probChange,
        lostPatterns: [...prevPatterns].filter((p: string) => !currPatterns.has(p)),
        gainedPatterns: [...currPatterns].filter((p: string) => !prevPatterns.has(p)),
        newRiskFactors: [...currRisks].filter((r: string) => !prevRisks.has(r)),
      };

      // Factor prediction change into momentum score
      if (probChange >= 10) positiveChanges++;
      else if (probChange <= -10) negativeChanges++;
    }

    // Calculate momentum score (-5 to +5)
    const momentumScore = Math.max(-5, Math.min(5, positiveChanges - negativeChanges));

    // Determine classification based on momentum assessment
    let classification: ResendClassification;
    let shouldSuppress = false;
    let suppressReason: string | undefined;

    if (newKolEntry || (positiveChanges >= 3 && negativeChanges === 0)) {
      classification = 'NEW_CATALYST';
    } else if (positiveChanges >= 2 && positiveChanges > negativeChanges) {
      classification = 'MOMENTUM_CONFIRMED';
    } else if (positiveChanges > 0 && negativeChanges > 0) {
      classification = 'MIXED_SIGNALS';
    } else if (negativeChanges >= 3 || (negativeChanges >= 2 && positiveChanges === 0)) {
      // Quality gate: suppress if clearly deteriorating
      classification = 'SUPPRESS';
      shouldSuppress = true;
      suppressReason = this.generateSuppressionReason(metricsComparison, predictionComparison);
    } else {
      classification = 'DETERIORATING';
    }

    // Generate legacy changes array for backward compatibility
    const changes = this.generateLegacyChanges(metricsComparison, newKolEntry, current.kolHandle, timeSinceFirst);

    // Generate narrative summary
    const narrative = this.generateResendNarrative(
      classification,
      metricsComparison,
      newKolEntry,
      current.kolHandle,
      predictionComparison
    );

    return {
      isFollowUp: true,
      timeSinceFirst,
      changes,
      classification,
      shouldSuppress,
      suppressReason,
      momentumScore,
      positiveChanges,
      negativeChanges,
      metricsComparison,
      narrative,
      predictionComparison,
    };
  }

  /**
   * Generate suppression reason for logging
   */
  private generateSuppressionReason(
    metrics: MetricComparison[],
    prediction?: FollowUpContext['predictionComparison']
  ): string {
    const declining = metrics
      .filter(m => !m.isPositive && m.direction !== 'flat')
      .map(m => m.name.toLowerCase());

    let reason = `Momentum fading: ${declining.join(', ')} declining`;

    if (prediction && prediction.probChange < -15) {
      reason += `, ML win prob dropped ${Math.abs(prediction.probChange).toFixed(0)}%`;
    }

    return reason;
  }

  /**
   * Generate legacy changes array for backward compatibility
   */
  private generateLegacyChanges(
    metrics: MetricComparison[],
    newKolEntry: boolean,
    kolHandle: string,
    timeSinceFirst: number
  ): string[] {
    const changes: string[] = [];

    for (const m of metrics) {
      if (m.direction === 'flat') continue;

      const changeStr = m.changePercent >= 0 ? `+${m.changePercent.toFixed(0)}%` : `${m.changePercent.toFixed(0)}%`;

      if (m.name === 'MC') {
        if (m.changePercent >= 20) changes.push(`🚀 MC up ${changeStr}`);
        else if (m.changePercent <= -20) changes.push(`⚠️ MC down ${changeStr}`);
      } else if (m.name === 'Score') {
        if (m.change >= 5) changes.push(`📈 Score up (+${m.change.toFixed(0)})`);
        else if (m.change <= -5) changes.push(`📉 Score down (${m.change.toFixed(0)})`);
      } else if (m.name === 'Holders') {
        if (m.change >= 20 || m.changePercent >= 15) changes.push(`👥 Holders +${m.change.toFixed(0)}`);
        else if (m.change <= -10) changes.push(`👥 Holders ${m.change.toFixed(0)}`);
      } else if (m.name === 'Volume') {
        if (m.changePercent >= 30) changes.push(`💰 Volume ${changeStr}`);
        else if (m.changePercent <= -30) changes.push(`💰 Volume ${changeStr}`);
      } else if (m.name === 'Social') {
        if (m.changePercent >= 50) changes.push(`🔊 Social ${changeStr}`);
      }
    }

    if (newKolEntry) {
      changes.push(`🐋 New KOL: @${kolHandle}`);
    }

    if (changes.length === 0) {
      changes.push(`🔄 Re-triggered after ${timeSinceFirst}min`);
    }

    return changes;
  }

  /**
   * Generate a one-line narrative explaining why this resend matters
   */
  private generateResendNarrative(
    classification: ResendClassification,
    metrics: MetricComparison[],
    newKolEntry: boolean,
    kolHandle: string,
    prediction?: FollowUpContext['predictionComparison']
  ): string {
    const mcMetric = metrics.find(m => m.name === 'MC');
    const holdersMetric = metrics.find(m => m.name === 'Holders');
    const volumeMetric = metrics.find(m => m.name === 'Volume');
    const scoreMetric = metrics.find(m => m.name === 'Score');

    switch (classification) {
      case 'NEW_CATALYST':
        if (newKolEntry) {
          return `New whale entry: @${kolHandle} buying in${mcMetric && mcMetric.changePercent < -10 ? ' while MC consolidating' : ''}`;
        }
        return 'Strong momentum: multiple metrics surging simultaneously';

      case 'MOMENTUM_CONFIRMED':
        const improving = metrics.filter(m => m.isPositive && m.direction === 'up').map(m => m.name.toLowerCase());
        if (holdersMetric?.isPositive && volumeMetric?.isPositive) {
          return `Accumulation confirmed: holder growth + volume surge indicates strong interest`;
        }
        return `Momentum building: ${improving.slice(0, 2).join(' + ')} trending up`;

      case 'MIXED_SIGNALS':
        const positive = metrics.filter(m => m.isPositive && m.direction !== 'flat').map(m => m.name.toLowerCase());
        const negative = metrics.filter(m => !m.isPositive && m.direction !== 'flat').map(m => m.name.toLowerCase());

        if (mcMetric && mcMetric.changePercent < -20 && holdersMetric?.isPositive) {
          return `Potential dip opportunity: MC down ${Math.abs(mcMetric.changePercent).toFixed(0)}% but holders accumulating`;
        }
        return `Mixed: ${positive[0] || 'some metrics'} up, ${negative[0] || 'others'} down - use caution`;

      case 'DETERIORATING':
        if (prediction && prediction.probChange < -10) {
          return `Caution: ML win probability dropped from ${prediction.previousWinProb}% to ${prediction.currentWinProb}%`;
        }
        return `Weakening: metrics declining but still above signal thresholds`;

      case 'SUPPRESS':
        return `Suppressed: momentum clearly negative, not worth your attention`;

      default:
        return 'Follow-up signal detected';
    }
  }

  /**
   * Record signal in history for follow-up tracking
   */
  private recordSignalHistory(signal: BuySignal, prediction?: any): void {
    const existing = this.signalHistory.get(signal.tokenAddress);
    const snapshot = this.createSignalSnapshot(signal, prediction);

    if (existing) {
      // Keep original timestamp, update metrics, increment KOL count
      snapshot.timestamp = existing.timestamp;
      snapshot.kolCount = existing.kolCount + (signal.kolActivity.kol.handle !== existing.kolHandle ? 1 : 0);
      // Preserve original prediction if new one not provided
      if (!snapshot.prediction && existing.prediction) {
        snapshot.prediction = existing.prediction;
      }
    }

    this.signalHistory.set(signal.tokenAddress, snapshot);
  }

  /**
   * Analyze follow-up context for on-chain signals
   * Enhanced with momentum quality gate, classification, and rich context
   */
  private analyzeOnChainFollowUp(signal: any, previous: SignalSnapshot | undefined): FollowUpContext {
    if (!previous) {
      return { isFollowUp: false, timeSinceFirst: 0, changes: [], positiveChanges: 0, negativeChanges: 0 };
    }

    const timeSinceFirst = Math.round((Date.now() - previous.timestamp) / 60000);
    const currentPrediction = signal.prediction;

    // Build comprehensive metrics comparison
    const metricsComparison: MetricComparison[] = [];
    let positiveChanges = 0;
    let negativeChanges = 0;

    // Helper to add metric comparison
    const addMetric = (
      name: string,
      emoji: string,
      prev: number,
      curr: number,
      positiveDirection: 'up' | 'down' = 'up',
      significantThreshold: number = 10
    ) => {
      const change = curr - prev;
      const changePercent = prev > 0 ? (change / prev) * 100 : (curr > 0 ? 100 : 0);
      const direction: 'up' | 'down' | 'flat' =
        changePercent > 5 ? 'up' : changePercent < -5 ? 'down' : 'flat';
      const isPositive = direction === positiveDirection || direction === 'flat';

      if (Math.abs(changePercent) >= significantThreshold) {
        if (isPositive && direction !== 'flat') positiveChanges++;
        else if (!isPositive) negativeChanges++;
      }

      metricsComparison.push({
        name, emoji, previous: prev, current: curr, change, changePercent, direction, isPositive
      });
    };

    // Core metrics
    const currentScore = signal.onChainScore?.total || 0;
    const currentMC = signal.metrics?.marketCap || signal.tokenMetrics?.marketCap || 0;
    const currentHolders = signal.metrics?.holderCount || signal.tokenMetrics?.holderCount || 0;
    const currentVolume = signal.metrics?.volume24h || signal.tokenMetrics?.volume24h || 0;
    const currentBuySell = signal.momentumScore?.metrics?.buySellRatio || 0;

    addMetric('MC', '💰', previous.marketCap, currentMC, 'up', 15);
    addMetric('Score', '📊', previous.compositeScore, currentScore, 'up', 5);
    addMetric('Holders', '👥', previous.holderCount, currentHolders, 'up', 10);
    addMetric('Volume', '📈', previous.volume24h, currentVolume, 'up', 20);

    if (previous.buySellRatio !== undefined && currentBuySell > 0) {
      addMetric('Buy/Sell', '⚖️', previous.buySellRatio, currentBuySell, 'up', 15);
    }

    // ML Prediction comparison
    let predictionComparison: FollowUpContext['predictionComparison'] | undefined;
    if (previous.prediction && currentPrediction) {
      const probChange = currentPrediction.winProbability - previous.prediction.winProbability;
      const prevPatterns = new Set<string>(previous.prediction.matchedPatterns || []);
      const currPatterns = new Set<string>(currentPrediction.matchedPatterns || []);
      const prevRisks = new Set<string>(previous.prediction.riskFactors || []);
      const currRisks = new Set<string>(currentPrediction.riskFactors || []);

      predictionComparison = {
        previousWinProb: previous.prediction.winProbability,
        currentWinProb: currentPrediction.winProbability,
        probChange,
        lostPatterns: [...prevPatterns].filter((p: string) => !currPatterns.has(p)),
        gainedPatterns: [...currPatterns].filter((p: string) => !prevPatterns.has(p)),
        newRiskFactors: [...currRisks].filter((r: string) => !prevRisks.has(r)),
      };

      if (probChange >= 10) positiveChanges++;
      else if (probChange <= -10) negativeChanges++;
    }

    // Calculate momentum score
    const momentumScore = Math.max(-5, Math.min(5, positiveChanges - negativeChanges));

    // Determine classification
    let classification: ResendClassification;
    let shouldSuppress = false;
    let suppressReason: string | undefined;

    if (positiveChanges >= 3 && negativeChanges === 0) {
      classification = 'NEW_CATALYST';
    } else if (positiveChanges >= 2 && positiveChanges > negativeChanges) {
      classification = 'MOMENTUM_CONFIRMED';
    } else if (positiveChanges > 0 && negativeChanges > 0) {
      classification = 'MIXED_SIGNALS';
    } else if (negativeChanges >= 3 || (negativeChanges >= 2 && positiveChanges === 0)) {
      classification = 'SUPPRESS';
      shouldSuppress = true;
      suppressReason = this.generateSuppressionReason(metricsComparison, predictionComparison);
    } else {
      classification = 'DETERIORATING';
    }

    // Generate legacy changes array
    const changes = this.generateLegacyChanges(metricsComparison, false, 'ONCHAIN', timeSinceFirst);

    // Generate narrative
    const narrative = this.generateResendNarrative(
      classification,
      metricsComparison,
      false,
      'ONCHAIN',
      predictionComparison
    );

    return {
      isFollowUp: true,
      timeSinceFirst,
      changes,
      classification,
      shouldSuppress,
      suppressReason,
      momentumScore,
      positiveChanges,
      negativeChanges,
      metricsComparison,
      narrative,
      predictionComparison,
    };
  }

  /**
   * Record on-chain signal in history
   * @param classification - Optional classification to track weakening signals
   */
  private recordOnChainSignalHistory(signal: any, classification?: ResendClassification): void {
    const existing = this.signalHistory.get(signal.tokenAddress);
    const prediction = signal.prediction;

    // Increment weakening count if this was a DETERIORATING signal
    let weakeningCount = existing?.weakeningSignalCount || 0;
    if (classification === 'DETERIORATING') {
      weakeningCount++;
    } else if (classification === 'NEW_CATALYST' || classification === 'MOMENTUM_CONFIRMED') {
      // Reset weakening count on positive signals
      weakeningCount = 0;
    }

    const snapshot: SignalSnapshot = {
      timestamp: existing?.timestamp || Date.now(),
      ticker: signal.tokenTicker || '',
      price: signal.metrics?.price || signal.tokenMetrics?.price || 0,
      marketCap: signal.metrics?.marketCap || signal.tokenMetrics?.marketCap || 0,
      volume24h: signal.metrics?.volume24h || signal.tokenMetrics?.volume24h || 0,
      holderCount: signal.metrics?.holderCount || signal.tokenMetrics?.holderCount || 0,
      compositeScore: signal.onChainScore?.total || 0,
      socialMomentum: signal.socialMetrics?.mentionVelocity1h || 0,
      mentionVelocity: signal.socialMetrics?.mentionVelocity1h || 0,
      kolHandle: 'ONCHAIN',
      kolCount: 0,
      // Enhanced fields
      buySellRatio: signal.momentumScore?.metrics?.buySellRatio,
      uniqueBuyers5m: signal.momentumScore?.metrics?.uniqueBuyers5m,
      prediction: prediction ? {
        winProbability: prediction.winProbability,
        confidence: prediction.confidence,
        matchedPatterns: prediction.matchedPatterns,
        riskFactors: prediction.riskFactors,
      } : existing?.prediction,
      weakeningSignalCount: weakeningCount,
    };

    this.signalHistory.set(signal.tokenAddress, snapshot);
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
    const { score, tokenMetrics, moonshotAssessment, safetyResult, scamFilter, socialMetrics, dexScreenerInfo, ctoAnalysis } = signal;

    // Moonshot grade emoji for header
    const gradeEmoji = moonshotAssessment.grade === 'A' ? '🔥' :
                       moonshotAssessment.grade === 'B' ? '✨' :
                       moonshotAssessment.grade === 'C' ? '📈' : '📊';

    // Build the message with clear visual hierarchy
    let msg = `\n`;
    msg += `═══════════════════════════════\n`;
    msg += `🔍  *METRICS DISCOVERY SIGNAL*\n`;
    msg += `    Score: *${score.compositeScore}/100* · Grade: ${gradeEmoji}${moonshotAssessment.grade}\n`;
    msg += `═══════════════════════════════\n\n`;

    // Token info
    msg += `*Token:* \`$${signal.tokenTicker}\` (${this.truncateAddress(signal.tokenAddress)})\n`;
    msg += `*Name:* ${signal.tokenName}\n`;
    msg += `*Chain:* Solana\n`;

    // DexScreener & CTO Status (NEW)
    msg += this.formatDexScreenerCTOStatus(dexScreenerInfo, ctoAnalysis);
    msg += `\n`;

    msg += `───────────────────────────────\n`;
    // Discovery metrics
    msg += `📊 *DISCOVERY METRICS*\n`;
    msg += `├─ Score: *${score.compositeScore}/100*\n`;
    msg += `├─ Confidence: *${score.confidence}*\n`;
    msg += `├─ Risk Level: *${score.riskLevel}/5*\n`;
    msg += `└─ Signal Type: METRICS\\_DISCOVERY\n\n`;

    msg += `───────────────────────────────\n`;
    // Moonshot assessment
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

    msg += `───────────────────────────────\n`;
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

    msg += `───────────────────────────────\n`;
    // Safety check
    msg += `🛡️ *SAFETY CHECK*\n`;
    msg += `├─ Safety Score: ${safetyResult.safetyScore}/100\n`;
    msg += `├─ Mint Authority: ${safetyResult.mintAuthorityEnabled ? '⚠️ ENABLED' : '✅ Revoked'}\n`;
    msg += `├─ Freeze Authority: ${safetyResult.freezeAuthorityEnabled ? '⚠️ ENABLED' : '✅ Revoked'}\n`;
    msg += `├─ Insider Risk: ${safetyResult.insiderAnalysis.insiderRiskScore}/100\n`;
    msg += `└─ Bundle Risk: ${scamFilter.bundleAnalysis.riskLevel === 'LOW' ? '🟢 CLEAR' : scamFilter.bundleAnalysis.riskLevel === 'MEDIUM' ? '🟡 FLAGGED' : '🔴 HIGH'}\n\n`;

    msg += `───────────────────────────────\n`;
    // Social signals - X Integration
    msg += `𝕏 *X/SOCIAL SIGNALS*\n`;

    // Social velocity with visual indicator
    const velocityEmojiD = socialMetrics.mentionVelocity1h >= 50 ? '🔥' :
                          socialMetrics.mentionVelocity1h >= 20 ? '📈' :
                          socialMetrics.mentionVelocity1h >= 5 ? '📊' : '📉';
    const velocityLabelD = socialMetrics.mentionVelocity1h >= 50 ? 'VIRAL' :
                          socialMetrics.mentionVelocity1h >= 20 ? 'HIGH' :
                          socialMetrics.mentionVelocity1h >= 5 ? 'MODERATE' : 'LOW';
    msg += `├─ Velocity: ${velocityEmojiD} *${socialMetrics.mentionVelocity1h}* mentions/hr (${velocityLabelD})\n`;

    // Engagement quality score
    const engagementPercentD = Math.round(socialMetrics.engagementQuality * 100);
    const engagementEmojiD = engagementPercentD >= 70 ? '🟢' : engagementPercentD >= 40 ? '🟡' : '🔴';
    msg += `├─ Engagement: ${engagementEmojiD} ${engagementPercentD}/100\n`;

    // Account authenticity
    const authPercentD = Math.round(socialMetrics.accountAuthenticity * 100);
    const authEmojiD = authPercentD >= 70 ? '✅' : authPercentD >= 40 ? '⚠️' : '🚨';
    msg += `├─ Authenticity: ${authEmojiD} ${authPercentD}/100\n`;

    // KOL mentions with tiers
    if (socialMetrics.kolMentions.length > 0) {
      const kolDisplayD = socialMetrics.kolMentions.slice(0, 3).map(k => {
        const tierBadge = k.tier ? `[${k.tier}]` : '';
        return `@${k.handle}${tierBadge}`;
      }).join(', ');
      msg += `├─ KOL Mentions: 👑 ${kolDisplayD}\n`;
    } else {
      msg += `├─ KOL Mentions: None yet\n`;
    }

    // Sentiment
    msg += `├─ Sentiment: ${socialMetrics.sentimentPolarity > 0.3 ? '🟢 POSITIVE' : socialMetrics.sentimentPolarity > -0.3 ? '🟡 NEUTRAL' : '🔴 NEGATIVE'}\n`;
    msg += `└─ Narrative: ${socialMetrics.narrativeFit || 'N/A'}\n\n`;

    msg += `───────────────────────────────\n`;
    // KOL Status
    msg += `👛 *KOL STATUS*\n`;
    msg += `└─ ⏳ NO KOL ACTIVITY YET\n`;
    msg += `   _Waiting for KOL validation..._\n\n`;

    msg += `───────────────────────────────\n`;
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

    msg += `───────────────────────────────\n`;
    // Trade Links
    msg += `*Quick Trade:*\n`;
    msg += formatLinksAsMarkdown(signal.tokenAddress);
    msg += `\n\n`;

    // Footer
    msg += `⏱️ _Discovery: ${signal.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;
    msg += `⚠️ _DISCOVERY SIGNAL: No KOL validation. Higher risk. DYOR._\n`;
    msg += `═══════════════════════════════\n`;

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

    // RACE CONDITION PROTECTION: Synchronous check BEFORE any async operations
    // This prevents two parallel processes from both passing the history check
    if (this.signalsInProgress.has(signal.tokenAddress)) {
      logger.debug({
        tokenAddress: signal.tokenAddress,
      }, 'Signal already in progress (race condition prevented)');
      return false;
    }

    // Immediately mark as in-progress (synchronous - prevents race condition)
    this.signalsInProgress.add(signal.tokenAddress);

    try {
      // Clean up signal history
      this.cleanupSignalHistory();

      // Check minimum interval between signals for the same token
      const previousSnapshot = this.signalHistory.get(signal.tokenAddress);
      if (previousSnapshot) {
        const timeSince = Date.now() - previousSnapshot.timestamp;
        if (timeSince < this.MIN_FOLLOWUP_INTERVAL_MS) {
          logger.debug({
            tokenAddress: signal.tokenAddress,
            timeSinceMs: timeSince,
          }, 'On-chain follow-up too soon (10 min minimum)');
          return false;
        }
      }

      // Analyze follow-up context for on-chain signals
      const followUpContext = this.analyzeOnChainFollowUp(signal, previousSnapshot);

      // QUALITY GATE: Suppress resends with clearly negative momentum
      if (followUpContext.isFollowUp && followUpContext.shouldSuppress) {
        logger.info({
          tokenAddress: signal.tokenAddress,
          ticker: signal.tokenTicker,
          classification: followUpContext.classification,
          suppressReason: followUpContext.suppressReason,
          positiveChanges: followUpContext.positiveChanges,
          negativeChanges: followUpContext.negativeChanges,
          timeSinceFirst: followUpContext.timeSinceFirst,
        }, 'On-chain follow-up SUPPRESSED - momentum clearly negative');

        // Still record in history to track the decline, but don't send
        this.recordOnChainSignalHistory(signal, followUpContext.classification);
        return false;
      }

      // WEAKENING SIGNAL LIMIT: After 3 weakening signals, only allow BUY signals (positive momentum)
      const weakeningCount = previousSnapshot?.weakeningSignalCount || 0;
      if (followUpContext.isFollowUp &&
          followUpContext.classification === 'DETERIORATING' &&
          weakeningCount >= this.MAX_WEAKENING_SIGNALS) {
        logger.info({
          tokenAddress: signal.tokenAddress,
          ticker: signal.tokenTicker,
          weakeningCount,
          maxAllowed: this.MAX_WEAKENING_SIGNALS,
          classification: followUpContext.classification,
        }, 'Weakening signal SUPPRESSED - max weakening signals reached (only buy signals allowed now)');

        // Record but don't send
        this.recordOnChainSignalHistory(signal, followUpContext.classification);
        return false;
      }

      const message = this.formatOnChainSignal(signal, followUpContext);

      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: createTelegramInlineKeyboard(signal.tokenAddress),
      });

      // Log the signal
      await Database.logSignal(
        signal.tokenAddress,
        SignalType.DISCOVERY,
        signal.onChainScore?.total || 0,
        'ONCHAIN_MOMENTUM'
      );

      // Record in signal history for follow-up tracking (with classification for weakening count)
      this.recordOnChainSignalHistory(signal, followUpContext.classification);

      logger.info({
        tokenAddress: signal.tokenAddress,
        ticker: signal.tokenTicker,
        signalMomentumScore: signal.momentumScore?.total,
        onChainScore: signal.onChainScore?.total,
        isFollowUp: followUpContext.isFollowUp,
        classification: followUpContext.classification,
        narrative: followUpContext.narrative,
        followUpMomentumScore: followUpContext.momentumScore,
        weakeningSignalCount: followUpContext.classification === 'DETERIORATING' ? (weakeningCount + 1) : weakeningCount,
      }, followUpContext.isFollowUp ? `On-chain follow-up sent (${followUpContext.classification})` : 'On-chain momentum signal sent');

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({
        error: errorMessage,
        tokenAddress: signal.tokenAddress,
        ticker: signal.tokenTicker
      }, 'Failed to send on-chain signal');

      // Try sending a simplified fallback message without Markdown
      try {
        const fallbackMsg = `MOMENTUM SIGNAL: $${signal.tokenTicker || 'UNKNOWN'}\n` +
          `Address: ${signal.tokenAddress}\n` +
          `Score: ${signal.onChainScore?.total || 'N/A'}/100\n` +
          `Recommendation: ${signal.onChainScore?.recommendation || 'N/A'}`;

        await this.bot.sendMessage(this.chatId, fallbackMsg, {
          disable_web_page_preview: true,
          reply_markup: createTelegramInlineKeyboard(signal.tokenAddress),
        });

        logger.info({ tokenAddress: signal.tokenAddress }, 'Sent fallback on-chain signal (no markdown)');
        return true;
      } catch (fallbackError) {
        logger.error({ error: fallbackError }, 'Failed to send fallback signal too');
        return false;
      }
    } finally {
      // Always remove from in-progress set when done (success or failure)
      this.signalsInProgress.delete(signal.tokenAddress);
    }
  }

  /**
   * Escape Markdown special characters in dynamic text
   */
  private escapeMarkdown(text: string): string {
    if (!text) return '';
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }

  /**
   * Generate a brief narrative about what the token is
   */
  private generateNarrative(tokenName: string, ticker: string): string {
    const name = (tokenName || '').toLowerCase();
    const tick = (ticker || '').toLowerCase();

    // AI/Tech themed
    if (name.includes('ai') || name.includes('gpt') || name.includes('llm') || name.includes('neural') || name.includes('bot')) {
      return 'AI/tech-themed memecoin riding the artificial intelligence narrative.';
    }
    // Animal themed
    if (name.includes('dog') || name.includes('cat') || name.includes('pepe') || name.includes('frog') || name.includes('shib') || name.includes('doge') || tick.includes('dog') || tick.includes('cat')) {
      return 'Animal-themed memecoin following classic crypto mascot trends.';
    }
    // Trump/Political
    if (name.includes('trump') || name.includes('maga') || name.includes('biden') || name.includes('politic')) {
      return 'Political-themed token capitalizing on current events narrative.';
    }
    // Elon/Tesla
    if (name.includes('elon') || name.includes('tesla') || name.includes('mars') || name.includes('rocket') || name.includes('space')) {
      return 'Space/Elon-themed memecoin tapping into tech billionaire culture.';
    }
    // Food themed
    if (name.includes('burger') || name.includes('pizza') || name.includes('food') || name.includes('eat') || name.includes('chef')) {
      return 'Food-themed memecoin with casual retail appeal.';
    }
    // Gaming
    if (name.includes('game') || name.includes('play') || name.includes('pixel') || name.includes('arcade')) {
      return 'Gaming-themed token targeting the web3 gaming community.';
    }
    // Default
    return 'New Solana memecoin with emerging on-chain momentum.';
  }

  /**
   * Format on-chain momentum signal message
   */
  private formatOnChainSignal(signal: any, followUpContext?: FollowUpContext): string {
    // Safely extract properties with defaults
    const tokenMetrics = signal.tokenMetrics || {};
    const momentumScore = signal.momentumScore || { total: 0, metrics: {}, components: {} };
    const bundleAnalysis = signal.bundleAnalysis || { riskLevel: 'UNKNOWN', riskScore: 0, flags: [] };
    const onChainScore = signal.onChainScore || { total: 0, recommendation: 'N/A', components: {}, signals: [] };
    const safetyResult = signal.safetyResult || { safetyScore: 0, mintAuthorityEnabled: false, freezeAuthorityEnabled: false };
    const dexScreenerInfo = signal.dexScreenerInfo as DexScreenerTokenInfo | undefined;
    const ctoAnalysis = signal.ctoAnalysis as CTOAnalysis | undefined;

    const ticker = signal.tokenTicker || 'UNKNOWN';
    const tokenName = signal.tokenName || 'Unknown';
    const totalScore = onChainScore.total || 0;
    const recommendation = onChainScore.recommendation || 'WATCH';

    // Score emoji
    const scoreEmoji = totalScore >= 70 ? '🔥' : totalScore >= 55 ? '✨' : totalScore >= 40 ? '📊' : '⚠️';

    // Recommendation emoji
    const recEmoji = recommendation === 'STRONG_BUY' ? '🚀' :
                     recommendation === 'BUY' ? '✅' :
                     recommendation === 'WATCH' ? '👀' : '⛔';

    // Risk level
    const riskLevel = bundleAnalysis.riskLevel || 'UNKNOWN';
    const riskEmoji = riskLevel === 'LOW' ? '🟢' : riskLevel === 'MEDIUM' ? '🟡' : '🔴';

    // Safety status
    const safetyScore = safetyResult.safetyScore || 0;
    const safetyEmoji = safetyScore >= 60 ? '🛡️' : safetyScore >= 40 ? '⚠️' : '🚨';

    // Token age formatting
    const ageMinutes = Math.round(tokenMetrics.tokenAge || 0);
    const ageDisplay = ageMinutes < 60 ? `${ageMinutes}m` : `${Math.round(ageMinutes / 60)}h`;

    // Build the message with clear visual hierarchy
    let msg = `\n`;
    msg += `═══════════════════════════════\n`;

    // Different header for follow-up signals
    if (followUpContext?.isFollowUp) {
      // Classification-based header with visual cue
      const classificationHeader = this.getClassificationHeader(followUpContext.classification);
      msg += `${classificationHeader.emoji}  *${classificationHeader.title}*\n`;
      msg += `    ${recEmoji} ${recommendation} · Score: *${totalScore}/100*\n`;
      msg += `═══════════════════════════════\n\n`;

      // Momentum indicator
      const momentumIndicator = this.getMomentumIndicator(followUpContext);
      msg += `${momentumIndicator}\n\n`;

      // Narrative summary - the key insight
      if (followUpContext.narrative) {
        msg += `💡 *${followUpContext.narrative}*\n\n`;
      }

      // Rich before/after comparison
      if (followUpContext.metricsComparison && followUpContext.metricsComparison.length > 0) {
        msg += `📊 *METRICS COMPARISON* (${followUpContext.timeSinceFirst}min)\n`;
        for (const m of followUpContext.metricsComparison) {
          if (m.direction === 'flat') continue; // Skip unchanged metrics
          const arrow = m.direction === 'up' ? '↑' : '↓';
          const sentiment = m.isPositive ? '✅' : '⚠️';
          const prevStr = this.formatMetricValue(m.name, m.previous);
          const currStr = this.formatMetricValue(m.name, m.current);
          const changeStr = m.changePercent >= 0 ? `+${m.changePercent.toFixed(0)}%` : `${m.changePercent.toFixed(0)}%`;
          msg += `├─ ${sentiment} ${m.emoji} ${m.name}: ${prevStr} → ${currStr} (${arrow}${changeStr})\n`;
        }
        msg += `\n`;
      }

      // ML Prediction comparison (if available)
      if (followUpContext.predictionComparison) {
        const pc = followUpContext.predictionComparison;
        const probArrow = pc.probChange >= 0 ? '↑' : '↓';
        const probEmoji = pc.probChange >= 0 ? '🎯' : '⚠️';
        msg += `${probEmoji} *ML Win Prob:* ${pc.previousWinProb}% → ${pc.currentWinProb}% (${probArrow}${pc.probChange >= 0 ? '+' : ''}${pc.probChange.toFixed(0)}%)\n`;

        if (pc.newRiskFactors && pc.newRiskFactors.length > 0) {
          msg += `🚨 *New Risks:* ${pc.newRiskFactors.slice(0, 2).join(', ')}\n`;
        }
        if (pc.lostPatterns && pc.lostPatterns.length > 0) {
          msg += `❌ *Lost Patterns:* ${pc.lostPatterns.slice(0, 2).join(', ')}\n`;
        }
        if (pc.gainedPatterns && pc.gainedPatterns.length > 0) {
          msg += `✅ *New Patterns:* ${pc.gainedPatterns.slice(0, 2).join(', ')}\n`;
        }
        msg += `\n`;
      }
    } else {
      msg += `${scoreEmoji}  *ON-CHAIN MOMENTUM SIGNAL*\n`;
      msg += `    ${recEmoji} ${recommendation} · Score: *${totalScore}/100*\n`;
      msg += `═══════════════════════════════\n\n`;
    }

    // Token header with key info
    msg += `*$${ticker}* — ${tokenName}\n`;
    msg += `\`${signal.tokenAddress || ''}\`\n`;

    // DexScreener & CTO Status (NEW)
    msg += this.formatDexScreenerCTOStatus(dexScreenerInfo, ctoAnalysis);

    // Narrative - one sentence about what this token is
    msg += `_${this.generateNarrative(tokenName, ticker)}_\n\n`;

    msg += `───────────────────────────────\n`;

    // Market snapshot
    msg += `💰 *Market*\n`;
    msg += `MCap: \`$${this.formatNumber(tokenMetrics.marketCap || 0)}\` · Liq: \`$${this.formatNumber(tokenMetrics.liquidityPool || 0)}\`\n`;
    msg += `Vol: \`$${this.formatNumber(tokenMetrics.volume24h || 0)}\` · Age: \`${ageDisplay}\`\n\n`;

    // Holders & concentration
    msg += `👥 *Holders:* ${tokenMetrics.holderCount || 0} · Top 10: ${(tokenMetrics.top10Concentration || 0).toFixed(0)}%\n\n`;

    msg += `───────────────────────────────\n`;
    // Safety & Risk in one line
    msg += `${safetyEmoji} *Safety:* ${safetyScore}/100`;
    msg += ` · ${riskEmoji} *Bundle:* ${riskLevel}\n`;

    // Contract status
    const mintStatus = safetyResult.mintAuthorityEnabled ? '⚠️ Mint ON' : '✅ Mint OFF';
    const freezeStatus = safetyResult.freezeAuthorityEnabled ? '⚠️ Freeze ON' : '✅ Freeze OFF';
    msg += `${mintStatus} · ${freezeStatus}\n\n`;

    // Momentum quick stats
    const buySellRatio = momentumScore.metrics?.buySellRatio || 0;
    const uniqueBuyers = momentumScore.metrics?.uniqueBuyers5m || 0;
    if (buySellRatio > 0 || uniqueBuyers > 0) {
      msg += `📈 *Momentum:* ${buySellRatio.toFixed(1)}x buy/sell · ${uniqueBuyers} buyers (5m)\n\n`;
    }

    // Social/X Indicators Section
    const socialMetrics = signal.socialMetrics;
    if (socialMetrics) {
      msg += `───────────────────────────────\n`;
      msg += `𝕏 *SOCIAL SIGNALS*\n`;

      // Mention velocity with visual indicator
      const velocity = socialMetrics.mentionVelocity1h || 0;
      const velocityEmoji = velocity >= 50 ? '🔥' : velocity >= 20 ? '📈' : velocity >= 5 ? '📊' : '📉';
      const velocityLabel = velocity >= 50 ? 'VIRAL' : velocity >= 20 ? 'HIGH' : velocity >= 5 ? 'MODERATE' : 'LOW';
      msg += `├─ Velocity: ${velocityEmoji} *${velocity}* mentions/hr (${velocityLabel})\n`;

      // Engagement quality score
      const engagementPercent = Math.round((socialMetrics.engagementQuality || 0) * 100);
      const engagementEmoji = engagementPercent >= 70 ? '🟢' : engagementPercent >= 40 ? '🟡' : '🔴';
      msg += `├─ Engagement: ${engagementEmoji} ${engagementPercent}/100\n`;

      // Account authenticity
      const authPercent = Math.round((socialMetrics.accountAuthenticity || 0) * 100);
      const authEmoji = authPercent >= 70 ? '✅' : authPercent >= 40 ? '⚠️' : '🚨';
      msg += `├─ Authenticity: ${authEmoji} ${authPercent}/100\n`;

      // KOL mentions with tiers (if any)
      if (socialMetrics.kolMentions && socialMetrics.kolMentions.length > 0) {
        const kolDisplay = socialMetrics.kolMentions.slice(0, 3).map((k: any) => {
          const tierBadge = k.tier ? `[${k.tier}]` : '';
          return `@${k.handle}${tierBadge}`;
        }).join(', ');
        msg += `├─ KOL Mentions: 👑 ${kolDisplay}\n`;
      }

      // Sentiment
      const sentiment = socialMetrics.sentimentPolarity || 0;
      const sentimentLabel = sentiment > 0.3 ? '🟢 POSITIVE' : sentiment > -0.3 ? '🟡 NEUTRAL' : '🔴 NEGATIVE';
      msg += `└─ Sentiment: ${sentimentLabel}\n\n`;
    }

    msg += `───────────────────────────────\n`;

    // ML Prediction Section (NEW)
    const prediction = signal.prediction;
    if (prediction) {
      // Label based on ACTUAL probability, not data confidence
      // 65%+ is meaningful edge, 55-64% is moderate, below 55% is weak
      const probLabel = prediction.winProbability >= 65 ? 'STRONG' :
                        prediction.winProbability >= 55 ? 'MODERATE' : 'WEAK';
      const probEmoji = prediction.winProbability >= 65 ? '🔥' :
                        prediction.winProbability >= 55 ? '✨' : '⚠️';

      msg += `🎯 *ML Prediction*\n`;
      msg += `Win Prob: *${prediction.winProbability.toFixed(1)}%* ${probEmoji} (${probLabel})\n`;

      if (prediction.matchedPatterns && prediction.matchedPatterns.length > 0) {
        msg += `✅ Patterns: ${prediction.matchedPatterns.slice(0, 2).join(', ')}\n`;
      }

      if (prediction.optimalHoldTime) {
        msg += `⏱️ Opt. Hold: ${prediction.optimalHoldTime}h`;
        if (prediction.earlyExitRisk > 50) {
          msg += ` · Early Exit Risk: ${prediction.earlyExitRisk}%`;
        }
        msg += `\n`;
      }

      if (prediction.riskFactors && prediction.riskFactors.length > 0) {
        const shortRisks = prediction.riskFactors.slice(0, 2).map((r: string) => r.split(':')[0]);
        msg += `⚠️ Risks: ${shortRisks.join(', ')}\n`;
      }

      msg += `\n`;
    }

    // Position sizing - simplified
    msg += `💵 *Size:* ${signal.suggestedPositionSize || 0.1} SOL\n`;
    msg += `🎯 TP: +100% · SL: -40%\n\n`;

    // Warnings - only show if present, cleaner format
    const riskWarnings = signal.riskWarnings || [];
    const importantWarnings = riskWarnings.filter((w: string) =>
      !w.includes('ON-CHAIN SIGNAL') && !w.includes('No KOL')
    );
    if (importantWarnings.length > 0) {
      msg += `⚠️ *Warnings:* `;
      const shortWarnings = importantWarnings.slice(0, 3).map((w: string) => {
        // Shorten common warnings
        if (w.includes('less than 1 hour')) return 'New token';
        if (w.includes('Low liquidity')) return 'Low liq';
        if (w.includes('DEPLOYER')) return 'Dev holding';
        if (w.includes('VERY_NEW')) return 'Very new';
        if (w.includes('HIGH_CONCENTRATION')) return 'Concentrated';
        return w.slice(0, 20);
      });
      msg += shortWarnings.join(' · ') + '\n\n';
    }

    msg += `───────────────────────────────\n`;
    // Trade links
    msg += `🔗 [Jupiter](https://jup.ag/swap/SOL-${signal.tokenAddress || ''})`;
    msg += ` · [DexS](https://dexscreener.com/solana/${signal.tokenAddress || ''})`;
    msg += ` · [Birdeye](https://birdeye.so/token/${signal.tokenAddress || ''})\n\n`;

    // Footer
    msg += `_No KOL validation · DYOR_\n`;
    msg += `═══════════════════════════════\n`;

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
    const { kolActivity, score, tokenMetrics, scamFilter, socialMetrics, dexScreenerInfo, ctoAnalysis } = signal;
    const wallet = kolActivity.wallet;
    const tx = kolActivity.transaction;
    const perf = kolActivity.performance;

    // Calculate time since discovery
    const timeSinceDiscovery = Math.round(
      (Date.now() - previousDiscovery.discoveredAt.getTime()) / (1000 * 60)
    );

    // Score boost
    const scoreBoost = signal.score.compositeScore - previousDiscovery.score.compositeScore;

    // Build the message with clear visual hierarchy
    let msg = `\n`;
    msg += `═══════════════════════════════\n`;
    msg += `✅  *KOL VALIDATION SIGNAL*\n`;
    msg += `    Boosted: *${score.compositeScore}/100* (+${scoreBoost})\n`;
    msg += `═══════════════════════════════\n\n`;

    // Discovery recap
    msg += `📍 *PREVIOUSLY DISCOVERED*\n`;
    msg += `├─ Discovery Time: ${timeSinceDiscovery} min ago\n`;
    msg += `├─ Original Score: ${previousDiscovery.score.compositeScore}/100\n`;
    msg += `├─ Moonshot Grade: ${previousDiscovery.moonshotAssessment.grade}\n`;
    msg += `└─ Now: *KOL VALIDATED* ✅\n\n`;

    // Token info
    msg += `*Token:* \`$${signal.tokenTicker}\` (${this.truncateAddress(signal.tokenAddress)})\n`;
    msg += `*Chain:* Solana\n`;

    // DexScreener & CTO Status (NEW)
    msg += this.formatDexScreenerCTOStatus(dexScreenerInfo, ctoAnalysis);
    msg += `\n`;

    msg += `───────────────────────────────\n`;
    // Signal metrics
    msg += `📊 *SIGNAL METRICS (BOOSTED)*\n`;
    msg += `├─ Original Score: ${previousDiscovery.score.compositeScore}/100\n`;
    msg += `├─ *Boosted Score: ${score.compositeScore}/100* (+${scoreBoost})\n`;
    msg += `├─ Confidence: *${score.confidence}*\n`;
    msg += `├─ Risk Level: *${score.riskLevel}/5*\n`;
    msg += `└─ Signal Type: KOL\\_VALIDATION\n\n`;

    msg += `───────────────────────────────\n`;
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

    msg += `───────────────────────────────\n`;
    // On-chain data
    msg += `📈 *ON-CHAIN DATA*\n`;
    msg += `├─ Price: $${this.formatPrice(tokenMetrics.price)}\n`;
    msg += `├─ Market Cap: $${this.formatNumber(tokenMetrics.marketCap)}\n`;
    msg += `├─ 24h Volume: $${this.formatNumber(tokenMetrics.volume24h)}\n`;
    msg += `├─ Holders: ${tokenMetrics.holderCount}\n`;
    msg += `├─ Top 10: ${tokenMetrics.top10Concentration.toFixed(1)}%\n`;
    msg += `└─ Bundle Risk: ${scamFilter.bundleAnalysis.riskLevel === 'LOW' ? '🟢 CLEAR' : scamFilter.bundleAnalysis.riskLevel === 'MEDIUM' ? '🟡 FLAGGED' : '🔴 HIGH'}\n\n`;

    msg += `───────────────────────────────\n`;
    // Social signals - X Integration
    msg += `𝕏 *X/SOCIAL SIGNALS*\n`;

    // Social velocity with visual indicator
    const velocityEmoji2 = socialMetrics.mentionVelocity1h >= 50 ? '🔥' :
                          socialMetrics.mentionVelocity1h >= 20 ? '📈' :
                          socialMetrics.mentionVelocity1h >= 5 ? '📊' : '📉';
    const velocityLabel2 = socialMetrics.mentionVelocity1h >= 50 ? 'VIRAL' :
                          socialMetrics.mentionVelocity1h >= 20 ? 'HIGH' :
                          socialMetrics.mentionVelocity1h >= 5 ? 'MODERATE' : 'LOW';
    msg += `├─ Velocity: ${velocityEmoji2} *${socialMetrics.mentionVelocity1h}* mentions/hr (${velocityLabel2})\n`;

    // Engagement quality score
    const engagementPercent2 = Math.round(socialMetrics.engagementQuality * 100);
    const engagementEmoji2 = engagementPercent2 >= 70 ? '🟢' : engagementPercent2 >= 40 ? '🟡' : '🔴';
    msg += `├─ Engagement: ${engagementEmoji2} ${engagementPercent2}/100\n`;

    // Account authenticity
    const authPercent2 = Math.round(socialMetrics.accountAuthenticity * 100);
    const authEmoji2 = authPercent2 >= 70 ? '✅' : authPercent2 >= 40 ? '⚠️' : '🚨';
    msg += `├─ Authenticity: ${authEmoji2} ${authPercent2}/100\n`;

    // KOL mentions with tiers
    if (socialMetrics.kolMentions.length > 0) {
      const kolDisplay2 = socialMetrics.kolMentions.slice(0, 3).map(k => {
        const tierBadge = k.tier ? `[${k.tier}]` : '';
        return `@${k.handle}${tierBadge}`;
      }).join(', ');
      msg += `├─ KOL Mentions: 👑 ${kolDisplay2}\n`;
    } else {
      msg += `├─ KOL Mentions: None yet\n`;
    }

    // Sentiment
    msg += `├─ Sentiment: ${socialMetrics.sentimentPolarity > 0.3 ? '🟢 POSITIVE' : socialMetrics.sentimentPolarity > -0.3 ? '🟡 NEUTRAL' : '🔴 NEGATIVE'}\n`;
    msg += `└─ Narrative: ${socialMetrics.narrativeFit || 'N/A'}\n\n`;

    msg += `───────────────────────────────\n`;
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

    msg += `───────────────────────────────\n`;
    // Trade Links
    msg += `*Quick Trade:*\n`;
    msg += formatLinksAsMarkdown(signal.tokenAddress);
    msg += `\n\n`;

    // Footer
    msg += `⏱️ _Signal: ${signal.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;
    msg += `✅ _KOL validated our discovery! Higher confidence entry._\n`;
    msg += `═══════════════════════════════\n`;

    return msg;
  }

  // ============ HELPER METHODS ============

  /**
   * Format DexScreener payment status and CTO analysis for display
   */
  private formatDexScreenerCTOStatus(
    dexInfo?: DexScreenerTokenInfo,
    ctoAnalysis?: CTOAnalysis
  ): string {
    let status = '';

    // DexScreener Payment Status
    if (dexInfo) {
      if (dexInfo.hasPaidDexscreener) {
        status += `*DEX:* 💰 PAID`;
        if (dexInfo.boostCount > 0) {
          status += ` (${dexInfo.boostCount} boost${dexInfo.boostCount > 1 ? 's' : ''})`;
        }
      } else {
        status += `*DEX:* ⚪ Not Paid`;
      }
    } else {
      status += `*DEX:* ⚪ Unknown`;
    }

    // CTO Status
    if (ctoAnalysis) {
      if (ctoAnalysis.isCTO) {
        const ctoEmoji = ctoAnalysis.ctoConfidence === 'HIGH' ? '🔄' :
                         ctoAnalysis.ctoConfidence === 'MEDIUM' ? '🔃' : '❓';
        status += ` | *CTO:* ${ctoEmoji} ${ctoAnalysis.ctoConfidence}`;
        if (ctoAnalysis.devAbandoned) {
          status += ` (Dev gone)`;
        }
      } else {
        status += ` | *CTO:* ❌ No`;
      }
    }

    return status ? `${status}\n` : '';
  }

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

  /**
   * Get classification header for follow-up signals
   */
  private getClassificationHeader(classification?: ResendClassification): { emoji: string; title: string } {
    switch (classification) {
      case 'NEW_CATALYST':
        return { emoji: '🚀', title: 'NEW CATALYST DETECTED' };
      case 'MOMENTUM_CONFIRMED':
        return { emoji: '📈', title: 'MOMENTUM CONFIRMED' };
      case 'MIXED_SIGNALS':
        return { emoji: '⚖️', title: 'MIXED SIGNALS - REVIEW' };
      case 'DETERIORATING':
        return { emoji: '⚠️', title: 'CAUTION: WEAKENING' };
      case 'SUPPRESS':
        return { emoji: '🛑', title: 'SUPPRESSED' };
      default:
        return { emoji: '🔄', title: 'FOLLOW-UP SIGNAL' };
    }
  }

  /**
   * Get momentum direction indicator for follow-up signals
   */
  private getMomentumIndicator(context: FollowUpContext): string {
    const { positiveChanges, negativeChanges, momentumScore } = context;
    const total = positiveChanges + negativeChanges;

    if (total === 0) {
      return '📊 MOMENTUM: ➡️ STABLE (no significant changes)';
    }

    if (momentumScore && momentumScore >= 2) {
      return `📈 MOMENTUM: ↗️ BUILDING (${positiveChanges}/${total} metrics improving)`;
    } else if (momentumScore && momentumScore <= -2) {
      return `📉 MOMENTUM: ↘️ FADING (${negativeChanges}/${total} metrics declining)`;
    } else {
      return `📊 MOMENTUM: ↔️ MIXED (${positiveChanges} up, ${negativeChanges} down)`;
    }
  }

  /**
   * Format metric value for display in comparison
   */
  private formatMetricValue(name: string, value: number): string {
    switch (name) {
      case 'MC':
      case 'Volume':
        return `$${this.formatNumber(value)}`;
      case 'Score':
        return `${value.toFixed(0)}`;
      case 'Holders':
        return `${value.toFixed(0)}`;
      case 'Social':
        return `${value.toFixed(0)}/hr`;
      case 'Buy/Sell':
        return `${value.toFixed(2)}x`;
      default:
        return `${value.toFixed(2)}`;
    }
  }

  /**
   * Format AI performance report for Telegram
   */
  private formatAIReport(report: import('./performance/ai-query-interface.js').BotPerformanceReport): string {
    const healthEmoji = {
      'EXCELLENT': '🟢',
      'GOOD': '🟢',
      'FAIR': '🟡',
      'POOR': '🟠',
      'CRITICAL': '🔴',
    }[report.overallHealth] || '⚪';

    let message = `📊 *ROSSYBOT PERFORMANCE REPORT*\n`;
    message += `_Last ${Math.round(report.reportPeriodHours / 24)} days_\n\n`;

    // Overall Health
    message += `${healthEmoji} *Overall Health:* ${report.overallHealth} (${report.healthScore}/100)\n\n`;

    // Trading Performance
    message += `💰 *TRADING PERFORMANCE*\n`;
    message += `├ Win Rate: *${report.trading.winRate.toFixed(1)}%*\n`;
    message += `├ Wins: ${report.trading.wins} | Losses: ${report.trading.losses}\n`;
    message += `├ Pending: ${report.trading.pending}\n`;
    message += `├ Avg Win: +${report.trading.avgWinRoi.toFixed(1)}%\n`;
    message += `└ Avg Loss: ${report.trading.avgLossRoi.toFixed(1)}%\n`;

    if (report.trading.bestTrade) {
      message += `   🏆 Best: ${this.escapeMarkdown(report.trading.bestTrade.token)} (+${report.trading.bestTrade.roi.toFixed(0)}%)\n`;
    }
    if (report.trading.worstTrade) {
      message += `   💔 Worst: ${this.escapeMarkdown(report.trading.worstTrade.token)} (${report.trading.worstTrade.roi.toFixed(0)}%)\n`;
    }
    message += '\n';

    // Signal Breakdown
    message += `📡 *SIGNALS*\n`;
    message += `├ Generated: ${report.signals.totalGenerated}\n`;
    message += `├ Sent: ${report.signals.totalSent}\n`;
    message += `├ Filtered: ${report.signals.totalFiltered} (${report.signals.filterRate.toFixed(0)}%)\n`;
    message += `└ By Type: On-chain ${report.signals.byType.onchain} | KOL ${report.signals.byType.kol}\n\n`;

    // Track Performance
    if (report.signals.byTrack.provenRunner.count > 0 || report.signals.byTrack.earlyQuality.count > 0) {
      message += `🛤 *BY TRACK*\n`;
      message += `├ PROVEN\\_RUNNER: ${report.signals.byTrack.provenRunner.winRate.toFixed(0)}% win (${report.signals.byTrack.provenRunner.count})\n`;
      message += `└ EARLY\\_QUALITY: ${report.signals.byTrack.earlyQuality.winRate.toFixed(0)}% win (${report.signals.byTrack.earlyQuality.count})\n\n`;
    }

    // System Health
    message += `🖥 *SYSTEM HEALTH*\n`;
    message += `├ API Score: ${report.systemHealth.apiHealthScore}/100\n`;
    message += `├ DB Score: ${report.systemHealth.dbHealthScore}/100\n`;
    message += `├ Memory: ${report.systemHealth.memoryUsageMb.toFixed(0)} MB\n`;
    message += `└ Errors (24h): ${report.systemHealth.errorCount}\n\n`;

    // Factor Analysis
    if (report.factorAnalysis.workingWell.length > 0) {
      message += `✅ *WORKING WELL*\n`;
      message += `${report.factorAnalysis.workingWell.slice(0, 3).map(s => this.escapeMarkdown(s)).join(', ')}\n\n`;
    }

    if (report.factorAnalysis.needsImprovement.length > 0) {
      message += `⚠️ *NEEDS ATTENTION*\n`;
      message += `${report.factorAnalysis.needsImprovement.slice(0, 3).map(s => this.escapeMarkdown(s)).join(', ')}\n\n`;
    }

    // Recommendations
    if (report.recommendations.length > 0) {
      message += `💡 *RECOMMENDATIONS*\n`;
      const topRecs = report.recommendations.slice(0, 3);
      for (const rec of topRecs) {
        const priorityEmoji = rec.priority === 'HIGH' ? '🔴' : rec.priority === 'MEDIUM' ? '🟡' : '🟢';
        message += `${priorityEmoji} ${this.escapeMarkdown(rec.issue)}\n`;
        message += `   ${this.escapeMarkdown(rec.suggestion)}\n`;
      }
      message += '\n';
    }

    // Current Thresholds
    message += `⚙️ *CURRENT THRESHOLDS*\n`;
    message += `├ Min OnChain: ${report.currentThresholds.minOnChainScore}\n`;
    message += `├ Min Momentum: ${report.currentThresholds.minMomentumScore}\n`;
    message += `├ Min Safety: ${report.currentThresholds.minSafetyScore}\n`;
    message += `└ Max Bundle Risk: ${report.currentThresholds.maxBundleRiskScore}\n\n`;

    message += `_Use /tweaks for AI-suggested optimizations_`;

    return message;
  }

  /**
   * Split a long message into multiple messages
   */
  private splitLongMessage(message: string, maxLength: number): string[] {
    if (message.length <= maxLength) {
      return [message];
    }

    const messages: string[] = [];
    let remaining = message;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        messages.push(remaining);
        break;
      }

      // Find a good break point (newline or space)
      let breakPoint = remaining.lastIndexOf('\n', maxLength);
      if (breakPoint === -1 || breakPoint < maxLength * 0.5) {
        breakPoint = remaining.lastIndexOf(' ', maxLength);
      }
      if (breakPoint === -1) {
        breakPoint = maxLength;
      }

      messages.push(remaining.substring(0, breakPoint));
      remaining = remaining.substring(breakPoint).trim();
    }

    return messages;
  }
}

// ============ EXPORTS ============

export const telegramBot = new TelegramAlertBot();

export default {
  TelegramAlertBot,
  telegramBot,
  RATE_LIMITS,
};
