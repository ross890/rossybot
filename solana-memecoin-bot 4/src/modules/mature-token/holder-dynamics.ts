// ===========================================
// HOLDER DYNAMICS ANALYZER
// Tracks holder behavior and distribution for mature tokens
// ===========================================

import { logger } from '../../utils/logger.js';
import { heliusClient, dexScreenerClient } from '../onchain.js';
import { HolderDynamicsMetrics, HOLDER_THRESHOLDS } from './types.js';

// ============ CONSTANTS ============

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============ CLASS ============

export class HolderDynamicsAnalyzer {
  private cache: Map<string, { metrics: HolderDynamicsMetrics; timestamp: number }> = new Map();

  /**
   * Analyze holder dynamics for a mature token
   */
  async analyze(tokenAddress: string): Promise<HolderDynamicsMetrics> {
    // Check cache
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.metrics;
    }

    try {
      const [growthData, distributionData, retentionData, qualityData] = await Promise.all([
        this.getGrowthMetrics(tokenAddress),
        this.getDistributionMetrics(tokenAddress),
        this.getRetentionMetrics(tokenAddress),
        this.getWalletQualityMetrics(tokenAddress),
      ]);

      const metrics: HolderDynamicsMetrics = {
        ...growthData,
        ...distributionData,
        ...retentionData,
        ...qualityData,
        holderDynamicsScore: 0,
      };

      metrics.holderDynamicsScore = this.calculateScore(metrics);

      // Cache result
      this.cache.set(tokenAddress, { metrics, timestamp: Date.now() });

      logger.debug({
        tokenAddress: tokenAddress.slice(0, 8),
        score: metrics.holderDynamicsScore,
        holderGrowth: metrics.holderGrowth24h,
      }, 'Holder dynamics analysis complete');

      return metrics;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to analyze holder dynamics');
      return this.getDefaultMetrics();
    }
  }

  /**
   * Get holder growth metrics
   */
  private async getGrowthMetrics(tokenAddress: string): Promise<{
    holderGrowth24h: number;
    holderGrowth7d: number;
    uniqueBuyers24h: number;
    uniqueSellers24h: number;
    buyerSellerRatio: number;
  }> {
    try {
      const [holderData, txnData] = await Promise.all([
        heliusClient.getTokenHolders(tokenAddress),
        this.getTransactionData(tokenAddress),
      ]);

      const totalHolders = holderData.total || 0;

      // Estimate growth (would need historical tracking for accurate data)
      const holderGrowth24h = txnData.netNewHolders24h > 0
        ? (txnData.netNewHolders24h / Math.max(1, totalHolders - txnData.netNewHolders24h)) * 100
        : 0;

      const holderGrowth7d = holderGrowth24h * 5; // Rough estimate

      return {
        holderGrowth24h,
        holderGrowth7d,
        uniqueBuyers24h: txnData.uniqueBuyers24h,
        uniqueSellers24h: txnData.uniqueSellers24h,
        buyerSellerRatio: txnData.uniqueSellers24h > 0
          ? txnData.uniqueBuyers24h / txnData.uniqueSellers24h
          : txnData.uniqueBuyers24h > 0 ? 2 : 1,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get growth metrics');
      return {
        holderGrowth24h: 0,
        holderGrowth7d: 0,
        uniqueBuyers24h: 0,
        uniqueSellers24h: 0,
        buyerSellerRatio: 1,
      };
    }
  }

  /**
   * Get distribution metrics
   */
  private async getDistributionMetrics(tokenAddress: string): Promise<{
    giniCoefficient: number;
    medianHolding: number;
    top10Change7d: number;
    freshWalletRatio: number;
  }> {
    try {
      const holderData = await heliusClient.getTokenHolders(tokenAddress);
      const holders = holderData.holders || [];

      if (holders.length === 0) {
        return this.getDefaultDistributionMetrics();
      }

      // Calculate holdings
      const holdings = holders.map((h: any) => parseFloat(h.amount || '0')).sort((a, b) => b - a);
      const totalSupply = holdings.reduce((sum, h) => sum + h, 0);

      // Gini coefficient calculation
      const giniCoefficient = this.calculateGini(holdings);

      // Median holding
      const medianIndex = Math.floor(holdings.length / 2);
      const medianHolding = holdings[medianIndex] || 0;

      // Top 10 concentration change (estimate)
      const top10Holdings = holdings.slice(0, 10).reduce((sum, h) => sum + h, 0);
      const top10Percent = totalSupply > 0 ? (top10Holdings / totalSupply) * 100 : 0;
      const top10Change7d = 0; // Would need historical data

      // Fresh wallet ratio (estimate based on holder age patterns)
      // In production, would check wallet creation dates
      const freshWalletRatio = 0.15; // Default estimate

      return {
        giniCoefficient,
        medianHolding,
        top10Change7d,
        freshWalletRatio,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get distribution metrics');
      return this.getDefaultDistributionMetrics();
    }
  }

  /**
   * Get retention metrics
   */
  private async getRetentionMetrics(tokenAddress: string): Promise<{
    diamondHandsRatio: number;
    paperHandsExitRate: number;
    avgHoldTime: number;
  }> {
    try {
      // In production, would track holder history
      // For now, estimate from transaction patterns
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return this.getDefaultRetentionMetrics();
      }

      const pair = pairs[0] as any;
      const buys24h = pair.txns?.h24?.buys || 0;
      const sells24h = pair.txns?.h24?.sells || 0;

      // Higher sell rate = lower retention
      const sellRatio = buys24h > 0 ? sells24h / buys24h : 0.5;

      // Diamond hands ratio - estimate based on low sell pressure
      const diamondHandsRatio = Math.max(0.2, Math.min(0.8, 0.6 - sellRatio * 0.3));

      // Paper hands exit rate
      const paperHandsExitRate = Math.min(0.5, sellRatio * 0.3);

      // Average hold time (estimate from trading patterns)
      const avgHoldTime = sellRatio < 0.5 ? 72 : sellRatio < 1 ? 48 : 24; // hours

      return {
        diamondHandsRatio,
        paperHandsExitRate,
        avgHoldTime,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get retention metrics');
      return this.getDefaultRetentionMetrics();
    }
  }

  /**
   * Get wallet quality metrics
   */
  private async getWalletQualityMetrics(tokenAddress: string): Promise<{
    qualityWalletRatio: number;
    smartMoneyHolders: number;
    institutionalWallets: number;
  }> {
    try {
      const holderData = await heliusClient.getTokenHolders(tokenAddress);
      const holders = holderData.holders || [];

      // Quality wallets = wallets with transaction history
      // In production, would check each wallet's history
      const qualityWalletRatio = 0.65; // Default estimate

      // Smart money holders (would cross-reference with known profitable wallets)
      const smartMoneyHolders = Math.floor(holders.length * 0.05);

      // Institutional wallets (large stable holders)
      const largeHolders = holders.filter((h: any) => {
        const totalSupply = holders.reduce((sum: number, holder: any) =>
          sum + parseFloat(holder.amount || '0'), 0);
        const balance = parseFloat(h.amount || '0');
        return balance / totalSupply > 0.02; // > 2% of supply
      });
      const institutionalWallets = Math.floor(largeHolders.length * 0.3);

      return {
        qualityWalletRatio,
        smartMoneyHolders,
        institutionalWallets,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get wallet quality metrics');
      return {
        qualityWalletRatio: 0.5,
        smartMoneyHolders: 0,
        institutionalWallets: 0,
      };
    }
  }

  /**
   * Get transaction data helper
   */
  private async getTransactionData(tokenAddress: string): Promise<{
    netNewHolders24h: number;
    uniqueBuyers24h: number;
    uniqueSellers24h: number;
  }> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) {
        return { netNewHolders24h: 0, uniqueBuyers24h: 0, uniqueSellers24h: 0 };
      }

      const pair = pairs[0] as any;
      const buys = pair.txns?.h24?.buys || 0;
      const sells = pair.txns?.h24?.sells || 0;

      // Estimate unique buyers/sellers (assume some overlap)
      const uniqueBuyers24h = Math.floor(buys * 0.7);
      const uniqueSellers24h = Math.floor(sells * 0.7);
      const netNewHolders24h = Math.max(0, uniqueBuyers24h - uniqueSellers24h);

      return {
        netNewHolders24h,
        uniqueBuyers24h,
        uniqueSellers24h,
      };
    } catch (error) {
      return { netNewHolders24h: 0, uniqueBuyers24h: 0, uniqueSellers24h: 0 };
    }
  }

  /**
   * Calculate Gini coefficient
   */
  private calculateGini(holdings: number[]): number {
    if (holdings.length === 0) return 0;

    const n = holdings.length;
    const sorted = [...holdings].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, h) => sum + h, 0) / n;

    if (mean === 0) return 0;

    let sumOfDifferences = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        sumOfDifferences += Math.abs(sorted[i] - sorted[j]);
      }
    }

    return sumOfDifferences / (2 * n * n * mean);
  }

  /**
   * Calculate holder dynamics score
   */
  private calculateScore(metrics: HolderDynamicsMetrics): number {
    let score = 0;

    // Holder Growth Score (0-25)
    if (metrics.holderGrowth24h >= 10) score += 25;
    else if (metrics.holderGrowth24h >= 7) score += 20;
    else if (metrics.holderGrowth24h >= 5) score += 15;
    else if (metrics.holderGrowth24h >= 3) score += 10;
    else if (metrics.holderGrowth24h >= 1) score += 5;

    // Buyer/Seller Ratio Score (0-20)
    if (metrics.buyerSellerRatio >= 3.0) score += 20;
    else if (metrics.buyerSellerRatio >= 2.0) score += 16;
    else if (metrics.buyerSellerRatio >= 1.5) score += 12;
    else if (metrics.buyerSellerRatio >= 1.2) score += 8;
    else if (metrics.buyerSellerRatio >= 1.0) score += 4;

    // Distribution Score (0-15) - Lower gini = better distribution
    if (metrics.giniCoefficient <= 0.5) score += 15;
    else if (metrics.giniCoefficient <= 0.6) score += 12;
    else if (metrics.giniCoefficient <= 0.7) score += 8;
    else if (metrics.giniCoefficient <= 0.75) score += 4;

    // Diamond Hands Score (0-15)
    if (metrics.diamondHandsRatio >= 0.5) score += 15;
    else if (metrics.diamondHandsRatio >= 0.4) score += 12;
    else if (metrics.diamondHandsRatio >= 0.3) score += 8;
    else if (metrics.diamondHandsRatio >= 0.2) score += 4;

    // Quality Wallet Score (0-15)
    if (metrics.qualityWalletRatio >= 0.75) score += 15;
    else if (metrics.qualityWalletRatio >= 0.65) score += 12;
    else if (metrics.qualityWalletRatio >= 0.55) score += 8;
    else if (metrics.qualityWalletRatio >= 0.45) score += 4;

    // Smart Money Score (0-10)
    if (metrics.smartMoneyHolders >= 10) score += 10;
    else if (metrics.smartMoneyHolders >= 7) score += 8;
    else if (metrics.smartMoneyHolders >= 5) score += 6;
    else if (metrics.smartMoneyHolders >= 3) score += 4;
    else if (metrics.smartMoneyHolders >= 1) score += 2;

    return Math.min(100, score);
  }

  /**
   * Check if holder dynamics are healthy
   */
  isHealthyHolderDynamics(metrics: HolderDynamicsMetrics): boolean {
    return (
      metrics.holderDynamicsScore >= 50 &&
      metrics.buyerSellerRatio >= HOLDER_THRESHOLDS.buyerSellerRatio.min &&
      metrics.giniCoefficient <= HOLDER_THRESHOLDS.giniCoefficient.max
    );
  }

  /**
   * Get default metrics
   */
  private getDefaultMetrics(): HolderDynamicsMetrics {
    return {
      holderGrowth24h: 0,
      holderGrowth7d: 0,
      uniqueBuyers24h: 0,
      uniqueSellers24h: 0,
      buyerSellerRatio: 1,
      giniCoefficient: 0.7,
      medianHolding: 0,
      top10Change7d: 0,
      freshWalletRatio: 0.2,
      diamondHandsRatio: 0.3,
      paperHandsExitRate: 0.2,
      avgHoldTime: 24,
      qualityWalletRatio: 0.5,
      smartMoneyHolders: 0,
      institutionalWallets: 0,
      holderDynamicsScore: 0,
    };
  }

  private getDefaultDistributionMetrics() {
    return {
      giniCoefficient: 0.7,
      medianHolding: 0,
      top10Change7d: 0,
      freshWalletRatio: 0.2,
    };
  }

  private getDefaultRetentionMetrics() {
    return {
      diamondHandsRatio: 0.3,
      paperHandsExitRate: 0.2,
      avgHoldTime: 24,
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

export const holderDynamicsAnalyzer = new HolderDynamicsAnalyzer();

export default {
  HolderDynamicsAnalyzer,
  holderDynamicsAnalyzer,
};
