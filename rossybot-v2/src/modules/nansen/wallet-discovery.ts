import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { query, getMany } from '../../db/database.js';
import { config, SEED_WALLETS, getTierConfig, getTierForCapital } from '../../config/index.js';
import { CapitalTier, WalletSource, WalletTier } from '../../types/index.js';
import { NansenClient } from './client.js';
import { HoldTimeAnalyzer } from '../analysis/hold-time-analyzer.js';

interface WalletCandidate {
  address: string;
  label: string;
  tradeCount: number;
  totalVolumeUsd: number;
  tokensTraded: number;
  bestRoi: number;
  score: number;
}

// Cap total active wallets — raised to 200 for larger seed lists
const MAX_ACTIVE_WALLETS = 200;
// Wallets with no trade data after 3 days get cut
const STALE_WALLET_DAYS = 3;

export class WalletDiscovery {
  private nansen: NansenClient;
  private holdTimeAnalyzer: HoldTimeAnalyzer;
  private discoveryInterval: ReturnType<typeof setInterval> | null = null;
  private onNewWallet: ((address: string) => void) | null = null;
  private onHoldTimeResults: ((results: { deactivated: string[]; demoted: string[] }) => void) | null = null;

  constructor(nansen: NansenClient) {
    this.nansen = nansen;
    this.holdTimeAnalyzer = new HoldTimeAnalyzer();
  }

  /** Set callback for hold-time enforcement results */
  setHoldTimeCallback(cb: (results: { deactivated: string[]; demoted: string[] }) => void): void {
    this.onHoldTimeResults = cb;
  }

  /** Get the hold-time analyzer for direct access (e.g., /holdtime command) */
  getHoldTimeAnalyzer(): HoldTimeAnalyzer {
    return this.holdTimeAnalyzer;
  }

  /** Set callback for when new wallets are discovered */
  setNewWalletCallback(cb: (address: string) => void): void {
    this.onNewWallet = cb;
  }

  /** Seed initial wallets into DB */
  async seedWallets(capitalTier: CapitalTier): Promise<string[]> {
    // In shadow mode, seed ALL wallets regardless of tier for max signal coverage
    const eligible = config.shadowMode
      ? SEED_WALLETS
      : SEED_WALLETS.filter((w) => {
          const tierOrder = [CapitalTier.MICRO, CapitalTier.SMALL, CapitalTier.MEDIUM, CapitalTier.FULL];
          return tierOrder.indexOf(w.minTier) <= tierOrder.indexOf(capitalTier);
        });

    for (const w of eligible) {
      const isPumpFun = w.pumpfunOnly === true;
      const isGrad = w.label.startsWith('grad_');
      const source = isGrad ? WalletSource.GRADUATION_SEED
        : isPumpFun ? WalletSource.PUMPFUN_SEED
        : WalletSource.NANSEN_SEED;

      // Insert new seed wallets as active, but DON'T force-reactivate existing ones.
      // If a seed was deactivated due to bad performance, it should stay off until data improves.
      await query(
        `INSERT INTO alpha_wallets (address, label, source, tier, min_capital_tier, active, helius_subscribed, pumpfun_only)
         VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, $6)
         ON CONFLICT (address) DO UPDATE SET
           pumpfun_only = COALESCE(EXCLUDED.pumpfun_only, alpha_wallets.pumpfun_only),
           label = EXCLUDED.label`,
        [w.address, w.label, source, WalletTier.B, w.minTier, isPumpFun],
      );
    }

    const pfCount = eligible.filter((w) => w.pumpfunOnly).length;
    logger.info({ count: eligible.length, pumpfun: pfCount, tier: capitalTier }, 'Seed wallets loaded');
    return eligible.map((w) => w.address);
  }

  /**
   * Backfill nansen_roi_percent for wallets that have PnL data but no ROI.
   * Estimates ROI from PnL / trade count — conservative but better than 0.
   * Run on startup to fix wallets added before ROI was stored.
   */
  async backfillNansenRoi(): Promise<number> {
    // Estimate: if a wallet has $10K PnL across 20 trades, avg PnL per trade ≈ $500
    // Assume avg position size ~$1K → ROI ≈ 50% per trade → overall ROI ~1000%
    // Simplified: ROI ≈ (pnl_usd / max(trade_count, 1)) * 10 (assumes ~$100 avg cost basis per trade)
    const result = await query(
      `UPDATE alpha_wallets
       SET nansen_roi_percent = LEAST(
         (COALESCE(nansen_pnl_usd, 0) / GREATEST(COALESCE(nansen_trade_count, 1), 1)) * 10,
         5000
       )
       WHERE COALESCE(nansen_roi_percent, 0) = 0
         AND COALESCE(nansen_pnl_usd, 0) > 0
       RETURNING address`,
    );
    const count = result.rowCount || 0;
    if (count > 0) {
      logger.info({ count }, 'Backfilled nansen_roi_percent for existing wallets');
    }
    return count;
  }

  /** Deactivate wallets below $1K PnL minimum (run on startup to clean existing data) */
  async enforceMinimumPnl(): Promise<number> {
    const MIN_PNL_USD = 1_000;
    const result = await query(
      `UPDATE alpha_wallets SET active = FALSE
       WHERE active = TRUE
         AND source NOT IN ('NANSEN_SEED', 'PUMPFUN_SEED', 'GRADUATION_SEED')
         AND COALESCE(nansen_pnl_usd, 0) < $1
       RETURNING address`,
      [MIN_PNL_USD],
    );
    const count = result.rowCount || 0;
    if (count > 0) {
      logger.info({ count, minPnl: MIN_PNL_USD }, 'Deactivated wallets below minimum PnL threshold on startup');
    }
    return count;
  }

  /**
   * Aggressive startup purge: deactivate wallets that have zero evidence of being quick flippers.
   * Now applies to ALL wallets including seeds — no wallet gets a free pass with proven bad data.
   */
  async purgeWeakWallets(): Promise<number> {
    const gracePeriod = new Date(Date.now() - STALE_WALLET_DAYS * 24 * 60 * 60 * 1000);

    // 1. Non-seed wallets: original rules (no data past grace, bad alpha, bag holders)
    const discoveredResult = await query(
      `UPDATE alpha_wallets SET active = FALSE
       WHERE active = TRUE
         AND source NOT IN ('NANSEN_SEED', 'PUMPFUN_SEED', 'GRADUATION_SEED')
         AND (
           (COALESCE(our_total_trades, 0) = 0 AND COALESCE(round_trips_analyzed, 0) = 0
            AND discovered_at < $1)
           OR (COALESCE(round_trips_analyzed, 0) >= 3 AND COALESCE(short_term_alpha_score, 0) < 25)
           OR (COALESCE(median_hold_time_mins, 0) > 720 AND COALESCE(round_trips_analyzed, 0) >= 3)
         )
       RETURNING address`,
      [gracePeriod],
    );

    // 2. Seed wallets: deactivate if they have enough data proving they're bad
    //    - 5+ trades with <40% WR (proven loser with meaningful sample)
    //    - 5+ trades with negative avg PnL (net losing money)
    //    - Alpha score <20 with 3+ rounds analyzed (bad within our exit windows)
    const seedResult = await query(
      `UPDATE alpha_wallets SET active = FALSE
       WHERE active = TRUE
         AND source IN ('NANSEN_SEED', 'PUMPFUN_SEED', 'GRADUATION_SEED')
         AND (
           (COALESCE(our_total_trades, 0) >= 5 AND COALESCE(our_win_rate, 0) < 0.40)
           OR (COALESCE(our_total_trades, 0) >= 5 AND COALESCE(our_avg_pnl_percent, 0) < 0)
           OR (COALESCE(round_trips_analyzed, 0) >= 3 AND COALESCE(short_term_alpha_score, 0) < 20)
         )
       RETURNING address, label`,
    );

    const discoveredCount = discoveredResult.rowCount || 0;
    const seedCount = seedResult.rowCount || 0;
    const total = discoveredCount + seedCount;

    if (seedCount > 0) {
      const labels = seedResult.rows.map((r: { label: string }) => r.label).join(', ');
      logger.info({ count: seedCount, labels }, 'Purged underperforming SEED wallets on startup');
      console.log(`Purged ${seedCount} underperforming seed wallets: ${labels}`);
    }
    if (total > 0) {
      console.log(`Purged ${total} weak/unproven wallets on startup (${seedCount} seeds, ${discoveredCount} discovered)`);
    }
    return total;
  }

  /** Start periodic discovery */
  start(): void {
    this.discoveryInterval = setInterval(
      () => this.runDiscovery(),
      config.nansen.discoveryIntervalMs,
    );
    logger.info('Wallet discovery scheduler started (every 1h)');
  }

  stop(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
  }

  /** Run a discovery cycle: find top profitable traders from trending tokens */
  async runDiscovery(): Promise<void> {
    const start = Date.now();
    logger.info('Starting wallet discovery cycle...');

    try {
      const result = await this.discoverTopTraders();
      const walletsRemoved = await this.validateExistingWallets();

      // Run hold-time analysis on all active wallets
      // This scores wallets on short-term profitability within our exit windows
      logger.info('Running hold-time analysis...');
      const holdTimeResults = await this.holdTimeAnalyzer.enforceHoldTimeRequirements();
      if (holdTimeResults.deactivated.length > 0 || holdTimeResults.demoted.length > 0) {
        logger.info({
          deactivated: holdTimeResults.deactivated.length,
          demoted: holdTimeResults.demoted.length,
        }, 'Hold-time enforcement applied');
        this.onHoldTimeResults?.(holdTimeResults);
      }

      // Auto-cleanup: remove stale, slow, and excess wallets
      const cleanup = await this.autoCleanup();

      const duration = Date.now() - start;
      await this.logDiscovery(result.tokensScreened, result.candidates, result.added,
        walletsRemoved + holdTimeResults.deactivated.length + cleanup.removed, duration);

      logger.info({
        tokensScreened: result.tokensScreened,
        candidates: result.candidates,
        added: result.added,
        removed: walletsRemoved + holdTimeResults.deactivated.length + cleanup.removed,
        holdTimeDemoted: holdTimeResults.demoted.length,
        cleanupReasons: cleanup.reasons,
        durationMs: duration,
      }, 'Discovery cycle complete');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
      if (axiosErr.response) {
        logger.error({ status: axiosErr.response.status, data: axiosErr.response.data }, 'Wallet discovery failed');
      } else {
        logger.error({ err }, 'Wallet discovery failed');
      }
    }
  }

  /**
   * Single pipeline: screen trending tokens → get PnL leaderboard for each →
   * find the most profitable traders across multiple tokens and watch them.
   * Uses ~26 API calls per cycle (1 screener + 25 leaderboard).
   */
  private async discoverTopTraders(): Promise<{ added: number; candidates: number; tokensScreened: number }> {
    // Step 1: Find trending Solana memecoins via token screener
    let tokens: { address: string; symbol: string }[] = [];
    try {
      const screenerResults = await this.nansen.tokenScreener({
        mcapMin: 50_000,
        mcapMax: 50_000_000,
        liquidityMin: 5_000,
        minTraders: 5,
        limit: 50,
      });
      tokens = screenerResults.map((t) => ({ address: t.token_address, symbol: t.token_symbol }));
      logger.info({ count: tokens.length }, 'Token screener returned tokens');
    } catch (err: unknown) {
      const axErr = err as { response?: { status?: number }; message?: string };
      logger.warn({ status: axErr.response?.status, err: axErr.message }, 'Token screener failed');
      return { added: 0, candidates: 0, tokensScreened: 0 };
    }

    if (tokens.length === 0) {
      return { added: 0, candidates: 0, tokensScreened: 0 };
    }

    // Step 2: For the top 25 tokens, pull 30-day PnL leaderboard to find top profitable traders
    // 25 tokens keeps us within rate limits (1 screener + 25 leaderboard = 26 calls/cycle, limit is 80/min)
    const tokensToProcess = tokens.slice(0, 25);
    const walletScores = new Map<string, {
      label: string;
      totalPnl: number;
      totalTrades: number;
      tokensFound: number;
      bestRoi: number;
    }>();
    let tokensProcessed = 0;

    for (const token of tokensToProcess) {
      try {
        const leaders = await this.nansen.tokenPnlLeaderboard(token.address, {
          pnlUsdMin: 50,
          tradesMin: 1,
          limit: 50,
        });

        tokensProcessed++;
        for (const leader of leaders) {
          if (!leader.trader_address || leader.pnl_usd_total <= 0) continue;

          const existing = walletScores.get(leader.trader_address) || {
            label: leader.trader_address_label || leader.trader_address.slice(0, 8),
            totalPnl: 0, totalTrades: 0, tokensFound: 0, bestRoi: 0,
          };
          existing.totalPnl += leader.pnl_usd_total;
          existing.totalTrades += leader.nof_trades;
          existing.tokensFound++;
          existing.bestRoi = Math.max(existing.bestRoi, leader.roi_percent_total || 0);
          walletScores.set(leader.trader_address, existing);
        }
      } catch (err: unknown) {
        const axErr = err as { response?: { status?: number }; message?: string };
        const status = axErr.response?.status;
        if (status === 403 || status === 429) {
          logger.warn(
            { tokensProcessed, total: tokensToProcess.length, traders: walletScores.size },
            `Nansen leaderboard blocked (${status}) — using ${walletScores.size} traders from ${tokensProcessed} tokens`,
          );
          break;
        }
        logger.warn({ token: token.symbol, err: axErr.message }, 'PnL leaderboard failed for token');
      }
    }

    if (walletScores.size === 0) {
      logger.info('No profitable traders found');
      return { added: 0, candidates: 0, tokensScreened: tokensProcessed };
    }

    // Step 3: Score and rank — prioritize multi-token profitable traders
    const candidates: WalletCandidate[] = [];
    for (const [addr, data] of walletScores) {
      // PnL weight (40%) + trade activity (30%) + multi-token presence (30%)
      const pnlScore = Math.min(Math.log10(Math.max(data.totalPnl, 1)) / 5, 1) * 0.40;
      const tradeScore = Math.min(data.totalTrades / 20, 1) * 0.30;
      const diversityScore = Math.min(data.tokensFound / 5, 1) * 0.30;

      candidates.push({
        address: addr,
        label: `${data.label} | PnL $${data.totalPnl >= 1000 ? (data.totalPnl / 1000).toFixed(0) + 'K' : data.totalPnl.toFixed(0)}`,
        tradeCount: data.totalTrades,
        totalVolumeUsd: data.totalPnl,
        tokensTraded: data.tokensFound,
        bestRoi: data.bestRoi,
        score: pnlScore + tradeScore + diversityScore,
      });
    }

    // Filter out wallets below PnL minimum — lowered to $1K for quick-flip micro traders
    const MIN_PNL_USD = 1_000;
    const qualifiedCandidates = candidates.filter((c) => c.totalVolumeUsd >= MIN_PNL_USD);
    logger.info({
      total: candidates.length,
      qualified: qualifiedCandidates.length,
      filtered: candidates.length - qualifiedCandidates.length,
      minPnl: MIN_PNL_USD,
    }, 'Applied $1K minimum PnL filter');

    qualifiedCandidates.sort((a, b) => b.score - a.score);
    let added = 0;
    for (const c of qualifiedCandidates) {
      if (await this.addWallet(c)) added++;
    }

    logger.info({
      tokensScreened: tokensProcessed,
      tradersFound: walletScores.size,
      added,
    }, 'Discovery complete — top PnL traders identified');
    return { added, candidates: candidates.length, tokensScreened: tokensProcessed };
  }

  private async addWallet(candidate: WalletCandidate): Promise<boolean> {
    try {
      // Check if wallet exists but was deactivated — reactivate if it now qualifies
      const existing = await getMany<{ address: string; active: boolean; short_term_alpha_score: number | null }>(
        `SELECT address, active, short_term_alpha_score FROM alpha_wallets WHERE address = $1`,
        [candidate.address],
      );

      if (existing.length > 0 && !existing[0].active) {
        // Previously deactivated — only reactivate if it was deactivated because it
        // had no data (score is null), not because it was proven bad (score < 25)
        const score = existing[0].short_term_alpha_score;
        if (score !== null && score < 25) {
          // Proven bad — don't reactivate
          return false;
        }
        // No score yet or decent score — reactivate
        await query(
          `UPDATE alpha_wallets SET active = TRUE, label = $2, nansen_trade_count = $3,
                  nansen_pnl_usd = $4, nansen_roi_percent = $5, last_validated_at = NOW()
           WHERE address = $1`,
          [candidate.address, candidate.label, candidate.tradeCount, candidate.totalVolumeUsd, candidate.bestRoi],
        );
        if (this.onNewWallet) this.onNewWallet(candidate.address);
        logger.info({ address: candidate.address.slice(0, 8), pnl: candidate.totalVolumeUsd }, 'Reactivated wallet');
        return true;
      }

      const result = await query(
        `INSERT INTO alpha_wallets (address, label, source, nansen_trade_count, nansen_pnl_usd, nansen_roi_percent, tier, active, helius_subscribed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, FALSE)
         ON CONFLICT (address) DO UPDATE SET
           label = $2,
           nansen_trade_count = $4,
           nansen_pnl_usd = $5,
           nansen_roi_percent = $6,
           last_validated_at = NOW()
         RETURNING (xmax = 0) AS is_new`,
        [
          candidate.address,
          candidate.label,
          WalletSource.NANSEN_DISCOVERY,
          candidate.tradeCount,
          candidate.totalVolumeUsd,
          candidate.bestRoi,
          WalletTier.B,
        ],
      );

      const isNew = result.rows[0]?.is_new;
      if (isNew && this.onNewWallet) {
        this.onNewWallet(candidate.address);
      }
      return !!isNew;
    } catch (err) {
      logger.error({ err, address: candidate.address }, 'Failed to add wallet');
      return false;
    }
  }

  private async validateExistingWallets(): Promise<number> {
    // Auto-promote: 3+ trades, >50% win rate, avg hold <4h, alpha score >40 → Tier A (quick flippers)
    await query(
      `UPDATE alpha_wallets SET tier = 'A'
       WHERE tier = 'B' AND our_total_trades >= 3 AND our_win_rate > 0.50
         AND our_avg_hold_time_mins < 240
         AND COALESCE(short_term_alpha_score, 0) > 40`,
    );

    // Demote: 2 consecutive losses → Tier B (tighter than before)
    await query(
      `UPDATE alpha_wallets SET tier = 'B' WHERE tier = 'A' AND consecutive_losses >= 2`,
    );

    // Deactivate: 3 consecutive losses — now applies to ALL wallets including seeds
    const deactivated = await query(
      `UPDATE alpha_wallets SET active = FALSE
       WHERE active = TRUE AND consecutive_losses >= 3
       RETURNING address, label, source`,
    );
    if ((deactivated.rowCount || 0) > 0) {
      const seedHits = deactivated.rows.filter((r: { source: string }) =>
        ['NANSEN_SEED', 'PUMPFUN_SEED', 'GRADUATION_SEED'].includes(r.source));
      if (seedHits.length > 0) {
        logger.info({ wallets: seedHits.map((r: { label: string }) => r.label) },
          'Deactivated seed wallet(s) — 3 consecutive losses');
      }
    }

    // Deactivate wallets below $1K PnL minimum (skip seed wallets which may lack PnL data)
    const pnlPurged = await query(
      `UPDATE alpha_wallets SET active = FALSE
       WHERE active = TRUE
         AND source NOT IN ('NANSEN_SEED', 'PUMPFUN_SEED', 'GRADUATION_SEED')
         AND COALESCE(nansen_pnl_usd, 0) < 1000
       RETURNING address`,
    );
    if ((pnlPurged.rowCount || 0) > 0) {
      logger.info({ count: pnlPurged.rowCount }, 'Deactivated wallets below $1K PnL minimum');
    }

    // Check on-chain trade activity via Helius
    const activityDeactivated = await this.enforceTradeActivity();

    return (deactivated.rowCount || 0) + (pnlPurged.rowCount || 0) + activityDeactivated;
  }

  private async logDiscovery(
    tokensScreened: number,
    walletsEvaluated: number,
    walletsAdded: number,
    walletsRemoved: number,
    durationMs: number,
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO wallet_discovery_log (tokens_screened, wallets_evaluated, wallets_added, wallets_removed, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [tokensScreened, walletsEvaluated, walletsAdded, walletsRemoved, JSON.stringify({ durationMs })],
      );
    } catch (err) {
      logger.error({ err }, 'Failed to log discovery');
    }
  }

  /**
   * Check on-chain activity for all active wallets via Helius getSignaturesForAddress.
   * Deactivates wallets with no transactions in the last 7 days (except seeds).
   * Updates last_active_at for all checked wallets.
   */
  async enforceTradeActivity(forceCheckAll = false): Promise<number> {
    const INACTIVE_DAYS = 7;
    const cutoff = new Date(Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000);

    const wallets = await getMany<{ address: string; source: string; last_active_at: string | null }>(
      `SELECT address, source, last_active_at FROM alpha_wallets WHERE active = TRUE`,
    );

    console.log(`🔍 Checking on-chain activity for ${wallets.length} wallets (force=${forceCheckAll})...`);

    let deactivated = 0;
    let checked = 0;
    let skipped = 0;

    for (const wallet of wallets) {
      // Skip wallets known active within 7d (unless force-checking all)
      if (!forceCheckAll && wallet.last_active_at) {
        const lastActive = new Date(wallet.last_active_at);
        if (lastActive.getTime() > cutoff.getTime()) {
          skipped++;
          continue; // Known active within window, skip RPC call
        }
      }

      try {
        const lastTxTime = await this.getLastTransactionTime(wallet.address);
        checked++;

        const isSeed = wallet.source === 'NANSEN_SEED' || wallet.source === 'PUMPFUN_SEED' || wallet.source === 'GRADUATION_SEED';
        // Even seed wallets should be deactivated if dead for 30+ days — no wallet is worth
        // watching after a month of silence (e.g. abandoned wallets, compromised keys)
        const SEED_HARD_CUTOFF_DAYS = 30;
        const seedCutoff = new Date(Date.now() - SEED_HARD_CUTOFF_DAYS * 24 * 60 * 60 * 1000);

        if (lastTxTime) {
          // Update last_active_at with actual on-chain activity time
          await query(
            `UPDATE alpha_wallets SET last_active_at = $1 WHERE address = $2`,
            [new Date(lastTxTime * 1000), wallet.address],
          );

          // Deactivate if inactive for too long
          if (!isSeed && lastTxTime * 1000 < cutoff.getTime()) {
            await query(`UPDATE alpha_wallets SET active = FALSE WHERE address = $1`, [wallet.address]);
            deactivated++;
            logger.info({
              address: wallet.address.slice(0, 8),
              lastActiveAgo: `${Math.round((Date.now() - lastTxTime * 1000) / 86400000)}d`,
            }, 'Deactivated inactive wallet');
          } else if (isSeed && lastTxTime * 1000 < seedCutoff.getTime()) {
            // Seed wallets inactive 30+ days — deactivate (likely abandoned)
            await query(`UPDATE alpha_wallets SET active = FALSE WHERE address = $1`, [wallet.address]);
            deactivated++;
            logger.info({
              address: wallet.address.slice(0, 8),
              lastActiveAgo: `${Math.round((Date.now() - lastTxTime * 1000) / 86400000)}d`,
              source: wallet.source,
            }, 'Deactivated seed wallet — inactive >30d');
          }
        } else {
          // No transactions found at all — deactivate non-seeds
          if (!isSeed) {
            await query(`UPDATE alpha_wallets SET active = FALSE WHERE address = $1`, [wallet.address]);
            deactivated++;
            logger.info({ address: wallet.address.slice(0, 8) }, 'Deactivated wallet — no on-chain activity found');
          } else {
            // Seed wallet with zero on-chain activity — deactivate
            await query(`UPDATE alpha_wallets SET active = FALSE WHERE address = $1`, [wallet.address]);
            deactivated++;
            logger.info({ address: wallet.address.slice(0, 8), source: wallet.source },
              'Deactivated seed wallet — no on-chain activity found');
          }
        }

        // Rate-limit RPC calls: ~100ms between each
        if (checked % 10 === 0) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        logger.debug({ err, address: wallet.address.slice(0, 8) }, 'Failed to check wallet activity');
      }
    }

    console.log(`✅ Activity check: ${checked} checked, ${skipped} skipped (known active), ${deactivated} deactivated (inactive >${INACTIVE_DAYS}d)`);
    if (deactivated > 0 || checked > 0) {
      logger.info({ checked, skipped, deactivated, total: wallets.length, inactiveDays: INACTIVE_DAYS },
        'Trade activity check complete');
    }
    return deactivated;
  }

  /**
   * Get the timestamp of a wallet's most recent transaction via Helius RPC.
   * Returns blockTime (unix seconds) or null if no recent tx found.
   */
  private async getLastTransactionTime(address: string): Promise<number | null> {
    try {
      const resp = await axios.post(config.helius.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit: 1 }],
      }, { timeout: 5000 });

      const signatures = resp.data?.result;
      if (Array.isArray(signatures) && signatures.length > 0) {
        return signatures[0].blockTime || null;
      }
    } catch {
      // Silent — will be logged by caller
    }
    return null;
  }

  /**
   * Automatic wallet cleanup — runs every discovery cycle.
   * 1. Remove stale wallets (no trade data after STALE_WALLET_DAYS)
   * 2. Remove wallets with median hold >12h (proven slow holders)
   * 3. Cap total active wallets at MAX_ACTIVE_WALLETS (cut lowest-scoring)
   */
  async autoCleanup(): Promise<{ removed: number; reasons: Record<string, number> }> {
    const reasons: Record<string, number> = {};
    let totalRemoved = 0;

    // 1. Stale wallets: discovered >3 days ago, no trade data from us, not a seed
    const staleCutoff = new Date(Date.now() - STALE_WALLET_DAYS * 24 * 60 * 60 * 1000);
    const staleResult = await query(
      `UPDATE alpha_wallets SET active = FALSE
       WHERE active = TRUE
         AND source NOT IN ('NANSEN_SEED', 'PUMPFUN_SEED', 'GRADUATION_SEED')
         AND COALESCE(our_total_trades, 0) = 0
         AND COALESCE(round_trips_analyzed, 0) = 0
         AND discovered_at < $1
       RETURNING address`,
      [staleCutoff],
    );
    const staleCount = staleResult.rowCount || 0;
    if (staleCount > 0) {
      reasons['stale (no trade data)'] = staleCount;
      totalRemoved += staleCount;
      logger.info({ count: staleCount }, 'Removed stale wallets with no trade data');
    }

    // 2. Proven slow holders: median hold >12h with 3+ analyzed trips — ALL wallets including seeds
    const slowResult = await query(
      `UPDATE alpha_wallets SET active = FALSE
       WHERE active = TRUE
         AND COALESCE(median_hold_time_mins, 0) > 720
         AND COALESCE(round_trips_analyzed, 0) >= 3
       RETURNING address`,
    );
    const slowCount = slowResult.rowCount || 0;
    if (slowCount > 0) {
      reasons['slow holder (median >12h)'] = slowCount;
      totalRemoved += slowCount;
      logger.info({ count: slowCount }, 'Removed slow-holder wallets (median hold >12h)');
    }

    // 3. Proven losers: 5+ trades with <40% WR or negative avg PnL — ALL wallets including seeds
    const loserResult = await query(
      `UPDATE alpha_wallets SET active = FALSE
       WHERE active = TRUE
         AND COALESCE(our_total_trades, 0) >= 5
         AND (COALESCE(our_win_rate, 0) < 0.40 OR COALESCE(our_avg_pnl_percent, 0) < 0)
       RETURNING address`,
    );
    const loserCount = loserResult.rowCount || 0;
    if (loserCount > 0) {
      reasons['proven loser (5+ trades, <40% WR or negative PnL)'] = loserCount;
      totalRemoved += loserCount;
      logger.info({ count: loserCount }, 'Removed proven loser wallets');
    }

    // 4. Low alpha score with data: alpha <15 with 3+ rounds = not profitable in our windows
    const lowAlphaResult = await query(
      `UPDATE alpha_wallets SET active = FALSE
       WHERE active = TRUE
         AND COALESCE(round_trips_analyzed, 0) >= 3
         AND COALESCE(short_term_alpha_score, 0) < 15
       RETURNING address`,
    );
    const lowAlphaCount = lowAlphaResult.rowCount || 0;
    if (lowAlphaCount > 0) {
      reasons['low alpha score (<15 with 3+ rounds)'] = lowAlphaCount;
      totalRemoved += lowAlphaCount;
      logger.info({ count: lowAlphaCount }, 'Removed low alpha score wallets');
    }

    // 5. Cap at MAX_ACTIVE_WALLETS — remove lowest-scoring non-seed wallets
    const activeCount = await getMany<{ count: string }>(
      `SELECT COUNT(*) as count FROM alpha_wallets WHERE active = TRUE`,
    );
    const currentActive = parseInt(activeCount[0]?.count || '0');
    if (currentActive > MAX_ACTIVE_WALLETS) {
      const excess = currentActive - MAX_ACTIVE_WALLETS;
      // Remove the lowest-scoring wallets (seeds included — earn your slot)
      const capResult = await query(
        `UPDATE alpha_wallets SET active = FALSE
         WHERE address IN (
           SELECT address FROM alpha_wallets
           WHERE active = TRUE
           ORDER BY
             COALESCE(short_term_alpha_score, 0) ASC,
             COALESCE(our_win_rate, 0) ASC,
             COALESCE(nansen_pnl_usd, 0) ASC
           LIMIT $1
         )
         RETURNING address`,
        [excess],
      );
      const capCount = capResult.rowCount || 0;
      if (capCount > 0) {
        reasons[`cap exceeded (>${MAX_ACTIVE_WALLETS})`] = capCount;
        totalRemoved += capCount;
        logger.info({ count: capCount, cap: MAX_ACTIVE_WALLETS }, 'Removed lowest-scoring wallets to enforce cap');
      }
    }

    if (totalRemoved > 0) {
      logger.info({ totalRemoved, reasons }, 'Auto-cleanup complete');
    }

    return { removed: totalRemoved, reasons };
  }

  /** Get all active wallet addresses — ranked by composite performance score.
   *  When pumpFunOnlyMode is true, heavily prioritize wallets that trade on bonding curves. */
  async getActiveWallets(pumpFunOnlyMode = false): Promise<string[]> {
    const isPumpFunOnlyMode = pumpFunOnlyMode;

    const rows = await getMany<{ address: string }>(
      `SELECT address,
         (
           -- Seed wallets get base priority (reduced for non-pumpfun seeds in curve scalp mode)
           CASE
             WHEN source = 'GRADUATION_SEED' THEN 60
             WHEN source IN ('NANSEN_SEED', 'PUMPFUN_SEED') AND pumpfun_only = TRUE THEN 50
             WHEN source IN ('NANSEN_SEED', 'PUMPFUN_SEED') AND $1 = TRUE THEN 20
             WHEN source IN ('NANSEN_SEED', 'PUMPFUN_SEED') THEN 50
             WHEN source = 'GRADUATION_DISCOVERY' THEN 35
             ELSE 0
           END
           -- Pump.fun wallet bonus in curve scalp mode (+25 for pumpfun_only wallets)
           + CASE WHEN $1 = TRUE AND pumpfun_only = TRUE THEN 25 ELSE 0 END
           -- PumpPortal-discovered wallets get extra bump (real-time validated on curves)
           + CASE WHEN $1 = TRUE AND source = 'PUMPFUN_DISCOVERY' THEN 15 ELSE 0 END
           -- Tier A wallets get priority
           + CASE WHEN tier = 'A' THEN 30 ELSE 0 END
           -- SHORT-TERM ALPHA SCORE (0-100 → 0-40 pts) — biggest weight
           -- This measures whether the wallet is profitable within OUR hold windows
           + LEAST(COALESCE(short_term_alpha_score, 0) * 0.4, 40)
           -- Nansen ROI (capped at 10 points, reduced from 20)
           + LEAST(COALESCE(nansen_roi_percent, 0) / 25, 10)
           -- Our win rate contribution (up to 20 points, only if 3+ trades)
           + CASE WHEN our_total_trades >= 3 THEN COALESCE(our_win_rate, 0) * 20 ELSE 0 END
           -- Our avg PnL (up to 10 points)
           + LEAST(GREATEST(COALESCE(our_avg_pnl_percent, 0) * 100, 0), 10)
           -- Recent on-chain activity bonus (up to 20 points)
           + CASE
               WHEN last_active_at IS NULL THEN 0
               WHEN last_active_at > NOW() - INTERVAL '1 day' THEN 20
               WHEN last_active_at > NOW() - INTERVAL '3 days' THEN 15
               WHEN last_active_at > NOW() - INTERVAL '7 days' THEN 10
               ELSE 0
             END
           -- Consecutive losses penalty
           - COALESCE(consecutive_losses, 0) * 10
           -- Bag-holder penalty: high median hold time = bad fit for quick flips
           - CASE
               WHEN COALESCE(median_hold_time_mins, 0) > 720 AND COALESCE(round_trips_analyzed, 0) >= 3 THEN 30
               WHEN COALESCE(median_hold_time_mins, 0) > 240 AND COALESCE(round_trips_analyzed, 0) >= 3 THEN 15
               ELSE 0
             END
           -- Stale wallet penalty: inactive 3+ days with no tracked trades = dead weight
           - CASE
               WHEN COALESCE(our_total_trades, 0) = 0
                 AND last_active_at < NOW() - INTERVAL '3 days' THEN 40
               WHEN COALESCE(our_total_trades, 0) = 0
                 AND last_active_at < NOW() - INTERVAL '1 day' THEN 20
               ELSE 0
             END
           -- In curve scalp mode, penalize non-pumpfun wallets with zero signal history
           - CASE
               WHEN $1 = TRUE AND pumpfun_only = FALSE
                 AND COALESCE(our_total_trades, 0) = 0 THEN 25
               ELSE 0
             END
         ) as score
       FROM alpha_wallets WHERE active = TRUE
       ORDER BY score DESC`,
      [isPumpFunOnlyMode],
    );
    return rows.map((r) => r.address);
  }
}
