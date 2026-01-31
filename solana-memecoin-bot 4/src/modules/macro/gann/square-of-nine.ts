// ===========================================
// GANN SQUARE OF 9 CALCULATOR
// ===========================================
// Based on W.D. Gann's Square of 9 methodology
// Reference: https://www.litefinance.org/blog/for-beginners/unknown-gann-method-square-of-9-part-2/

import { GannLevels, DetailedGannLevel } from '../types.js';

/**
 * Gann Square of 9 Calculator
 *
 * The Square of 9 is a spiral of numbers starting from 1 at the center.
 * Key angles (cardinal crosses) occur at 90, 180, 270, and 360 degrees.
 * These angles mark significant support/resistance levels.
 */
export class GannSquareOfNine {
  /**
   * Calculate support and resistance levels using Gann's Square of 9
   *
   * @param pivotPrice - The reference price (usually a significant high or low)
   * @param direction - Whether to calculate levels above or below the pivot
   * @returns GannLevels with support and resistance arrays
   */
  calculateLevels(pivotPrice: number, direction: 'up' | 'down'): GannLevels {
    const sqrtPrice = Math.sqrt(pivotPrice);
    const levels: number[] = [];
    const cardinalCross: Array<{ angle: number; price: number }> = [];

    // Cardinal cross angles: 90, 180, 270, 360 degrees
    const angles = [90, 180, 270, 360];

    for (const angle of angles) {
      // Gann increment formula: each 360 degrees = 2 units on the square root scale
      const increment = (angle / 360) * 2;

      let newPrice: number;
      if (direction === 'up') {
        const newSqrt = sqrtPrice + increment;
        newPrice = Math.pow(newSqrt, 2);
      } else {
        const newSqrt = sqrtPrice - increment;
        // Ensure we don't go negative
        newPrice = newSqrt > 0 ? Math.pow(newSqrt, 2) : 0;
      }

      if (newPrice > 0) {
        levels.push(newPrice);
        cardinalCross.push({ angle, price: newPrice });
      }
    }

    return {
      resistance: direction === 'up' ? levels : [],
      support: direction === 'down' ? levels : [],
      cardinalCross,
    };
  }

  /**
   * Calculate detailed levels at 45-degree increments
   * Provides finer granularity for support/resistance identification
   *
   * @param pivotPrice - The reference price
   * @returns Array of detailed Gann levels
   */
  calculateDetailedLevels(pivotPrice: number): DetailedGannLevel[] {
    const sqrtPrice = Math.sqrt(pivotPrice);
    const levels: DetailedGannLevel[] = [];

    // Calculate levels at 45-degree increments up to 720 degrees (2 full rotations)
    for (let angle = 45; angle <= 720; angle += 45) {
      const increment = (angle / 360) * 2;

      const sqrtUp = sqrtPrice + increment;
      const sqrtDown = sqrtPrice - increment;

      levels.push({
        angle,
        priceUp: Math.pow(sqrtUp, 2),
        priceDown: sqrtDown > 0 ? Math.pow(sqrtDown, 2) : 0,
      });
    }

    return levels;
  }

  /**
   * Calculate both support and resistance levels from a pivot price
   *
   * @param pivotPrice - The reference price
   * @param numLevels - Number of levels to calculate in each direction
   * @returns Combined GannLevels
   */
  calculateAllLevels(pivotPrice: number, numLevels: number = 4): GannLevels {
    const sqrtPrice = Math.sqrt(pivotPrice);
    const support: number[] = [];
    const resistance: number[] = [];
    const cardinalCross: Array<{ angle: number; price: number }> = [];

    // Calculate levels in both directions
    for (let i = 1; i <= numLevels; i++) {
      // Each level is 90 degrees apart
      const angle = i * 90;
      const increment = (angle / 360) * 2;

      // Resistance (above current price)
      const sqrtUp = sqrtPrice + increment;
      const resistancePrice = Math.pow(sqrtUp, 2);
      resistance.push(resistancePrice);
      cardinalCross.push({ angle, price: resistancePrice });

      // Support (below current price)
      const sqrtDown = sqrtPrice - increment;
      if (sqrtDown > 0) {
        const supportPrice = Math.pow(sqrtDown, 2);
        support.push(supportPrice);
      }
    }

    return {
      support: support.sort((a, b) => b - a),  // Descending (closest first)
      resistance: resistance.sort((a, b) => a - b),  // Ascending (closest first)
      cardinalCross,
    };
  }

  /**
   * Find the nearest Gann level to the current price
   *
   * @param currentPrice - Current market price
   * @param levels - Pre-calculated Gann levels
   * @returns Nearest support and resistance levels
   */
  findNearestLevels(
    currentPrice: number,
    levels: GannLevels
  ): { nearestSupport: number; nearestResistance: number } {
    // Find nearest support (highest support below current price)
    const nearestSupport = levels.support.find((s) => s < currentPrice) || levels.support[levels.support.length - 1] || currentPrice * 0.9;

    // Find nearest resistance (lowest resistance above current price)
    const nearestResistance = levels.resistance.find((r) => r > currentPrice) || levels.resistance[levels.resistance.length - 1] || currentPrice * 1.1;

    return { nearestSupport, nearestResistance };
  }

  /**
   * Determine which quadrant of the Square of 9 the price is in
   *
   * @param currentPrice - Current market price
   * @param pivotPrice - Reference pivot price
   * @returns Description of the position on the Square of 9
   */
  getSquareOf9Position(currentPrice: number, pivotPrice: number): string {
    const sqrtCurrent = Math.sqrt(currentPrice);
    const sqrtPivot = Math.sqrt(pivotPrice);
    const diff = sqrtCurrent - sqrtPivot;

    // Calculate which angle range we're in
    const rotations = diff / 2;  // Each full rotation is 2 units
    const degrees = (rotations % 1) * 360;
    const normalizedDegrees = degrees < 0 ? 360 + degrees : degrees;

    if (normalizedDegrees < 90) {
      return 'Between 0° and 90° (Early momentum)';
    } else if (normalizedDegrees < 180) {
      return 'Between 90° and 180° (Building strength)';
    } else if (normalizedDegrees < 270) {
      return 'Between 180° and 270° (Mature trend)';
    } else {
      return 'Between 270° and 360° (Approaching reversal zone)';
    }
  }

  /**
   * Calculate price targets based on Gann's 50% retracement rule
   * Gann believed that prices often retrace to the 50% level of the previous move
   *
   * @param highPrice - Recent high
   * @param lowPrice - Recent low
   * @returns Key retracement levels
   */
  calculateRetracementLevels(
    highPrice: number,
    lowPrice: number
  ): { levels: number[]; labels: string[] } {
    const range = highPrice - lowPrice;

    return {
      levels: [
        lowPrice + range * 0.25,   // 25%
        lowPrice + range * 0.333,  // 33.3%
        lowPrice + range * 0.5,    // 50% (most important)
        lowPrice + range * 0.667,  // 66.7%
        lowPrice + range * 0.75,   // 75%
      ],
      labels: ['25%', '33.3%', '50%', '66.7%', '75%'],
    };
  }
}

// Export singleton instance
export const gannSquareOfNine = new GannSquareOfNine();
