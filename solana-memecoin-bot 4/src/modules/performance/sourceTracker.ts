// ===========================================
// MODULE: SOURCE-LEVEL EV TRACKING
// Tracks which discovery sources produce the best EV.
// Auto-demotes bad sources and boosts good ones.
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';

// ============ TYPES ============

export type DiscoverySource =
  | 'DEXSCREENER_BOOSTED'
  | 'DEXSCREENER_PROFILES'
  | 'JUPITER_NEW'
  | 'GMGN_TRENDING'
  | 'GMGN_PULLBACK'
  | 'ALPHA_WALLETS'
  | 'PUMPFUN_DEV'
  | 'KOL'
  | 'DISCOVERY'
  | 'ONCHAIN'
  | 'UNKNOWN';

export interface SourceStats {
  source: DiscoverySource;
  signalCount: number;
  winRate: number;
  evPerSignal: number;
  avgRealizedReturn: number;
  bestSignal: { token: string; returnPct: number } | null;
  worstSignal: { token: string; returnPct: number } | null;
  scoreAdjustment: number; // Current bonus/penalty applied
  status: 'ACTIVE' | 'DEMOTED' | 'DISABLED' | 'BOOSTED';
}

// ============ CONFIGURATION ============

const CONFIG = {
  ROLLING_WINDOW_DAYS: 14,

  // Auto-action thresholds
  DEMOTE_EV_THRESHOLD: -10,    // EV < -10% over 14d + 20 signals → demote (-5 score)
  DISABLE_EV_THRESHOLD: -20,   // EV < -20% over 14d + 30 signals → disable
  BOOST_EV_THRESHOLD: 25,      // EV > +25% over 14d → boost (+5 score)

  DEMOTE_MIN_SIGNALS: 20,
  DISABLE_MIN_SIGNALS: 30,

  DEMOTE_SCORE_PENALTY: -5,
  BOOST_SCORE_BONUS: 5,
} as const;

// ============ SOURCE TRACKER CLASS ============

export class SourceTracker {
  // In-memory score adjustments (persist to DB)
  private scoreAdjustments: Map<string, number> = new Map();
  private disabledSources: Set<string> = new Set();

  /**
   * Initialize: load state from DB.
   */
  async initialize(): Promise<void> {
    await this.ensureTable();
    await this.loadState();
    logger.info('Source tracker initialized');
  }

  /**
   * Get the score adjustment for a discovery source.
   * Returns bonus (+5) or penalty (-5) to add to signal score.
   */
  getScoreAdjustment(source: string): number {
    return this.scoreAdjustments.get(source) || 0;
  }

  /**
   * Check if a source is disabled.
   */
  isSourceDisabled(source: string): boolean {
    return this.disabledSources.has(source);
  }

  /**
   * Re-enable a disabled source (via Telegram command).
   */
  enableSource(source: string): void {
    this.disabledSources.delete(source);
    this.scoreAdjustments.delete(source);
    logger.info({ source }, 'Source re-enabled');
  }

  /**
   * Calculate source-level stats from the performance database.
   * Uses realized_return (canonical) when available, falls back to final_return.
   */
  async calculateSourceStats(): Promise<SourceStats[]> {
    try {
      const result = await pool.query(`
        SELECT
          COALESCE(signal_type, 'UNKNOWN') as source,
          COUNT(*) as signal_count,
          COUNT(*) FILTER (WHERE final_outcome IN ('WIN', 'EXPIRED_PROFIT')) as wins,
          AVG(COALESCE(realized_return, final_return)) as avg_return,
          MAX(COALESCE(realized_return, final_return)) as best_return,
          MIN(COALESCE(realized_return, final_return)) as worst_return,
          token_ticker
        FROM signal_performance
        WHERE signal_time > NOW() - INTERVAL '${CONFIG.ROLLING_WINDOW_DAYS} days'
          AND final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')
        GROUP BY COALESCE(signal_type, 'UNKNOWN'), token_ticker
        ORDER BY source
      `);

      // Aggregate per source
      const sourceMap = new Map<string, {
        signals: number;
        wins: number;
        returns: number[];
        best: { token: string; ret: number };
        worst: { token: string; ret: number };
      }>();

      for (const row of result.rows) {
        const source = row.source;
        const ret = parseFloat(row.avg_return) || 0;

        if (!sourceMap.has(source)) {
          sourceMap.set(source, {
            signals: 0,
            wins: 0,
            returns: [],
            best: { token: '', ret: -Infinity },
            worst: { token: '', ret: Infinity },
          });
        }

        const stats = sourceMap.get(source)!;
        stats.signals += parseInt(row.signal_count);
        stats.wins += parseInt(row.wins);
        stats.returns.push(ret);

        const bestRet = parseFloat(row.best_return) || 0;
        const worstRet = parseFloat(row.worst_return) || 0;
        if (bestRet > stats.best.ret) {
          stats.best = { token: row.token_ticker || 'unknown', ret: bestRet };
        }
        if (worstRet < stats.worst.ret) {
          stats.worst = { token: row.token_ticker || 'unknown', ret: worstRet };
        }
      }

      const results: SourceStats[] = [];

      for (const [source, data] of sourceMap) {
        const evPerSignal = data.returns.length > 0
          ? data.returns.reduce((a, b) => a + b, 0) / data.returns.length
          : 0;

        const adjustment = this.scoreAdjustments.get(source) || 0;
        const disabled = this.disabledSources.has(source);

        let status: SourceStats['status'] = 'ACTIVE';
        if (disabled) status = 'DISABLED';
        else if (adjustment > 0) status = 'BOOSTED';
        else if (adjustment < 0) status = 'DEMOTED';

        results.push({
          source: source as DiscoverySource,
          signalCount: data.signals,
          winRate: data.signals > 0 ? (data.wins / data.signals) * 100 : 0,
          evPerSignal,
          avgRealizedReturn: evPerSignal,
          bestSignal: data.best.ret > -Infinity
            ? { token: data.best.token, returnPct: data.best.ret }
            : null,
          worstSignal: data.worst.ret < Infinity
            ? { token: data.worst.token, returnPct: data.worst.ret }
            : null,
          scoreAdjustment: adjustment,
          status,
        });
      }

      return results.sort((a, b) => b.evPerSignal - a.evPerSignal);
    } catch (error) {
      logger.error({ error }, 'Failed to calculate source stats');
      return [];
    }
  }

  /**
   * Run auto-actions based on source performance.
   * Returns alerts to send via Telegram.
   */
  async runAutoActions(): Promise<string[]> {
    const alerts: string[] = [];
    const stats = await this.calculateSourceStats();

    for (const source of stats) {
      // Skip sources with insufficient data
      if (source.signalCount < CONFIG.DEMOTE_MIN_SIGNALS) continue;

      // Check for disable (worst case)
      if (source.evPerSignal < CONFIG.DISABLE_EV_THRESHOLD &&
          source.signalCount >= CONFIG.DISABLE_MIN_SIGNALS &&
          source.status !== 'DISABLED') {
        this.disabledSources.add(source.source);
        this.scoreAdjustments.set(source.source, CONFIG.DEMOTE_SCORE_PENALTY);
        alerts.push(
          `🚫 Source ${source.source} has ${source.evPerSignal.toFixed(1)}% EV over ${source.signalCount} signals. Disabling.`
        );
        logger.warn({ source: source.source, ev: source.evPerSignal }, 'Source disabled due to negative EV');
      }
      // Check for demote
      else if (source.evPerSignal < CONFIG.DEMOTE_EV_THRESHOLD &&
               source.status !== 'DISABLED' && source.status !== 'DEMOTED') {
        this.scoreAdjustments.set(source.source, CONFIG.DEMOTE_SCORE_PENALTY);
        alerts.push(
          `⚠️ Source ${source.source} has ${source.evPerSignal.toFixed(1)}% EV over ${source.signalCount} signals. Demoting.`
        );
        logger.info({ source: source.source, ev: source.evPerSignal }, 'Source demoted');
      }
      // Check for boost
      else if (source.evPerSignal > CONFIG.BOOST_EV_THRESHOLD &&
               source.status !== 'BOOSTED') {
        this.scoreAdjustments.set(source.source, CONFIG.BOOST_SCORE_BONUS);
        alerts.push(
          `✅ Source ${source.source} performing well (+${source.evPerSignal.toFixed(1)}% EV). Boosted.`
        );
        logger.info({ source: source.source, ev: source.evPerSignal }, 'Source boosted');
      }
      // Reset if performance recovered
      else if (source.evPerSignal >= 0 && source.status === 'DEMOTED') {
        this.scoreAdjustments.delete(source.source);
        alerts.push(
          `🔄 Source ${source.source} recovered (${source.evPerSignal.toFixed(1)}% EV). Reset to normal.`
        );
      }
    }

    // Persist state
    if (alerts.length > 0) {
      await this.saveState();
    }

    return alerts;
  }

  /**
   * Format source stats for the daily Telegram report.
   */
  formatDailyReport(stats: SourceStats[]): string {
    if (stats.length === 0) return '';

    let msg = '📊 *SOURCE PERFORMANCE*\n';
    for (const s of stats) {
      const statusEmoji = s.status === 'BOOSTED' ? '✅' :
                          s.status === 'DEMOTED' ? '⚠️' :
                          s.status === 'DISABLED' ? '🚫' : '📌';
      msg += `${statusEmoji} ${s.source}: ${s.evPerSignal.toFixed(1)}% EV | ${s.signalCount} signals | ${s.winRate.toFixed(0)}% WR\n`;
    }
    return msg;
  }

  // ============ PERSISTENCE ============

  private async ensureTable(): Promise<void> {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS source_tracker_state (
          id INTEGER PRIMARY KEY DEFAULT 1,
          score_adjustments JSONB DEFAULT '{}',
          disabled_sources JSONB DEFAULT '[]',
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
    } catch (error) {
      logger.error({ error }, 'Failed to create source tracker table');
    }
  }

  private async saveState(): Promise<void> {
    try {
      const adjustments = Object.fromEntries(this.scoreAdjustments);
      const disabled = [...this.disabledSources];

      await pool.query(`
        INSERT INTO source_tracker_state (id, score_adjustments, disabled_sources, updated_at)
        VALUES (1, $1, $2, NOW())
        ON CONFLICT (id) DO UPDATE SET
          score_adjustments = $1,
          disabled_sources = $2,
          updated_at = NOW()
      `, [JSON.stringify(adjustments), JSON.stringify(disabled)]);
    } catch (error) {
      logger.error({ error }, 'Failed to save source tracker state');
    }
  }

  private async loadState(): Promise<void> {
    try {
      const result = await pool.query(`
        SELECT score_adjustments, disabled_sources FROM source_tracker_state WHERE id = 1
      `);

      if (result.rows.length > 0) {
        const row = result.rows[0];
        if (row.score_adjustments) {
          for (const [key, value] of Object.entries(row.score_adjustments)) {
            this.scoreAdjustments.set(key, value as number);
          }
        }
        if (row.disabled_sources && Array.isArray(row.disabled_sources)) {
          for (const source of row.disabled_sources) {
            this.disabledSources.add(source);
          }
        }
      }
    } catch {
      // Table may not exist yet
    }
  }
}

// ============ EXPORTS ============

export const sourceTracker = new SourceTracker();

export default {
  SourceTracker,
  sourceTracker,
};
