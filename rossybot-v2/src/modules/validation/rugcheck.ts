import axios from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { RugCheckResult, ValidationCheckResult } from '../../types/index.js';

export async function checkRugSafety(mintAddress: string): Promise<{ result: RugCheckResult | null; check: ValidationCheckResult }> {
  try {
    const resp = await axios.get(`${config.rugCheck.baseUrl}/tokens/${mintAddress}/report`, {
      timeout: 10_000,
    });

    const data = resp.data;

    // Parse RugCheck response
    const risks: string[] = [];
    let mintAuthorityRevoked = true;
    let freezeAuthorityRevoked = true;
    let topHolderConcentration = 0;
    let lpLocked = true;

    // Check risks array from RugCheck
    if (data.risks && Array.isArray(data.risks)) {
      for (const risk of data.risks) {
        risks.push(risk.name || risk.description || 'unknown');

        if (risk.name?.toLowerCase().includes('mint authority')) {
          mintAuthorityRevoked = false;
        }
        if (risk.name?.toLowerCase().includes('freeze authority')) {
          freezeAuthorityRevoked = false;
        }
        if (risk.name?.toLowerCase().includes('top holders') || risk.name?.toLowerCase().includes('high concentration')) {
          topHolderConcentration = risk.value || 0;
        }
        if (risk.name?.toLowerCase().includes('lp unlocked')) {
          lpLocked = false;
        }
      }
    }

    // Also check top holders from data.topHolders
    if (data.topHolders && Array.isArray(data.topHolders)) {
      const top10Total = data.topHolders
        .slice(0, 10)
        .reduce((sum: number, h: { pct?: number }) => sum + (h.pct || 0), 0);
      topHolderConcentration = Math.max(topHolderConcentration, top10Total);
    }

    const rugResult: RugCheckResult = {
      mint: mintAddress,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      topHolderConcentration,
      lpLocked,
      score: data.score || 0,
      risks,
    };

    // Safety gate — all must pass
    const reasons: string[] = [];
    if (!mintAuthorityRevoked) reasons.push('Mint authority not revoked');
    if (!freezeAuthorityRevoked) reasons.push('Freeze authority not revoked');
    if (topHolderConcentration > 50) reasons.push(`Top 10 holders: ${topHolderConcentration.toFixed(1)}% (>50%)`);
    if (!lpLocked) reasons.push('LP not locked');

    const passed = reasons.length === 0;

    return {
      result: rugResult,
      check: {
        passed,
        reason: passed ? undefined : reasons.join('; '),
        details: rugResult as unknown as Record<string, unknown>,
      },
    };
  } catch (err) {
    logger.error({ err, mint: mintAddress }, 'RugCheck API error');
    return {
      result: null,
      check: { passed: false, reason: 'RugCheck API error' },
    };
  }
}
