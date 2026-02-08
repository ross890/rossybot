// ===========================================
// RUGCHECK.XYZ API INTEGRATION (Layer 1)
// Contract-level safety checks
// ===========================================

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { rugCheckRateLimiter, TTLCache } from '../utils/rate-limiter.js';
import { pool } from '../utils/database.js';

// ============ TYPES ============

export interface RugCheckResult {
  score: 'GOOD' | 'WARNING' | 'DANGER';
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpLocked: boolean;
  top10HolderPct: number;
  risks: string[];
  rawResponse: object;
}

export type RugCheckAction = 'AUTO_SKIP' | 'NEGATIVE_MODIFIER' | 'PASS';

export interface RugCheckDecision {
  action: RugCheckAction;
  result: RugCheckResult;
  reason: string;
}

// ============ CACHE ============

// Cache RugCheck results for 1 hour — contract-level properties rarely change
const rugCheckCache = new TTLCache<RugCheckResult>(500);
const RUGCHECK_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ============ RUGCHECK CLIENT ============

class RugCheckClient {
  private baseUrl = 'https://api.rugcheck.xyz/v1';

  /**
   * Check a token's contract safety via RugCheck API
   */
  async checkToken(contractAddress: string): Promise<RugCheckResult> {
    // Check cache first
    const cached = rugCheckCache.get(contractAddress);
    if (cached) {
      logger.debug({ address: contractAddress.slice(0, 8) }, 'RugCheck cache hit');
      return cached;
    }

    const endpoint = `/tokens/${contractAddress}/report`;

    try {
      const response = await rugCheckRateLimiter.execute(
        () => axios.get(`${this.baseUrl}${endpoint}`, { timeout: 15000 }),
        endpoint
      );

      const data = response.data;
      const result = this.parseResponse(data, contractAddress);

      // Cache the result
      rugCheckCache.set(contractAddress, result, RUGCHECK_CACHE_TTL_MS);

      logger.debug({
        address: contractAddress.slice(0, 8),
        score: result.score,
        risks: result.risks.length,
        mintRevoked: result.mintAuthorityRevoked,
        freezeRevoked: result.freezeAuthorityRevoked,
        lpLocked: result.lpLocked,
        top10Pct: result.top10HolderPct,
      }, 'RugCheck analysis complete');

      return result;
    } catch (error: any) {
      logger.error({
        error: error.message,
        status: error?.response?.status,
        address: contractAddress.slice(0, 8),
      }, 'RugCheck API call failed');

      // Return a cautious default on API failure
      return {
        score: 'WARNING',
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        lpLocked: false,
        top10HolderPct: 100,
        risks: ['RugCheck API unavailable — defaulting to WARNING'],
        rawResponse: {},
      };
    }
  }

  /**
   * Parse the RugCheck API response into our standardized format
   */
  private parseResponse(data: any, contractAddress: string): RugCheckResult {
    const risks: string[] = [];

    // Extract risk factors from the response
    const riskItems = data.risks || [];
    for (const risk of riskItems) {
      if (risk.name || risk.description) {
        risks.push(risk.name || risk.description);
      }
    }

    // Determine mint authority status
    const mintAuthorityRevoked = data.mintAuthority === null ||
      data.mintAuthority === '' ||
      data.token?.mintAuthority === null ||
      (data.risks || []).every((r: any) =>
        !(r.name || '').toLowerCase().includes('mint authority')
      );

    // Determine freeze authority status
    const freezeAuthorityRevoked = data.freezeAuthority === null ||
      data.freezeAuthority === '' ||
      data.token?.freezeAuthority === null ||
      (data.risks || []).every((r: any) =>
        !(r.name || '').toLowerCase().includes('freeze authority')
      );

    // LP lock status
    const lpLocked = data.markets?.some((m: any) =>
      m.lp?.lpLockedPct > 50 || m.lp?.lpLocked === true
    ) || false;

    // Top 10 holder concentration
    let top10HolderPct = 100;
    if (data.topHolders && Array.isArray(data.topHolders)) {
      top10HolderPct = data.topHolders
        .slice(0, 10)
        .reduce((sum: number, h: any) => sum + (h.pct || h.percentage || 0), 0);
    } else if (data.token?.top10HolderPercent !== undefined) {
      top10HolderPct = data.token.top10HolderPercent;
    }

    // Determine overall score
    let score: 'GOOD' | 'WARNING' | 'DANGER' = 'GOOD';

    // Check for DANGER conditions
    const hasDangerRisk = riskItems.some((r: any) =>
      (r.level || r.severity || '').toLowerCase() === 'danger' ||
      (r.level || r.severity || '').toLowerCase() === 'critical'
    );
    const hasMintRisk = !mintAuthorityRevoked;
    const hasFreezeRisk = !freezeAuthorityRevoked;

    if (hasDangerRisk || (data.score !== undefined && data.score >= 1000)) {
      score = 'DANGER';
    } else if (hasMintRisk || hasFreezeRisk || risks.length > 3) {
      score = 'WARNING';
    } else if (data.score !== undefined && data.score >= 500) {
      score = 'WARNING';
    }

    // Use RugCheck's own score classification if available
    if (data.tokenMeta?.rugged === true) {
      score = 'DANGER';
      risks.push('Token flagged as rugged');
    }

    return {
      score,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      lpLocked,
      top10HolderPct: Math.round(top10HolderPct * 100) / 100,
      risks,
      rawResponse: data,
    };
  }

  /**
   * Determine what action to take based on RugCheck results
   */
  getDecision(result: RugCheckResult): RugCheckDecision {
    // DANGER → AUTO-SKIP regardless of other factors
    if (result.score === 'DANGER') {
      return {
        action: 'AUTO_SKIP',
        result,
        reason: `RugCheck DANGER: ${result.risks.slice(0, 3).join(', ')}`,
      };
    }

    // WARNING with critical issues → AUTO-SKIP
    if (result.score === 'WARNING') {
      if (!result.mintAuthorityRevoked) {
        return {
          action: 'AUTO_SKIP',
          result,
          reason: 'Mint authority not revoked — can mint unlimited tokens',
        };
      }
      if (!result.freezeAuthorityRevoked) {
        return {
          action: 'AUTO_SKIP',
          result,
          reason: 'Freeze authority active — tokens can be frozen',
        };
      }

      // WARNING for non-critical reasons (e.g., concentration)
      return {
        action: 'NEGATIVE_MODIFIER',
        result,
        reason: `RugCheck WARNING: ${result.risks.slice(0, 2).join(', ')}`,
      };
    }

    // GOOD → pass through
    return {
      action: 'PASS',
      result,
      reason: 'RugCheck GOOD — clean report',
    };
  }

  /**
   * Store RugCheck results in token_tracking table
   */
  async storeResults(contractAddress: string, result: RugCheckResult): Promise<void> {
    try {
      await pool.query(
        `UPDATE token_tracking SET
          rugcheck_score = $1,
          mint_authority_revoked = $2,
          freeze_authority_revoked = $3,
          lp_locked = $4,
          top10_holder_pct = $5,
          rugcheck_raw = $6
        WHERE contract_address = $7`,
        [
          result.score,
          result.mintAuthorityRevoked,
          result.freezeAuthorityRevoked,
          result.lpLocked,
          result.top10HolderPct,
          JSON.stringify(result.rawResponse),
          contractAddress,
        ]
      );
    } catch (error) {
      logger.error({ error, address: contractAddress.slice(0, 8) }, 'Failed to store RugCheck results');
    }
  }
}

// ============ EXPORTS ============

export const rugCheckClient = new RugCheckClient();
