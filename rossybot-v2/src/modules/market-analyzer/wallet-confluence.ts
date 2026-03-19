import { logger } from '../../utils/logger.js';
import { query, getMany, getOne } from '../../db/database.js';
import type { EarlyBuyer } from './early-buyer-analyzer.js';
import type { GraduatedToken } from './graduated-fetcher.js';

export interface WalletConfluenceResult {
  walletAddress: string;
  graduatedTokensBought: number;
  totalGraduatedTokens: number;
  hitRate: number;
  avgBuyTimeBeforeGradMins: number;
  tokenMints: string[];
  isTrackedAlpha: boolean;
  alphaWalletLabel: string | null;
  confluenceScore: number;
}

/**
 * Analyze wallet confluence across all graduated tokens from today's analysis.
 *
 * For each wallet that bought early in ANY graduated token, calculate:
 * 1. How many graduated tokens they bought (hit count)
 * 2. Their hit rate (graduated tokens bought / total graduated)
 * 3. Average time of purchase before graduation
 * 4. Whether they're already tracked by rossybot
 * 5. A composite confluence score
 *
 * This is the core edge-finding algorithm: wallets that consistently buy
 * tokens BEFORE they graduate have predictive alpha.
 */
export async function analyzeWalletConfluence(
  graduatedTokens: GraduatedToken[],
  allEarlyBuyers: Map<string, EarlyBuyer[]>, // mint → early buyers
  analysisDate: string,
): Promise<WalletConfluenceResult[]> {
  const totalGraduated = graduatedTokens.length;
  if (totalGraduated === 0) return [];

  // Aggregate: wallet → { tokens bought, total sol, timing data }
  const walletAgg = new Map<string, {
    tokens: Set<string>;
    totalSolSpent: number;
    buyTimesBeforeGrad: number[]; // minutes before graduation
    isKnownAlpha: boolean;
    alphaLabel: string | null;
  }>();

  for (const token of graduatedTokens) {
    const buyers = allEarlyBuyers.get(token.mint) || [];
    const gradTimeMs = token.pairCreatedAt;

    for (const buyer of buyers) {
      let agg = walletAgg.get(buyer.walletAddress);
      if (!agg) {
        agg = {
          tokens: new Set(),
          totalSolSpent: 0,
          buyTimesBeforeGrad: [],
          isKnownAlpha: buyer.isKnownAlpha,
          alphaLabel: buyer.alphaWalletLabel,
        };
        walletAgg.set(buyer.walletAddress, agg);
      }

      agg.tokens.add(token.mint);
      agg.totalSolSpent += buyer.estimatedSolSpent;

      // Calculate how many minutes before graduation this buy occurred
      const buyTimeMs = buyer.buyTime.getTime();
      const minsBeforeGrad = (gradTimeMs - buyTimeMs) / 60_000;
      if (minsBeforeGrad > 0) {
        agg.buyTimesBeforeGrad.push(minsBeforeGrad);
      }

      // Update alpha status if any buyer record says known
      if (buyer.isKnownAlpha) {
        agg.isKnownAlpha = true;
        agg.alphaLabel = buyer.alphaWalletLabel;
      }
    }
  }

  // Calculate confluence scores
  const results: WalletConfluenceResult[] = [];

  for (const [wallet, agg] of walletAgg) {
    const hitCount = agg.tokens.size;
    const hitRate = hitCount / totalGraduated;
    const avgMinsBeforeGrad = agg.buyTimesBeforeGrad.length > 0
      ? agg.buyTimesBeforeGrad.reduce((a, b) => a + b, 0) / agg.buyTimesBeforeGrad.length
      : 0;

    // Confluence scoring formula:
    // - Base: hit count (more graduated tokens bought = stronger signal)
    // - Multiplied by consistency (hit rate)
    // - Bonus for early buying (more minutes before graduation = better)
    // - Bonus for spending real money (higher SOL = more conviction)
    const hitCountScore = Math.min(hitCount * 15, 40);         // 0-40 pts
    const hitRateScore = hitRate * 30;                          // 0-30 pts
    const timingScore = Math.min(avgMinsBeforeGrad / 5, 15);   // 0-15 pts (max at 75+ min early)
    const convictionScore = Math.min(agg.totalSolSpent / 2, 15); // 0-15 pts (max at 30+ SOL total)

    const confluenceScore = hitCountScore + hitRateScore + timingScore + convictionScore;

    results.push({
      walletAddress: wallet,
      graduatedTokensBought: hitCount,
      totalGraduatedTokens: totalGraduated,
      hitRate,
      avgBuyTimeBeforeGradMins: avgMinsBeforeGrad,
      tokenMints: Array.from(agg.tokens),
      isTrackedAlpha: agg.isKnownAlpha,
      alphaWalletLabel: agg.alphaLabel,
      confluenceScore,
    });
  }

  // Sort by confluence score descending
  results.sort((a, b) => b.confluenceScore - a.confluenceScore);

  logger.info({
    totalWallets: results.length,
    top5: results.slice(0, 5).map((r) => ({
      wallet: r.walletAddress.slice(0, 8),
      tokens: r.graduatedTokensBought,
      score: r.confluenceScore.toFixed(1),
      isAlpha: r.isTrackedAlpha,
    })),
  }, 'Wallet confluence analysis complete');

  return results;
}

/**
 * Save confluence results to the database.
 */
export async function saveConfluenceResults(
  results: WalletConfluenceResult[],
  analysisDate: string,
): Promise<void> {
  let saved = 0;

  for (const r of results) {
    try {
      await query(
        `INSERT INTO ma_wallet_confluence
           (wallet_address, analysis_date, graduated_tokens_bought, total_graduated_tokens_analyzed,
            hit_rate, avg_buy_time_before_grad_mins, token_mints,
            is_tracked_alpha, alpha_wallet_label, confluence_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (wallet_address, analysis_date)
         DO UPDATE SET
           graduated_tokens_bought = EXCLUDED.graduated_tokens_bought,
           total_graduated_tokens_analyzed = EXCLUDED.total_graduated_tokens_analyzed,
           hit_rate = EXCLUDED.hit_rate,
           avg_buy_time_before_grad_mins = EXCLUDED.avg_buy_time_before_grad_mins,
           token_mints = EXCLUDED.token_mints,
           is_tracked_alpha = EXCLUDED.is_tracked_alpha,
           alpha_wallet_label = EXCLUDED.alpha_wallet_label,
           confluence_score = EXCLUDED.confluence_score`,
        [
          r.walletAddress,
          analysisDate,
          r.graduatedTokensBought,
          r.totalGraduatedTokens,
          r.hitRate,
          r.avgBuyTimeBeforeGradMins,
          r.tokenMints,
          r.isTrackedAlpha,
          r.alphaWalletLabel,
          r.confluenceScore,
        ],
      );
      saved++;
    } catch (err) {
      logger.error({ err, wallet: r.walletAddress.slice(0, 8) }, 'Failed to save confluence result');
    }
  }

  logger.info({ saved, total: results.length }, 'Confluence results saved to DB');
}

/**
 * Find wallets with high confluence scores over multiple days.
 * These are the most valuable wallet discoveries — consistent graduation buyers.
 */
export async function findRecurringHighConfluenceWallets(
  daysBack: number = 7,
  minAvgScore: number = 20,
): Promise<Array<{
  walletAddress: string;
  daysActive: number;
  avgScore: number;
  totalTokensBought: number;
  isTrackedAlpha: boolean;
}>> {
  try {
    const rows = await getMany<{
      wallet_address: string;
      days_active: string;
      avg_score: string;
      total_tokens: string;
      is_tracked: boolean;
    }>(
      `SELECT
         wallet_address,
         COUNT(DISTINCT analysis_date) as days_active,
         AVG(confluence_score) as avg_score,
         SUM(graduated_tokens_bought) as total_tokens,
         BOOL_OR(is_tracked_alpha) as is_tracked
       FROM ma_wallet_confluence
       WHERE analysis_date >= CURRENT_DATE - $1
         AND confluence_score > 0
       GROUP BY wallet_address
       HAVING AVG(confluence_score) >= $2
       ORDER BY AVG(confluence_score) DESC
       LIMIT 50`,
      [daysBack, minAvgScore],
    );

    return rows.map((r) => ({
      walletAddress: r.wallet_address,
      daysActive: Number(r.days_active),
      avgScore: Number(r.avg_score),
      totalTokensBought: Number(r.total_tokens),
      isTrackedAlpha: r.is_tracked,
    }));
  } catch (err) {
    logger.error({ err }, 'Failed to find recurring high confluence wallets');
    return [];
  }
}

/**
 * Check how many of today's graduated tokens were bought by existing alpha wallets.
 * This measures the overlap between our tracked wallets and graduation activity.
 */
export async function measureAlphaOverlap(
  allEarlyBuyers: Map<string, EarlyBuyer[]>,
): Promise<{
  totalUniqueEarlyBuyers: number;
  knownAlphaCount: number;
  knownAlphaPct: number;
  topAlphaWallets: Array<{ address: string; label: string; tokensBought: number }>;
}> {
  const uniqueBuyers = new Set<string>();
  const alphaHits = new Map<string, { label: string; count: number }>();

  for (const [, buyers] of allEarlyBuyers) {
    for (const buyer of buyers) {
      uniqueBuyers.add(buyer.walletAddress);

      if (buyer.isKnownAlpha && buyer.alphaWalletLabel) {
        const existing = alphaHits.get(buyer.walletAddress);
        if (existing) {
          existing.count++;
        } else {
          alphaHits.set(buyer.walletAddress, {
            label: buyer.alphaWalletLabel,
            count: 1,
          });
        }
      }
    }
  }

  const topAlpha = Array.from(alphaHits.entries())
    .map(([addr, data]) => ({
      address: addr,
      label: data.label,
      tokensBought: data.count,
    }))
    .sort((a, b) => b.tokensBought - a.tokensBought)
    .slice(0, 20);

  return {
    totalUniqueEarlyBuyers: uniqueBuyers.size,
    knownAlphaCount: alphaHits.size,
    knownAlphaPct: uniqueBuyers.size > 0 ? alphaHits.size / uniqueBuyers.size : 0,
    topAlphaWallets: topAlpha,
  };
}
