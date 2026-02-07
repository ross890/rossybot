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
  logger.info('   RugCheck: FREE (contract safety hard gate)');
  logger.info(`   Solscan Pro: ${appConfig.solscanApiKey ? 'CONFIGURED (dev wallet monitoring)' : 'NOT SET - dev tracker limited'}`);
  logger.info(`   Telegram: ${appConfig.telegramBotToken ? 'CONFIGURED' : 'MISSING - alerts disabled'}`);
  logger.info('   Twitter/X: NOT CONNECTED (social metrics use on-chain proxy)');

  // Strategy Configuration
  logger.info('');
  logger.info('STRATEGIES');
  logger.info(`   Early Token (5min-90min): ${appConfig.trading.enableEarlyStrategy ? 'ENABLED - 20s scan cycle' : 'DISABLED'}`);
  logger.info(`   Mature Token (21+ days): ${appConfig.trading.enableMatureStrategy ? 'ENABLED - 5min scan cycle' : 'DISABLED'}`);
  logger.info(`   Pump.fun Dev Tracker: ${appConfig.devTracker.enabled ? 'ENABLED - 15s poll cycle' : 'DISABLED'}`);

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
  logger.info(`   Market Cap: $${appConfig.screening.minMarketCap.toLocaleString()} - $${appConfig.screening.maxMarketCap.toLocaleString()}`);
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
