// ===========================================
// MACRO SIGNAL GENERATOR
// ===========================================
// Generates trading signals based on Gann analysis and live data
// Determines bias (Long/Short/Neutral) and action (Open/Close/Hold)

import { v4 as uuidv4 } from 'uuid';
import {
  MacroGannSignal,
  MacroBias,
  BiasStrength,
  MacroAction,
  MarketRegime,
  GannAnalysis,
  DerivativesMetrics,
  OrderBookMetrics,
  SentimentMetrics,
  WhaleActivityMetrics,
  TrendStrength,
  CycleSignificance,
} from '../types.js';
import { leverageCalculator } from './leverage-calculator.js';

/**
 * Macro Signal Generator
 *
 * Combines Gann analysis with live market data to generate
 * actionable trading signals with:
 * - Directional bias (Long/Short/Neutral)
 * - Position action (Open/Close/Hold/Reduce)
 * - Leverage recommendation
 */
export class MacroSignalGenerator {
  /**
   * Generate a complete macro signal
   */
  generateSignal(
    gann: GannAnalysis,
    derivatives: DerivativesMetrics,
    orderBook: OrderBookMetrics | null,
    sentiment: SentimentMetrics,
    whaleActivity: WhaleActivityMetrics,
    btcPrice: number,
    solPrice: number
  ): MacroGannSignal {
    // Calculate components
    const { bias, biasStrength } = this.calculateBias(gann, derivatives, orderBook, sentiment);
    const action = this.determineAction(bias, biasStrength, gann, derivatives, sentiment);
    const leverage = leverageCalculator.calculate(gann, derivatives, orderBook, sentiment);
    const regime = this.classifyRegime(derivatives, sentiment, gann);
    const confidence = this.calculateConfidence(gann, derivatives, sentiment, bias);
    const summary = this.generateSummary(bias, action, gann, derivatives, sentiment);

    return {
      id: uuidv4(),
      timestamp: new Date(),

      // Directional
      bias,
      biasStrength,
      action,

      // Leverage
      leverage,

      // Gann Analysis
      gann,

      // Live Metrics
      derivatives,
      orderBook: orderBook || {
        bidAskImbalance: 0,
        topBidWall: { price: 0, size: 0 },
        topAskWall: { price: 0, size: 0 },
        depth1Percent: { bids: 0, asks: 0 },
        spoofingDetected: false,
      },
      sentiment,
      whaleActivity,

      // Price data
      btcPrice,
      solPrice,
      solBtcRatio: solPrice / btcPrice,

      // Meta
      confidence,
      regime,
      summary,
      keyLevels: {
        support: gann.squareOf9Levels.support.slice(0, 3),
        resistance: gann.squareOf9Levels.resistance.slice(0, 3),
      },

      // Always informational
      isInformationalOnly: true,
    };
  }

  /**
   * Calculate directional bias
   */
  private calculateBias(
    gann: GannAnalysis,
    derivatives: DerivativesMetrics,
    orderBook: OrderBookMetrics | null,
    sentiment: SentimentMetrics
  ): { bias: MacroBias; biasStrength: BiasStrength } {
    let bullishScore = 0;
    let bearishScore = 0;

    // === GANN FACTORS ===

    // Trend angle direction
    if (gann.currentAngle.direction === 'UP') {
      bullishScore += 15;
    } else {
      bearishScore += 15;
    }

    // Angle above 1x1 = strong momentum
    if (gann.currentAngle.isAbove1x1) {
      if (gann.currentAngle.direction === 'UP') {
        bullishScore += 10;
      } else {
        bearishScore += 10;
      }
    }

    // Trend strength
    const strengthMultiplier = this.getTrendStrengthMultiplier(gann.currentAngle.trendStrength);
    if (gann.currentAngle.direction === 'UP') {
      bullishScore += 10 * strengthMultiplier;
    } else {
      bearishScore += 10 * strengthMultiplier;
    }

    // Confluence signal
    if (gann.confluence) {
      if (gann.confluence.expectedReversal === 'BULLISH') {
        bullishScore += 20;
      } else {
        bearishScore += 20;
      }
    }

    // === DERIVATIVES FACTORS ===

    // Funding rate
    if (derivatives.fundingRate < -0.01) {
      // Negative funding = shorts paying = potential squeeze
      bullishScore += 15;
    } else if (derivatives.fundingRate > 0.01) {
      // Positive funding = longs paying = potential dump
      bearishScore += 15;
    }

    // OI trend
    if (derivatives.oiChange24h > 10) {
      // Rising OI with price trend = continuation
      bullishScore += 5;
    } else if (derivatives.oiChange24h < -10) {
      // Falling OI = deleveraging
      bearishScore += 5;
    }

    // Liquidation dominance
    const liqRatio = derivatives.liquidations24h.long /
      (derivatives.liquidations24h.short || 1);
    if (liqRatio > 2) {
      // More long liquidations = bearish pressure
      bearishScore += 10;
    } else if (liqRatio < 0.5) {
      // More short liquidations = bullish pressure
      bullishScore += 10;
    }

    // === ORDER BOOK FACTORS ===

    if (orderBook) {
      if (orderBook.bidAskImbalance > 0.2) {
        bullishScore += 10;
      } else if (orderBook.bidAskImbalance < -0.2) {
        bearishScore += 10;
      }
    }

    // === SENTIMENT FACTORS ===

    // Extreme fear = contrarian bullish
    if (sentiment.fearGreedIndex <= 20) {
      bullishScore += 15;
    } else if (sentiment.fearGreedIndex <= 35) {
      bullishScore += 8;
    }

    // Extreme greed = contrarian bearish
    if (sentiment.fearGreedIndex >= 80) {
      bearishScore += 15;
    } else if (sentiment.fearGreedIndex >= 65) {
      bearishScore += 8;
    }

    // === CALCULATE FINAL BIAS ===

    const netScore = bullishScore - bearishScore;
    const totalScore = bullishScore + bearishScore;

    let bias: MacroBias;
    let biasStrength: BiasStrength;

    if (Math.abs(netScore) < 10) {
      bias = MacroBias.NEUTRAL;
      biasStrength = BiasStrength.WEAK;
    } else if (netScore > 0) {
      bias = MacroBias.LONG;
      biasStrength = this.calculateBiasStrength(netScore, totalScore);
    } else {
      bias = MacroBias.SHORT;
      biasStrength = this.calculateBiasStrength(Math.abs(netScore), totalScore);
    }

    return { bias, biasStrength };
  }

  /**
   * Get trend strength multiplier
   */
  private getTrendStrengthMultiplier(strength: TrendStrength): number {
    switch (strength) {
      case TrendStrength.VERY_STRONG:
        return 1.5;
      case TrendStrength.STRONG:
        return 1.2;
      case TrendStrength.MODERATE:
        return 1.0;
      case TrendStrength.WEAK:
        return 0.7;
      case TrendStrength.VERY_WEAK:
        return 0.5;
      default:
        return 1.0;
    }
  }

  /**
   * Calculate bias strength from scores
   */
  private calculateBiasStrength(netScore: number, totalScore: number): BiasStrength {
    const ratio = netScore / (totalScore || 1);

    if (ratio > 0.6 || netScore > 50) {
      return BiasStrength.EXTREME;
    } else if (ratio > 0.4 || netScore > 35) {
      return BiasStrength.STRONG;
    } else if (ratio > 0.2 || netScore > 20) {
      return BiasStrength.MODERATE;
    }
    return BiasStrength.WEAK;
  }

  /**
   * Determine recommended action
   */
  private determineAction(
    bias: MacroBias,
    biasStrength: BiasStrength,
    gann: GannAnalysis,
    derivatives: DerivativesMetrics,
    sentiment: SentimentMetrics
  ): MacroAction {
    // Neutral bias = flat or hold
    if (bias === MacroBias.NEUTRAL) {
      return MacroAction.FLAT;
    }

    // Check for reversal conditions
    const nearCycleCompletion = gann.activeCycles.some(
      (c) => c.barsRemaining <= 2 && c.significance === CycleSignificance.HIGH
    );

    const extremeSentiment =
      sentiment.fearGreedIndex <= 15 || sentiment.fearGreedIndex >= 85;

    const heavyLiquidations = derivatives.liquidations24h.total > 300_000_000;

    // Strong confluence = open position
    if (gann.confluence && biasStrength !== BiasStrength.WEAK) {
      return bias === MacroBias.LONG ? MacroAction.OPEN_LONG : MacroAction.OPEN_SHORT;
    }

    // Near cycle completion = consider closing
    if (nearCycleCompletion) {
      if (bias === MacroBias.LONG) {
        return MacroAction.CLOSE_SHORT;  // Close shorts, prepare for long
      } else {
        return MacroAction.CLOSE_LONG;   // Close longs, prepare for short
      }
    }

    // Extreme sentiment + strong bias = open position
    if (extremeSentiment && biasStrength === BiasStrength.STRONG) {
      return bias === MacroBias.LONG ? MacroAction.OPEN_LONG : MacroAction.OPEN_SHORT;
    }

    // Heavy liquidations = caution, reduce if against bias
    if (heavyLiquidations) {
      if (bias === MacroBias.LONG && derivatives.liquidations24h.long > derivatives.liquidations24h.short) {
        return MacroAction.REDUCE_LONG;
      }
      if (bias === MacroBias.SHORT && derivatives.liquidations24h.short > derivatives.liquidations24h.long) {
        return MacroAction.REDUCE_SHORT;
      }
    }

    // Moderate/Strong bias without special conditions = hold or add
    if (biasStrength === BiasStrength.STRONG || biasStrength === BiasStrength.EXTREME) {
      return bias === MacroBias.LONG ? MacroAction.ADD_LONG : MacroAction.ADD_SHORT;
    }

    // Default to hold
    return MacroAction.HOLD;
  }

  /**
   * Classify market regime
   */
  private classifyRegime(
    derivatives: DerivativesMetrics,
    sentiment: SentimentMetrics,
    gann: GannAnalysis
  ): MarketRegime {
    // Capitulation: extreme fear + heavy liquidations + weak angle
    if (
      sentiment.fearGreedIndex <= 20 &&
      derivatives.liquidations24h.total > 200_000_000 &&
      (gann.currentAngle.trendStrength === TrendStrength.WEAK ||
        gann.currentAngle.trendStrength === TrendStrength.VERY_WEAK)
    ) {
      return MarketRegime.CAPITULATION;
    }

    // Accumulation: fear + stabilizing metrics + potential reversal
    if (
      sentiment.fearGreedIndex <= 35 &&
      derivatives.oiChange24h > -5 &&
      gann.confluence?.expectedReversal === 'BULLISH'
    ) {
      return MarketRegime.ACCUMULATION;
    }

    // Markup: greed zone + strong uptrend
    if (
      sentiment.fearGreedIndex >= 55 &&
      gann.currentAngle.direction === 'UP' &&
      gann.currentAngle.trendStrength !== TrendStrength.WEAK &&
      gann.currentAngle.trendStrength !== TrendStrength.VERY_WEAK
    ) {
      return MarketRegime.MARKUP;
    }

    // Distribution: extreme greed + weakening momentum
    if (
      sentiment.fearGreedIndex >= 70 &&
      (gann.currentAngle.trendStrength === TrendStrength.WEAK ||
        derivatives.oiChange24h < -5)
    ) {
      return MarketRegime.DISTRIBUTION;
    }

    // Markdown: strong downtrend
    if (
      gann.currentAngle.direction === 'DOWN' &&
      gann.currentAngle.isAbove1x1 &&
      sentiment.fearGreedIndex < 50
    ) {
      return MarketRegime.MARKDOWN;
    }

    // Default to ranging
    return MarketRegime.RANGING;
  }

  /**
   * Calculate overall confidence score
   */
  private calculateConfidence(
    gann: GannAnalysis,
    derivatives: DerivativesMetrics,
    sentiment: SentimentMetrics,
    bias: MacroBias
  ): number {
    let confidence = 50;  // Base confidence

    // Confluence adds significant confidence
    if (gann.confluence) {
      confidence += gann.confluence.confidence * 0.3;
    }

    // Strong trend adds confidence
    if (gann.currentAngle.trendStrength === TrendStrength.STRONG) {
      confidence += 10;
    } else if (gann.currentAngle.trendStrength === TrendStrength.VERY_STRONG) {
      confidence += 15;
    }

    // Aligned funding rate adds confidence
    if (bias === MacroBias.LONG && derivatives.fundingRate < 0) {
      confidence += 8;
    } else if (bias === MacroBias.SHORT && derivatives.fundingRate > 0) {
      confidence += 8;
    }

    // Extreme sentiment (contrarian) adds confidence
    if (sentiment.fearGreedIndex <= 20 || sentiment.fearGreedIndex >= 80) {
      confidence += 10;
    }

    // High liquidations reduce confidence (volatile)
    if (derivatives.liquidations24h.total > 300_000_000) {
      confidence -= 10;
    }

    return Math.min(100, Math.max(0, Math.round(confidence)));
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(
    bias: MacroBias,
    action: MacroAction,
    gann: GannAnalysis,
    derivatives: DerivativesMetrics,
    sentiment: SentimentMetrics
  ): string {
    const parts: string[] = [];

    // Bias description
    if (bias === MacroBias.LONG) {
      parts.push('Bullish bias detected.');
    } else if (bias === MacroBias.SHORT) {
      parts.push('Bearish bias detected.');
    } else {
      parts.push('Market direction unclear.');
    }

    // Gann analysis
    parts.push(
      `Price at ${gann.currentAngle.closestGannAngle} angle (${gann.currentAngle.currentAngle.toFixed(1)}°).`
    );

    // Confluence
    if (gann.confluence) {
      parts.push(gann.confluence.message);
    }

    // Derivatives insight
    if (Math.abs(derivatives.fundingRate) > 0.02) {
      const direction = derivatives.fundingRate > 0 ? 'positive' : 'negative';
      parts.push(`Funding rate ${direction} (${(derivatives.fundingRate * 100).toFixed(3)}%).`);
    }

    // Sentiment
    parts.push(`Fear & Greed: ${sentiment.fearGreedIndex} (${sentiment.fearGreedClassification}).`);

    // Action recommendation
    const actionMap: Record<MacroAction, string> = {
      [MacroAction.OPEN_LONG]: 'Consider opening long position.',
      [MacroAction.OPEN_SHORT]: 'Consider opening short position.',
      [MacroAction.CLOSE_LONG]: 'Consider closing long positions.',
      [MacroAction.CLOSE_SHORT]: 'Consider closing short positions.',
      [MacroAction.ADD_LONG]: 'Can add to long position.',
      [MacroAction.ADD_SHORT]: 'Can add to short position.',
      [MacroAction.REDUCE_LONG]: 'Consider reducing long exposure.',
      [MacroAction.REDUCE_SHORT]: 'Consider reducing short exposure.',
      [MacroAction.HOLD]: 'Maintain current positions.',
      [MacroAction.FLAT]: 'Stay flat, no clear edge.',
    };
    parts.push(actionMap[action]);

    return parts.join(' ');
  }
}

// Export singleton instance
export const macroSignalGenerator = new MacroSignalGenerator();
