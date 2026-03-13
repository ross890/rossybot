// ===========================================
// MODULE: KELLY CRITERION POSITION SIZER
// Calculates optimal position sizes based on realized
// win/loss data per signal type using fractional Kelly.
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { SignalType } from '../../types/index.js';

// ============ TYPES ============

export interface KellyParams {
  winProbability: number;   // p
  lossProbability: number;  // q = 1 - p
  avgWinReturn: number;     // average winning return (e.g. 2.5 = +250%)
  avgLossReturn: number;    // average loss magnitude (positive, e.g. 0.4 = -40%)
  payoffRatio: number;      // b = avgWin / avgLoss
  fullKelly: number;        // f* = (p*b - q) / b
  quarterKelly: number;     // f* × 0.25
  confidenceMultiplier: number; // scaling based on sample size
  finalSizePercent: number; // quarter Kelly × confidence multiplier
  signalCount: number;
  hasEdge: boolean;         // p*b > q
}

export interface KellyReport {
  timestamp: Date;
  overall: KellyParams;
  perSignalType: Record<string, KellyParams>;
  dataSource: 'realized' | 'signal_performance';
}

// Signal types that Kelly tracks
const KELLY_SIGNAL_TYPES = [
  'BUY',
  'ALPHA_WALLET',
  'DISCOVERY',
  'SOCIAL_DISCOVERY',
  'KOL_VALIDATION',
] as const;

type KellySignalType = typeof KELLY_SIGNAL_TYPES[number];

// ============ CONSTANTS ============

const KELLY_CONFIG = {
  // Fractional Kelly: use quarter-Kelly for ~75% growth rate, ~50% drawdown risk
  FRACTION: 0.25,

  // Confidence scaling based on sample size
  CONFIDENCE_TIERS: [
    { minSignals: 100, multiplier: 1.00 },
    { minSignals: 50,  multiplier: 0.75 },
    { minSignals: 30,  multiplier: 0.50 },
    { minSignals: 0,   multiplier: 0.00 },  // < 30 signals: use fixed default
  ],

  // Fixed default when not enough data
  DEFAULT_SIZE_PERCENT: 2,

  // Absolute bounds
  MIN_SIZE_PERCENT: 0.5,
  MAX_SIZE_PERCENT: 15,

  // Slippage guard
  SLIPPAGE_WARNING_THRESHOLD: 0.05,  // 5% - reduce size
  SLIPPAGE_SKIP_THRESHOLD: 0.15,     // 15% - skip trade

  // How far back to look for realized data (days)
  LOOKBACK_DAYS: 30,
} as const;

// ============ KELLY SIZER CLASS ============

export class KellySizer {
  private cache: KellyReport | null = null;
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  /**
   * Calculate Kelly fraction from win probability and payoff ratio.
   * f* = (p × b - q) / b
   */
  private calculateKelly(
    wins: number,
    losses: number,
    avgWinReturn: number,
    avgLossReturn: number,
  ): KellyParams {
    const total = wins + losses;
    const p = total > 0 ? wins / total : 0;
    const q = 1 - p;

    // avgLossReturn is the magnitude of losses (positive number)
    // avgWinReturn is the magnitude of wins (positive number)
    const b = avgLossReturn > 0 ? avgWinReturn / avgLossReturn : 0;

    // Kelly formula: f* = (p*b - q) / b
    const fullKelly = b > 0 ? (p * b - q) / b : 0;
    const hasEdge = fullKelly > 0;

    // Quarter-Kelly
    const quarterKelly = hasEdge ? fullKelly * KELLY_CONFIG.FRACTION : 0;

    // Confidence multiplier based on sample size
    const confidenceMultiplier = this.getConfidenceMultiplier(total);

    // Final size: quarter-Kelly × confidence, or default if not enough data
    let finalSizePercent: number;
    if (total < 30) {
      finalSizePercent = KELLY_CONFIG.DEFAULT_SIZE_PERCENT;
    } else if (!hasEdge) {
      finalSizePercent = 0;
    } else {
      finalSizePercent = quarterKelly * 100 * confidenceMultiplier;
    }

    // Clamp to bounds (0 is valid — means no edge)
    if (finalSizePercent > 0) {
      finalSizePercent = Math.max(KELLY_CONFIG.MIN_SIZE_PERCENT,
        Math.min(KELLY_CONFIG.MAX_SIZE_PERCENT, finalSizePercent));
    }

    return {
      winProbability: p,
      lossProbability: q,
      avgWinReturn,
      avgLossReturn,
      payoffRatio: b,
      fullKelly,
      quarterKelly,
      confidenceMultiplier,
      finalSizePercent: Math.round(finalSizePercent * 10) / 10,
      signalCount: total,
      hasEdge,
    };
  }

  /**
   * Get confidence multiplier based on sample size.
   */
  private getConfidenceMultiplier(signalCount: number): number {
    for (const tier of KELLY_CONFIG.CONFIDENCE_TIERS) {
      if (signalCount >= tier.minSignals) {
        return tier.multiplier;
      }
    }
    return 0;
  }

  /**
   * Fetch realized win/loss data from the signal_performance table.
   * Groups by signal_type to get per-type Kelly fractions.
   */
  async calculateKellyReport(): Promise<KellyReport> {
    // Check cache
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }

    try {
      const result = await pool.query(`
        SELECT
          COALESCE(signal_type, 'UNKNOWN') as signal_type,
          COUNT(*) FILTER (WHERE final_outcome IN ('WIN', 'EXPIRED_PROFIT')) as wins,
          COUNT(*) FILTER (WHERE final_outcome = 'LOSS') as losses,
          AVG(CASE WHEN final_outcome IN ('WIN', 'EXPIRED_PROFIT')
              THEN COALESCE(realized_return, final_return) END) as avg_win_return,
          AVG(CASE WHEN final_outcome = 'LOSS'
              THEN ABS(COALESCE(realized_return, final_return)) END) as avg_loss_return
        FROM signal_performance
        WHERE signal_time > NOW() - INTERVAL '${KELLY_CONFIG.LOOKBACK_DAYS} days'
          AND final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')
        GROUP BY COALESCE(signal_type, 'UNKNOWN')
      `);

      // Per-signal-type Kelly
      const perSignalType: Record<string, KellyParams> = {};
      let totalWins = 0;
      let totalLosses = 0;
      let weightedWinReturn = 0;
      let weightedLossReturn = 0;
      let winCount = 0;
      let lossCount = 0;

      for (const row of result.rows) {
        const signalType = row.signal_type;
        const wins = parseInt(row.wins) || 0;
        const losses = parseInt(row.losses) || 0;
        // Returns from DB are percentages (e.g. 150 for +150%)
        // Convert to ratios for Kelly (e.g. 1.5 for +150%)
        const avgWinReturn = (parseFloat(row.avg_win_return) || 0) / 100;
        const avgLossReturn = (parseFloat(row.avg_loss_return) || 0) / 100;

        perSignalType[signalType] = this.calculateKelly(
          wins, losses, avgWinReturn, avgLossReturn,
        );

        // Accumulate for overall calculation
        totalWins += wins;
        totalLosses += losses;
        if (wins > 0 && avgWinReturn > 0) {
          weightedWinReturn += avgWinReturn * wins;
          winCount += wins;
        }
        if (losses > 0 && avgLossReturn > 0) {
          weightedLossReturn += avgLossReturn * losses;
          lossCount += losses;
        }
      }

      // Overall Kelly
      const overallAvgWin = winCount > 0 ? weightedWinReturn / winCount : 0;
      const overallAvgLoss = lossCount > 0 ? weightedLossReturn / lossCount : 0;
      const overall = this.calculateKelly(
        totalWins, totalLosses, overallAvgWin, overallAvgLoss,
      );

      const report: KellyReport = {
        timestamp: new Date(),
        overall,
        perSignalType,
        dataSource: 'signal_performance',
      };

      // Cache
      this.cache = report;
      this.cacheExpiry = Date.now() + this.CACHE_TTL_MS;

      logger.info({
        overall: {
          p: overall.winProbability.toFixed(2),
          b: overall.payoffRatio.toFixed(2),
          fStar: overall.fullKelly.toFixed(3),
          qK: overall.quarterKelly.toFixed(3),
          final: overall.finalSizePercent,
          signals: overall.signalCount,
          edge: overall.hasEdge,
        },
      }, 'Kelly report calculated');

      return report;
    } catch (error) {
      logger.error({ error }, 'Failed to calculate Kelly report');

      // Return default report
      return {
        timestamp: new Date(),
        overall: this.calculateKelly(0, 0, 0, 0),
        perSignalType: {},
        dataSource: 'signal_performance',
      };
    }
  }

  /**
   * Get the Kelly-optimal position size for a given signal type.
   * Returns percentage of portfolio to allocate.
   */
  async getPositionSizePercent(signalType: string): Promise<number> {
    const report = await this.calculateKellyReport();

    // Use per-type Kelly if available, fall back to overall
    const params = report.perSignalType[signalType] || report.overall;

    return params.finalSizePercent;
  }

  /**
   * Apply slippage guard to position size.
   * Returns adjusted size or 0 if trade should be skipped.
   */
  applySlippageGuard(
    positionSizeUSD: number,
    liquidityUSD: number,
  ): { adjustedSize: number; skipped: boolean; expectedSlippage: number } {
    if (liquidityUSD <= 0) {
      return { adjustedSize: 0, skipped: true, expectedSlippage: 1 };
    }

    const expectedSlippage = positionSizeUSD / (liquidityUSD * 2);

    // Skip if slippage too high
    if (expectedSlippage > KELLY_CONFIG.SLIPPAGE_SKIP_THRESHOLD) {
      return { adjustedSize: 0, skipped: true, expectedSlippage };
    }

    // Reduce size if above warning threshold
    if (expectedSlippage > KELLY_CONFIG.SLIPPAGE_WARNING_THRESHOLD) {
      // Reduce to keep slippage at warning threshold
      const maxSize = liquidityUSD * 2 * KELLY_CONFIG.SLIPPAGE_WARNING_THRESHOLD;
      return {
        adjustedSize: Math.min(positionSizeUSD, maxSize),
        skipped: false,
        expectedSlippage: KELLY_CONFIG.SLIPPAGE_WARNING_THRESHOLD,
      };
    }

    return { adjustedSize: positionSizeUSD, skipped: false, expectedSlippage };
  }

  /**
   * Check if a signal type currently has edge.
   * Returns false if Kelly fraction <= 0 (no edge).
   */
  async hasEdge(signalType: string): Promise<boolean> {
    const report = await this.calculateKellyReport();
    const params = report.perSignalType[signalType];

    // If no data for this type, assume edge (default sizing)
    if (!params) return true;

    // If not enough data, assume edge (default sizing)
    if (params.signalCount < 30) return true;

    return params.hasEdge;
  }

  /**
   * Clear cache (e.g. after new performance data).
   */
  invalidateCache(): void {
    this.cache = null;
    this.cacheExpiry = 0;
  }

  /**
   * Format Kelly report for Telegram daily digest.
   */
  formatKellyReport(report: KellyReport): string {
    const o = report.overall;
    const lines: string[] = [];

    const confidenceLabel = o.signalCount >= 100 ? 'full confidence'
      : o.signalCount >= 50 ? 'high confidence'
      : o.signalCount >= 30 ? 'moderate confidence'
      : 'insufficient data';

    lines.push('📐 *KELLY STATUS*');
    lines.push(`├─ Data: ${o.signalCount} signals (${confidenceLabel})`);
    lines.push(`├─ Overall: p=${(o.winProbability * 100).toFixed(0)}%, b=${o.payoffRatio.toFixed(2)}, f*=${(o.fullKelly * 100).toFixed(1)}%, qK=${o.finalSizePercent}%`);

    // Per-type line
    const typeLabels: Record<string, string> = {
      BUY: 'BUY (KOL)',
      KOL: 'BUY (KOL)',
      ALPHA_WALLET: 'ALPHA',
      DISCOVERY: 'DISCOVERY',
      SOCIAL_DISCOVERY: 'SOCIAL',
      KOL_VALIDATION: 'KOL_VAL',
    };

    const typeParts: string[] = [];
    for (const [type, params] of Object.entries(report.perSignalType)) {
      const label = typeLabels[type] || type;
      if (params.signalCount >= 5) {
        typeParts.push(`${label}: qK=${params.finalSizePercent}%`);
      }
    }

    if (typeParts.length > 0) {
      // Split into max 2 per line
      for (let i = 0; i < typeParts.length; i += 2) {
        const chunk = typeParts.slice(i, i + 2).join(' | ');
        lines.push(`├─ ${chunk}`);
      }
    }

    const edgeEmoji = o.hasEdge ? 'POSITIVE ✅' : 'NEGATIVE ❌';
    lines.push(`└─ Edge: ${edgeEmoji}`);

    return lines.join('\n');
  }

  /**
   * Format no-edge alert for Telegram.
   */
  formatNoEdgeAlert(signalType: string): string {
    return `🚫 KELLY NO EDGE — ${signalType} paused`;
  }
}

// ============ SINGLETON EXPORT ============

export const kellySizer = new KellySizer();

export default kellySizer;
