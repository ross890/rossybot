// ===========================================
// MODULE: MOMENTUM ANALYZER
// On-chain momentum detection for memecoin evaluation
// Independent of KOL tracking - pure metrics-based
// ===========================================

import { logger } from '../utils/logger.js';
import { heliusClient, birdeyeClient, dexScreenerClient } from './onchain.js';

// ============ TYPES ============

export interface MomentumMetrics {
  // Buy/Sell Analysis
  buyCount5m: number;
  sellCount5m: number;
  buyVolume5m: number;
  sellVolume5m: number;
  buySellRatio: number;           // >1.2 is healthy
  netBuyPressure: number;         // Positive = buying pressure

  // Volume Velocity
  volume5m: number;
  volume1h: number;
  volumeVelocity: number;         // 5m volume as % of 1h (>20% = momentum)
  volumeAcceleration: number;     // Is volume increasing? (-1 to 1)

  // Trade Patterns
  avgTradeSize: number;
  medianTradeSize: number;
  largeTradeCount: number;        // Trades > 2x median
  smallTradeRatio: number;        // % of trades < $50 (bot indicator)
  uniqueBuyers5m: number;
  uniqueSellers5m: number;

  // Holder Dynamics
  holderCount: number;
  newHolders5m: number;           // New unique wallets
  holderGrowthRate: number;       // Holders per minute

  // Price Action
  priceChange5m: number;
  priceChange1h: number;
  priceVolatility: number;        // Standard deviation of price moves

  // Timestamp
  analyzedAt: Date;
}

export interface MomentumScore {
  total: number;                  // 0-100
  breakdown: {
    buyPressure: number;          // 0-25: Buy/sell ratio strength
    volumeMomentum: number;       // 0-25: Volume velocity and acceleration
    tradeQuality: number;         // 0-25: Organic vs bot trading patterns
    holderGrowth: number;         // 0-25: New holder acquisition rate
  };
  signals: string[];              // Detected patterns
  flags: string[];                // Warning flags
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

// ============ CONSTANTS ============

// Research-backed thresholds
const THRESHOLDS = {
  // Buy/Sell Ratio
  EXCELLENT_BUY_RATIO: 2.0,       // Strong buying pressure
  GOOD_BUY_RATIO: 1.5,            // Healthy buying
  MIN_BUY_RATIO: 1.2,             // Minimum for momentum
  WEAK_BUY_RATIO: 0.8,            // Selling pressure

  // Volume Velocity (5m volume as % of 1h)
  EXCELLENT_VELOCITY: 0.30,       // 30% of hourly in 5 mins = explosive
  GOOD_VELOCITY: 0.20,            // 20% = strong momentum
  MIN_VELOCITY: 0.10,             // 10% = moderate interest

  // Trade Quality
  MAX_SMALL_TRADE_RATIO: 0.70,    // >70% tiny trades = bots
  MIN_UNIQUE_BUYERS: 5,           // Need at least 5 unique buyers in 5m

  // Holder Growth
  EXCELLENT_GROWTH_RATE: 2.0,     // 2+ holders/minute
  GOOD_GROWTH_RATE: 1.0,          // 1 holder/minute
  MIN_GROWTH_RATE: 0.2,           // At least some growth

  // Price Action
  MAX_VOLATILITY: 0.50,           // >50% swings = manipulation
  MIN_PRICE_SUPPORT: -0.15,       // Max 15% drawdown in 5m
} as const;

// ============ MOMENTUM ANALYZER CLASS ============

export class MomentumAnalyzer {
  private metricsCache: Map<string, { metrics: MomentumMetrics; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 30 * 1000; // 30 seconds cache

  /**
   * Analyze momentum for a token
   * This is the core on-chain analysis independent of KOL tracking
   */
  async analyze(tokenAddress: string): Promise<MomentumMetrics | null> {
    try {
      // Check cache
      const cached = this.metricsCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        return cached.metrics;
      }

      // Fetch data in parallel
      const [tradeData, holderData, priceData] = await Promise.all([
        this.getTradeMetrics(tokenAddress),
        this.getHolderMetrics(tokenAddress),
        this.getPriceMetrics(tokenAddress),
      ]);

      if (!tradeData) {
        logger.debug({ tokenAddress }, 'Could not fetch trade data for momentum analysis');
        return null;
      }

      const metrics: MomentumMetrics = {
        // Buy/Sell Analysis
        buyCount5m: tradeData.buyCount5m,
        sellCount5m: tradeData.sellCount5m,
        buyVolume5m: tradeData.buyVolume5m,
        sellVolume5m: tradeData.sellVolume5m,
        buySellRatio: tradeData.sellCount5m > 0
          ? tradeData.buyCount5m / tradeData.sellCount5m
          : tradeData.buyCount5m > 0 ? 10 : 1,
        netBuyPressure: tradeData.buyVolume5m - tradeData.sellVolume5m,

        // Volume Velocity
        volume5m: tradeData.volume5m,
        volume1h: tradeData.volume1h,
        volumeVelocity: tradeData.volume1h > 0
          ? tradeData.volume5m / tradeData.volume1h
          : 0,
        volumeAcceleration: tradeData.volumeAcceleration,

        // Trade Patterns
        avgTradeSize: tradeData.avgTradeSize,
        medianTradeSize: tradeData.medianTradeSize,
        largeTradeCount: tradeData.largeTradeCount,
        smallTradeRatio: tradeData.smallTradeRatio,
        uniqueBuyers5m: tradeData.uniqueBuyers5m,
        uniqueSellers5m: tradeData.uniqueSellers5m,

        // Holder Dynamics
        holderCount: holderData?.holderCount || 0,
        newHolders5m: holderData?.newHolders5m || 0,
        holderGrowthRate: holderData?.holderGrowthRate || 0,

        // Price Action
        priceChange5m: priceData?.priceChange5m || 0,
        priceChange1h: priceData?.priceChange1h || 0,
        priceVolatility: priceData?.priceVolatility || 0,

        analyzedAt: new Date(),
      };

      // Cache the result
      this.metricsCache.set(tokenAddress, { metrics, timestamp: Date.now() });

      return metrics;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to analyze momentum');
      return null;
    }
  }

  /**
   * Calculate momentum score from metrics
   */
  calculateScore(metrics: MomentumMetrics): MomentumScore {
    const breakdown = {
      buyPressure: this.scoreBuyPressure(metrics),
      volumeMomentum: this.scoreVolumeMomentum(metrics),
      tradeQuality: this.scoreTradeQuality(metrics),
      holderGrowth: this.scoreHolderGrowth(metrics),
    };

    const total = breakdown.buyPressure + breakdown.volumeMomentum +
                  breakdown.tradeQuality + breakdown.holderGrowth;

    const { signals, flags } = this.detectPatterns(metrics);
    const confidence = this.determineConfidence(metrics, flags);

    return {
      total: Math.round(total),
      breakdown,
      signals,
      flags,
      confidence,
    };
  }

  /**
   * Quick check if token has minimum momentum for consideration
   * Used for fast filtering before full analysis
   */
  async hasMinimumMomentum(tokenAddress: string): Promise<boolean> {
    const metrics = await this.analyze(tokenAddress);
    if (!metrics) return false;

    // Must have basic buying activity
    if (metrics.buyCount5m < 3) return false;

    // Must have some volume
    if (metrics.volume5m < 500) return false;

    // Must have positive or neutral buy/sell ratio
    if (metrics.buySellRatio < 0.8) return false;

    return true;
  }

  // ============ DATA FETCHING ============

  private async getTradeMetrics(tokenAddress: string): Promise<{
    buyCount5m: number;
    sellCount5m: number;
    buyVolume5m: number;
    sellVolume5m: number;
    volume5m: number;
    volume1h: number;
    volumeAcceleration: number;
    avgTradeSize: number;
    medianTradeSize: number;
    largeTradeCount: number;
    smallTradeRatio: number;
    uniqueBuyers5m: number;
    uniqueSellers5m: number;
  } | null> {
    try {
      // Get trade data from Birdeye
      const tradeData = await birdeyeClient.getTokenTradeData(tokenAddress);

      if (!tradeData) {
        // Fallback to DexScreener
        const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
        if (pairs.length === 0) return null;

        const pair = pairs[0];
        return {
          buyCount5m: pair.txns?.m5?.buys || 0,
          sellCount5m: pair.txns?.m5?.sells || 0,
          buyVolume5m: (pair.volume?.m5 || 0) * 0.6, // Estimate 60% buy volume
          sellVolume5m: (pair.volume?.m5 || 0) * 0.4,
          volume5m: pair.volume?.m5 || 0,
          volume1h: pair.volume?.h1 || 0,
          volumeAcceleration: this.calculateVolumeAcceleration(pair),
          avgTradeSize: pair.volume?.m5 && pair.txns?.m5
            ? pair.volume.m5 / (pair.txns.m5.buys + pair.txns.m5.sells)
            : 0,
          medianTradeSize: 0, // Not available from DexScreener
          largeTradeCount: 0,
          smallTradeRatio: 0.5, // Default estimate
          uniqueBuyers5m: pair.txns?.m5?.buys || 0, // Approximate
          uniqueSellers5m: pair.txns?.m5?.sells || 0,
        };
      }

      // Parse Birdeye trade data
      const buy5m = tradeData.buy5m || 0;
      const sell5m = tradeData.sell5m || 0;
      const buyVol5m = tradeData.buyVolume5m || tradeData.vBuy5m || 0;
      const sellVol5m = tradeData.sellVolume5m || tradeData.vSell5m || 0;
      const vol5m = buyVol5m + sellVol5m;
      const vol1h = tradeData.volume1h || tradeData.v1h || vol5m * 12;

      // Calculate volume acceleration (is volume increasing?)
      const vol15m = tradeData.volume15m || tradeData.v15m || vol5m * 3;
      const avgVolPer5m = vol15m / 3;
      const volumeAcceleration = avgVolPer5m > 0
        ? (vol5m - avgVolPer5m) / avgVolPer5m
        : 0;

      const totalTrades = buy5m + sell5m;
      const avgSize = totalTrades > 0 ? vol5m / totalTrades : 0;

      return {
        buyCount5m: buy5m,
        sellCount5m: sell5m,
        buyVolume5m: buyVol5m,
        sellVolume5m: sellVol5m,
        volume5m: vol5m,
        volume1h: vol1h,
        volumeAcceleration: Math.max(-1, Math.min(1, volumeAcceleration)),
        avgTradeSize: avgSize,
        medianTradeSize: avgSize * 0.7, // Estimate median as 70% of avg
        largeTradeCount: 0, // Would need transaction-level data
        smallTradeRatio: 0.5, // Default
        uniqueBuyers5m: tradeData.uniqueBuy5m || buy5m * 0.8,
        uniqueSellers5m: tradeData.uniqueSell5m || sell5m * 0.8,
      };
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to get trade metrics');
      return null;
    }
  }

  private async getHolderMetrics(tokenAddress: string): Promise<{
    holderCount: number;
    newHolders5m: number;
    holderGrowthRate: number;
  } | null> {
    try {
      const holderData = await heliusClient.getTokenHolders(tokenAddress);

      // Note: Getting new holders in last 5m requires historical tracking
      // For now, we estimate based on recent transaction unique addresses
      const holderCount = holderData.total;

      // Estimate new holders from buy transactions
      // In production, maintain a holder snapshot database
      const estimatedNewHolders = Math.floor(holderCount * 0.02); // 2% estimate

      return {
        holderCount,
        newHolders5m: estimatedNewHolders,
        holderGrowthRate: estimatedNewHolders / 5, // per minute
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get holder metrics');
      return null;
    }
  }

  private async getPriceMetrics(tokenAddress: string): Promise<{
    priceChange5m: number;
    priceChange1h: number;
    priceVolatility: number;
  } | null> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) return null;

      const pair = pairs[0];

      return {
        priceChange5m: pair.priceChange?.m5 || 0,
        priceChange1h: pair.priceChange?.h1 || 0,
        priceVolatility: Math.abs(pair.priceChange?.m5 || 0) / 100, // Normalize
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get price metrics');
      return null;
    }
  }

  private calculateVolumeAcceleration(pair: any): number {
    const vol5m = pair.volume?.m5 || 0;
    const vol1h = pair.volume?.h1 || 1;
    const avgPer5m = vol1h / 12;

    if (avgPer5m === 0) return 0;
    return Math.max(-1, Math.min(1, (vol5m - avgPer5m) / avgPer5m));
  }

  // ============ SCORING FUNCTIONS ============

  private scoreBuyPressure(metrics: MomentumMetrics): number {
    let score = 0;
    const maxScore = 25;

    // Buy/sell ratio scoring (0-15 points)
    if (metrics.buySellRatio >= THRESHOLDS.EXCELLENT_BUY_RATIO) {
      score += 15;
    } else if (metrics.buySellRatio >= THRESHOLDS.GOOD_BUY_RATIO) {
      score += 12;
    } else if (metrics.buySellRatio >= THRESHOLDS.MIN_BUY_RATIO) {
      score += 8;
    } else if (metrics.buySellRatio >= 1.0) {
      score += 5;
    } else if (metrics.buySellRatio >= THRESHOLDS.WEAK_BUY_RATIO) {
      score += 2;
    }

    // Net buy pressure scoring (0-10 points)
    if (metrics.netBuyPressure > 0) {
      const pressureRatio = metrics.buyVolume5m > 0
        ? metrics.netBuyPressure / metrics.buyVolume5m
        : 0;
      score += Math.min(10, Math.round(pressureRatio * 20));
    }

    return Math.min(maxScore, score);
  }

  private scoreVolumeMomentum(metrics: MomentumMetrics): number {
    let score = 0;
    const maxScore = 25;

    // Volume velocity scoring (0-15 points)
    if (metrics.volumeVelocity >= THRESHOLDS.EXCELLENT_VELOCITY) {
      score += 15;
    } else if (metrics.volumeVelocity >= THRESHOLDS.GOOD_VELOCITY) {
      score += 12;
    } else if (metrics.volumeVelocity >= THRESHOLDS.MIN_VELOCITY) {
      score += 8;
    } else if (metrics.volumeVelocity >= 0.05) {
      score += 4;
    }

    // Volume acceleration scoring (0-10 points)
    if (metrics.volumeAcceleration > 0.5) {
      score += 10; // Rapidly accelerating
    } else if (metrics.volumeAcceleration > 0.2) {
      score += 7;
    } else if (metrics.volumeAcceleration > 0) {
      score += 4;
    } else if (metrics.volumeAcceleration > -0.2) {
      score += 2; // Slight deceleration is OK
    }
    // Negative acceleration = no points

    return Math.min(maxScore, score);
  }

  private scoreTradeQuality(metrics: MomentumMetrics): number {
    let score = 0;
    const maxScore = 25;

    // Unique buyers scoring (0-10 points)
    if (metrics.uniqueBuyers5m >= 20) {
      score += 10;
    } else if (metrics.uniqueBuyers5m >= 10) {
      score += 7;
    } else if (metrics.uniqueBuyers5m >= THRESHOLDS.MIN_UNIQUE_BUYERS) {
      score += 4;
    } else if (metrics.uniqueBuyers5m >= 3) {
      score += 2;
    }

    // Trade size distribution (0-10 points)
    // Lower small trade ratio = more organic
    if (metrics.smallTradeRatio < 0.3) {
      score += 10; // Mostly larger trades = organic
    } else if (metrics.smallTradeRatio < 0.5) {
      score += 7;
    } else if (metrics.smallTradeRatio < THRESHOLDS.MAX_SMALL_TRADE_RATIO) {
      score += 4;
    }
    // High small trade ratio = bots, no points

    // Large trade presence (0-5 points)
    if (metrics.largeTradeCount >= 5) {
      score += 5;
    } else if (metrics.largeTradeCount >= 2) {
      score += 3;
    } else if (metrics.largeTradeCount >= 1) {
      score += 1;
    }

    return Math.min(maxScore, score);
  }

  private scoreHolderGrowth(metrics: MomentumMetrics): number {
    let score = 0;
    const maxScore = 25;

    // Holder growth rate scoring (0-15 points)
    if (metrics.holderGrowthRate >= THRESHOLDS.EXCELLENT_GROWTH_RATE) {
      score += 15;
    } else if (metrics.holderGrowthRate >= THRESHOLDS.GOOD_GROWTH_RATE) {
      score += 11;
    } else if (metrics.holderGrowthRate >= THRESHOLDS.MIN_GROWTH_RATE) {
      score += 6;
    } else if (metrics.holderGrowthRate > 0) {
      score += 2;
    }

    // Absolute holder count bonus (0-10 points)
    if (metrics.holderCount >= 500) {
      score += 10;
    } else if (metrics.holderCount >= 200) {
      score += 7;
    } else if (metrics.holderCount >= 100) {
      score += 4;
    } else if (metrics.holderCount >= 50) {
      score += 2;
    }

    return Math.min(maxScore, score);
  }

  // ============ PATTERN DETECTION ============

  private detectPatterns(metrics: MomentumMetrics): { signals: string[]; flags: string[] } {
    const signals: string[] = [];
    const flags: string[] = [];

    // Positive signals
    if (metrics.buySellRatio >= THRESHOLDS.EXCELLENT_BUY_RATIO) {
      signals.push('STRONG_BUY_PRESSURE');
    }
    if (metrics.volumeVelocity >= THRESHOLDS.EXCELLENT_VELOCITY) {
      signals.push('EXPLOSIVE_VOLUME');
    }
    if (metrics.volumeAcceleration > 0.5) {
      signals.push('ACCELERATING_MOMENTUM');
    }
    if (metrics.holderGrowthRate >= THRESHOLDS.EXCELLENT_GROWTH_RATE) {
      signals.push('RAPID_ADOPTION');
    }
    if (metrics.uniqueBuyers5m >= 20 && metrics.buySellRatio >= THRESHOLDS.MIN_BUY_RATIO) {
      signals.push('ORGANIC_BUYING_WAVE');
    }
    if (metrics.netBuyPressure > metrics.volume5m * 0.3) {
      signals.push('SIGNIFICANT_ACCUMULATION');
    }

    // Warning flags
    if (metrics.buySellRatio < THRESHOLDS.WEAK_BUY_RATIO) {
      flags.push('SELLING_PRESSURE');
    }
    if (metrics.volumeAcceleration < -0.3) {
      flags.push('DECLINING_INTEREST');
    }
    if (metrics.smallTradeRatio > THRESHOLDS.MAX_SMALL_TRADE_RATIO) {
      flags.push('BOT_ACTIVITY_SUSPECTED');
    }
    if (metrics.priceVolatility > THRESHOLDS.MAX_VOLATILITY) {
      flags.push('HIGH_VOLATILITY');
    }
    if (metrics.priceChange5m < THRESHOLDS.MIN_PRICE_SUPPORT) {
      flags.push('PRICE_DUMPING');
    }
    if (metrics.uniqueBuyers5m < THRESHOLDS.MIN_UNIQUE_BUYERS && metrics.buyCount5m > 10) {
      flags.push('LOW_BUYER_DIVERSITY');
    }
    if (metrics.holderGrowthRate < 0) {
      flags.push('LOSING_HOLDERS');
    }

    return { signals, flags };
  }

  private determineConfidence(metrics: MomentumMetrics, flags: string[]): 'HIGH' | 'MEDIUM' | 'LOW' {
    // Critical flags reduce confidence
    if (flags.includes('SELLING_PRESSURE') ||
        flags.includes('PRICE_DUMPING') ||
        flags.includes('LOSING_HOLDERS')) {
      return 'LOW';
    }

    // Multiple warning flags reduce confidence
    if (flags.length >= 3) {
      return 'LOW';
    }
    if (flags.length >= 2) {
      return 'MEDIUM';
    }

    // Low data quality reduces confidence
    if (metrics.buyCount5m + metrics.sellCount5m < 5) {
      return 'LOW';
    }
    if (metrics.volume5m < 1000) {
      return 'MEDIUM';
    }

    // Good data and no major flags = high confidence
    return 'HIGH';
  }

  /**
   * Clear the metrics cache
   */
  clearCache(): void {
    this.metricsCache.clear();
  }
}

// ============ EXPORTS ============

export const momentumAnalyzer = new MomentumAnalyzer();

export default {
  MomentumAnalyzer,
  momentumAnalyzer,
  THRESHOLDS,
};
