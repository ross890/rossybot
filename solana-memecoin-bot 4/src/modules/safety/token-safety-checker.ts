// ===========================================
// MODULE: TOKEN SAFETY CHECKER (Feature 1)
// ===========================================

import { Connection, PublicKey } from '@solana/web3.js';
import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import type { TokenSafetyResult, InsiderAnalysis } from '../../types/index.js';

// ============ CONSTANTS ============

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_SAFETY_SCORE_THRESHOLD = 40;
const RUGCHECK_API_BASE = 'https://api.rugcheck.xyz/v1';

// ============ TOKEN SAFETY CHECKER CLASS ============

export class TokenSafetyChecker {
  private connection: Connection;
  private cache: Map<string, { result: TokenSafetyResult; expiry: number }> = new Map();

  constructor() {
    this.connection = new Connection(appConfig.heliusRpcUrl, 'confirmed');
  }

  /**
   * Perform comprehensive safety check on a token
   */
  async checkTokenSafety(tokenMint: string): Promise<TokenSafetyResult> {
    // Check in-memory cache first
    const cached = this.cache.get(tokenMint);
    if (cached && cached.expiry > Date.now()) {
      logger.debug({ tokenMint }, 'Token safety result from cache');
      return cached.result;
    }

    // Check database cache
    const dbCached = await this.getFromDbCache(tokenMint);
    if (dbCached) {
      this.cache.set(tokenMint, { result: dbCached, expiry: Date.now() + CACHE_TTL_MS });
      return dbCached;
    }

    logger.info({ tokenMint }, 'Running token safety check');

    const flags: string[] = [];
    let safetyScore = 100;

    // 1. Check mint and freeze authority
    const { mintAuthorityEnabled, freezeAuthorityEnabled } = await this.checkMintAuthorities(tokenMint);
    if (mintAuthorityEnabled) {
      flags.push('MINT_AUTHORITY_ENABLED');
      safetyScore -= 25;
    }
    if (freezeAuthorityEnabled) {
      flags.push('FREEZE_AUTHORITY_ENABLED');
      safetyScore -= 20;
    }

    // 2. Check holder concentration
    const { top10HolderConcentration, deployerHolding } = await this.checkHolderConcentration(tokenMint);
    if (top10HolderConcentration > 50) {
      flags.push('HIGH_TOP10_CONCENTRATION');
      safetyScore -= 15;
    }
    if (deployerHolding > 10) {
      flags.push('HIGH_DEPLOYER_HOLDING');
      safetyScore -= 10;
    }

    // 3. Get token age
    const tokenAgeMins = await this.getTokenAge(tokenMint);
    if (tokenAgeMins < 30) {
      flags.push('VERY_NEW_TOKEN');
      safetyScore -= 10;
    }

    // 4. Check LP status
    const { lpLocked, lpLockDuration } = await this.checkLpStatus(tokenMint);
    if (!lpLocked) {
      flags.push('LP_NOT_LOCKED');
      safetyScore -= 15;
    }

    // 5. Get RugCheck score
    const rugCheckScore = await this.getRugCheckScore(tokenMint);
    if (rugCheckScore !== null) {
      if (rugCheckScore < 50) {
        flags.push('LOW_RUGCHECK_SCORE');
        safetyScore -= 15;
      } else if (rugCheckScore < 70) {
        flags.push('MEDIUM_RUGCHECK_SCORE');
        safetyScore -= 5;
      }
    }

    // 6. Check honeypot risk (can token be sold)
    const honeypotRisk = await this.checkHoneypotRisk(tokenMint);
    if (honeypotRisk) {
      flags.push('HONEYPOT_RISK');
      safetyScore -= 30;
    }

    // 7. Run insider detection (Feature 5 integration)
    const insiderAnalysis = await this.analyzeInsiderActivity(tokenMint);
    if (insiderAnalysis.insiderRiskScore > 70) {
      flags.push('HIGH_INSIDER_RISK');
      safetyScore -= 20;
    } else if (insiderAnalysis.insiderRiskScore > 50) {
      flags.push('MEDIUM_INSIDER_RISK');
      safetyScore -= 10;
    }

    // Ensure score stays within bounds
    safetyScore = Math.max(0, Math.min(100, safetyScore));

    const result: TokenSafetyResult = {
      tokenAddress: tokenMint,
      mintAuthorityEnabled,
      freezeAuthorityEnabled,
      lpLocked,
      lpLockDuration,
      top10HolderConcentration,
      deployerHolding,
      tokenAgeMins,
      rugCheckScore,
      honeypotRisk,
      safetyScore,
      flags,
      insiderAnalysis,
    };

    // Cache the result
    this.cache.set(tokenMint, { result, expiry: Date.now() + CACHE_TTL_MS });
    await this.saveToDbCache(result);

    logger.info({ tokenMint, safetyScore, flags }, 'Token safety check complete');

    return result;
  }

  /**
   * Check if token should be blocked based on safety score
   */
  shouldBlockSignal(result: TokenSafetyResult): { blocked: boolean; reason?: string } {
    if (result.safetyScore < MIN_SAFETY_SCORE_THRESHOLD) {
      return { blocked: true, reason: `Safety score too low: ${result.safetyScore}` };
    }

    // Instant rejection flags
    const instantRejectFlags = ['HONEYPOT_RISK', 'HIGH_INSIDER_RISK'];
    for (const flag of instantRejectFlags) {
      if (result.flags.includes(flag)) {
        return { blocked: true, reason: `Critical flag: ${flag}` };
      }
    }

    // Block if both mint and freeze authority are enabled
    if (result.mintAuthorityEnabled && result.freezeAuthorityEnabled) {
      return { blocked: true, reason: 'Both mint and freeze authorities enabled' };
    }

    return { blocked: false };
  }

  /**
   * Check mint and freeze authorities
   */
  private async checkMintAuthorities(tokenMint: string): Promise<{
    mintAuthorityEnabled: boolean;
    freezeAuthorityEnabled: boolean;
  }> {
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const accountInfo = await this.connection.getParsedAccountInfo(mintPubkey);

      if (!accountInfo.value || !('parsed' in accountInfo.value.data)) {
        return { mintAuthorityEnabled: false, freezeAuthorityEnabled: false };
      }

      const parsed = accountInfo.value.data.parsed;
      if (parsed.type !== 'mint') {
        return { mintAuthorityEnabled: false, freezeAuthorityEnabled: false };
      }

      const info = parsed.info;
      return {
        mintAuthorityEnabled: info.mintAuthority !== null,
        freezeAuthorityEnabled: info.freezeAuthority !== null,
      };
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to check mint authorities');
      return { mintAuthorityEnabled: false, freezeAuthorityEnabled: false };
    }
  }

  /**
   * Check holder concentration
   */
  private async checkHolderConcentration(tokenMint: string): Promise<{
    top10HolderConcentration: number;
    deployerHolding: number;
  }> {
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);

      if (!largestAccounts.value || largestAccounts.value.length === 0) {
        return { top10HolderConcentration: 0, deployerHolding: 0 };
      }

      // Get token supply
      const supplyInfo = await this.connection.getTokenSupply(mintPubkey);
      const totalSupply = Number(supplyInfo.value.amount);

      if (totalSupply === 0) {
        return { top10HolderConcentration: 0, deployerHolding: 0 };
      }

      // Calculate top 10 concentration
      const top10 = largestAccounts.value.slice(0, 10);
      const top10Total = top10.reduce((sum, acc) => sum + Number(acc.amount), 0);
      const top10HolderConcentration = (top10Total / totalSupply) * 100;

      // Get deployer holding (first account is often deployer)
      const deployerHolding = largestAccounts.value.length > 0
        ? (Number(largestAccounts.value[0].amount) / totalSupply) * 100
        : 0;

      return { top10HolderConcentration, deployerHolding };
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to check holder concentration');
      return { top10HolderConcentration: 0, deployerHolding: 0 };
    }
  }

  /**
   * Get token age in minutes
   */
  private async getTokenAge(tokenMint: string): Promise<number> {
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const signatures = await this.connection.getSignaturesForAddress(mintPubkey, { limit: 1 }, 'confirmed');

      if (signatures.length === 0) {
        return 0;
      }

      const firstTxTime = signatures[signatures.length - 1].blockTime;
      if (!firstTxTime) {
        return 0;
      }

      const ageMs = Date.now() - (firstTxTime * 1000);
      return Math.floor(ageMs / (60 * 1000));
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to get token age');
      return 0;
    }
  }

  /**
   * Check LP lock status
   */
  private async checkLpStatus(tokenMint: string): Promise<{
    lpLocked: boolean;
    lpLockDuration: number | null;
  }> {
    // This would require checking known LP lock protocols
    // For now, return conservative defaults
    // In production, integrate with LP lock verification services
    try {
      // Placeholder: In production, check against known LP lock contracts
      // like Raydium LP tokens or Streamflow locks
      return {
        lpLocked: false,
        lpLockDuration: null,
      };
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to check LP status');
      return { lpLocked: false, lpLockDuration: null };
    }
  }

  /**
   * Get RugCheck score from free API
   */
  private async getRugCheckScore(tokenMint: string): Promise<number | null> {
    try {
      const response = await fetch(`${RUGCHECK_API_BASE}/tokens/${tokenMint}/report`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;

      // RugCheck returns risks array and a score
      if (data.score !== undefined) {
        return data.score;
      }

      // Calculate score from risks if direct score not available
      if (data.risks && Array.isArray(data.risks)) {
        const riskCount = data.risks.length;
        // More risks = lower score
        return Math.max(0, 100 - (riskCount * 15));
      }

      return null;
    } catch (error) {
      logger.debug({ error, tokenMint }, 'Failed to fetch RugCheck score');
      return null;
    }
  }

  /**
   * Check for honeypot risk (can token be sold)
   */
  private async checkHoneypotRisk(tokenMint: string): Promise<boolean> {
    try {
      // Check RugCheck API for honeypot indicators
      const response = await fetch(`${RUGCHECK_API_BASE}/tokens/${tokenMint}/report`, {
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as any;

      // Check for honeypot-related risks
      if (data.risks && Array.isArray(data.risks)) {
        const honeypotRisks = data.risks.filter((r: any) =>
          r.name?.toLowerCase().includes('honeypot') ||
          r.name?.toLowerCase().includes('cant sell') ||
          r.name?.toLowerCase().includes('sell blocked')
        );
        return honeypotRisks.length > 0;
      }

      return false;
    } catch (error) {
      logger.debug({ error, tokenMint }, 'Failed to check honeypot risk');
      return false;
    }
  }

  /**
   * Analyze insider activity (Feature 5)
   */
  private async analyzeInsiderActivity(tokenMint: string): Promise<InsiderAnalysis> {
    // This will be enhanced in the insider-detector module
    // Basic implementation here
    const result: InsiderAnalysis = {
      sameBlockBuyers: 0,
      deployerFundedBuyers: 0,
      suspiciousPatterns: [],
      insiderRiskScore: 0,
    };

    try {
      const mintPubkey = new PublicKey(tokenMint);

      // Get the creation transaction and early transactions
      const signatures = await this.connection.getSignaturesForAddress(
        mintPubkey,
        { limit: 50 },
        'confirmed'
      );

      if (signatures.length < 2) {
        return result;
      }

      // Get creation block
      const creationSig = signatures[signatures.length - 1];
      if (!creationSig.slot) {
        return result;
      }

      const creationSlot = creationSig.slot;

      // Count transactions in the same block and next 2 blocks
      const earlyTxs = signatures.filter(sig =>
        sig.slot && sig.slot <= creationSlot + 2
      );

      result.sameBlockBuyers = earlyTxs.length - 1; // Exclude creation tx

      // Flag if more than 3 wallets bought in creation block
      if (result.sameBlockBuyers > 3) {
        result.suspiciousPatterns.push('Multiple same-block buyers');
        result.insiderRiskScore += 30;
      }

      // Calculate final risk score
      result.insiderRiskScore = Math.min(100, result.insiderRiskScore);

      return result;
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to analyze insider activity');
      return result;
    }
  }

  /**
   * Get cached result from database
   */
  private async getFromDbCache(tokenMint: string): Promise<TokenSafetyResult | null> {
    try {
      const result = await pool.query(
        `SELECT * FROM token_safety_cache
         WHERE token_address = $1 AND expires_at > NOW()`,
        [tokenMint]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        tokenAddress: row.token_address,
        mintAuthorityEnabled: row.mint_authority_enabled,
        freezeAuthorityEnabled: row.freeze_authority_enabled,
        lpLocked: row.lp_locked,
        lpLockDuration: row.lp_lock_duration,
        top10HolderConcentration: parseFloat(row.top10_holder_concentration),
        deployerHolding: parseFloat(row.deployer_holding),
        tokenAgeMins: row.token_age_mins,
        rugCheckScore: row.rugcheck_score,
        honeypotRisk: row.honeypot_risk,
        safetyScore: row.safety_score,
        flags: row.flags || [],
        insiderAnalysis: {
          sameBlockBuyers: row.same_block_buyers || 0,
          deployerFundedBuyers: row.deployer_funded_buyers || 0,
          suspiciousPatterns: row.suspicious_patterns || [],
          insiderRiskScore: row.insider_risk_score || 0,
        },
      };
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to get from DB cache');
      return null;
    }
  }

  /**
   * Save result to database cache
   */
  private async saveToDbCache(result: TokenSafetyResult): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO token_safety_cache (
          token_address, mint_authority_enabled, freeze_authority_enabled,
          lp_locked, lp_lock_duration, top10_holder_concentration,
          deployer_holding, token_age_mins, rugcheck_score, honeypot_risk,
          safety_score, flags, same_block_buyers, deployer_funded_buyers,
          suspicious_patterns, insider_risk_score, checked_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW() + INTERVAL '15 minutes')
        ON CONFLICT (token_address) DO UPDATE SET
          mint_authority_enabled = EXCLUDED.mint_authority_enabled,
          freeze_authority_enabled = EXCLUDED.freeze_authority_enabled,
          lp_locked = EXCLUDED.lp_locked,
          lp_lock_duration = EXCLUDED.lp_lock_duration,
          top10_holder_concentration = EXCLUDED.top10_holder_concentration,
          deployer_holding = EXCLUDED.deployer_holding,
          token_age_mins = EXCLUDED.token_age_mins,
          rugcheck_score = EXCLUDED.rugcheck_score,
          honeypot_risk = EXCLUDED.honeypot_risk,
          safety_score = EXCLUDED.safety_score,
          flags = EXCLUDED.flags,
          same_block_buyers = EXCLUDED.same_block_buyers,
          deployer_funded_buyers = EXCLUDED.deployer_funded_buyers,
          suspicious_patterns = EXCLUDED.suspicious_patterns,
          insider_risk_score = EXCLUDED.insider_risk_score,
          checked_at = NOW(),
          expires_at = NOW() + INTERVAL '15 minutes'`,
        [
          result.tokenAddress,
          result.mintAuthorityEnabled,
          result.freezeAuthorityEnabled,
          result.lpLocked,
          result.lpLockDuration,
          result.top10HolderConcentration,
          result.deployerHolding,
          result.tokenAgeMins,
          result.rugCheckScore,
          result.honeypotRisk,
          result.safetyScore,
          result.flags,
          result.insiderAnalysis.sameBlockBuyers,
          result.insiderAnalysis.deployerFundedBuyers,
          result.insiderAnalysis.suspiciousPatterns,
          result.insiderAnalysis.insiderRiskScore,
        ]
      );
    } catch (error) {
      logger.warn({ error, tokenAddress: result.tokenAddress }, 'Failed to save to DB cache');
    }
  }

  /**
   * Clear expired cache entries
   */
  async clearExpiredCache(): Promise<void> {
    // Clear in-memory cache
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (value.expiry < now) {
        this.cache.delete(key);
      }
    }

    // Clear database cache
    try {
      await pool.query('DELETE FROM token_safety_cache WHERE expires_at < NOW()');
    } catch (error) {
      logger.warn({ error }, 'Failed to clear expired DB cache');
    }
  }
}

// ============ EXPORTS ============

export const tokenSafetyChecker = new TokenSafetyChecker();

// Re-export the type for external use
export type { TokenSafetyResult } from '../../types/index.js';

export default {
  TokenSafetyChecker,
  tokenSafetyChecker,
};
