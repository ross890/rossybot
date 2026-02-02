// ===========================================
// MODULE: KOL PERFORMANCE ANALYTICS (Feature 7)
// Tracks and scores each KOL's historical performance
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool, Database } from '../../utils/database.js';
import type { KolPerformanceStats, Kol } from '../../types/index.js';
import { KolReputationTier } from '../../types/index.js';

// ============ CONSTANTS ============

const WIN_THRESHOLD_ROI = 100; // 2x = win (100% ROI)
const RECALCULATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Tier thresholds - SINGLE SOURCE OF TRUTH for KOL reputation
// Research shows 76% of KOL-promoted tokens fail, and most "top KOLs"
// have 5-15 second hold times (front-running). We require:
// 1. Proven win rate over minimum trades
// 2. Minimum average hold time to filter front-runners
const TIER_THRESHOLDS = {
  S_TIER_WIN_RATE: 0.50,    // 50%+ win rate (note: winRate is 0-1 in stats)
  A_TIER_WIN_RATE: 0.40,    // 40%+ win rate
  B_TIER_WIN_RATE: 0.30,    // 30%+ win rate
  MIN_TRADES: 10,           // Minimum trades to be considered (was 30, lowered for faster learning)
  MIN_HOLD_TIME_HOURS: 1,   // Minimum 1 hour avg hold time (filters front-runners)
};

// ============ KOL ANALYTICS CLASS ============

export class KolAnalytics {
  private statsCache: Map<string, { stats: KolPerformanceStats; cachedAt: number }> = new Map();

  /**
   * Get performance stats for a KOL
   */
  async getKolStats(kolId: string): Promise<KolPerformanceStats | null> {
    // Check cache
    const cached = this.statsCache.get(kolId);
    if (cached && Date.now() - cached.cachedAt < RECALCULATION_INTERVAL_MS) {
      return cached.stats;
    }

    // Calculate fresh stats
    const stats = await this.calculateKolStats(kolId);
    if (stats) {
      this.statsCache.set(kolId, { stats, cachedAt: Date.now() });
    }

    return stats;
  }

  /**
   * Calculate comprehensive performance stats for a KOL
   */
  private async calculateKolStats(kolId: string): Promise<KolPerformanceStats | null> {
    try {
      // Get KOL info
      const kol = await Database.getKolById(kolId);
      if (!kol) {
        return null;
      }

      // Get all completed trades
      const tradesResult = await pool.query(
        `SELECT * FROM kol_trades
         WHERE kol_id = $1 AND roi IS NOT NULL
         ORDER BY entry_timestamp DESC`,
        [kolId]
      );

      const trades = tradesResult.rows;

      if (trades.length === 0) {
        return this.emptyStats(kolId, kol.handle);
      }

      // Calculate basic stats
      const totalTrades = trades.length;
      const wins = trades.filter(t => parseFloat(t.roi) >= WIN_THRESHOLD_ROI).length;
      const winRate = totalTrades > 0 ? wins / totalTrades : 0;

      // Calculate average ROI
      const rois = trades.map(t => parseFloat(t.roi));
      const avgRoi = rois.reduce((a, b) => a + b, 0) / rois.length;

      // Calculate average hold time
      const holdTimes = trades
        .filter(t => t.exit_timestamp)
        .map(t => {
          const entry = new Date(t.entry_timestamp).getTime();
          const exit = new Date(t.exit_timestamp).getTime();
          return (exit - entry) / (1000 * 60 * 60); // Hours
        });
      const avgHoldTimeHours = holdTimes.length > 0
        ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length
        : 0;

      // Find best and worst trades
      const sortedByRoi = [...trades].sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi));
      const bestTrade = sortedByRoi[0];
      const worstTrade = sortedByRoi[sortedByRoi.length - 1];

      // Calculate last 7 days performance
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const recentTrades = trades.filter(t =>
        new Date(t.entry_timestamp) >= sevenDaysAgo
      );
      const last7DaysTrades = recentTrades.length;
      const last7DaysWins = recentTrades.filter(t => parseFloat(t.roi) >= WIN_THRESHOLD_ROI).length;
      const last7DaysRoi = recentTrades.length > 0
        ? recentTrades.reduce((sum, t) => sum + parseFloat(t.roi), 0) / recentTrades.length
        : 0;

      // Calculate consistency score (inverse of standard deviation)
      const variance = rois.reduce((sum, roi) => sum + Math.pow(roi - avgRoi, 2), 0) / rois.length;
      const stdDev = Math.sqrt(variance);
      // Lower std dev = more consistent, scale to 0-100
      const consistencyScore = Math.max(0, Math.min(100, 100 - stdDev / 2));

      const stats: KolPerformanceStats = {
        kolId,
        kolHandle: kol.handle,
        totalTrades,
        winRate,
        avgRoi,
        avgHoldTimeHours,
        bestTrade: bestTrade ? {
          token: bestTrade.token_address,
          ticker: bestTrade.token_ticker || '',
          roi: parseFloat(bestTrade.roi),
        } : null,
        worstTrade: worstTrade ? {
          token: worstTrade.token_address,
          ticker: worstTrade.token_ticker || '',
          roi: parseFloat(worstTrade.roi),
        } : null,
        last7DaysRoi,
        last7DaysTrades,
        last7DaysWins,
        consistencyScore,
      };

      // Save to extended performance table
      await this.saveExtendedPerformance(stats);

      return stats;
    } catch (error) {
      logger.error({ error, kolId }, 'Failed to calculate KOL stats');
      return null;
    }
  }

  /**
   * Return empty stats for a KOL with no trades
   */
  private emptyStats(kolId: string, kolHandle: string): KolPerformanceStats {
    return {
      kolId,
      kolHandle,
      totalTrades: 0,
      winRate: 0,
      avgRoi: 0,
      avgHoldTimeHours: 0,
      bestTrade: null,
      worstTrade: null,
      last7DaysRoi: 0,
      last7DaysTrades: 0,
      last7DaysWins: 0,
      consistencyScore: 50, // Neutral for unknown
    };
  }

  /**
   * Save extended performance to database
   */
  private async saveExtendedPerformance(stats: KolPerformanceStats): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO kol_extended_performance (
          kol_id, total_trades, win_rate, avg_roi, avg_hold_time_hours,
          best_trade_token, best_trade_ticker, best_trade_roi,
          worst_trade_token, worst_trade_ticker, worst_trade_roi,
          last_7d_roi, last_7d_trades, last_7d_wins,
          consistency_score, last_calculated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
        ON CONFLICT (kol_id) DO UPDATE SET
          total_trades = EXCLUDED.total_trades,
          win_rate = EXCLUDED.win_rate,
          avg_roi = EXCLUDED.avg_roi,
          avg_hold_time_hours = EXCLUDED.avg_hold_time_hours,
          best_trade_token = EXCLUDED.best_trade_token,
          best_trade_ticker = EXCLUDED.best_trade_ticker,
          best_trade_roi = EXCLUDED.best_trade_roi,
          worst_trade_token = EXCLUDED.worst_trade_token,
          worst_trade_ticker = EXCLUDED.worst_trade_ticker,
          worst_trade_roi = EXCLUDED.worst_trade_roi,
          last_7d_roi = EXCLUDED.last_7d_roi,
          last_7d_trades = EXCLUDED.last_7d_trades,
          last_7d_wins = EXCLUDED.last_7d_wins,
          consistency_score = EXCLUDED.consistency_score,
          last_calculated = NOW()`,
        [
          stats.kolId,
          stats.totalTrades,
          stats.winRate,
          stats.avgRoi,
          stats.avgHoldTimeHours,
          stats.bestTrade?.token || null,
          stats.bestTrade?.ticker || null,
          stats.bestTrade?.roi || null,
          stats.worstTrade?.token || null,
          stats.worstTrade?.ticker || null,
          stats.worstTrade?.roi || null,
          stats.last7DaysRoi,
          stats.last7DaysTrades,
          stats.last7DaysWins,
          stats.consistencyScore,
        ]
      );
    } catch (error) {
      logger.warn({ error, kolId: stats.kolId }, 'Failed to save extended performance');
    }
  }

  /**
   * Get KOL leaderboard by win rate
   */
  async getLeaderboard(limit: number = 10): Promise<KolPerformanceStats[]> {
    try {
      // First, update all KOL stats
      const kols = await Database.getAllKols();

      const allStats: KolPerformanceStats[] = [];
      for (const kol of kols) {
        const stats = await this.getKolStats(kol.id);
        if (stats && stats.totalTrades > 0) {
          allStats.push(stats);
        }
      }

      // Sort by win rate (with minimum trades requirement)
      const qualified = allStats.filter(s => s.totalTrades >= 5);
      qualified.sort((a, b) => b.winRate - a.winRate);

      return qualified.slice(0, limit);
    } catch (error) {
      logger.error({ error }, 'Failed to get leaderboard');
      return [];
    }
  }

  /**
   * Get KOLs sorted by recent performance
   */
  async getRecentTopPerformers(limit: number = 10): Promise<KolPerformanceStats[]> {
    try {
      const kols = await Database.getAllKols();

      const allStats: KolPerformanceStats[] = [];
      for (const kol of kols) {
        const stats = await this.getKolStats(kol.id);
        if (stats && stats.last7DaysTrades > 0) {
          allStats.push(stats);
        }
      }

      // Sort by 7-day ROI
      allStats.sort((a, b) => b.last7DaysRoi - a.last7DaysRoi);

      return allStats.slice(0, limit);
    } catch (error) {
      logger.error({ error }, 'Failed to get recent top performers');
      return [];
    }
  }

  /**
   * Get signal weight multiplier based on KOL performance
   */
  getSignalWeightMultiplier(stats: KolPerformanceStats): number {
    // Base multiplier of 1.0
    let multiplier = 1.0;

    // Win rate factor (higher win rate = higher weight)
    if (stats.winRate > 0.5) {
      multiplier += (stats.winRate - 0.5) * 0.5; // Up to +0.25 for 100% win rate
    }

    // Consistency factor
    if (stats.consistencyScore > 70) {
      multiplier += 0.1;
    }

    // Recent performance factor
    if (stats.last7DaysRoi > 100) {
      multiplier += 0.15;
    }

    // Penalty for poor recent performance
    if (stats.last7DaysTrades > 3 && stats.last7DaysWins === 0) {
      multiplier *= 0.8;
    }

    return Math.min(multiplier, 1.5); // Cap at 1.5x
  }

  /**
   * Format leaderboard message for Telegram
   */
  formatLeaderboardMessage(leaderboard: KolPerformanceStats[]): string {
    if (leaderboard.length === 0) {
      return 'No KOLs with sufficient trade history yet.';
    }

    let msg = '*KOL LEADERBOARD*\n\n';

    for (let i = 0; i < leaderboard.length; i++) {
      const stats = leaderboard[i];
      const medal = i === 0 ? '' : i === 1 ? '' : i === 2 ? '' : `${i + 1}.`;

      msg += `${medal} *${stats.kolHandle}*\n`;
      msg += `   Win Rate: ${(stats.winRate * 100).toFixed(1)}% (${stats.totalTrades} trades)\n`;
      msg += `   Avg ROI: ${stats.avgRoi.toFixed(0)}%\n`;
      msg += `   7d: ${stats.last7DaysWins}/${stats.last7DaysTrades} wins\n\n`;
    }

    return msg;
  }

  /**
   * Recalculate all KOL stats
   */
  async recalculateAllStats(): Promise<void> {
    logger.info('Recalculating all KOL stats');

    const kols = await Database.getAllKols();
    for (const kol of kols) {
      // Clear cache to force recalculation
      this.statsCache.delete(kol.id);
      await this.getKolStats(kol.id);
    }

    logger.info({ kolCount: kols.length }, 'KOL stats recalculation complete');
  }

  // ============ TIER DETERMINATION (Consolidated from kol-reputation.ts) ============

  /**
   * Determine tier for a KOL based on stats
   * Requires BOTH win rate AND hold time thresholds to filter front-runners
   */
  getTier(stats: KolPerformanceStats): KolReputationTier {
    // Not enough data
    if (stats.totalTrades < TIER_THRESHOLDS.MIN_TRADES) {
      return KolReputationTier.UNPROVEN;
    }

    // Front-runner check: high win rate but very short hold times
    if (stats.avgHoldTimeHours < TIER_THRESHOLDS.MIN_HOLD_TIME_HOURS) {
      logger.debug({
        kolHandle: stats.kolHandle,
        avgHoldTimeHours: stats.avgHoldTimeHours,
        minRequired: TIER_THRESHOLDS.MIN_HOLD_TIME_HOURS,
        winRate: stats.winRate,
      }, 'KOL has insufficient hold time - possible front-runner');
      return KolReputationTier.UNPROVEN;
    }

    // Tier assignment based on win rate
    if (stats.winRate >= TIER_THRESHOLDS.S_TIER_WIN_RATE) {
      return KolReputationTier.S_TIER;
    } else if (stats.winRate >= TIER_THRESHOLDS.A_TIER_WIN_RATE) {
      return KolReputationTier.A_TIER;
    } else if (stats.winRate >= TIER_THRESHOLDS.B_TIER_WIN_RATE) {
      return KolReputationTier.B_TIER;
    }

    return KolReputationTier.UNPROVEN;
  }

  /**
   * Check if a KOL is S-tier or A-tier (trusted for Early Quality track)
   * This is the SINGLE method to call for KOL trust verification
   */
  async isHighTierKol(kolId: string): Promise<{
    isTrusted: boolean;
    tier: KolReputationTier;
    stats: KolPerformanceStats | null;
  }> {
    const stats = await this.getKolStats(kolId);

    if (!stats) {
      return {
        isTrusted: false,
        tier: KolReputationTier.UNPROVEN,
        stats: null,
      };
    }

    const tier = this.getTier(stats);
    const isTrusted = tier === KolReputationTier.S_TIER || tier === KolReputationTier.A_TIER;

    return { isTrusted, tier, stats };
  }

  /**
   * Check if a KOL is trusted by handle (convenience method)
   * Looks up KOL by handle, then checks tier
   */
  async isHighTierKolByHandle(handle: string): Promise<{
    isTrusted: boolean;
    tier: KolReputationTier;
    stats: KolPerformanceStats | null;
  }> {
    try {
      // Look up KOL by handle
      const kolResult = await pool.query(
        `SELECT id FROM kols WHERE LOWER(handle) = $1`,
        [handle.toLowerCase().replace(/^@/, '')]
      );

      if (kolResult.rows.length === 0) {
        return {
          isTrusted: false,
          tier: KolReputationTier.UNPROVEN,
          stats: null,
        };
      }

      return await this.isHighTierKol(kolResult.rows[0].id);
    } catch (error) {
      logger.warn({ error, handle }, 'Failed to check KOL tier by handle');
      return {
        isTrusted: false,
        tier: KolReputationTier.UNPROVEN,
        stats: null,
      };
    }
  }

  /**
   * Get all KOLs of a specific tier
   */
  async getKolsByTier(tier: KolReputationTier): Promise<KolPerformanceStats[]> {
    const kols = await Database.getAllKols();
    const results: KolPerformanceStats[] = [];

    for (const kol of kols) {
      const stats = await this.getKolStats(kol.id);
      if (stats && this.getTier(stats) === tier) {
        results.push(stats);
      }
    }

    return results;
  }

  /**
   * Get system status for Early Quality track availability
   */
  async getEarlyQualityStatus(): Promise<{
    available: boolean;
    sTierCount: number;
    aTierCount: number;
    totalTracked: number;
  }> {
    const kols = await Database.getAllKols();
    let sTierCount = 0;
    let aTierCount = 0;

    for (const kol of kols) {
      const stats = await this.getKolStats(kol.id);
      if (stats) {
        const tier = this.getTier(stats);
        if (tier === KolReputationTier.S_TIER) sTierCount++;
        else if (tier === KolReputationTier.A_TIER) aTierCount++;
      }
    }

    const available = (sTierCount + aTierCount) > 0;

    if (!available) {
      logger.warn({
        reason: `No KOLs meet requirements (${TIER_THRESHOLDS.MIN_TRADES}+ trades, ${TIER_THRESHOLDS.A_TIER_WIN_RATE * 100}%+ win rate, ${TIER_THRESHOLDS.MIN_HOLD_TIME_HOURS}h+ avg hold)`,
        impact: 'EARLY_QUALITY track disabled - only PROVEN_RUNNER track will generate signals',
      }, 'EARLY_QUALITY track unavailable - cold start mode');
    }

    return {
      available,
      sTierCount,
      aTierCount,
      totalTracked: kols.length,
    };
  }
}

// ============ EXPORTS ============

export const kolAnalytics = new KolAnalytics();

export default {
  KolAnalytics,
  kolAnalytics,
  WIN_THRESHOLD_ROI,
  TIER_THRESHOLDS,
};
