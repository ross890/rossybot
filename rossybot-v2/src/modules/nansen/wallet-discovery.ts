import { logger } from '../../utils/logger.js';
import { query, getMany } from '../../db/database.js';
import { config, SEED_WALLETS, getTierConfig, getTierForCapital } from '../../config/index.js';
import { CapitalTier, WalletSource, WalletTier } from '../../types/index.js';
import { NansenClient } from './client.js';

interface WalletCandidate {
  address: string;
  label: string;
  tradeCount: number;
  totalVolumeUsd: number;
  tokensTraded: number;
  score: number;
}

export class WalletDiscovery {
  private nansen: NansenClient;
  private discoveryInterval: ReturnType<typeof setInterval> | null = null;
  private onNewWallet: ((address: string) => void) | null = null;

  constructor(nansen: NansenClient) {
    this.nansen = nansen;
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
      await query(
        `INSERT INTO alpha_wallets (address, label, source, tier, min_capital_tier, active, helius_subscribed)
         VALUES ($1, $2, $3, $4, $5, TRUE, FALSE)
         ON CONFLICT (address) DO UPDATE SET active = TRUE`,
        [w.address, w.label, WalletSource.NANSEN_SEED, WalletTier.B, w.minTier],
      );
    }

    logger.info({ count: eligible.length, tier: capitalTier }, 'Seed wallets loaded');
    return eligible.map((w) => w.address);
  }

  /** Remove all previously discovered wallets (clean slate for new discovery method) */
  async purgeWeakWallets(): Promise<number> {
    const result = await query(
      `DELETE FROM alpha_wallets
       WHERE source != 'NANSEN_SEED'
       RETURNING address`,
    );
    const count = result.rowCount || 0;
    if (count > 0) {
      console.log(`Purged ${count} old discovered wallets`);
    }
    return count;
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

      const duration = Date.now() - start;
      await this.logDiscovery(result.tokensScreened, result.candidates, result.added, walletsRemoved, duration);

      logger.info({
        tokensScreened: result.tokensScreened,
        candidates: result.candidates,
        added: result.added,
        removed: walletsRemoved,
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
   * Uses ~9 API calls per cycle (1 screener + 8 leaderboard).
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

    // Step 2: For the top 8 tokens, pull 30-day PnL leaderboard to find top profitable traders
    // 8 tokens keeps us well within rate limits (1 screener + 8 leaderboard = 9 calls/cycle)
    const tokensToProcess = tokens.slice(0, 8);
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
          pnlUsdMin: 100,
          tradesMin: 1,
          limit: 25,
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
        score: pnlScore + tradeScore + diversityScore,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    let added = 0;
    for (const c of candidates) {
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
      const result = await query(
        `INSERT INTO alpha_wallets (address, label, source, nansen_trade_count, nansen_pnl_usd, tier, active, helius_subscribed)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, FALSE)
         ON CONFLICT (address) DO UPDATE SET
           label = $2,
           nansen_trade_count = $4,
           nansen_pnl_usd = $5,
           last_validated_at = NOW()
         RETURNING (xmax = 0) AS is_new`,
        [
          candidate.address,
          candidate.label,
          WalletSource.NANSEN_DISCOVERY,
          candidate.tradeCount,
          candidate.totalVolumeUsd,
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
    // Auto-promote: 5+ trades, >40% win rate, avg hold <12h → Tier A
    await query(
      `UPDATE alpha_wallets SET tier = 'A'
       WHERE tier = 'B' AND our_total_trades >= 5 AND our_win_rate > 0.40 AND our_avg_hold_time_mins < 720`,
    );

    // Demote: 3 consecutive losses → Tier B
    await query(
      `UPDATE alpha_wallets SET tier = 'B' WHERE tier = 'A' AND consecutive_losses >= 3`,
    );

    // Deactivate: 5 consecutive losses
    const deactivated = await query(
      `UPDATE alpha_wallets SET active = FALSE WHERE active = TRUE AND consecutive_losses >= 5 RETURNING address`,
    );

    return deactivated.rowCount || 0;
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

  /** Get all active wallet addresses — ranked by composite performance score */
  async getActiveWallets(): Promise<string[]> {
    const rows = await getMany<{ address: string }>(
      `SELECT address,
         (
           -- Seed wallets get base priority
           CASE WHEN source = 'NANSEN_SEED' THEN 50 ELSE 0 END
           -- Tier A wallets get priority
           + CASE WHEN tier = 'A' THEN 30 ELSE 0 END
           -- Nansen ROI (capped at 20 points)
           + LEAST(COALESCE(nansen_roi_percent, 0) / 25, 20)
           -- Our win rate contribution (up to 30 points, only if 3+ trades)
           + CASE WHEN our_total_trades >= 3 THEN COALESCE(our_win_rate, 0) * 30 ELSE 0 END
           -- Our avg PnL (up to 15 points)
           + LEAST(GREATEST(COALESCE(our_avg_pnl_percent, 0) * 100, 0), 15)
           -- Consecutive losses penalty
           - COALESCE(consecutive_losses, 0) * 10
         ) as score
       FROM alpha_wallets WHERE active = TRUE
       ORDER BY score DESC`,
    );
    return rows.map((r) => r.address);
  }
}
