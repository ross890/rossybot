import { logger } from '../../utils/logger.js';
import { query, getMany } from '../../db/database.js';
import { enrichTokenWithDex } from './graduated-fetcher.js';

/**
 * Signal Rejection Tracker — post-hoc analysis of rejected pump.fun signals.
 *
 * Problem: 79% of signals are rejected, but we don't know if we're rejecting
 * good trades. This module:
 *   1. Logs every rejected pump.fun signal with reason, curve fill, wallet, etc.
 *   2. Periodically checks: did the rejected token graduate?
 *   3. If it graduated, records what the outcome would have been
 *   4. Reports missed opportunities in the daily market analysis
 *
 * Data flow:
 *   handlePumpFunBuy() rejection → logRejectedSignal() → DB
 *   runDailyAnalysis() → analyzeRejectedSignals() → report
 */

export interface RejectedSignal {
  tokenMint: string;
  walletAddress: string;
  walletLabel: string;
  rejectionReason: string;
  curveFillPct: number;
  solInCurve: number;
  alphaSolSpent: number;
  signalScore: number;
}

export interface RejectionAnalysisResult {
  /** Total rejections in the analysis window */
  totalRejections: number;
  /** Rejections where the token went on to graduate */
  graduatedCount: number;
  /** Graduated tokens that were profitable (>+20% at 24h) */
  profitableCount: number;
  /** Estimated SOL missed from profitable graduated rejections */
  estimatedMissedSolPnl: number;
  /** Breakdown by rejection reason */
  byReason: Array<{
    reason: string;
    count: number;
    graduated: number;
    profitableGrads: number;
    avgPriceChangeH24: number;
  }>;
  /** Top missed opportunities */
  topMissed: Array<{
    tokenMint: string;
    symbol: string;
    reason: string;
    curveFillAtRejection: number;
    priceChangeH24: number;
  }>;
}

/**
 * Ensure the rejection tracking table exists. Called from the market analyzer
 * ensureTables(). Idempotent.
 */
export async function ensureRejectionTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS ma_signal_rejections (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      token_mint TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      wallet_label TEXT,
      rejection_reason TEXT NOT NULL,
      curve_fill_pct DECIMAL DEFAULT 0,
      sol_in_curve DECIMAL DEFAULT 0,
      alpha_sol_spent DECIMAL DEFAULT 0,
      signal_score INT DEFAULT 0,
      rejected_at TIMESTAMPTZ DEFAULT NOW(),
      -- Post-hoc analysis (filled in later by analyzeRejectedSignals)
      graduated BOOLEAN DEFAULT NULL,
      graduated_at TIMESTAMPTZ DEFAULT NULL,
      post_grad_price_change_h24 DECIMAL DEFAULT NULL,
      post_grad_mcap_usd DECIMAL DEFAULT NULL,
      analyzed BOOLEAN DEFAULT FALSE
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_rejections_mint ON ma_signal_rejections(token_mint)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_rejections_reason ON ma_signal_rejections(rejection_reason)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_rejections_time ON ma_signal_rejections(rejected_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_rejections_unanalyzed ON ma_signal_rejections(analyzed) WHERE analyzed = FALSE`);
}

/**
 * Log a rejected pump.fun signal for post-hoc analysis.
 * Called from handlePumpFunBuy() in index.ts when a signal is rejected.
 *
 * NOTE: This is a fire-and-forget insert — errors are logged but don't
 * block the main signal flow.
 */
export async function logRejectedSignal(signal: RejectedSignal): Promise<void> {
  try {
    await query(
      `INSERT INTO ma_signal_rejections
         (token_mint, wallet_address, wallet_label, rejection_reason,
          curve_fill_pct, sol_in_curve, alpha_sol_spent, signal_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        signal.tokenMint,
        signal.walletAddress,
        signal.walletLabel,
        signal.rejectionReason,
        signal.curveFillPct,
        signal.solInCurve,
        signal.alphaSolSpent,
        signal.signalScore,
      ],
    );
  } catch (err) {
    logger.error({ err, mint: signal.tokenMint.slice(0, 8) }, 'Failed to log rejected signal');
  }
}

/**
 * Post-hoc analysis: check unanalyzed rejected signals to see if
 * the tokens went on to graduate and how they performed.
 *
 * Called during the daily market analysis pipeline.
 *
 * @param lookbackHours How far back to look for unanalyzed rejections (default 48h)
 */
export async function analyzeRejectedSignals(
  lookbackHours: number = 48,
): Promise<RejectionAnalysisResult> {
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  // Fetch unanalyzed rejections from the last N hours
  const unanalyzed = await getMany<{
    id: string;
    token_mint: string;
    wallet_label: string;
    rejection_reason: string;
    curve_fill_pct: string;
    rejected_at: string;
  }>(
    `SELECT id, token_mint, wallet_label, rejection_reason, curve_fill_pct, rejected_at
     FROM ma_signal_rejections
     WHERE analyzed = FALSE AND rejected_at >= $1
     ORDER BY rejected_at ASC
     LIMIT 200`,
    [cutoff],
  );

  if (unanalyzed.length === 0) {
    logger.info('No unanalyzed rejected signals to process');
    return emptyResult();
  }

  logger.info({ count: unanalyzed.length }, 'Analyzing rejected signals post-hoc...');

  // Deduplicate by token mint (may have multiple rejections for same token)
  const uniqueMints = new Set(unanalyzed.map((r) => r.token_mint));
  const mintResults = new Map<string, {
    graduated: boolean;
    priceChangeH24: number;
    mcapUsd: number;
    symbol: string;
  }>();

  // Check each unique token against DexScreener / graduated tokens table
  for (const mint of uniqueMints) {
    // First check if it graduated (exists in ma_graduated_tokens)
    const gradRow = await query<{ mint: string; price_change_h24: string; mcap_usd: string; symbol: string }>(
      `SELECT mint, price_change_h24, mcap_usd, symbol
       FROM ma_graduated_tokens WHERE mint = $1
       ORDER BY analysis_date DESC LIMIT 1`,
      [mint],
    );

    if (gradRow.rows.length > 0) {
      const row = gradRow.rows[0];
      mintResults.set(mint, {
        graduated: true,
        priceChangeH24: Number(row.price_change_h24) || 0,
        mcapUsd: Number(row.mcap_usd) || 0,
        symbol: row.symbol || mint.slice(0, 6),
      });
      continue;
    }

    // Fallback: check DexScreener for pumpswap/raydium pair (graduated off our radar)
    const enriched = await enrichTokenWithDex(mint);
    if (enriched && (enriched.dexId === 'pumpswap' || enriched.dexId === 'pump_swap' || enriched.dexId === 'raydium')) {
      mintResults.set(mint, {
        graduated: true,
        priceChangeH24: enriched.priceChangeH24,
        mcapUsd: enriched.mcapUsd,
        symbol: enriched.symbol,
      });
    } else {
      mintResults.set(mint, {
        graduated: false,
        priceChangeH24: 0,
        mcapUsd: 0,
        symbol: mint.slice(0, 6),
      });
    }

    // Rate limit DexScreener calls
    await new Promise((r) => setTimeout(r, 2500));
  }

  // Update all rejection rows with post-hoc results
  for (const row of unanalyzed) {
    const result = mintResults.get(row.token_mint);
    if (!result) continue;

    await query(
      `UPDATE ma_signal_rejections SET
         analyzed = TRUE,
         graduated = $2,
         post_grad_price_change_h24 = $3,
         post_grad_mcap_usd = $4
       WHERE id = $1`,
      [row.id, result.graduated, result.priceChangeH24, result.mcapUsd],
    ).catch(() => {});
  }

  // Build analysis result
  const totalRejections = unanalyzed.length;
  const graduatedRejections = unanalyzed.filter((r) => mintResults.get(r.token_mint)?.graduated);
  const profitableRejections = graduatedRejections.filter((r) => {
    const result = mintResults.get(r.token_mint);
    return result && result.priceChangeH24 > 20;
  });

  // Breakdown by reason
  const reasonMap = new Map<string, { count: number; graduated: number; profitableGrads: number; priceChanges: number[] }>();
  for (const row of unanalyzed) {
    const reason = row.rejection_reason;
    let agg = reasonMap.get(reason);
    if (!agg) {
      agg = { count: 0, graduated: 0, profitableGrads: 0, priceChanges: [] };
      reasonMap.set(reason, agg);
    }
    agg.count++;
    const result = mintResults.get(row.token_mint);
    if (result?.graduated) {
      agg.graduated++;
      agg.priceChanges.push(result.priceChangeH24);
      if (result.priceChangeH24 > 20) agg.profitableGrads++;
    }
  }

  const byReason = Array.from(reasonMap.entries())
    .map(([reason, agg]) => ({
      reason,
      count: agg.count,
      graduated: agg.graduated,
      profitableGrads: agg.profitableGrads,
      avgPriceChangeH24: agg.priceChanges.length > 0
        ? agg.priceChanges.reduce((a, b) => a + b, 0) / agg.priceChanges.length
        : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Top missed opportunities (profitable graduated rejections)
  const topMissed = profitableRejections
    .map((r) => {
      const result = mintResults.get(r.token_mint)!;
      return {
        tokenMint: r.token_mint,
        symbol: result.symbol,
        reason: r.rejection_reason,
        curveFillAtRejection: Number(r.curve_fill_pct),
        priceChangeH24: result.priceChangeH24,
      };
    })
    .sort((a, b) => b.priceChangeH24 - a.priceChangeH24)
    .slice(0, 10);

  logger.info({
    totalRejections,
    graduated: graduatedRejections.length,
    profitable: profitableRejections.length,
    topMissed: topMissed.slice(0, 3).map((t) => `${t.symbol}(+${t.priceChangeH24.toFixed(0)}%)`),
  }, 'Rejection analysis complete');

  return {
    totalRejections,
    graduatedCount: graduatedRejections.length,
    profitableCount: profitableRejections.length,
    estimatedMissedSolPnl: 0, // TODO: estimate based on position sizing
    byReason,
    topMissed,
  };
}

function emptyResult(): RejectionAnalysisResult {
  return {
    totalRejections: 0,
    graduatedCount: 0,
    profitableCount: 0,
    estimatedMissedSolPnl: 0,
    byReason: [],
    topMissed: [],
  };
}
