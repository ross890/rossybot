// ===========================================
// MODULE: TIME-OF-DAY OPTIMIZER
// Tracks signal EV by hour-of-day (AEDT windows)
// Phase 3.5 — avoids trading during historically bad hours
// ===========================================

import { logger } from '../utils/logger.js';
import { pool } from '../utils/database.js';

// ============ TYPES ============

export interface TimeWindow {
  label: string;
  startHour: number; // AEDT hour
  endHour: number;
  description: string;
}

export interface TimeWindowStats {
  window: TimeWindow;
  signalCount: number;
  wins: number;
  losses: number;
  winRate: number;
  evPercent: number;
  scoreAdjustment: number;
}

export interface TimeAdjustment {
  scoreAdjustment: number;  // -5 to 0 (penalty only)
  minScoreIncrease: number; // 0 or +10
  currentWindow: string;
  reason: string;
}

// ============ CONFIGURATION ============

const TIME_WINDOWS: TimeWindow[] = [
  { label: '00-04 AEDT', startHour: 0, endHour: 4, description: 'US afternoon/evening' },
  { label: '04-08 AEDT', startHour: 4, endHour: 8, description: 'US late night / Asia morning' },
  { label: '08-12 AEDT', startHour: 8, endHour: 12, description: 'Asia active / Europe morning' },
  { label: '12-16 AEDT', startHour: 12, endHour: 16, description: 'Europe active / US pre-market' },
  { label: '16-20 AEDT', startHour: 16, endHour: 20, description: 'US morning/midday' },
  { label: '20-24 AEDT', startHour: 20, endHour: 24, description: 'US afternoon' },
];

const CONFIG = {
  // Minimum signals per window before applying adjustments
  MIN_SIGNALS_FOR_ADJUSTMENT: 30,

  // Minimum total signals before enabling time optimization
  MIN_TOTAL_SIGNALS: 100,

  // Thresholds for time-based penalties
  NEGATIVE_EV_THRESHOLD: -15, // -15% EV → apply penalty
  SCORE_PENALTY: -5,
  MIN_SCORE_INCREASE: 10,

  // AEDT timezone
  TIMEZONE: 'Australia/Sydney',
} as const;

// ============ TIME OPTIMIZER CLASS ============

export class TimeOptimizer {
  // Cached window stats (refreshed during daily optimization)
  private windowStats: Map<string, TimeWindowStats> = new Map();
  private lastCalculation = 0;
  private totalSignals = 0;

  /**
   * Initialize: calculate initial stats from database.
   */
  async initialize(): Promise<void> {
    await this.calculateWindowStats();
    logger.info({
      windows: this.windowStats.size,
      totalSignals: this.totalSignals,
    }, 'Time optimizer initialized');
  }

  /**
   * Get the time-based adjustment for the current hour.
   * Returns score penalty and/or minimum score increase.
   */
  getTimeAdjustment(date: Date = new Date()): TimeAdjustment {
    // Only apply adjustments after sufficient data
    if (this.totalSignals < CONFIG.MIN_TOTAL_SIGNALS) {
      return {
        scoreAdjustment: 0,
        minScoreIncrease: 0,
        currentWindow: this.getCurrentWindowLabel(date),
        reason: `Insufficient data (${this.totalSignals}/${CONFIG.MIN_TOTAL_SIGNALS} signals)`,
      };
    }

    const window = this.getCurrentWindow(date);
    if (!window) {
      return {
        scoreAdjustment: 0,
        minScoreIncrease: 0,
        currentWindow: 'UNKNOWN',
        reason: 'Could not determine current time window',
      };
    }

    const stats = this.windowStats.get(window.label);
    if (!stats || stats.signalCount < CONFIG.MIN_SIGNALS_FOR_ADJUSTMENT) {
      return {
        scoreAdjustment: 0,
        minScoreIncrease: 0,
        currentWindow: window.label,
        reason: `Insufficient data for ${window.label} (${stats?.signalCount || 0}/${CONFIG.MIN_SIGNALS_FOR_ADJUSTMENT} signals)`,
      };
    }

    // Apply penalty if EV is consistently negative
    if (stats.evPercent < CONFIG.NEGATIVE_EV_THRESHOLD) {
      return {
        scoreAdjustment: CONFIG.SCORE_PENALTY,
        minScoreIncrease: CONFIG.MIN_SCORE_INCREASE,
        currentWindow: window.label,
        reason: `${window.label} has ${stats.evPercent.toFixed(1)}% EV over ${stats.signalCount} signals — penalty applied`,
      };
    }

    return {
      scoreAdjustment: 0,
      minScoreIncrease: 0,
      currentWindow: window.label,
      reason: `${window.label} performing normally (${stats.evPercent.toFixed(1)}% EV)`,
    };
  }

  /**
   * Calculate window stats from the performance database.
   * Called during daily optimization cycle.
   */
  async calculateWindowStats(): Promise<void> {
    try {
      // Query signals with time data
      const result = await pool.query(`
        SELECT
          signal_time,
          final_outcome,
          COALESCE(realized_return, final_return) as return_pct
        FROM signal_performance
        WHERE final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')
        ORDER BY signal_time
      `);

      this.windowStats.clear();
      this.totalSignals = result.rows.length;

      // Initialize all windows
      for (const window of TIME_WINDOWS) {
        this.windowStats.set(window.label, {
          window,
          signalCount: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          evPercent: 0,
          scoreAdjustment: 0,
        });
      }

      // Bucket signals by time window
      for (const row of result.rows) {
        const signalTime = new Date(row.signal_time);
        const window = this.getCurrentWindow(signalTime);
        if (!window) continue;

        const stats = this.windowStats.get(window.label)!;
        stats.signalCount++;

        const isWin = row.final_outcome === 'WIN' || row.final_outcome === 'EXPIRED_PROFIT';
        if (isWin) stats.wins++;
        else stats.losses++;

        const returnPct = parseFloat(row.return_pct) || 0;
        stats.evPercent = ((stats.evPercent * (stats.signalCount - 1)) + returnPct) / stats.signalCount;
      }

      // Calculate final stats
      for (const [, stats] of this.windowStats) {
        if (stats.signalCount > 0) {
          stats.winRate = (stats.wins / stats.signalCount) * 100;
        }

        // Calculate score adjustment
        if (stats.signalCount >= CONFIG.MIN_SIGNALS_FOR_ADJUSTMENT &&
            stats.evPercent < CONFIG.NEGATIVE_EV_THRESHOLD) {
          stats.scoreAdjustment = CONFIG.SCORE_PENALTY;
        }
      }

      this.lastCalculation = Date.now();

      logger.info({
        totalSignals: this.totalSignals,
        windowsWithPenalty: Array.from(this.windowStats.values())
          .filter(s => s.scoreAdjustment < 0)
          .map(s => s.window.label),
      }, 'Time window stats calculated');
    } catch (error) {
      logger.debug({ error }, 'Failed to calculate time window stats');
    }
  }

  /**
   * Format time-of-day breakdown for Telegram report.
   */
  formatReport(): string {
    if (this.totalSignals < CONFIG.MIN_TOTAL_SIGNALS) {
      return `🕐 *TIME-OF-DAY*: Insufficient data (${this.totalSignals}/${CONFIG.MIN_TOTAL_SIGNALS})`;
    }

    const lines = ['🕐 *TIME-OF-DAY PERFORMANCE*'];

    for (const window of TIME_WINDOWS) {
      const stats = this.windowStats.get(window.label);
      if (!stats || stats.signalCount === 0) continue;

      const evEmoji = stats.evPercent >= 10 ? '✅' :
                      stats.evPercent >= 0 ? '⚠️' : '❌';
      const penaltyFlag = stats.scoreAdjustment < 0 ? ' ⛔ PENALTY' : '';

      lines.push(
        `${evEmoji} ${window.label}: ${stats.evPercent.toFixed(1)}% EV | ${stats.winRate.toFixed(0)}% WR | ${stats.signalCount} signals${penaltyFlag}`
      );
    }

    return lines.join('\n');
  }

  // ============ HELPERS ============

  /**
   * Get the current time window based on AEDT.
   */
  private getCurrentWindow(date: Date): TimeWindow | null {
    const hour = this.getAEDTHour(date);

    for (const window of TIME_WINDOWS) {
      if (hour >= window.startHour && hour < window.endHour) {
        return window;
      }
    }
    return null;
  }

  private getCurrentWindowLabel(date: Date): string {
    const window = this.getCurrentWindow(date);
    return window?.label || 'UNKNOWN';
  }

  /**
   * Get the hour in AEDT timezone.
   */
  private getAEDTHour(date: Date): number {
    // Get hour in Australia/Sydney timezone
    const formatter = new Intl.DateTimeFormat('en-AU', {
      timeZone: CONFIG.TIMEZONE,
      hour: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find(p => p.type === 'hour');
    return parseInt(hourPart?.value || '0');
  }

  /**
   * Get all window stats for reporting.
   */
  getAllStats(): TimeWindowStats[] {
    return Array.from(this.windowStats.values());
  }
}

// ============ EXPORTS ============

export const timeOptimizer = new TimeOptimizer();

export default {
  TimeOptimizer,
  timeOptimizer,
};
