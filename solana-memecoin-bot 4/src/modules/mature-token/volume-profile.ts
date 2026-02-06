// ===========================================
// VOLUME PROFILE ANALYZER
// Deep volume pattern analysis for mature tokens
// ===========================================

import { logger } from '../../utils/logger.js';
import { dexScreenerClient } from '../onchain.js';
import { VolumeProfileMetrics, VolumeTrend, VOLUME_THRESHOLDS } from './types.js';

// ============ CONSTANTS ============

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

// ============ CLASS ============

export class VolumeProfileAnalyzer {
  private cache: Map<string, { metrics: VolumeProfileMetrics; timestamp: number }> = new Map();

  /**
   * Analyze volume profile for a mature token
   */
  async analyze(tokenAddress: string): Promise<VolumeProfileMetrics> {
    // Check cache
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.metrics;
    }

    try {
      const [patternData, tradeData, authenticityData, distributionData] = await Promise.all([
        this.getVolumePatterns(tokenAddress),
        this.getTradeAnalysis(tokenAddress),
        this.getAuthenticityMetrics(tokenAddress),
        this.getTimeDistribution(tokenAddress),
      ]);

      const metrics: VolumeProfileMetrics = {
        ...patternData,
        ...tradeData,
        ...authenticityData,
        ...distributionData,
        volumeAuthenticityScore: 0,
      };

      metrics.volumeAuthenticityScore = this.calculateScore(metrics);

      // Cache result
      this.cache.set(tokenAddress, { metrics, timestamp: Date.now() });

      logger.debug({
        tokenAddress: tokenAddress.slice(0, 8),
        score: metrics.volumeAuthenticityScore,
        trend: metrics.volumeTrend7d,
      }, 'Volume profile analysis complete');

      return metrics;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to analyze volume profile');
      return this.getDefaultMetrics();
    }
  }

  /**
   * Get volume patterns
   */
  private async getVolumePatterns(tokenAddress: string): Promise<{
    volumeTrend7d: VolumeTrend;
    volumeSpikes24h: number;
    avgSpikeMultiplier: number;
    volumeAtKeyLevels: number;
  }> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return this.getDefaultPatternData();
      }

      const pair = pairs[0] as any;

      // Volume data
      const vol24h = pair.volume?.h24 || 0;
      const vol6h = pair.volume?.h6 || vol24h / 4;
      const vol1h = pair.volume?.h1 || vol24h / 24;

      // Estimate 7d trend from 24h pattern
      const avgVol1h = vol24h / 24;
      const recentRate = vol1h;

      let volumeTrend7d: VolumeTrend;
      if (recentRate > avgVol1h * 1.3) {
        volumeTrend7d = VolumeTrend.INCREASING;
      } else if (recentRate < avgVol1h * 0.7) {
        volumeTrend7d = VolumeTrend.DECLINING;
      } else {
        volumeTrend7d = VolumeTrend.STABLE;
      }

      // Volume spikes (count significant increases)
      const spikeThreshold = avgVol1h * 2;
      const volumeSpikes24h = vol1h > spikeThreshold ? 1 : 0;

      // Average spike multiplier
      const avgSpikeMultiplier = avgVol1h > 0 ? vol1h / avgVol1h : 1;

      // Volume at key levels (would need order book data)
      const volumeAtKeyLevels = vol24h > 100000 ? 80 : vol24h > 50000 ? 60 : vol24h > 20000 ? 40 : 20;

      return {
        volumeTrend7d,
        volumeSpikes24h,
        avgSpikeMultiplier,
        volumeAtKeyLevels,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get volume patterns');
      return this.getDefaultPatternData();
    }
  }

  /**
   * Get trade analysis
   */
  private async getTradeAnalysis(tokenAddress: string): Promise<{
    avgTradeSize: number;
    medianTradeSize: number;
    largeTradeRatio: number;
    microTradeRatio: number;
  }> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return this.getDefaultTradeData();
      }

      const pair = pairs[0] as any;

      const vol24h = pair.volume?.h24 || 0;
      const buys = pair.txns?.h24?.buys || 0;
      const sells = pair.txns?.h24?.sells || 0;
      const totalTxns = buys + sells;

      // Average trade size
      const avgTradeSize = totalTxns > 0 ? vol24h / totalTxns : 0;

      // Median estimate (typically 60-70% of average for crypto)
      const medianTradeSize = avgTradeSize * 0.65;

      // Large trade ratio (trades > 2x median)
      // Estimate from volume distribution
      const largeTradeRatio = avgTradeSize > 500 ? 0.2 : avgTradeSize > 200 ? 0.15 : 0.1;

      // Micro trade ratio (trades < $50, often bots)
      // Higher ratio = more bot activity
      const microTradeRatio = avgTradeSize < 100 ? 0.6 : avgTradeSize < 200 ? 0.4 : 0.25;

      return {
        avgTradeSize,
        medianTradeSize,
        largeTradeRatio,
        microTradeRatio,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get trade analysis');
      return this.getDefaultTradeData();
    }
  }

  /**
   * Get volume authenticity metrics
   */
  private async getAuthenticityMetrics(tokenAddress: string): Promise<{
    organicVolumeRatio: number;
    washTradingScore: number;
    botActivityScore: number;
  }> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return this.getDefaultAuthenticityData();
      }

      const pair = pairs[0] as any;

      const buys = pair.txns?.h24?.buys || 0;
      const sells = pair.txns?.h24?.sells || 0;
      const vol24h = pair.volume?.h24 || 0;
      const liquidity = pair.liquidity?.usd || 1;

      // Volume to liquidity ratio (high ratio = suspicious)
      const volLiqRatio = vol24h / liquidity;

      // Organic volume estimation
      // Based on typical patterns: healthy tokens have 0.5-3x vol/liq ratio
      let organicVolumeRatio = 0.7;
      if (volLiqRatio > 10) {
        organicVolumeRatio = 0.3; // Very suspicious
      } else if (volLiqRatio > 5) {
        organicVolumeRatio = 0.5;
      } else if (volLiqRatio < 0.5) {
        organicVolumeRatio = 0.8; // Low volume but likely organic
      }

      // Wash trading detection
      // Signs: perfectly balanced buys/sells, repeated patterns
      const buysSellRatio = sells > 0 ? buys / sells : buys > 0 ? 2 : 1;
      const isBalanced = buysSellRatio > 0.9 && buysSellRatio < 1.1;

      let washTradingScore = 20; // Base score
      if (isBalanced && volLiqRatio > 5) {
        washTradingScore = 60; // Suspicious balance with high volume
      } else if (volLiqRatio > 10) {
        washTradingScore = 50;
      } else if (isBalanced) {
        washTradingScore = 30;
      }

      // Bot activity score
      // High transaction count with low average size = bots
      const totalTxns = buys + sells;
      const avgSize = totalTxns > 0 ? vol24h / totalTxns : 0;

      let botActivityScore = 30; // Base
      if (avgSize < 50 && totalTxns > 100) {
        botActivityScore = 70; // Lots of small trades
      } else if (avgSize < 100 && totalTxns > 200) {
        botActivityScore = 60;
      } else if (avgSize > 500) {
        botActivityScore = 20; // Larger trades = less bots
      }

      return {
        organicVolumeRatio,
        washTradingScore,
        botActivityScore,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get authenticity metrics');
      return this.getDefaultAuthenticityData();
    }
  }

  /**
   * Get time distribution of volume
   */
  private async getTimeDistribution(tokenAddress: string): Promise<{
    volumeByHour: number[];
    peakTradingHours: number[];
    volumeConsistency: number;
  }> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return this.getDefaultDistributionData();
      }

      const pair = pairs[0] as any;

      // We don't have hourly breakdown from DexScreener
      // Estimate from available data
      const vol24h = pair.volume?.h24 || 0;
      const vol6h = pair.volume?.h6 || vol24h / 4;
      const vol1h = pair.volume?.h1 || vol24h / 24;

      // Create estimated hourly distribution
      const avgHourly = vol24h / 24;
      const volumeByHour = Array(24).fill(avgHourly);

      // Peak hours estimation based on recent activity
      const recentMultiplier = avgHourly > 0 ? vol1h / avgHourly : 1;
      const currentHour = new Date().getUTCHours();
      volumeByHour[currentHour] = vol1h;

      // Peak trading hours (typically during US/EU market hours)
      const peakTradingHours = [14, 15, 16, 17, 18, 19, 20]; // UTC

      // Volume consistency (how stable is volume)
      // Based on recent vs average
      const variance = Math.abs(recentMultiplier - 1);
      const volumeConsistency = Math.max(0, Math.min(1, 1 - variance));

      return {
        volumeByHour,
        peakTradingHours,
        volumeConsistency,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get time distribution');
      return this.getDefaultDistributionData();
    }
  }

  /**
   * Calculate volume authenticity score
   */
  private calculateScore(metrics: VolumeProfileMetrics): number {
    let score = 0;

    // Volume Trend Score (0-20)
    if (metrics.volumeTrend7d === VolumeTrend.INCREASING) score += 20;
    else if (metrics.volumeTrend7d === VolumeTrend.STABLE) score += 12;
    else score += 5;

    // Organic Volume Ratio Score (0-25)
    if (metrics.organicVolumeRatio >= 0.8) score += 25;
    else if (metrics.organicVolumeRatio >= 0.7) score += 20;
    else if (metrics.organicVolumeRatio >= 0.6) score += 15;
    else if (metrics.organicVolumeRatio >= 0.5) score += 10;
    else if (metrics.organicVolumeRatio >= 0.4) score += 5;

    // Wash Trading Score (0-20, inverted - lower is better)
    if (metrics.washTradingScore <= 20) score += 20;
    else if (metrics.washTradingScore <= 30) score += 15;
    else if (metrics.washTradingScore <= 40) score += 10;
    else if (metrics.washTradingScore <= 50) score += 5;

    // Bot Activity Score (0-15, inverted - lower is better)
    if (metrics.botActivityScore <= 30) score += 15;
    else if (metrics.botActivityScore <= 40) score += 12;
    else if (metrics.botActivityScore <= 50) score += 8;
    else if (metrics.botActivityScore <= 60) score += 4;

    // Large Trade Ratio Score (0-10)
    if (metrics.largeTradeRatio >= 0.25) score += 10;
    else if (metrics.largeTradeRatio >= 0.2) score += 8;
    else if (metrics.largeTradeRatio >= 0.15) score += 6;
    else if (metrics.largeTradeRatio >= 0.1) score += 4;

    // Volume Consistency Score (0-10)
    if (metrics.volumeConsistency >= 0.7) score += 10;
    else if (metrics.volumeConsistency >= 0.5) score += 7;
    else if (metrics.volumeConsistency >= 0.4) score += 4;

    return Math.min(100, score);
  }

  /**
   * Check if volume is authentic
   */
  isAuthenticVolume(metrics: VolumeProfileMetrics): boolean {
    return (
      metrics.volumeAuthenticityScore >= 50 &&
      metrics.organicVolumeRatio >= VOLUME_THRESHOLDS.organicVolumeRatio.min &&
      metrics.washTradingScore <= VOLUME_THRESHOLDS.washTradingScore.max
    );
  }

  /**
   * Check if volume is healthy
   */
  isHealthyVolume(metrics: VolumeProfileMetrics): boolean {
    return (
      metrics.volumeTrend7d !== VolumeTrend.DECLINING &&
      metrics.botActivityScore <= VOLUME_THRESHOLDS.botActivityScore.max &&
      metrics.volumeConsistency >= VOLUME_THRESHOLDS.volumeConsistency.min
    );
  }

  /**
   * Get default metrics
   */
  private getDefaultMetrics(): VolumeProfileMetrics {
    return {
      volumeTrend7d: VolumeTrend.STABLE,
      volumeSpikes24h: 0,
      avgSpikeMultiplier: 1,
      volumeAtKeyLevels: 50,
      avgTradeSize: 0,
      medianTradeSize: 0,
      largeTradeRatio: 0.1,
      microTradeRatio: 0.3,
      organicVolumeRatio: 0.5,
      washTradingScore: 30,
      botActivityScore: 40,
      volumeByHour: Array(24).fill(0),
      peakTradingHours: [14, 15, 16],
      volumeConsistency: 0.5,
      volumeAuthenticityScore: 0,
    };
  }

  private getDefaultPatternData() {
    return {
      volumeTrend7d: VolumeTrend.STABLE,
      volumeSpikes24h: 0,
      avgSpikeMultiplier: 1,
      volumeAtKeyLevels: 50,
    };
  }

  private getDefaultTradeData() {
    return {
      avgTradeSize: 0,
      medianTradeSize: 0,
      largeTradeRatio: 0.1,
      microTradeRatio: 0.3,
    };
  }

  private getDefaultAuthenticityData() {
    return {
      organicVolumeRatio: 0.5,
      washTradingScore: 30,
      botActivityScore: 40,
    };
  }

  private getDefaultDistributionData() {
    return {
      volumeByHour: Array(24).fill(0),
      peakTradingHours: [14, 15, 16],
      volumeConsistency: 0.5,
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

export const volumeProfileAnalyzer = new VolumeProfileAnalyzer();

export default {
  VolumeProfileAnalyzer,
  volumeProfileAnalyzer,
};
