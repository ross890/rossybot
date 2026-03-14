import { logger } from '../../utils/logger.js';
import { query, getMany } from '../../db/database.js';
import { config, SEED_WALLETS, getTierConfig, getTierForCapital } from '../../config/index.js';
import { CapitalTier, WalletSource, WalletTier } from '../../types/index.js';
import { NansenClient, type SmartMoneyDexTrade } from './client.js';

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

  /** Remove all previously discovered wallets (clean slate for new discovery method) */
  async purgeWeakWallets(): Promise<number> {
    const result = await query(
      `DELETE FROM alpha_wallets
       WHERE source != 'NANSEN_SEED'
       RETURNING address`,
    );
    const count = result.rowCount || 0;
    if (count > 0) {
      console.log(`🗑️ Purged ${count} old discovered wallets — will repopulate from smart money dex-trades`);
    }
    return count;
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

  /** Run a full discovery cycle using Nansen Smart Money DEX Trades */
  async runDiscovery(): Promise<void> {
    const start = Date.now();
    console.log('🔍 Starting wallet discovery cycle...');

    try {
      // Step 1: Pull smart money DEX trades on Solana (3 pages for coverage)
      console.log('Step 1: Fetching smart money DEX trades (Solana, last 24h)...');
      const allTrades: SmartMoneyDexTrade[] = [];

      for (let page = 1; page <= 3; page++) {
        try {
          const trades = await this.nansen.smartMoneyDexTrades({
            tradeValueMin: 500,
            labels: ['Smart Trader', '30D Smart Trader', '90D Smart Trader', '180D Smart Trader'],
            limit: 100,
            page,
          });
          allTrades.push(...trades);
          if (trades.length < 100) break; // No more pages
        } catch (err: unknown) {
          const axErr = err as { response?: { status?: number; data?: unknown }; message?: string };
          console.error(`Failed to fetch dex-trades page ${page}: ${axErr.response?.status || axErr.message || err}`);
          break;
        }
      }

      if (allTrades.length === 0) {
        console.log('No smart money trades found');
        await this.logDiscovery(0, 0, 0, 0, Date.now() - start);
        return;
      }
      console.log(`Found ${allTrades.length} smart money trades`);

      // Step 2: Aggregate by trader — count trades, volume, unique tokens
      const traderMap = new Map<string, {
        label: string;
        trades: number;
        totalVolume: number;
        tokens: Set<string>;
      }>();

      for (const t of allTrades) {
        const addr = t.trader_address;
        if (!addr) continue;

        const existing = traderMap.get(addr) || {
          label: t.trader_address_label || addr.slice(0, 8),
          trades: 0,
          totalVolume: 0,
          tokens: new Set<string>(),
        };

        existing.trades++;
        existing.totalVolume += t.trade_value_usd || 0;
        if (t.token_bought_symbol) existing.tokens.add(t.token_bought_symbol);
        traderMap.set(addr, existing);
      }

      console.log(`Step 2: ${traderMap.size} unique traders identified`);

      // Step 3: Filter — 5+ trades AND 5+ unique tokens traded
      const allCandidates: WalletCandidate[] = [];

      for (const [addr, data] of traderMap) {
        if (data.trades < 5) continue;
        if (data.tokens.size < 5) continue;

        // Score: trade activity + volume + diversity
        const tradeScore = Math.min(data.trades / 20, 1) * 0.35;
        const volumeScore = Math.min(Math.log10(Math.max(data.totalVolume, 1)) / 6, 1) * 0.35;
        const diversityScore = Math.min(data.tokens.size / 10, 1) * 0.30;
        const score = tradeScore + volumeScore + diversityScore;

        console.log(`  ✓ ${data.label} (${addr.slice(0, 8)}) | ${data.trades} trades | $${(data.totalVolume/1000).toFixed(1)}k vol | ${data.tokens.size} tokens | Score: ${score.toFixed(2)}`);

        allCandidates.push({
          address: addr,
          label: data.label,
          tradeCount: data.trades,
          totalVolumeUsd: data.totalVolume,
          tokensTraded: data.tokens.size,
          score,
        });
      }

      // Step 4: Rank and add top candidates
      allCandidates.sort((a, b) => b.score - a.score);
      const topCandidates = allCandidates.slice(0, 10);

      let walletsAdded = 0;
      for (const c of topCandidates) {
        const isNew = await this.addWallet(c);
        if (isNew) walletsAdded++;
      }

      // Step 5: Validate/demote existing wallets
      const walletsRemoved = await this.validateExistingWallets();

      const duration = Date.now() - start;
      await this.logDiscovery(allTrades.length, allCandidates.length, walletsAdded, walletsRemoved, duration);

      console.log(`✅ Discovery complete: ${allTrades.length} trades analyzed, ${allCandidates.length} qualified traders, ${walletsAdded} wallets added, ${walletsRemoved} removed (${duration}ms)`);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
      if (axiosErr.response) {
        console.error(`❌ Wallet discovery failed: ${axiosErr.response.status} — ${JSON.stringify(axiosErr.response.data)}`);
      } else {
        console.error(`❌ Wallet discovery failed: ${axiosErr.message || err}`);
      }
    }
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
