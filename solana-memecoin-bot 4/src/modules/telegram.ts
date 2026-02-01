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
import { dailyReportGenerator, signalPerformanceTracker, thresholdOptimizer } from './performance/index.js';
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

// Trading module imports (disabled - signal-only mode)
// import { TradingCommands } from './telegram/trading-commands.js';
// import { tradeExecutor, positionManager, autoTrader } from './trading/index.js';

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

    // Trading system disabled - using signal-only mode
    // Wallet integration and auto-trading can be re-enabled later
    logger.info('Running in signal-only mode (trading system disabled)');

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
    const SIGNAL_BOT_COMMANDS: TelegramBot.BotCommand[] = [
      { command: 'status', description: 'Bot status & connection health' },
      { command: 'performance', description: 'Signal performance & win rate report' },
      { command: 'safety', description: 'Run safety check: /safety <token>' },
      { command: 'conviction', description: 'High-conviction tokens (2+ KOLs)' },
      { command: 'leaderboard', description: 'KOL performance rankings' },
      { command: 'pumpfun', description: 'Tokens approaching migration' },
      { command: 'thresholds', description: 'View current signal thresholds' },
      { command: 'optimize', description: 'Run threshold optimization analysis' },
      { command: 'reset_thresholds', description: 'Reset thresholds to defaults' },
      { command: 'test', description: 'Send a test signal' },
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
        '*rossybot* initialized!\n\n' +
        'You will receive memecoin buy signals here.\n\n' +
        '*Signal Commands:*\n' +
        '/status - Bot status & connection health\n' +
        '/performance - Signal performance & win rate report\n' +
        '/safety <token> - Run safety check on any token\n' +
        '/conviction - Show high-conviction tokens (2+ KOLs)\n' +
        '/leaderboard - KOL performance rankings\n' +
        '/pumpfun - Tokens approaching migration\n' +
        '/test - Send a test signal\n\n' +
        '*Threshold Commands:*\n' +
        '/thresholds - View current signal thresholds\n' +
        '/optimize - Run threshold optimization analysis\n' +
        '/apply\\_thresholds - Apply recommended changes\n' +
        '/reset\\_thresholds - Reset to defaults\n\n' +
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
        '*Signal Commands:*\n' +
        '/status - Bot status, uptime & connection health\n' +
        '/performance - Signal performance & win rate report\n' +
        '/safety <token> - Run safety check on any token\n' +
        '/conviction - High-conviction tokens (2+ KOLs)\n' +
        '/leaderboard - KOL performance rankings\n' +
        '/pumpfun - Tokens approaching migration\n' +
        '/test - Send a test signal\n\n' +
        '*Threshold Commands:*\n' +
        '/thresholds - View current signal thresholds\n' +
        '/optimize - Run optimization analysis\n' +
        '/apply\\_thresholds - Apply recommended changes\n' +
        '/reset\\_thresholds - Reset to defaults\n\n' +
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
              message += `${arrow} ${rec.factor}: ${rec.currentValue} → ${rec.recommendedValue}\n`;
              message += `   _${rec.reason}_\n`;
            }
            message += '\nUse /apply\\_thresholds to apply recommendations';
          } else {
            message += '✅ _All thresholds are optimally configured_\n';
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
    const { kolActivity, score, tokenMetrics, socialMetrics, scamFilter, dexScreenerInfo, ctoAnalysis } = signal;
    const wallet = kolActivity.wallet;
    const tx = kolActivity.transaction;
    const perf = kolActivity.performance;

    // Build the message with clear visual hierarchy
    let msg = `\n`;
    msg += `═══════════════════════════════\n`;
    msg += `🎯  *KOL CONFIRMED BUY SIGNAL*\n`;
    msg += `    Score: *${score.compositeScore}/100* · ${score.confidence}\n`;
    msg += `═══════════════════════════════\n\n`;

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
        signal.onChainScore?.total || 0,
        'ONCHAIN_MOMENTUM'
      );

      logger.info({
        tokenAddress: signal.tokenAddress,
        ticker: signal.tokenTicker,
        momentumScore: signal.momentumScore?.total,
        onChainScore: signal.onChainScore?.total,
      }, 'On-chain momentum signal sent');

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
  private formatOnChainSignal(signal: any): string {
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
    msg += `${scoreEmoji}  *ON-CHAIN MOMENTUM SIGNAL*\n`;
    msg += `    ${recEmoji} ${recommendation} · Score: *${totalScore}/100*\n`;
    msg += `═══════════════════════════════\n\n`;

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

    msg += `───────────────────────────────\n`;

    // ML Prediction Section (NEW)
    const prediction = signal.prediction;
    if (prediction) {
      const probEmoji = prediction.winProbability >= 50 ? '🎯' :
                        prediction.winProbability >= 35 ? '📊' : '⚠️';
      const confEmoji = prediction.confidence === 'HIGH' ? '🔥' :
                        prediction.confidence === 'MEDIUM' ? '✨' : '❓';

      msg += `${probEmoji} *ML Prediction*\n`;
      msg += `Win Prob: *${prediction.winProbability}%* ${confEmoji} (${prediction.confidence})\n`;

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
}

// ============ EXPORTS ============

export const telegramBot = new TelegramAlertBot();

export default {
  TelegramAlertBot,
  telegramBot,
  RATE_LIMITS,
};
