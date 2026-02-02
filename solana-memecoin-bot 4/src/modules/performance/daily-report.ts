// ===========================================
// MODULE: DAILY PERFORMANCE REPORT
// Generates and sends daily performance summaries to Telegram
// ===========================================

import { logger } from '../../utils/logger.js';
import { signalPerformanceTracker, PerformanceStats } from './signal-performance-tracker.js';
import { thresholdOptimizer } from './threshold-optimizer.js';

// ============ TYPES ============

export interface DailyReport {
  date: Date;
  periodHours: number;

  // Summary stats
  stats: PerformanceStats;

  // Threshold optimization
  optimizationSummary: string;

  // Formatted message
  telegramMessage: string;
}

// ============ DAILY REPORT GENERATOR ============

export class DailyReportGenerator {
  private reportTimer: NodeJS.Timeout | null = null;
  private sendReport: ((message: string) => Promise<void>) | null = null;

  /**
   * Initialize the report generator with Telegram callback
   */
  initialize(sendReportCallback: (message: string) => Promise<void>): void {
    this.sendReport = sendReportCallback;
    logger.info('Daily report generator initialized');
  }

  /**
   * Schedule daily reports at a specific hour (UTC)
   */
  scheduleDaily(hourUTC: number = 9): void {
    if (this.reportTimer) {
      clearTimeout(this.reportTimer);
    }

    const scheduleNextReport = () => {
      const now = new Date();
      const nextReport = new Date();

      nextReport.setUTCHours(hourUTC, 0, 0, 0);

      // If we've passed today's report time, schedule for tomorrow
      if (nextReport <= now) {
        nextReport.setDate(nextReport.getDate() + 1);
      }

      const msUntilReport = nextReport.getTime() - now.getTime();

      this.reportTimer = setTimeout(async () => {
        await this.generateAndSendReport();
        scheduleNextReport(); // Schedule next one
      }, msUntilReport);

      logger.info({
        nextReport: nextReport.toISOString(),
        hoursUntil: (msUntilReport / (1000 * 60 * 60)).toFixed(1)
      }, 'Daily report scheduled');
    };

    scheduleNextReport();
  }

  /**
   * Stop scheduled reports
   */
  stopSchedule(): void {
    if (this.reportTimer) {
      clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
    logger.info('Daily report schedule stopped');
  }

  /**
   * Generate and send the daily report
   */
  async generateAndSendReport(): Promise<DailyReport> {
    try {
      const report = await this.generateReport(24);

      if (this.sendReport) {
        await this.sendReport(report.telegramMessage);
        logger.info('Daily report sent to Telegram');
      }

      return report;
    } catch (error) {
      logger.error({ error }, 'Failed to generate/send daily report');
      throw error;
    }
  }

  /**
   * Generate a performance report for the specified period
   */
  async generateReport(hours: number = 24): Promise<DailyReport> {
    // Get performance stats
    const stats = await signalPerformanceTracker.getPerformanceStats(hours);

    // Get optimization summary
    const optimizationSummary = await thresholdOptimizer.getOptimizationSummary();

    // Generate Telegram message
    const telegramMessage = this.formatTelegramMessage(stats, optimizationSummary, hours);

    return {
      date: new Date(),
      periodHours: hours,
      stats,
      optimizationSummary,
      telegramMessage,
    };
  }

  /**
   * Format the report for Telegram
   */
  private formatTelegramMessage(
    stats: PerformanceStats,
    optimizationSummary: string,
    hours: number
  ): string {
    const periodLabel = hours === 24 ? 'Daily' : hours === 168 ? 'Weekly' : `${hours}h`;

    let msg = `📊 **ROSSYBOT ${periodLabel.toUpperCase()} PERFORMANCE REPORT**\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Overview Section
    msg += `📈 **Overview**\n`;
    msg += `• Total Signals: ${stats.totalSignals}\n`;
    msg += `• Completed: ${stats.completedSignals}\n`;
    msg += `• Pending: ${stats.pendingSignals}\n\n`;

    // Win/Loss Section
    msg += `🎯 **Performance**\n`;
    msg += `• Wins: ${stats.wins} ✅\n`;
    msg += `• Losses: ${stats.losses} ❌\n`;
    msg += `• Win Rate: ${stats.winRate.toFixed(1)}%\n`;

    // Performance indicator
    if (stats.completedSignals > 0) {
      if (stats.winRate >= 35) {
        msg += `• Status: 🟢 Excellent\n`;
      } else if (stats.winRate >= 25) {
        msg += `• Status: 🟡 On Target\n`;
      } else if (stats.winRate >= 15) {
        msg += `• Status: 🟠 Below Target\n`;
      } else {
        msg += `• Status: 🔴 Needs Attention\n`;
      }
    }
    msg += '\n';

    // Returns Section
    msg += `💰 **Returns**\n`;
    msg += `• Average: ${this.formatReturn(stats.avgReturn)}\n`;
    msg += `• Avg Win: ${this.formatReturn(stats.avgWinReturn)}\n`;
    msg += `• Avg Loss: ${this.formatReturn(stats.avgLossReturn)}\n`;
    msg += `• Best: ${this.formatReturn(stats.bestReturn)}\n`;
    msg += `• Worst: ${this.formatReturn(stats.worstReturn)}\n\n`;

    // Expected Value
    if (stats.completedSignals >= 5) {
      const ev = (stats.winRate / 100 * stats.avgWinReturn) -
                 ((100 - stats.winRate) / 100 * Math.abs(stats.avgLossReturn));
      msg += `📐 **Expected Value per Trade:** ${this.formatReturn(ev)}\n\n`;
    }

    // By Signal Type
    msg += `📡 **By Signal Type**\n`;
    for (const [type, data] of Object.entries(stats.bySignalType)) {
      if (data.count > 0) {
        msg += `• ${type}: ${data.count} signals, ${data.winRate.toFixed(0)}% win, ${this.formatReturn(data.avgReturn)} avg\n`;
      }
    }
    msg += '\n';

    // By Score Range
    msg += `📊 **By Score Range**\n`;
    if (stats.byScoreRange.high.count > 0) {
      msg += `• High (70+): ${stats.byScoreRange.high.count} signals, ${stats.byScoreRange.high.winRate.toFixed(0)}% win\n`;
    }
    if (stats.byScoreRange.medium.count > 0) {
      msg += `• Medium (50-69): ${stats.byScoreRange.medium.count} signals, ${stats.byScoreRange.medium.winRate.toFixed(0)}% win\n`;
    }
    if (stats.byScoreRange.low.count > 0) {
      msg += `• Low (<50): ${stats.byScoreRange.low.count} signals, ${stats.byScoreRange.low.winRate.toFixed(0)}% win\n`;
    }
    msg += '\n';

    // By Signal Strength
    msg += `💪 **By Signal Strength**\n`;
    for (const [strength, data] of Object.entries(stats.byStrength)) {
      if (data.count > 0) {
        msg += `• ${strength}: ${data.count} signals, ${data.winRate.toFixed(0)}% win\n`;
      }
    }
    msg += '\n';

    // DUAL-TRACK: By Signal Track
    if (stats.byTrack) {
      const provenStats = stats.byTrack.PROVEN_RUNNER;
      const earlyStats = stats.byTrack.EARLY_QUALITY;
      if (provenStats.count > 0 || earlyStats.count > 0) {
        msg += `🔀 **By Signal Track**\n`;
        if (provenStats.count > 0) {
          msg += `• 🏃 Proven Runner: ${provenStats.count} signals, ${provenStats.winRate.toFixed(0)}% win, ${this.formatReturn(provenStats.avgReturn)} avg\n`;
        }
        if (earlyStats.count > 0) {
          msg += `• ⚡ Early Quality: ${earlyStats.count} signals, ${earlyStats.winRate.toFixed(0)}% win, ${this.formatReturn(earlyStats.avgReturn)} avg\n`;
        }
        msg += '\n';
      }
    }

    // Separator
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Optimization Summary
    msg += optimizationSummary;
    msg += '\n';

    // Footer
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📅 Report generated: ${new Date().toUTCString()}\n`;
    msg += `🤖 Rossybot v2.0 - On-Chain First Strategy`;

    return msg;
  }

  /**
   * Format return percentage with sign and color indicator
   */
  private formatReturn(value: number): string {
    if (value === 0 || isNaN(value)) return '0.0%';

    const sign = value >= 0 ? '+' : '';
    const emoji = value >= 100 ? '🚀' : value >= 50 ? '📈' : value >= 0 ? '↗️' : value >= -20 ? '↘️' : '📉';

    return `${emoji} ${sign}${value.toFixed(1)}%`;
  }

  /**
   * Generate a quick stats summary (shorter format)
   */
  async getQuickSummary(hours: number = 24): Promise<string> {
    const stats = await signalPerformanceTracker.getPerformanceStats(hours);

    const ev = stats.completedSignals >= 3
      ? (stats.winRate / 100 * stats.avgWinReturn) - ((100 - stats.winRate) / 100 * Math.abs(stats.avgLossReturn))
      : 0;

    let summary = `📊 **${hours}h Quick Stats**\n`;
    summary += `Signals: ${stats.totalSignals} | Win Rate: ${stats.winRate.toFixed(0)}%\n`;
    summary += `Wins: ${stats.wins} | Losses: ${stats.losses}\n`;

    if (ev !== 0) {
      summary += `EV/Trade: ${ev >= 0 ? '+' : ''}${ev.toFixed(1)}%`;
    }

    return summary;
  }
}

// ============ EXPORTS ============

export const dailyReportGenerator = new DailyReportGenerator();

export default {
  DailyReportGenerator,
  dailyReportGenerator,
};
