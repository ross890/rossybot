/**
 * Standalone runner for the Pump.fun Market Analyzer.
 *
 * Usage:
 *   npx tsx src/modules/market-analyzer/run.ts           # Run once (end-of-day analysis)
 *   npx tsx src/modules/market-analyzer/run.ts --cron     # Run with daily cron schedule (23:30 UTC)
 *   npx tsx src/modules/market-analyzer/run.ts --test     # Dry run with limited tokens
 *
 * Cron setup (alternative to --cron flag):
 *   30 23 * * * cd /path/to/rossybot-v2 && npx tsx src/modules/market-analyzer/run.ts >> logs/market-analyzer.log 2>&1
 */
import dotenv from 'dotenv';
dotenv.config();

import { logger } from '../../utils/logger.js';
import { testConnection } from '../../db/database.js';
import { runDailyAnalysis } from './index.js';

const args = process.argv.slice(2);
const isCron = args.includes('--cron');
const isTest = args.includes('--test');

async function main(): Promise<void> {
  logger.info({ mode: isCron ? 'cron' : isTest ? 'test' : 'once' }, 'Pump.fun Market Analyzer starting');

  // Test DB connection
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('Database connection failed — exiting');
    process.exit(1);
  }

  if (isCron) {
    // Schedule daily at 23:30 UTC
    logger.info('Cron mode: scheduling daily analysis at 23:30 UTC');
    scheduleDaily(23, 30);
  } else {
    // Run once
    try {
      await runDailyAnalysis();
      logger.info('Analysis complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Analysis failed');
      process.exit(1);
    }
  }
}

function scheduleDaily(hour: number, minute: number): void {
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hour, minute, 0, 0);

    // If we've already passed the time today, schedule for tomorrow
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    const delayMs = next.getTime() - now.getTime();
    logger.info({
      nextRun: next.toISOString(),
      inHours: (delayMs / 3_600_000).toFixed(1),
    }, 'Next analysis scheduled');

    setTimeout(async () => {
      try {
        await runDailyAnalysis();
      } catch (err) {
        logger.error({ err }, 'Scheduled analysis failed');
      }
      // Schedule next run
      scheduleNext();
    }, delayMs);
  };

  scheduleNext();

  // Keep process alive
  process.on('SIGINT', () => {
    logger.info('Shutting down market analyzer');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logger.info('Shutting down market analyzer');
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
