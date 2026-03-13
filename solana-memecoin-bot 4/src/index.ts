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
import { dailyAutoOptimizer, thresholdOptimizer } from './modules/performance/index.js';
// probability-signal module REMOVED (over-engineered, decoupled from pipeline)
import { pumpfunDevMonitor } from './modules/pumpfun/dev-monitor.js';
import { devStatsUpdater } from './modules/pumpfun/dev-stats-updater.js';

// Phase 3+4: New modules
import { portfolioManager } from './risk/portfolioManager.js';
import { regimeDetector } from './analysis/regimeDetector.js';
import { crossTokenRotationDetector } from './analysis/crossTokenRotationDetector.js';
import { timeOptimizer } from './analysis/timeOptimizer.js';
import { narrativeDetector } from './analysis/narrativeDetector.js';

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
    pumpfunDevMonitor.stop();
    devStatsUpdater.stop();
    crossTokenRotationDetector.stop();
    regimeDetector.stop();
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
