// ===========================================
// MODULE: FRESH WALLET ANALYZER
// Distinguishes organic fresh wallets from sybil attacks
// Phase 4.5 — adds nuance to existing bundle detection
// ===========================================

import { logger } from '../utils/logger.js';

// ============ TYPES ============

export type FreshWalletClassification = 'ORGANIC' | 'SYBIL' | 'UNKNOWN';

export interface FreshWalletAnalysis {
  classification: FreshWalletClassification;
  scoreAdjustment: number; // +5 for organic, -5 for sybil, 0 for unknown
  totalFreshWallets: number;
  organicIndicators: string[];
  sybilIndicators: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

interface WalletBuyInfo {
  walletAddress: string;
  buyAmount: number; // in SOL
  blockNumber: number;
  timestamp: number;
  walletAge: number; // seconds since first tx
  fundingSource: string | null;
}

// ============ CONFIGURATION ============

const CONFIG = {
  // Buy size uniformity detection
  UNIFORM_SIZE_THRESHOLD: 0.10, // Within 10% of each other = uniform (suspicious)

  // Timing
  SAME_BLOCK_THRESHOLD: 2,     // 2+ blocks = spread out (organic)
  ORGANIC_SPREAD_MINUTES: 10,  // 10+ min spread between buys = organic

  // Funding
  SAME_SOURCE_THRESHOLD: 3,    // 3+ wallets from same source = sybil

  // Score adjustments
  ORGANIC_BONUS: 5,
  SYBIL_PENALTY: -5,

  // Minimum fresh wallets to analyze
  MIN_FRESH_WALLETS: 3,
} as const;

// ============ FRESH WALLET ANALYZER CLASS ============

export class FreshWalletAnalyzer {
  /**
   * Analyze fresh wallet activity for a token.
   * Distinguishes organic new retail discovery from insider sybil attacks.
   *
   * ORGANIC indicators:
   *   - Varying buy sizes (not uniform)
   *   - Spread over 10-30 minutes (not same-block)
   *   - Coming from funded wallets with SOL history
   *
   * SYBIL indicators:
   *   - Uniform buy sizes (within 10% of each other)
   *   - Same block or within 2-3 blocks
   *   - Funded from same source wallet
   */
  analyzeFreshWallets(buys: WalletBuyInfo[]): FreshWalletAnalysis {
    if (buys.length < CONFIG.MIN_FRESH_WALLETS) {
      return {
        classification: 'UNKNOWN',
        scoreAdjustment: 0,
        totalFreshWallets: buys.length,
        organicIndicators: [],
        sybilIndicators: [],
        confidence: 'LOW',
      };
    }

    const organicIndicators: string[] = [];
    const sybilIndicators: string[] = [];

    // 1. Check buy size uniformity
    const sizes = buys.map(b => b.buyAmount).filter(s => s > 0);
    if (sizes.length >= 2) {
      const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
      const maxDeviation = Math.max(...sizes.map(s => Math.abs(s - avgSize) / avgSize));

      if (maxDeviation <= CONFIG.UNIFORM_SIZE_THRESHOLD) {
        sybilIndicators.push(`Uniform buy sizes (max ${(maxDeviation * 100).toFixed(0)}% deviation)`);
      } else {
        organicIndicators.push(`Varying buy sizes (${(maxDeviation * 100).toFixed(0)}% deviation)`);
      }
    }

    // 2. Check timing spread
    const blocks = buys.map(b => b.blockNumber).filter(b => b > 0);
    if (blocks.length >= 2) {
      const uniqueBlocks = new Set(blocks);
      const blockSpread = Math.max(...blocks) - Math.min(...blocks);

      if (uniqueBlocks.size <= 1) {
        sybilIndicators.push('All buys in same block');
      } else if (blockSpread <= CONFIG.SAME_BLOCK_THRESHOLD) {
        sybilIndicators.push(`Buys within ${blockSpread} blocks`);
      } else {
        organicIndicators.push(`Spread across ${uniqueBlocks.size} blocks`);
      }
    }

    // Check time spread
    const timestamps = buys.map(b => b.timestamp).filter(t => t > 0);
    if (timestamps.length >= 2) {
      const timeSpreadMs = Math.max(...timestamps) - Math.min(...timestamps);
      const timeSpreadMin = timeSpreadMs / (60 * 1000);

      if (timeSpreadMin >= CONFIG.ORGANIC_SPREAD_MINUTES) {
        organicIndicators.push(`Spread over ${timeSpreadMin.toFixed(0)} minutes`);
      } else if (timeSpreadMin < 1) {
        sybilIndicators.push('All buys within 1 minute');
      }
    }

    // 3. Check funding sources
    const fundingSources = buys
      .map(b => b.fundingSource)
      .filter((s): s is string => s !== null);

    if (fundingSources.length >= 2) {
      const sourceCount = new Map<string, number>();
      for (const source of fundingSources) {
        sourceCount.set(source, (sourceCount.get(source) || 0) + 1);
      }

      const maxFromSameSource = Math.max(...sourceCount.values());
      const uniqueSources = sourceCount.size;

      if (maxFromSameSource >= CONFIG.SAME_SOURCE_THRESHOLD) {
        sybilIndicators.push(`${maxFromSameSource} wallets funded from same source`);
      }
      if (uniqueSources >= Math.ceil(fundingSources.length * 0.7)) {
        organicIndicators.push(`${uniqueSources} different funding sources`);
      }
    }

    // 4. Check wallet age
    const freshCount = buys.filter(b => b.walletAge < 300).length; // < 5 minutes
    const establishedCount = buys.filter(b => b.walletAge > 86400).length; // > 24 hours
    if (freshCount > buys.length * 0.8) {
      sybilIndicators.push(`${((freshCount / buys.length) * 100).toFixed(0)}% are brand-new wallets`);
    }
    if (establishedCount > buys.length * 0.5) {
      organicIndicators.push(`${((establishedCount / buys.length) * 100).toFixed(0)}% are established wallets`);
    }

    // Classify
    const organicScore = organicIndicators.length;
    const sybilScore = sybilIndicators.length;

    let classification: FreshWalletClassification;
    let scoreAdjustment: number;
    let confidence: FreshWalletAnalysis['confidence'];

    if (sybilScore >= 3 || (sybilScore >= 2 && organicScore === 0)) {
      classification = 'SYBIL';
      scoreAdjustment = CONFIG.SYBIL_PENALTY;
      confidence = sybilScore >= 3 ? 'HIGH' : 'MEDIUM';
    } else if (organicScore >= 3 || (organicScore >= 2 && sybilScore === 0)) {
      classification = 'ORGANIC';
      scoreAdjustment = CONFIG.ORGANIC_BONUS;
      confidence = organicScore >= 3 ? 'HIGH' : 'MEDIUM';
    } else {
      classification = 'UNKNOWN';
      scoreAdjustment = 0;
      confidence = 'LOW';
    }

    if (classification !== 'UNKNOWN') {
      logger.debug({
        classification,
        freshWallets: buys.length,
        organicIndicators,
        sybilIndicators,
        confidence,
      }, 'Fresh wallet analysis complete');
    }

    return {
      classification,
      scoreAdjustment,
      totalFreshWallets: buys.length,
      organicIndicators,
      sybilIndicators,
      confidence,
    };
  }

  /**
   * Quick check: analyze from existing bundle detection data.
   * This avoids new API calls — uses data already collected by bundle-detector.ts
   */
  analyzeFromBundleData(bundleData: {
    freshWalletBuyers: number;
    sameBlockBuyers: number;
    distributionEvennessScore: number;
    clusteredWalletCount: number;
    deployerFundedBuyers: number;
  }): FreshWalletAnalysis {
    const organicIndicators: string[] = [];
    const sybilIndicators: string[] = [];

    // Uniform distribution = suspicious
    if (bundleData.distributionEvennessScore > 0.9) {
      sybilIndicators.push(`Very uniform distribution (${(bundleData.distributionEvennessScore * 100).toFixed(0)}%)`);
    } else if (bundleData.distributionEvennessScore < 0.5) {
      organicIndicators.push('Natural distribution pattern');
    }

    // Same-block buying
    if (bundleData.sameBlockBuyers >= 5) {
      sybilIndicators.push(`${bundleData.sameBlockBuyers} same-block buyers`);
    }

    // Clustered wallets
    if (bundleData.clusteredWalletCount >= 3) {
      sybilIndicators.push(`${bundleData.clusteredWalletCount} clustered wallets`);
    }

    // Deployer-funded buyers
    if (bundleData.deployerFundedBuyers >= 2) {
      sybilIndicators.push(`${bundleData.deployerFundedBuyers} deployer-funded buyers`);
    }

    // Fresh wallet ratio
    const totalEarlyBuyers = bundleData.sameBlockBuyers + bundleData.freshWalletBuyers;
    if (totalEarlyBuyers > 0) {
      const freshRatio = bundleData.freshWalletBuyers / totalEarlyBuyers;
      if (freshRatio > 0.8) {
        sybilIndicators.push(`${(freshRatio * 100).toFixed(0)}% fresh wallets`);
      } else if (freshRatio < 0.3) {
        organicIndicators.push('Low fresh wallet ratio — established buyers');
      }
    }

    const sybilScore = sybilIndicators.length;
    const organicScore = organicIndicators.length;

    let classification: FreshWalletClassification;
    let scoreAdjustment: number;
    let confidence: FreshWalletAnalysis['confidence'];

    if (sybilScore >= 3) {
      classification = 'SYBIL';
      scoreAdjustment = CONFIG.SYBIL_PENALTY;
      confidence = 'HIGH';
    } else if (sybilScore >= 2 && organicScore === 0) {
      classification = 'SYBIL';
      scoreAdjustment = CONFIG.SYBIL_PENALTY;
      confidence = 'MEDIUM';
    } else if (organicScore >= 2 && sybilScore === 0) {
      classification = 'ORGANIC';
      scoreAdjustment = CONFIG.ORGANIC_BONUS;
      confidence = 'MEDIUM';
    } else {
      classification = 'UNKNOWN';
      scoreAdjustment = 0;
      confidence = 'LOW';
    }

    return {
      classification,
      scoreAdjustment,
      totalFreshWallets: bundleData.freshWalletBuyers,
      organicIndicators,
      sybilIndicators,
      confidence,
    };
  }
}

// ============ EXPORTS ============

export const freshWalletAnalyzer = new FreshWalletAnalyzer();

export default {
  FreshWalletAnalyzer,
  freshWalletAnalyzer,
};
