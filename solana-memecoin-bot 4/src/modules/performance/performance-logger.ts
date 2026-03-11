// ===========================================
// MODULE: PERFORMANCE LOGGER
// Utility for easy logging across all modules
// Simplified: uses standard logger instead of deleted deployment-logs-reader
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';

// ============ TYPES ============

export type LogSeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
export type LogCategory = 'SIGNAL' | 'TRADE' | 'KOL' | 'API' | 'SYSTEM';

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

    this.startHealthMonitor();
    this.isInitialized = true;

    logger.info('Performance logger initialized');
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

  async logSignalEvaluation(data: SignalLogData): Promise<void> {
    hourlyCounters.signalsGenerated++;

    if (data.passed) {
      hourlyCounters.signalsSent++;
    } else {
      hourlyCounters.signalsFiltered++;
    }

    const logData = {
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
      tokenAddress: data.tokenAddress,
    };

    if (data.passed) {
      logger.info(logData, `Signal generated: ${data.tokenTicker} (${data.signalType})`);
    } else {
      logger.debug(logData, `Signal filtered: ${data.tokenTicker} - ${data.filterReason}`);
    }
  }

  async logSignalSent(
    signalId: string,
    tokenAddress: string,
    tokenTicker: string,
    signalType: string,
    compositeScore: number
  ): Promise<void> {
    logger.info({ signalId, tokenAddress, signalType, compositeScore }, `Signal sent: ${tokenTicker}`);
  }

  // ============ TRADE LOGGING ============

  async logTrade(data: TradeLogData): Promise<void> {
    hourlyCounters.tradesExecuted++;
    if (data.success) {
      hourlyCounters.tradesSuccessful++;
    }

    const logData = {
      action: data.action,
      solAmount: data.solAmount,
      priceUsd: data.priceUsd,
      success: data.success,
      error: data.error,
      txSignature: data.txSignature,
      tokenAddress: data.tokenAddress,
      signalId: data.signalId,
    };

    if (data.success) {
      logger.info(logData, `Trade executed: ${data.action} ${data.solAmount} SOL of ${data.tokenTicker}`);
    } else {
      logger.warn(logData, `Trade failed: ${data.action} ${data.tokenTicker} - ${data.error}`);
    }
  }

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
    logger.info({
      tokenAddress,
      tokenTicker,
      signalId,
      outcome,
      entryData,
      outcomeData,
      factors,
    }, `Trade outcome: ${tokenTicker} - ${outcome}`);
  }

  // ============ KOL LOGGING ============

  async logKolActivity(
    kolHandle: string,
    tokenAddress: string,
    tokenTicker: string,
    action: 'BUY' | 'SELL',
    solAmount: number
  ): Promise<void> {
    hourlyCounters.kolTradesDetected++;
    logger.info({ kolHandle, tokenAddress, action, solAmount }, `KOL ${action}: ${kolHandle} - ${tokenTicker}`);
  }

  // ============ SCAN CYCLE LOGGING ============

  async logScanCycle(data: ScanCycleData): Promise<void> {
    logger.info({ scanCycle: data }, 'Scan cycle complete');
  }

  // ============ API LOGGING ============

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

    const logData = { service, endpoint, success, latencyMs, error };

    if (success) {
      logger.debug(logData, `${service}: ${endpoint}`);
    } else {
      logger.warn(logData, `${service}: ${endpoint}`);
    }
  }

  // ============ ERROR LOGGING ============

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
    logger.error({ category, error, ...context }, message);
  }

  async logCritical(
    message: string,
    error: Error | unknown,
    context?: Record<string, any>
  ): Promise<void> {
    logger.error({ error, context }, `CRITICAL: ${message}`);
  }

  // ============ SYSTEM LOGGING ============

  async logSystem(
    severity: LogSeverity,
    message: string,
    context?: Record<string, any>
  ): Promise<void> {
    const level = severity === 'DEBUG' ? 'debug' :
      severity === 'WARN' ? 'warn' :
      severity === 'ERROR' || severity === 'CRITICAL' ? 'error' : 'info';
    logger[level]({ context }, message);
  }

  // ============ HEALTH MONITORING ============

  private startHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
    }

    this.healthTimer = setInterval(
      () => this.recordHealthSnapshot(),
      this.HEALTH_INTERVAL_MS
    );

    this.recordHealthSnapshot();
    logger.info('Health monitor started - snapshots every hour');
  }

  private async recordHealthSnapshot(): Promise<void> {
    try {
      const memUsage = process.memoryUsage();
      const memoryMb = memUsage.heapUsed / 1024 / 1024;

      const poolStats = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };

      logger.info({
        signalsSent: hourlyCounters.signalsSent,
        signalsFiltered: hourlyCounters.signalsFiltered,
        tradesExecuted: hourlyCounters.tradesExecuted,
        tradesSuccessful: hourlyCounters.tradesSuccessful,
        kolTradesDetected: hourlyCounters.kolTradesDetected,
        apiErrors: hourlyCounters.apiErrors,
        memoryMb: Math.round(memoryMb),
        dbPool: poolStats,
      }, 'Health snapshot recorded');

      this.resetHourlyCounters();
    } catch (error) {
      logger.error({ error }, 'Failed to record health snapshot');
    }
  }

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
