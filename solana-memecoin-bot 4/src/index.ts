// ===========================================
// SOLANA MEMECOIN BOT - MAIN ENTRY POINT
// ===========================================

import { appConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { pool, SCHEMA_SQL } from './utils/database.js';
import { signalGenerator } from './modules/signal-generator.js';
import { telegramBot } from './modules/telegram.js';
import { matureTokenScanner, matureTokenTelegram } from './modules/mature-token/index.js';
import { dailyAutoOptimizer, thresholdOptimizer } from './modules/performance/index.js';
import { probabilitySignalModule } from './modules/probability-signal.js';
import { pumpfunDevMonitor } from './modules/pumpfun/dev-monitor.js';
import { devStatsUpdater } from './modules/pumpfun/dev-stats-updater.js';

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
  logger.info('📋 ENVIRONMENT');
  logger.info(`   Mode: ${appConfig.nodeEnv.toUpperCase()}`);
  logger.info(`   Learning Mode: ${appConfig.trading.learningMode ? '✅ ENABLED (relaxed filters)' : '❌ DISABLED (strict filters)'}`);
  logger.info(`   Log Level: ${appConfig.logLevel}`);

  // API Connections
  logger.info('');
  logger.info('🔌 API CONNECTIONS');
  if (appConfig.heliusDisabled) {
    logger.info('   Helius (RPC): ⚠️ DISABLED (rate limit mode)');
    logger.info('      → Security checks return permissive defaults');
    logger.info('      → Top 10 concentration defaulting to 50%');
    logger.info('      → Bundle analysis disabled');
    logger.info('      → Set HELIUS_DISABLED=false when quota resets');
  } else {
    logger.info(`   Helius (RPC): ${appConfig.heliusApiKey ? '✅ Configured' : '❌ MISSING - on-chain analysis disabled'}`);
  }
  logger.info('   DexScreener: ✅ Free (no API key needed)');
  logger.info('   RugCheck: ✅ Free (contract safety)');
  logger.info('   SolanaFM: ✅ Free (dev wallet history)');
  logger.info('   Jupiter: ✅ Free (no API key needed)');
  logger.info(`   Telegram: ${appConfig.telegramBotToken ? '✅ Configured' : '❌ MISSING - alerts disabled'}`);

  // Twitter/X Status - Critical for social analysis
  logger.info('');
  logger.info('🐦 TWITTER/X INTEGRATION');
  if (!appConfig.twitterEnabled) {
    logger.info('   Status: ❌ DISABLED (TWITTER_ENABLED=false)');
    logger.info('   Impact: Social metrics will return empty data');
    logger.info('   Fix: Set TWITTER_ENABLED=true in .env');
  } else {
    const hasTwitterCreds = appConfig.twitterBearerToken ||
      (appConfig.twitterConsumerKey && appConfig.twitterConsumerSecret);
    if (hasTwitterCreds) {
      logger.info('   Status: ✅ ENABLED');
      logger.info(`   Auth: ${appConfig.twitterBearerToken ? 'Bearer Token' : 'Consumer Key/Secret'}`);
    } else {
      logger.info('   Status: ⚠️ ENABLED but NO CREDENTIALS');
      logger.info('   Impact: Twitter API calls will fail');
      logger.info('   Fix: Set TWITTER_BEARER_TOKEN in .env');
    }
  }

  // Strategy Configuration
  logger.info('');
  logger.info('🎯 STRATEGY CONFIGURATION');
  logger.info(`   Early Token Strategy: ${appConfig.trading.enableEarlyStrategy ? '✅ ENABLED (5min-90min tokens)' : '❌ DISABLED'}`);
  logger.info(`   Mature Token Strategy: ${appConfig.trading.enableMatureStrategy ? '✅ ENABLED (21+ day tokens)' : '❌ DISABLED'}`);
  logger.info(`   Pump.fun Dev Tracker: ${appConfig.devTracker.enabled ? '✅ ENABLED (dev wallet monitoring)' : '❌ DISABLED'}`);

  // Signal Generation Settings
  logger.info('');
  logger.info('📡 SIGNAL GENERATION');
  if (appConfig.trading.enableEarlyStrategy) {
    logger.info(`   Early Strategy Scan Interval: 20 seconds`);
  }
  if (appConfig.trading.enableMatureStrategy) {
    logger.info(`   Mature Strategy Scan Interval: 5 minutes`);
  }
  logger.info(`   Max Signals/Hour: ${appConfig.trading.maxSignalsPerHour}`);
  logger.info(`   Max Signals/Day: ${appConfig.trading.maxSignalsPerDay}`);
  logger.info(`   Min Score (Buy): ${appConfig.trading.minScoreBuySignal}`);
  logger.info(`   Min Score (Watch): ${appConfig.trading.minScoreWatchSignal}`);

  // Token Screening Thresholds
  logger.info('');
  logger.info('🔍 TOKEN SCREENING THRESHOLDS');
  logger.info(`   Market Cap: $${appConfig.screening.minMarketCap.toLocaleString()} - $${appConfig.screening.maxMarketCap.toLocaleString()}`);
  logger.info(`   Min 24h Volume: $${appConfig.screening.min24hVolume.toLocaleString()}`);
  logger.info(`   Min Holders: ${appConfig.screening.minHolderCount}`);
  logger.info(`   Max Top10 Concentration: ${appConfig.screening.maxTop10Concentration}%`);
  logger.info(`   Min Liquidity: $${appConfig.screening.minLiquidityPool.toLocaleString()}`);
  logger.info(`   Min Token Age: ${appConfig.screening.minTokenAgeMinutes} minutes`);

  // Discovery Sources
  logger.info('');
  logger.info('🔎 TOKEN DISCOVERY SOURCES');
  logger.info('   ✅ DexScreener New Pairs');
  logger.info('   ✅ DexScreener Trending');
  logger.info('   ✅ Jupiter Recent Tokens');
  logger.info('   ✅ Volume Anomaly Scanner');
  logger.info('   ✅ Holder Growth Scanner');
  logger.info('   ✅ Narrative Scanner');
  logger.info('   ✅ KOL Wallet Tracker');
  if (appConfig.devTracker.enabled) {
    logger.info('   ✅ Pump.fun Dev Signal Tracker');
  }

  // Analysis Modules
  logger.info('');
  logger.info('📊 ANALYSIS MODULES');
  logger.info('   ✅ On-Chain Scoring Engine');
  logger.info('   ✅ Momentum Analyzer');
  logger.info('   ✅ Bundle Detector (informational)');
  logger.info('   ✅ Token Safety Checker');
  logger.info('   ✅ Scam Filter');
  logger.info('   ✅ Moonshot Assessor');
  logger.info('   ✅ Discovery Scanners');
  logger.info('   ✅ RugCheck Integration (Layer 1 - Contract Safety)');
  logger.info('   ✅ Dev Wallet Scorer (Layer 2 - Serial Launcher Detection)');
  logger.info('   ✅ 2x Probability Calculator');
  logger.info('   ✅ Token Data Crawler (DexScreener → Backtest)');

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

  // Share bot instance with mature token telegram formatter
  const botInstance = telegramBot.getBot();
  if (botInstance) {
    matureTokenTelegram.initialize(botInstance);
    logger.info('Mature token telegram formatter initialized');
  }

  // Initialize signal generators based on config
  if (appConfig.trading.enableEarlyStrategy) {
    await signalGenerator.initialize();
    logger.info('Early token strategy ENABLED');
  } else {
    logger.info('Early token strategy DISABLED');
  }

  if (appConfig.trading.enableMatureStrategy) {
    await matureTokenScanner.initialize();
    logger.info('Mature token strategy ENABLED');
  } else {
    logger.info('Mature token strategy DISABLED');
  }

  // Initialize 2x probability signal module (RugCheck, Dev Scoring, Token Crawler)
  try {
    await probabilitySignalModule.initialize();
    logger.info('2x probability signal module initialized');
  } catch (error) {
    logger.warn({ error }, 'Failed to initialize probability module - 2x signals disabled');
  }

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

  // Print comprehensive startup diagnostics
  printStartupDiagnostics();

  // Start signal generators based on config
  if (appConfig.trading.enableEarlyStrategy) {
    signalGenerator.start();
    logger.info('Early token signal generator started');
  }

  if (appConfig.trading.enableMatureStrategy) {
    matureTokenScanner.start();
    logger.info('Mature token scanner started - scanning for 21+ day survivor tokens');
  }

  // Start 2x probability module (token crawler + backtest scheduler)
  try {
    probabilitySignalModule.start();
    logger.info('2x probability module started (crawler + backtest scheduler)');
  } catch (error) {
    logger.warn({ error }, 'Failed to start probability module');
  }

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
    if (appConfig.trading.enableMatureStrategy) {
      matureTokenScanner.stop();
    }
    probabilitySignalModule.stop();
    dailyAutoOptimizer.stop();
    pumpfunDevMonitor.stop();
    devStatsUpdater.stop();
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
