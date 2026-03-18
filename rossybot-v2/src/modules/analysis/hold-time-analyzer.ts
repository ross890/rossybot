import { logger } from '../../utils/logger.js';
import { query, getMany, getOne } from '../../db/database.js';

/**
 * Wallet hold-time profile — tells us whether a wallet's trades
 * are profitable within OUR exit windows (1h, 4h, 12h, 48h).
 */
export interface HoldTimeProfile {
  address: string;
  label: string;
  totalRoundTrips: number;       // completed buy→sell pairs
  openPositions: number;         // buys without matching sell
  avgHoldTimeMins: number;
  medianHoldTimeMins: number;
  pctProfitable: number;         // % of round-trips that were profitable
  pctClosedWithin48h: number;    // % of trades closed within our max window
  pctClosedWithin4h: number;     // fast traders
  avgPnlPct: number;             // average PnL across round-trips
  /** What % of buys were profitable at each checkpoint (using current price for open) */
  profitableAt1h: number;
  profitableAt4h: number;
  profitableAt12h: number;
  profitableAt48h: number;
  /** Short-term alpha score: 0–100, higher = better fit for our strategy */
  shortTermAlphaScore: number;
  lastAnalyzedAt: Date;
}

interface RoundTrip {
  tokenMint: string;
  buyTime: Date;
  sellTime: Date | null;   // null = still holding
  holdTimeMins: number | null;
  buySol: number;
  sellSol: number | null;
  pnlPct: number | null;   // null if still holding
}

export class HoldTimeAnalyzer {
  /**
   * Analyze a wallet's trades by pairing BUY→SELL from wallet_transactions.
   * For open positions (buys without sells), checks current DexScreener price.
   */
  async analyzeWallet(address: string): Promise<HoldTimeProfile | null> {
    // Get wallet label
    const walletRow = await getOne<{ label: string }>(
      `SELECT label FROM alpha_wallets WHERE address = $1`, [address],
    );
    if (!walletRow) return null;

    // Get all transactions for this wallet, ordered by time
    const txs = await getMany<{
      type: string;
      token_mint: string;
      block_time: string;
      amount: string;
      estimated_sol_value: string;
    }>(
      `SELECT type, token_mint, block_time, amount, estimated_sol_value
       FROM wallet_transactions
       WHERE wallet_address = $1 AND type IN ('BUY', 'SELL') AND token_mint IS NOT NULL
       ORDER BY block_time ASC`,
      [address],
    );

    if (txs.length === 0) {
      return {
        address,
        label: walletRow.label,
        totalRoundTrips: 0,
        openPositions: 0,
        avgHoldTimeMins: 0,
        medianHoldTimeMins: 0,
        pctProfitable: 0,
        pctClosedWithin48h: 0,
        pctClosedWithin4h: 0,
        avgPnlPct: 0,
        profitableAt1h: 0,
        profitableAt4h: 0,
        profitableAt12h: 0,
        profitableAt48h: 0,
        shortTermAlphaScore: 0,
        lastAnalyzedAt: new Date(),
      };
    }

    // Pair BUY→SELL per token (FIFO matching)
    const roundTrips = this.pairTrades(txs);

    // Calculate metrics (no DexScreener calls — uses SOL values from transactions only)
    return this.calculateProfile(address, walletRow.label, roundTrips);
  }

  /**
   * FIFO pair matching: for each token, match buys with subsequent sells.
   */
  private pairTrades(txs: Array<{
    type: string;
    token_mint: string;
    block_time: string;
    amount: string;
    estimated_sol_value: string;
  }>): RoundTrip[] {
    // Group by token
    const byToken = new Map<string, typeof txs>();
    for (const tx of txs) {
      const existing = byToken.get(tx.token_mint) || [];
      existing.push(tx);
      byToken.set(tx.token_mint, existing);
    }

    const roundTrips: RoundTrip[] = [];

    for (const [tokenMint, tokenTxs] of byToken) {
      const buyQueue: typeof txs = [];

      for (const tx of tokenTxs) {
        if (tx.type === 'BUY') {
          buyQueue.push(tx);
        } else if (tx.type === 'SELL' && buyQueue.length > 0) {
          // Match with oldest unmatched buy (FIFO)
          const buy = buyQueue.shift()!;
          const buyTime = new Date(buy.block_time);
          const sellTime = new Date(tx.block_time);
          const holdTimeMins = (sellTime.getTime() - buyTime.getTime()) / (1000 * 60);
          const buySol = Number(buy.estimated_sol_value) || 0;
          const sellSol = Number(tx.estimated_sol_value) || 0;
          const pnlPct = buySol > 0 ? (sellSol - buySol) / buySol : 0;

          roundTrips.push({
            tokenMint,
            buyTime,
            sellTime,
            holdTimeMins,
            buySol,
            sellSol,
            pnlPct,
          });
        }
      }

      // Remaining unmatched buys = open positions
      for (const buy of buyQueue) {
        const buyTime = new Date(buy.block_time);
        const holdTimeMins = (Date.now() - buyTime.getTime()) / (1000 * 60);
        roundTrips.push({
          tokenMint,
          buyTime,
          sellTime: null,
          holdTimeMins,
          buySol: Number(buy.estimated_sol_value) || 0,
          sellSol: null,
          pnlPct: null,
        });
      }
    }

    return roundTrips;
  }

  private calculateProfile(address: string, label: string, roundTrips: RoundTrip[]): HoldTimeProfile {
    const closed = roundTrips.filter((rt) => rt.sellTime !== null);
    const open = roundTrips.filter((rt) => rt.sellTime === null);

    // Hold time stats (closed trades only)
    const holdTimes = closed.map((rt) => rt.holdTimeMins!).sort((a, b) => a - b);
    const avgHold = holdTimes.length > 0 ? holdTimes.reduce((s, h) => s + h, 0) / holdTimes.length : 0;
    const medianHold = holdTimes.length > 0 ? holdTimes[Math.floor(holdTimes.length / 2)] : 0;

    // Profitability
    const profitable = closed.filter((rt) => rt.pnlPct! > 0);
    const pctProfitable = closed.length > 0 ? profitable.length / closed.length : 0;

    // Time window analysis
    const closedWithin48h = closed.filter((rt) => rt.holdTimeMins! <= 48 * 60);
    const closedWithin4h = closed.filter((rt) => rt.holdTimeMins! <= 4 * 60);
    const pctClosedWithin48h = closed.length > 0 ? closedWithin48h.length / closed.length : 0;
    const pctClosedWithin4h = closed.length > 0 ? closedWithin4h.length / closed.length : 0;

    // Average PnL (closed only)
    const avgPnl = closed.length > 0
      ? closed.reduce((s, rt) => s + (rt.pnlPct || 0), 0) / closed.length
      : 0;

    // Profitability at checkpoints (only for trades closed within those windows)
    const profitableAt = (maxMins: number) => {
      const inWindow = closed.filter((rt) => rt.holdTimeMins! <= maxMins);
      if (inWindow.length === 0) return 0;
      return inWindow.filter((rt) => rt.pnlPct! > 0).length / inWindow.length;
    };

    const profitableAt1h = profitableAt(60);
    const profitableAt4h = profitableAt(240);
    const profitableAt12h = profitableAt(720);
    const profitableAt48h = profitableAt(48 * 60);

    // === SHORT-TERM ALPHA SCORE (0–100) ===
    // Optimized for QUICK FLIPS: wallets that buy and sell profitably within hours
    let score = 0;

    // 1. Speed: do they close trades fast? (25 pts max)
    //    Heavy bonus for trades closed within 4h (quick flips)
    score += Math.min(pctClosedWithin4h * 35, 25);

    // 2. Profitability within 4h window (30 pts max) — #1 signal for quick flips
    score += profitableAt4h * 30;

    // 3. Profitability within 48h window (15 pts max) — secondary
    score += profitableAt48h * 15;

    // 4. Average PnL on closed trades (10 pts max)
    const avgPnlCapped = Math.min(Math.max(avgPnl, -0.5), 1.0);
    score += Math.max((avgPnlCapped + 0.5) / 1.5 * 10, 0);

    // 5. Sample size confidence (10 pts max)
    score += Math.min(closed.length / 5, 1) * 10;

    // 6. Bag-holding penalty (-25 pts max)
    //    If >40% of their buys are still open, they hold too long for quick flips
    const totalTrades = closed.length + open.length;
    if (totalTrades > 0) {
      const openRatio = open.length / totalTrades;
      if (openRatio > 0.4) {
        score -= Math.min((openRatio - 0.4) * 50, 25);
      }
    }

    // 7. Slow hold penalty (-15 pts)
    //    Median hold >12h = not a quick flipper
    if (medianHold > 12 * 60 && closed.length >= 3) {
      score -= 15;
    } else if (medianHold > 4 * 60 && closed.length >= 3) {
      score -= 5; // Mildly slow
    }

    score = Math.max(0, Math.min(100, score));

    return {
      address,
      label,
      totalRoundTrips: closed.length,
      openPositions: open.length,
      avgHoldTimeMins: Math.round(avgHold),
      medianHoldTimeMins: Math.round(medianHold),
      pctProfitable,
      pctClosedWithin48h,
      pctClosedWithin4h,
      avgPnlPct: avgPnl,
      profitableAt1h,
      profitableAt4h,
      profitableAt12h,
      profitableAt48h,
      shortTermAlphaScore: Math.round(score),
      lastAnalyzedAt: new Date(),
    };
  }

  /**
   * Analyze all active wallets and persist results.
   * Returns profiles sorted by shortTermAlphaScore descending.
   */
  async analyzeAllWallets(): Promise<HoldTimeProfile[]> {
    const wallets = await getMany<{ address: string }>(
      `SELECT address FROM alpha_wallets WHERE active = TRUE`,
    );

    const profiles: HoldTimeProfile[] = [];

    for (const wallet of wallets) {
      try {
        const profile = await this.analyzeWallet(wallet.address);
        if (profile) {
          profiles.push(profile);
          await this.persistProfile(profile);
        }
      } catch (err) {
        logger.error({ err, wallet: wallet.address.slice(0, 8) }, 'Failed to analyze wallet');
      }
    }

    profiles.sort((a, b) => b.shortTermAlphaScore - a.shortTermAlphaScore);

    logger.info({
      analyzed: profiles.length,
      avgScore: profiles.length > 0
        ? Math.round(profiles.reduce((s, p) => s + p.shortTermAlphaScore, 0) / profiles.length)
        : 0,
    }, 'Hold-time analysis complete');

    return profiles;
  }

  /**
   * Enforce hold-time requirements: deactivate wallets that are proven bag-holders.
   * Only acts on wallets with enough data (3+ round-trips).
   * Returns number of wallets deactivated.
   */
  async enforceHoldTimeRequirements(): Promise<{ deactivated: string[]; demoted: string[] }> {
    const profiles = await this.analyzeAllWallets();

    const deactivated: string[] = [];
    const demoted: string[] = [];

    for (const profile of profiles) {
      // Need 3+ round-trips to judge — don't penalize new wallets
      if (profile.totalRoundTrips < 3) continue;

      const walletRow = await getOne<{ source: string; tier: string }>(
        `SELECT source, tier FROM alpha_wallets WHERE address = $1`, [profile.address],
      );
      const isSeed = walletRow?.source === 'NANSEN_SEED' || walletRow?.source === 'PUMPFUN_SEED';

      // === HARD CUTOFFS (quick-flip focus) ===

      // 1. Median hold >12h with 3+ trips = too slow for our strategy → deactivate
      const isBagHolder = profile.medianHoldTimeMins > 12 * 60 && profile.totalRoundTrips >= 3;

      // 2. >40% of buys still open = holding too long → deactivate
      const totalTrades = profile.totalRoundTrips + profile.openPositions;
      const highOpenRatio = totalTrades > 3 && (profile.openPositions / totalTrades) > 0.40;

      // 3. Score <25 with 3+ trips = bad fit
      const lowScore = profile.shortTermAlphaScore < 25 && profile.totalRoundTrips >= 3;

      // DEACTIVATE: any hard cutoff triggered (seeds get demoted instead)
      if (isBagHolder || highOpenRatio || lowScore) {
        const reason = isBagHolder ? 'median hold >12h'
          : highOpenRatio ? `${(profile.openPositions / totalTrades * 100).toFixed(0)}% positions still open`
          : `score ${profile.shortTermAlphaScore}/100`;

        if (isSeed) {
          await query(
            `UPDATE alpha_wallets SET tier = 'B' WHERE address = $1`, [profile.address],
          );
          demoted.push(profile.address);
          logger.warn({
            wallet: profile.address.slice(0, 8),
            label: profile.label,
            score: profile.shortTermAlphaScore,
            medianHold: `${Math.round(profile.medianHoldTimeMins / 60)}h`,
            reason,
          }, 'Seed wallet DEMOTED — not a quick flipper');
        } else {
          // Don't fully deactivate — keep wallet active for pump.fun signals
          // Standard pipeline will skip pumpfun_only wallets
          await query(
            `UPDATE alpha_wallets SET pumpfun_only = TRUE WHERE address = $1`, [profile.address],
          );
          deactivated.push(profile.address);
          logger.warn({
            wallet: profile.address.slice(0, 8),
            label: profile.label,
            score: profile.shortTermAlphaScore,
            medianHold: `${Math.round(profile.medianHoldTimeMins / 60)}h`,
            reason,
          }, 'Wallet set to PUMP.FUN ONLY — bag-holder for standard trades');
        }
        continue;
      }

      // DEMOTE to Tier B: Score 25–40 with 3+ trades = mediocre fit
      if (profile.shortTermAlphaScore < 40 && profile.totalRoundTrips >= 3) {
        if (walletRow?.tier === 'A') {
          await query(
            `UPDATE alpha_wallets SET tier = 'B' WHERE address = $1`, [profile.address],
          );
          demoted.push(profile.address);
          logger.info({
            wallet: profile.address.slice(0, 8),
            score: profile.shortTermAlphaScore,
          }, 'Wallet demoted — below quick-flip alpha threshold');
        }
      }
    }

    return { deactivated, demoted };
  }

  /** Persist profile to alpha_wallets for use in ranking */
  private async persistProfile(profile: HoldTimeProfile): Promise<void> {
    try {
      await query(
        `UPDATE alpha_wallets SET
           our_avg_hold_time_mins = $2,
           short_term_alpha_score = $3,
           round_trips_analyzed = $4,
           pct_profitable_48h = $5,
           median_hold_time_mins = $6,
           alpha_analyzed_at = NOW(),
           last_validated_at = NOW()
         WHERE address = $1`,
        [profile.address, profile.avgHoldTimeMins, profile.shortTermAlphaScore,
         profile.totalRoundTrips, profile.profitableAt48h, profile.medianHoldTimeMins],
      );
    } catch (err) {
      logger.error({ err, wallet: profile.address.slice(0, 8) }, 'Failed to persist hold-time profile');
    }
  }

  /**
   * Get a formatted summary for Telegram.
   */
  formatProfileForTelegram(profile: HoldTimeProfile): string {
    const holdStr = profile.avgHoldTimeMins < 60
      ? `${profile.avgHoldTimeMins}m`
      : `${Math.round(profile.avgHoldTimeMins / 60)}h`;
    const medianStr = profile.medianHoldTimeMins < 60
      ? `${profile.medianHoldTimeMins}m`
      : `${Math.round(profile.medianHoldTimeMins / 60)}h`;

    return [
      `${profile.address.slice(0, 6)}...${profile.address.slice(-4)} (${profile.label})`,
      `  Score: ${profile.shortTermAlphaScore}/100 | Trips: ${profile.totalRoundTrips} closed, ${profile.openPositions} open`,
      `  Hold: avg ${holdStr}, median ${medianStr} | ${(profile.pctClosedWithin48h * 100).toFixed(0)}% within 48h`,
      `  Win: ${(profile.pctProfitable * 100).toFixed(0)}% overall | Avg PnL: ${(profile.avgPnlPct * 100).toFixed(1)}%`,
      `  @1h: ${(profile.profitableAt1h * 100).toFixed(0)}% | @4h: ${(profile.profitableAt4h * 100).toFixed(0)}% | @12h: ${(profile.profitableAt12h * 100).toFixed(0)}% | @48h: ${(profile.profitableAt48h * 100).toFixed(0)}%`,
    ].join('\n');
  }
}
