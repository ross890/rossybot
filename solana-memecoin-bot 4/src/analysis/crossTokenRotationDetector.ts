// ===========================================
// MODULE: CROSS-TOKEN ROTATION DETECTOR
// Detects money rotating between major memecoins via DexScreener
// Phase 3.3 — predictive signal from dump/rotation patterns
// ===========================================

import { logger } from '../utils/logger.js';
import { dexScreenerClient } from '../modules/onchain.js';

// ============ TYPES ============

export interface TokenSnapshot {
  address: string;
  symbol: string;
  name: string;
  price: number;
  volume5m: number;
  volume1h: number;
  marketCap: number;
  priceChange5m: number;
  priceChange1h: number;
  timestamp: number;
}

export interface RotationEvent {
  exitingToken: {
    address: string;
    symbol: string;
    volumeSpike: number; // multiplier vs average
    priceDropPercent: number;
  };
  inflowTokens: {
    address: string;
    symbol: string;
    volumeSpike: number;
    priceChangePercent: number;
  }[];
  detectedAt: Date;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface RotationDiscovery {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  rotationInflowDetected: boolean;
  exitingFromToken: string;
  exitingFromSymbol: string;
  scoreBonus: number;
  detectedAt: Date;
}

// ============ CONFIGURATION ============

const CONFIG = {
  // Watchlist
  WATCHLIST_SIZE: 20,
  WATCHLIST_REFRESH_MS: 60 * 60 * 1000, // 1 hour

  // Polling
  POLL_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes

  // Rolling window
  SNAPSHOT_WINDOW_MS: 60 * 60 * 1000, // 1 hour

  // Rotation triggers
  VOLUME_SPIKE_THRESHOLD: 3.0, // 3x average volume
  PRICE_DROP_THRESHOLD: -5,     // -5% in 15 minutes
  PRICE_DROP_WINDOW_MS: 15 * 60 * 1000, // 15 minutes

  // Score bonus for rotation inflow detection
  ROTATION_SCORE_BONUS: 10,
} as const;

// ============ CROSS-TOKEN ROTATION DETECTOR CLASS ============

export class CrossTokenRotationDetector {
  // Watchlist: top 20 active Solana memecoins by volume
  private watchlist: Map<string, string> = new Map(); // address → symbol
  private watchlistLastRefresh = 0;

  // Rolling snapshots per token (1-hour window)
  private snapshots: Map<string, TokenSnapshot[]> = new Map();

  // Recent rotation events
  private recentEvents: RotationEvent[] = [];
  private readonly MAX_EVENTS = 50;

  // Polling state
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  // Callback for discovered rotation signals
  private discoveryCallback: ((discovery: RotationDiscovery) => Promise<void>) | null = null;
  private notifyCallback: ((message: string) => Promise<void>) | null = null;

  // ============ LIFECYCLE ============

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Refresh watchlist immediately
    this.refreshWatchlist();

    // Start polling
    this.pollTimer = setInterval(() => this.poll(), CONFIG.POLL_INTERVAL_MS);

    logger.info('Cross-token rotation detector started');
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Cross-token rotation detector stopped');
  }

  onDiscovery(callback: (discovery: RotationDiscovery) => Promise<void>): void {
    this.discoveryCallback = callback;
  }

  onNotify(callback: (message: string) => Promise<void>): void {
    this.notifyCallback = callback;
  }

  // ============ WATCHLIST ============

  /**
   * Refresh the watchlist: top 20 Solana memecoins by volume.
   * Uses DexScreener search — piggybacks on existing API calls.
   */
  private async refreshWatchlist(): Promise<void> {
    if (Date.now() - this.watchlistLastRefresh < CONFIG.WATCHLIST_REFRESH_MS) return;

    try {
      // Use DexScreener to get top Solana pairs by volume
      const response = await fetch(
        'https://api.dexscreener.com/latest/dex/tokens/solana?sort=volume&order=desc',
        { signal: AbortSignal.timeout(10000) }
      );

      if (!response.ok) {
        // Fallback: search for popular Solana tokens
        const searchResponse = await fetch(
          'https://api.dexscreener.com/latest/dex/search?q=solana',
          { signal: AbortSignal.timeout(10000) }
        );

        if (searchResponse.ok) {
          const data = await searchResponse.json() as any;
          this.parseWatchlistFromPairs(data.pairs || []);
        }
        return;
      }

      const data = await response.json() as any;
      this.parseWatchlistFromPairs(data.pairs || []);
    } catch (error) {
      logger.debug({ error }, 'Failed to refresh rotation watchlist');

      // If watchlist is empty, try DexScreener trending
      if (this.watchlist.size === 0) {
        try {
          const trendingResponse = await fetch(
            'https://api.dexscreener.com/token-boosts/top/v1',
            { signal: AbortSignal.timeout(10000) }
          );
          if (trendingResponse.ok) {
            const data = await trendingResponse.json() as any;
            if (Array.isArray(data)) {
              for (const item of data.slice(0, CONFIG.WATCHLIST_SIZE)) {
                if (item.chainId === 'solana' && item.tokenAddress) {
                  this.watchlist.set(item.tokenAddress, item.symbol || item.tokenAddress.slice(0, 6));
                }
              }
            }
          }
        } catch {
          // Silent fail — watchlist will be populated next cycle
        }
      }
    }

    this.watchlistLastRefresh = Date.now();
    logger.debug({ watchlistSize: this.watchlist.size }, 'Rotation watchlist refreshed');
  }

  private parseWatchlistFromPairs(pairs: any[]): void {
    this.watchlist.clear();

    // Filter for Solana pairs, sort by volume, take top 20
    const solanaPairs = pairs
      .filter((p: any) => p.chainId === 'solana')
      .sort((a: any, b: any) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
      .slice(0, CONFIG.WATCHLIST_SIZE);

    for (const pair of solanaPairs) {
      const address = pair.baseToken?.address;
      const symbol = pair.baseToken?.symbol;
      if (address && symbol) {
        this.watchlist.set(address, symbol);
      }
    }
  }

  // ============ POLLING ============

  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    // Refresh watchlist if stale
    await this.refreshWatchlist();

    if (this.watchlist.size === 0) return;

    try {
      // Fetch current data for watchlist tokens via DexScreener
      // Batch fetch in groups of 30 (DexScreener limit)
      const addresses = Array.from(this.watchlist.keys());

      for (let i = 0; i < addresses.length; i += 30) {
        const batch = addresses.slice(i, i + 30);
        const joinedAddresses = batch.join(',');

        try {
          const response = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${joinedAddresses}`,
            { signal: AbortSignal.timeout(15000) }
          );

          if (!response.ok) continue;
          const data = await response.json() as any;
          const pairs = data.pairs || [];

          // Take the best pair per token
          const bestPairByToken = new Map<string, any>();
          for (const pair of pairs) {
            const addr = pair.baseToken?.address;
            if (!addr) continue;
            const existing = bestPairByToken.get(addr);
            if (!existing || (pair.volume?.h24 || 0) > (existing.volume?.h24 || 0)) {
              bestPairByToken.set(addr, pair);
            }
          }

          // Create snapshots
          const now = Date.now();
          for (const [addr, pair] of bestPairByToken) {
            const snapshot: TokenSnapshot = {
              address: addr,
              symbol: pair.baseToken?.symbol || 'UNKNOWN',
              name: pair.baseToken?.name || 'Unknown',
              price: parseFloat(pair.priceUsd || '0'),
              volume5m: pair.volume?.m5 || (pair.volume?.h24 || 0) / 288,
              volume1h: pair.volume?.h1 || (pair.volume?.h24 || 0) / 24,
              marketCap: pair.fdv || 0,
              priceChange5m: pair.priceChange?.m5 || 0,
              priceChange1h: pair.priceChange?.h1 || 0,
              timestamp: now,
            };

            // Store snapshot
            if (!this.snapshots.has(addr)) {
              this.snapshots.set(addr, []);
            }
            const tokenSnapshots = this.snapshots.get(addr)!;
            tokenSnapshots.push(snapshot);

            // Clean old snapshots (keep 1-hour window)
            const cutoff = now - CONFIG.SNAPSHOT_WINDOW_MS;
            this.snapshots.set(addr, tokenSnapshots.filter(s => s.timestamp > cutoff));
          }
        } catch (error) {
          logger.debug({ error }, 'Failed to fetch rotation watchlist batch');
        }

        // Brief pause between batches
        if (i + 30 < addresses.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Detect rotation events
      await this.detectRotationEvents();
    } catch (error) {
      logger.debug({ error }, 'Rotation detector poll error');
    }
  }

  // ============ ROTATION DETECTION ============

  private async detectRotationEvents(): Promise<void> {
    const now = Date.now();

    for (const [address, snapshots] of this.snapshots) {
      if (snapshots.length < 2) continue;

      const latest = snapshots[snapshots.length - 1];

      // Calculate average volume from earlier snapshots
      const olderSnapshots = snapshots.filter(
        s => s.timestamp < now - CONFIG.PRICE_DROP_WINDOW_MS
      );
      if (olderSnapshots.length === 0) continue;

      const avgVolume = olderSnapshots.reduce((sum, s) => sum + s.volume5m, 0) / olderSnapshots.length;
      if (avgVolume <= 0) continue;

      const volumeSpike = latest.volume5m / avgVolume;

      // Check 15-min price drop
      const fifteenMinAgo = snapshots.filter(
        s => s.timestamp >= now - CONFIG.PRICE_DROP_WINDOW_MS && s.timestamp < now - 60000
      );
      let priceDropPercent = 0;
      if (fifteenMinAgo.length > 0) {
        const referencePrice = fifteenMinAgo[0].price;
        if (referencePrice > 0) {
          priceDropPercent = ((latest.price - referencePrice) / referencePrice) * 100;
        }
      }

      // Rotation trigger: volume spike > 3x AND price drop > -5%
      if (volumeSpike >= CONFIG.VOLUME_SPIKE_THRESHOLD && priceDropPercent <= CONFIG.PRICE_DROP_THRESHOLD) {
        // Money is leaving this token — look for where it's going
        const inflowTokens: RotationEvent['inflowTokens'] = [];

        for (const [otherAddr, otherSnapshots] of this.snapshots) {
          if (otherAddr === address) continue;
          if (otherSnapshots.length < 2) continue;

          const otherLatest = otherSnapshots[otherSnapshots.length - 1];
          const otherOlder = otherSnapshots.filter(
            s => s.timestamp < now - CONFIG.PRICE_DROP_WINDOW_MS
          );
          if (otherOlder.length === 0) continue;

          const otherAvgVol = otherOlder.reduce((sum, s) => sum + s.volume5m, 0) / otherOlder.length;
          if (otherAvgVol <= 0) continue;

          const otherSpike = otherLatest.volume5m / otherAvgVol;

          // Token is receiving inflow if volume spiking AND price going up
          if (otherSpike >= 2.0 && otherLatest.priceChange5m > 0) {
            inflowTokens.push({
              address: otherAddr,
              symbol: otherLatest.symbol,
              volumeSpike: otherSpike,
              priceChangePercent: otherLatest.priceChange5m,
            });
          }
        }

        if (inflowTokens.length > 0) {
          const confidence = inflowTokens.length >= 3 ? 'HIGH' as const :
                            inflowTokens.length >= 2 ? 'MEDIUM' as const : 'LOW' as const;

          const event: RotationEvent = {
            exitingToken: {
              address,
              symbol: latest.symbol,
              volumeSpike,
              priceDropPercent,
            },
            inflowTokens,
            detectedAt: new Date(),
            confidence,
          };

          this.recentEvents.push(event);
          if (this.recentEvents.length > this.MAX_EVENTS) {
            this.recentEvents.shift();
          }

          // Notify
          const message = [
            `🔄 *ROTATION DETECTED*`,
            '',
            `Money leaving: *$${latest.symbol}*`,
            `  Volume spike: ${volumeSpike.toFixed(1)}x | Price: ${priceDropPercent.toFixed(1)}%`,
            '',
            `Flowing to:`,
            ...inflowTokens.slice(0, 5).map(t =>
              `  → *$${t.symbol}* (${t.volumeSpike.toFixed(1)}x vol, +${t.priceChangePercent.toFixed(1)}%)`
            ),
          ].join('\n');

          await this.notifyCallback?.(message);

          // Submit inflow tokens as rotation discoveries
          for (const inflow of inflowTokens) {
            const discovery: RotationDiscovery = {
              tokenAddress: inflow.address,
              tokenSymbol: inflow.symbol,
              tokenName: inflow.symbol,
              rotationInflowDetected: true,
              exitingFromToken: address,
              exitingFromSymbol: latest.symbol,
              scoreBonus: CONFIG.ROTATION_SCORE_BONUS,
              detectedAt: new Date(),
            };

            await this.discoveryCallback?.(discovery);
          }

          logger.info({
            exitingToken: latest.symbol,
            inflowCount: inflowTokens.length,
            confidence,
          }, 'Rotation event detected');
        }
      }
    }
  }

  // ============ PUBLIC API ============

  /**
   * Check if a token is currently receiving rotation inflow.
   * Used by scoring pipeline to add rotation bonus.
   */
  isReceivingRotationInflow(tokenAddress: string): {
    detected: boolean;
    exitingFrom: string | null;
    bonus: number;
  } {
    // Check recent events (last 30 minutes)
    const cutoff = Date.now() - 30 * 60 * 1000;

    for (const event of this.recentEvents) {
      if (event.detectedAt.getTime() < cutoff) continue;

      const inflow = event.inflowTokens.find(t => t.address === tokenAddress);
      if (inflow) {
        return {
          detected: true,
          exitingFrom: event.exitingToken.symbol,
          bonus: CONFIG.ROTATION_SCORE_BONUS,
        };
      }
    }

    return { detected: false, exitingFrom: null, bonus: 0 };
  }

  /**
   * Get recent rotation events.
   */
  getRecentEvents(): RotationEvent[] {
    return [...this.recentEvents];
  }

  /**
   * Get watchlist.
   */
  getWatchlist(): Map<string, string> {
    return new Map(this.watchlist);
  }
}

// ============ EXPORTS ============

export const crossTokenRotationDetector = new CrossTokenRotationDetector();

export default {
  CrossTokenRotationDetector,
  crossTokenRotationDetector,
};
