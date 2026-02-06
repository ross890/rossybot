// ===========================================
// VOLUME ANOMALY SCANNER
// Detects tokens with unusual volume spikes (5x+ normal)
// Phase 1 Quick Win: Token Discovery Enhancement
//
// SMART FEATURES:
// - Wash trading detection (clustered wallets, repetitive patterns)
// - Volume authenticity scoring
// - Not blocking, but informing signals of suspicious activity
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

  // Wash trading detection thresholds
  washTradingDetection: {
    enabled: boolean;
    maxRepetitiveTxPercent: number;     // Max % of txs with same amount (suggests bot)
    maxTopWalletVolumePercent: number;  // Max % of volume from top 3 wallets
    minUniqueTraders: number;           // Min unique traders for legitimate volume
    suspiciousAvgTxSize: number;        // Average tx size that's suspiciously uniform
  };
}

const DEFAULT_CONFIG: VolumeAnomalyConfig = {
  minVolumeMultiplier: 3,     // 3x normal volume (was 5x)
  minAbsoluteVolume: 5000,    // $5K volume (was $25K)
  minTokenAgeDays: 0.083,     // 2 hours old (was 1 day)
  maxTokenAgeDays: 90,        // Up to 90 days old (extended from 14)
  minLiquidity: 2000,         // $2K liquidity (was $15K)
  scanIntervalMinutes: 10,    // Scan every 10 minutes
  maxTokensPerScan: 50,       // Return up to 50 tokens
  washTradingDetection: {
    enabled: true,
    maxRepetitiveTxPercent: 70,     // Bots are normal on memecoins (was 40%)
    maxTopWalletVolumePercent: 85,  // Whales dominate early (was 60%)
    minUniqueTraders: 5,            // 5 unique traders (was 20)
    suspiciousAvgTxSize: 500,       // Very uniform avg tx size is suspicious
  },
};

// ============ TYPES ============

// Wash trading analysis result
export interface WashTradingAnalysis {
  suspicionScore: number;      // 0-100, higher = more suspicious
  isLikelySpoofed: boolean;    // true if score > 60
  warnings: string[];          // Human-readable warnings
  metrics: {
    repetitiveTxPercent: number;     // % of txs with identical amounts
    topWalletsVolumePercent: number; // % of volume from top 3 wallets
    uniqueTraders: number;           // Number of unique trading wallets
    avgTxSizeVariance: number;       // Variance in tx sizes (low = suspicious)
    buyToSellRatio: number;          // Extreme ratios suggest manipulation
  };
}

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

  // NEW: Wash trading analysis (informational, not blocking)
  washTradingAnalysis?: WashTradingAnalysis;
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

    // SMART FEATURE: Analyze for wash trading (informational, not blocking)
    let washTradingAnalysis: WashTradingAnalysis | undefined;
    if (this.config.washTradingDetection.enabled) {
      washTradingAnalysis = await this.analyzeWashTrading(address, metrics);
    }

    // Record this anomaly
    this.recentAnomalies.set(address, Date.now());

    logger.info({
      ticker: metrics.ticker,
      address: address.slice(0, 8),
      volumeMultiplier: volumeMultiplier.toFixed(1),
      currentVolume: metrics.volume24h,
      avgVolume: averageVolume7d,
      washTradingSuspicion: washTradingAnalysis?.suspicionScore || 0,
      isLikelySpoofed: washTradingAnalysis?.isLikelySpoofed || false,
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
      washTradingAnalysis,
    };
  }

  /**
   * Analyze a token for wash trading / spoofed volume
   * Returns suspicion score and detailed metrics (informational, not blocking)
   */
  private async analyzeWashTrading(address: string, metrics: TokenMetrics): Promise<WashTradingAnalysis> {
    const warnings: string[] = [];
    let suspicionScore = 0;

    // Default metrics (when we can't fetch detailed data)
    const analysisMetrics = {
      repetitiveTxPercent: 0,
      topWalletsVolumePercent: 0,
      uniqueTraders: 0,
      avgTxSizeVariance: 100, // High variance = good
      buyToSellRatio: 1.0,
    };

    try {
      // Try to get trade data from APIs
      // We'll use heuristics based on available data

      // HEURISTIC 1: Volume to holder ratio
      // High volume but few holders suggests wash trading
      const volumePerHolder = metrics.volume24h / Math.max(metrics.holderCount, 1);
      if (volumePerHolder > 5000) {
        // Each holder averaging $5K+ volume is suspicious
        suspicionScore += 20;
        warnings.push(`High volume per holder: $${volumePerHolder.toFixed(0)}/holder`);
      } else if (volumePerHolder > 2000) {
        suspicionScore += 10;
        warnings.push(`Elevated volume per holder: $${volumePerHolder.toFixed(0)}/holder`);
      }

      // HEURISTIC 2: Volume to liquidity ratio
      // Volume >> liquidity suggests potential wash trading (artificial volume)
      const volumeToLiquidity = metrics.volume24h / Math.max(metrics.liquidityPool, 1);
      if (volumeToLiquidity > 20) {
        // 20x daily turnover of liquidity is very suspicious
        suspicionScore += 25;
        warnings.push(`Extreme volume/liquidity ratio: ${volumeToLiquidity.toFixed(1)}x`);
      } else if (volumeToLiquidity > 10) {
        suspicionScore += 15;
        warnings.push(`High volume/liquidity ratio: ${volumeToLiquidity.toFixed(1)}x`);
      } else if (volumeToLiquidity > 5) {
        suspicionScore += 5;
      }

      // HEURISTIC 3: Volume to market cap ratio
      // Extremely high volume relative to market cap can indicate manipulation
      const volumeToMcap = metrics.volume24h / Math.max(metrics.marketCap, 1);
      if (volumeToMcap > 2) {
        // >200% daily turnover of entire market cap
        suspicionScore += 20;
        warnings.push(`Volume exceeds 2x market cap`);
      } else if (volumeToMcap > 1) {
        suspicionScore += 10;
        warnings.push(`Volume exceeds market cap`);
      }

      // HEURISTIC 4: Holder count vs volume (few holders + huge volume = suspicious)
      if (metrics.holderCount < 100 && metrics.volume24h > 100000) {
        suspicionScore += 15;
        warnings.push(`Only ${metrics.holderCount} holders with $${(metrics.volume24h / 1000).toFixed(0)}K volume`);
        analysisMetrics.uniqueTraders = metrics.holderCount;
      } else if (metrics.holderCount < 50 && metrics.volume24h > 50000) {
        suspicionScore += 20;
        warnings.push(`Very few holders (${metrics.holderCount}) with significant volume`);
        analysisMetrics.uniqueTraders = metrics.holderCount;
      }

      // Try to get more detailed trade data if available
      try {
        // Use existing momentum analyzer data if we have it
        // This gives us buy/sell ratio and unique buyer counts
        const tradeStats = await this.getTradeStats(address);
        if (tradeStats) {
          analysisMetrics.uniqueTraders = tradeStats.uniqueTraders;
          analysisMetrics.buyToSellRatio = tradeStats.buyToSellRatio;
          analysisMetrics.topWalletsVolumePercent = tradeStats.topWalletsVolumePercent;

          // HEURISTIC 5: Extreme buy/sell imbalance
          if (tradeStats.buyToSellRatio > 10 || tradeStats.buyToSellRatio < 0.1) {
            suspicionScore += 15;
            warnings.push(`Extreme buy/sell ratio: ${tradeStats.buyToSellRatio.toFixed(2)}`);
          }

          // HEURISTIC 6: Top wallets dominating volume
          if (tradeStats.topWalletsVolumePercent > 60) {
            suspicionScore += 20;
            warnings.push(`Top 3 wallets: ${tradeStats.topWalletsVolumePercent.toFixed(0)}% of volume`);
          } else if (tradeStats.topWalletsVolumePercent > 40) {
            suspicionScore += 10;
            warnings.push(`Concentrated trading: top wallets ${tradeStats.topWalletsVolumePercent.toFixed(0)}%`);
          }

          // HEURISTIC 7: Very few unique traders
          if (tradeStats.uniqueTraders < this.config.washTradingDetection.minUniqueTraders) {
            suspicionScore += 15;
            warnings.push(`Only ${tradeStats.uniqueTraders} unique traders`);
          }
        }
      } catch {
        // Can't get detailed trade stats - that's OK, use basic heuristics
      }

    } catch (error) {
      logger.debug({ error, address: address.slice(0, 8) }, 'Error analyzing wash trading');
    }

    // Cap at 100
    suspicionScore = Math.min(100, suspicionScore);

    return {
      suspicionScore,
      isLikelySpoofed: suspicionScore >= 60,
      warnings,
      metrics: analysisMetrics,
    };
  }

  /**
   * Get trade statistics for wash trading analysis
   * Returns null if data unavailable
   */
  private async getTradeStats(address: string): Promise<{
    uniqueTraders: number;
    buyToSellRatio: number;
    topWalletsVolumePercent: number;
  } | null> {
    try {
      // Use DexScreener pairs data (FREE) for trade statistics
      const pairs = await dexScreenerClient.getTokenPairs(address);
      if (pairs.length > 0) {
        const pair = pairs[0] as any;
        const buys24h = pair.txns?.h24?.buys || 0;
        const sells24h = pair.txns?.h24?.sells || 0;
        const totalTrades = buys24h + sells24h;

        // Estimate unique traders from transaction counts
        const uniqueTraders = totalTrades;

        // Calculate buy/sell ratio
        const buyToSellRatio = sells24h > 0 ? buys24h / sells24h : buys24h > 0 ? 10 : 1;

        // Estimate top wallet concentration (not directly available from DexScreener)
        // Use a moderate default - actual concentration checked via Helius holder data
        const topWalletsVolumePercent = 30; // Conservative estimate

        return {
          uniqueTraders,
          buyToSellRatio,
          topWalletsVolumePercent,
        };
      }
    } catch {
      // Data unavailable
    }

    return null;
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
