// ===========================================
// MODULE: INSIDER DETECTOR (Feature 5)
// Same-Block Sniper Detection & Insider Filter
// ===========================================

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { InsiderAnalysis } from '../../types/index.js';

// ============ CONSTANTS ============

const INSIDER_RISK_THRESHOLD = 70;
const SAME_BLOCK_BUYERS_WARNING = 3;
const DEPLOYER_FUNDED_WARNING = 2;
const FUNDING_LOOKBACK_HOURS = 24;

// Known DEX program IDs for filtering
const DEX_PROGRAM_IDS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
];

// ============ INSIDER DETECTOR CLASS ============

export class InsiderDetector {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(appConfig.heliusRpcUrl, 'confirmed');
  }

  /**
   * Perform comprehensive insider analysis on a token
   */
  async analyzeToken(tokenMint: string): Promise<InsiderAnalysis> {
    logger.info({ tokenMint }, 'Starting insider analysis');

    const result: InsiderAnalysis = {
      sameBlockBuyers: 0,
      deployerFundedBuyers: 0,
      suspiciousPatterns: [],
      insiderRiskScore: 0,
    };

    try {
      // 1. Get token creation details
      const creationInfo = await this.getTokenCreationInfo(tokenMint);
      if (!creationInfo) {
        logger.warn({ tokenMint }, 'Could not get token creation info');
        return result;
      }

      // 2. Analyze same-block buyers
      const sameBlockAnalysis = await this.analyzeSameBlockBuyers(
        tokenMint,
        creationInfo.slot,
        creationInfo.signature
      );
      result.sameBlockBuyers = sameBlockAnalysis.count;
      if (sameBlockAnalysis.suspicious) {
        result.suspiciousPatterns.push(...sameBlockAnalysis.patterns);
        result.insiderRiskScore += sameBlockAnalysis.riskContribution;
      }

      // 3. Analyze deployer-funded buyers
      const deployerFundedAnalysis = await this.analyzeDeployerFundedBuyers(
        tokenMint,
        creationInfo.deployer
      );
      result.deployerFundedBuyers = deployerFundedAnalysis.count;
      if (deployerFundedAnalysis.suspicious) {
        result.suspiciousPatterns.push(...deployerFundedAnalysis.patterns);
        result.insiderRiskScore += deployerFundedAnalysis.riskContribution;
      }

      // 4. Check for suspicious timing patterns
      const timingAnalysis = await this.analyzeTimingPatterns(
        tokenMint,
        creationInfo.timestamp
      );
      if (timingAnalysis.suspicious) {
        result.suspiciousPatterns.push(...timingAnalysis.patterns);
        result.insiderRiskScore += timingAnalysis.riskContribution;
      }

      // Cap the risk score at 100
      result.insiderRiskScore = Math.min(100, result.insiderRiskScore);

      logger.info({
        tokenMint,
        insiderRiskScore: result.insiderRiskScore,
        sameBlockBuyers: result.sameBlockBuyers,
        deployerFundedBuyers: result.deployerFundedBuyers,
        patterns: result.suspiciousPatterns,
      }, 'Insider analysis complete');

      return result;
    } catch (error) {
      logger.error({ error, tokenMint }, 'Error in insider analysis');
      return result;
    }
  }

  /**
   * Check if token should be blocked due to insider risk
   */
  shouldBlockForInsiderRisk(analysis: InsiderAnalysis): boolean {
    return analysis.insiderRiskScore > INSIDER_RISK_THRESHOLD;
  }

  /**
   * Get token creation information
   */
  private async getTokenCreationInfo(tokenMint: string): Promise<{
    signature: string;
    slot: number;
    timestamp: number;
    deployer: string;
  } | null> {
    try {
      const mintPubkey = new PublicKey(tokenMint);

      // Get the oldest transaction (creation)
      const signatures = await this.connection.getSignaturesForAddress(
        mintPubkey,
        { limit: 100 },
        'confirmed'
      );

      if (signatures.length === 0) {
        return null;
      }

      // Get the oldest (creation) transaction
      const creationSig = signatures[signatures.length - 1];

      if (!creationSig.slot || !creationSig.blockTime) {
        return null;
      }

      // Get the full transaction to find deployer
      const tx = await this.connection.getParsedTransaction(
        creationSig.signature,
        { maxSupportedTransactionVersion: 0 }
      );

      if (!tx || !tx.transaction.message.accountKeys.length) {
        return null;
      }

      // First account is typically the fee payer (deployer)
      const deployer = tx.transaction.message.accountKeys[0].pubkey.toString();

      return {
        signature: creationSig.signature,
        slot: creationSig.slot,
        timestamp: creationSig.blockTime,
        deployer,
      };
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to get token creation info');
      return null;
    }
  }

  /**
   * Analyze buyers in the same block as creation
   */
  private async analyzeSameBlockBuyers(
    tokenMint: string,
    creationSlot: number,
    creationSignature: string
  ): Promise<{
    count: number;
    suspicious: boolean;
    patterns: string[];
    riskContribution: number;
  }> {
    const result = {
      count: 0,
      suspicious: false,
      patterns: [] as string[],
      riskContribution: 0,
    };

    try {
      const mintPubkey = new PublicKey(tokenMint);

      // Get transactions within the same block + next 2 blocks
      const signatures = await this.connection.getSignaturesForAddress(
        mintPubkey,
        { limit: 100 },
        'confirmed'
      );

      // Filter to early transactions (same block + next 2)
      const earlyTxs = signatures.filter(sig => {
        if (!sig.slot) return false;
        return sig.slot <= creationSlot + 2 && sig.signature !== creationSignature;
      });

      result.count = earlyTxs.length;

      // Flag if too many buyers in the same block
      if (result.count > SAME_BLOCK_BUYERS_WARNING) {
        result.suspicious = true;
        result.patterns.push(`${result.count} wallets bought within first 2 blocks of creation`);
        result.riskContribution = Math.min(40, result.count * 10);
      }

      // Check if same-block transactions came from unique wallets
      if (earlyTxs.length > 0) {
        const uniqueBuyers = new Set<string>();

        for (const sig of earlyTxs.slice(0, 10)) {
          try {
            const tx = await this.connection.getParsedTransaction(
              sig.signature,
              { maxSupportedTransactionVersion: 0 }
            );

            if (tx && tx.transaction.message.accountKeys.length > 0) {
              const buyer = tx.transaction.message.accountKeys[0].pubkey.toString();
              uniqueBuyers.add(buyer);
            }
          } catch {
            // Skip failed tx fetches
          }
        }

        // If all early buys came from few unique wallets, it's more suspicious
        if (uniqueBuyers.size < result.count / 2 && result.count > 5) {
          result.patterns.push('Same wallets made multiple early buys');
          result.riskContribution += 15;
        }
      }

      return result;
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to analyze same-block buyers');
      return result;
    }
  }

  /**
   * Analyze if early buyers were funded by the deployer
   */
  private async analyzeDeployerFundedBuyers(
    tokenMint: string,
    deployerAddress: string
  ): Promise<{
    count: number;
    suspicious: boolean;
    patterns: string[];
    riskContribution: number;
  }> {
    const result = {
      count: 0,
      suspicious: false,
      patterns: [] as string[],
      riskContribution: 0,
    };

    try {
      const mintPubkey = new PublicKey(tokenMint);
      const deployerPubkey = new PublicKey(deployerAddress);

      // Get early token transactions
      const tokenSigs = await this.connection.getSignaturesForAddress(
        mintPubkey,
        { limit: 20 },
        'confirmed'
      );

      // Get deployer's recent outgoing SOL transfers
      const deployerSigs = await this.connection.getSignaturesForAddress(
        deployerPubkey,
        { limit: 100 },
        'confirmed'
      );

      const lookbackTime = Math.floor(Date.now() / 1000) - (FUNDING_LOOKBACK_HOURS * 60 * 60);

      // Find wallets that received SOL from deployer recently
      const fundedWallets = new Set<string>();

      for (const sig of deployerSigs) {
        if (sig.blockTime && sig.blockTime < lookbackTime) continue;

        try {
          const tx = await this.connection.getParsedTransaction(
            sig.signature,
            { maxSupportedTransactionVersion: 0 }
          );

          if (!tx) continue;

          // Check for SOL transfers from deployer
          for (const instruction of tx.transaction.message.instructions) {
            if ('parsed' in instruction && instruction.parsed?.type === 'transfer') {
              const info = instruction.parsed.info;
              if (info.source === deployerAddress && info.destination) {
                fundedWallets.add(info.destination);
              }
            }
          }
        } catch {
          // Skip failed tx fetches
        }
      }

      // Check if any early token buyers were funded by deployer
      for (const sig of tokenSigs.slice(0, 10)) {
        try {
          const tx = await this.connection.getParsedTransaction(
            sig.signature,
            { maxSupportedTransactionVersion: 0 }
          );

          if (tx && tx.transaction.message.accountKeys.length > 0) {
            const buyer = tx.transaction.message.accountKeys[0].pubkey.toString();
            if (fundedWallets.has(buyer)) {
              result.count++;
            }
          }
        } catch {
          // Skip failed tx fetches
        }
      }

      if (result.count >= DEPLOYER_FUNDED_WARNING) {
        result.suspicious = true;
        result.patterns.push(`${result.count} early buyers received SOL from deployer in last 24h`);
        result.riskContribution = Math.min(35, result.count * 15);
      }

      return result;
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to analyze deployer-funded buyers');
      return result;
    }
  }

  /**
   * Analyze timing patterns for suspicious coordinated buying
   */
  private async analyzeTimingPatterns(
    tokenMint: string,
    creationTimestamp: number
  ): Promise<{
    suspicious: boolean;
    patterns: string[];
    riskContribution: number;
  }> {
    const result = {
      suspicious: false,
      patterns: [] as string[],
      riskContribution: 0,
    };

    try {
      const mintPubkey = new PublicKey(tokenMint);

      // Get early transactions
      const signatures = await this.connection.getSignaturesForAddress(
        mintPubkey,
        { limit: 50 },
        'confirmed'
      );

      if (signatures.length < 5) {
        return result;
      }

      // Analyze time gaps between early transactions
      const earlyTxs = signatures
        .filter(sig => sig.blockTime)
        .sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0))
        .slice(0, 20);

      // Check for bursts of activity (many txs in short time)
      const timeGaps: number[] = [];
      for (let i = 1; i < earlyTxs.length; i++) {
        const gap = (earlyTxs[i].blockTime || 0) - (earlyTxs[i - 1].blockTime || 0);
        timeGaps.push(gap);
      }

      // Count very short gaps (< 5 seconds)
      const shortGaps = timeGaps.filter(gap => gap < 5).length;
      if (shortGaps > earlyTxs.length * 0.5) {
        result.suspicious = true;
        result.patterns.push('Coordinated rapid buying pattern detected');
        result.riskContribution = 20;
      }

      // Check for suspiciously uniform timing
      const avgGap = timeGaps.reduce((a, b) => a + b, 0) / timeGaps.length;
      const variance = timeGaps.reduce((sum, gap) => sum + Math.pow(gap - avgGap, 2), 0) / timeGaps.length;
      const stdDev = Math.sqrt(variance);

      // Very low variance in timing suggests bot/scripted activity
      if (avgGap < 10 && stdDev < 2 && earlyTxs.length > 10) {
        result.suspicious = true;
        result.patterns.push('Bot-like uniform buying timing');
        result.riskContribution += 15;
      }

      return result;
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to analyze timing patterns');
      return result;
    }
  }
}

// ============ EXPORTS ============

export const insiderDetector = new InsiderDetector();

export default {
  InsiderDetector,
  insiderDetector,
  INSIDER_RISK_THRESHOLD,
};
