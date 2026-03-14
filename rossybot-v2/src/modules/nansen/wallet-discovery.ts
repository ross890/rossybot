import { logger } from '../../utils/logger.js';
import { query, getMany } from '../../db/database.js';
import { config, SEED_WALLETS, getTierConfig, getTierForCapital } from '../../config/index.js';
import { CapitalTier, WalletSource, WalletTier } from '../../types/index.js';
import { NansenClient, type TokenScreenerItem, type PnlLeaderboardItem } from './client.js';

interface WalletCandidate {
  address: string;
  realizedPnl: number;
  unrealizedPnl: number;
  tradeCount: number;
  roiPercent: number;
  holdingRatio: number;
  score: number;
  sourceToken: string;
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
    const eligible = SEED_WALLETS.filter((w) => {
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

  /** Start periodic discovery */
  start(): void {
    this.discoveryInterval = setInterval(
      () => this.runDiscovery(),
      config.nansen.discoveryIntervalMs,
    );
    logger.info('Wallet discovery scheduler started (every 4h)');
  }

  stop(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
  }

  /** Run a full discovery cycle */
  async runDiscovery(): Promise<void> {
    const start = Date.now();
    console.log('🔍 Starting wallet discovery cycle...');

    try {
      // Step 1: Get trending tokens from screener
      const currentTier = CapitalTier.MICRO; // TODO: get from capital manager
      const tierCfg = getTierConfig(currentTier);

      console.log(`Step 1: Screening tokens (mcap $${tierCfg.mcapMin/1000}k-$${tierCfg.mcapMax/1000}k, liq >$${tierCfg.liquidityMin/1000}k)`);
      const tokens: TokenScreenerItem[] = await this.nansen.tokenScreener({
        mcapMin: tierCfg.mcapMin,
        mcapMax: tierCfg.mcapMax,
        liquidityMin: tierCfg.liquidityMin,
        minTraders: 20,
        limit: currentTier === CapitalTier.MICRO || currentTier === CapitalTier.SMALL ? 10 : 20,
      });

      if (!tokens || tokens.length === 0) {
        console.log('No trending tokens found in screener');
        await this.logDiscovery(0, 0, 0, 0, Date.now() - start);
        return;
      }
      console.log(`Found ${tokens.length} trending tokens`);
      for (const t of tokens.slice(0, 5)) {
        console.log(`  - ${t.token_symbol} (${t.token_address.slice(0, 8)}...) | MCap: $${(t.market_cap_usd/1000).toFixed(0)}k | Netflow: $${(t.netflow/1000).toFixed(0)}k`);
      }

      // Step 2: Get PnL leaderboard for top tokens
      const allCandidates: WalletCandidate[] = [];
      const tokenAddresses = tokens.slice(0, 2).map((t) => t.token_address).filter(Boolean);
      console.log(`Step 2: Checking PnL leaderboard for ${tokenAddresses.length} tokens`);

      for (const tokenAddr of tokenAddresses) {
        try {
          const leaders: PnlLeaderboardItem[] = await this.nansen.tokenPnlLeaderboard(tokenAddr, {
            pnlUsdMin: 1000,
            tradesMin: 10,
            tradesMax: 100,
            holdingRatioMax: 0.3,
          });

          console.log(`  Token ${tokenAddr.slice(0, 8)}: ${leaders.length} traders on leaderboard`);

          for (const l of leaders) {
            const addr = l.trader_address;
            if (!addr) continue;

            const realizedPnl = l.pnl_usd_realised || 0;
            const unrealizedPnl = l.pnl_usd_unrealised || 0;
            const tradeCount = l.nof_trades || 0;
            const roiPercent = l.roi_percent_total || 0;
            const holdingRatio = l.still_holding_balance_ratio || 0;

            // Red flag filters
            if (holdingRatio > 0.7) continue;
            if (tradeCount < 5) continue;
            if (tradeCount > 100) continue;

            // Score the wallet
            const score = this.scoreWallet(realizedPnl, unrealizedPnl, tradeCount, roiPercent, holdingRatio);

            allCandidates.push({
              address: addr,
              realizedPnl,
              unrealizedPnl,
              tradeCount,
              roiPercent,
              holdingRatio,
              score,
              sourceToken: tokenAddr,
            });
          }
        } catch (err: unknown) {
          const axErr = err as { response?: { status?: number; data?: unknown }; message?: string };
          if (axErr.response?.data) {
            console.error(`Failed to get PnL leaderboard for ${tokenAddr.slice(0, 8)}: ${axErr.response.status} — ${JSON.stringify(axErr.response.data)}`);
          } else {
            console.error(`Failed to get PnL leaderboard for ${tokenAddr.slice(0, 8)}: ${axErr.message || err}`);
          }
        }
      }

      // Step 3: Rank and add top candidates
      allCandidates.sort((a, b) => b.score - a.score);
      const topCandidates = allCandidates.slice(0, 10);

      let walletsAdded = 0;
      for (const c of topCandidates) {
        const isNew = await this.addWallet(c);
        if (isNew) walletsAdded++;
      }

      // Step 4: Validate/demote existing wallets
      const walletsRemoved = await this.validateExistingWallets();

      const duration = Date.now() - start;
      await this.logDiscovery(tokenAddresses.length, allCandidates.length, walletsAdded, walletsRemoved, duration);

      console.log(`✅ Discovery complete: ${tokenAddresses.length} tokens screened, ${allCandidates.length} candidates evaluated, ${walletsAdded} wallets added, ${walletsRemoved} removed (${duration}ms)`);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
      if (axiosErr.response) {
        console.error(`❌ Wallet discovery failed: ${axiosErr.response.status} — ${JSON.stringify(axiosErr.response.data)}`);
      } else {
        console.error(`❌ Wallet discovery failed: ${axiosErr.message || err}`);
      }
    }
  }

  private scoreWallet(
    realizedPnl: number,
    unrealizedPnl: number,
    tradeCount: number,
    roiPercent: number,
    holdingRatio: number,
  ): number {
    // Normalize each factor to 0-1 range
    const pnlScore = Math.min(realizedPnl / 10_000, 1) * 0.30;

    // Low unrealized vs realized = better
    const unrealizedRatio = realizedPnl > 0 ? Math.abs(unrealizedPnl) / realizedPnl : 1;
    const unrealizedScore = Math.max(1 - unrealizedRatio, 0) * 0.15;

    // Trade frequency: 20-100 is ideal
    const freqScore = (tradeCount >= 20 && tradeCount <= 100 ? 1 : tradeCount < 20 ? tradeCount / 20 : 100 / tradeCount) * 0.20;

    // ROI
    const roiScore = Math.min(roiPercent / 500, 1) * 0.15;

    // Holding ratio: lower is better
    const holdScore = Math.max(1 - holdingRatio / 0.3, 0) * 0.10;

    // Multi-token consistency placeholder (would need cross-token data)
    const consistencyScore = 0.05; // Base 50% — improved with actual data

    return pnlScore + unrealizedScore + freqScore + roiScore + holdScore + consistencyScore;
  }

  private async addWallet(candidate: WalletCandidate): Promise<boolean> {
    try {
      const result = await query(
        `INSERT INTO alpha_wallets (address, label, source, nansen_pnl_usd, nansen_roi_percent, nansen_holding_ratio, nansen_trade_count, nansen_realized_pnl, nansen_unrealized_pnl, tier, active, helius_subscribed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, FALSE)
         ON CONFLICT (address) DO UPDATE SET
           nansen_pnl_usd = $4, nansen_roi_percent = $5, nansen_holding_ratio = $6,
           nansen_trade_count = $7, nansen_realized_pnl = $8, nansen_unrealized_pnl = $9,
           last_validated_at = NOW()
         RETURNING (xmax = 0) AS is_new`,
        [
          candidate.address,
          `nansen_discovered_${candidate.address.slice(0, 6)}`,
          WalletSource.NANSEN_DISCOVERY,
          candidate.realizedPnl,
          candidate.roiPercent,
          candidate.holdingRatio,
          candidate.tradeCount,
          candidate.realizedPnl,
          candidate.unrealizedPnl,
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

  /** Get all active wallet addresses — seed wallets always first */
  async getActiveWallets(): Promise<string[]> {
    const rows = await getMany<{ address: string }>(
      `SELECT address FROM alpha_wallets WHERE active = TRUE
       ORDER BY
         CASE WHEN source = 'nansen_seed' THEN 0 ELSE 1 END ASC,
         tier ASC,
         nansen_roi_percent DESC`,
    );
    return rows.map((r) => r.address);
  }
}
