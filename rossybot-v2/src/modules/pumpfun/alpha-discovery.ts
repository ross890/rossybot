import { logger } from '../../utils/logger.js';
import { query, getOne } from '../../db/database.js';
import { WalletSource, WalletTier } from '../../types/index.js';
import type { PumpPortalTrade } from './pumpportal-client.js';

/**
 * Tracks a wallet's pump.fun bonding curve performance in-memory.
 * Once a wallet proves profitable, it gets promoted to alpha_wallets.
 */
interface WalletTracker {
  address: string;
  /** Token mint → buy entry { mcapSol, vSol, timestamp } */
  openBuys: Map<string, { mcapSol: number; vSol: number; timestamp: number }>;
  totalBuys: number;
  totalSells: number;
  wins: number;
  losses: number;
  totalPnlPct: number;
  firstSeen: number;
  lastSeen: number;
  /** Already promoted to alpha_wallets */
  promoted: boolean;
}

/**
 * Pump.fun Alpha Discovery — discovers profitable bonding curve traders
 * by watching the PumpPortal real-time trade stream.
 *
 * Strategy:
 * 1. Watch ALL pump.fun trades via PumpPortal
 * 2. Track each wallet's buy entries (mcap at buy time)
 * 3. When a wallet sells, calculate PnL from mcap change
 * 4. Wallets with enough trades + good win rate → promote to alpha_wallets
 *
 * This runs continuously alongside existing Nansen discovery.
 */
export class PumpFunAlphaDiscovery {
  private wallets = new Map<string, WalletTracker>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private onNewAlpha: ((address: string) => void) | null = null;

  // --- Promotion thresholds ---
  /** Minimum completed round-trips to evaluate */
  private static readonly MIN_TRADES = 3;
  /** Minimum win rate to promote */
  private static readonly MIN_WIN_RATE = 0.55;
  /** Minimum average PnL % per trade */
  private static readonly MIN_AVG_PNL = 0.10; // 10%
  /** Max wallets to track in memory (evict oldest) */
  private static readonly MAX_TRACKED = 10_000;
  /** Evict wallets not seen in this many ms */
  private static readonly EVICT_AFTER_MS = 4 * 60 * 60 * 1000; // 4 hours

  setNewAlphaCallback(cb: (address: string) => void): void {
    this.onNewAlpha = cb;
  }

  start(): void {
    // Periodic cleanup of stale wallets
    this.cleanupInterval = setInterval(() => this.evictStale(), 10 * 60 * 1000); // every 10 min
    logger.info('Pump.fun alpha discovery started');
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Process a trade from PumpPortal stream.
   * Called for every buy/sell on pump.fun bonding curves.
   */
  async processTrade(trade: PumpPortalTrade): Promise<void> {
    if (trade.txType === 'create') return; // Skip token creation events

    const wallet = trade.traderPublicKey;
    const mint = trade.mint;

    let tracker = this.wallets.get(wallet);
    if (!tracker) {
      // Don't track if already at capacity
      if (this.wallets.size >= PumpFunAlphaDiscovery.MAX_TRACKED) return;

      tracker = {
        address: wallet,
        openBuys: new Map(),
        totalBuys: 0,
        totalSells: 0,
        wins: 0,
        losses: 0,
        totalPnlPct: 0,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        promoted: false,
      };
      this.wallets.set(wallet, tracker);
    }

    tracker.lastSeen = Date.now();

    if (trade.txType === 'buy') {
      tracker.totalBuys++;
      // Record entry point for this token
      if (!tracker.openBuys.has(mint)) {
        tracker.openBuys.set(mint, {
          mcapSol: trade.marketCapSol,
          vSol: trade.vSolInBondingCurve,
          timestamp: Date.now(),
        });
      }
    } else if (trade.txType === 'sell') {
      tracker.totalSells++;
      const entry = tracker.openBuys.get(mint);
      if (entry) {
        // Calculate PnL from market cap change
        const pnlPct = entry.mcapSol > 0
          ? (trade.marketCapSol - entry.mcapSol) / entry.mcapSol
          : 0;

        if (pnlPct > 0) {
          tracker.wins++;
        } else {
          tracker.losses++;
        }
        tracker.totalPnlPct += pnlPct;
        tracker.openBuys.delete(mint);

        // Check if wallet qualifies for promotion
        await this.checkPromotion(tracker);
      }
    }
  }

  private async checkPromotion(tracker: WalletTracker): Promise<void> {
    if (tracker.promoted) return;

    const completedTrades = tracker.wins + tracker.losses;
    if (completedTrades < PumpFunAlphaDiscovery.MIN_TRADES) return;

    const winRate = tracker.wins / completedTrades;
    const avgPnl = tracker.totalPnlPct / completedTrades;

    if (winRate < PumpFunAlphaDiscovery.MIN_WIN_RATE) return;
    if (avgPnl < PumpFunAlphaDiscovery.MIN_AVG_PNL) return;

    // Check if already in alpha_wallets
    const existing = await getOne<{ address: string }>(
      `SELECT address FROM alpha_wallets WHERE address = $1`,
      [tracker.address],
    );

    if (existing) {
      tracker.promoted = true;
      return; // Already in DB (from Nansen or previous discovery)
    }

    // Promote to alpha_wallets!
    tracker.promoted = true;
    const label = `pf_alpha_${tracker.address.slice(0, 6)}`;

    try {
      await query(
        `INSERT INTO alpha_wallets (address, label, source, tier, active, helius_subscribed, pumpfun_only,
           our_total_trades, our_win_rate, our_avg_pnl_percent)
         VALUES ($1, $2, $3, $4, TRUE, FALSE, TRUE, $5, $6, $7)
         ON CONFLICT (address) DO NOTHING`,
        [
          tracker.address,
          label,
          WalletSource.PUMPFUN_DISCOVERY,
          WalletTier.B,
          completedTrades,
          winRate,
          avgPnl,
        ],
      );

      logger.info({
        address: tracker.address.slice(0, 8),
        trades: completedTrades,
        winRate: `${(winRate * 100).toFixed(0)}%`,
        avgPnl: `${(avgPnl * 100).toFixed(1)}%`,
      }, 'NEW pump.fun alpha wallet discovered via PumpPortal');

      this.onNewAlpha?.(tracker.address);
    } catch (err) {
      logger.error({ err, address: tracker.address.slice(0, 8) }, 'Failed to insert pump.fun alpha wallet');
    }
  }

  private evictStale(): void {
    const now = Date.now();
    let evicted = 0;

    for (const [addr, tracker] of this.wallets) {
      if (tracker.promoted) continue; // Keep promoted wallets
      if (now - tracker.lastSeen > PumpFunAlphaDiscovery.EVICT_AFTER_MS) {
        this.wallets.delete(addr);
        evicted++;
      }
    }

    if (evicted > 0) {
      logger.debug({ evicted, remaining: this.wallets.size }, 'Pump.fun alpha discovery: evicted stale wallets');
    }
  }

  getStats(): { tracked: number; promoted: number } {
    let promoted = 0;
    for (const t of this.wallets.values()) {
      if (t.promoted) promoted++;
    }
    return { tracked: this.wallets.size, promoted };
  }
}
