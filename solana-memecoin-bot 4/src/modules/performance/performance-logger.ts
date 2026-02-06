// ===========================================
// MODULE: PERFORMANCE LOGGER
// Utility for easy logging across all modules
// Automatically collects metrics and logs for analysis
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import {
  deploymentLogsReader,
  LogSeverity,
  LogCategory,
} from './deployment-logs-reader.js';

// ============ TYPES ============

export interface SignalLogData {
  tokenAddress: string;
  tokenTicker: string;
  signalType: 'ONCHAIN' | 'KOL' | 'DISCOVERY';
  signalTrack?: string;
  compositeScore: number;
  momentumScore: number;
  safetyScore: number;
  bundleRiskScore: number;
  marketCap: number;
  liquidity: number;
  tokenAge: number;
  holderCount: number;
  passed: boolean;
  filterReason?: string;
  kolHandle?: string;
  winProbability?: number;
}

export interface TradeLogData {
  tokenAddress: string;
  tokenTicker: string;
  action: 'BUY' | 'SELL';
  solAmount: number;
  priceUsd: number;
  signalId?: string;
  success: boolean;
  error?: string;
  txSignature?: string;
}

export interface ScanCycleData {
  totalCandidates: number;
  preFilterPassed: number;
  safetyBlocked: number;
  scamRejected: number;
  scoringFailed: number;
  momentumFailed: number;
  bundleBlocked: number;
  signalsGenerated: number;
  onchainSignals: number;
  kolSignals: number;
  discoverySignals: number;
  cycleTimeMs: number;
}

// ============ COUNTERS FOR HOURLY AGGREGATION ============

interface HourlyCounters {
  signalsGenerated: number;
  signalsSent: number;
  signalsFiltered: number;
  tradesExecuted: number;
  tradesSuccessful: number;
  kolTradesDetected: number;
  apiErrors: number;
  lastReset: Date;
}

let hourlyCounters: HourlyCounters = {
  signalsGenerated: 0,
  signalsSent: 0,
  signalsFiltered: 0,
  tradesExecuted: 0,
  tradesSuccessful: 0,
  kolTradesDetected: 0,
  apiErrors: 0,
  lastReset: new Date(),
};

// ============ PERFORMANCE LOGGER CLASS ============

export class PerformanceLogger {
  private isInitialized = false;
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly HEALTH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  /**
   * Initialize the performance logger
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    await deploymentLogsReader.initialize();
    this.startHealthMonitor();
    this.isInitialized = true;

    await this.logSystem('INFO', 'Performance logger initialized');
    logger.info('Performance Logger initialized - metrics collection active');
  }

  /**
   * Stop the performance logger
   */
  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    logger.info('Performance Logger stopped');
  }

  // ============ SIGNAL LOGGING ============

  /**
   * Log a signal evaluation (pass or fail)
   */
  async logSignalEvaluation(data: SignalLogData): Promise<void> {
    hourlyCounters.signalsGenerated++;

    if (data.passed) {
      hourlyCounters.signalsSent++;
    } else {
      hourlyCounters.signalsFiltered++;
    }

    const severity: LogSeverity = data.passed ? 'INFO' : 'DEBUG';
    const message = data.passed
      ? `Signal generated: ${data.tokenTicker} (${data.signalType})`
      : `Signal filtered: ${data.tokenTicker} - ${data.filterReason}`;

    await deploymentLogsReader.writeLog(severity, 'SIGNAL', message, {
      context: {
        signalType: data.signalType,
        signalTrack: data.signalTrack,
        compositeScore: data.compositeScore,
        momentumScore: data.momentumScore,
        safetyScore: data.safetyScore,
        bundleRiskScore: data.bundleRiskScore,
        marketCap: data.marketCap,
        liquidity: data.liquidity,
        tokenAge: data.tokenAge,
        holderCount: data.holderCount,
        passed: data.passed,
        filterReason: data.filterReason,
        winProbability: data.winProbability,
      },
      tokenAddress: data.tokenAddress,
      kolHandle: data.kolHandle,
    });

    // Record as metric
    await deploymentLogsReader.recordMetric(
      data.passed ? 'signal.sent' : 'signal.filtered',
      1,
      'count',
      {
        signalType: data.signalType,
        signalTrack: data.signalTrack,
        compositeScore: data.compositeScore,
      }
    );
  }

  /**
   * Log a signal that was sent
   */
  async logSignalSent(
    signalId: string,
    tokenAddress: string,
    tokenTicker: string,
    signalType: string,
    compositeScore: number
  ): Promise<void> {
    await deploymentLogsReader.writeLog('INFO', 'SIGNAL', `Signal sent: ${tokenTicker}`, {
      context: { signalType, compositeScore },
      tokenAddress,
      signalId,
    });
  }

  // ============ TRADE LOGGING ============

  /**
   * Log a trade execution
   */
  async logTrade(data: TradeLogData): Promise<void> {
    hourlyCounters.tradesExecuted++;
    if (data.success) {
      hourlyCounters.tradesSuccessful++;
    }

    const severity: LogSeverity = data.success ? 'INFO' : 'WARN';
    const message = data.success
      ? `Trade executed: ${data.action} ${data.solAmount} SOL of ${data.tokenTicker}`
      : `Trade failed: ${data.action} ${data.tokenTicker} - ${data.error}`;

    await deploymentLogsReader.writeLog(severity, 'TRADE', message, {
      context: {
        action: data.action,
        solAmount: data.solAmount,
        priceUsd: data.priceUsd,
        success: data.success,
        error: data.error,
        txSignature: data.txSignature,
      },
      tokenAddress: data.tokenAddress,
      signalId: data.signalId,
    });

    // Record metrics
    await deploymentLogsReader.recordMetric(
      data.success ? 'trade.success' : 'trade.failed',
      1,
      'count',
      { action: data.action }
    );

    if (data.success) {
      await deploymentLogsReader.recordMetric(
        'trade.volume',
        data.solAmount,
        'SOL',
        { action: data.action }
      );
    }
  }

  /**
   * Log a trade outcome (win/loss) for analysis
   */
  async logTradeOutcome(
    tokenAddress: string,
    tokenTicker: string,
    signalId: string,
    outcome: 'WIN' | 'LOSS',
    entryData: {
      price: number;
      mcap: number;
      liquidity: number;
      holderCount: number;
      tokenAgeMins: number;
      compositeScore: number;
      safetyScore: number;
      momentumScore: number;
      kolHandle?: string;
      kolTier?: string;
    },
    outcomeData: {
      peakRoi: number;
      finalRoi: number;
      holdTimeHours: number;
      exitReason: string;
    },
    factors?: {
      contributing: Record<string, any>;
      warnings: Record<string, any>;
    }
  ): Promise<void> {
    await deploymentLogsReader.recordTradeOutcome({
      tokenAddress,
      tokenTicker,
      signalId,
      entryPrice: entryData.price,
      entryMcap: entryData.mcap,
      entryLiquidity: entryData.liquidity,
      entryHolderCount: entryData.holderCount,
      entryTokenAgeMins: entryData.tokenAgeMins,
      compositeScore: entryData.compositeScore,
      safetyScore: entryData.safetyScore,
      momentumScore: entryData.momentumScore,
      kolHandle: entryData.kolHandle,
      kolTier: entryData.kolTier,
      outcome,
      peakRoi: outcomeData.peakRoi,
      finalRoi: outcomeData.finalRoi,
      holdTimeHours: outcomeData.holdTimeHours,
      exitReason: outcomeData.exitReason,
      contributingFactors: factors?.contributing,
      warnings: factors?.warnings,
    });

    await deploymentLogsReader.writeLog('INFO', 'TRADE', `Trade outcome: ${tokenTicker} - ${outcome}`, {
      context: {
        outcome,
        finalRoi: outcomeData.finalRoi,
        peakRoi: outcomeData.peakRoi,
        holdTimeHours: outcomeData.holdTimeHours,
        exitReason: outcomeData.exitReason,
      },
      tokenAddress,
      signalId,
    });
  }

  // ============ KOL LOGGING ============

  /**
   * Log KOL activity detection
   */
  async logKolActivity(
    kolHandle: string,
    tokenAddress: string,
    tokenTicker: string,
    action: 'BUY' | 'SELL',
    solAmount: number
  ): Promise<void> {
    hourlyCounters.kolTradesDetected++;

    await deploymentLogsReader.writeLog('INFO', 'KOL', `KOL ${action}: ${kolHandle} - ${tokenTicker}`, {
      context: {
        action,
        solAmount,
      },
      tokenAddress,
      kolHandle,
    });

    await deploymentLogsReader.recordMetric(
      'kol.trade_detected',
      1,
      'count',
      { kolHandle, action }
    );
  }

  // ============ SCAN CYCLE LOGGING ============

  /**
   * Log a complete scan cycle with all metrics
   */
  async logScanCycle(data: ScanCycleData): Promise<void> {
    await deploymentLogsReader.writeLog('INFO', 'SYSTEM', 'Scan cycle complete', {
      context: data,
    });

    // Record individual metrics
    await deploymentLogsReader.recordMetric('scan.candidates', data.totalCandidates, 'count');
    await deploymentLogsReader.recordMetric('scan.signals_generated', data.signalsGenerated, 'count');
    await deploymentLogsReader.recordMetric('scan.cycle_time', data.cycleTimeMs, 'ms');

    // Calculate filter breakdown percentages
    if (data.preFilterPassed > 0) {
      const safetyBlockRate = (data.safetyBlocked / data.preFilterPassed) * 100;
      const scamRejectRate = (data.scamRejected / data.preFilterPassed) * 100;
      const momentumFailRate = (data.momentumFailed / data.preFilterPassed) * 100;

      await deploymentLogsReader.recordMetric('filter.safety_block_rate', safetyBlockRate, 'percent');
      await deploymentLogsReader.recordMetric('filter.scam_reject_rate', scamRejectRate, 'percent');
      await deploymentLogsReader.recordMetric('filter.momentum_fail_rate', momentumFailRate, 'percent');
    }
  }

  // ============ API LOGGING ============

  /**
   * Log an API call (success or error)
   */
  async logApiCall(
    service: 'helius' | 'dexscreener' | 'jupiter' | 'twitter',
    endpoint: string,
    success: boolean,
    latencyMs: number,
    error?: string
  ): Promise<void> {
    if (!success) {
      hourlyCounters.apiErrors++;
    }

    const severity: LogSeverity = success ? 'DEBUG' : 'WARN';

    await deploymentLogsReader.writeLog(severity, 'API', `${service}: ${endpoint}`, {
      context: {
        service,
        endpoint,
        success,
        latencyMs,
        error,
      },
    });

    await deploymentLogsReader.recordMetric(`api.${service}.latency`, latencyMs, 'ms');
    if (!success) {
      await deploymentLogsReader.recordMetric(`api.${service}.errors`, 1, 'count');
    }
  }

  // ============ ERROR LOGGING ============

  /**
   * Log an error
   */
  async logError(
    category: LogCategory,
    message: string,
    error: Error | unknown,
    context?: {
      tokenAddress?: string;
      signalId?: string;
      kolHandle?: string;
      data?: Record<string, any>;
    }
  ): Promise<void> {
    const errorStack = error instanceof Error ? error.stack : String(error);

    await deploymentLogsReader.writeLog('ERROR', category, message, {
      context: context?.data,
      tokenAddress: context?.tokenAddress,
      signalId: context?.signalId,
      kolHandle: context?.kolHandle,
      errorStack,
    });
  }

  /**
   * Log a critical error
   */
  async logCritical(
    message: string,
    error: Error | unknown,
    context?: Record<string, any>
  ): Promise<void> {
    const errorStack = error instanceof Error ? error.stack : String(error);

    await deploymentLogsReader.writeLog('CRITICAL', 'SYSTEM', message, {
      context,
      errorStack,
    });

    // Also log to standard logger for immediate visibility
    logger.error({ error, context }, `CRITICAL: ${message}`);
  }

  // ============ SYSTEM LOGGING ============

  /**
   * Log a system message
   */
  async logSystem(
    severity: LogSeverity,
    message: string,
    context?: Record<string, any>
  ): Promise<void> {
    await deploymentLogsReader.writeLog(severity, 'SYSTEM', message, { context });
  }

  // ============ HEALTH MONITORING ============

  /**
   * Start the health monitor
   */
  private startHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
    }

    // Record health snapshot every hour
    this.healthTimer = setInterval(
      () => this.recordHealthSnapshot(),
      this.HEALTH_INTERVAL_MS
    );

    // Also record initial snapshot
    this.recordHealthSnapshot();

    logger.info('Health monitor started - snapshots every hour');
  }

  /**
   * Record a health snapshot
   */
  private async recordHealthSnapshot(): Promise<void> {
    try {
      // Get memory usage
      const memUsage = process.memoryUsage();
      const memoryMb = memUsage.heapUsed / 1024 / 1024;

      // Get database pool stats
      const poolStats = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };

      // Calculate trade success rate
      const tradeSuccessRate = hourlyCounters.tradesExecuted > 0
        ? hourlyCounters.tradesSuccessful / hourlyCounters.tradesExecuted
        : null;

      // Get active KOL count from database
      let activeKolWallets = 0;
      try {
        const kolResult = await pool.query(`
          SELECT COUNT(DISTINCT wallet_address) as count
          FROM kol_wallets
          WHERE is_active = true
        `);
        activeKolWallets = parseInt(kolResult.rows[0]?.count) || 0;
      } catch {
        // Ignore errors in KOL count
      }

      // Record the snapshot
      await deploymentLogsReader.recordHealthSnapshot({
        signalsGenerated1h: hourlyCounters.signalsGenerated,
        signalsSent1h: hourlyCounters.signalsSent,
        signalsFiltered1h: hourlyCounters.signalsFiltered,
        tradesExecuted1h: hourlyCounters.tradesExecuted,
        tradeSuccessRate,
        activeKolWallets,
        kolTradesDetected1h: hourlyCounters.kolTradesDetected,
        apiErrorCount1h: hourlyCounters.apiErrors,
        dbPoolSize: poolStats.total,
        dbActiveConnections: poolStats.total - poolStats.idle,
        memoryUsageMb: memoryMb,
      });

      // Reset hourly counters
      this.resetHourlyCounters();

      logger.info({
        signalsSent: hourlyCounters.signalsSent,
        tradesExecuted: hourlyCounters.tradesExecuted,
        memoryMb: Math.round(memoryMb),
      }, 'Health snapshot recorded');
    } catch (error) {
      logger.error({ error }, 'Failed to record health snapshot');
    }
  }

  /**
   * Reset hourly counters
   */
  private resetHourlyCounters(): void {
    hourlyCounters = {
      signalsGenerated: 0,
      signalsSent: 0,
      signalsFiltered: 0,
      tradesExecuted: 0,
      tradesSuccessful: 0,
      kolTradesDetected: 0,
      apiErrors: 0,
      lastReset: new Date(),
    };
  }

  /**
   * Get current hourly stats (for real-time display)
   */
  getCurrentHourlyStats(): HourlyCounters {
    return { ...hourlyCounters };
  }
}

// ============ EXPORTS ============

export const performanceLogger = new PerformanceLogger();

export default {
  PerformanceLogger,
  performanceLogger,
};
