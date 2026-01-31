// ===========================================
// MODULE: DAILY DIGEST SUMMARY (Feature 8)
// Automated daily performance summaries
// ===========================================

import * as cron from 'node-cron';
import { logger } from '../../utils/logger.js';
import { pool, Database } from '../../utils/database.js';
import { convictionTracker } from '../signals/conviction-tracker.js';
import { kolAnalytics } from '../kol/kol-analytics.js';
import type { DailyDigest } from '../../types/index.js';

// ============ CONSTANTS ============

const DEFAULT_DIGEST_HOUR = 9; // 9 AM
const SIMULATED_ENTRY_SOL = 10; // Assume 10 SOL per signal for simulation

// ============ DAILY DIGEST CLASS ============

export class DailyDigestGenerator {
  private cronJob: cron.ScheduledTask | null = null;
  private sendCallback: ((message: string) => Promise<void>) | null = null;

  /**
   * Set callback to send digest messages
   */
  onSend(callback: (message: string) => Promise<void>): void {
    this.sendCallback = callback;
  }

  /**
   * Start the daily digest scheduler
   */
  start(hour: number = DEFAULT_DIGEST_HOUR): void {
    if (this.cronJob) {
      this.cronJob.stop();
    }

    // Schedule at specified hour daily
    const cronExpression = `0 ${hour} * * *`;

    this.cronJob = cron.schedule(cronExpression, async () => {
      logger.info('Running scheduled daily digest');
      await this.generateAndSend();
    });

    logger.info({ hour, cronExpression }, 'Daily digest scheduler started');
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    logger.info('Daily digest scheduler stopped');
  }

  /**
   * Generate and send the daily digest
   */
  async generateAndSend(): Promise<void> {
    try {
      const digest = await this.generateDigest();
      const message = this.formatDigestMessage(digest);

      // Save to database
      await this.saveDigest(digest);

      // Send via callback
      if (this.sendCallback) {
        await this.sendCallback(message);
      }

      logger.info({
        signalsSent: digest.signalsSent,
        winRate: (digest.winRate * 100).toFixed(1),
      }, 'Daily digest sent');
    } catch (error) {
      logger.error({ error }, 'Failed to generate daily digest');
    }
  }

  /**
   * Generate digest for yesterday's activity
   */
  async generateDigest(): Promise<DailyDigest> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get signals from yesterday
    const signalsResult = await pool.query(
      `SELECT * FROM signal_log
       WHERE sent_at >= $1 AND sent_at < $2
       ORDER BY sent_at DESC`,
      [yesterday, today]
    );

    const signals = signalsResult.rows;
    const signalsSent = signals.length;

    // Get positions with outcomes
    const positionsResult = await pool.query(
      `SELECT p.*, sl.kol_handle
       FROM positions p
       LEFT JOIN signal_log sl ON p.signal_id::text = sl.id::text
       WHERE p.entry_timestamp >= $1 AND p.entry_timestamp < $2`,
      [yesterday, today]
    );

    const positions = positionsResult.rows;

    // Calculate winners/losers
    let winners = 0;
    let losers = 0;
    let neutral = 0;
    let totalRoi = 0;
    let bestRoi = -Infinity;
    let worstRoi = Infinity;
    let bestToken: any = null;
    let worstToken: any = null;

    for (const pos of positions) {
      const roi = pos.realized_pnl
        ? (parseFloat(pos.realized_pnl) / parseFloat(pos.entry_price)) * 100
        : pos.current_price && pos.entry_price
          ? ((parseFloat(pos.current_price) - parseFloat(pos.entry_price)) / parseFloat(pos.entry_price)) * 100
          : 0;

      totalRoi += roi;

      if (roi >= 100) {
        winners++;
      } else if (roi <= -50) {
        losers++;
      } else {
        neutral++;
      }

      if (roi > bestRoi) {
        bestRoi = roi;
        bestToken = pos;
      }
      if (roi < worstRoi) {
        worstRoi = roi;
        worstToken = pos;
      }
    }

    const winRate = positions.length > 0 ? winners / positions.length : 0;

    // Calculate top KOL for the day
    const kolPerformance = new Map<string, { wins: number; total: number }>();
    for (const pos of positions) {
      const kolHandle = pos.kol_handle || 'Unknown';
      if (!kolPerformance.has(kolHandle)) {
        kolPerformance.set(kolHandle, { wins: 0, total: 0 });
      }

      const perf = kolPerformance.get(kolHandle)!;
      perf.total++;

      const roi = pos.realized_pnl
        ? (parseFloat(pos.realized_pnl) / parseFloat(pos.entry_price)) * 100
        : 0;
      if (roi >= 100) {
        perf.wins++;
      }
    }

    let topKol: { handle: string; wins: number; total: number } | null = null;
    let maxWins = 0;
    for (const [handle, perf] of kolPerformance) {
      if (perf.wins > maxWins) {
        maxWins = perf.wins;
        topKol = { handle, ...perf };
      }
    }

    // Calculate simulated P&L
    const entrySol = signalsSent * SIMULATED_ENTRY_SOL;
    const avgRoi = positions.length > 0 ? totalRoi / positions.length : 0;
    const currentSol = entrySol * (1 + avgRoi / 100);

    // Get high conviction tokens
    const highConvictionTokens = await convictionTracker.getHighConvictionTokensWithDetails(2);

    return {
      date: yesterday,
      signalsSent,
      winners,
      losers,
      neutral,
      winRate,
      bestPerformer: bestToken && bestRoi > -Infinity ? {
        token: bestToken.token_address,
        ticker: bestToken.token_ticker || '',
        roi: bestRoi,
      } : null,
      worstPerformer: worstToken && worstRoi < Infinity ? {
        token: worstToken.token_address,
        ticker: worstToken.token_ticker || '',
        roi: worstRoi,
      } : null,
      topKol,
      simulatedPnl: {
        entrySol,
        currentSol,
        roi: avgRoi,
      },
      highConvictionTokens: highConvictionTokens.map(c => ({
        tokenAddress: c.tokenAddress,
        ticker: '', // Would need to look up
        kolCount: c.level,
      })),
    };
  }

  /**
   * Format digest message for Telegram
   */
  formatDigestMessage(digest: DailyDigest): string {
    const dateStr = digest.date.toISOString().split('T')[0];

    let msg = `*DAILY ROSSYBOT DIGEST - ${dateStr}*\n\n`;

    // Signal summary
    msg += `*Signals Sent:* ${digest.signalsSent}\n`;
    msg += `*Winners (>2x):* ${digest.winners} (${(digest.winRate * 100).toFixed(0)}%)\n`;
    msg += `*Losers (<0.5x):* ${digest.losers}\n`;

    // Best performer
    if (digest.bestPerformer) {
      const ticker = digest.bestPerformer.ticker || digest.bestPerformer.token.slice(0, 6);
      msg += `*Best Performer:* $${ticker} (+${digest.bestPerformer.roi.toFixed(0)}%)\n`;
    }

    msg += '\n';

    // Top KOL
    if (digest.topKol) {
      msg += `*Top KOL Today:* ${digest.topKol.handle} (${digest.topKol.wins}/${digest.topKol.total} wins)\n`;
    }

    msg += '\n';

    // Simulated P&L
    const pnlEmoji = digest.simulatedPnl.roi >= 0 ? '' : '';
    msg += `*Simulated P&L (if all signals traded):*\n`;
    msg += `   Entry: ${digest.simulatedPnl.entrySol.toFixed(1)} SOL\n`;
    msg += `   Current: ${digest.simulatedPnl.currentSol.toFixed(1)} SOL\n`;
    msg += `   ROI: ${pnlEmoji} ${digest.simulatedPnl.roi >= 0 ? '+' : ''}${digest.simulatedPnl.roi.toFixed(0)}%\n`;

    // High conviction tokens
    if (digest.highConvictionTokens.length > 0) {
      msg += '\n*High Conviction Tokens (2+ KOLs):*\n';
      for (const token of digest.highConvictionTokens.slice(0, 5)) {
        const ticker = token.ticker || token.tokenAddress.slice(0, 6);
        msg += `   - $${ticker} - ${token.kolCount} KOLs bought\n`;
      }
    }

    return msg;
  }

  /**
   * Save digest to database
   */
  private async saveDigest(digest: DailyDigest): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO daily_stats (
          date, signals_sent, winners, losers, neutral,
          best_performer_token, best_performer_ticker, best_performer_roi,
          worst_performer_token, worst_performer_ticker, worst_performer_roi,
          top_kol_handle, top_kol_wins, top_kol_total,
          simulated_entry_sol, simulated_current_sol,
          high_conviction_tokens
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (date) DO UPDATE SET
          signals_sent = EXCLUDED.signals_sent,
          winners = EXCLUDED.winners,
          losers = EXCLUDED.losers,
          neutral = EXCLUDED.neutral,
          best_performer_token = EXCLUDED.best_performer_token,
          best_performer_ticker = EXCLUDED.best_performer_ticker,
          best_performer_roi = EXCLUDED.best_performer_roi,
          worst_performer_token = EXCLUDED.worst_performer_token,
          worst_performer_ticker = EXCLUDED.worst_performer_ticker,
          worst_performer_roi = EXCLUDED.worst_performer_roi,
          top_kol_handle = EXCLUDED.top_kol_handle,
          top_kol_wins = EXCLUDED.top_kol_wins,
          top_kol_total = EXCLUDED.top_kol_total,
          simulated_entry_sol = EXCLUDED.simulated_entry_sol,
          simulated_current_sol = EXCLUDED.simulated_current_sol,
          high_conviction_tokens = EXCLUDED.high_conviction_tokens,
          updated_at = NOW()`,
        [
          digest.date,
          digest.signalsSent,
          digest.winners,
          digest.losers,
          digest.neutral,
          digest.bestPerformer?.token || null,
          digest.bestPerformer?.ticker || null,
          digest.bestPerformer?.roi || null,
          digest.worstPerformer?.token || null,
          digest.worstPerformer?.ticker || null,
          digest.worstPerformer?.roi || null,
          digest.topKol?.handle || null,
          digest.topKol?.wins || null,
          digest.topKol?.total || null,
          digest.simulatedPnl.entrySol,
          digest.simulatedPnl.currentSol,
          JSON.stringify(digest.highConvictionTokens),
        ]
      );
    } catch (error) {
      logger.warn({ error }, 'Failed to save daily digest to DB');
    }
  }

  /**
   * Get historical digests
   */
  async getHistoricalDigests(days: number = 7): Promise<DailyDigest[]> {
    try {
      const result = await pool.query(
        `SELECT * FROM daily_stats
         ORDER BY date DESC
         LIMIT $1`,
        [days]
      );

      return result.rows.map(row => ({
        date: new Date(row.date),
        signalsSent: row.signals_sent,
        winners: row.winners,
        losers: row.losers,
        neutral: row.neutral,
        winRate: row.signals_sent > 0 ? row.winners / row.signals_sent : 0,
        bestPerformer: row.best_performer_token ? {
          token: row.best_performer_token,
          ticker: row.best_performer_ticker || '',
          roi: parseFloat(row.best_performer_roi),
        } : null,
        worstPerformer: row.worst_performer_token ? {
          token: row.worst_performer_token,
          ticker: row.worst_performer_ticker || '',
          roi: parseFloat(row.worst_performer_roi),
        } : null,
        topKol: row.top_kol_handle ? {
          handle: row.top_kol_handle,
          wins: row.top_kol_wins,
          total: row.top_kol_total,
        } : null,
        simulatedPnl: {
          entrySol: parseFloat(row.simulated_entry_sol),
          currentSol: parseFloat(row.simulated_current_sol),
          roi: row.simulated_entry_sol > 0
            ? ((row.simulated_current_sol - row.simulated_entry_sol) / row.simulated_entry_sol) * 100
            : 0,
        },
        highConvictionTokens: row.high_conviction_tokens || [],
      }));
    } catch (error) {
      logger.warn({ error }, 'Failed to get historical digests');
      return [];
    }
  }
}

// ============ EXPORTS ============

export const dailyDigestGenerator = new DailyDigestGenerator();

export default {
  DailyDigestGenerator,
  dailyDigestGenerator,
  DEFAULT_DIGEST_HOUR,
};
