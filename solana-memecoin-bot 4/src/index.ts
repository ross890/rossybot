// ===========================================
// SOLANA MEMECOIN BOT - MAIN ENTRY POINT
// ===========================================

import { appConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { pool, SCHEMA_SQL } from './utils/database.js';
import { signalGenerator } from './modules/signal-generator.js';
import { telegramBot } from './modules/telegram.js';
import { macroGannAnalyzer, MacroDatabase } from './modules/macro/index.js';

// ============ STARTUP ============

async function initializeDatabase(): Promise<void> {
  logger.info('Initializing database...');

  try {
    const client = await pool.connect();
    await client.query(SCHEMA_SQL);
    client.release();
    logger.info('Database schema initialized');

    // Initialize macro database schema (separate tables)
    await MacroDatabase.initializeSchema();
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

  // Initialize signal generator (memecoin)
  await signalGenerator.initialize();

  // Initialize macro Gann analyzer (informational, separate module)
  try {
    await macroGannAnalyzer.initialize();
    macroGannAnalyzer.start();
    logger.info('Macro Gann Analyzer started (informational signals)');
  } catch (error) {
    // Non-fatal - macro module is optional
    logger.warn({ error }, 'Macro Gann Analyzer failed to start (continuing without it)');
  }

  // Start the main memecoin loop
  signalGenerator.start();

  logger.info('Bot is running! Press Ctrl+C to stop.');

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    signalGenerator.stop();
    macroGannAnalyzer.stop();
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
