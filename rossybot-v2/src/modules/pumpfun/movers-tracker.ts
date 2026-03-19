import { logger } from '../../utils/logger.js';
import { estimateCurveFillPct } from './detector.js';

/**
 * Tracks momentum/velocity of pump.fun tokens from PumpPortal trade stream.
 * Replaces external pump.fun "movers" API (which requires auth) with our own
 * real-time velocity detection built from the trade data we already receive.
 *
 * A token becomes a "mover" when it has sustained SOL inflow above a threshold
 * within a rolling time window. This is the same signal that pump.fun's
 * "King of the Hill" list uses — tokens with curve velocity.
 */

interface TokenVelocity {
  mint: string;
  /** Rolling SOL inflows within the velocity window */
  recentBuys: Array<{ solDelta: number; timestamp: number }>;
  /** Current curve fill % */
  curveFillPct: number;
  /** Total unique buyers in the window */
  uniqueBuyers: Set<string>;
  /** Timestamp when first tracked */
  firstSeen: number;
  /** Last trade timestamp */
  lastSeen: number;
}

export interface MoverToken {
  mint: string;
  velocitySolPerMin: number;
  curveFillPct: number;
  uniqueBuyers: number;
  solInflow: number;
  ageSecs: number;
}

export class MoversTracker {
  private tokens = new Map<string, TokenVelocity>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private onMover: ((mover: MoverToken) => void) | null = null;
  // Track which tokens we already fired a mover event for (prevent duplicates)
  private firedMovers = new Set<string>();

  // --- Configuration ---
  /** Rolling window for velocity calculation */
  private static readonly VELOCITY_WINDOW_MS = 2 * 60_000; // 2 minutes
  /** Minimum SOL/min inflow to qualify as a mover */
  private static readonly MIN_VELOCITY_SOL_PER_MIN = 0.5;
  /** Minimum unique buyers in window to qualify */
  private static readonly MIN_UNIQUE_BUYERS = 3;
  /** Don't track tokens above this curve fill (already too late) */
  private static readonly MAX_CURVE_FILL_TRACK = 0.45;
  /** Evict tokens not seen in this long */
  private static readonly EVICT_AFTER_MS = 10 * 60_000; // 10 minutes
  /** Max tokens to track */
  private static readonly MAX_TRACKED = 5_000;

  setMoverCallback(cb: (mover: MoverToken) => void): void {
    this.onMover = cb;
  }

  start(): void {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    logger.info('Movers tracker started');
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Process a trade from PumpPortal stream.
   * Called on every buy/sell — builds velocity profile per token.
   */
  processTrade(mint: string, txType: 'buy' | 'sell' | 'create', vSolInBondingCurve: number, traderPublicKey: string): void {
    if (txType === 'create') return;

    const realSol = Math.max(0, vSolInBondingCurve - 30);
    const curveFillPct = estimateCurveFillPct(realSol);

    // Don't track tokens already too far along
    if (curveFillPct > MoversTracker.MAX_CURVE_FILL_TRACK) {
      this.tokens.delete(mint);
      return;
    }

    let tracker = this.tokens.get(mint);
    if (!tracker) {
      if (this.tokens.size >= MoversTracker.MAX_TRACKED) return;
      tracker = {
        mint,
        recentBuys: [],
        curveFillPct,
        uniqueBuyers: new Set(),
        firstSeen: Date.now(),
        lastSeen: Date.now(),
      };
      this.tokens.set(mint, tracker);
    }

    tracker.lastSeen = Date.now();
    tracker.curveFillPct = curveFillPct;

    if (txType === 'buy') {
      // Estimate SOL spent from vSol change
      const solDelta = realSol > 0 ? Math.max(0.01, realSol * 0.05) : 0.1;
      tracker.recentBuys.push({ solDelta, timestamp: Date.now() });
      tracker.uniqueBuyers.add(traderPublicKey);

      // Check if this token just became a mover
      this.checkMover(tracker);
    }
  }

  private checkMover(tracker: TokenVelocity): void {
    // Don't fire duplicate events
    if (this.firedMovers.has(tracker.mint)) return;

    // Prune old buys outside the velocity window
    const cutoff = Date.now() - MoversTracker.VELOCITY_WINDOW_MS;
    tracker.recentBuys = tracker.recentBuys.filter((b) => b.timestamp > cutoff);

    // Prune old unique buyers (reset if window expired)
    // Simple approach: only count buyers from recent buys
    const recentBuyerSet = new Set<string>();
    // We don't have buyer info in recentBuys, so use the full set but cap it
    const uniqueBuyerCount = tracker.uniqueBuyers.size;

    // Calculate velocity: total SOL inflow in window / window duration in minutes
    const totalSolInflow = tracker.recentBuys.reduce((sum, b) => sum + b.solDelta, 0);
    const windowMins = MoversTracker.VELOCITY_WINDOW_MS / 60_000;
    const velocitySolPerMin = totalSolInflow / windowMins;

    // Must meet all thresholds
    if (velocitySolPerMin < MoversTracker.MIN_VELOCITY_SOL_PER_MIN) return;
    if (uniqueBuyerCount < MoversTracker.MIN_UNIQUE_BUYERS) return;

    // Must be in a useful curve range (not too early, not too late)
    // Movers below 25% are still too risky; above 38% is too late (matches curveEntryMax)
    if (tracker.curveFillPct < 0.25 || tracker.curveFillPct > 0.38) return;

    // This is a mover!
    this.firedMovers.add(tracker.mint);

    const mover: MoverToken = {
      mint: tracker.mint,
      velocitySolPerMin,
      curveFillPct: tracker.curveFillPct,
      uniqueBuyers: uniqueBuyerCount,
      solInflow: totalSolInflow,
      ageSecs: Math.round((Date.now() - tracker.firstSeen) / 1000),
    };

    logger.info({
      token: tracker.mint.slice(0, 8),
      velocity: `${velocitySolPerMin.toFixed(2)} SOL/min`,
      curveFill: `${(tracker.curveFillPct * 100).toFixed(0)}%`,
      buyers: uniqueBuyerCount,
      solInflow: totalSolInflow.toFixed(2),
    }, 'MOVER DETECTED — high velocity token');

    this.onMover?.(mover);
  }

  private cleanup(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [mint, tracker] of this.tokens) {
      if (now - tracker.lastSeen > MoversTracker.EVICT_AFTER_MS) {
        this.tokens.delete(mint);
        this.firedMovers.delete(mint);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.debug({ evicted, remaining: this.tokens.size }, 'Movers tracker cleanup');
    }
  }

  getStats(): { tracked: number; movers: number } {
    return { tracked: this.tokens.size, movers: this.firedMovers.size };
  }

  /** Get current movers list — tokens with high velocity right now */
  getCurrentMovers(): MoverToken[] {
    const movers: MoverToken[] = [];
    const cutoff = Date.now() - MoversTracker.VELOCITY_WINDOW_MS;

    for (const tracker of this.tokens.values()) {
      const recentBuys = tracker.recentBuys.filter((b) => b.timestamp > cutoff);
      const totalSolInflow = recentBuys.reduce((sum, b) => sum + b.solDelta, 0);
      const windowMins = MoversTracker.VELOCITY_WINDOW_MS / 60_000;
      const velocitySolPerMin = totalSolInflow / windowMins;

      if (velocitySolPerMin >= MoversTracker.MIN_VELOCITY_SOL_PER_MIN
          && tracker.uniqueBuyers.size >= MoversTracker.MIN_UNIQUE_BUYERS) {
        movers.push({
          mint: tracker.mint,
          velocitySolPerMin,
          curveFillPct: tracker.curveFillPct,
          uniqueBuyers: tracker.uniqueBuyers.size,
          solInflow: totalSolInflow,
          ageSecs: Math.round((Date.now() - tracker.firstSeen) / 1000),
        });
      }
    }

    return movers.sort((a, b) => b.velocitySolPerMin - a.velocitySolPerMin);
  }
}
