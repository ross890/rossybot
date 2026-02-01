// ===========================================
// KOL REENTRY DETECTOR
// Detects when KOLs return to or enter mature tokens
// ===========================================

import { logger } from '../../utils/logger.js';
import { Database } from '../../utils/database.js';
import { kolWalletMonitor } from '../kol-tracker.js';
import { kolAnalytics } from '../kol/kol-analytics.js';
import { KolReentryMetrics, KOL_REENTRY_THRESHOLDS } from './types.js';

// ============ CONSTANTS ============

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const KOL_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ============ CLASS ============

export class KolReentryDetector {
  private cache: Map<string, { metrics: KolReentryMetrics; timestamp: number }> = new Map();

  /**
   * Analyze KOL activity for a mature token
   */
  async analyze(tokenAddress: string, currentPrice: number): Promise<KolReentryMetrics> {
    // Check cache
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.metrics;
    }

    try {
      const [activityData, qualityData, timingData, socialData] = await Promise.all([
        this.getActivityMetrics(tokenAddress),
        this.getKolQualityMetrics(tokenAddress),
        this.getTimingMetrics(tokenAddress, currentPrice),
        this.getSocialMetrics(tokenAddress),
      ]);

      const metrics: KolReentryMetrics = {
        ...activityData,
        ...qualityData,
        ...timingData,
        ...socialData,
        kolActivityScore: 0,
      };

      metrics.kolActivityScore = this.calculateScore(metrics);

      // Cache result
      this.cache.set(tokenAddress, { metrics, timestamp: Date.now() });

      logger.debug({
        tokenAddress: tokenAddress.slice(0, 8),
        score: metrics.kolActivityScore,
        kolBuys24h: metrics.kolBuys24h,
      }, 'KOL reentry analysis complete');

      return metrics;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to analyze KOL activity');
      return this.getDefaultMetrics();
    }
  }

  /**
   * Get KOL activity metrics
   */
  private async getActivityMetrics(tokenAddress: string): Promise<{
    kolBuys24h: number;
    kolBuys7d: number;
    kolTotalHolding: number;
    kolHoldingChange: number;
  }> {
    try {
      // Get KOL activities from tracker
      const activities24h = await kolWalletMonitor.getKolActivityForToken(
        tokenAddress,
        24 * 60 * 60 * 1000 // 24 hours
      );

      const activities7d = await kolWalletMonitor.getKolActivityForToken(
        tokenAddress,
        KOL_ACTIVITY_WINDOW_MS // 7 days
      );

      // Count unique KOL buys
      const uniqueKols24h = new Set(activities24h.map(a => a.kol.id));
      const uniqueKols7d = new Set(activities7d.map(a => a.kol.id));

      // Calculate total KOL holdings (sum of all KOL positions)
      const kolTotalHolding = activities7d.reduce((sum, a) =>
        sum + (a.transaction?.tokensAcquired || 0), 0);

      // Holding change (positive = accumulation)
      const recentHolding = activities24h.reduce((sum, a) =>
        sum + (a.transaction?.tokensAcquired || 0), 0);
      const kolHoldingChange = kolTotalHolding > 0
        ? (recentHolding / kolTotalHolding) * 100
        : 0;

      return {
        kolBuys24h: uniqueKols24h.size,
        kolBuys7d: uniqueKols7d.size,
        kolTotalHolding,
        kolHoldingChange,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get activity metrics');
      return {
        kolBuys24h: 0,
        kolBuys7d: 0,
        kolTotalHolding: 0,
        kolHoldingChange: 0,
      };
    }
  }

  /**
   * Get KOL quality metrics
   */
  private async getKolQualityMetrics(tokenAddress: string): Promise<{
    tier1KolCount: number;
    tier2KolCount: number;
    tier3KolCount: number;
    avgKolWinRate: number;
    kolConvictionScore: number;
  }> {
    try {
      const activities = await kolWalletMonitor.getKolActivityForToken(
        tokenAddress,
        KOL_ACTIVITY_WINDOW_MS
      );

      if (activities.length === 0) {
        return this.getDefaultQualityMetrics();
      }

      // Count by tier
      let tier1 = 0, tier2 = 0, tier3 = 0;
      const kolIds = new Set<string>();
      const winRates: number[] = [];

      for (const activity of activities) {
        if (kolIds.has(activity.kol.id)) continue;
        kolIds.add(activity.kol.id);

        // Tier classification
        if (activity.kol.tier === 'TIER_1') tier1++;
        else if (activity.kol.tier === 'TIER_2') tier2++;
        else tier3++;

        // Get KOL performance
        try {
          const stats = await kolAnalytics.getKolStats(activity.kol.id);
          if (stats) {
            winRates.push(stats.winRate);
          }
        } catch {
          // Skip if can't get stats
        }
      }

      const avgKolWinRate = winRates.length > 0
        ? winRates.reduce((sum, r) => sum + r, 0) / winRates.length
        : 0.5;

      // Conviction score based on KOL tier and count
      const convictionScore = Math.min(100,
        (tier1 * 30) + (tier2 * 20) + (tier3 * 10)
      );

      return {
        tier1KolCount: tier1,
        tier2KolCount: tier2,
        tier3KolCount: tier3,
        avgKolWinRate,
        kolConvictionScore: convictionScore,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get quality metrics');
      return this.getDefaultQualityMetrics();
    }
  }

  /**
   * Get timing analysis metrics
   */
  private async getTimingMetrics(tokenAddress: string, currentPrice: number): Promise<{
    kolEntryTiming: 'EARLY' | 'MIDDLE' | 'LATE';
    kolAvgEntryPrice: number;
    currentVsKolEntry: number;
  }> {
    try {
      const activities = await kolWalletMonitor.getKolActivityForToken(
        tokenAddress,
        KOL_ACTIVITY_WINDOW_MS
      );

      if (activities.length === 0 || currentPrice === 0) {
        return {
          kolEntryTiming: 'MIDDLE',
          kolAvgEntryPrice: currentPrice,
          currentVsKolEntry: 1,
        };
      }

      // Calculate average entry price
      // Would need to get actual entry prices from transactions
      // For now, estimate from timing
      const avgEntryTime = activities.reduce((sum, a) =>
        sum + a.transaction.timestamp.getTime(), 0) / activities.length;
      const now = Date.now();
      const timeSinceAvgEntry = now - avgEntryTime;

      // Estimate entry price (rough - would need historical data)
      // Assume KOLs entered at similar prices to current
      const kolAvgEntryPrice = currentPrice * 0.9; // Assume 10% profit on average

      const currentVsKolEntry = kolAvgEntryPrice > 0
        ? currentPrice / kolAvgEntryPrice
        : 1;

      // Timing classification
      let kolEntryTiming: 'EARLY' | 'MIDDLE' | 'LATE' = 'MIDDLE';
      if (timeSinceAvgEntry < 24 * 60 * 60 * 1000) { // Within 24h
        kolEntryTiming = 'EARLY';
      } else if (timeSinceAvgEntry > 3 * 24 * 60 * 60 * 1000) { // > 3 days ago
        kolEntryTiming = 'LATE';
      }

      return {
        kolEntryTiming,
        kolAvgEntryPrice,
        currentVsKolEntry,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get timing metrics');
      return {
        kolEntryTiming: 'MIDDLE',
        kolAvgEntryPrice: currentPrice,
        currentVsKolEntry: 1,
      };
    }
  }

  /**
   * Get social amplification metrics
   */
  private async getSocialMetrics(tokenAddress: string): Promise<{
    kolMentions24h: number;
    kolSentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
    kolEngagementRate: number;
  }> {
    // Social metrics would come from Twitter API
    // For now, estimate from KOL activity
    try {
      const activities = await kolWalletMonitor.getKolActivityForToken(
        tokenAddress,
        24 * 60 * 60 * 1000
      );

      // Estimate mentions from buys (assume each KOL buy = 1 mention)
      const kolMentions24h = activities.length;

      // Sentiment from buy/sell ratio
      const buys = activities.filter(a => a.transaction.solAmount > 0).length;
      const kolSentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH' =
        buys >= activities.length * 0.7 ? 'BULLISH' :
        buys >= activities.length * 0.3 ? 'NEUTRAL' : 'BEARISH';

      // Engagement rate (placeholder)
      const kolEngagementRate = activities.length > 0 ? 0.05 : 0;

      return {
        kolMentions24h,
        kolSentiment,
        kolEngagementRate,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get social metrics');
      return {
        kolMentions24h: 0,
        kolSentiment: 'NEUTRAL',
        kolEngagementRate: 0,
      };
    }
  }

  /**
   * Calculate KOL activity score
   */
  private calculateScore(metrics: KolReentryMetrics): number {
    let score = 0;

    // KOL Buys 24h Score (0-25)
    if (metrics.kolBuys24h >= 3) score += 25;
    else if (metrics.kolBuys24h >= 2) score += 20;
    else if (metrics.kolBuys24h >= 1) score += 12;

    // Tier 1 KOL Bonus (0-25)
    if (metrics.tier1KolCount >= 2) score += 25;
    else if (metrics.tier1KolCount >= 1) score += 18;

    // Tier 2 KOL Score (0-15)
    if (metrics.tier2KolCount >= 3) score += 15;
    else if (metrics.tier2KolCount >= 2) score += 10;
    else if (metrics.tier2KolCount >= 1) score += 5;

    // KOL Win Rate Score (0-15)
    if (metrics.avgKolWinRate >= 0.7) score += 15;
    else if (metrics.avgKolWinRate >= 0.6) score += 12;
    else if (metrics.avgKolWinRate >= 0.55) score += 8;
    else if (metrics.avgKolWinRate >= 0.5) score += 4;

    // Conviction Score (0-10)
    if (metrics.kolConvictionScore >= 70) score += 10;
    else if (metrics.kolConvictionScore >= 50) score += 7;
    else if (metrics.kolConvictionScore >= 30) score += 4;

    // Entry Timing Score (0-10)
    if (metrics.currentVsKolEntry <= 1.1) score += 10; // Within 10% of KOL entry
    else if (metrics.currentVsKolEntry <= 1.2) score += 7;
    else if (metrics.currentVsKolEntry <= 1.5) score += 4;

    return Math.min(100, score);
  }

  /**
   * Check if there's significant KOL interest
   */
  hasKolInterest(metrics: KolReentryMetrics): boolean {
    return (
      metrics.kolActivityScore >= 30 &&
      (metrics.kolBuys24h >= 1 || metrics.kolBuys7d >= 2)
    );
  }

  /**
   * Check if this is a strong KOL signal
   */
  isStrongKolSignal(metrics: KolReentryMetrics): boolean {
    return (
      metrics.kolActivityScore >= 60 &&
      metrics.tier1KolCount >= KOL_REENTRY_THRESHOLDS.tier1KolCount.min &&
      metrics.avgKolWinRate >= KOL_REENTRY_THRESHOLDS.avgKolWinRate.min
    );
  }

  /**
   * Get default metrics
   */
  private getDefaultMetrics(): KolReentryMetrics {
    return {
      kolBuys24h: 0,
      kolBuys7d: 0,
      kolTotalHolding: 0,
      kolHoldingChange: 0,
      tier1KolCount: 0,
      tier2KolCount: 0,
      tier3KolCount: 0,
      avgKolWinRate: 0.5,
      kolConvictionScore: 0,
      kolEntryTiming: 'MIDDLE',
      kolAvgEntryPrice: 0,
      currentVsKolEntry: 1,
      kolMentions24h: 0,
      kolSentiment: 'NEUTRAL',
      kolEngagementRate: 0,
      kolActivityScore: 0,
    };
  }

  private getDefaultQualityMetrics() {
    return {
      tier1KolCount: 0,
      tier2KolCount: 0,
      tier3KolCount: 0,
      avgKolWinRate: 0.5,
      kolConvictionScore: 0,
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// ============ EXPORTS ============

export const kolReentryDetector = new KolReentryDetector();

export default {
  KolReentryDetector,
  kolReentryDetector,
};
