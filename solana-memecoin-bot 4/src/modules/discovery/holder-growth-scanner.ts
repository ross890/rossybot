// ===========================================
// HOLDER GROWTH VELOCITY SCANNER
// Detects tokens with rapid holder growth (50+ holders/hour)
// Phase 1 Quick Win: Token Discovery Enhancement
// ===========================================

import { logger } from '../../utils/logger.js';
import { Database, pool } from '../../utils/database.js';
import { getTokenMetrics, dexScreenerClient, birdeyeClient } from '../onchain.js';
import { TokenMetrics } from '../../types/index.js';

// ============ CONFIGURATION ============

interface HolderGrowthConfig {
  // Minimum new holders per hour to be flagged
  minHoldersPerHour: number;

  // Token age range (in hours)
  minTokenAgeHours: number;
  maxTokenAgeHours: number;

  // Minimum existing holders (avoid brand new tokens)
  minExistingHolders: number;

  // Minimum liquidity for safety
  minLiquidity: number;

  // Scan interval in minutes
  scanIntervalMinutes: number;

  // Maximum tokens to return per scan
  maxTokensPerScan: number;

  // Historical tracking window (hours)
  trackingWindowHours: number;
}

const DEFAULT_CONFIG: HolderGrowthConfig = {
  minHoldersPerHour: 50,       // 50+ new holders per hour
  minTokenAgeHours: 2,         // At least 2 hours old
  maxTokenAgeHours: 2160,      // Up to 90 days old (90 * 24)
  minExistingHolders: 100,     // At least 100 existing holders
  minLiquidity: 15000,         // At least $15K liquidity
  scanIntervalMinutes: 5,      // Scan every 5 minutes
  maxTokensPerScan: 50,        // Return up to 50 tokens
  trackingWindowHours: 6,      // Track for 6 hours
};

// ============ TYPES ============

export interface HolderGrowthSignal {
  address: string;
  ticker: string;
  name: string;
  currentHolders: number;
  previousHolders: number;
  holdersGained: number;
  holdersPerHour: number;
  growthRate: number;  // Percentage growth
  marketCap: number;
  liquidity: number;
  volume24h: number;
  tokenAgeHours: number;
  detectedAt: Date;
  trackingStarted: Date;
}

interface HolderSnapshot {
  holders: number;
  timestamp: number;
}

// ============ SCANNER CLASS ============

class HolderGrowthScanner {
  private config: HolderGrowthConfig = DEFAULT_CONFIG;
  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;

  // Historical holder snapshots for velocity calculation
  private holderSnapshots: Map<string, HolderSnapshot[]> = new Map();

  // Recent growth signals (to avoid duplicates)
  private recentSignals: Map<string, number> = new Map();
  private readonly SIGNAL_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hour cooldown

  /**
   * Initialize the scanner
   */
  async initialize(): Promise<void> {
    logger.info('Initializing holder growth velocity scanner...');

    // Load any persistent snapshot data from database
    await this.loadSnapshots();

    logger.info({
      config: this.config,
    }, 'Holder growth velocity scanner initialized');
  }

  /**
   * Start the scanning loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Holder growth scanner already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting holder growth velocity scanning loop');

    // Run immediately, then on interval
    this.runScanCycle();
    this.scanTimer = setInterval(
      () => this.runScanCycle(),
      this.config.scanIntervalMinutes * 60 * 1000
    );
  }

  /**
   * Stop the scanning loop
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    logger.info('Holder growth scanner stopped');
  }

  /**
   * Run a single scan cycle
   */
  private async runScanCycle(): Promise<void> {
    try {
      logger.info('Holder growth scan cycle starting...');

      // Step 1: Get candidate tokens
      const candidates = await this.getCandidateTokens();

      // Step 2: Update snapshots for all candidates
      await this.updateSnapshots(candidates);

      // Step 3: Check each for growth velocity
      const signals: HolderGrowthSignal[] = [];

      for (const address of candidates) {
        try {
          const signal = await this.checkGrowthVelocity(address);
          if (signal) {
            signals.push(signal);
          }
        } catch (error) {
          logger.debug({ error, address: address.slice(0, 8) }, 'Error checking holder growth');
        }
      }

      // Step 4: Log results
      if (signals.length > 0) {
        logger.info({
          count: signals.length,
          topGrowth: signals.slice(0, 5).map(s => ({
            ticker: s.ticker,
            holdersPerHour: s.holdersPerHour.toFixed(0),
            gained: s.holdersGained,
            total: s.currentHolders,
          })),
        }, 'Holder growth signals detected');
      } else {
        logger.debug('No significant holder growth detected this cycle');
      }

      // Step 5: Clean up old data
      this.cleanupSnapshots();

    } catch (error) {
      logger.error({ error }, 'Error in holder growth scan cycle');
    }
  }

  /**
   * Get candidate tokens to monitor
   */
  private async getCandidateTokens(): Promise<string[]> {
    const candidates: Set<string> = new Set();

    try {
      // Get trending tokens from DexScreener
      const trendingAddresses = await dexScreenerClient.getTrendingSolanaTokens(100);

      for (const address of trendingAddresses) {
        candidates.add(address);
      }

      // Also get from Birdeye new listings (slightly older ones for growth tracking)
      const newListings = await birdeyeClient.getNewListings(50);
      for (const listing of newListings) {
        if (listing.address) {
          candidates.add(listing.address);
        }
      }

      logger.debug({ count: candidates.size }, 'Holder growth scanner candidates');
    } catch (error) {
      logger.error({ error }, 'Failed to get candidates for holder growth scanning');
    }

    // Also include tokens we're already tracking
    for (const address of this.holderSnapshots.keys()) {
      candidates.add(address);
    }

    return Array.from(candidates).slice(0, 200);
  }

  /**
   * Update holder snapshots for candidates
   */
  private async updateSnapshots(candidates: string[]): Promise<void> {
    const now = Date.now();

    for (const address of candidates) {
      try {
        const metrics = await getTokenMetrics(address);
        if (!metrics) continue;

        // Get or create snapshot array
        let snapshots = this.holderSnapshots.get(address);
        if (!snapshots) {
          snapshots = [];
          this.holderSnapshots.set(address, snapshots);
        }

        // Add new snapshot
        snapshots.push({
          holders: metrics.holderCount,
          timestamp: now,
        });

        // Keep only snapshots within tracking window
        const windowMs = this.config.trackingWindowHours * 60 * 60 * 1000;
        this.holderSnapshots.set(
          address,
          snapshots.filter(s => now - s.timestamp < windowMs)
        );

      } catch {
        // Skip tokens we can't get data for
      }
    }
  }

  /**
   * Check if a token has significant holder growth velocity
   */
  private async checkGrowthVelocity(address: string): Promise<HolderGrowthSignal | null> {
    // Check cooldown
    const lastSignal = this.recentSignals.get(address);
    if (lastSignal && Date.now() - lastSignal < this.SIGNAL_COOLDOWN_MS) {
      return null;
    }

    // Get snapshots
    const snapshots = this.holderSnapshots.get(address);
    if (!snapshots || snapshots.length < 2) {
      return null; // Need at least 2 snapshots to calculate velocity
    }

    // Sort by timestamp
    const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
    const oldest = sorted[0];
    const newest = sorted[sorted.length - 1];

    // Calculate time span
    const timeSpanMs = newest.timestamp - oldest.timestamp;
    const timeSpanHours = timeSpanMs / (60 * 60 * 1000);

    // Need at least 15 minutes of data
    if (timeSpanHours < 0.25) {
      return null;
    }

    // Calculate holder growth
    const holdersGained = newest.holders - oldest.holders;
    const holdersPerHour = holdersGained / timeSpanHours;

    // Check if meets threshold
    if (holdersPerHour < this.config.minHoldersPerHour) {
      return null;
    }

    // Get current metrics for additional data
    const metrics = await getTokenMetrics(address);
    if (!metrics) return null;

    // Apply additional filters
    if (metrics.tokenAge < this.config.minTokenAgeHours) {
      return null;
    }

    if (metrics.holderCount < this.config.minExistingHolders) {
      return null;
    }

    if (metrics.liquidityPool < this.config.minLiquidity) {
      return null;
    }

    // Calculate growth rate
    const growthRate = oldest.holders > 0
      ? ((newest.holders - oldest.holders) / oldest.holders) * 100
      : 0;

    // Record this signal
    this.recentSignals.set(address, Date.now());

    logger.info({
      ticker: metrics.ticker,
      address: address.slice(0, 8),
      holdersPerHour: holdersPerHour.toFixed(1),
      gained: holdersGained,
      timeSpan: timeSpanHours.toFixed(2) + 'h',
      total: newest.holders,
    }, 'Holder growth velocity signal detected');

    return {
      address,
      ticker: metrics.ticker,
      name: metrics.name,
      currentHolders: newest.holders,
      previousHolders: oldest.holders,
      holdersGained,
      holdersPerHour,
      growthRate,
      marketCap: metrics.marketCap,
      liquidity: metrics.liquidityPool,
      volume24h: metrics.volume24h,
      tokenAgeHours: metrics.tokenAge,
      detectedAt: new Date(),
      trackingStarted: new Date(oldest.timestamp),
    };
  }

  /**
   * Get current growth signals (for use by signal generator)
   */
  async getGrowthSignals(): Promise<HolderGrowthSignal[]> {
    const candidates = await this.getCandidateTokens();
    await this.updateSnapshots(candidates);

    const signals: HolderGrowthSignal[] = [];

    for (const address of candidates.slice(0, this.config.maxTokensPerScan)) {
      try {
        const signal = await this.checkGrowthVelocity(address);
        if (signal) {
          signals.push(signal);
        }
      } catch {
        // Skip errors silently
      }
    }

    // Sort by holders per hour (highest first)
    return signals.sort((a, b) => b.holdersPerHour - a.holdersPerHour);
  }

  /**
   * Get token addresses with holder growth
   */
  async getGrowthAddresses(): Promise<string[]> {
    const signals = await this.getGrowthSignals();
    return signals.map(s => s.address);
  }

  /**
   * Load snapshots from database
   */
  private async loadSnapshots(): Promise<void> {
    try {
      const result = await pool.query(`
        SELECT token_address, holder_count, recorded_at
        FROM holder_snapshots
        WHERE recorded_at > NOW() - INTERVAL '6 hours'
        ORDER BY recorded_at ASC
      `);

      for (const row of result.rows) {
        const address = row.token_address;
        if (!this.holderSnapshots.has(address)) {
          this.holderSnapshots.set(address, []);
        }
        this.holderSnapshots.get(address)!.push({
          holders: parseInt(row.holder_count),
          timestamp: new Date(row.recorded_at).getTime(),
        });
      }

      logger.info({
        tokens: this.holderSnapshots.size,
        snapshots: result.rows.length,
      }, 'Loaded holder snapshots from database');
    } catch (error) {
      // Table might not exist yet
      logger.debug({ error }, 'Could not load holder snapshots (table may not exist)');
    }
  }

  /**
   * Clean up old snapshot data
   */
  private cleanupSnapshots(): void {
    const now = Date.now();
    const windowMs = this.config.trackingWindowHours * 60 * 60 * 1000;

    // Clean old snapshots
    for (const [address, snapshots] of this.holderSnapshots) {
      const filtered = snapshots.filter(s => now - s.timestamp < windowMs);
      if (filtered.length === 0) {
        this.holderSnapshots.delete(address);
      } else {
        this.holderSnapshots.set(address, filtered);
      }
    }

    // Clean old signals
    for (const [address, timestamp] of this.recentSignals) {
      if (now - timestamp > 24 * 60 * 60 * 1000) {
        this.recentSignals.delete(address);
      }
    }

    logger.debug({
      trackedTokens: this.holderSnapshots.size,
      recentSignals: this.recentSignals.size,
    }, 'Holder growth scanner cleanup complete');
  }

  /**
   * Manually track a token (for external use)
   */
  async trackToken(address: string): Promise<void> {
    const metrics = await getTokenMetrics(address);
    if (!metrics) return;

    if (!this.holderSnapshots.has(address)) {
      this.holderSnapshots.set(address, []);
    }

    this.holderSnapshots.get(address)!.push({
      holders: metrics.holderCount,
      timestamp: Date.now(),
    });
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<HolderGrowthConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Holder growth scanner config updated');
  }

  /**
   * Get scanner statistics
   */
  getStats(): {
    isRunning: boolean;
    trackedTokens: number;
    totalSnapshots: number;
    recentSignalsCount: number;
    config: HolderGrowthConfig;
  } {
    let totalSnapshots = 0;
    for (const snapshots of this.holderSnapshots.values()) {
      totalSnapshots += snapshots.length;
    }

    return {
      isRunning: this.isRunning,
      trackedTokens: this.holderSnapshots.size,
      totalSnapshots,
      recentSignalsCount: this.recentSignals.size,
      config: this.config,
    };
  }
}

// ============ EXPORTS ============

export const holderGrowthScanner = new HolderGrowthScanner();

export default {
  HolderGrowthScanner,
  holderGrowthScanner,
};
