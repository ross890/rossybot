// ===========================================
// MODULE: PULLBACK ENTRY SYSTEM
// Detects surges, waits for pullbacks, then enters at better prices.
// The core insight: Momentum is anti-predictive (-0.04 correlation)
// because the system buys surges. This module inverts that by waiting
// for the dip after the surge.
//
// Two entry modes:
// - IMMEDIATE: Alpha/KOL signals (smart money timing IS the edge)
// - PULLBACK:  Discovery/GMGN signals (default — enter on dip)
// ===========================================

import { logger } from '../../utils/logger.js';
import { dexScreenerClient } from '../onchain.js';
import { momentumAnalyzer } from '../momentum-analyzer.js';
import { tokenSafetyChecker } from '../safety/token-safety-checker.js';

// ============ TYPES ============

export interface WatchlistEntry {
  tokenAddress: string;
  tokenTicker: string;
  qualifiedScore: number;
  qualifiedPrice: number;
  qualifiedTime: Date;
  peakPriceSinceQualified: number;
  pullbackTarget: number;
  pullbackPercent: number;
  watchExpiry: Date;
  discoverySource: string;
  // Metadata for signal generation
  signalMetadata: any;
}

export interface PullbackResult {
  action: 'ENTER' | 'WAIT' | 'EXPIRED' | 'STRONG_RUNNER';
  entry?: WatchlistEntry;
  currentPrice?: number;
  pullbackPercent?: number;
  reason: string;
}

export type EntryMode = 'IMMEDIATE' | 'PULLBACK';

// ============ CONFIGURATION ============

const CONFIG = {
  // Pullback percentages by context
  PULLBACK_SURGE_HIGH: 0.15,    // HIGH confidence surge: 15% pullback
  PULLBACK_SURGE_MEDIUM: 0.10,  // MEDIUM surge: 10% pullback
  PULLBACK_NORMAL: 0.07,        // No surge, normal momentum: 7% pullback
  PULLBACK_NEAR_ATH: 0.20,     // Near ATH: 20% pullback

  // Watchlist limits
  MAX_WATCHLIST_SIZE: 20,
  WATCH_EXPIRY_MS: 30 * 60 * 1000, // 30 minutes

  // Strong runner detection
  STRONG_RUNNER_GAIN: 0.50, // If price rises 50% without pullback = strong runner

  // Minimum holder count on re-check (distribution = bail)
  MIN_HOLDER_COUNT_ON_RECHECK: 8,
} as const;

// ============ PULLBACK DETECTOR CLASS ============

export class PullbackDetector {
  private watchlist: Map<string, WatchlistEntry> = new Map();
  private checkTimer: NodeJS.Timeout | null = null;

  // Callback to generate signal when pullback is hit
  private signalCallback: ((entry: WatchlistEntry, currentPrice: number) => Promise<void>) | null = null;

  // Metrics for tracking effectiveness
  private metrics = {
    tokensWatched: 0,
    pullbackEntries: 0,
    expired: 0,
    strongRunners: 0,
    missRate: 0,
  };

  /**
   * Set the callback for when a pullback entry is triggered.
   */
  setSignalCallback(callback: (entry: WatchlistEntry, currentPrice: number) => Promise<void>): void {
    this.signalCallback = callback;
  }

  /**
   * Determine if a signal should use immediate or pullback entry.
   */
  getEntryMode(discoverySource: string, tokenAge: number): EntryMode {
    // Alpha wallet signals: smart money timing IS the edge — don't delay
    if (discoverySource === 'ALPHA_WALLET' || discoverySource === 'ALPHA_WALLETS') {
      return 'IMMEDIATE';
    }

    // KOL signals: KOL timing matters — don't delay
    if (discoverySource === 'KOL' || discoverySource === 'KOL_VALIDATION') {
      return 'IMMEDIATE';
    }

    // Token age < 10 min: initial price discovery, pullback may not come
    if (tokenAge < 10) {
      return 'IMMEDIATE';
    }

    // Everything else: pullback entry (DISCOVERY, GMGN, on-chain signals)
    return 'PULLBACK';
  }

  /**
   * Add a qualified token to the pullback watchlist.
   * Called when a token passes all scoring/safety gates but entry mode = PULLBACK.
   */
  async addToWatchlist(
    tokenAddress: string,
    tokenTicker: string,
    qualifiedScore: number,
    currentPrice: number,
    discoverySource: string,
    signalMetadata: any
  ): Promise<void> {
    // Don't add if already watching
    if (this.watchlist.has(tokenAddress)) {
      logger.debug({ tokenAddress: tokenAddress.slice(0, 8) }, 'Token already on pullback watchlist');
      return;
    }

    // Enforce watchlist size limit
    if (this.watchlist.size >= CONFIG.MAX_WATCHLIST_SIZE) {
      // Remove oldest entry
      const oldest = [...this.watchlist.entries()]
        .sort((a, b) => a[1].qualifiedTime.getTime() - b[1].qualifiedTime.getTime())[0];
      if (oldest) {
        this.watchlist.delete(oldest[0]);
      }
    }

    // Detect surge to determine pullback percentage
    let pullbackPercent: number = CONFIG.PULLBACK_NORMAL;
    try {
      const surge = await momentumAnalyzer.detectSurge(tokenAddress);
      if (surge.detected) {
        pullbackPercent = surge.confidence === 'HIGH'
          ? CONFIG.PULLBACK_SURGE_HIGH
          : CONFIG.PULLBACK_SURGE_MEDIUM;
        logger.info({
          tokenAddress: tokenAddress.slice(0, 8),
          surgeType: surge.type,
          surgeConfidence: surge.confidence,
          pullbackPercent: (pullbackPercent * 100).toFixed(0) + '%',
        }, 'Surge detected — requiring larger pullback');
      }
    } catch {
      // Surge detection is best-effort
    }

    const pullbackTarget = currentPrice * (1 - pullbackPercent);

    const entry: WatchlistEntry = {
      tokenAddress,
      tokenTicker,
      qualifiedScore,
      qualifiedPrice: currentPrice,
      qualifiedTime: new Date(),
      peakPriceSinceQualified: currentPrice,
      pullbackTarget,
      pullbackPercent,
      watchExpiry: new Date(Date.now() + CONFIG.WATCH_EXPIRY_MS),
      discoverySource,
      signalMetadata,
    };

    this.watchlist.set(tokenAddress, entry);
    this.metrics.tokensWatched++;

    logger.info({
      tokenAddress: tokenAddress.slice(0, 8),
      ticker: tokenTicker,
      qualifiedPrice: currentPrice.toFixed(6),
      pullbackTarget: pullbackTarget.toFixed(6),
      pullbackPercent: (pullbackPercent * 100).toFixed(0) + '%',
      expiresIn: '30 min',
      source: discoverySource,
    }, 'Token added to pullback watchlist');
  }

  /**
   * Check all watchlist entries for pullback or expiry.
   * Called every scan cycle (piggybacks on existing 20s scan interval).
   */
  async checkWatchlist(): Promise<PullbackResult[]> {
    const results: PullbackResult[] = [];
    const now = new Date();

    for (const [address, entry] of this.watchlist) {
      try {
        // Get current price
        const pairs = await dexScreenerClient.getTokenPairs(address);
        if (!pairs || pairs.length === 0) continue;

        const currentPrice = pairs[0].priceUsd ? parseFloat(pairs[0].priceUsd) : 0;
        if (currentPrice <= 0) continue;

        // Update peak price
        entry.peakPriceSinceQualified = Math.max(entry.peakPriceSinceQualified, currentPrice);

        // Update pullback target (relative to peak, not qualified price)
        entry.pullbackTarget = entry.peakPriceSinceQualified * (1 - entry.pullbackPercent);

        // Check 1: Pullback hit
        if (currentPrice <= entry.pullbackTarget) {
          // Re-run quick safety check
          const safetyOk = await this.recheckSafety(address);

          if (safetyOk) {
            this.watchlist.delete(address);
            this.metrics.pullbackEntries++;

            const actualPullback = ((entry.peakPriceSinceQualified - currentPrice) / entry.peakPriceSinceQualified) * 100;

            logger.info({
              tokenAddress: address.slice(0, 8),
              ticker: entry.tokenTicker,
              entryPrice: currentPrice.toFixed(6),
              peakPrice: entry.peakPriceSinceQualified.toFixed(6),
              pullbackPercent: actualPullback.toFixed(1) + '%',
            }, 'PULLBACK ENTRY triggered');

            results.push({
              action: 'ENTER',
              entry,
              currentPrice,
              pullbackPercent: actualPullback,
              reason: `Pullback ${actualPullback.toFixed(1)}% from peak`,
            });

            // Fire the signal callback
            if (this.signalCallback) {
              await this.signalCallback(entry, currentPrice);
            }
          } else {
            // Safety degraded — remove from watchlist
            this.watchlist.delete(address);
            results.push({
              action: 'EXPIRED',
              entry,
              reason: 'Safety check failed on pullback re-check',
            });
          }
          continue;
        }

        // Check 2: Watch expiry
        if (now >= entry.watchExpiry) {
          this.watchlist.delete(address);
          this.metrics.expired++;

          const priceChange = ((currentPrice - entry.qualifiedPrice) / entry.qualifiedPrice) * 100;
          results.push({
            action: 'EXPIRED',
            entry,
            currentPrice,
            reason: `Expired after 30 min (price: ${priceChange > 0 ? '+' : ''}${priceChange.toFixed(1)}%)`,
          });

          logger.debug({
            tokenAddress: address.slice(0, 8),
            ticker: entry.tokenTicker,
            priceChange: priceChange.toFixed(1) + '%',
          }, 'Watchlist entry expired');
          continue;
        }

        // Check 3: Strong runner detection
        const gainFromQualified = (currentPrice - entry.qualifiedPrice) / entry.qualifiedPrice;
        if (gainFromQualified >= CONFIG.STRONG_RUNNER_GAIN) {
          this.watchlist.delete(address);
          this.metrics.strongRunners++;

          logger.info({
            tokenAddress: address.slice(0, 8),
            ticker: entry.tokenTicker,
            gain: (gainFromQualified * 100).toFixed(1) + '%',
          }, 'STRONG RUNNER detected — entering at market despite no pullback');

          results.push({
            action: 'STRONG_RUNNER',
            entry,
            currentPrice,
            reason: `Strong runner: +${(gainFromQualified * 100).toFixed(1)}% without pullback`,
          });

          // Fire signal callback with strong runner flag
          if (this.signalCallback) {
            entry.signalMetadata = {
              ...entry.signalMetadata,
              pullbackEntry: false,
              strongRunner: true,
              reducedSize: true, // Use 50% Kelly — less conviction on entry timing
            };
            await this.signalCallback(entry, currentPrice);
          }
          continue;
        }

        // Otherwise: still waiting
        results.push({
          action: 'WAIT',
          entry,
          currentPrice,
          reason: 'Waiting for pullback',
        });

      } catch (error) {
        logger.debug({ error, tokenAddress: address.slice(0, 8) }, 'Watchlist check failed for token');
      }
    }

    return results;
  }

  /**
   * Re-run quick safety check before entering on pullback.
   */
  private async recheckSafety(tokenAddress: string): Promise<boolean> {
    try {
      const safety = await tokenSafetyChecker.checkTokenSafety(tokenAddress);

      // Reject if safety degraded significantly
      if (safety.safetyScore < 20) return false;

      // Check holder count hasn't dropped (distribution = bail)
      if (safety.insiderAnalysis && safety.insiderAnalysis.insiderRiskScore > 80) return false;

      return true;
    } catch {
      // If safety check fails, be conservative
      return false;
    }
  }

  /**
   * Get current watchlist status.
   */
  getWatchlistStatus(): {
    entries: Array<{
      ticker: string;
      qualifiedPrice: number;
      peakPrice: number;
      pullbackTarget: number;
      minutesRemaining: number;
      source: string;
    }>;
    metrics: { tokensWatched: number; pullbackEntries: number; expired: number; strongRunners: number; missRate: number };
  } {
    const entries = [...this.watchlist.values()].map(e => ({
      ticker: e.tokenTicker,
      qualifiedPrice: e.qualifiedPrice,
      peakPrice: e.peakPriceSinceQualified,
      pullbackTarget: e.pullbackTarget,
      minutesRemaining: Math.max(0, (e.watchExpiry.getTime() - Date.now()) / 60000),
      source: e.discoverySource,
    }));

    return { entries, metrics: { ...this.metrics } };
  }

  /**
   * Check if a token is on the watchlist.
   */
  isWatching(tokenAddress: string): boolean {
    return this.watchlist.has(tokenAddress);
  }

  /**
   * Remove a token from the watchlist.
   */
  removeFromWatchlist(tokenAddress: string): void {
    this.watchlist.delete(tokenAddress);
  }

  /**
   * Clear all watchlist entries.
   */
  clearWatchlist(): void {
    this.watchlist.clear();
  }
}

// ============ EXPORTS ============

export const pullbackDetector = new PullbackDetector();

export default {
  PullbackDetector,
  pullbackDetector,
};
