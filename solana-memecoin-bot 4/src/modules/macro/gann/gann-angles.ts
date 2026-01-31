// ===========================================
// GANN ANGLES ANALYZER
// ===========================================
// Based on W.D. Gann's angle methodology
// The 1x1 (45 degree) angle is the most important - balanced trend

import {
  GannAngleResult,
  GannAngleName,
  TrendStrength,
  GannPivot,
} from '../types.js';

/**
 * Gann Angles Analyzer
 *
 * Gann angles measure the relationship between price and time.
 * Key angles:
 * - 1x1 (45°) - Balanced, most important
 * - 2x1 (63.75°) - Strong trend
 * - 1x2 (26.25°) - Weak trend
 */
export class GannAngles {
  // Gann angle definitions (name: degrees)
  private readonly ANGLES: Record<GannAngleName, number> = {
    [GannAngleName.ANGLE_8X1]: 82.5,   // Extremely strong (8 price units per 1 time unit)
    [GannAngleName.ANGLE_4X1]: 75,     // Very strong
    [GannAngleName.ANGLE_3X1]: 71.25,  // Strong
    [GannAngleName.ANGLE_2X1]: 63.75,  // Moderate-strong
    [GannAngleName.ANGLE_1X1]: 45,     // Balanced (most important)
    [GannAngleName.ANGLE_1X2]: 26.25,  // Moderate-weak
    [GannAngleName.ANGLE_1X3]: 18.75,  // Weak
    [GannAngleName.ANGLE_1X4]: 15,     // Very weak
    [GannAngleName.ANGLE_1X8]: 7.5,    // Extremely weak
  };

  /**
   * Calculate the current angle from a pivot point
   *
   * @param pivotPrice - The pivot price
   * @param pivotTime - The pivot timestamp
   * @param currentPrice - Current market price
   * @param currentTime - Current timestamp
   * @param priceScale - Price units per time unit for 1x1 angle
   * @returns Gann angle analysis result
   */
  calculateCurrentAngle(
    pivotPrice: number,
    pivotTime: Date,
    currentPrice: number,
    currentTime: Date,
    priceScale: number = 1000
  ): GannAngleResult {
    const priceChange = currentPrice - pivotPrice;
    const timeChangeHours = (currentTime.getTime() - pivotTime.getTime()) / (1000 * 60 * 60);

    // Prevent division by zero
    if (timeChangeHours === 0) {
      return {
        currentAngle: 0,
        closestGannAngle: GannAngleName.ANGLE_1X1,
        trendStrength: TrendStrength.MODERATE,
        direction: 'UP',
        isAbove1x1: false,
      };
    }

    // Normalize price change by scale
    const normalizedPriceChange = priceChange / priceScale;

    // Calculate angle in degrees (atan returns radians)
    const angleRadians = Math.atan(normalizedPriceChange / timeChangeHours);
    const angleDegrees = angleRadians * (180 / Math.PI);

    // Find closest Gann angle
    let closestAngle = GannAngleName.ANGLE_1X1;
    let minDiff = Infinity;

    for (const [name, degrees] of Object.entries(this.ANGLES)) {
      const diff = Math.abs(Math.abs(angleDegrees) - degrees);
      if (diff < minDiff) {
        minDiff = diff;
        closestAngle = name as GannAngleName;
      }
    }

    return {
      currentAngle: angleDegrees,
      closestGannAngle: closestAngle,
      trendStrength: this.getTrendStrength(closestAngle),
      direction: priceChange >= 0 ? 'UP' : 'DOWN',
      isAbove1x1: Math.abs(angleDegrees) > 45,  // Price leading time = strong momentum
    };
  }

  /**
   * Get trend strength from angle name
   */
  private getTrendStrength(angle: GannAngleName): TrendStrength {
    switch (angle) {
      case GannAngleName.ANGLE_8X1:
      case GannAngleName.ANGLE_4X1:
        return TrendStrength.VERY_STRONG;
      case GannAngleName.ANGLE_3X1:
      case GannAngleName.ANGLE_2X1:
        return TrendStrength.STRONG;
      case GannAngleName.ANGLE_1X1:
        return TrendStrength.MODERATE;
      case GannAngleName.ANGLE_1X2:
      case GannAngleName.ANGLE_1X3:
        return TrendStrength.WEAK;
      case GannAngleName.ANGLE_1X4:
      case GannAngleName.ANGLE_1X8:
        return TrendStrength.VERY_WEAK;
      default:
        return TrendStrength.MODERATE;
    }
  }

  /**
   * Calculate price levels at each Gann angle from a pivot
   * Useful for determining where price "should" be at different trend strengths
   *
   * @param pivot - The pivot point
   * @param hoursFromPivot - Number of hours from the pivot
   * @param priceScale - Price scale factor
   * @returns Price levels at each Gann angle
   */
  calculateAnglePriceLevels(
    pivot: GannPivot,
    hoursFromPivot: number,
    priceScale: number = 1000
  ): Record<GannAngleName, number> {
    const levels: Record<string, number> = {};

    for (const [name, degrees] of Object.entries(this.ANGLES)) {
      // Convert degrees to radians
      const radians = degrees * (Math.PI / 180);
      // Calculate price change at this angle
      const priceChange = Math.tan(radians) * hoursFromPivot * priceScale;

      if (pivot.pivotType === 'LOW') {
        // From a low, angles go up
        levels[name] = pivot.price + priceChange;
      } else {
        // From a high, angles go down
        levels[name] = pivot.price - priceChange;
      }
    }

    return levels as Record<GannAngleName, number>;
  }

  /**
   * Check if price is breaking above or below a key Gann angle
   * This is a significant signal in Gann analysis
   *
   * @param currentPrice - Current market price
   * @param angleLevels - Pre-calculated angle levels
   * @param previousPrice - Previous price to detect break
   * @returns Information about any angle breaks
   */
  detectAngleBreaks(
    currentPrice: number,
    angleLevels: Record<GannAngleName, number>,
    previousPrice: number
  ): { broken: GannAngleName | null; direction: 'above' | 'below' | null } {
    // Check the 1x1 angle specifically as it's most important
    const oneToOne = angleLevels[GannAngleName.ANGLE_1X1];

    if (previousPrice < oneToOne && currentPrice >= oneToOne) {
      return { broken: GannAngleName.ANGLE_1X1, direction: 'above' };
    }

    if (previousPrice > oneToOne && currentPrice <= oneToOne) {
      return { broken: GannAngleName.ANGLE_1X1, direction: 'below' };
    }

    // Check 2x1 (strong support/resistance)
    const twoToOne = angleLevels[GannAngleName.ANGLE_2X1];

    if (previousPrice < twoToOne && currentPrice >= twoToOne) {
      return { broken: GannAngleName.ANGLE_2X1, direction: 'above' };
    }

    if (previousPrice > twoToOne && currentPrice <= twoToOne) {
      return { broken: GannAngleName.ANGLE_2X1, direction: 'below' };
    }

    return { broken: null, direction: null };
  }

  /**
   * Calculate the "natural" angle based on recent price action
   * Helps identify if the market is in a natural rhythm
   *
   * @param prices - Array of recent prices
   * @param intervalHours - Hours between each price point
   * @param priceScale - Price scale factor
   * @returns Average angle of recent price action
   */
  calculateNaturalAngle(
    prices: number[],
    intervalHours: number,
    priceScale: number = 1000
  ): number {
    if (prices.length < 2) return 0;

    let totalAngle = 0;
    let count = 0;

    for (let i = 1; i < prices.length; i++) {
      const priceChange = prices[i] - prices[i - 1];
      const normalizedChange = priceChange / priceScale;
      const angleRadians = Math.atan(normalizedChange / intervalHours);
      const angleDegrees = angleRadians * (180 / Math.PI);

      totalAngle += angleDegrees;
      count++;
    }

    return count > 0 ? totalAngle / count : 0;
  }

  /**
   * Determine if the current angle suggests a trend continuation or reversal
   *
   * @param angleResult - The calculated angle result
   * @returns Analysis of trend implications
   */
  analyzeTrendImplications(angleResult: GannAngleResult): {
    implication: 'CONTINUATION' | 'WEAKENING' | 'REVERSAL_POSSIBLE';
    reason: string;
  } {
    const { trendStrength, isAbove1x1, currentAngle } = angleResult;

    // Very weak angle suggests potential reversal
    if (trendStrength === TrendStrength.VERY_WEAK) {
      return {
        implication: 'REVERSAL_POSSIBLE',
        reason: `Angle at ${currentAngle.toFixed(1)}° indicates exhaustion`,
      };
    }

    // Strong angle above 1x1 suggests continuation
    if (isAbove1x1 && (trendStrength === TrendStrength.STRONG || trendStrength === TrendStrength.VERY_STRONG)) {
      return {
        implication: 'CONTINUATION',
        reason: `Strong ${angleResult.closestGannAngle} angle above 1x1 line`,
      };
    }

    // Moderate or weakening
    if (trendStrength === TrendStrength.WEAK || !isAbove1x1) {
      return {
        implication: 'WEAKENING',
        reason: `Angle falling below 1x1 line, momentum fading`,
      };
    }

    return {
      implication: 'CONTINUATION',
      reason: `Balanced ${angleResult.closestGannAngle} trend angle`,
    };
  }

  /**
   * Get the degree value for a Gann angle name
   */
  getAngleDegrees(angleName: GannAngleName): number {
    return this.ANGLES[angleName];
  }

  /**
   * Format angle for display
   */
  formatAngle(angleName: GannAngleName, degrees: number): string {
    const directionEmoji = degrees >= 0 ? '↗️' : '↘️';
    return `${angleName} (${Math.abs(degrees).toFixed(1)}°) ${directionEmoji}`;
  }
}

// Export singleton instance
export const gannAngles = new GannAngles();
