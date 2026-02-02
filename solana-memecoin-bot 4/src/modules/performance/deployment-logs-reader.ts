// ===========================================
// MODULE: DEPLOYMENT LOGS READER
// Reads deployment logs and performance data from the database
// for strategy analysis and system monitoring
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';

// ============ TYPES ============

export type LogSeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
export type LogCategory = 'SIGNAL' | 'TRADE' | 'KOL' | 'SAFETY' | 'DISCOVERY' | 'PERFORMANCE' | 'SYSTEM' | 'API' | 'DATABASE';

export interface DeploymentLog {
  id: string;
  severity: LogSeverity;
  category: LogCategory;
  message: string;
  context: Record<string, any> | null;
  tokenAddress: string | null;
  kolHandle: string | null;
  signalId: string | null;
  errorStack: string | null;
  createdAt: Date;
}

export interface PerformanceMetric {
  id: string;
  metricName: string;
  metricValue: number;
  metricUnit: string | null;
  tags: Record<string, any> | null;
  recordedAt: Date;
}

export interface SystemHealthSnapshot {
  id: string;

  // Signal metrics
  signalsGenerated1h: number;
  signalsSent1h: number;
  signalsFiltered1h: number;
  avgSignalScore: number | null;

  // Trade metrics
  tradesExecuted1h: number;
  tradeSuccessRate: number | null;
  avgTradeRoi: number | null;

  // KOL metrics
  activeKolWallets: number;
  kolTradesDetected1h: number;

  // API health
  birdeyeLatencyMs: number | null;
  heliusLatencyMs: number | null;
  dexscreenerLatencyMs: number | null;
  apiErrorCount1h: number;

  // Database health
  dbPoolSize: number | null;
  dbActiveConnections: number | null;
  dbQueryAvgMs: number | null;

  // Memory & CPU
  memoryUsageMb: number | null;
  cpuUsagePercent: number | null;

  snapshotTime: Date;
}

export interface TradeOutcomeAnalysis {
  id: string;
  tokenAddress: string;
  tokenTicker: string | null;
  signalId: string | null;

  // Entry conditions
  entryPrice: number | null;
  entryMcap: number | null;
  entryLiquidity: number | null;
  entryHolderCount: number | null;
  entryTokenAgeMins: number | null;

  // Scores at entry
  compositeScore: number | null;
  safetyScore: number | null;
  momentumScore: number | null;

  // KOL info
  kolHandle: string | null;
  kolTier: string | null;

  // Outcome
  outcome: 'WIN' | 'LOSS' | 'PENDING' | null;
  peakRoi: number | null;
  finalRoi: number | null;
  holdTimeHours: number | null;
  exitReason: string | null;

  // Analysis flags
  contributingFactors: Record<string, any> | null;
  warnings: Record<string, any> | null;

  analyzedAt: Date;
}

export interface LogQuery {
  severity?: LogSeverity | LogSeverity[];
  category?: LogCategory | LogCategory[];
  tokenAddress?: string;
  kolHandle?: string;
  signalId?: string;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
  offset?: number;
  searchText?: string;
}

export interface LogSummary {
  totalLogs: number;
  bySeverity: Record<LogSeverity, number>;
  byCategory: Record<LogCategory, number>;
  errorRate: number;
  topErrors: Array<{ message: string; count: number }>;
  timeRange: { start: Date; end: Date };
}

export interface PerformanceSummary {
  signalsGenerated: number;
  signalsSent: number;
  signalsFiltered: number;
  filterRate: number;
  tradesExecuted: number;
  avgWinRate: number;
  avgRoi: number;
  apiHealthScore: number;
  dbHealthScore: number;
  avgMemoryUsageMb: number;
  avgCpuUsagePercent: number;
  timeRange: { start: Date; end: Date };
}

export interface WinLossAnalysis {
  totalTrades: number;
  wins: number;
  losses: number;
  pending: number;
  winRate: number;
  avgWinRoi: number;
  avgLossRoi: number;
  avgHoldTimeWins: number;
  avgHoldTimeLosses: number;
  topWinningFactors: Array<{ factor: string; frequency: number }>;
  topLosingFactors: Array<{ factor: string; frequency: number }>;
  byKol: Array<{
    kolHandle: string;
    wins: number;
    losses: number;
    winRate: number;
  }>;
  byScoreRange: Array<{
    range: string;
    count: number;
    winRate: number;
  }>;
}

// ============ DEPLOYMENT LOGS READER CLASS ============

export class DeploymentLogsReader {
  private isInitialized = false;

  /**
   * Initialize the reader and ensure tables exist
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Tables are created via SCHEMA_SQL in database.ts
    this.isInitialized = true;
    logger.info('Deployment Logs Reader initialized');
  }

  // ============ LOG WRITING ============

  /**
   * Write a deployment log entry
   */
  async writeLog(
    severity: LogSeverity,
    category: LogCategory,
    message: string,
    options?: {
      context?: Record<string, any>;
      tokenAddress?: string;
      kolHandle?: string;
      signalId?: string;
      errorStack?: string;
    }
  ): Promise<void> {
    try {
      await pool.query(`
        INSERT INTO deployment_logs (
          severity, category, message, context,
          token_address, kol_handle, signal_id, error_stack
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        severity,
        category,
        message,
        options?.context ? JSON.stringify(options.context) : null,
        options?.tokenAddress || null,
        options?.kolHandle || null,
        options?.signalId || null,
        options?.errorStack || null,
      ]);
    } catch (error) {
      // Don't throw - logging failures shouldn't break the app
      logger.error({ error }, 'Failed to write deployment log');
    }
  }

  /**
   * Record a performance metric
   */
  async recordMetric(
    metricName: string,
    metricValue: number,
    metricUnit?: string,
    tags?: Record<string, any>
  ): Promise<void> {
    try {
      await pool.query(`
        INSERT INTO performance_metrics (metric_name, metric_value, metric_unit, tags)
        VALUES ($1, $2, $3, $4)
      `, [metricName, metricValue, metricUnit || null, tags ? JSON.stringify(tags) : null]);
    } catch (error) {
      logger.error({ error }, 'Failed to record performance metric');
    }
  }

  /**
   * Record a system health snapshot
   */
  async recordHealthSnapshot(snapshot: Partial<Omit<SystemHealthSnapshot, 'id' | 'snapshotTime'>>): Promise<void> {
    try {
      await pool.query(`
        INSERT INTO system_health_snapshots (
          signals_generated_1h, signals_sent_1h, signals_filtered_1h, avg_signal_score,
          trades_executed_1h, trade_success_rate, avg_trade_roi,
          active_kol_wallets, kol_trades_detected_1h,
          birdeye_latency_ms, helius_latency_ms, dexscreener_latency_ms, api_error_count_1h,
          db_pool_size, db_active_connections, db_query_avg_ms,
          memory_usage_mb, cpu_usage_percent
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      `, [
        snapshot.signalsGenerated1h || 0,
        snapshot.signalsSent1h || 0,
        snapshot.signalsFiltered1h || 0,
        snapshot.avgSignalScore || null,
        snapshot.tradesExecuted1h || 0,
        snapshot.tradeSuccessRate || null,
        snapshot.avgTradeRoi || null,
        snapshot.activeKolWallets || 0,
        snapshot.kolTradesDetected1h || 0,
        snapshot.birdeyeLatencyMs || null,
        snapshot.heliusLatencyMs || null,
        snapshot.dexscreenerLatencyMs || null,
        snapshot.apiErrorCount1h || 0,
        snapshot.dbPoolSize || null,
        snapshot.dbActiveConnections || null,
        snapshot.dbQueryAvgMs || null,
        snapshot.memoryUsageMb || null,
        snapshot.cpuUsagePercent || null,
      ]);
    } catch (error) {
      logger.error({ error }, 'Failed to record health snapshot');
    }
  }

  /**
   * Record a trade outcome analysis
   */
  async recordTradeOutcome(analysis: Partial<Omit<TradeOutcomeAnalysis, 'id' | 'analyzedAt'>>): Promise<void> {
    try {
      await pool.query(`
        INSERT INTO trade_outcome_analysis (
          token_address, token_ticker, signal_id,
          entry_price, entry_mcap, entry_liquidity, entry_holder_count, entry_token_age_mins,
          composite_score, safety_score, momentum_score,
          kol_handle, kol_tier,
          outcome, peak_roi, final_roi, hold_time_hours, exit_reason,
          contributing_factors, warnings
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      `, [
        analysis.tokenAddress,
        analysis.tokenTicker || null,
        analysis.signalId || null,
        analysis.entryPrice || null,
        analysis.entryMcap || null,
        analysis.entryLiquidity || null,
        analysis.entryHolderCount || null,
        analysis.entryTokenAgeMins || null,
        analysis.compositeScore || null,
        analysis.safetyScore || null,
        analysis.momentumScore || null,
        analysis.kolHandle || null,
        analysis.kolTier || null,
        analysis.outcome || null,
        analysis.peakRoi || null,
        analysis.finalRoi || null,
        analysis.holdTimeHours || null,
        analysis.exitReason || null,
        analysis.contributingFactors ? JSON.stringify(analysis.contributingFactors) : null,
        analysis.warnings ? JSON.stringify(analysis.warnings) : null,
      ]);
    } catch (error) {
      logger.error({ error }, 'Failed to record trade outcome');
    }
  }

  // ============ LOG READING ============

  /**
   * Query deployment logs with filters
   */
  async getLogs(query: LogQuery = {}): Promise<DeploymentLog[]> {
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (query.severity) {
        const severities = Array.isArray(query.severity) ? query.severity : [query.severity];
        conditions.push(`severity = ANY($${paramIndex}::deployment_log_severity[])`);
        params.push(severities);
        paramIndex++;
      }

      if (query.category) {
        const categories = Array.isArray(query.category) ? query.category : [query.category];
        conditions.push(`category = ANY($${paramIndex}::deployment_log_category[])`);
        params.push(categories);
        paramIndex++;
      }

      if (query.tokenAddress) {
        conditions.push(`token_address = $${paramIndex}`);
        params.push(query.tokenAddress);
        paramIndex++;
      }

      if (query.kolHandle) {
        conditions.push(`kol_handle = $${paramIndex}`);
        params.push(query.kolHandle);
        paramIndex++;
      }

      if (query.signalId) {
        conditions.push(`signal_id = $${paramIndex}`);
        params.push(query.signalId);
        paramIndex++;
      }

      if (query.startTime) {
        conditions.push(`created_at >= $${paramIndex}`);
        params.push(query.startTime);
        paramIndex++;
      }

      if (query.endTime) {
        conditions.push(`created_at <= $${paramIndex}`);
        params.push(query.endTime);
        paramIndex++;
      }

      if (query.searchText) {
        conditions.push(`message ILIKE $${paramIndex}`);
        params.push(`%${query.searchText}%`);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = query.limit || 100;
      const offset = query.offset || 0;

      const result = await pool.query(`
        SELECT * FROM deployment_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `, params);

      return result.rows.map(this.mapLogRow);
    } catch (error) {
      logger.error({ error }, 'Failed to get deployment logs');
      return [];
    }
  }

  /**
   * Get log summary for a time period
   */
  async getLogSummary(hours: number = 24): Promise<LogSummary> {
    try {
      const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);

      // Get counts by severity
      const severityResult = await pool.query(`
        SELECT severity, COUNT(*) as count
        FROM deployment_logs
        WHERE created_at >= $1
        GROUP BY severity
      `, [startTime]);

      // Get counts by category
      const categoryResult = await pool.query(`
        SELECT category, COUNT(*) as count
        FROM deployment_logs
        WHERE created_at >= $1
        GROUP BY category
      `, [startTime]);

      // Get top errors
      const errorResult = await pool.query(`
        SELECT message, COUNT(*) as count
        FROM deployment_logs
        WHERE created_at >= $1 AND severity IN ('ERROR', 'CRITICAL')
        GROUP BY message
        ORDER BY count DESC
        LIMIT 10
      `, [startTime]);

      // Get total count
      const totalResult = await pool.query(`
        SELECT COUNT(*) as total
        FROM deployment_logs
        WHERE created_at >= $1
      `, [startTime]);

      const bySeverity: Record<LogSeverity, number> = {
        DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, CRITICAL: 0,
      };
      severityResult.rows.forEach((row: any) => {
        bySeverity[row.severity as LogSeverity] = parseInt(row.count);
      });

      const byCategory: Record<LogCategory, number> = {
        SIGNAL: 0, TRADE: 0, KOL: 0, SAFETY: 0, DISCOVERY: 0,
        PERFORMANCE: 0, SYSTEM: 0, API: 0, DATABASE: 0,
      };
      categoryResult.rows.forEach((row: any) => {
        byCategory[row.category as LogCategory] = parseInt(row.count);
      });

      const totalLogs = parseInt(totalResult.rows[0].total);
      const errorCount = bySeverity.ERROR + bySeverity.CRITICAL;

      return {
        totalLogs,
        bySeverity,
        byCategory,
        errorRate: totalLogs > 0 ? (errorCount / totalLogs) * 100 : 0,
        topErrors: errorResult.rows.map((row: any) => ({
          message: row.message,
          count: parseInt(row.count),
        })),
        timeRange: { start: startTime, end: new Date() },
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get log summary');
      throw error;
    }
  }

  /**
   * Get recent errors for quick debugging
   */
  async getRecentErrors(limit: number = 20): Promise<DeploymentLog[]> {
    return this.getLogs({
      severity: ['ERROR', 'CRITICAL'],
      limit,
    });
  }

  /**
   * Get logs for a specific token
   */
  async getTokenLogs(tokenAddress: string, limit: number = 50): Promise<DeploymentLog[]> {
    return this.getLogs({
      tokenAddress,
      limit,
    });
  }

  /**
   * Get logs for a specific signal
   */
  async getSignalLogs(signalId: string): Promise<DeploymentLog[]> {
    return this.getLogs({
      signalId,
      limit: 100,
    });
  }

  // ============ PERFORMANCE READING ============

  /**
   * Get performance metrics for a time range
   */
  async getMetrics(
    metricName?: string,
    hours: number = 24,
    limit: number = 100
  ): Promise<PerformanceMetric[]> {
    try {
      const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);

      let query = `
        SELECT * FROM performance_metrics
        WHERE recorded_at >= $1
      `;
      const params: any[] = [startTime];

      if (metricName) {
        query += ` AND metric_name = $2`;
        params.push(metricName);
      }

      query += ` ORDER BY recorded_at DESC LIMIT ${limit}`;

      const result = await pool.query(query, params);
      return result.rows.map(this.mapMetricRow);
    } catch (error) {
      logger.error({ error }, 'Failed to get performance metrics');
      return [];
    }
  }

  /**
   * Get system health snapshots
   */
  async getHealthSnapshots(hours: number = 24): Promise<SystemHealthSnapshot[]> {
    try {
      const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);

      const result = await pool.query(`
        SELECT * FROM system_health_snapshots
        WHERE snapshot_time >= $1
        ORDER BY snapshot_time DESC
      `, [startTime]);

      return result.rows.map(this.mapHealthRow);
    } catch (error) {
      logger.error({ error }, 'Failed to get health snapshots');
      return [];
    }
  }

  /**
   * Get performance summary for a time period
   */
  async getPerformanceSummary(hours: number = 24): Promise<PerformanceSummary> {
    try {
      const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);

      const result = await pool.query(`
        SELECT
          COALESCE(SUM(signals_generated_1h), 0) as total_generated,
          COALESCE(SUM(signals_sent_1h), 0) as total_sent,
          COALESCE(SUM(signals_filtered_1h), 0) as total_filtered,
          COALESCE(SUM(trades_executed_1h), 0) as total_trades,
          AVG(trade_success_rate) as avg_win_rate,
          AVG(avg_trade_roi) as avg_roi,
          AVG(api_error_count_1h) as avg_api_errors,
          AVG(birdeye_latency_ms) as avg_birdeye_latency,
          AVG(helius_latency_ms) as avg_helius_latency,
          AVG(dexscreener_latency_ms) as avg_dex_latency,
          AVG(db_query_avg_ms) as avg_db_latency,
          AVG(memory_usage_mb) as avg_memory,
          AVG(cpu_usage_percent) as avg_cpu
        FROM system_health_snapshots
        WHERE snapshot_time >= $1
      `, [startTime]);

      const row = result.rows[0];
      const totalGenerated = parseInt(row.total_generated) || 0;
      const totalFiltered = parseInt(row.total_filtered) || 0;

      // Calculate health scores (0-100)
      const avgApiLatency = (
        (parseFloat(row.avg_birdeye_latency) || 0) +
        (parseFloat(row.avg_helius_latency) || 0) +
        (parseFloat(row.avg_dex_latency) || 0)
      ) / 3;
      const apiHealthScore = Math.max(0, 100 - (avgApiLatency / 10)); // 100ms = 90 score

      const avgDbLatency = parseFloat(row.avg_db_latency) || 0;
      const dbHealthScore = Math.max(0, 100 - (avgDbLatency / 5)); // 50ms = 90 score

      return {
        signalsGenerated: totalGenerated,
        signalsSent: parseInt(row.total_sent) || 0,
        signalsFiltered: totalFiltered,
        filterRate: totalGenerated > 0 ? (totalFiltered / totalGenerated) * 100 : 0,
        tradesExecuted: parseInt(row.total_trades) || 0,
        avgWinRate: (parseFloat(row.avg_win_rate) || 0) * 100,
        avgRoi: parseFloat(row.avg_roi) || 0,
        apiHealthScore: Math.round(apiHealthScore),
        dbHealthScore: Math.round(dbHealthScore),
        avgMemoryUsageMb: parseFloat(row.avg_memory) || 0,
        avgCpuUsagePercent: parseFloat(row.avg_cpu) || 0,
        timeRange: { start: startTime, end: new Date() },
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get performance summary');
      throw error;
    }
  }

  // ============ TRADE ANALYSIS ============

  /**
   * Get trade outcome analyses
   */
  async getTradeOutcomes(
    options?: {
      outcome?: 'WIN' | 'LOSS' | 'PENDING';
      kolHandle?: string;
      hours?: number;
      limit?: number;
    }
  ): Promise<TradeOutcomeAnalysis[]> {
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (options?.outcome) {
        conditions.push(`outcome = $${paramIndex}`);
        params.push(options.outcome);
        paramIndex++;
      }

      if (options?.kolHandle) {
        conditions.push(`kol_handle = $${paramIndex}`);
        params.push(options.kolHandle);
        paramIndex++;
      }

      if (options?.hours) {
        const startTime = new Date(Date.now() - options.hours * 60 * 60 * 1000);
        conditions.push(`analyzed_at >= $${paramIndex}`);
        params.push(startTime);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = options?.limit || 100;

      const result = await pool.query(`
        SELECT * FROM trade_outcome_analysis
        ${whereClause}
        ORDER BY analyzed_at DESC
        LIMIT ${limit}
      `, params);

      return result.rows.map(this.mapTradeOutcomeRow);
    } catch (error) {
      logger.error({ error }, 'Failed to get trade outcomes');
      return [];
    }
  }

  /**
   * Get comprehensive win/loss analysis
   */
  async getWinLossAnalysis(hours: number = 168): Promise<WinLossAnalysis> {
    try {
      const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);

      // Get overall stats
      const overallResult = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE outcome = 'WIN') as wins,
          COUNT(*) FILTER (WHERE outcome = 'LOSS') as losses,
          COUNT(*) FILTER (WHERE outcome = 'PENDING') as pending,
          AVG(final_roi) FILTER (WHERE outcome = 'WIN') as avg_win_roi,
          AVG(final_roi) FILTER (WHERE outcome = 'LOSS') as avg_loss_roi,
          AVG(hold_time_hours) FILTER (WHERE outcome = 'WIN') as avg_hold_wins,
          AVG(hold_time_hours) FILTER (WHERE outcome = 'LOSS') as avg_hold_losses
        FROM trade_outcome_analysis
        WHERE analyzed_at >= $1
      `, [startTime]);

      // Get stats by KOL
      const kolResult = await pool.query(`
        SELECT
          kol_handle,
          COUNT(*) FILTER (WHERE outcome = 'WIN') as wins,
          COUNT(*) FILTER (WHERE outcome = 'LOSS') as losses
        FROM trade_outcome_analysis
        WHERE analyzed_at >= $1 AND kol_handle IS NOT NULL
        GROUP BY kol_handle
        ORDER BY (COUNT(*) FILTER (WHERE outcome = 'WIN'))::float /
          NULLIF(COUNT(*) FILTER (WHERE outcome IN ('WIN', 'LOSS')), 0) DESC
        LIMIT 20
      `, [startTime]);

      // Get stats by score range
      const scoreResult = await pool.query(`
        SELECT
          CASE
            WHEN composite_score >= 80 THEN '80-100 (High)'
            WHEN composite_score >= 60 THEN '60-79 (Medium)'
            WHEN composite_score >= 40 THEN '40-59 (Low)'
            ELSE '0-39 (Very Low)'
          END as score_range,
          COUNT(*) as count,
          COUNT(*) FILTER (WHERE outcome = 'WIN') as wins
        FROM trade_outcome_analysis
        WHERE analyzed_at >= $1 AND composite_score IS NOT NULL
        GROUP BY score_range
        ORDER BY score_range DESC
      `, [startTime]);

      // Extract contributing factors from wins and losses
      const factorsResult = await pool.query(`
        SELECT
          outcome,
          contributing_factors
        FROM trade_outcome_analysis
        WHERE analyzed_at >= $1 AND contributing_factors IS NOT NULL
      `, [startTime]);

      const winFactors: Map<string, number> = new Map();
      const lossFactors: Map<string, number> = new Map();

      factorsResult.rows.forEach((row: any) => {
        const factors = row.contributing_factors;
        const factorMap = row.outcome === 'WIN' ? winFactors : lossFactors;

        if (factors && typeof factors === 'object') {
          Object.keys(factors).forEach(key => {
            factorMap.set(key, (factorMap.get(key) || 0) + 1);
          });
        }
      });

      const row = overallResult.rows[0];
      const wins = parseInt(row.wins) || 0;
      const losses = parseInt(row.losses) || 0;
      const total = wins + losses;

      return {
        totalTrades: parseInt(row.total) || 0,
        wins,
        losses,
        pending: parseInt(row.pending) || 0,
        winRate: total > 0 ? (wins / total) * 100 : 0,
        avgWinRoi: parseFloat(row.avg_win_roi) || 0,
        avgLossRoi: parseFloat(row.avg_loss_roi) || 0,
        avgHoldTimeWins: parseFloat(row.avg_hold_wins) || 0,
        avgHoldTimeLosses: parseFloat(row.avg_hold_losses) || 0,
        topWinningFactors: Array.from(winFactors.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([factor, frequency]) => ({ factor, frequency })),
        topLosingFactors: Array.from(lossFactors.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([factor, frequency]) => ({ factor, frequency })),
        byKol: kolResult.rows.map((r: any) => ({
          kolHandle: r.kol_handle,
          wins: parseInt(r.wins) || 0,
          losses: parseInt(r.losses) || 0,
          winRate: (parseInt(r.wins) || 0) + (parseInt(r.losses) || 0) > 0
            ? ((parseInt(r.wins) || 0) / ((parseInt(r.wins) || 0) + (parseInt(r.losses) || 0))) * 100
            : 0,
        })),
        byScoreRange: scoreResult.rows.map((r: any) => ({
          range: r.score_range,
          count: parseInt(r.count) || 0,
          winRate: parseInt(r.count) > 0
            ? ((parseInt(r.wins) || 0) / parseInt(r.count)) * 100
            : 0,
        })),
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get win/loss analysis');
      throw error;
    }
  }

  // ============ UTILITY METHODS ============

  /**
   * Cleanup old logs (older than specified days)
   */
  async cleanupOldLogs(daysToKeep: number = 30): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

      const result = await pool.query(`
        DELETE FROM deployment_logs
        WHERE created_at < $1
        RETURNING id
      `, [cutoffDate]);

      const deletedCount = result.rowCount || 0;
      logger.info({ deletedCount, daysToKeep }, 'Cleaned up old deployment logs');
      return deletedCount;
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup old logs');
      return 0;
    }
  }

  /**
   * Cleanup old metrics (older than specified days)
   */
  async cleanupOldMetrics(daysToKeep: number = 30): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

      const metricsResult = await pool.query(`
        DELETE FROM performance_metrics
        WHERE recorded_at < $1
        RETURNING id
      `, [cutoffDate]);

      const healthResult = await pool.query(`
        DELETE FROM system_health_snapshots
        WHERE snapshot_time < $1
        RETURNING id
      `, [cutoffDate]);

      const totalDeleted = (metricsResult.rowCount || 0) + (healthResult.rowCount || 0);
      logger.info({ totalDeleted, daysToKeep }, 'Cleaned up old metrics');
      return totalDeleted;
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup old metrics');
      return 0;
    }
  }

  // ============ ROW MAPPERS ============

  private mapLogRow(row: any): DeploymentLog {
    return {
      id: row.id,
      severity: row.severity,
      category: row.category,
      message: row.message,
      context: row.context,
      tokenAddress: row.token_address,
      kolHandle: row.kol_handle,
      signalId: row.signal_id,
      errorStack: row.error_stack,
      createdAt: row.created_at,
    };
  }

  private mapMetricRow(row: any): PerformanceMetric {
    return {
      id: row.id,
      metricName: row.metric_name,
      metricValue: parseFloat(row.metric_value),
      metricUnit: row.metric_unit,
      tags: row.tags,
      recordedAt: row.recorded_at,
    };
  }

  private mapHealthRow(row: any): SystemHealthSnapshot {
    return {
      id: row.id,
      signalsGenerated1h: parseInt(row.signals_generated_1h) || 0,
      signalsSent1h: parseInt(row.signals_sent_1h) || 0,
      signalsFiltered1h: parseInt(row.signals_filtered_1h) || 0,
      avgSignalScore: row.avg_signal_score ? parseFloat(row.avg_signal_score) : null,
      tradesExecuted1h: parseInt(row.trades_executed_1h) || 0,
      tradeSuccessRate: row.trade_success_rate ? parseFloat(row.trade_success_rate) : null,
      avgTradeRoi: row.avg_trade_roi ? parseFloat(row.avg_trade_roi) : null,
      activeKolWallets: parseInt(row.active_kol_wallets) || 0,
      kolTradesDetected1h: parseInt(row.kol_trades_detected_1h) || 0,
      birdeyeLatencyMs: row.birdeye_latency_ms ? parseInt(row.birdeye_latency_ms) : null,
      heliusLatencyMs: row.helius_latency_ms ? parseInt(row.helius_latency_ms) : null,
      dexscreenerLatencyMs: row.dexscreener_latency_ms ? parseInt(row.dexscreener_latency_ms) : null,
      apiErrorCount1h: parseInt(row.api_error_count_1h) || 0,
      dbPoolSize: row.db_pool_size ? parseInt(row.db_pool_size) : null,
      dbActiveConnections: row.db_active_connections ? parseInt(row.db_active_connections) : null,
      dbQueryAvgMs: row.db_query_avg_ms ? parseInt(row.db_query_avg_ms) : null,
      memoryUsageMb: row.memory_usage_mb ? parseFloat(row.memory_usage_mb) : null,
      cpuUsagePercent: row.cpu_usage_percent ? parseFloat(row.cpu_usage_percent) : null,
      snapshotTime: row.snapshot_time,
    };
  }

  private mapTradeOutcomeRow(row: any): TradeOutcomeAnalysis {
    return {
      id: row.id,
      tokenAddress: row.token_address,
      tokenTicker: row.token_ticker,
      signalId: row.signal_id,
      entryPrice: row.entry_price ? parseFloat(row.entry_price) : null,
      entryMcap: row.entry_mcap ? parseFloat(row.entry_mcap) : null,
      entryLiquidity: row.entry_liquidity ? parseFloat(row.entry_liquidity) : null,
      entryHolderCount: row.entry_holder_count ? parseInt(row.entry_holder_count) : null,
      entryTokenAgeMins: row.entry_token_age_mins ? parseInt(row.entry_token_age_mins) : null,
      compositeScore: row.composite_score ? parseInt(row.composite_score) : null,
      safetyScore: row.safety_score ? parseInt(row.safety_score) : null,
      momentumScore: row.momentum_score ? parseInt(row.momentum_score) : null,
      kolHandle: row.kol_handle,
      kolTier: row.kol_tier,
      outcome: row.outcome,
      peakRoi: row.peak_roi ? parseFloat(row.peak_roi) : null,
      finalRoi: row.final_roi ? parseFloat(row.final_roi) : null,
      holdTimeHours: row.hold_time_hours ? parseFloat(row.hold_time_hours) : null,
      exitReason: row.exit_reason,
      contributingFactors: row.contributing_factors,
      warnings: row.warnings,
      analyzedAt: row.analyzed_at,
    };
  }
}

// ============ EXPORTS ============

export const deploymentLogsReader = new DeploymentLogsReader();

export default {
  DeploymentLogsReader,
  deploymentLogsReader,
};
