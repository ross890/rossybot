// ===========================================
// HOLDER GROWTH VELOCITY SCANNER
// Detects tokens with rapid holder growth (50+ holders/hour)
// Phase 1 Quick Win: Token Discovery Enhancement
//
// SMART FEATURES:
// - Relative growth (as % of existing holders)
// - Holder quality analysis (new wallets vs established)
// - Organic growth vs artificial growth detection
// - Not blocking, but informing signals
// ===========================================

import { logger } from '../../utils/logger.js';
import { Database, pool } from '../../utils/database.js';
import { getTokenMetrics, dexScreenerClient } from '../onchain.js';
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

  // Holder quality analysis thresholds
  holderQualityAnalysis: {
    enabled: boolean;
    minRelativeGrowthPercent: number;   // Min % growth relative to existing holders
    suspiciousGrowthRatePercent: number; // Growth > this % in short time is suspicious
    idealNewToExistingRatio: number;     // Ideal ratio of new vs existing wallet holders
  };
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
  holderQualityAnalysis: {
    enabled: true,
    minRelativeGrowthPercent: 5,    // Need at least 5% growth relative to base
    suspiciousGrowthRatePercent: 50, // >50% growth in 1 hour is suspicious
    idealNewToExistingRatio: 0.7,    // 70% new wallets is ideal (30% experienced)
  },
};

// ============ TYPES ============

// Holder quality analysis result
export interface HolderQualityAnalysis {
  qualityScore: number;        // 0-100, higher = better quality growth
  isOrganicGrowth: boolean;    // true if growth appears organic
  warnings: string[];          // Human-readable warnings
  metrics: {
    relativeGrowthPercent: number;  // Growth as % of starting holders
    estimatedNewWalletPercent: number; // % of new holders that are fresh wallets
    estimatedExperiencedPercent: number; // % that have held other tokens
    avgHoldingSize: number;    // Average $ size of new holder positions
    growthConsistency: number; // How consistent is growth over time (0-100)
  };
  positiveSignals: string[];   // Positive indicators
}

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

  // NEW: Holder quality analysis (informational)
  holderQualityAnalysis?: HolderQualityAnalysis;
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

    // SMART FEATURE: Analyze holder quality (informational, not blocking)
    let holderQualityAnalysis: HolderQualityAnalysis | undefined;
    if (this.config.holderQualityAnalysis.enabled) {
      holderQualityAnalysis = await this.analyzeHolderQuality(
        address,
        metrics,
        sorted,
        holdersGained,
        growthRate,
        timeSpanHours
      );
    }

    // Record this signal
    this.recentSignals.set(address, Date.now());

    logger.info({
      ticker: metrics.ticker,
      address: address.slice(0, 8),
      holdersPerHour: holdersPerHour.toFixed(1),
      gained: holdersGained,
      timeSpan: timeSpanHours.toFixed(2) + 'h',
      total: newest.holders,
      relativeGrowth: growthRate.toFixed(1) + '%',
      qualityScore: holderQualityAnalysis?.qualityScore || 0,
      isOrganic: holderQualityAnalysis?.isOrganicGrowth,
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
      holderQualityAnalysis,
    };
  }

  /**
   * Analyze holder quality - distinguish organic vs artificial growth
   * Returns quality score and detailed metrics (informational, not blocking)
   */
  private async analyzeHolderQuality(
    address: string,
    metrics: TokenMetrics,
    snapshots: HolderSnapshot[],
    holdersGained: number,
    growthRatePercent: number,
    timeSpanHours: number
  ): Promise<HolderQualityAnalysis> {
    const warnings: string[] = [];
    const positiveSignals: string[] = [];
    let qualityScore = 50; // Start neutral

    // Initialize metrics with defaults
    const analysisMetrics = {
      relativeGrowthPercent: growthRatePercent,
      estimatedNewWalletPercent: 70,  // Default estimate
      estimatedExperiencedPercent: 30,
      avgHoldingSize: 0,
      growthConsistency: 50,
    };

    try {
      // ANALYSIS 1: Relative growth (% of existing holders)
      // More meaningful than absolute numbers
      // e.g., 100 new holders when you had 200 (50% growth) vs when you had 10,000 (1% growth)
      if (growthRatePercent > 100) {
        // Doubling+ holders very quickly is suspicious
        qualityScore -= 20;
        warnings.push(`Extremely rapid growth: ${growthRatePercent.toFixed(0)}% increase`);
      } else if (growthRatePercent > 50) {
        // 50%+ growth is notable
        qualityScore -= 10;
        warnings.push(`Very fast growth: ${growthRatePercent.toFixed(0)}% increase`);
      } else if (growthRatePercent >= 10 && growthRatePercent <= 30) {
        // 10-30% is healthy organic growth
        qualityScore += 15;
        positiveSignals.push(`Healthy growth rate: ${growthRatePercent.toFixed(0)}%`);
      } else if (growthRatePercent >= 5) {
        qualityScore += 5;
      }

      // ANALYSIS 2: Growth consistency over time
      // Organic growth is usually steady, not all at once
      if (snapshots.length >= 3) {
        const intervals: number[] = [];
        for (let i = 1; i < snapshots.length; i++) {
          const diff = snapshots[i].holders - snapshots[i - 1].holders;
          intervals.push(diff);
        }

        // Calculate variance in growth intervals
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance = intervals.reduce((sum, val) => sum + Math.pow(val - avgInterval, 2), 0) / intervals.length;
        const stdDev = Math.sqrt(variance);
        const coeffOfVariation = avgInterval > 0 ? (stdDev / avgInterval) * 100 : 0;

        // Low variance = consistent growth = more organic
        // High variance = spiky growth = potentially artificial
        if (coeffOfVariation < 50) {
          qualityScore += 15;
          positiveSignals.push('Consistent growth pattern');
          analysisMetrics.growthConsistency = 80;
        } else if (coeffOfVariation < 100) {
          analysisMetrics.growthConsistency = 60;
        } else if (coeffOfVariation > 150) {
          qualityScore -= 15;
          warnings.push('Erratic/spiky growth pattern');
          analysisMetrics.growthConsistency = 30;
        }
      }

      // ANALYSIS 3: Holder size distribution estimate
      // Use mcap and holder count to estimate avg holding
      const avgHoldingSize = metrics.marketCap / Math.max(metrics.holderCount, 1);
      analysisMetrics.avgHoldingSize = avgHoldingSize;

      if (avgHoldingSize > 10000) {
        // Large average holdings suggest whales, not retail
        qualityScore -= 10;
        warnings.push(`High avg holding: $${avgHoldingSize.toFixed(0)}`);
      } else if (avgHoldingSize >= 100 && avgHoldingSize <= 2000) {
        // Healthy retail range
        qualityScore += 10;
        positiveSignals.push('Healthy retail-sized holdings');
      } else if (avgHoldingSize < 50) {
        // Very small holdings might be dust/bots
        qualityScore -= 5;
        warnings.push('Very small avg holdings (possible dust/bots)');
      }

      // ANALYSIS 4: Volume to new holders ratio
      // High volume with few new holders = existing holders trading
      // Moderate volume with many new holders = organic adoption
      const volumePerNewHolder = metrics.volume24h / Math.max(holdersGained, 1);

      if (volumePerNewHolder > 5000) {
        // $5K+ volume per new holder suggests not just new buyers
        qualityScore -= 5;
        warnings.push(`High volume/new holder ratio: $${volumePerNewHolder.toFixed(0)}`);
      } else if (volumePerNewHolder >= 100 && volumePerNewHolder <= 1000) {
        qualityScore += 5;
        positiveSignals.push('Healthy volume per new holder');
      }

      // ANALYSIS 5: Estimate new vs experienced wallets
      // Heuristic: Newer tokens tend to attract more new wallets
      // Older tokens with growth likely have more experienced traders
      const tokenAgeWeeks = metrics.tokenAge / (24 * 7);

      if (tokenAgeWeeks < 1) {
        // Very new token - likely all new wallets
        analysisMetrics.estimatedNewWalletPercent = 85;
        analysisMetrics.estimatedExperiencedPercent = 15;
      } else if (tokenAgeWeeks < 4) {
        // 1-4 weeks old - mixed
        analysisMetrics.estimatedNewWalletPercent = 70;
        analysisMetrics.estimatedExperiencedPercent = 30;
      } else {
        // Established token with new growth - likely more experienced traders
        analysisMetrics.estimatedNewWalletPercent = 50;
        analysisMetrics.estimatedExperiencedPercent = 50;
        qualityScore += 10;
        positiveSignals.push('Established token attracting new holders');
      }

      // ANALYSIS 6: Growth rate relative to token maturity
      // Young tokens naturally grow faster, so adjust expectations
      const hourlyGrowthRate = growthRatePercent / Math.max(timeSpanHours, 1);

      if (tokenAgeWeeks > 4 && hourlyGrowthRate > 20) {
        // Old token suddenly growing 20%/hour is suspicious
        qualityScore -= 15;
        warnings.push('Mature token with unusually rapid growth');
      } else if (tokenAgeWeeks > 4 && hourlyGrowthRate > 5 && hourlyGrowthRate < 15) {
        // Established token with healthy renewed interest
        qualityScore += 15;
        positiveSignals.push('Renewed organic interest in established token');
      }

      // ANALYSIS 7: Holder count vs market cap sanity check
      // Very high holders with low mcap = potential airdrop/spam holders
      const mcapPerHolder = metrics.marketCap / Math.max(metrics.holderCount, 1);

      if (mcapPerHolder < 10) {
        // Less than $10 mcap per holder suggests artificial inflation
        qualityScore -= 15;
        warnings.push('Holder count may be artificially inflated');
      }

    } catch (error) {
      logger.debug({ error, address: address.slice(0, 8) }, 'Error analyzing holder quality');
    }

    // Bound quality score
    qualityScore = Math.max(0, Math.min(100, qualityScore));

    return {
      qualityScore,
      isOrganicGrowth: qualityScore >= 50 && warnings.length <= 1,
      warnings,
      metrics: analysisMetrics,
      positiveSignals,
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
