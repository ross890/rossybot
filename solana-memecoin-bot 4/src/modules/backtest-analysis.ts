// ===========================================
// BACKTEST & CONVERSION ANALYSIS (Task D)
// Analyzes token_tracking data to compute base rates
// ===========================================

import { pool } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { twoXProbabilityEngine } from './two-x-probability.js';

// ============ TYPES ============

export interface ConversionStats {
  totalTokensAt50k: number;
  tokensHit100k: number;
  conversionPct: number;
  timeDistribution: {
    p25Minutes: number | null;
    medianMinutes: number | null;
    p75Minutes: number | null;
  };
  byDevScore: Array<{
    devScore: string;
    total: number;
    hit100k: number;
    conversionPct: number;
  }>;
  byRugCheckScore: Array<{
    rugCheckScore: string;
    total: number;
    hit100k: number;
    conversionPct: number;
  }>;
  byHolderBracket: Array<{
    bracket: string;
    total: number;
    hit100k: number;
    conversionPct: number;
  }>;
  byLiquidityBracket: Array<{
    bracket: string;
    total: number;
    hit100k: number;
    conversionPct: number;
  }>;
  dataCollectionHours: number;
  lastUpdated: string;
}

// ============ ANALYSIS CLASS ============

class BacktestAnalysis {
  /**
   * Run the full backtest analysis suite and return structured results
   */
  async runAnalysis(): Promise<ConversionStats> {
    logger.info('Running backtest conversion analysis...');

    const [
      baseRate,
      timeDistribution,
      byDevScore,
      byRugCheckScore,
      byHolderBracket,
      byLiquidityBracket,
      collectionHours,
    ] = await Promise.all([
      this.getBaseConversionRate(),
      this.getTimeDistribution(),
      this.getConversionByDevScore(),
      this.getConversionByRugCheckScore(),
      this.getConversionByHolderBracket(),
      this.getConversionByLiquidityBracket(),
      this.getDataCollectionHours(),
    ]);

    const stats: ConversionStats = {
      totalTokensAt50k: baseRate.total,
      tokensHit100k: baseRate.hit100k,
      conversionPct: baseRate.pct,
      timeDistribution,
      byDevScore,
      byRugCheckScore,
      byHolderBracket,
      byLiquidityBracket,
      dataCollectionHours: collectionHours,
      lastUpdated: new Date().toISOString(),
    };

    // Auto-update base rate if we have enough data (100+ tokens)
    if (baseRate.total >= 100) {
      const newRate = baseRate.pct / 100;
      await twoXProbabilityEngine.updateBaseRate(newRate);
      logger.info({
        tokens: baseRate.total,
        conversionRate: baseRate.pct + '%',
      }, 'Auto-updated base rate from backtest data');
    }

    logger.info({
      tokens: baseRate.total,
      hit100k: baseRate.hit100k,
      conversionRate: baseRate.pct + '%',
      hours: collectionHours,
    }, 'Backtest analysis complete');

    return stats;
  }

  /**
   * Base conversion rate: % of tokens that hit $50k MC and went on to hit $100k
   */
  private async getBaseConversionRate(): Promise<{ total: number; hit100k: number; pct: number }> {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*) as total_tokens_at_50k,
          COUNT(*) FILTER (WHERE hit_100k = TRUE) as tokens_hit_100k,
          ROUND(
            COALESCE(
              COUNT(*) FILTER (WHERE hit_100k = TRUE)::NUMERIC / NULLIF(COUNT(*), 0) * 100,
              0
            ), 1
          ) as conversion_pct
        FROM token_tracking
        WHERE first_50k_timestamp IS NOT NULL
      `);

      const row = result.rows[0];
      return {
        total: Number(row.total_tokens_at_50k) || 0,
        hit100k: Number(row.tokens_hit_100k) || 0,
        pct: Number(row.conversion_pct) || 0,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get base conversion rate');
      return { total: 0, hit100k: 0, pct: 0 };
    }
  }

  /**
   * Time distribution: how quickly tokens convert from $50k → $100k
   */
  private async getTimeDistribution(): Promise<{
    p25Minutes: number | null;
    medianMinutes: number | null;
    p75Minutes: number | null;
  }> {
    try {
      const result = await pool.query(`
        SELECT
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY time_50k_to_100k_minutes) as p25_minutes,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY time_50k_to_100k_minutes) as median_minutes,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY time_50k_to_100k_minutes) as p75_minutes
        FROM token_tracking
        WHERE hit_100k = TRUE AND time_50k_to_100k_minutes IS NOT NULL
      `);

      const row = result.rows[0];
      return {
        p25Minutes: row.p25_minutes !== null ? Math.round(Number(row.p25_minutes)) : null,
        medianMinutes: row.median_minutes !== null ? Math.round(Number(row.median_minutes)) : null,
        p75Minutes: row.p75_minutes !== null ? Math.round(Number(row.p75_minutes)) : null,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get time distribution');
      return { p25Minutes: null, medianMinutes: null, p75Minutes: null };
    }
  }

  /**
   * Conversion rate breakdown by dev score
   */
  private async getConversionByDevScore(): Promise<Array<{
    devScore: string;
    total: number;
    hit100k: number;
    conversionPct: number;
  }>> {
    try {
      const result = await pool.query(`
        SELECT
          COALESCE(dev_score, 'UNKNOWN') as dev_score,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE hit_100k = TRUE) as hit_100k,
          ROUND(
            COALESCE(
              COUNT(*) FILTER (WHERE hit_100k = TRUE)::NUMERIC / NULLIF(COUNT(*), 0) * 100,
              0
            ), 1
          ) as conversion_pct
        FROM token_tracking
        WHERE first_50k_timestamp IS NOT NULL
        GROUP BY dev_score
        ORDER BY total DESC
      `);

      return result.rows.map(row => ({
        devScore: row.dev_score,
        total: Number(row.total),
        hit100k: Number(row.hit_100k),
        conversionPct: Number(row.conversion_pct),
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get conversion by dev score');
      return [];
    }
  }

  /**
   * Conversion rate breakdown by RugCheck score
   */
  private async getConversionByRugCheckScore(): Promise<Array<{
    rugCheckScore: string;
    total: number;
    hit100k: number;
    conversionPct: number;
  }>> {
    try {
      const result = await pool.query(`
        SELECT
          COALESCE(rugcheck_score, 'UNKNOWN') as rugcheck_score,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE hit_100k = TRUE) as hit_100k,
          ROUND(
            COALESCE(
              COUNT(*) FILTER (WHERE hit_100k = TRUE)::NUMERIC / NULLIF(COUNT(*), 0) * 100,
              0
            ), 1
          ) as conversion_pct
        FROM token_tracking
        WHERE first_50k_timestamp IS NOT NULL
        GROUP BY rugcheck_score
        ORDER BY total DESC
      `);

      return result.rows.map(row => ({
        rugCheckScore: row.rugcheck_score,
        total: Number(row.total),
        hit100k: Number(row.hit_100k),
        conversionPct: Number(row.conversion_pct),
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get conversion by rug check score');
      return [];
    }
  }

  /**
   * Conversion rate by holder count bracket at $50k
   */
  private async getConversionByHolderBracket(): Promise<Array<{
    bracket: string;
    total: number;
    hit100k: number;
    conversionPct: number;
  }>> {
    try {
      const result = await pool.query(`
        SELECT
          CASE
            WHEN holders_at_50k < 200 THEN '<200'
            WHEN holders_at_50k < 500 THEN '200-500'
            WHEN holders_at_50k < 1000 THEN '500-1000'
            ELSE '1000+'
          END as holder_bracket,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE hit_100k = TRUE) as hit_100k,
          ROUND(
            COALESCE(
              COUNT(*) FILTER (WHERE hit_100k = TRUE)::NUMERIC / NULLIF(COUNT(*), 0) * 100,
              0
            ), 1
          ) as conversion_pct
        FROM token_tracking
        WHERE first_50k_timestamp IS NOT NULL AND holders_at_50k IS NOT NULL
        GROUP BY 1 ORDER BY 1
      `);

      return result.rows.map(row => ({
        bracket: row.holder_bracket,
        total: Number(row.total),
        hit100k: Number(row.hit_100k),
        conversionPct: Number(row.conversion_pct),
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get conversion by holder bracket');
      return [];
    }
  }

  /**
   * Conversion rate by liquidity bracket at $50k
   */
  private async getConversionByLiquidityBracket(): Promise<Array<{
    bracket: string;
    total: number;
    hit100k: number;
    conversionPct: number;
  }>> {
    try {
      const result = await pool.query(`
        SELECT
          CASE
            WHEN liquidity_at_50k < 15000 THEN '<$15k'
            WHEN liquidity_at_50k < 25000 THEN '$15k-$25k'
            WHEN liquidity_at_50k < 50000 THEN '$25k-$50k'
            ELSE '$50k+'
          END as liq_bracket,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE hit_100k = TRUE) as hit_100k,
          ROUND(
            COALESCE(
              COUNT(*) FILTER (WHERE hit_100k = TRUE)::NUMERIC / NULLIF(COUNT(*), 0) * 100,
              0
            ), 1
          ) as conversion_pct
        FROM token_tracking
        WHERE first_50k_timestamp IS NOT NULL AND liquidity_at_50k IS NOT NULL
        GROUP BY 1 ORDER BY 1
      `);

      return result.rows.map(row => ({
        bracket: row.liq_bracket,
        total: Number(row.total),
        hit100k: Number(row.hit_100k),
        conversionPct: Number(row.conversion_pct),
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get conversion by liquidity bracket');
      return [];
    }
  }

  /**
   * Get how many hours we've been collecting data
   */
  private async getDataCollectionHours(): Promise<number> {
    try {
      const result = await pool.query(`
        SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 3600 as hours
        FROM token_tracking
        WHERE first_50k_timestamp IS NOT NULL
      `);

      return Math.round(Number(result.rows[0]?.hours) || 0);
    } catch (error) {
      return 0;
    }
  }

  /**
   * Format analysis results as a Telegram-friendly string
   */
  formatForTelegram(stats: ConversionStats): string {
    const lines: string[] = [];

    lines.push('📊 ROSSYBOT BACKTEST ANALYSIS');
    lines.push('');
    lines.push(`📈 Base Conversion Rate ($50k → $100k)`);
    lines.push(`├─ Total tokens tracked: ${stats.totalTokensAt50k}`);
    lines.push(`├─ Hit $100k: ${stats.tokensHit100k}`);
    lines.push(`└─ Conversion: ${stats.conversionPct}%`);
    lines.push('');

    if (stats.timeDistribution.medianMinutes !== null) {
      lines.push('⏱️ Time to 2x (for tokens that converted)');
      lines.push(`├─ 25th percentile: ${stats.timeDistribution.p25Minutes} min`);
      lines.push(`├─ Median: ${stats.timeDistribution.medianMinutes} min`);
      lines.push(`└─ 75th percentile: ${stats.timeDistribution.p75Minutes} min`);
      lines.push('');
    }

    if (stats.byDevScore.length > 0) {
      lines.push('👨‍💻 By Dev Score');
      for (const row of stats.byDevScore) {
        lines.push(`├─ ${row.devScore}: ${row.conversionPct}% (${row.hit100k}/${row.total})`);
      }
      lines.push('');
    }

    if (stats.byRugCheckScore.length > 0) {
      lines.push('🛡️ By RugCheck');
      for (const row of stats.byRugCheckScore) {
        lines.push(`├─ ${row.rugCheckScore}: ${row.conversionPct}% (${row.hit100k}/${row.total})`);
      }
      lines.push('');
    }

    if (stats.byHolderBracket.length > 0) {
      lines.push('👥 By Holder Count at $50k');
      for (const row of stats.byHolderBracket) {
        lines.push(`├─ ${row.bracket}: ${row.conversionPct}% (${row.hit100k}/${row.total})`);
      }
      lines.push('');
    }

    if (stats.byLiquidityBracket.length > 0) {
      lines.push('💧 By Liquidity at $50k');
      for (const row of stats.byLiquidityBracket) {
        lines.push(`├─ ${row.bracket}: ${row.conversionPct}% (${row.hit100k}/${row.total})`);
      }
      lines.push('');
    }

    lines.push(`📅 Data collection: ${stats.dataCollectionHours}h`);
    lines.push(`🕐 Last updated: ${new Date(stats.lastUpdated).toUTCString()}`);

    if (stats.totalTokensAt50k < 100) {
      lines.push('');
      lines.push(`⚠️ Need ${100 - stats.totalTokensAt50k} more tokens for reliable base rate`);
    }

    return lines.join('\n');
  }
}

// ============ EXPORTS ============

export const backtestAnalysis = new BacktestAnalysis();
