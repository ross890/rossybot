// ===========================================
// LEVERAGE CALCULATOR
// ===========================================
// Calculates recommended leverage based on market conditions
// Uses Gann analysis + live data to determine safe leverage levels

import {
  LeverageRecommendation,
  GannAnalysis,
  DerivativesMetrics,
  OrderBookMetrics,
  SentimentMetrics,
  CycleSignificance,
  TrendStrength,
} from '../types.js';

/**
 * Leverage Calculator
 *
 * Determines safe leverage levels based on:
 * - Gann analysis (confluence, trend strength, cycle proximity)
 * - On-chain metrics (funding, OI, liquidations)
 * - Order book conditions (imbalance, depth)
 * - Market sentiment (fear & greed)
 */
export class LeverageCalculator {
  /**
   * Calculate leverage recommendation
   */
  calculate(
    gann: GannAnalysis,
    derivatives: DerivativesMetrics,
    orderBook: OrderBookMetrics | null,
    sentiment: SentimentMetrics
  ): LeverageRecommendation {
    let baseLeverage = 1;
    let maxLeverage = 2;
    const reasons: string[] = [];

    // === GANN FACTORS ===

    // Confluence present = higher confidence, can use more leverage
    if (gann.confluence) {
      baseLeverage += 1;
      maxLeverage += 2;
      reasons.push('Gann price/time confluence detected');
    }

    // Strong trend angle = can ride momentum
    if (gann.currentAngle.trendStrength === TrendStrength.STRONG ||
        gann.currentAngle.trendStrength === TrendStrength.VERY_STRONG) {
      baseLeverage += 0.5;
      reasons.push(`Strong ${gann.currentAngle.closestGannAngle} trend angle`);
    }

    // Weak trend = reduce leverage
    if (gann.currentAngle.trendStrength === TrendStrength.WEAK ||
        gann.currentAngle.trendStrength === TrendStrength.VERY_WEAK) {
      maxLeverage = Math.min(maxLeverage, 2);
      reasons.push('Weak trend angle - reducing max leverage');
    }

    // Near cycle completion = reduce leverage (reversal risk)
    const imminentHighCycle = gann.activeCycles.find(
      (c) => c.barsRemaining <= 3 && c.significance === CycleSignificance.HIGH
    );
    if (imminentHighCycle) {
      maxLeverage = Math.min(maxLeverage, 2);
      reasons.push(`Cycle ${imminentHighCycle.cycleLength} completing in ${imminentHighCycle.barsRemaining} bars`);
    }

    // === ON-CHAIN FACTORS ===

    // Funding rate extremes = reversal risk
    if (Math.abs(derivatives.fundingRate) > 0.05) {
      maxLeverage = Math.min(maxLeverage, 2);
      reasons.push(`Extreme funding rate (${(derivatives.fundingRate * 100).toFixed(3)}%)`);
    } else if (Math.abs(derivatives.fundingRate) > 0.02) {
      // Moderate funding - slight reduction
      maxLeverage = Math.min(maxLeverage, 4);
      reasons.push('Elevated funding rate');
    }

    // OI change analysis
    if (derivatives.oiChange24h < -20) {
      // Major deleveraging = volatile conditions
      maxLeverage = Math.min(maxLeverage, 2);
      reasons.push(`Major OI decline (${derivatives.oiChange24h.toFixed(1)}%)`);
    } else if (derivatives.oiChange24h > 15) {
      // Rising OI = can use more leverage with trend
      baseLeverage += 0.5;
      reasons.push('Rising open interest supports trend');
    }

    // Liquidation cascade detection
    const totalLiqs = derivatives.liquidations24h.total;
    if (totalLiqs > 500_000_000) {  // $500M
      maxLeverage = Math.min(maxLeverage, 2);
      reasons.push('Active liquidation cascade - reduce exposure');
    } else if (totalLiqs > 200_000_000) {  // $200M
      maxLeverage = Math.min(maxLeverage, 3);
      reasons.push('Elevated liquidations');
    }

    // Liquidation imbalance
    const liqRatio = derivatives.liquidations24h.long /
      (derivatives.liquidations24h.short || 1);
    if (liqRatio > 3) {
      // Heavy long liquidations = caution on longs
      reasons.push('Heavy long liquidations - caution');
    } else if (liqRatio < 0.33) {
      // Heavy short liquidations = caution on shorts
      reasons.push('Heavy short liquidations');
    }

    // === ORDER BOOK FACTORS ===

    if (orderBook) {
      // Strong imbalance in your direction = can increase leverage
      if (Math.abs(orderBook.bidAskImbalance) > 0.3) {
        baseLeverage += 0.5;
        reasons.push(`Order book imbalance ${(orderBook.bidAskImbalance * 100).toFixed(0)}%`);
      }

      // Spoofing detected = unreliable levels
      if (orderBook.spoofingDetected) {
        maxLeverage = Math.min(maxLeverage, 2);
        reasons.push('Spoofing detected - unreliable levels');
      }

      // Thin order book = higher slippage risk
      const totalDepth = orderBook.depth1Percent.bids + orderBook.depth1Percent.asks;
      if (totalDepth < 5_000_000) {  // Less than $5M in 1% depth
        maxLeverage = Math.min(maxLeverage, 3);
        reasons.push('Thin order book liquidity');
      }
    }

    // === SENTIMENT FACTORS ===

    // Extreme fear = contrarian long opportunity (if other factors align)
    if (sentiment.fearGreedIndex <= 20) {
      baseLeverage += 1;
      maxLeverage += 1;
      reasons.push('Extreme fear - contrarian long setup');
    } else if (sentiment.fearGreedIndex <= 30) {
      baseLeverage += 0.5;
      reasons.push('Fear zone - potential accumulation');
    }

    // Extreme greed = reduce long leverage
    if (sentiment.fearGreedIndex >= 80) {
      maxLeverage = Math.min(maxLeverage, 2);
      reasons.push('Extreme greed - reduce long exposure');
    } else if (sentiment.fearGreedIndex >= 70) {
      maxLeverage = Math.min(maxLeverage, 3);
      reasons.push('Greed zone - caution on longs');
    }

    // === FINAL CALCULATION ===

    // Ensure max is at least as high as base
    maxLeverage = Math.max(maxLeverage, baseLeverage);

    // Hard caps
    const suggestedLeverage = Math.min(Math.max(Math.round(baseLeverage), 1), 10);
    const maximumLeverage = Math.min(Math.max(Math.round(maxLeverage), 1), 10);

    return {
      suggested: suggestedLeverage,
      maximum: maximumLeverage,
      reasoning: reasons.join('; ') || 'Standard market conditions',
    };
  }

  /**
   * Get leverage recommendation for specific market regimes
   */
  getRegimeLeverage(regime: string): { suggested: number; maximum: number } {
    switch (regime) {
      case 'CAPITULATION':
        return { suggested: 1, maximum: 2 };
      case 'ACCUMULATION':
        return { suggested: 2, maximum: 3 };
      case 'MARKUP':
        return { suggested: 3, maximum: 5 };
      case 'DISTRIBUTION':
        return { suggested: 1, maximum: 2 };
      case 'MARKDOWN':
        return { suggested: 1, maximum: 2 };
      case 'RANGING':
        return { suggested: 1, maximum: 2 };
      default:
        return { suggested: 1, maximum: 2 };
    }
  }

  /**
   * Adjust leverage based on position direction and market bias
   */
  adjustForDirection(
    baseLeverage: LeverageRecommendation,
    positionDirection: 'LONG' | 'SHORT',
    marketBias: 'LONG' | 'SHORT' | 'NEUTRAL'
  ): LeverageRecommendation {
    // If position aligns with market bias, can use full leverage
    if (positionDirection === marketBias) {
      return baseLeverage;
    }

    // If going against market bias, reduce leverage
    if (marketBias !== 'NEUTRAL' && positionDirection !== marketBias) {
      return {
        suggested: Math.max(1, baseLeverage.suggested - 1),
        maximum: Math.max(1, baseLeverage.maximum - 1),
        reasoning: baseLeverage.reasoning + '; Reduced for counter-trend position',
      };
    }

    return baseLeverage;
  }

  /**
   * Format leverage for display
   */
  formatLeverage(leverage: LeverageRecommendation): string {
    return `${leverage.suggested}x suggested (${leverage.maximum}x max)`;
  }
}

// Export singleton instance
export const leverageCalculator = new LeverageCalculator();
