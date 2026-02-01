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
