// ===========================================
// GANN CONFLUENCE DETECTOR
// ===========================================
// Detects when price levels and time cycles align
// This is the highest-probability Gann signal

import {
  ConfluenceSignal,
  GannLevels,
  TimeCycleWindow,
  CycleSignificance,
  PivotType,
} from '../types.js';

/**
 * Gann Confluence Detector
 *
 * A confluence occurs when:
 * 1. Price reaches a significant Gann level (Square of 9)
 * 2. At the same time a significant time cycle completes
 *
 * This combination often marks major turning points.
 */
export class GannConfluenceDetector {
  /**
   * Detect if there's a price/time confluence occurring
   *
   * @param currentPrice - Current market price
   * @param gannLevels - Calculated Gann price levels
   * @param timeCycles - Active time cycle windows
   * @param tolerance - Tolerance settings for matching
   * @returns Confluence signal if detected, null otherwise
   */
  detectConfluence(
    currentPrice: number,
    gannLevels: GannLevels,
    timeCycles: TimeCycleWindow[],
    tolerance: { pricePercent: number; barsWindow: number } = { pricePercent: 0.01, barsWindow: 3 }
  ): ConfluenceSignal | null {
    // Find imminent cycles (completing soon)
    const imminentCycles = timeCycles.filter(
      (c) => c.barsRemaining <= tolerance.barsWindow && c.significance !== CycleSignificance.LOW
    );

    if (imminentCycles.length === 0) {
      return null;
    }

    // Combine all Gann levels
    const allLevels = [...gannLevels.support, ...gannLevels.resistance];

    for (const cycle of imminentCycles) {
      for (const level of allLevels) {
        const priceDiff = Math.abs(currentPrice - level) / level;

        if (priceDiff <= tolerance.pricePercent) {
          // Confluence detected!
          const isSupport = gannLevels.support.includes(level);
          const expectedReversal = this.determineExpectedReversal(cycle, isSupport);
          const confidence = this.calculateConfidence(priceDiff, cycle, tolerance);

          return {
            type: 'PRICE_TIME_CONFLUENCE',
            confidence,
            priceLevel: level,
            timeCycle: cycle,
            expectedReversal,
            message: this.formatConfluenceMessage(level, cycle, expectedReversal),
          };
        }
      }
    }

    return null;
  }

  /**
   * Determine expected reversal direction based on cycle and price level
   */
  private determineExpectedReversal(
    cycle: TimeCycleWindow,
    isAtSupport: boolean
  ): 'BULLISH' | 'BEARISH' {
    // If cycle is from a HIGH and we're at support, expect bullish reversal
    // If cycle is from a LOW and we're at resistance, expect bearish reversal
    if (cycle.fromPivot === PivotType.HIGH && isAtSupport) {
      return 'BULLISH';
    }
    if (cycle.fromPivot === PivotType.LOW && !isAtSupport) {
      return 'BEARISH';
    }
    // Default based on support/resistance
    return isAtSupport ? 'BULLISH' : 'BEARISH';
  }

  /**
   * Calculate confluence confidence score (0-100)
   */
  private calculateConfidence(
    priceDiff: number,
    cycle: TimeCycleWindow,
    tolerance: { pricePercent: number; barsWindow: number }
  ): number {
    let confidence = 50;  // Base confidence

    // Better price alignment = higher confidence
    const priceScore = (1 - priceDiff / tolerance.pricePercent) * 20;
    confidence += priceScore;

    // Closer cycle completion = higher confidence
    const timeScore = (1 - cycle.barsRemaining / tolerance.barsWindow) * 15;
    confidence += timeScore;

    // Higher significance cycles = higher confidence
    if (cycle.significance === CycleSignificance.HIGH) {
      confidence += 15;
    } else if (cycle.significance === CycleSignificance.MEDIUM) {
      confidence += 8;
    }

    return Math.min(100, Math.round(confidence));
  }

  /**
   * Format a human-readable confluence message
   */
  private formatConfluenceMessage(
    priceLevel: number,
    cycle: TimeCycleWindow,
    expectedReversal: 'BULLISH' | 'BEARISH'
  ): string {
    const levelStr = priceLevel.toLocaleString('en-US', { maximumFractionDigits: 0 });
    const cycleStr = `${cycle.cycleLength}-bar`;
    const fromStr = cycle.fromPivot === PivotType.HIGH ? 'ATH' : 'ATL';
    const barsStr = cycle.barsRemaining === 0 ? 'now' : `in ${cycle.barsRemaining} bars`;

    return `Price at $${levelStr} meeting ${cycleStr} cycle from ${fromStr} completing ${barsStr}. Expected: ${expectedReversal} reversal.`;
  }

  /**
   * Find all potential confluence zones in the near future
   * Useful for planning trades
   *
   * @param gannLevels - Calculated Gann levels
   * @param timeCycles - Active time cycles
   * @param currentPrice - Current price for context
   * @returns Array of potential confluence zones
   */
  findPotentialConfluenceZones(
    gannLevels: GannLevels,
    timeCycles: TimeCycleWindow[],
    currentPrice: number
  ): Array<{
    priceLevel: number;
    cycles: TimeCycleWindow[];
    distancePercent: number;
    type: 'SUPPORT' | 'RESISTANCE';
  }> {
    const zones: Array<{
      priceLevel: number;
      cycles: TimeCycleWindow[];
      distancePercent: number;
      type: 'SUPPORT' | 'RESISTANCE';
    }> = [];

    // Check each Gann level
    const allLevels = [
      ...gannLevels.support.map((l) => ({ price: l, type: 'SUPPORT' as const })),
      ...gannLevels.resistance.map((l) => ({ price: l, type: 'RESISTANCE' as const })),
    ];

    for (const level of allLevels) {
      const distancePercent = ((level.price - currentPrice) / currentPrice) * 100;

      // Only include levels within 10% of current price
      if (Math.abs(distancePercent) <= 10) {
        // Find cycles completing in a reasonable timeframe
        const relevantCycles = timeCycles.filter(
          (c) => c.significance !== CycleSignificance.LOW && c.barsRemaining <= 20
        );

        if (relevantCycles.length > 0) {
          zones.push({
            priceLevel: level.price,
            cycles: relevantCycles,
            distancePercent,
            type: level.type,
          });
        }
      }
    }

    // Sort by distance from current price
    return zones.sort((a, b) => Math.abs(a.distancePercent) - Math.abs(b.distancePercent));
  }

  /**
   * Calculate overall confluence strength in the current market
   * Higher = more confluence signals = more significant levels nearby
   *
   * @param currentPrice - Current price
   * @param gannLevels - Gann levels
   * @param timeCycles - Time cycles
   * @returns Confluence strength score (0-100)
   */
  calculateConfluenceStrength(
    currentPrice: number,
    gannLevels: GannLevels,
    timeCycles: TimeCycleWindow[]
  ): number {
    let strength = 0;

    // Check proximity to Gann levels
    const allLevels = [...gannLevels.support, ...gannLevels.resistance];
    for (const level of allLevels) {
      const distance = Math.abs(currentPrice - level) / level;
      if (distance <= 0.02) {
        strength += 20;  // Very close
      } else if (distance <= 0.05) {
        strength += 10;  // Moderately close
      }
    }

    // Check imminent cycles
    const imminentHighCycles = timeCycles.filter(
      (c) => c.barsRemaining <= 5 && c.significance === CycleSignificance.HIGH
    );
    strength += imminentHighCycles.length * 15;

    const imminentMediumCycles = timeCycles.filter(
      (c) => c.barsRemaining <= 5 && c.significance === CycleSignificance.MEDIUM
    );
    strength += imminentMediumCycles.length * 8;

    return Math.min(100, strength);
  }

  /**
   * Check for multiple confluence alignment
   * Returns true if multiple high-significance factors align
   */
  hasMultipleConfluence(
    currentPrice: number,
    gannLevels: GannLevels,
    timeCycles: TimeCycleWindow[],
    tolerancePercent: number = 0.02
  ): { hasMultiple: boolean; factors: string[] } {
    const factors: string[] = [];

    // Check price levels
    const allLevels = [...gannLevels.support, ...gannLevels.resistance];
    const nearbyLevels = allLevels.filter(
      (l) => Math.abs(currentPrice - l) / l <= tolerancePercent
    );

    if (nearbyLevels.length > 0) {
      factors.push(`Near ${nearbyLevels.length} Gann level(s)`);
    }

    // Check imminent cycles
    const imminentCycles = timeCycles.filter(
      (c) => c.barsRemaining <= 3 && c.significance === CycleSignificance.HIGH
    );

    if (imminentCycles.length > 0) {
      factors.push(`${imminentCycles.length} high-significance cycle(s) completing`);
    }

    // Check cardinal cross alignment
    const nearCardinal = gannLevels.cardinalCross.filter(
      (cc) => Math.abs(currentPrice - cc.price) / cc.price <= tolerancePercent
    );

    if (nearCardinal.length > 0) {
      const angles = nearCardinal.map((cc) => `${cc.angle}°`).join(', ');
      factors.push(`At cardinal cross: ${angles}`);
    }

    return {
      hasMultiple: factors.length >= 2,
      factors,
    };
  }
}

// Export singleton instance
export const gannConfluenceDetector = new GannConfluenceDetector();
