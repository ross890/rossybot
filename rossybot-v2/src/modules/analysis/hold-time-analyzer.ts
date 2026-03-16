import { logger } from '../../utils/logger.js';
import { query, getMany, getOne } from '../../db/database.js';
import { fetchDexPair, getPriceUsd } from '../validation/dexscreener.js';

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
  currentPriceUsd: number | null; // for open positions
  entryPriceApprox: number | null;
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

    // For open positions, check current price
    await this.enrichOpenPositions(roundTrips);

    // Calculate metrics
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
            currentPriceUsd: null,
            entryPriceApprox: null,
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
          currentPriceUsd: null,
          entryPriceApprox: null,
        });
      }
    }

    return roundTrips;
  }

  /**
   * For open positions, fetch current DexScreener price to estimate unrealized PnL.
   * Rate-limits to avoid hammering DexScreener.
   */
  private async enrichOpenPositions(roundTrips: RoundTrip[]): Promise<void> {
    const openPositions = roundTrips.filter((rt) => rt.sellTime === null);

    // Deduplicate by token mint
    const uniqueMints = [...new Set(openPositions.map((rt) => rt.tokenMint))];

    // Limit to 10 price lookups per wallet analysis
    for (const mint of uniqueMints.slice(0, 10)) {
      try {
        const pair = await fetchDexPair(mint);
        if (!pair) continue;

        const currentPrice = getPriceUsd(pair);
        if (currentPrice <= 0) continue;

        // Apply current price to all open positions for this token
        for (const rt of openPositions) {
          if (rt.tokenMint === mint) {
            rt.currentPriceUsd = currentPrice;
            // We can't perfectly calculate PnL without knowing entry price in USD,
            // but we can flag that they're still holding (bag-holding indicator)
          }
        }
      } catch {
        // Silent — best effort
      }
    }
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
    // This is the key metric: does this wallet generate profit within our time windows?
    let score = 0;

    // 1. Do they actually close trades quickly? (30 pts max)
    //    We need >50% of trades closed within 48h to be useful
    score += Math.min(pctClosedWithin48h * 40, 30);

    // 2. Are their quick trades profitable? (35 pts max)
    //    Profitability within 48h window is the #1 signal
    score += profitableAt48h * 35;

    // 3. Average PnL on closed trades (15 pts max)
    //    Positive avg PnL within window = good
    const avgPnlCapped = Math.min(Math.max(avgPnl, -0.5), 1.0);
    score += Math.max((avgPnlCapped + 0.5) / 1.5 * 15, 0);

    // 4. Sample size confidence (10 pts max)
    //    Need at least 3 round-trips to trust the data
    score += Math.min(closed.length / 5, 1) * 10;

    // 5. Bag-holding penalty (-20 pts max)
    //    If >60% of their buys are still open (no sell), they hold too long
    const totalTrades = closed.length + open.length;
    if (totalTrades > 0) {
      const openRatio = open.length / totalTrades;
      if (openRatio > 0.6) {
        score -= Math.min((openRatio - 0.6) * 50, 20);
      }
    }

    // 6. Very long hold penalty (-10 pts)
    //    If median hold > 24h, they're too slow for our strategy
    if (medianHold > 24 * 60 && closed.length >= 3) {
      score -= 10;
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

      // DEACTIVATE: Score < 15 AND 5+ trades = proven bad fit
      if (profile.shortTermAlphaScore < 15 && profile.totalRoundTrips >= 5) {
        // Check if it's a seed wallet (don't deactivate seeds, just demote)
        const walletRow = await getOne<{ source: string }>(
          `SELECT source FROM alpha_wallets WHERE address = $1`, [profile.address],
        );

        if (walletRow?.source === 'NANSEN_SEED') {
          // Demote seed wallets instead of deactivating
          await query(
            `UPDATE alpha_wallets SET tier = 'B' WHERE address = $1`, [profile.address],
          );
          demoted.push(profile.address);
          logger.warn({
            wallet: profile.address.slice(0, 8),
            label: profile.label,
            score: profile.shortTermAlphaScore,
            avgHold: `${Math.round(profile.avgHoldTimeMins / 60)}h`,
            pctProfitable48h: `${(profile.profitableAt48h * 100).toFixed(0)}%`,
          }, 'Seed wallet DEMOTED — poor short-term alpha');
        } else {
          await query(
            `UPDATE alpha_wallets SET active = FALSE WHERE address = $1`, [profile.address],
          );
          deactivated.push(profile.address);
          logger.warn({
            wallet: profile.address.slice(0, 8),
            label: profile.label,
            score: profile.shortTermAlphaScore,
            avgHold: `${Math.round(profile.avgHoldTimeMins / 60)}h`,
            pctProfitable48h: `${(profile.profitableAt48h * 100).toFixed(0)}%`,
          }, 'Wallet DEACTIVATED — poor short-term alpha');
        }
        continue;
      }

      // DEMOTE to Tier B: Score 15–30 with 3+ trades = mediocre fit
      if (profile.shortTermAlphaScore < 30 && profile.totalRoundTrips >= 3) {
        const walletRow = await getOne<{ tier: string }>(
          `SELECT tier FROM alpha_wallets WHERE address = $1`, [profile.address],
        );
        if (walletRow?.tier === 'A') {
          await query(
            `UPDATE alpha_wallets SET tier = 'B' WHERE address = $1`, [profile.address],
          );
          demoted.push(profile.address);
          logger.info({
            wallet: profile.address.slice(0, 8),
            score: profile.shortTermAlphaScore,
          }, 'Wallet demoted — below short-term alpha threshold');
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
