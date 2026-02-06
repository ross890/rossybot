// ===========================================
// BREAKOUT ANALYZER
// Identifies breakout potential in mature tokens
// ===========================================

import { logger } from '../../utils/logger.js';
import { dexScreenerClient } from '../onchain.js';
import { BreakoutMetrics, BREAKOUT_THRESHOLDS } from './types.js';

// ============ CONSTANTS ============

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes (more frequent for breakout detection)

// ============ CLASS ============

export class BreakoutAnalyzer {
  private cache: Map<string, { metrics: BreakoutMetrics; timestamp: number }> = new Map();

  /**
   * Analyze breakout potential for a mature token
   */
  async analyze(tokenAddress: string): Promise<BreakoutMetrics> {
    // Check cache
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.metrics;
    }

    try {
      const [technicalData, momentumData, socialData] = await Promise.all([
        this.getTechnicalData(tokenAddress),
        this.getMomentumData(tokenAddress),
        this.getSocialData(tokenAddress),
      ]);

      const metrics: BreakoutMetrics = {
        ...technicalData,
        ...momentumData,
        ...socialData,
        breakoutScore: 0,
        breakoutProbability: 0,
      };

      metrics.breakoutScore = this.calculateBreakoutScore(metrics);
      metrics.breakoutProbability = this.calculateBreakoutProbability(metrics);

      // Cache result
      this.cache.set(tokenAddress, { metrics, timestamp: Date.now() });

      logger.debug({
        tokenAddress: tokenAddress.slice(0, 8),
        score: metrics.breakoutScore,
        probability: metrics.breakoutProbability,
      }, 'Breakout analysis complete');

      return metrics;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to analyze breakout');
      return this.getDefaultMetrics();
    }
  }

  /**
   * Get technical indicators
   */
  private async getTechnicalData(tokenAddress: string): Promise<{
    volumeExpansion: number;
    priceVelocity5m: number;
    resistanceTests: number;
    supportBounces: number;
    rsi14: number;
    macdCrossover: boolean;
    ema9CrossEma21: boolean;
    volumeOBV: number;
  }> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return this.getDefaultTechnicalData();
      }

      const pair = pairs[0] as any;

      // Volume expansion (current vs 7-day average)
      const vol24h = pair.volume?.h24 || 0;
      const vol6h = pair.volume?.h6 || vol24h / 4;
      const avgVol = vol24h / 24;
      const currentVolRate = vol6h / 6;
      const volumeExpansion = avgVol > 0 ? currentVolRate / avgVol : 1;

      // Price velocity (5m change)
      const priceChange5m = pair.priceChange?.m5 || 0;
      const priceVelocity5m = priceChange5m / 5; // % per minute

      // Resistance tests and support bounces (estimated from price action)
      const priceChange24h = pair.priceChange?.h24 || 0;
      const priceChange1h = pair.priceChange?.h1 || 0;

      // If price is up but has pulled back multiple times = resistance tests
      const resistanceTests = priceChange24h > 0 && priceChange1h < priceChange24h / 2 ? 2 : 1;

      // If price has bounced from lows = support bounces
      const supportBounces = priceChange24h < 0 && priceChange1h > 0 ? 2 : 1;

      // RSI estimation (simplified - would need historical data)
      // If recent price up strongly, RSI higher
      const rsi14 = 50 + priceChange24h / 2; // Rough estimate

      // MACD and EMA crossovers (simplified)
      const macdCrossover = priceChange5m > 0 && priceChange1h > 0;
      const ema9CrossEma21 = priceChange1h > 0 && priceChange24h > -10;

      // OBV trend (buy volume - sell volume)
      const buys = pair.txns?.h24?.buys || 0;
      const sells = pair.txns?.h24?.sells || 0;
      const volumeOBV = buys - sells;

      return {
        volumeExpansion,
        priceVelocity5m,
        resistanceTests,
        supportBounces,
        rsi14: Math.max(0, Math.min(100, rsi14)),
        macdCrossover,
        ema9CrossEma21,
        volumeOBV,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get technical data');
      return this.getDefaultTechnicalData();
    }
  }

  /**
   * Get momentum/order flow data
   */
  private async getMomentumData(tokenAddress: string): Promise<{
    bidAskRatio: number;
    largeOrderFlow: number;
    marketOrderRatio: number;
  }> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return this.getDefaultMomentumData();
      }

      const pair = pairs[0] as any;

      // Bid/ask ratio from buy/sell transactions
      const buys = pair.txns?.h1?.buys || 0;
      const sells = pair.txns?.h1?.sells || 0;
      const bidAskRatio = sells > 0 ? buys / sells : buys > 0 ? 2 : 1;

      // Large order flow (estimate from volume per transaction)
      const vol1h = pair.volume?.h1 || 0;
      const totalTxns = buys + sells;
      const avgTxnSize = totalTxns > 0 ? vol1h / totalTxns : 0;
      const largeOrderFlow = avgTxnSize > 1000 ? 10 : avgTxnSize > 500 ? 7 : avgTxnSize > 100 ? 4 : 1;

      // Market order ratio (estimate - higher buys = more market orders)
      const marketOrderRatio = bidAskRatio > 1.5 ? 0.7 : bidAskRatio > 1 ? 0.5 : 0.3;

      return {
        bidAskRatio,
        largeOrderFlow,
        marketOrderRatio,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get momentum data');
      return this.getDefaultMomentumData();
    }
  }

  /**
   * Get social/narrative data
   */
  private async getSocialData(tokenAddress: string): Promise<{
    socialVelocity3h: number;
    narrativeStrength: number;
    kolMentions24h: number;
  }> {
    // Social data would come from Twitter API
    // For now, return estimates based on on-chain activity
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return this.getDefaultSocialData();
      }

      const pair = pairs[0] as any;

      // Social velocity estimate from transaction growth
      const txns1h = (pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0);
      const txns24h = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0);
      const avgTxns1h = txns24h / 24;
      const socialVelocity3h = avgTxns1h > 0 ? txns1h / avgTxns1h : 1;

      // Narrative strength from name/ticker
      const name = (pair.baseToken?.name || '').toLowerCase();
      let narrativeStrength = 50;
      if (name.includes('ai') || name.includes('agent')) narrativeStrength = 80;
      else if (name.includes('trump') || name.includes('maga')) narrativeStrength = 75;
      else if (name.includes('pepe') || name.includes('doge')) narrativeStrength = 70;

      // KOL mentions (placeholder - would need Twitter integration)
      const kolMentions24h = 0;

      return {
        socialVelocity3h,
        narrativeStrength,
        kolMentions24h,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get social data');
      return this.getDefaultSocialData();
    }
  }

  /**
   * Calculate breakout score
   */
  private calculateBreakoutScore(metrics: BreakoutMetrics): number {
    let score = 0;

    // Volume Expansion Score (0-25)
    if (metrics.volumeExpansion >= 3.0) score += 25;
    else if (metrics.volumeExpansion >= 2.5) score += 20;
    else if (metrics.volumeExpansion >= 2.0) score += 15;
    else if (metrics.volumeExpansion >= 1.5) score += 10;
    else if (metrics.volumeExpansion >= 1.2) score += 5;

    // Price Velocity Score (0-15)
    if (metrics.priceVelocity5m > 1) score += 15;
    else if (metrics.priceVelocity5m > 0.5) score += 12;
    else if (metrics.priceVelocity5m > 0.2) score += 8;
    else if (metrics.priceVelocity5m > 0) score += 4;

    // Resistance Tests Score (0-10)
    if (metrics.resistanceTests >= 3) score += 10;
    else if (metrics.resistanceTests >= 2) score += 7;
    else if (metrics.resistanceTests >= 1) score += 3;

    // RSI Score (0-15) - Sweet spot is 45-70
    if (metrics.rsi14 >= 45 && metrics.rsi14 <= 70) score += 15;
    else if (metrics.rsi14 >= 40 && metrics.rsi14 <= 75) score += 10;
    else if (metrics.rsi14 >= 35 && metrics.rsi14 <= 80) score += 5;

    // Bid/Ask Ratio Score (0-15)
    if (metrics.bidAskRatio >= 2.0) score += 15;
    else if (metrics.bidAskRatio >= 1.5) score += 12;
    else if (metrics.bidAskRatio >= 1.3) score += 8;
    else if (metrics.bidAskRatio >= 1.1) score += 4;

    // Crossover Bonuses (0-10)
    if (metrics.macdCrossover) score += 5;
    if (metrics.ema9CrossEma21) score += 5;

    // Social Velocity Score (0-10)
    if (metrics.socialVelocity3h >= 2.0) score += 10;
    else if (metrics.socialVelocity3h >= 1.5) score += 7;
    else if (metrics.socialVelocity3h >= 1.2) score += 4;

    return Math.min(100, score);
  }

  /**
   * Calculate breakout probability
   */
  private calculateBreakoutProbability(metrics: BreakoutMetrics): number {
    let probability = 0.3; // Base probability

    // Volume expansion is the strongest predictor
    if (metrics.volumeExpansion >= BREAKOUT_THRESHOLDS.volumeExpansion.min) {
      probability += 0.2;
    }

    // RSI in optimal range
    if (metrics.rsi14 >= BREAKOUT_THRESHOLDS.rsi14.min &&
        metrics.rsi14 <= BREAKOUT_THRESHOLDS.rsi14.max) {
      probability += 0.15;
    }

    // Bid pressure
    if (metrics.bidAskRatio >= BREAKOUT_THRESHOLDS.bidAskRatio.min) {
      probability += 0.15;
    }

    // Multiple resistance tests
    if (metrics.resistanceTests >= BREAKOUT_THRESHOLDS.resistanceTests.min) {
      probability += 0.1;
    }

    // Social momentum
    if (metrics.socialVelocity3h >= BREAKOUT_THRESHOLDS.socialVelocity3h.min) {
      probability += 0.1;
    }

    return Math.min(0.9, probability);
  }

  /**
   * Check if breakout is likely
   */
  isBreakoutLikely(metrics: BreakoutMetrics): boolean {
    return (
      metrics.breakoutScore >= 50 &&
      metrics.breakoutProbability >= 0.5 &&
      metrics.volumeExpansion >= 1.5
    );
  }

  /**
   * Check if token is breaking out NOW
   */
  isActiveBreakout(metrics: BreakoutMetrics): boolean {
    return (
      metrics.volumeExpansion >= 2.5 &&
      metrics.priceVelocity5m > 0.5 &&
      metrics.bidAskRatio >= 1.5 &&
      metrics.macdCrossover
    );
  }

  /**
   * Default metrics
   */
  private getDefaultMetrics(): BreakoutMetrics {
    return {
      volumeExpansion: 1,
      priceVelocity5m: 0,
      resistanceTests: 0,
      supportBounces: 0,
      rsi14: 50,
      macdCrossover: false,
      ema9CrossEma21: false,
      volumeOBV: 0,
      bidAskRatio: 1,
      largeOrderFlow: 0,
      marketOrderRatio: 0.5,
      socialVelocity3h: 1,
      narrativeStrength: 50,
      kolMentions24h: 0,
      breakoutScore: 0,
      breakoutProbability: 0,
    };
  }

  private getDefaultTechnicalData() {
    return {
      volumeExpansion: 1,
      priceVelocity5m: 0,
      resistanceTests: 0,
      supportBounces: 0,
      rsi14: 50,
      macdCrossover: false,
      ema9CrossEma21: false,
      volumeOBV: 0,
    };
  }

  private getDefaultMomentumData() {
    return {
      bidAskRatio: 1,
      largeOrderFlow: 0,
      marketOrderRatio: 0.5,
    };
  }

  private getDefaultSocialData() {
    return {
      socialVelocity3h: 1,
      narrativeStrength: 50,
      kolMentions24h: 0,
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

export const breakoutAnalyzer = new BreakoutAnalyzer();

export default {
  BreakoutAnalyzer,
  breakoutAnalyzer,
};
