// ===========================================
// MODULE 1C: SCAM FILTERING PIPELINE
// ===========================================

import { analyzeTokenContract, analyzeBundles, analyzeDevWallet, getTokenMetrics } from './onchain.js';
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

  // Mint authority - new pump.fun tokens legitimately have mint authority briefly
  MINT_AUTHORITY_AGE_THRESHOLD_MINS: 30,
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

    // Pre-check: Get token age for mint authority evaluation
    const tokenMetrics = await getTokenMetrics(tokenAddress);
    const tokenAgeMins = tokenMetrics?.tokenAge ?? undefined;

    // Stage 0: Honeypot Detection (absolute deal-breaker - can't sell)
    const isHoneypot = await this.checkHoneypot(tokenAddress);
    if (isHoneypot) {
      flags.push('HONEYPOT: Token cannot be sold - confirmed honeypot');
      return this.buildOutput(ScamFilterResult.REJECT, flags);
    }

    // Stage 1: Contract Analysis
    const contractAnalysis = await analyzeTokenContract(tokenAddress);
    const contractResult = this.evaluateContract(contractAnalysis, flags, tokenAgeMins);
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
    // 3+ rug wallets is now a REJECT — too many known bad actors
    const rugHistoryCount = await this.checkRugHistory(tokenAddress);
    if (rugHistoryCount >= THRESHOLDS.RUG_HISTORY_REJECT_COUNT) {
      flags.push(`RUG_HISTORY_HIGH: ${rugHistoryCount} wallets with prior rug involvement`);
      return this.buildOutput(ScamFilterResult.REJECT, flags, contractAnalysis, bundleAnalysis, devBehaviour, rugHistoryCount);
    } else if (rugHistoryCount >= THRESHOLDS.RUG_HISTORY_FLAG_COUNT) {
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
    flags: string[],
    tokenAgeMins?: number
  ): ScamFilterResult {
    let result: ScamFilterResult = ScamFilterResult.PASS;

    // Known scam template is instant reject (absolute deal-breaker)
    if (analysis.isKnownScamTemplate) {
      flags.push('SCAM_TEMPLATE: Contract matches known scam pattern');
      return ScamFilterResult.REJECT;
    }

    // Mint authority check:
    // - REJECT only if token is older than 30 minutes (new pump.fun tokens legitimately have it briefly)
    // - FLAG if token is new or age is unknown
    if (!analysis.mintAuthorityRevoked) {
      if (tokenAgeMins !== undefined && tokenAgeMins > THRESHOLDS.MINT_AUTHORITY_AGE_THRESHOLD_MINS) {
        flags.push(`MINT_AUTHORITY: Not revoked after ${tokenAgeMins.toFixed(0)} mins - tokens can still be minted`);
        return ScamFilterResult.REJECT;
      }
      flags.push('MINT_AUTHORITY: Not yet revoked - tokens can be minted (new token, monitoring)');
      result = ScamFilterResult.FLAG;
    }

    // Freeze authority - FLAG only (informational)
    if (!analysis.freezeAuthorityRevoked) {
      flags.push('FREEZE_AUTHORITY: Not revoked - tokens can be frozen');
      result = ScamFilterResult.FLAG;
    }

    // Mutable metadata is a flag
    if (analysis.metadataMutable) {
      flags.push('METADATA_MUTABLE: Token metadata can be changed');
      result = ScamFilterResult.FLAG;
    }

    return result;
  }
  
  /**
   * Stage 2: Evaluate bundle analysis
   */
  private evaluateBundles(
    analysis: BundleAnalysis,
    flags: string[]
  ): ScamFilterResult {
    // High risk with rug history - REJECT (strong rug signal)
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
    // Transfer to CEX combined with high selling is a REJECT (clear rug pattern)
    if (behaviour.transferredToCex && behaviour.soldPercent48h >= THRESHOLDS.DEV_SELL_HIGH_RISK_PERCENT) {
      flags.push(`DEV_RUG_PATTERN: Dev sold ${behaviour.soldPercent48h.toFixed(1)}% AND transferred to CEX`);
      return ScamFilterResult.REJECT;
    }

    // Transfer to CEX alone is a FLAG (could be legitimate but suspicious)
    if (behaviour.transferredToCex) {
      flags.push(`DEV_CEX_TRANSFER: Dev wallet transferred to CEX`);
      return ScamFilterResult.FLAG;
    }

    // Very high sell percent (>30%) is a REJECT — dev is dumping
    if (behaviour.soldPercent48h >= 30) {
      flags.push(`DEV_DUMP_HARD: Dev sold ${behaviour.soldPercent48h.toFixed(1)}% within 48h - likely rug`);
      return ScamFilterResult.REJECT;
    }

    // High sell percent - FLAG (informational warning)
    if (behaviour.soldPercent48h >= THRESHOLDS.DEV_SELL_HIGH_RISK_PERCENT) {
      flags.push(`DEV_DUMP: Dev sold ${behaviour.soldPercent48h.toFixed(1)}% within 48h`);
      return ScamFilterResult.FLAG;
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
   * Honeypot Detection: Check if token can actually be sold
   * This is an absolute deal-breaker - instant reject if confirmed
   * In production, this should simulate a sell transaction (e.g., via Jupiter quote)
   */
  private async checkHoneypot(tokenAddress: string): Promise<boolean> {
    try {
      // TODO: Integrate with honeypot detection service
      // Production implementation should:
      // 1. Attempt a simulated sell via Jupiter to confirm token is sellable
      // 2. Check for transfer restrictions in the token program
      // 3. Verify sell transactions exist on-chain
      logger.debug({ tokenAddress }, 'Checking honeypot status');
      return false;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Honeypot check failed');
      return false; // Fail open - don't block if check itself fails
    }
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
  warnings?: string[];
}> {
  try {
    const warnings: string[] = [];

    // Just check contract basics
    const contractAnalysis = await analyzeTokenContract(tokenAddress);

    // Known scam template is a hard reject (absolute deal-breaker)
    if (contractAnalysis.isKnownScamTemplate) {
      logger.info({ tokenAddress }, 'Quick check FAIL: Known scam template');
      return { pass: false, reason: 'Known scam contract template' };
    }

    // Mint authority - flag only, don't block (new pump.fun tokens have it briefly)
    if (!contractAnalysis.mintAuthorityRevoked) {
      logger.info({ tokenAddress }, 'Quick check FLAG: Mint authority not revoked');
      warnings.push('Mint authority not revoked (may be new token)');
    }

    // Freeze authority - flag only, not a hard block
    if (!contractAnalysis.freezeAuthorityRevoked) {
      logger.info({ tokenAddress }, 'Quick check FLAG: Freeze authority not revoked');
      warnings.push('Freeze authority not revoked');
    }

    logger.info({ tokenAddress, warnings }, 'Quick check PASS');
    return { pass: true, warnings: warnings.length > 0 ? warnings : undefined };
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
