// ===========================================
// MODULE: BUNDLE DETECTOR
// Detects bundled launches, insider allocations, and sniper activity
// INFORMATIONAL ONLY - findings are reported but NEVER used to block signals.
// Risk scores and flags are for logging/diagnostics; they do not gate trades.
// ===========================================

import { logger } from '../utils/logger.js';
import { heliusClient } from './onchain.js';
import { appConfig } from '../config/index.js';

// ============ TYPES ============

export interface BundleAnalysisResult {
  // Bundle Detection (informational only - never used to block signals)
  isBundled: boolean;               // Always false - kept for interface compat; never gates trades
  bundleConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

  // Metrics
  sameBlockBuyers: number;
  firstBlockBuyers: number;
  insiderSupplyPercent: number;     // % of supply held by suspected insiders
  clusteredWalletCount: number;     // Wallets buying in same block

  // Funding Analysis
  fundingSourceCount: number;       // Unique funding sources for early buyers
  deployerFundedBuyers: number;     // Buyers funded by deployer
  freshWalletBuyers: number;        // Brand new wallets buying

  // Risk Assessment (informational only - reported but never blocks signals)
  riskScore: number;                // 0-100 (higher = more risk) - informational only
  riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; // informational only
  flags: string[];                  // informational flags for logging

  // Details
  largestInsiderPercent: number;    // Largest single insider holding
  totalEarlyBuyers: number;
  timestamp: Date;
}

// ============ CONSTANTS ============

const THRESHOLDS = {
  // Same-block buying thresholds
  CRITICAL_SAME_BLOCK: 10,          // 10+ buyers in same block = critical
  HIGH_SAME_BLOCK: 5,               // 5+ = high risk
  MEDIUM_SAME_BLOCK: 3,             // 3+ = medium risk

  // Insider supply thresholds
  CRITICAL_INSIDER_SUPPLY: 60,      // >60% insider = critical (Focai example)
  HIGH_INSIDER_SUPPLY: 40,          // >40% = high risk
  MEDIUM_INSIDER_SUPPLY: 25,        // >25% = medium risk

  // Fresh wallet thresholds
  HIGH_FRESH_WALLET_RATIO: 0.7,     // >70% fresh wallets = suspicious
  MEDIUM_FRESH_WALLET_RATIO: 0.5,   // >50% = medium risk

  // Deployer funding thresholds
  HIGH_DEPLOYER_FUNDED: 5,          // 5+ buyers funded by deployer
  MEDIUM_DEPLOYER_FUNDED: 2,        // 2+ = medium risk

  // Timing thresholds
  EARLY_BLOCKS: 3,                  // First 3 blocks after creation
  SNIPER_WINDOW_MS: 2000,           // 2 seconds from creation
} as const;

// Known DEX program IDs for filtering
const DEX_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter V6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter V4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium V4
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca V2
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun
]);

// ============ BUNDLE DETECTOR CLASS ============

export class BundleDetector {
  private analysisCache: Map<string, { result: BundleAnalysisResult; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minute cache

  /**
   * Analyze a token for bundled launch characteristics
   */
  async analyze(tokenAddress: string): Promise<BundleAnalysisResult> {
    // Skip analysis when Helius is disabled - return safe defaults
    if (appConfig.heliusDisabled) {
      return this.createDefaultResult('Helius disabled - bundle analysis skipped');
    }

    try {
      // Check cache
      const cached = this.analysisCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        return cached.result;
      }

      // Get early transactions
      const txSignatures = await heliusClient.getRecentTransactions(tokenAddress, 100);

      if (!txSignatures || txSignatures.length === 0) {
        return this.createDefaultResult('No transactions found');
      }

      // Sort by slot (block number) to find earliest transactions
      const sortedTxs = [...txSignatures].sort((a, b) => a.slot - b.slot);
      const creationSlot = sortedTxs[0]?.slot || 0;

      // Analyze early transactions
      const earlyTxs = sortedTxs.filter(tx => tx.slot <= creationSlot + THRESHOLDS.EARLY_BLOCKS);

      // Get detailed transaction data for early txs
      const earlyDetails = await this.getTransactionDetails(earlyTxs.slice(0, 30));

      // Extract buyer wallets
      const buyerAnalysis = this.analyzeBuyers(earlyDetails, creationSlot);

      // Calculate insider supply percentage
      const insiderSupply = await this.estimateInsiderSupply(
        tokenAddress,
        buyerAnalysis.earlyBuyers
      );

      // Analyze funding patterns
      const fundingAnalysis = await this.analyzeFundingPatterns(
        buyerAnalysis.earlyBuyers
      );

      // Calculate risk score and determine result
      const result = this.calculateResult(
        buyerAnalysis,
        insiderSupply,
        fundingAnalysis
      );

      // Cache result
      this.analysisCache.set(tokenAddress, { result, timestamp: Date.now() });

      return result;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to analyze bundle');
      return this.createDefaultResult('Analysis failed');
    }
  }

  /**
   * Quick check if token shows obvious bundle characteristics
   * Faster than full analysis, good for pre-filtering
   */
  async quickBundleCheck(tokenAddress: string): Promise<{
    suspected: boolean;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  }> {
    // Skip check when Helius is disabled - return safe defaults
    if (appConfig.heliusDisabled) {
      return { suspected: false, confidence: 'LOW' };
    }

    try {
      const txSignatures = await heliusClient.getRecentTransactions(tokenAddress, 50);

      if (!txSignatures || txSignatures.length === 0) {
        return { suspected: false, confidence: 'LOW' };
      }

      // Count transactions in first few blocks
      const sortedTxs = [...txSignatures].sort((a, b) => a.slot - b.slot);
      const firstSlot = sortedTxs[0]?.slot || 0;

      const firstBlockTxs = sortedTxs.filter(tx => tx.slot === firstSlot).length;
      const earlyBlockTxs = sortedTxs.filter(tx => tx.slot <= firstSlot + 2).length;

      // Quick heuristics
      if (firstBlockTxs >= THRESHOLDS.CRITICAL_SAME_BLOCK) {
        return { suspected: true, confidence: 'HIGH' };
      }
      if (earlyBlockTxs >= THRESHOLDS.HIGH_SAME_BLOCK * 2) {
        return { suspected: true, confidence: 'HIGH' };
      }
      if (firstBlockTxs >= THRESHOLDS.HIGH_SAME_BLOCK) {
        return { suspected: true, confidence: 'MEDIUM' };
      }
      if (earlyBlockTxs >= THRESHOLDS.MEDIUM_SAME_BLOCK * 2) {
        return { suspected: true, confidence: 'MEDIUM' };
      }

      return { suspected: false, confidence: 'LOW' };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Quick bundle check failed');
      return { suspected: false, confidence: 'LOW' };
    }
  }

  // ============ ANALYSIS HELPERS ============

  private async getTransactionDetails(txSignatures: any[]): Promise<any[]> {
    const details: any[] = [];

    // Batch process transactions (parallel with rate limiting)
    const batchSize = 10;
    for (let i = 0; i < txSignatures.length; i += batchSize) {
      const batch = txSignatures.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(tx => heliusClient.getTransaction(tx.signature).catch(() => null))
      );
      details.push(...batchResults.filter(Boolean));
    }

    return details;
  }

  private analyzeBuyers(transactions: any[], creationSlot: number): {
    earlyBuyers: Set<string>;
    sameBlockBuyers: number;
    firstBlockBuyers: number;
    buyersBySlot: Map<number, string[]>;
  } {
    const earlyBuyers = new Set<string>();
    const buyersBySlot = new Map<number, string[]>();
    let sameBlockBuyers = 0;
    let firstBlockBuyers = 0;

    for (const tx of transactions) {
      if (!tx) continue;

      const slot = tx.slot;
      const accounts = tx.transaction?.message?.accountKeys || [];

      // Extract potential buyer (fee payer is typically first account)
      // For swaps, the buyer is usually the signer
      const signers = accounts
        .filter((acc: any) => acc.signer)
        .map((acc: any) => acc.pubkey);

      for (const signer of signers) {
        earlyBuyers.add(signer);

        if (!buyersBySlot.has(slot)) {
          buyersBySlot.set(slot, []);
        }
        buyersBySlot.get(slot)!.push(signer);
      }

      // Count first block buyers
      if (slot === creationSlot) {
        firstBlockBuyers += signers.length;
      }
    }

    // Calculate same-block buyers (max buyers in any single block)
    for (const [_slot, buyers] of buyersBySlot) {
      const uniqueBuyers = new Set(buyers).size;
      if (uniqueBuyers > sameBlockBuyers) {
        sameBlockBuyers = uniqueBuyers;
      }
    }

    return {
      earlyBuyers,
      sameBlockBuyers,
      firstBlockBuyers,
      buyersBySlot,
    };
  }

  private async estimateInsiderSupply(
    tokenAddress: string,
    earlyBuyers: Set<string>
  ): Promise<{
    insiderSupplyPercent: number;
    largestInsiderPercent: number;
  }> {
    try {
      const holderData = await heliusClient.getTokenHolders(tokenAddress);

      if (!holderData || holderData.topHolders.length === 0) {
        return { insiderSupplyPercent: 0, largestInsiderPercent: 0 };
      }

      // Check which top holders were early buyers
      let insiderSupply = 0;
      let largestInsider = 0;

      for (const holder of holderData.topHolders) {
        if (earlyBuyers.has(holder.address)) {
          insiderSupply += holder.percentage;
          if (holder.percentage > largestInsider) {
            largestInsider = holder.percentage;
          }
        }
      }

      return {
        insiderSupplyPercent: Math.round(insiderSupply * 10) / 10,
        largestInsiderPercent: Math.round(largestInsider * 10) / 10,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to estimate insider supply');
      return { insiderSupplyPercent: 0, largestInsiderPercent: 0 };
    }
  }

  private async analyzeFundingPatterns(earlyBuyers: Set<string>): Promise<{
    fundingSourceCount: number;
    deployerFundedBuyers: number;
    freshWalletBuyers: number;
  }> {
    // This would require deeper transaction analysis
    // For now, use heuristics based on early buyer count
    const buyerCount = earlyBuyers.size;

    return {
      fundingSourceCount: Math.ceil(buyerCount * 0.3), // Estimate 30% unique funding
      deployerFundedBuyers: Math.floor(buyerCount * 0.1), // Estimate 10% deployer funded
      freshWalletBuyers: Math.floor(buyerCount * 0.4), // Estimate 40% fresh wallets
    };
  }

  private calculateResult(
    buyerAnalysis: {
      earlyBuyers: Set<string>;
      sameBlockBuyers: number;
      firstBlockBuyers: number;
      buyersBySlot: Map<number, string[]>;
    },
    insiderSupply: {
      insiderSupplyPercent: number;
      largestInsiderPercent: number;
    },
    fundingAnalysis: {
      fundingSourceCount: number;
      deployerFundedBuyers: number;
      freshWalletBuyers: number;
    }
  ): BundleAnalysisResult {
    const flags: string[] = [];
    let riskScore = 0;

    // Same-block buyer risk
    if (buyerAnalysis.sameBlockBuyers >= THRESHOLDS.CRITICAL_SAME_BLOCK) {
      riskScore += 35;
      flags.push('CRITICAL_SAME_BLOCK_BUYING');
    } else if (buyerAnalysis.sameBlockBuyers >= THRESHOLDS.HIGH_SAME_BLOCK) {
      riskScore += 25;
      flags.push('HIGH_SAME_BLOCK_BUYING');
    } else if (buyerAnalysis.sameBlockBuyers >= THRESHOLDS.MEDIUM_SAME_BLOCK) {
      riskScore += 15;
      flags.push('MEDIUM_SAME_BLOCK_BUYING');
    }

    // Insider supply risk
    if (insiderSupply.insiderSupplyPercent >= THRESHOLDS.CRITICAL_INSIDER_SUPPLY) {
      riskScore += 35;
      flags.push('CRITICAL_INSIDER_CONCENTRATION');
    } else if (insiderSupply.insiderSupplyPercent >= THRESHOLDS.HIGH_INSIDER_SUPPLY) {
      riskScore += 25;
      flags.push('HIGH_INSIDER_CONCENTRATION');
    } else if (insiderSupply.insiderSupplyPercent >= THRESHOLDS.MEDIUM_INSIDER_SUPPLY) {
      riskScore += 15;
      flags.push('MEDIUM_INSIDER_CONCENTRATION');
    }

    // Deployer funding risk
    if (fundingAnalysis.deployerFundedBuyers >= THRESHOLDS.HIGH_DEPLOYER_FUNDED) {
      riskScore += 20;
      flags.push('DEPLOYER_FUNDED_SNIPERS');
    } else if (fundingAnalysis.deployerFundedBuyers >= THRESHOLDS.MEDIUM_DEPLOYER_FUNDED) {
      riskScore += 10;
      flags.push('SOME_DEPLOYER_FUNDING');
    }

    // Fresh wallet risk
    const freshWalletRatio = fundingAnalysis.freshWalletBuyers / Math.max(1, buyerAnalysis.earlyBuyers.size);
    if (freshWalletRatio >= THRESHOLDS.HIGH_FRESH_WALLET_RATIO) {
      riskScore += 15;
      flags.push('HIGH_FRESH_WALLET_RATIO');
    } else if (freshWalletRatio >= THRESHOLDS.MEDIUM_FRESH_WALLET_RATIO) {
      riskScore += 8;
      flags.push('ELEVATED_FRESH_WALLETS');
    }

    // Determine bundle confidence and risk level
    riskScore = Math.min(100, riskScore);

    let bundleConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
    let riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

    if (riskScore >= 70) {
      bundleConfidence = 'HIGH';
      riskLevel = 'CRITICAL';
    } else if (riskScore >= 50) {
      bundleConfidence = 'HIGH';
      riskLevel = 'HIGH';
    } else if (riskScore >= 30) {
      bundleConfidence = 'MEDIUM';
      riskLevel = 'MEDIUM';
    } else if (riskScore >= 15) {
      bundleConfidence = 'LOW';
      riskLevel = 'LOW';
    } else {
      bundleConfidence = 'NONE';
      riskLevel = 'LOW';
    }

    return {
      // INFORMATIONAL ONLY: isBundled is always false - bundle data never blocks signals.
      // Risk score is still calculated and reported for logging/diagnostics.
      isBundled: false,
      bundleConfidence,
      sameBlockBuyers: buyerAnalysis.sameBlockBuyers,
      firstBlockBuyers: buyerAnalysis.firstBlockBuyers,
      insiderSupplyPercent: insiderSupply.insiderSupplyPercent,
      clusteredWalletCount: buyerAnalysis.sameBlockBuyers,
      fundingSourceCount: fundingAnalysis.fundingSourceCount,
      deployerFundedBuyers: fundingAnalysis.deployerFundedBuyers,
      freshWalletBuyers: fundingAnalysis.freshWalletBuyers,
      riskScore,
      riskLevel,
      flags,
      largestInsiderPercent: insiderSupply.largestInsiderPercent,
      totalEarlyBuyers: buyerAnalysis.earlyBuyers.size,
      timestamp: new Date(),
    };
  }

  private createDefaultResult(reason: string): BundleAnalysisResult {
    return {
      isBundled: false,
      bundleConfidence: 'NONE',
      sameBlockBuyers: 0,
      firstBlockBuyers: 0,
      insiderSupplyPercent: 0,
      clusteredWalletCount: 0,
      fundingSourceCount: 0,
      deployerFundedBuyers: 0,
      freshWalletBuyers: 0,
      riskScore: 0,
      riskLevel: 'LOW',
      flags: [reason],
      largestInsiderPercent: 0,
      totalEarlyBuyers: 0,
      timestamp: new Date(),
    };
  }

  /**
   * Clear the analysis cache
   */
  clearCache(): void {
    this.analysisCache.clear();
  }
}

// ============ EXPORTS ============

export const bundleDetector = new BundleDetector();

export default {
  BundleDetector,
  bundleDetector,
  THRESHOLDS,
};
