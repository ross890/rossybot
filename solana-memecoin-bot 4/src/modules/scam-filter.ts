// ===========================================
// MODULE 1C: SCAM FILTERING PIPELINE
// ===========================================

import { analyzeTokenContract, analyzeBundles, analyzeDevWallet } from './onchain.js';
import { Database } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import {
  ScamFilterResult,
  ScamFilterOutput,
  TokenContractAnalysis,
  BundleAnalysis,
  DevWalletBehaviour,
} from '../types/index.js';

// ============ SCAM FILTER THRESHOLDS ============

const THRESHOLDS = {
  // Bundle analysis
  BUNDLE_HIGH_RISK_SUPPLY_PERCENT: 25,
  BUNDLE_MEDIUM_RISK_SUPPLY_PERCENT: 10,
  
  // Dev wallet behaviour
  DEV_SELL_HIGH_RISK_PERCENT: 10,
  DEV_SELL_FLAG_PERCENT: 5,
  
  // Holder analysis
  RUG_HISTORY_REJECT_COUNT: 3,
  RUG_HISTORY_FLAG_COUNT: 1,
  
  // Liquidity
  MIN_LIQUIDITY_FOR_TRADE: 5000,
} as const;

// ============ SCAM FILTER CLASS ============

export class ScamFilter {
  /**
   * Run the complete scam filtering pipeline
   * Returns PASS, FLAG, or REJECT with detailed analysis
   */
  async filterToken(tokenAddress: string): Promise<ScamFilterOutput> {
    const flags: string[] = [];
    let result: ScamFilterResult = ScamFilterResult.PASS;
    
    logger.debug({ tokenAddress }, 'Running scam filter');
    
    // Stage 1: Contract Analysis
    const contractAnalysis = await analyzeTokenContract(tokenAddress);
    const contractResult = this.evaluateContract(contractAnalysis, flags);
    if (contractResult === ScamFilterResult.REJECT) {
      return this.buildOutput(ScamFilterResult.REJECT, flags, contractAnalysis);
    }
    if (contractResult === ScamFilterResult.FLAG) {
      result = ScamFilterResult.FLAG;
    }
    
    // Stage 2: Bundle Analysis
    const bundleAnalysis = await analyzeBundles(tokenAddress);
    const bundleResult = this.evaluateBundles(bundleAnalysis, flags);
    if (bundleResult === ScamFilterResult.REJECT) {
      return this.buildOutput(ScamFilterResult.REJECT, flags, contractAnalysis, bundleAnalysis);
    }
    if (bundleResult === ScamFilterResult.FLAG) {
      result = ScamFilterResult.FLAG;
    }
    
    // Stage 3: Dev Wallet Behaviour
    const devBehaviour = await analyzeDevWallet(tokenAddress);
    if (devBehaviour) {
      const devResult = this.evaluateDevBehaviour(devBehaviour, flags);
      if (devResult === ScamFilterResult.REJECT) {
        return this.buildOutput(ScamFilterResult.REJECT, flags, contractAnalysis, bundleAnalysis, devBehaviour);
      }
      if (devResult === ScamFilterResult.FLAG) {
        result = ScamFilterResult.FLAG;
      }
    }
    
    // Stage 4: Rug History Check (on top holders)
    const rugHistoryCount = await this.checkRugHistory(tokenAddress);
    if (rugHistoryCount >= THRESHOLDS.RUG_HISTORY_REJECT_COUNT) {
      flags.push(`RUG_HISTORY: ${rugHistoryCount} wallets with prior rug involvement`);
      return this.buildOutput(ScamFilterResult.REJECT, flags, contractAnalysis, bundleAnalysis, devBehaviour, rugHistoryCount);
    }
    if (rugHistoryCount >= THRESHOLDS.RUG_HISTORY_FLAG_COUNT) {
      flags.push(`RUG_HISTORY: ${rugHistoryCount} wallet(s) with prior rug involvement`);
      result = ScamFilterResult.FLAG;
    }
    
    logger.debug({ tokenAddress, result, flags }, 'Scam filter complete');
    
    return this.buildOutput(result, flags, contractAnalysis, bundleAnalysis, devBehaviour, rugHistoryCount);
  }
  
  /**
   * Stage 1: Evaluate token contract
   */
  private evaluateContract(
    analysis: TokenContractAnalysis,
    flags: string[]
  ): ScamFilterResult {
    // Mint authority must be revoked
    if (!analysis.mintAuthorityRevoked) {
      flags.push('MINT_AUTHORITY: Not revoked - tokens can be minted');
      return ScamFilterResult.REJECT;
    }
    
    // Freeze authority must be revoked
    if (!analysis.freezeAuthorityRevoked) {
      flags.push('FREEZE_AUTHORITY: Not revoked - tokens can be frozen');
      return ScamFilterResult.REJECT;
    }
    
    // Known scam template is instant reject
    if (analysis.isKnownScamTemplate) {
      flags.push('SCAM_TEMPLATE: Contract matches known scam pattern');
      return ScamFilterResult.REJECT;
    }
    
    // Mutable metadata is a flag (not reject)
    if (analysis.metadataMutable) {
      flags.push('METADATA_MUTABLE: Token metadata can be changed');
      return ScamFilterResult.FLAG;
    }
    
    return ScamFilterResult.PASS;
  }
  
  /**
   * Stage 2: Evaluate bundle analysis
   */
  private evaluateBundles(
    analysis: BundleAnalysis,
    flags: string[]
  ): ScamFilterResult {
    // High risk with rug history is instant reject
    if (analysis.riskLevel === 'HIGH' && analysis.hasRugHistory) {
      flags.push(`BUNDLE_RUG: ${analysis.bundledSupplyPercent.toFixed(1)}% bundled supply with rug history wallets`);
      return ScamFilterResult.REJECT;
    }
    
    // High bundled supply is a flag
    if (analysis.bundledSupplyPercent >= THRESHOLDS.BUNDLE_HIGH_RISK_SUPPLY_PERCENT) {
      flags.push(`BUNDLE_HIGH: ${analysis.bundledSupplyPercent.toFixed(1)}% supply in bundled wallets`);
      return ScamFilterResult.FLAG;
    }
    
    // Medium bundled supply with overlap is a flag
    if (
      analysis.bundledSupplyPercent >= THRESHOLDS.BUNDLE_MEDIUM_RISK_SUPPLY_PERCENT ||
      analysis.fundingOverlapDetected
    ) {
      flags.push(`BUNDLE_MEDIUM: ${analysis.bundledSupplyPercent.toFixed(1)}% bundled, funding overlap: ${analysis.fundingOverlapDetected}`);
      return ScamFilterResult.FLAG;
    }
    
    return ScamFilterResult.PASS;
  }
  
  /**
   * Stage 3: Evaluate dev wallet behaviour
   */
  private evaluateDevBehaviour(
    behaviour: DevWalletBehaviour,
    flags: string[]
  ): ScamFilterResult {
    // Transfer to CEX is suspicious
    if (behaviour.transferredToCex) {
      flags.push(`DEV_CEX_TRANSFER: Dev wallet transferred to CEX`);
      return ScamFilterResult.REJECT;
    }
    
    // High sell percent is a reject
    if (behaviour.soldPercent48h >= THRESHOLDS.DEV_SELL_HIGH_RISK_PERCENT) {
      flags.push(`DEV_DUMP: Dev sold ${behaviour.soldPercent48h.toFixed(1)}% within 48h`);
      return ScamFilterResult.REJECT;
    }
    
    // Moderate sell is a flag
    if (behaviour.soldPercent48h >= THRESHOLDS.DEV_SELL_FLAG_PERCENT) {
      flags.push(`DEV_SELLING: Dev sold ${behaviour.soldPercent48h.toFixed(1)}% within 48h`);
      return ScamFilterResult.FLAG;
    }
    
    // Bridge activity is suspicious
    if (behaviour.bridgeActivity) {
      flags.push(`DEV_BRIDGE: Dev wallet has bridge activity`);
      return ScamFilterResult.FLAG;
    }
    
    return ScamFilterResult.PASS;
  }
  
  /**
   * Stage 4: Check top holders against rug database
   */
  private async checkRugHistory(tokenAddress: string): Promise<number> {
    try {
      // Get top 20 holders
      // Uses Helius for holder data (included in plan)
      // Simplified implementation - in production, get actual holder list
      const topHolders: string[] = [];
      
      let rugCount = 0;
      for (const holder of topHolders) {
        if (await Database.isRugWallet(holder)) {
          rugCount++;
        }
      }
      
      return rugCount;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to check rug history');
      return 0;
    }
  }
  
  /**
   * Build the final output object
   */
  private buildOutput(
    result: ScamFilterResult,
    flags: string[],
    contractAnalysis?: TokenContractAnalysis,
    bundleAnalysis?: BundleAnalysis,
    devBehaviour?: DevWalletBehaviour | null,
    rugHistoryCount: number = 0
  ): ScamFilterOutput {
    return {
      result,
      flags,
      contractAnalysis: contractAnalysis || {
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        metadataMutable: true,
        isKnownScamTemplate: false,
      },
      bundleAnalysis: bundleAnalysis || {
        bundleDetected: false,
        bundledSupplyPercent: 0,
        clusteredWalletCount: 0,
        fundingOverlapDetected: false,
        hasRugHistory: false,
        riskLevel: 'LOW',
      },
      devBehaviour: devBehaviour || null,
      rugHistoryWallets: rugHistoryCount,
    };
  }
}

// ============ QUICK CHECKS ============

/**
 * Quick pre-screening check (faster than full filter)
 * Use for initial candidate filtering before detailed analysis
 */
export async function quickScamCheck(tokenAddress: string): Promise<{
  pass: boolean;
  reason?: string;
}> {
  try {
    // Just check contract basics
    const contractAnalysis = await analyzeTokenContract(tokenAddress);

    if (!contractAnalysis.mintAuthorityRevoked) {
      logger.info({ tokenAddress }, 'Quick check FAIL: Mint authority not revoked');
      return { pass: false, reason: 'Mint authority not revoked' };
    }

    if (!contractAnalysis.freezeAuthorityRevoked) {
      logger.info({ tokenAddress }, 'Quick check FAIL: Freeze authority not revoked');
      return { pass: false, reason: 'Freeze authority not revoked' };
    }

    if (contractAnalysis.isKnownScamTemplate) {
      logger.info({ tokenAddress }, 'Quick check FAIL: Known scam template');
      return { pass: false, reason: 'Known scam contract template' };
    }

    logger.info({ tokenAddress }, 'Quick check PASS');
    return { pass: true };
  } catch (error) {
    logger.error({ error, tokenAddress }, 'Quick scam check failed with exception');
    return { pass: false, reason: 'Check failed - treating as suspicious' };
  }
}

// ============ EXPORTS ============

export const scamFilter = new ScamFilter();

export default {
  ScamFilter,
  scamFilter,
  quickScamCheck,
  THRESHOLDS,
};
