// ===========================================
// SOLANA MEMECOIN BOT - MAIN ENTRY POINT
// ===========================================

import { appConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { pool, SCHEMA_SQL } from './utils/database.js';
import { signalGenerator } from './modules/signal-generator.js';
import { telegramBot } from './modules/telegram.js';
import { matureTokenScanner } from './modules/mature-token/index.js';
import { dailyAutoOptimizer, thresholdOptimizer } from './modules/performance/index.js';

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
  logger.info(`   Helius (RPC): ${appConfig.heliusApiKey ? '✅ Configured' : '❌ MISSING - on-chain analysis disabled'}`);
  logger.info(`   Birdeye: ${appConfig.birdeyeApiKey ? '✅ Configured' : '❌ MISSING - token metrics disabled'}`);
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

  // Signal Generation Settings
  logger.info('');
  logger.info('📡 SIGNAL GENERATION');
  logger.info(`   Scan Interval: 20 seconds`);
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
  logger.info('   ✅ Birdeye New Listings');
  logger.info('   ✅ DexScreener Trending');
  logger.info('   ✅ Volume Anomaly Scanner');
  logger.info('   ✅ Holder Growth Scanner');
  logger.info('   ✅ Narrative Scanner');
  logger.info('   ✅ KOL Wallet Tracker');

  // Analysis Modules
  logger.info('');
  logger.info('📊 ANALYSIS MODULES');
  logger.info('   ✅ On-Chain Scoring Engine');
  logger.info('   ✅ Momentum Analyzer');
  logger.info('   ✅ Bundle/Insider Detector');
  logger.info('   ✅ Token Safety Checker');
  logger.info('   ✅ Scam Filter');
  logger.info('   ✅ ML Win Predictor');
  logger.info(`   ${appConfig.twitterEnabled ? '✅' : '⚠️'} Social Analyzer (X/Twitter)`);

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

  // Initialize signal generator
  await signalGenerator.initialize();

  // Initialize mature token scanner
  await matureTokenScanner.initialize();

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

  // Start the main loop
  signalGenerator.start();

  // Start mature token scanner
  matureTokenScanner.start();

  logger.info('Bot is running! Press Ctrl+C to stop.');
  logger.info('Mature Token Scanner is active - scanning for 24h+ survivor tokens');
  
  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    signalGenerator.stop();
    matureTokenScanner.stop();
    dailyAutoOptimizer.stop();
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
