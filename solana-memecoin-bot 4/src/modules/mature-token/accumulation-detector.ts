// ===========================================
// ACCUMULATION DETECTOR
// Detects Wyckoff-style accumulation patterns in mature tokens
// ===========================================

import { logger } from '../../utils/logger.js';
import { dexScreenerClient, birdeyeClient, heliusClient } from '../onchain.js';
import {
  AccumulationMetrics,
  AccumulationPattern,
  ACCUMULATION_THRESHOLDS,
} from './types.js';
import { appConfig } from '../../config/index.js';

// ============ CONSTANTS ============

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============ CLASS ============

export class AccumulationDetector {
  private cache: Map<string, { metrics: AccumulationMetrics; timestamp: number }> = new Map();

  /**
   * Analyze accumulation patterns for a mature token
   */
  async analyze(tokenAddress: string): Promise<AccumulationMetrics> {
    // Check cache
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.metrics;
    }

    try {
      // Fetch data in parallel
      const [priceData, volumeData, holderData] = await Promise.all([
        this.getPriceData(tokenAddress),
        this.getVolumeData(tokenAddress),
        this.getHolderData(tokenAddress),
      ]);

      // Calculate accumulation metrics
      const metrics = this.calculateMetrics(priceData, volumeData, holderData);

      // Detect pattern
      metrics.pattern = this.detectPattern(metrics);
      metrics.patternConfidence = this.calculatePatternConfidence(metrics);

      // Calculate overall score
      metrics.accumulationScore = this.calculateScore(metrics);

      // Cache result
      this.cache.set(tokenAddress, { metrics, timestamp: Date.now() });

      logger.debug({
        tokenAddress: tokenAddress.slice(0, 8),
        pattern: metrics.pattern,
        score: metrics.accumulationScore,
      }, 'Accumulation analysis complete');

      return metrics;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to analyze accumulation');
      return this.getDefaultMetrics();
    }
  }

  /**
   * Get price data for accumulation analysis
   */
  private async getPriceData(tokenAddress: string): Promise<{
    priceRange24h: number;
    priceRangePercentile: number;
    lowerHighsCount: number;
    higherLowsCount: number;
    distanceFromATH: number;
    distanceFromATL: number;
    currentPrice: number;
    high24h: number;
    low24h: number;
  }> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return this.getDefaultPriceData();
      }

      const pair = pairs[0] as any;
      const currentPrice = parseFloat(pair.priceUsd || '0');
      const priceChange24h = pair.priceChange?.h24 || 0;

      // Estimate high/low from price change
      const high24h = currentPrice * (1 + Math.abs(priceChange24h) / 100);
      const low24h = currentPrice * (1 - Math.abs(priceChange24h) / 100);

      const priceRange24h = high24h > 0 ? ((high24h - low24h) / high24h) * 100 : 0;

      // For ATH/ATL, we'd need historical data - estimate from FDV patterns
      const fdv = pair.fdv || pair.marketCap || 0;
      const estimatedATH = fdv * 2; // Assume ATH was 2x current FDV
      const distanceFromATH = estimatedATH > 0 ? ((estimatedATH - fdv) / estimatedATH) * 100 : 50;
      const distanceFromATL = 20; // Default estimate

      // Count higher lows and lower highs from recent price action
      // This would require OHLC data - using estimates
      const lowerHighsCount = priceChange24h < 0 ? 2 : 0;
      const higherLowsCount = priceChange24h > -10 ? 2 : 0;

      // Price range percentile (compared to historical volatility)
      // Tight range = accumulation signal
      const priceRangePercentile = priceRange24h < 15 ? 80 : priceRange24h < 25 ? 60 : 40;

      return {
        priceRange24h,
        priceRangePercentile,
        lowerHighsCount,
        higherLowsCount,
        distanceFromATH,
        distanceFromATL,
        currentPrice,
        high24h,
        low24h,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get price data');
      return this.getDefaultPriceData();
    }
  }

  /**
   * Get volume data for accumulation analysis
   */
  private async getVolumeData(tokenAddress: string): Promise<{
    volumeDecline7d: number;
    volumeSpikesInRange: number;
    buyVolumeRatio: number;
    volume24h: number;
    volume7d: number;
    consolidationDays: number;
  }> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return this.getDefaultVolumeData();
      }

      const pair = pairs[0] as any;
      const volume24h = pair.volume?.h24 || 0;
      const volume6h = pair.volume?.h6 || volume24h / 4;

      // Estimate 7d volume from 24h (would need historical data)
      const volume7d = volume24h * 7;

      // Volume decline calculation
      // If current volume is lower than average, it indicates consolidation
      const avgDailyVol = volume7d / 7;
      const volumeDecline7d = avgDailyVol > 0 ? Math.max(0, ((avgDailyVol - volume24h) / avgDailyVol) * 100) : 0;

      // Buy/sell ratio from transaction data
      const buys = pair.txns?.h24?.buys || 0;
      const sells = pair.txns?.h24?.sells || 0;
      const buyVolumeRatio = sells > 0 ? buys / sells : buys > 0 ? 2 : 1;

      // Volume spikes - count significant volume increases
      const volumeSpikesInRange = volume24h > avgDailyVol * 1.5 ? 1 : 0;

      // Consolidation days - estimate from volume pattern
      const consolidationDays = volumeDecline7d > 30 ? 3 : volumeDecline7d > 15 ? 2 : 1;

      return {
        volumeDecline7d,
        volumeSpikesInRange,
        buyVolumeRatio,
        volume24h,
        volume7d,
        consolidationDays,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get volume data');
      return this.getDefaultVolumeData();
    }
  }

  /**
   * Get holder data for accumulation analysis
   */
  private async getHolderData(tokenAddress: string): Promise<{
    newHolders24h: number;
    holderRetentionRate: number;
    avgPositionSize: number;
    largeWalletAccumulation: number;
    totalHolders: number;
  }> {
    // Skip when Helius is disabled - return defaults
    if (appConfig.heliusDisabled) {
      return this.getDefaultHolderData();
    }

    try {
      const holderInfo = await heliusClient.getTokenHolders(tokenAddress);
      const totalHolders = holderInfo.total || 0;

      // Get holder distribution
      const topHolders = holderInfo.topHolders || [];
      const largeWallets = topHolders.filter((h: any) => {
        const balance = parseFloat(h.amount || '0');
        const totalSupply = topHolders.reduce((sum: number, holder: any) =>
          sum + parseFloat(holder.amount || '0'), 0);
        return balance / totalSupply > 0.01; // > 1% of supply
      });

      // Estimate new holders (would need historical tracking)
      const newHolders24h = Math.floor(totalHolders * 0.05); // Estimate 5% new

      // Holder retention (estimate based on holder growth)
      const holderRetentionRate = 0.75; // Default 75%

      // Average position size
      const totalValue = topHolders.reduce((sum: number, h: any) =>
        sum + parseFloat(h.amount || '0'), 0);
      const avgPositionSize = totalHolders > 0 ? totalValue / totalHolders : 0;

      // Large wallet accumulation count
      const largeWalletAccumulation = largeWallets.length;

      return {
        newHolders24h,
        holderRetentionRate,
        avgPositionSize,
        largeWalletAccumulation,
        totalHolders,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get holder data');
      return this.getDefaultHolderData();
    }
  }

  /**
   * Calculate accumulation metrics from raw data
   */
  private calculateMetrics(
    priceData: Awaited<ReturnType<typeof this.getPriceData>>,
    volumeData: Awaited<ReturnType<typeof this.getVolumeData>>,
    holderData: Awaited<ReturnType<typeof this.getHolderData>>
  ): AccumulationMetrics {
    return {
      priceRange24h: priceData.priceRange24h,
      priceRangePercentile: priceData.priceRangePercentile,
      lowerHighsCount: priceData.lowerHighsCount,
      higherLowsCount: priceData.higherLowsCount,
      volumeDecline7d: volumeData.volumeDecline7d,
      volumeSpikesInRange: volumeData.volumeSpikesInRange,
      buyVolumeRatio: volumeData.buyVolumeRatio,
      newHolders24h: holderData.newHolders24h,
      holderRetentionRate: holderData.holderRetentionRate,
      avgPositionSize: holderData.avgPositionSize,
      largeWalletAccumulation: holderData.largeWalletAccumulation,
      consolidationDays: volumeData.consolidationDays,
      distanceFromATH: priceData.distanceFromATH,
      distanceFromATL: priceData.distanceFromATL,
      pattern: AccumulationPattern.NONE,
      patternConfidence: 0,
      accumulationScore: 0,
    };
  }

  /**
   * Detect accumulation pattern from metrics
   */
  private detectPattern(metrics: AccumulationMetrics): AccumulationPattern {
    // Wyckoff Spring: Deep pullback with volume spike, then recovery
    if (
      metrics.distanceFromATH > 60 &&
      metrics.volumeSpikesInRange > 0 &&
      metrics.buyVolumeRatio > 1.5 &&
      metrics.higherLowsCount >= 2
    ) {
      return AccumulationPattern.WYCKOFF_SPRING;
    }

    // Ascending Triangle: Higher lows, testing resistance
    if (
      metrics.higherLowsCount >= 2 &&
      metrics.priceRange24h < 25 &&
      metrics.buyVolumeRatio > 1.2
    ) {
      return AccumulationPattern.ASCENDING_TRIANGLE;
    }

    // Double Bottom: Two tests of support
    if (
      metrics.distanceFromATL < 30 &&
      metrics.volumeSpikesInRange >= 1 &&
      metrics.buyVolumeRatio > 1.3
    ) {
      return AccumulationPattern.DOUBLE_BOTTOM;
    }

    // Range Break: Tight consolidation ready for breakout
    if (
      metrics.priceRange24h < ACCUMULATION_THRESHOLDS.priceRange24h.max &&
      metrics.volumeDecline7d > ACCUMULATION_THRESHOLDS.volumeDecline7d.min &&
      metrics.consolidationDays >= ACCUMULATION_THRESHOLDS.consolidationDays.min
    ) {
      return AccumulationPattern.RANGE_BREAK;
    }

    // General Consolidation
    if (
      metrics.priceRange24h < 30 &&
      metrics.consolidationDays >= 1
    ) {
      return AccumulationPattern.CONSOLIDATION;
    }

    return AccumulationPattern.NONE;
  }

  /**
   * Calculate pattern confidence
   */
  private calculatePatternConfidence(metrics: AccumulationMetrics): number {
    let confidence = 0;
    let factors = 0;

    // Price range tightness
    if (metrics.priceRange24h < ACCUMULATION_THRESHOLDS.priceRange24h.max) {
      confidence += 20;
      factors++;
    }

    // Volume decline (quiet accumulation)
    if (metrics.volumeDecline7d > ACCUMULATION_THRESHOLDS.volumeDecline7d.min) {
      confidence += 15;
      factors++;
    }

    // Buy pressure
    if (metrics.buyVolumeRatio > ACCUMULATION_THRESHOLDS.buyVolumeRatio.min) {
      confidence += 20;
      factors++;
    }

    // New holders
    if (metrics.newHolders24h > ACCUMULATION_THRESHOLDS.newHolders24h.min) {
      confidence += 15;
      factors++;
    }

    // Large wallet accumulation
    if (metrics.largeWalletAccumulation >= ACCUMULATION_THRESHOLDS.largeWalletAccumulation.min) {
      confidence += 15;
      factors++;
    }

    // Distance from ATH (40-80% is ideal)
    if (
      metrics.distanceFromATH >= ACCUMULATION_THRESHOLDS.distanceFromATH.min &&
      metrics.distanceFromATH <= ACCUMULATION_THRESHOLDS.distanceFromATH.max
    ) {
      confidence += 15;
      factors++;
    }

    return factors > 0 ? Math.min(100, confidence) : 0;
  }

  /**
   * Calculate overall accumulation score
   */
  private calculateScore(metrics: AccumulationMetrics): number {
    let score = 0;

    // Price Range Score (0-20)
    if (metrics.priceRange24h < 10) score += 20;
    else if (metrics.priceRange24h < 15) score += 15;
    else if (metrics.priceRange24h < 20) score += 10;
    else if (metrics.priceRange24h < 30) score += 5;

    // Volume Decline Score (0-15)
    if (metrics.volumeDecline7d > 50) score += 15;
    else if (metrics.volumeDecline7d > 40) score += 12;
    else if (metrics.volumeDecline7d > 30) score += 8;
    else if (metrics.volumeDecline7d > 20) score += 4;

    // Buy Volume Ratio Score (0-20)
    if (metrics.buyVolumeRatio > 2.0) score += 20;
    else if (metrics.buyVolumeRatio > 1.5) score += 15;
    else if (metrics.buyVolumeRatio > 1.2) score += 10;
    else if (metrics.buyVolumeRatio > 1.0) score += 5;

    // New Holders Score (0-15)
    if (metrics.newHolders24h > 100) score += 15;
    else if (metrics.newHolders24h > 75) score += 12;
    else if (metrics.newHolders24h > 50) score += 8;
    else if (metrics.newHolders24h > 25) score += 4;

    // Holder Retention Score (0-10)
    if (metrics.holderRetentionRate > 0.85) score += 10;
    else if (metrics.holderRetentionRate > 0.75) score += 7;
    else if (metrics.holderRetentionRate > 0.65) score += 4;

    // Large Wallet Accumulation Score (0-10)
    if (metrics.largeWalletAccumulation >= 5) score += 10;
    else if (metrics.largeWalletAccumulation >= 3) score += 7;
    else if (metrics.largeWalletAccumulation >= 2) score += 4;

    // Pattern Bonus (0-10)
    if (metrics.pattern === AccumulationPattern.WYCKOFF_SPRING) score += 10;
    else if (metrics.pattern === AccumulationPattern.ASCENDING_TRIANGLE) score += 8;
    else if (metrics.pattern === AccumulationPattern.DOUBLE_BOTTOM) score += 7;
    else if (metrics.pattern === AccumulationPattern.RANGE_BREAK) score += 6;
    else if (metrics.pattern === AccumulationPattern.CONSOLIDATION) score += 3;

    return Math.min(100, score);
  }

  /**
   * Check if token shows strong accumulation
   */
  isStrongAccumulation(metrics: AccumulationMetrics): boolean {
    return (
      metrics.accumulationScore >= 60 &&
      metrics.pattern !== AccumulationPattern.NONE &&
      metrics.buyVolumeRatio >= ACCUMULATION_THRESHOLDS.buyVolumeRatio.min
    );
  }

  /**
   * Get default metrics
   */
  private getDefaultMetrics(): AccumulationMetrics {
    return {
      priceRange24h: 50,
      priceRangePercentile: 50,
      lowerHighsCount: 0,
      higherLowsCount: 0,
      volumeDecline7d: 0,
      volumeSpikesInRange: 0,
      buyVolumeRatio: 1,
      newHolders24h: 0,
      holderRetentionRate: 0.5,
      avgPositionSize: 0,
      largeWalletAccumulation: 0,
      consolidationDays: 0,
      distanceFromATH: 50,
      distanceFromATL: 50,
      pattern: AccumulationPattern.NONE,
      patternConfidence: 0,
      accumulationScore: 0,
    };
  }

  private getDefaultPriceData() {
    return {
      priceRange24h: 50,
      priceRangePercentile: 50,
      lowerHighsCount: 0,
      higherLowsCount: 0,
      distanceFromATH: 50,
      distanceFromATL: 50,
      currentPrice: 0,
      high24h: 0,
      low24h: 0,
    };
  }

  private getDefaultVolumeData() {
    return {
      volumeDecline7d: 0,
      volumeSpikesInRange: 0,
      buyVolumeRatio: 1,
      volume24h: 0,
      volume7d: 0,
      consolidationDays: 0,
    };
  }

  private getDefaultHolderData() {
    return {
      newHolders24h: 0,
      holderRetentionRate: 0.5,
      avgPositionSize: 0,
      largeWalletAccumulation: 0,
      totalHolders: 0,
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

export const accumulationDetector = new AccumulationDetector();

export default {
  AccumulationDetector,
  accumulationDetector,
};
