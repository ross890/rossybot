// ===========================================
// GANN TIME CYCLES ANALYZER
// ===========================================
// Based on W.D. Gann's time cycle methodology
// "Time is more important than price. When time is up, the market will reverse."

import {
  TimeCycleWindow,
  SeasonalCycle,
  CycleSignificance,
  PivotType,
  GannPivot,
} from '../types.js';

/**
 * Gann Time Cycles Analyzer
 *
 * Key Gann cycles:
 * - Primary: 30, 45, 90, 180, 360 bars
 * - Secondary: 60, 120, 144, 270 bars
 * - Square numbers: 16, 25, 36, 49, 64, 81, 100, 121, 144
 */
export class GannTimeCycles {
  // Primary cycles (highest importance)
  private readonly PRIMARY_CYCLES = [30, 45, 90, 180, 360];

  // Secondary cycles
  private readonly SECONDARY_CYCLES = [60, 120, 144, 270];

  // Perfect square cycles (Gann's "vibration" numbers)
  private readonly SQUARE_CYCLES = [16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225];

  // Minor cycles for short-term trading
  private readonly MINOR_CYCLES = [7, 14, 21, 28];

  /**
   * Get bar duration in milliseconds for a given timeframe
   */
  private getBarDuration(timeframe: '1h' | '4h' | '1d'): number {
    switch (timeframe) {
      case '1h':
        return 60 * 60 * 1000;  // 1 hour
      case '4h':
        return 4 * 60 * 60 * 1000;  // 4 hours
      case '1d':
        return 24 * 60 * 60 * 1000;  // 1 day
      default:
        return 60 * 60 * 1000;
    }
  }

  /**
   * Calculate upcoming time cycles from a pivot point
   *
   * @param pivot - The pivot point to measure from
   * @param timeframe - The chart timeframe
   * @param lookAheadDays - How many days ahead to look for cycles
   * @returns Array of upcoming cycle windows
   */
  calculateUpcomingCycles(
    pivot: GannPivot,
    timeframe: '1h' | '4h' | '1d' = '4h',
    lookAheadDays: number = 30
  ): TimeCycleWindow[] {
    const windows: TimeCycleWindow[] = [];
    const now = Date.now();
    const barDuration = this.getBarDuration(timeframe);
    const lookAheadMs = lookAheadDays * 24 * 60 * 60 * 1000;

    const allCycles = [
      ...this.PRIMARY_CYCLES,
      ...this.SECONDARY_CYCLES,
      ...this.SQUARE_CYCLES,
    ];

    // Remove duplicates and sort
    const uniqueCycles = [...new Set(allCycles)].sort((a, b) => a - b);

    for (const cycle of uniqueCycles) {
      const cycleEndMs = pivot.timestamp.getTime() + cycle * barDuration;

      // Only include cycles that are in the future and within lookAhead window
      if (cycleEndMs > now && cycleEndMs < now + lookAheadMs) {
        const barsRemaining = Math.floor((cycleEndMs - now) / barDuration);

        windows.push({
          cycleLength: cycle,
          expectedDate: new Date(cycleEndMs),
          barsRemaining,
          fromPivot: pivot.pivotType,
          significance: this.getCycleSignificance(cycle),
        });
      }
    }

    // Sort by expected date (soonest first)
    return windows.sort((a, b) => a.expectedDate.getTime() - b.expectedDate.getTime());
  }

  /**
   * Get the significance level of a cycle
   */
  private getCycleSignificance(cycleLength: number): CycleSignificance {
    if (this.PRIMARY_CYCLES.includes(cycleLength)) {
      return CycleSignificance.HIGH;
    } else if (this.SECONDARY_CYCLES.includes(cycleLength)) {
      return CycleSignificance.MEDIUM;
    }
    return CycleSignificance.LOW;
  }

  /**
   * Get seasonal cycles (Equinox/Solstice dates)
   * Gann believed trends often change near these dates
   *
   * @param year - The year to get cycles for
   * @returns Array of seasonal cycle dates
   */
  getSeasonalCycles(year: number): SeasonalCycle[] {
    return [
      {
        name: 'Spring Equinox',
        date: new Date(year, 2, 20),  // March 20
        type: 'EQUINOX',
      },
      {
        name: 'Summer Solstice',
        date: new Date(year, 5, 21),  // June 21
        type: 'SOLSTICE',
      },
      {
        name: 'Autumn Equinox',
        date: new Date(year, 8, 22),  // September 22
        type: 'EQUINOX',
      },
      {
        name: 'Winter Solstice',
        date: new Date(year, 11, 21),  // December 21
        type: 'SOLSTICE',
      },
    ];
  }

  /**
   * Find cycles that are about to complete (imminent)
   *
   * @param cycles - Array of cycle windows
   * @param withinBars - Number of bars to consider as "imminent"
   * @returns Cycles completing soon
   */
  findImminentCycles(
    cycles: TimeCycleWindow[],
    withinBars: number = 3
  ): TimeCycleWindow[] {
    return cycles.filter((c) => c.barsRemaining <= withinBars);
  }

  /**
   * Calculate anniversary dates from a significant event
   * Gann tracked yearly anniversaries of major market events
   *
   * @param eventDate - The original event date
   * @param years - Number of years to calculate
   * @returns Array of anniversary dates
   */
  calculateAnniversaries(eventDate: Date, years: number = 5): Date[] {
    const anniversaries: Date[] = [];

    for (let i = 1; i <= years; i++) {
      const anniversary = new Date(eventDate);
      anniversary.setFullYear(anniversary.getFullYear() + i);
      anniversaries.push(anniversary);
    }

    return anniversaries;
  }

  /**
   * Check if current time is near a cycle completion
   *
   * @param pivot - The pivot to measure from
   * @param timeframe - Chart timeframe
   * @param toleranceBars - Number of bars tolerance
   * @returns True if near a significant cycle completion
   */
  isNearCycleCompletion(
    pivot: GannPivot,
    timeframe: '1h' | '4h' | '1d' = '4h',
    toleranceBars: number = 3
  ): { isNear: boolean; cycle: TimeCycleWindow | null } {
    const upcomingCycles = this.calculateUpcomingCycles(pivot, timeframe, 7);
    const imminentCycle = upcomingCycles.find(
      (c) => c.barsRemaining <= toleranceBars && c.significance === CycleSignificance.HIGH
    );

    return {
      isNear: !!imminentCycle,
      cycle: imminentCycle || null,
    };
  }

  /**
   * Calculate the "natural" time for a move based on price change
   * Gann's price-time squaring: price change should equal time elapsed
   *
   * @param priceChange - The price change (absolute value)
   * @param priceScale - Price units per time unit
   * @param timeframe - Chart timeframe
   * @returns Expected completion time
   */
  calculateNaturalTime(
    priceChange: number,
    priceScale: number,
    timeframe: '1h' | '4h' | '1d'
  ): { bars: number; date: Date } {
    const barDuration = this.getBarDuration(timeframe);
    const expectedBars = Math.round(priceChange / priceScale);
    const expectedDate = new Date(Date.now() + expectedBars * barDuration);

    return {
      bars: expectedBars,
      date: expectedDate,
    };
  }

  /**
   * Get the next significant cycle dates
   * Useful for planning entries/exits
   *
   * @param pivot - The pivot to measure from
   * @param timeframe - Chart timeframe
   * @param count - Number of cycles to return
   * @returns Next significant cycle completions
   */
  getNextSignificantCycles(
    pivot: GannPivot,
    timeframe: '1h' | '4h' | '1d' = '4h',
    count: number = 5
  ): TimeCycleWindow[] {
    const allCycles = this.calculateUpcomingCycles(pivot, timeframe, 90);

    // Filter to only high significance cycles
    const significantCycles = allCycles.filter(
      (c) => c.significance === CycleSignificance.HIGH
    );

    return significantCycles.slice(0, count);
  }

  /**
   * Calculate 30-day and 90-day cycle windows
   * These are Gann's most commonly used intermediate cycles
   *
   * @param fromDate - Starting date
   * @returns Object with 30-day and 90-day cycle dates
   */
  getIntermediateCycles(fromDate: Date): { thirtyDay: Date; ninetyDay: Date } {
    const thirtyDay = new Date(fromDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    const ninetyDay = new Date(fromDate.getTime() + 90 * 24 * 60 * 60 * 1000);

    return { thirtyDay, ninetyDay };
  }
}

// Export singleton instance
export const gannTimeCycles = new GannTimeCycles();
