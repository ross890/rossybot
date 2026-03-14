// ===========================================
// SOLANA MEMECOIN BOT - MAIN ENTRY POINT
// ===========================================

import { appConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { pool, SCHEMA_SQL } from './utils/database.js';
import { signalGenerator } from './modules/signal-generator.js';
import { telegramBot } from './modules/telegram.js';
// REMOVED: Mature token strategy disabled - contradicts micro-cap focus
// import { matureTokenScanner, matureTokenTelegram } from './modules/mature-token/index.js';
import { dailyAutoOptimizer, thresholdOptimizer, v3ChecklistAutomation } from './modules/performance/index.js';
// probability-signal module REMOVED (over-engineered, decoupled from pipeline)
import { pumpfunDevMonitor } from './modules/pumpfun/dev-monitor.js';
import { devStatsUpdater } from './modules/pumpfun/dev-stats-updater.js';

// Phase 3+4: New modules
import { portfolioManager } from './risk/portfolioManager.js';
import { regimeDetector } from './analysis/regimeDetector.js';
import { crossTokenRotationDetector } from './analysis/crossTokenRotationDetector.js';
import { timeOptimizer } from './analysis/timeOptimizer.js';
import { narrativeDetector } from './analysis/narrativeDetector.js';

// Nansen integration
import { nansenClient } from './nansen/nansenClient.js';
import { nansenWalletDiscovery } from './nansen/nansenWalletDiscovery.js';
import { nansenAlertReceiver } from './nansen/nansenAlertReceiver.js';
import { nansenWalletRefresh } from './nansen/nansenWalletRefresh.js';

// ============ STARTUP ============

async function initializeDatabase(): Promise<void> {
  logger.info('Initializing database...');

  try {
    const client = await pool.connect();
    await client.query(SCHEMA_SQL);
    client.release();
    logger.info('Database schema initialized');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize database');
    throw error;
  }
}

/**
 * Print comprehensive startup diagnostic summary
 * Shows all module states and configuration for debugging
 */
function printStartupDiagnostics(): void {
  const divider = '='.repeat(55);

  logger.info(divider);
  logger.info('           ROSSYBOT STARTUP DIAGNOSTICS');
  logger.info(divider);

  // Environment & Mode
  logger.info('');
  logger.info('ENVIRONMENT');
  logger.info(`   Mode: ${appConfig.nodeEnv.toUpperCase()}`);
  logger.info(`   Learning Mode: ${appConfig.trading.learningMode ? 'ENABLED (relaxed filters)' : 'DISABLED (strict filters)'}`);
  logger.info(`   Log Level: ${appConfig.logLevel}`);

  // API Connections — only list what's actually called
  logger.info('');
  logger.info('API CONNECTIONS');
  if (appConfig.heliusDisabled) {
    logger.info('   Helius (RPC): DISABLED (rate limit mode)');
    logger.info('      -> Security checks return permissive defaults');
    logger.info('      -> Top 10 concentration defaulting to 50%');
    logger.info('      -> KOL wallet tracking inactive');
  } else {
    logger.info(`   Helius (RPC): ${appConfig.heliusApiKey ? 'CONFIGURED' : 'MISSING - holder analysis disabled'}`);
  }
  logger.info('   DexScreener: FREE (token discovery, metrics, boost status)');
  logger.info('   Jupiter: FREE (recent tokens, verified list)');
  logger.info('   GMGN: FREE (trending tokens, smart money activity)');
  logger.info('   RugCheck: FREE (contract safety hard gate)');
  logger.info(`   Solscan Pro: ${appConfig.solscanApiKey ? 'CONFIGURED (dev wallet monitoring)' : 'NOT SET - dev tracker limited'}`);
  logger.info(`   Telegram: ${appConfig.telegramBotToken ? 'CONFIGURED' : 'MISSING - alerts disabled'}`);
  logger.info('   Twitter/X: NOT CONNECTED (social metrics use on-chain proxy)');
  logger.info(`   Nansen Pro: ${nansenClient.isConfigured() ? 'CONFIGURED (wallet intelligence + flow enrichment)' : 'NOT SET - wallet intelligence disabled'}`);


  // Strategy Configuration
  logger.info('');
  logger.info('STRATEGIES');
  logger.info(`   Early Token (micro-cap focus): ${appConfig.trading.enableEarlyStrategy ? 'ENABLED - 20s scan cycle' : 'DISABLED'}`);
  logger.info(`   Pump.fun Dev Tracker: ${appConfig.devTracker.enabled ? 'ENABLED - 15s poll cycle' : 'DISABLED'}`);

  // Phase 3+4 modules
  logger.info('');
  logger.info('RISK MANAGEMENT (Phase 3)');
  logger.info('   Portfolio Manager: ENABLED (8 max positions, 4/hour, circuit breakers)');
  logger.info('   Correlation Tracker: ENABLED (narrative clustering)');
  logger.info('   Cross-Token Rotation: ENABLED (5-min DexScreener poll)');
  logger.info('   Time-of-Day Optimizer: ENABLED (AEDT windows)');
  logger.info('');
  logger.info('   V3 Checklist: ENABLED (6-hour Telegram reports)');
  logger.info('');
  logger.info('MARKET INTELLIGENCE (Phase 4)');
  logger.info(`   Regime Detector: ENABLED (${regimeDetector.getRegimeLabel()})`);
  logger.info('   Narrative Detector: ENABLED (7-day rolling)');
  logger.info('   Fresh Wallet Analyzer: ENABLED (passive)');
  logger.info('   Price Oracle: ENABLED (DexScreener + Jupiter)');
  logger.info('   Adaptive Holder Cache: ENABLED (15s/30s/60s TTL)');

  // Signal Limits
  logger.info('');
  logger.info('SIGNAL LIMITS');
  logger.info(`   Max Signals/Hour: ${appConfig.trading.maxSignalsPerHour}`);
  logger.info(`   Max Signals/Day: ${appConfig.trading.maxSignalsPerDay}`);
  logger.info(`   Min Score (Buy): ${appConfig.trading.minScoreBuySignal}`);
  logger.info(`   Min Score (Watch): ${appConfig.trading.minScoreWatchSignal}`);

  // Screening
  logger.info('');
  logger.info('SCREENING');
  logger.info(`   Market Cap: $${appConfig.screening.minMarketCap.toLocaleString()} - $${appConfig.screening.maxMarketCap.toLocaleString()} (MICRO-CAP FOCUS)`);
  logger.info(`   Min Volume: $${appConfig.screening.min24hVolume.toLocaleString()} | Min Holders: ${appConfig.screening.minHolderCount}`);
  logger.info(`   Max Top10: ${appConfig.screening.maxTop10Concentration}% | Min Liquidity: $${appConfig.screening.minLiquidityPool.toLocaleString()}`);
  logger.info(`   Min Token Age: ${appConfig.screening.minTokenAgeMinutes} minutes`);

  // Wallet Engine
  logger.info('');
  logger.info('ALPHA WALLET ENGINE');
  logger.info('   GMGN Discovery: ENABLED (6h scan interval)');
  logger.info('   Wallet Graduation: ENABLED (shadow tracking + auto-graduate)');
  logger.info('   On-Chain Discovery: ENABLED (triggers on BIG_WIN/MASSIVE_WIN)');
  logger.info('   Co-Trader Discovery: ENABLED (triggers on alpha signals)');
  logger.info('   Performance Review: ENABLED (daily at 6 AM AEDT)');
  logger.info(`   Nansen Integration: ${nansenClient.isConfigured() ? 'ENABLED' : 'DISABLED (no API key)'}`);
  if (nansenClient.isConfigured()) {
    logger.info('     - Wallet Discovery: 6h scan interval (Smart Money PnL leaderboard)');
    logger.info('     - Fast-Track Graduation: ENABLED (5 trades for proven wallets)');
    logger.info('     - Token Flow Enrichment: ENABLED (async scoring bonus)');
    logger.info('     - Smart Alerts: ENABLED (webhook receiver)');
    logger.info('     - Winner Scanner: ENABLED (on BIG_WIN/MASSIVE_WIN)');
    logger.info('     - Weekly Refresh: ENABLED (Monday 6 AM AEDT)');
  }

  logger.info('');
  logger.info(divider);
  logger.info('              BOT READY - STARTING SCAN LOOP');
  logger.info(divider);
  logger.info('');
}

async function main(): Promise<void> {
  logger.info('='.repeat(50));
  logger.info('SOLANA MEMECOIN TRADING BOT');
  logger.info('='.repeat(50));
  logger.info({ env: appConfig.nodeEnv }, 'Starting up...');

  // Initialize database
  await initializeDatabase();

  // Initialize Telegram bot (must be done early for commands to work)
  await telegramBot.initialize();

  // Initialize signal generator (early token strategy - core mission)
  if (appConfig.trading.enableEarlyStrategy) {
    await signalGenerator.initialize();
    logger.info('Early token strategy ENABLED');
  } else {
    logger.info('Early token strategy DISABLED');
  }

  // 2x probability module REMOVED - was over-engineered bloat

  // Initialize Pump.fun Dev Tracker
  if (appConfig.devTracker.enabled) {
    try {
      await pumpfunDevMonitor.initialize();

      // Wire up signal delivery to Telegram
      pumpfunDevMonitor.onSignal(async (_signal, formattedMessage) => {
        await telegramBot.sendDevSignal(formattedMessage, _signal.token.mint);
      });

      logger.info('Pump.fun Dev Tracker ENABLED');
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize Pump.fun Dev Tracker');
    }
  } else {
    logger.info('Pump.fun Dev Tracker DISABLED');
  }

  // Load saved thresholds from database
  await thresholdOptimizer.loadThresholds();
  logger.info('Threshold optimizer loaded saved thresholds');

  // Initialize and start daily auto optimizer (runs at 6am Sydney time)
  await dailyAutoOptimizer.initialize();
  dailyAutoOptimizer.start();
  logger.info({
    nextRun: dailyAutoOptimizer.getNextRunTime()?.toISOString(),
  }, 'Daily auto optimizer scheduled');

  // Wire diagnostics getter so /diagnostics command can access signal generator state
  telegramBot.setDiagnosticsGetter(() => signalGenerator.getDiagnostics());
  telegramBot.setRollingStatsGetter((windowMs: number) => signalGenerator.getRollingStats(windowMs));

  // V3 Checklist Automation — milestone tracking every 6 hours
  try {
    v3ChecklistAutomation.initialize(async (message) => {
      await telegramBot.sendRawMessage(message);
    });
    v3ChecklistAutomation.start();
    logger.info('V3 Checklist Automation started (6-hour cycle)');
  } catch (error) {
    logger.warn({ error }, 'Failed to start V3 Checklist Automation');
  }

  // Phase 3: Portfolio risk management
  try {
    await portfolioManager.initialize();
    portfolioManager.onNotify(async (message) => {
      await telegramBot.sendRawMessage(message);
    });
    logger.info('Portfolio manager initialized');
  } catch (error) {
    logger.warn({ error }, 'Failed to initialize portfolio manager');
  }

  // Phase 3.3: Cross-token rotation detector
  try {
    crossTokenRotationDetector.onNotify(async (message) => {
      await telegramBot.sendRawMessage(message);
    });
    crossTokenRotationDetector.start();
    logger.info('Cross-token rotation detector started');
  } catch (error) {
    logger.warn({ error }, 'Failed to start rotation detector');
  }

  // Phase 3.5: Time-of-day optimizer
  try {
    await timeOptimizer.initialize();
    logger.info('Time-of-day optimizer initialized');
  } catch (error) {
    logger.warn({ error }, 'Failed to initialize time optimizer');
  }

  // Phase 4.1: Market regime detector
  try {
    regimeDetector.start();
    logger.info('Market regime detector started');
  } catch (error) {
    logger.warn({ error }, 'Failed to start regime detector');
  }

  // Phase 4.4: Narrative meta-detection
  try {
    await narrativeDetector.initialize();
    logger.info('Narrative detector initialized');
  } catch (error) {
    logger.warn({ error }, 'Failed to initialize narrative detector');
  }

  // Nansen integration — wallet intelligence
  if (nansenClient.isConfigured()) {
    try {
      // Nansen wallet discovery (every 6 hours)
      nansenWalletDiscovery.start();
      logger.info('Nansen wallet discovery started (6h scan interval)');

      // Nansen wallet refresh (weekly on Monday)
      nansenWalletRefresh.setNotifyCallback(async (msg) => {
        await telegramBot.sendRawMessage(msg);
      });
      nansenWalletRefresh.start();
      logger.info('Nansen wallet refresh scheduled (weekly Monday 6 AM AEDT)');

      // Nansen alert receiver — wire up active wallet checker
      nansenAlertReceiver.setActiveWalletChecker(async (address) => {
        const wallet = await import('./wallets/walletEngine.js').then(m => m.walletEngine.getWalletByAddress(address));
        return wallet?.status === 'ACTIVE';
      });
      logger.info('Nansen alert receiver configured');
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize Nansen integration');
    }
  } else {
    logger.info('Nansen: NANSEN_API_KEY not set, integration disabled');
  }

  // Mount Nansen routes on the Telegram bot's existing Express server
  // (Telegram module already binds to PORT — avoid EADDRINUSE)
  try {
    const expressApp = telegramBot.getExpressApp();
    if (expressApp) {
      if (nansenClient.isConfigured()) {
        expressApp.post('/webhooks/nansen', nansenAlertReceiver.createRouteHandler());
        logger.info('Nansen webhook endpoint registered: POST /webhooks/nansen');
      }

      expressApp.get('/nansen/credits', (_req: any, res: any) => {
        res.json(nansenClient.isConfigured() ? nansenClient.getCreditStats() : { configured: false });
      });
    } else {
      logger.debug('Nansen: No Express app available, webhook routes not mounted');
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to mount Nansen webhook routes (non-critical)');
  }

  // Print comprehensive startup diagnostics
  printStartupDiagnostics();

  // Start signal generators based on config
  if (appConfig.trading.enableEarlyStrategy) {
    signalGenerator.start();
    logger.info('Early token signal generator started');
  }

  // Mature token strategy REMOVED - micro-cap focus only

  // 2x probability module REMOVED

  // Start Pump.fun Dev Tracker
  if (appConfig.devTracker.enabled) {
    try {
      pumpfunDevMonitor.start();
      devStatsUpdater.start();
      logger.info('Pump.fun Dev Monitor and Stats Updater started');
    } catch (error) {
      logger.warn({ error }, 'Failed to start Pump.fun Dev Tracker');
    }
  }

  logger.info('Bot is running! Press Ctrl+C to stop.');
  
  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    if (appConfig.trading.enableEarlyStrategy) {
      signalGenerator.stop();
    }
    // probabilitySignalModule removed
    dailyAutoOptimizer.stop();
    v3ChecklistAutomation.stop();
    pumpfunDevMonitor.stop();
    devStatsUpdater.stop();
    crossTokenRotationDetector.stop();
    regimeDetector.stop();

    // Stop wallet engine modules
    try {
      const { gmgnDiscovery, walletGraduation } = await import('./wallets/index.js');
      gmgnDiscovery.stop();
      walletGraduation.stop();
    } catch {
      // Non-critical
    }

    // Stop Nansen modules
    try {
      nansenWalletDiscovery.stop();
      nansenWalletRefresh.stop();
    } catch {
      // Non-critical
    }

    await telegramBot.stop();
    await pool.end();

    logger.info('Shutdown complete');
    process.exit(0);
  };
  
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ============ RUN ============

main().catch((error) => {
  logger.error({ error }, 'Fatal error during startup');
  process.exit(1);
});
