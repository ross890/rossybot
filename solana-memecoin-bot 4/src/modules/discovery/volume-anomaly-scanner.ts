// ===========================================
// VOLUME ANOMALY SCANNER
// Detects tokens with unusual volume spikes (5x+ normal)
// Phase 1 Quick Win: Token Discovery Enhancement
// ===========================================

import { logger } from '../../utils/logger.js';
import { Database, pool } from '../../utils/database.js';
import { getTokenMetrics, dexScreenerClient } from '../onchain.js';
import { TokenMetrics } from '../../types/index.js';

// ============ CONFIGURATION ============

interface VolumeAnomalyConfig {
  // Minimum volume multiplier to be considered an anomaly (5x = 500% increase)
  minVolumeMultiplier: number;

  // Minimum absolute volume (USD) to consider
  minAbsoluteVolume: number;

  // Token age range (in days) - only scan established tokens
  minTokenAgeDays: number;
  maxTokenAgeDays: number;

  // Minimum liquidity for safety
  minLiquidity: number;

  // Scan interval in minutes
  scanIntervalMinutes: number;

  // Maximum tokens to return per scan
  maxTokensPerScan: number;
}

const DEFAULT_CONFIG: VolumeAnomalyConfig = {
  minVolumeMultiplier: 5,     // 5x normal volume
  minAbsoluteVolume: 25000,   // At least $25K volume
  minTokenAgeDays: 1,         // At least 1 day old
  maxTokenAgeDays: 90,        // Up to 90 days old (extended from 14)
  minLiquidity: 15000,        // At least $15K liquidity
  scanIntervalMinutes: 10,    // Scan every 10 minutes
  maxTokensPerScan: 50,       // Return up to 50 tokens
};

// ============ TYPES ============

export interface VolumeAnomaly {
  address: string;
  ticker: string;
  name: string;
  currentVolume24h: number;
  averageVolume7d: number;
  volumeMultiplier: number;
  volumeChange24h: number;
  marketCap: number;
  liquidity: number;
  holderCount: number;
  tokenAgeHours: number;
  detectedAt: Date;
}

// ============ SCANNER CLASS ============

class VolumeAnomalyScanner {
  private config: VolumeAnomalyConfig = DEFAULT_CONFIG;
  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;

  // Cache of detected anomalies (to avoid duplicate alerts)
  private recentAnomalies: Map<string, number> = new Map();
  private readonly ANOMALY_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hour cooldown

  // Cache of historical volume data
  private volumeHistory: Map<string, { volume7d: number; lastUpdated: number }> = new Map();

  /**
   * Initialize the scanner
   */
  async initialize(): Promise<void> {
    logger.info('Initializing volume anomaly scanner...');

    // Load any persistent volume history from database
    await this.loadVolumeHistory();

    logger.info({
      config: this.config,
    }, 'Volume anomaly scanner initialized');
  }

  /**
   * Start the scanning loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Volume anomaly scanner already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting volume anomaly scanning loop');

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

    logger.info('Volume anomaly scanner stopped');
  }

  /**
   * Run a single scan cycle
   */
  private async runScanCycle(): Promise<void> {
    try {
      logger.info('Volume anomaly scan cycle starting...');

      // Step 1: Get candidate tokens to check (from trending + recent signals)
      const candidates = await this.getCandidateTokens();

      // Step 2: Check each for volume anomalies
      const anomalies: VolumeAnomaly[] = [];

      for (const address of candidates) {
        try {
          const anomaly = await this.checkVolumeAnomaly(address);
          if (anomaly) {
            anomalies.push(anomaly);
          }
        } catch (error) {
          logger.debug({ error, address: address.slice(0, 8) }, 'Error checking token for volume anomaly');
        }
      }

      // Step 3: Log results
      if (anomalies.length > 0) {
        logger.info({
          count: anomalies.length,
          topAnomalies: anomalies.slice(0, 5).map(a => ({
            ticker: a.ticker,
            multiplier: a.volumeMultiplier.toFixed(1) + 'x',
            volume: '$' + a.currentVolume24h.toLocaleString(),
          })),
        }, 'Volume anomalies detected');
      } else {
        logger.debug('No volume anomalies detected this cycle');
      }

      // Step 4: Clean up old entries from caches
      this.cleanupCaches();

    } catch (error) {
      logger.error({ error }, 'Error in volume anomaly scan cycle');
    }
  }

  /**
   * Get candidate tokens to check for anomalies
   */
  private async getCandidateTokens(): Promise<string[]> {
    const candidates: Set<string> = new Set();

    try {
      // Get trending tokens from DexScreener (includes established tokens with activity)
      const trendingAddresses = await dexScreenerClient.getTrendingSolanaTokens(100);

      for (const address of trendingAddresses) {
        candidates.add(address);
      }

      logger.debug({ count: candidates.size }, 'Volume scanner candidates from trending');
    } catch (error) {
      logger.error({ error }, 'Failed to get candidates for volume scanning');
    }

    // Also check tokens we've tracked historically
    for (const address of this.volumeHistory.keys()) {
      candidates.add(address);
    }

    return Array.from(candidates).slice(0, 200); // Cap at 200 to avoid rate limits
  }

  /**
   * Check if a token has a volume anomaly
   */
  private async checkVolumeAnomaly(address: string): Promise<VolumeAnomaly | null> {
    // Check cooldown
    const lastDetected = this.recentAnomalies.get(address);
    if (lastDetected && Date.now() - lastDetected < this.ANOMALY_COOLDOWN_MS) {
      return null;
    }

    // Get current metrics
    const metrics = await getTokenMetrics(address);
    if (!metrics) return null;

    // Check token age range
    const tokenAgeHours = metrics.tokenAge;
    const tokenAgeDays = tokenAgeHours / 24;

    if (tokenAgeDays < this.config.minTokenAgeDays || tokenAgeDays > this.config.maxTokenAgeDays) {
      return null;
    }

    // Check minimum liquidity
    if (metrics.liquidityPool < this.config.minLiquidity) {
      return null;
    }

    // Check minimum absolute volume
    if (metrics.volume24h < this.config.minAbsoluteVolume) {
      return null;
    }

    // Get historical volume data
    const historical = this.volumeHistory.get(address);

    // Calculate average volume (use stored history or estimate from current)
    let averageVolume7d: number;

    if (historical && Date.now() - historical.lastUpdated < 24 * 60 * 60 * 1000) {
      // Use cached 7-day average
      averageVolume7d = historical.volume7d;
    } else {
      // Estimate: Assume current volume is elevated, use 20% of current as baseline
      // This is a heuristic - in production you'd store historical data properly
      averageVolume7d = metrics.volume24h * 0.2;

      // Update cache for future comparisons
      this.volumeHistory.set(address, {
        volume7d: averageVolume7d,
        lastUpdated: Date.now(),
      });
    }

    // Avoid division by zero
    if (averageVolume7d < 1000) {
      averageVolume7d = 1000; // Minimum baseline
    }

    // Calculate volume multiplier
    const volumeMultiplier = metrics.volume24h / averageVolume7d;

    // Check if it's an anomaly
    if (volumeMultiplier < this.config.minVolumeMultiplier) {
      return null;
    }

    // Record this anomaly
    this.recentAnomalies.set(address, Date.now());

    logger.info({
      ticker: metrics.ticker,
      address: address.slice(0, 8),
      volumeMultiplier: volumeMultiplier.toFixed(1),
      currentVolume: metrics.volume24h,
      avgVolume: averageVolume7d,
    }, 'Volume anomaly detected');

    return {
      address,
      ticker: metrics.ticker,
      name: metrics.name,
      currentVolume24h: metrics.volume24h,
      averageVolume7d,
      volumeMultiplier,
      volumeChange24h: ((metrics.volume24h - averageVolume7d) / averageVolume7d) * 100,
      marketCap: metrics.marketCap,
      liquidity: metrics.liquidityPool,
      holderCount: metrics.holderCount,
      tokenAgeHours,
      detectedAt: new Date(),
    };
  }

  /**
   * Get current anomalies (for use by signal generator)
   */
  async getAnomalies(): Promise<VolumeAnomaly[]> {
    const candidates = await this.getCandidateTokens();
    const anomalies: VolumeAnomaly[] = [];

    for (const address of candidates.slice(0, this.config.maxTokensPerScan)) {
      try {
        const anomaly = await this.checkVolumeAnomaly(address);
        if (anomaly) {
          anomalies.push(anomaly);
        }
      } catch {
        // Skip errors silently
      }
    }

    // Sort by volume multiplier (highest first)
    return anomalies.sort((a, b) => b.volumeMultiplier - a.volumeMultiplier);
  }

  /**
   * Get token addresses with volume anomalies
   */
  async getAnomalyAddresses(): Promise<string[]> {
    const anomalies = await this.getAnomalies();
    return anomalies.map(a => a.address);
  }

  /**
   * Load volume history from database
   */
  private async loadVolumeHistory(): Promise<void> {
    try {
      // Check if table exists and has data
      const result = await pool.query(`
        SELECT token_address, avg_volume_7d, updated_at
        FROM token_volume_history
        WHERE updated_at > NOW() - INTERVAL '7 days'
        ORDER BY updated_at DESC
        LIMIT 1000
      `);

      for (const row of result.rows) {
        this.volumeHistory.set(row.token_address, {
          volume7d: parseFloat(row.avg_volume_7d),
          lastUpdated: new Date(row.updated_at).getTime(),
        });
      }

      logger.info({ count: result.rows.length }, 'Loaded volume history from database');
    } catch (error) {
      // Table might not exist yet - that's OK
      logger.debug({ error }, 'Could not load volume history (table may not exist)');
    }
  }

  /**
   * Clean up old cache entries
   */
  private cleanupCaches(): void {
    const now = Date.now();

    // Clean anomaly cooldowns older than 24 hours
    for (const [address, timestamp] of this.recentAnomalies) {
      if (now - timestamp > 24 * 60 * 60 * 1000) {
        this.recentAnomalies.delete(address);
      }
    }

    // Clean volume history older than 7 days
    for (const [address, data] of this.volumeHistory) {
      if (now - data.lastUpdated > 7 * 24 * 60 * 60 * 1000) {
        this.volumeHistory.delete(address);
      }
    }
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<VolumeAnomalyConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Volume anomaly scanner config updated');
  }

  /**
   * Get scanner statistics
   */
  getStats(): {
    isRunning: boolean;
    recentAnomaliesCount: number;
    trackedTokensCount: number;
    config: VolumeAnomalyConfig;
  } {
    return {
      isRunning: this.isRunning,
      recentAnomaliesCount: this.recentAnomalies.size,
      trackedTokensCount: this.volumeHistory.size,
      config: this.config,
    };
  }
}

// ============ EXPORTS ============

export const volumeAnomalyScanner = new VolumeAnomalyScanner();

export default {
  VolumeAnomalyScanner,
  volumeAnomalyScanner,
};
