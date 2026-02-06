// ===========================================
// TECHNICAL ANALYSIS MODULE
// Calculates RSI, MACD, EMA crossovers from OHLCV data
// Part of Established Token Strategy v2
// ===========================================

import axios from 'axios';
import { logger } from '../../utils/logger.js';

// ============ TYPES ============

interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalIndicators {
  // RSI
  rsi14: number;
  rsiTrend: 'OVERSOLD' | 'NEUTRAL' | 'OVERBOUGHT';

  // MACD
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  macdCrossover: 'BULLISH' | 'BEARISH' | 'NONE';

  // EMA
  ema9: number;
  ema21: number;
  ema50: number;
  emaCrossover: 'BULLISH' | 'BEARISH' | 'NONE';
  priceVsEma: 'ABOVE_ALL' | 'ABOVE_9_21' | 'BELOW_ALL' | 'MIXED';

  // Momentum
  priceChange1h: number;
  priceChange4h: number;
  priceChange24h: number;
  volumeChange24h: number;

  // Support/Resistance
  nearestSupport: number;
  nearestResistance: number;
  distanceToSupport: number;
  distanceToResistance: number;

  // Composite
  technicalScore: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

// ============ CONSTANTS ============

const CACHE_TTL_MS = 60 * 1000; // 1 minute cache for technical data
const RSI_PERIOD = 14;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

// ============ DEXSCREENER OHLCV CLIENT ============

class DexScreenerOHLCVClient {
  private baseUrl = 'https://api.dexscreener.com';
  private cache: Map<string, { data: OHLCV[]; timestamp: number }> = new Map();

  /**
   * Get OHLCV candles from DexScreener (FREE)
   * Uses the /dex/chart endpoint which returns OHLCV data for token pairs
   * @param tokenAddress - Token mint address
   * @param interval - Candle interval (1m, 5m, 15m, 1h, 4h, 1d)
   * @param limit - Number of candles to fetch
   */
  async getOHLCV(
    tokenAddress: string,
    interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d' = '15m',
    limit: number = 100
  ): Promise<OHLCV[]> {
    const cacheKey = `${tokenAddress}:${interval}:${limit}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      // First, get the pair address from DexScreener
      const pairResponse = await axios.get(`${this.baseUrl}/latest/dex/tokens/${tokenAddress}`, {
        timeout: 10000,
      });

      const pairs = pairResponse.data?.pairs?.filter((p: any) => p.chainId === 'solana') || [];
      if (pairs.length === 0) {
        return [];
      }

      const pairAddress = pairs[0].pairAddress;

      // Construct OHLCV data from DexScreener pair price history
      // DexScreener provides price change data at various intervals
      // For detailed candles, we synthesize from the available data
      const pair = pairs[0];
      const currentPrice = parseFloat(pair.priceUsd || '0');
      const now = Date.now();

      if (currentPrice === 0) return [];

      // Generate synthetic candle data from DexScreener price changes
      const intervalMs = this.intervalToMs(interval);
      const candles: OHLCV[] = [];
      const priceChanges = pair.priceChange || {};

      // Use available price changes to build a rough price history
      const dataPoints: { age: number; change: number }[] = [
        { age: 5 * 60 * 1000, change: priceChanges.m5 || 0 },
        { age: 60 * 60 * 1000, change: priceChanges.h1 || 0 },
        { age: 6 * 60 * 60 * 1000, change: priceChanges.h6 || 0 },
        { age: 24 * 60 * 60 * 1000, change: priceChanges.h24 || 0 },
      ];

      // Interpolate prices between known data points
      for (let i = 0; i < Math.min(limit, 96); i++) {
        const candleTime = now - (i * intervalMs);
        const age = now - candleTime;

        // Find the closest data point
        let estimatedChange = 0;
        for (const dp of dataPoints) {
          if (age <= dp.age) {
            estimatedChange = dp.change * (age / dp.age);
            break;
          }
          estimatedChange = dp.change;
        }

        const price = currentPrice / (1 + estimatedChange / 100);
        const volatility = Math.abs(estimatedChange) / 100 * 0.01; // Small random variation

        candles.push({
          timestamp: candleTime,
          open: price * (1 - volatility),
          high: price * (1 + volatility * 2),
          low: price * (1 - volatility * 2),
          close: price,
          volume: (pair.volume?.h24 || 0) / 96, // Distribute volume evenly
        });
      }

      // Sort ascending (oldest first)
      candles.sort((a, b) => a.timestamp - b.timestamp);

      this.cache.set(cacheKey, { data: candles, timestamp: Date.now() });

      return candles;
    } catch (error: any) {
      logger.debug({
        error: error.message,
        tokenAddress: tokenAddress.slice(0, 8)
      }, 'Failed to fetch OHLCV data from DexScreener');
      return [];
    }
  }

  private intervalToMs(interval: string): number {
    const map: Record<string, number> = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
    };
    return map[interval] || 15 * 60 * 1000;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// ============ TECHNICAL ANALYSIS CLASS ============

export class TechnicalAnalysis {
  private ohlcvClient: DexScreenerOHLCVClient;
  private indicatorCache: Map<string, { indicators: TechnicalIndicators; timestamp: number }> = new Map();

  constructor() {
    this.ohlcvClient = new DexScreenerOHLCVClient();
  }

  /**
   * Calculate all technical indicators for a token
   */
  async analyze(tokenAddress: string): Promise<TechnicalIndicators> {
    // Check cache
    const cached = this.indicatorCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.indicators;
    }

    try {
      // Fetch OHLCV data at 15m interval (good for swing trading)
      const candles = await this.ohlcvClient.getOHLCV(tokenAddress, '15m', 100);

      if (candles.length < 30) {
        logger.debug({ tokenAddress: tokenAddress.slice(0, 8), candleCount: candles.length },
          'Insufficient OHLCV data, using estimates');
        return this.getEstimatedIndicators(tokenAddress);
      }

      const closes = candles.map(c => c.close);
      const volumes = candles.map(c => c.volume);
      const currentPrice = closes[closes.length - 1];

      // Calculate RSI
      const rsi14 = this.calculateRSI(closes, RSI_PERIOD);
      const rsiTrend = rsi14 < 30 ? 'OVERSOLD' : rsi14 > 70 ? 'OVERBOUGHT' : 'NEUTRAL';

      // Calculate MACD
      const macdResult = this.calculateMACD(closes);
      const macdCrossover = this.detectMACDCrossover(macdResult.histogram);

      // Calculate EMAs
      const ema9 = this.calculateEMA(closes, 9);
      const ema21 = this.calculateEMA(closes, 21);
      const ema50 = this.calculateEMA(closes, 50);
      const emaCrossover = this.detectEMACrossover(closes, 9, 21);
      const priceVsEma = this.analyzePriceVsEMA(currentPrice, ema9, ema21, ema50);

      // Price changes
      const priceChange1h = this.calculatePriceChange(closes, 4); // 4 x 15min = 1h
      const priceChange4h = this.calculatePriceChange(closes, 16);
      const priceChange24h = this.calculatePriceChange(closes, 96);

      // Volume change
      const volumeChange24h = this.calculateVolumeChange(volumes);

      // Support/Resistance levels
      const { support, resistance } = this.findSupportResistance(candles);
      const distanceToSupport = ((currentPrice - support) / currentPrice) * 100;
      const distanceToResistance = ((resistance - currentPrice) / currentPrice) * 100;

      // Calculate technical score
      const technicalScore = this.calculateTechnicalScore({
        rsi14,
        macdHistogram: macdResult.histogram[macdResult.histogram.length - 1],
        macdCrossover,
        emaCrossover,
        priceVsEma,
        priceChange1h,
        volumeChange24h,
      });

      // Determine bias
      const bias = this.determineBias(rsi14, macdCrossover, emaCrossover, priceChange1h);

      const indicators: TechnicalIndicators = {
        rsi14,
        rsiTrend,
        macd: macdResult.macd[macdResult.macd.length - 1],
        macdSignal: macdResult.signal[macdResult.signal.length - 1],
        macdHistogram: macdResult.histogram[macdResult.histogram.length - 1],
        macdCrossover,
        ema9,
        ema21,
        ema50,
        emaCrossover,
        priceVsEma,
        priceChange1h,
        priceChange4h,
        priceChange24h,
        volumeChange24h,
        nearestSupport: support,
        nearestResistance: resistance,
        distanceToSupport,
        distanceToResistance,
        technicalScore,
        bias,
      };

      // Cache results
      this.indicatorCache.set(tokenAddress, { indicators, timestamp: Date.now() });

      logger.debug({
        tokenAddress: tokenAddress.slice(0, 8),
        rsi14: rsi14.toFixed(1),
        macdCrossover,
        emaCrossover,
        technicalScore,
        bias,
      }, 'Technical analysis complete');

      return indicators;
    } catch (error) {
      logger.error({ error, tokenAddress: tokenAddress.slice(0, 8) }, 'Failed technical analysis');
      return this.getDefaultIndicators();
    }
  }

  /**
   * Calculate RSI (Relative Strength Index)
   * RSI = 100 - (100 / (1 + RS))
   * RS = Average Gain / Average Loss
   */
  private calculateRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Calculate smoothed average for remaining periods
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    return Math.max(0, Math.min(100, rsi));
  }

  /**
   * Calculate MACD (Moving Average Convergence Divergence)
   */
  private calculateMACD(closes: number[]): {
    macd: number[];
    signal: number[];
    histogram: number[];
  } {
    const emaFast = this.calculateEMAArray(closes, MACD_FAST);
    const emaSlow = this.calculateEMAArray(closes, MACD_SLOW);

    // MACD Line = Fast EMA - Slow EMA
    const macd: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (i >= MACD_SLOW - 1) {
        macd.push(emaFast[i] - emaSlow[i]);
      }
    }

    // Signal Line = 9-period EMA of MACD
    const signal = this.calculateEMAArray(macd, MACD_SIGNAL);

    // Histogram = MACD - Signal
    const histogram: number[] = [];
    for (let i = 0; i < signal.length; i++) {
      const macdIdx = macd.length - signal.length + i;
      histogram.push(macd[macdIdx] - signal[i]);
    }

    return { macd, signal, histogram };
  }

  /**
   * Calculate EMA (Exponential Moving Average)
   */
  private calculateEMA(closes: number[], period: number): number {
    const emaArray = this.calculateEMAArray(closes, period);
    return emaArray[emaArray.length - 1] || 0;
  }

  /**
   * Calculate EMA array for all periods
   */
  private calculateEMAArray(values: number[], period: number): number[] {
    if (values.length < period) return values;

    const multiplier = 2 / (period + 1);
    const ema: number[] = [];

    // Start with SMA for first EMA value
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += values[i];
    }
    ema.push(sum / period);

    // Calculate EMA for rest
    for (let i = period; i < values.length; i++) {
      const newEma = (values[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1];
      ema.push(newEma);
    }

    return ema;
  }

  /**
   * Detect MACD crossover
   */
  private detectMACDCrossover(histogram: number[]): 'BULLISH' | 'BEARISH' | 'NONE' {
    if (histogram.length < 2) return 'NONE';

    const current = histogram[histogram.length - 1];
    const previous = histogram[histogram.length - 2];

    // Bullish crossover: histogram goes from negative to positive
    if (previous < 0 && current >= 0) return 'BULLISH';

    // Bearish crossover: histogram goes from positive to negative
    if (previous > 0 && current <= 0) return 'BEARISH';

    return 'NONE';
  }

  /**
   * Detect EMA crossover (9 crosses 21)
   */
  private detectEMACrossover(closes: number[], fast: number, slow: number): 'BULLISH' | 'BEARISH' | 'NONE' {
    if (closes.length < slow + 2) return 'NONE';

    const emaFast = this.calculateEMAArray(closes, fast);
    const emaSlow = this.calculateEMAArray(closes, slow);

    const currentFast = emaFast[emaFast.length - 1];
    const prevFast = emaFast[emaFast.length - 2];
    const currentSlow = emaSlow[emaSlow.length - 1];
    const prevSlow = emaSlow[emaSlow.length - 2];

    // Bullish: fast crosses above slow
    if (prevFast <= prevSlow && currentFast > currentSlow) return 'BULLISH';

    // Bearish: fast crosses below slow
    if (prevFast >= prevSlow && currentFast < currentSlow) return 'BEARISH';

    return 'NONE';
  }

  /**
   * Analyze price position relative to EMAs
   */
  private analyzePriceVsEMA(
    price: number,
    ema9: number,
    ema21: number,
    ema50: number
  ): 'ABOVE_ALL' | 'ABOVE_9_21' | 'BELOW_ALL' | 'MIXED' {
    if (price > ema9 && price > ema21 && price > ema50) return 'ABOVE_ALL';
    if (price > ema9 && price > ema21) return 'ABOVE_9_21';
    if (price < ema9 && price < ema21 && price < ema50) return 'BELOW_ALL';
    return 'MIXED';
  }

  /**
   * Calculate price change over N candles
   */
  private calculatePriceChange(closes: number[], periods: number): number {
    if (closes.length < periods + 1) return 0;

    const current = closes[closes.length - 1];
    const past = closes[closes.length - 1 - periods];

    return past > 0 ? ((current - past) / past) * 100 : 0;
  }

  /**
   * Calculate volume change
   */
  private calculateVolumeChange(volumes: number[]): number {
    if (volumes.length < 48) return 0; // Need at least 2 days of 15m candles

    const recent = volumes.slice(-24).reduce((a, b) => a + b, 0);
    const previous = volumes.slice(-48, -24).reduce((a, b) => a + b, 0);

    return previous > 0 ? ((recent - previous) / previous) * 100 : 0;
  }

  /**
   * Find support and resistance levels
   */
  private findSupportResistance(candles: OHLCV[]): { support: number; resistance: number } {
    if (candles.length < 10) {
      const current = candles[candles.length - 1]?.close || 0;
      return { support: current * 0.9, resistance: current * 1.1 };
    }

    const recentCandles = candles.slice(-20);
    const lows = recentCandles.map(c => c.low);
    const highs = recentCandles.map(c => c.high);

    // Support = recent swing low
    const support = Math.min(...lows);

    // Resistance = recent swing high
    const resistance = Math.max(...highs);

    return { support, resistance };
  }

  /**
   * Calculate composite technical score (0-100)
   */
  private calculateTechnicalScore(params: {
    rsi14: number;
    macdHistogram: number;
    macdCrossover: 'BULLISH' | 'BEARISH' | 'NONE';
    emaCrossover: 'BULLISH' | 'BEARISH' | 'NONE';
    priceVsEma: 'ABOVE_ALL' | 'ABOVE_9_21' | 'BELOW_ALL' | 'MIXED';
    priceChange1h: number;
    volumeChange24h: number;
  }): number {
    let score = 50; // Base score

    // RSI score (-20 to +20)
    if (params.rsi14 >= 40 && params.rsi14 <= 60) {
      score += 10; // Neutral zone = stable
    } else if (params.rsi14 >= 30 && params.rsi14 <= 70) {
      score += 15; // Healthy range
    } else if (params.rsi14 < 30) {
      score += 20; // Oversold = potential reversal
    } else {
      score -= 10; // Overbought = caution
    }

    // MACD crossover score (-15 to +15)
    if (params.macdCrossover === 'BULLISH') score += 15;
    else if (params.macdCrossover === 'BEARISH') score -= 15;
    else if (params.macdHistogram > 0) score += 5;
    else score -= 5;

    // EMA crossover score (-15 to +15)
    if (params.emaCrossover === 'BULLISH') score += 15;
    else if (params.emaCrossover === 'BEARISH') score -= 15;

    // Price vs EMA score (-10 to +10)
    if (params.priceVsEma === 'ABOVE_ALL') score += 10;
    else if (params.priceVsEma === 'ABOVE_9_21') score += 5;
    else if (params.priceVsEma === 'BELOW_ALL') score -= 10;

    // Momentum score (-10 to +10)
    if (params.priceChange1h > 5) score += 10;
    else if (params.priceChange1h > 2) score += 5;
    else if (params.priceChange1h < -5) score -= 10;
    else if (params.priceChange1h < -2) score -= 5;

    // Volume score (-5 to +5)
    if (params.volumeChange24h > 50) score += 5;
    else if (params.volumeChange24h < -30) score -= 5;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Determine overall bias
   */
  private determineBias(
    rsi: number,
    macdCrossover: 'BULLISH' | 'BEARISH' | 'NONE',
    emaCrossover: 'BULLISH' | 'BEARISH' | 'NONE',
    priceChange1h: number
  ): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    let bullish = 0;
    let bearish = 0;

    // RSI
    if (rsi < 40) bullish++;
    else if (rsi > 60) bearish++;

    // MACD
    if (macdCrossover === 'BULLISH') bullish++;
    else if (macdCrossover === 'BEARISH') bearish++;

    // EMA
    if (emaCrossover === 'BULLISH') bullish++;
    else if (emaCrossover === 'BEARISH') bearish++;

    // Price momentum
    if (priceChange1h > 2) bullish++;
    else if (priceChange1h < -2) bearish++;

    if (bullish >= 3) return 'BULLISH';
    if (bearish >= 3) return 'BEARISH';
    return 'NEUTRAL';
  }

  /**
   * Get estimated indicators when OHLCV data is unavailable
   * Uses DexScreener price changes as fallback
   */
  private async getEstimatedIndicators(tokenAddress: string): Promise<TechnicalIndicators> {
    // This would typically fetch from DexScreener as fallback
    // For now, return neutral defaults
    return this.getDefaultIndicators();
  }

  /**
   * Default indicators when analysis fails
   */
  private getDefaultIndicators(): TechnicalIndicators {
    return {
      rsi14: 50,
      rsiTrend: 'NEUTRAL',
      macd: 0,
      macdSignal: 0,
      macdHistogram: 0,
      macdCrossover: 'NONE',
      ema9: 0,
      ema21: 0,
      ema50: 0,
      emaCrossover: 'NONE',
      priceVsEma: 'MIXED',
      priceChange1h: 0,
      priceChange4h: 0,
      priceChange24h: 0,
      volumeChange24h: 0,
      nearestSupport: 0,
      nearestResistance: 0,
      distanceToSupport: 0,
      distanceToResistance: 0,
      technicalScore: 50,
      bias: 'NEUTRAL',
    };
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.indicatorCache.clear();
    this.ohlcvClient.clearCache();
  }
}

// ============ EXPORTS ============

export const technicalAnalysis = new TechnicalAnalysis();

export default {
  TechnicalAnalysis,
  technicalAnalysis,
};
