// ===========================================
// ALPHA WALLET ENGINE — WALLET PERFORMANCE MANAGEMENT
// Tracks per-wallet EV, adjusts weight multipliers, handles probation/suspension
// Runs as part of the daily optimizer cycle
// ===========================================

import { logger } from '../utils/logger.js';
import { Database } from '../utils/database.js';
import { walletEngine, EngineWallet } from './walletEngine.js';
import { WALLET_ENGINE_CONFIG } from '../config/walletEngine.js';

// ============ TYPES ============

export interface WalletPerformanceReport {
  totalActive: number;
  totalCandidates: number;
  totalSuspended: number;
  signalsToday: number;
  todayEv: number;
  topPerformers: EngineWallet[];
  underperformers: EngineWallet[];
  graduatedToday: EngineWallet[];
  candidateAvgTrades: number;
}

// ============ PERFORMANCE MANAGER CLASS ============

export class WalletPerformanceManager {
  /**
   * Run daily performance review for all active wallets.
   * Call this from the daily auto-optimizer at 6 AM AEDT.
   */
  async runDailyReview(): Promise<WalletPerformanceReport> {
    logger.info('WalletPerformance: Running daily review');

    const activeWallets = await walletEngine.getActiveWallets();
    const probationWallets = (await Database.getEngineWalletsByStatus('PROBATION'))
      .map((row: any) => this.mapRow(row));

    // Process active wallets
    for (const wallet of activeWallets) {
      try {
        await this.reviewWallet(wallet);
      } catch (error) {
        logger.warn({ error, wallet: wallet.walletAddress.slice(0, 8) }, 'WalletPerformance: Error reviewing wallet');
      }
    }

    // Process probation wallets
    for (const wallet of probationWallets) {
      try {
        await this.reviewProbationWallet(wallet);
      } catch (error) {
        logger.warn({ error, wallet: wallet.walletAddress.slice(0, 8) }, 'WalletPerformance: Error reviewing probation wallet');
      }
    }

    // Clean expired cooldowns
    const cleaned = await Database.cleanExpiredCooldowns();
    if (cleaned > 0) {
      logger.info({ cleaned }, 'WalletPerformance: Cleaned expired cooldowns');
    }

    // Build report
    return this.buildReport();
  }

  /**
   * Review a single active wallet and adjust weight
   */
  private async reviewWallet(wallet: EngineWallet): Promise<void> {
    // Recalculate stats from signal results
    await this.recalculateSignalStats(wallet);

    // Re-fetch after stat update
    const updated = await walletEngine.getWalletById(wallet.id);
    if (!updated) return;

    const cfg = WALLET_ENGINE_CONFIG;

    if (updated.totalSignals < cfg.MIN_SIGNALS_FOR_WEIGHT_ADJUST) {
      return; // Not enough data yet
    }

    let newWeight = updated.weight;
    let newStatus: 'ACTIVE' | 'PROBATION' = 'ACTIVE';
    let reason = '';

    // Tier 1: Proven performer
    if (updated.last30dEv > cfg.TIER1_MIN_EV && updated.signalWinRate > cfg.TIER1_MIN_WIN_RATE) {
      newWeight = Math.min(cfg.TIER1_MAX_WEIGHT, updated.weight + cfg.WEIGHT_INCREASE_STEP);
      reason = `Tier 1: EV ${updated.last30dEv.toFixed(1)}%, WR ${(updated.signalWinRate * 100).toFixed(1)}%`;
    }
    // Tier 2: Decent performer
    else if (updated.last30dEv > cfg.TIER2_MIN_EV && updated.signalWinRate > cfg.TIER2_MIN_WIN_RATE) {
      newWeight = Math.min(cfg.TIER2_MAX_WEIGHT, updated.weight + cfg.WEIGHT_INCREASE_STEP / 2);
      reason = `Tier 2: EV ${updated.last30dEv.toFixed(1)}%, WR ${(updated.signalWinRate * 100).toFixed(1)}%`;
    }
    // Tier 3: Underperforming
    else if (updated.last30dEv < cfg.TIER3_MAX_EV && updated.totalSignals >= cfg.TIER3_MIN_SIGNALS) {
      newWeight = Math.max(cfg.WEIGHT_MIN, updated.weight - cfg.WEIGHT_DECREASE_STEP);
      reason = `Tier 3: EV ${updated.last30dEv.toFixed(1)}%, demoting weight`;
    }
    // Tier 4: Clearly no edge
    else if (updated.last30dEv < cfg.TIER4_MAX_EV && updated.totalSignals >= cfg.TIER4_MIN_SIGNALS) {
      newStatus = 'PROBATION';
      newWeight = cfg.WEIGHT_MIN;
      reason = `Tier 4: EV ${updated.last30dEv.toFixed(1)}% — PROBATION`;
    }

    // Losing streak circuit breaker
    if (updated.currentStreak <= -cfg.LOSING_STREAK_THRESHOLD) {
      newStatus = 'PROBATION';
      newWeight = cfg.WEIGHT_MIN;
      reason = `${Math.abs(updated.currentStreak)} consecutive losses — PROBATION`;
    }

    // Apply changes
    if (newStatus === 'PROBATION') {
      await walletEngine.suspendWallet(updated.id, reason);
    } else if (Math.abs(newWeight - updated.weight) > 0.01) {
      await Database.updateEngineWalletStats(updated.id, { weight: newWeight });
      logger.debug({
        wallet: updated.walletAddress.slice(0, 8),
        oldWeight: updated.weight.toFixed(2),
        newWeight: newWeight.toFixed(2),
        reason,
      }, 'WalletPerformance: Weight adjusted');
    }
  }

  /**
   * Review a probation wallet — reinstate or suspend
   */
  private async reviewProbationWallet(wallet: EngineWallet): Promise<void> {
    if (!wallet.probationStart) return;

    const cfg = WALLET_ENGINE_CONFIG;
    const daysSinceProbation = (Date.now() - new Date(wallet.probationStart).getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceProbation < cfg.PROBATION_DURATION_DAYS) {
      return; // Still in probation window
    }

    // Recalculate stats for the probation period
    await this.recalculateSignalStats(wallet);
    const updated = await walletEngine.getWalletById(wallet.id);
    if (!updated) return;

    // Calculate EV during probation period
    const probationSignals = await Database.getEngineSignalsForWallet(wallet.id, cfg.PROBATION_DURATION_DAYS);
    const completedSignals = probationSignals.filter((s: any) => s.realized_return !== null);
    const probationEv = completedSignals.length > 0
      ? completedSignals.reduce((sum: number, s: any) => sum + parseFloat(s.realized_return || '0'), 0) / completedSignals.length
      : 0;

    if (probationEv > 0) {
      // Recovered — reinstate at cautious weight
      await Database.updateEngineWalletStatus(wallet.id, 'ACTIVE', {
        weight: 0.75,
        probation_start: null,
      });
      logger.info({
        wallet: wallet.walletAddress.slice(0, 8),
        probationEv: probationEv.toFixed(1),
      }, 'WalletPerformance: Wallet reinstated from probation');
    } else {
      // Failed to recover — fully suspend
      await walletEngine.fullSuspendWallet(wallet.id, `Failed probation: EV ${probationEv.toFixed(1)}%`);
    }
  }

  /**
   * Recalculate signal-based stats for a wallet from the signals table
   */
  private async recalculateSignalStats(wallet: EngineWallet): Promise<void> {
    const signals = await Database.getEngineSignalsForWallet(wallet.id, 30);
    const completed = signals.filter((s: any) => s.realized_return !== null && s.outcome !== null);

    if (completed.length === 0) return;

    const wins = completed.filter((s: any) => s.outcome === 'WIN');
    const losses = completed.filter((s: any) => s.outcome === 'LOSS');
    const totalSignals = completed.length;
    const winRate = totalSignals > 0 ? wins.length / totalSignals : 0;

    const avgReturn = completed.reduce((sum: number, s: any) => sum + parseFloat(s.realized_return || '0'), 0) / totalSignals;
    const avgWin = wins.length > 0
      ? wins.reduce((sum: number, s: any) => sum + parseFloat(s.realized_return || '0'), 0) / wins.length
      : 0;
    const avgLoss = losses.length > 0
      ? losses.reduce((sum: number, s: any) => sum + parseFloat(s.realized_return || '0'), 0) / losses.length
      : 0;

    // Calculate Kelly criterion
    const kellyF = winRate > 0 && avgLoss !== 0
      ? winRate - ((1 - winRate) / (Math.abs(avgWin / avgLoss) || 1))
      : 0;

    // Calculate current streak
    let streak = 0;
    const sortedSignals = completed.sort((a: any, b: any) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    if (sortedSignals.length > 0) {
      const firstOutcome = sortedSignals[0].outcome;
      streak = firstOutcome === 'WIN' ? 1 : -1;
      for (let i = 1; i < sortedSignals.length; i++) {
        if (sortedSignals[i].outcome === firstOutcome) {
          streak += firstOutcome === 'WIN' ? 1 : -1;
        } else {
          break;
        }
      }
    }

    await Database.updateEngineWalletStats(wallet.id, {
      total_signals: totalSignals,
      signal_win_rate: winRate,
      signal_ev: avgReturn,
      signal_avg_win: avgWin,
      signal_avg_loss: avgLoss,
      signal_kelly_f: kellyF,
      current_streak: streak,
      last_30d_ev: avgReturn,
    });
  }

  /**
   * Build the daily wallet performance report
   */
  private async buildReport(): Promise<WalletPerformanceReport> {
    const counts = await walletEngine.getWalletCounts();

    const activeWallets = await walletEngine.getActiveWallets();

    // Sort by EV for top/bottom performers
    const sorted = [...activeWallets].sort((a, b) => b.last30dEv - a.last30dEv);
    const topPerformers = sorted.slice(0, 3);
    const underperformers = sorted.filter(w => w.last30dEv < 0).slice(-2);

    // Candidates stats
    const candidates = await walletEngine.getCandidates();
    const candidateAvgTrades = candidates.length > 0
      ? candidates.reduce((sum, c) => sum + c.observedTrades, 0) / candidates.length
      : 0;

    // Today's signals
    const todaySignals = await this.getTodaySignals();
    const signalsToday = todaySignals.length;
    const todayEv = signalsToday > 0
      ? todaySignals.reduce((sum: number, s: any) => sum + (parseFloat(s.realized_return) || 0), 0) / signalsToday
      : 0;

    return {
      totalActive: counts.active,
      totalCandidates: counts.candidates,
      totalSuspended: counts.suspended,
      signalsToday,
      todayEv,
      topPerformers,
      underperformers,
      graduatedToday: [], // Could track this with a graduated_at check
      candidateAvgTrades,
    };
  }

  private async getTodaySignals(): Promise<any[]> {
    const result = await Database.getEngineSignalsForWallet(0, 1); // This won't work for "all wallets"
    // Use direct query instead
    try {
      const { pool } = await import('../utils/database.js');
      const result = await pool.query(
        `SELECT * FROM engine_wallet_signals WHERE created_at > NOW() - INTERVAL '24 hours'`
      );
      return result.rows;
    } catch {
      return [];
    }
  }

  /**
   * Format the daily wallet report for Telegram
   */
  async formatDailyReport(): Promise<string> {
    const report = await this.buildReport();

    let msg = `*ALPHA WALLET STATUS*\n`;
    msg += `Active: ${report.totalActive} wallets | Candidates: ${report.totalCandidates} | Suspended: ${report.totalSuspended}\n`;
    msg += `Wallet signals today: ${report.signalsToday} | EV: ${report.todayEv >= 0 ? '+' : ''}${report.todayEv.toFixed(1)}%\n\n`;

    if (report.topPerformers.length > 0) {
      msg += `*TOP PERFORMERS (30d)*\n`;
      for (const w of report.topPerformers) {
        const addr = `${w.walletAddress.slice(0, 6)}...${w.walletAddress.slice(-4)}`;
        msg += `  \`${addr}\`: w=${w.weight.toFixed(1)}, ${w.totalSignals} signals, ${w.last30dEv >= 0 ? '+' : ''}${w.last30dEv.toFixed(0)}% EV, ${(w.signalWinRate * 100).toFixed(0)}% WR\n`;
      }
      msg += '\n';
    }

    if (report.underperformers.length > 0) {
      msg += `*UNDERPERFORMING*\n`;
      for (const w of report.underperformers) {
        const addr = `${w.walletAddress.slice(0, 6)}...${w.walletAddress.slice(-4)}`;
        msg += `  \`${addr}\`: w=${w.weight.toFixed(1)}, ${w.totalSignals} signals, ${w.last30dEv.toFixed(0)}% EV\n`;
      }
      msg += '\n';
    }

    msg += `*CANDIDATES:* ${report.totalCandidates} observing (avg ${report.candidateAvgTrades.toFixed(1)} trades observed)`;

    return msg;
  }

  // ============ UTILS ============

  private mapRow(row: any): EngineWallet {
    return {
      id: row.id,
      walletAddress: row.wallet_address,
      status: row.status,
      source: row.source,
      weight: parseFloat(row.weight) || 1.0,
      addedAt: row.added_at,
      graduatedAt: row.graduated_at,
      suspendedAt: row.suspended_at,
      probationStart: row.probation_start,
      discoveredFromToken: row.discovered_from_token,
      coTradeCount: row.co_trade_count || 0,
      winnerScanAppearances: row.winner_scan_appearances || 0,
      observedTrades: row.observed_trades || 0,
      observedWinRate: parseFloat(row.observed_win_rate) || 0,
      observedEv: parseFloat(row.observed_ev) || 0,
      observedAvgMcap: parseFloat(row.observed_avg_mcap) || 0,
      observedAvgHoldMin: parseFloat(row.observed_avg_hold_min) || 0,
      totalSignals: row.total_signals || 0,
      signalWinRate: parseFloat(row.signal_win_rate) || 0,
      signalEv: parseFloat(row.signal_ev) || 0,
      signalAvgWin: parseFloat(row.signal_avg_win) || 0,
      signalAvgLoss: parseFloat(row.signal_avg_loss) || 0,
      signalKellyF: parseFloat(row.signal_kelly_f) || 0,
      currentStreak: row.current_streak || 0,
      last30dEv: parseFloat(row.last_30d_ev) || 0,
      updatedAt: row.updated_at,
    };
  }
}

// Singleton export
export const walletPerformanceManager = new WalletPerformanceManager();

export default walletPerformanceManager;
