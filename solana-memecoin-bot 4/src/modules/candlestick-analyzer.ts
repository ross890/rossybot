// ===========================================
// MODULE: CANDLESTICK ANALYZER
// Builds OHLCV candles from DexScreener trade data and detects
// chart patterns relevant to memecoin trading (1m & 5m timeframes).
//
// Designed to fill the structural gap in the scoring pipeline:
// momentum-analyzer detects *activity* (volume, buy pressure),
// candlestick-analyzer reads *price structure* (support, rejection,
// trend context) to improve entry timing and reduce false positives.
// ===========================================

import { logger } from '../utils/logger.js';
import { dexScreenerClient } from './onchain.js';

// ============ TYPES ============

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;       // ms since epoch (start of candle)
}

export interface CandlePattern {
  name: string;
  type: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: number;        // 0-100
  description: string;
}

export interface CandlestickAnalysis {
  // Candle data used
  timeframe: '1m' | '5m';
  candleCount: number;

  // Pattern detection
  patterns: CandlePattern[];
  dominantSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL';

  // Structure metrics
  bodyToWickRatio: number;     // High = strong conviction candles
  upperWickAvg: number;        // High = selling pressure / rejection
  lowerWickAvg: number;        // High = buying support / absorption
  trendDirection: 'UP' | 'DOWN' | 'SIDEWAYS';
  trendStrength: number;       // 0-100

  // Support/resistance
  nearestSupport: number | null;   // Price level
  nearestResistance: number | null;
  distanceToSupport: number;       // % from current price
  distanceToResistance: number;

  // Composite score
  score: number;                   // -50 to +50 (bearish to bullish)
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

// ============ CONSTANTS ============

// Candle body thresholds (as fraction of candle range)
const DOJI_BODY_RATIO = 0.10;       // Body < 10% of range = doji
const STRONG_BODY_RATIO = 0.70;     // Body > 70% of range = strong conviction
const HAMMER_WICK_RATIO = 2.0;      // Lower wick >= 2x body = hammer
const SHOOTING_STAR_WICK_RATIO = 2.0; // Upper wick >= 2x body = shooting star

// Trend detection
const TREND_LOOKBACK = 5;           // Candles to determine trend
const TREND_THRESHOLD = 0.02;       // 2% move = trend

// Support/resistance detection
const SR_LOOKBACK = 10;             // Candles to scan for S/R
const SR_TOUCH_THRESHOLD = 0.015;   // 1.5% proximity = "touch"

// ============ CANDLE BUILDER ============

/**
 * Build OHLCV candles from DexScreener pair data.
 * DexScreener provides aggregated data (priceChange, volume) per timeframe,
 * not raw trades, so we construct approximate candles from available fields.
 */
function buildCandlesFromPairData(pair: any): { candles1m: Candle[]; candles5m: Candle[] } {
  const now = Date.now();
  const currentPrice = parseFloat(pair.priceUsd || '0');
  if (currentPrice <= 0) return { candles1m: [], candles5m: [] };

  // DexScreener gives us priceChange percentages for m5, h1, h6, h24
  // and volume for m5, h1, h6, h24. We reconstruct approximate candles.

  const priceChange5m = (pair.priceChange?.m5 || 0) / 100;
  const priceChange1h = (pair.priceChange?.h1 || 0) / 100;
  const priceChange6h = (pair.priceChange?.h6 || 0) / 100;

  const vol5m = pair.volume?.m5 || 0;
  const vol1h = pair.volume?.h1 || 0;
  const vol6h = pair.volume?.h6 || 0;

  // Txn counts for buy/sell pressure per timeframe
  const buys5m = pair.txns?.m5?.buys || 0;
  const sells5m = pair.txns?.m5?.sells || 0;
  const buys1h = pair.txns?.h1?.buys || 0;
  const sells1h = pair.txns?.h1?.sells || 0;

  // Reconstruct price at various points in time
  const price5mAgo = currentPrice / (1 + priceChange5m);
  const price1hAgo = currentPrice / (1 + priceChange1h);
  const price6hAgo = currentPrice / (1 + priceChange6h);

  // ---- Build 5-minute candles (up to 12 from the last hour) ----
  const candles5m: Candle[] = [];
  const avgVol5m = vol1h / 12;
  const numCandles = Math.min(12, Math.max(1, Math.ceil(vol1h / Math.max(1, avgVol5m))));

  // Interpolate prices linearly between 1h ago and now, adding noise from volume distribution
  for (let i = 0; i < numCandles; i++) {
    const t = i / numCandles; // 0 = 1h ago, 1 = now
    const tNext = (i + 1) / numCandles;
    const interpPrice = price1hAgo + (currentPrice - price1hAgo) * t;
    const interpPriceNext = price1hAgo + (currentPrice - price1hAgo) * tNext;

    // Add volatility based on volume concentration
    // Higher volume periods get wider candle ranges
    const volWeight = i === numCandles - 1 ? vol5m / Math.max(1, avgVol5m) : 1;
    const range = Math.abs(interpPriceNext - interpPrice) * Math.max(0.5, volWeight);

    const open = interpPrice;
    const close = interpPriceNext;
    const bullish = close >= open;

    // Construct high/low with wicks proportional to buy/sell pressure
    const buyPressure = buys1h > 0 ? buys1h / (buys1h + sells1h) : 0.5;
    const wickExtension = range * 0.3; // Wicks extend 30% beyond body
    const high = Math.max(open, close) + wickExtension * (bullish ? 0.5 : 1.0);
    const low = Math.min(open, close) - wickExtension * (bullish ? 1.0 : 0.5);

    candles5m.push({
      open,
      high: Math.max(high, Math.max(open, close)),
      low: Math.min(low, Math.min(open, close)),
      close,
      volume: avgVol5m * volWeight,
      timestamp: now - (numCandles - i) * 5 * 60 * 1000,
    });
  }

  // ---- Build 1-minute candles (last 5 from the most recent 5m period) ----
  const candles1m: Candle[] = [];
  const avgVol1m = vol5m / 5;

  for (let i = 0; i < 5; i++) {
    const t = i / 5;
    const tNext = (i + 1) / 5;
    const interpPrice = price5mAgo + (currentPrice - price5mAgo) * t;
    const interpPriceNext = price5mAgo + (currentPrice - price5mAgo) * tNext;

    const open = interpPrice;
    const close = interpPriceNext;
    const bullish = close >= open;
    const range = Math.abs(close - open);

    const buyPressure5m = (buys5m + sells5m) > 0 ? buys5m / (buys5m + sells5m) : 0.5;
    const wickExtension = range * 0.25;
    const high = Math.max(open, close) + wickExtension * (bullish ? 0.4 : 0.8);
    const low = Math.min(open, close) - wickExtension * (bullish ? 0.8 : 0.4);

    candles1m.push({
      open,
      high: Math.max(high, Math.max(open, close)),
      low: Math.min(low, Math.min(open, close)),
      close,
      volume: avgVol1m,
      timestamp: now - (5 - i) * 60 * 1000,
    });
  }

  return { candles1m, candles5m };
}

// ============ PATTERN DETECTION ============

function getCandleMetrics(candle: Candle) {
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const bullish = candle.close >= candle.open;
  const bodyRatio = range > 0 ? body / range : 0;

  return { range, body, upperWick, lowerWick, bullish, bodyRatio };
}

function detectSingleCandlePatterns(candles: Candle[]): CandlePattern[] {
  if (candles.length === 0) return [];
  const patterns: CandlePattern[] = [];
  const latest = candles[candles.length - 1];
  const m = getCandleMetrics(latest);

  // Determine prior trend for context
  const priorTrend = candles.length >= 3 ? getTrendDirection(candles.slice(-4, -1)) : 'SIDEWAYS';

  // --- DOJI: Indecision ---
  if (m.bodyRatio < DOJI_BODY_RATIO && m.range > 0) {
    patterns.push({
      name: 'DOJI',
      type: 'NEUTRAL',
      strength: 40,
      description: 'Indecision — trend reversal possible',
    });
  }

  // --- HAMMER: Bullish reversal (long lower wick, small body, after downtrend) ---
  if (m.body > 0 && m.lowerWick >= m.body * HAMMER_WICK_RATIO &&
      m.upperWick < m.body * 0.5 && priorTrend === 'DOWN') {
    patterns.push({
      name: 'HAMMER',
      type: 'BULLISH',
      strength: 70,
      description: 'Hammer after downtrend — buyers absorbing sell pressure',
    });
  }

  // --- INVERTED HAMMER: Potential bullish reversal after downtrend ---
  if (m.body > 0 && m.upperWick >= m.body * HAMMER_WICK_RATIO &&
      m.lowerWick < m.body * 0.5 && priorTrend === 'DOWN') {
    patterns.push({
      name: 'INVERTED_HAMMER',
      type: 'BULLISH',
      strength: 55,
      description: 'Inverted hammer after downtrend — potential reversal',
    });
  }

  // --- SHOOTING STAR: Bearish reversal (long upper wick, small body, after uptrend) ---
  if (m.body > 0 && m.upperWick >= m.body * SHOOTING_STAR_WICK_RATIO &&
      m.lowerWick < m.body * 0.5 && priorTrend === 'UP') {
    patterns.push({
      name: 'SHOOTING_STAR',
      type: 'BEARISH',
      strength: 70,
      description: 'Shooting star after uptrend — sellers rejecting higher prices',
    });
  }

  // --- STRONG BULLISH: Large green body, minimal wicks ---
  if (m.bullish && m.bodyRatio >= STRONG_BODY_RATIO && m.range > 0) {
    patterns.push({
      name: 'STRONG_BULLISH',
      type: 'BULLISH',
      strength: 65,
      description: 'Strong bullish candle — buying conviction',
    });
  }

  // --- STRONG BEARISH: Large red body, minimal wicks ---
  if (!m.bullish && m.bodyRatio >= STRONG_BODY_RATIO && m.range > 0) {
    patterns.push({
      name: 'STRONG_BEARISH',
      type: 'BEARISH',
      strength: 65,
      description: 'Strong bearish candle — selling conviction',
    });
  }

  return patterns;
}

function detectMultiCandlePatterns(candles: Candle[]): CandlePattern[] {
  if (candles.length < 2) return [];
  const patterns: CandlePattern[] = [];

  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  const pm = getCandleMetrics(prev);
  const cm = getCandleMetrics(curr);

  // --- BULLISH ENGULFING: Current green candle fully engulfs previous red ---
  if (!pm.bullish && cm.bullish &&
      curr.open <= prev.close && curr.close >= prev.open &&
      cm.body > pm.body * 1.1) {
    patterns.push({
      name: 'BULLISH_ENGULFING',
      type: 'BULLISH',
      strength: 80,
      description: 'Bullish engulfing — strong reversal signal',
    });
  }

  // --- BEARISH ENGULFING: Current red candle fully engulfs previous green ---
  if (pm.bullish && !cm.bullish &&
      curr.open >= prev.close && curr.close <= prev.open &&
      cm.body > pm.body * 1.1) {
    patterns.push({
      name: 'BEARISH_ENGULFING',
      type: 'BEARISH',
      strength: 80,
      description: 'Bearish engulfing — strong reversal signal, distribution likely',
    });
  }

  // --- MORNING STAR (3-candle): bearish → doji/small → bullish ---
  if (candles.length >= 3) {
    const prevPrev = candles[candles.length - 3];
    const ppm = getCandleMetrics(prevPrev);

    if (!ppm.bullish && pm.bodyRatio < 0.3 && cm.bullish &&
        cm.body > ppm.body * 0.5) {
      patterns.push({
        name: 'MORNING_STAR',
        type: 'BULLISH',
        strength: 75,
        description: 'Morning star — strong bottom reversal pattern',
      });
    }

    // --- EVENING STAR (3-candle): bullish → doji/small → bearish ---
    if (ppm.bullish && pm.bodyRatio < 0.3 && !cm.bullish &&
        cm.body > ppm.body * 0.5) {
      patterns.push({
        name: 'EVENING_STAR',
        type: 'BEARISH',
        strength: 75,
        description: 'Evening star — strong top reversal pattern',
      });
    }
  }

  // --- THREE WHITE SOLDIERS: 3 consecutive bullish candles with higher closes ---
  if (candles.length >= 3) {
    const c1 = candles[candles.length - 3];
    const c2 = candles[candles.length - 2];
    const c3 = candles[candles.length - 1];
    const m1 = getCandleMetrics(c1);
    const m2 = getCandleMetrics(c2);
    const m3 = getCandleMetrics(c3);

    if (m1.bullish && m2.bullish && m3.bullish &&
        c2.close > c1.close && c3.close > c2.close &&
        m1.bodyRatio > 0.4 && m2.bodyRatio > 0.4 && m3.bodyRatio > 0.4) {
      patterns.push({
        name: 'THREE_WHITE_SOLDIERS',
        type: 'BULLISH',
        strength: 85,
        description: 'Three white soldiers — strong sustained buying pressure',
      });
    }

    // --- THREE BLACK CROWS: 3 consecutive bearish candles with lower closes ---
    if (!m1.bullish && !m2.bullish && !m3.bullish &&
        c2.close < c1.close && c3.close < c2.close &&
        m1.bodyRatio > 0.4 && m2.bodyRatio > 0.4 && m3.bodyRatio > 0.4) {
      patterns.push({
        name: 'THREE_BLACK_CROWS',
        type: 'BEARISH',
        strength: 85,
        description: 'Three black crows — strong sustained selling pressure',
      });
    }
  }

  return patterns;
}

// ============ STRUCTURE ANALYSIS ============

function getTrendDirection(candles: Candle[]): 'UP' | 'DOWN' | 'SIDEWAYS' {
  if (candles.length < 2) return 'SIDEWAYS';

  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  const change = (last - first) / first;

  if (change > TREND_THRESHOLD) return 'UP';
  if (change < -TREND_THRESHOLD) return 'DOWN';
  return 'SIDEWAYS';
}

function calculateTrendStrength(candles: Candle[]): number {
  if (candles.length < 2) return 0;

  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  const totalChange = Math.abs((last - first) / first);

  // Count candles moving in the trend direction
  const trendUp = last > first;
  let aligned = 0;
  for (let i = 1; i < candles.length; i++) {
    if (trendUp && candles[i].close > candles[i - 1].close) aligned++;
    if (!trendUp && candles[i].close < candles[i - 1].close) aligned++;
  }

  const consistency = aligned / (candles.length - 1);

  // Trend strength = magnitude * consistency
  return Math.min(100, Math.round(totalChange * 500 * consistency));
}

function findSupportResistance(candles: Candle[], currentPrice: number): {
  nearestSupport: number | null;
  nearestResistance: number | null;
  distanceToSupport: number;
  distanceToResistance: number;
} {
  if (candles.length < 3) {
    return { nearestSupport: null, nearestResistance: null, distanceToSupport: 0, distanceToResistance: 0 };
  }

  // Collect swing lows (support) and swing highs (resistance)
  const supports: number[] = [];
  const resistances: number[] = [];

  for (let i = 1; i < candles.length - 1; i++) {
    // Swing low: low is lower than neighbors
    if (candles[i].low <= candles[i - 1].low && candles[i].low <= candles[i + 1].low) {
      supports.push(candles[i].low);
    }
    // Swing high: high is higher than neighbors
    if (candles[i].high >= candles[i - 1].high && candles[i].high >= candles[i + 1].high) {
      resistances.push(candles[i].high);
    }
  }

  // Find nearest support below current price
  const validSupports = supports.filter(s => s < currentPrice);
  const nearestSupport = validSupports.length > 0
    ? Math.max(...validSupports) : null;

  // Find nearest resistance above current price
  const validResistances = resistances.filter(r => r > currentPrice);
  const nearestResistance = validResistances.length > 0
    ? Math.min(...validResistances) : null;

  const distanceToSupport = nearestSupport
    ? (currentPrice - nearestSupport) / currentPrice : 0;
  const distanceToResistance = nearestResistance
    ? (nearestResistance - currentPrice) / currentPrice : 0;

  return { nearestSupport, nearestResistance, distanceToSupport, distanceToResistance };
}

// ============ COMPOSITE SCORING ============

function calculateCandlestickScore(
  patterns: CandlePattern[],
  trendDirection: 'UP' | 'DOWN' | 'SIDEWAYS',
  trendStrength: number,
  lowerWickAvg: number,
  upperWickAvg: number,
  distanceToSupport: number,
  distanceToResistance: number,
): number {
  let score = 0;

  // Pattern signals (-25 to +25)
  for (const pattern of patterns) {
    const weight = pattern.strength / 100;
    if (pattern.type === 'BULLISH') {
      score += weight * 15;
    } else if (pattern.type === 'BEARISH') {
      score -= weight * 15;
    }
  }
  score = Math.max(-25, Math.min(25, score));

  // Trend context (-15 to +15)
  const trendWeight = trendStrength / 100;
  if (trendDirection === 'UP') {
    score += trendWeight * 15;
  } else if (trendDirection === 'DOWN') {
    score -= trendWeight * 15;
  }

  // Wick analysis (-5 to +5)
  // More lower wicks = buying support = bullish
  // More upper wicks = selling rejection = bearish
  const wickBias = lowerWickAvg - upperWickAvg;
  score += Math.max(-5, Math.min(5, wickBias * 50));

  // S/R positioning (-5 to +5)
  // Near support = bullish (bounce potential)
  // Near resistance = bearish (rejection potential)
  if (distanceToSupport > 0 && distanceToSupport < 0.05) {
    score += 3; // Close to support — bounce opportunity
  }
  if (distanceToResistance > 0 && distanceToResistance < 0.03) {
    score -= 3; // Close to resistance — rejection risk
  }

  return Math.max(-50, Math.min(50, Math.round(score)));
}

// ============ MAIN ANALYZER CLASS ============

export class CandlestickAnalyzer {
  private analysisCache: Map<string, { analysis: CandlestickAnalysis; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 20 * 1000; // 20 seconds — aligned with scan interval

  /**
   * Analyze candlestick patterns for a token.
   * Returns a CandlestickAnalysis with pattern detection, trend context,
   * support/resistance levels, and a composite score (-50 to +50).
   */
  async analyze(tokenAddress: string, preferredTimeframe: '1m' | '5m' = '5m'): Promise<CandlestickAnalysis | null> {
    try {
      // Check cache
      const cacheKey = `${tokenAddress}:${preferredTimeframe}`;
      const cached = this.analysisCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        return cached.analysis;
      }

      // Fetch pair data from DexScreener
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs.length === 0) return null;

      const pair = pairs[0] as any;
      const currentPrice = parseFloat(pair.priceUsd || '0');
      if (currentPrice <= 0) return null;

      // Build candles
      const { candles1m, candles5m } = buildCandlesFromPairData(pair);
      const candles = preferredTimeframe === '1m' ? candles1m : candles5m;

      if (candles.length < 2) return null;

      // Detect patterns
      const singlePatterns = detectSingleCandlePatterns(candles);
      const multiPatterns = detectMultiCandlePatterns(candles);
      const allPatterns = [...singlePatterns, ...multiPatterns];

      // Analyze structure
      const trendCandles = candles.slice(-Math.min(TREND_LOOKBACK, candles.length));
      const trendDirection = getTrendDirection(trendCandles);
      const trendStrength = calculateTrendStrength(trendCandles);

      // Calculate average wick ratios
      let totalUpperWick = 0;
      let totalLowerWick = 0;
      let totalRange = 0;
      for (const c of candles) {
        const m = getCandleMetrics(c);
        totalUpperWick += m.upperWick;
        totalLowerWick += m.lowerWick;
        totalRange += m.range;
      }
      const avgRange = totalRange / candles.length || 1;
      const upperWickAvg = totalUpperWick / candles.length / avgRange;
      const lowerWickAvg = totalLowerWick / candles.length / avgRange;

      // Body-to-wick ratio (avg across candles)
      let totalBody = 0;
      let totalWick = 0;
      for (const c of candles) {
        const m = getCandleMetrics(c);
        totalBody += m.body;
        totalWick += m.upperWick + m.lowerWick;
      }
      const bodyToWickRatio = totalWick > 0 ? totalBody / totalWick : 1;

      // Support/resistance
      const srCandles = candles.slice(-Math.min(SR_LOOKBACK, candles.length));
      const sr = findSupportResistance(srCandles, currentPrice);

      // Dominant signal
      let bullishCount = 0;
      let bearishCount = 0;
      for (const p of allPatterns) {
        if (p.type === 'BULLISH') bullishCount++;
        if (p.type === 'BEARISH') bearishCount++;
      }
      const dominantSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
        bullishCount > bearishCount ? 'BULLISH' :
        bearishCount > bullishCount ? 'BEARISH' : 'NEUTRAL';

      // Composite score
      const score = calculateCandlestickScore(
        allPatterns, trendDirection, trendStrength,
        lowerWickAvg, upperWickAvg,
        sr.distanceToSupport, sr.distanceToResistance,
      );

      // Confidence based on data quality
      const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
        candles.length >= 8 && allPatterns.length > 0 ? 'HIGH' :
        candles.length >= 4 ? 'MEDIUM' : 'LOW';

      const analysis: CandlestickAnalysis = {
        timeframe: preferredTimeframe,
        candleCount: candles.length,
        patterns: allPatterns,
        dominantSignal,
        bodyToWickRatio,
        upperWickAvg,
        lowerWickAvg,
        trendDirection,
        trendStrength,
        nearestSupport: sr.nearestSupport,
        nearestResistance: sr.nearestResistance,
        distanceToSupport: sr.distanceToSupport,
        distanceToResistance: sr.distanceToResistance,
        score,
        confidence,
      };

      // Cache result
      this.analysisCache.set(cacheKey, { analysis, timestamp: Date.now() });

      // Evict old cache entries
      if (this.analysisCache.size > 500) {
        const now = Date.now();
        for (const [key, val] of this.analysisCache) {
          if (now - val.timestamp > this.CACHE_TTL_MS * 3) {
            this.analysisCache.delete(key);
          }
        }
      }

      logger.debug({
        tokenAddress: tokenAddress.slice(0, 8),
        timeframe: preferredTimeframe,
        patterns: allPatterns.map(p => p.name),
        score,
        trend: `${trendDirection} (${trendStrength})`,
        dominantSignal,
      }, 'Candlestick analysis complete');

      return analysis;
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Candlestick analysis failed');
      return null;
    }
  }

  /**
   * Quick check: is the candlestick structure favorable for entry?
   * Returns true if score >= 0 (neutral or bullish).
   * Designed for use as a soft gate in the signal pipeline.
   */
  async isFavorableEntry(tokenAddress: string): Promise<{ favorable: boolean; score: number; reason: string }> {
    const analysis = await this.analyze(tokenAddress, '5m');

    if (!analysis) {
      return { favorable: true, score: 0, reason: 'No candle data — neutral' };
    }

    if (analysis.score >= 10) {
      return { favorable: true, score: analysis.score, reason: `Bullish structure: ${analysis.dominantSignal} trend` };
    }

    if (analysis.score >= 0) {
      return { favorable: true, score: analysis.score, reason: 'Neutral structure — no bearish signals' };
    }

    if (analysis.score >= -15) {
      return { favorable: true, score: analysis.score, reason: 'Mildly bearish — proceed with caution' };
    }

    // Only unfavorable when strongly bearish
    const bearishPatterns = analysis.patterns.filter(p => p.type === 'BEARISH').map(p => p.name);
    return {
      favorable: false,
      score: analysis.score,
      reason: `Bearish structure: ${bearishPatterns.join(', ') || analysis.trendDirection} trend`,
    };
  }
}

// ============ EXPORTS ============

export const candlestickAnalyzer = new CandlestickAnalyzer();

export default {
  CandlestickAnalyzer,
  candlestickAnalyzer,
};
