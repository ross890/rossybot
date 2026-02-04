// ===========================================
// MODULE: DAILY AUTO OPTIMIZER
// Runs daily at 6am Sydney time to analyze performance
// and automatically adjust signal thresholds
// ===========================================

import { CronJob } from 'cron';
import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { signalPerformanceTracker } from './signal-performance-tracker.js';
import { thresholdOptimizer, ThresholdSet, ThresholdRecommendation } from './threshold-optimizer.js';
import TelegramBot from 'node-telegram-bot-api';
import { appConfig } from '../../config/index.js';

// ============ TYPES ============

interface FactorStats {
  name: string;
  winAvg: number;
  lossAvg: number;
  diff: number;
  recommendation: string;
  newValue?: number;
}

interface TierPerformance {
  tier: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturn: number;
}

interface OptimizationReport {
  timestamp: Date;
  dataPoints: number;
  winRate: number;
  previousWinRate: number | null;
  factorAnalysis: FactorStats[];
  tierPerformance: TierPerformance[];  // NEW: Performance by market cap tier
  previousThresholds: ThresholdSet;
  newThresholds: ThresholdSet;
  changesApplied: string[];
  reasoning: string[];
}

// ============ CONSTANTS ============

// Sydney is UTC+11 (AEDT) or UTC+10 (AEST)
// Using Australia/Sydney timezone for automatic DST handling
const SYDNEY_TIMEZONE = 'Australia/Sydney';
const CRON_SCHEDULE = '0 6 * * *'; // 6:00 AM daily

// Optimization constraints
const MIN_DATA_POINTS = 50;    // Need 50+ completed signals before adjusting (was 10)
const MAX_CHANGE_PERCENT = 5;  // Max 5% change per optimization cycle (was 15%)
const MAX_LIQUIDITY_CHANGE_PERCENT = 10;  // NEW: Allow 10% change for liquidity (strong signal)
const TARGET_WIN_RATE = 30;
const ADJUSTMENT_FACTOR = 0.1; // Apply 10% of factor diff (was 0.3)
const LIQUIDITY_ADJUSTMENT_FACTOR = 0.15; // NEW: More aggressive for liquidity

// ============ DAILY AUTO OPTIMIZER CLASS ============

export class DailyAutoOptimizer {
  private cronJob: CronJob | null = null;
  private bot: TelegramBot | null = null;
  private chatId: string;
  private lastWinRate: number | null = null;

  constructor() {
    this.chatId = appConfig.telegramChatId;
  }

  /**
   * Initialize the optimizer with Telegram bot
   */
  async initialize(existingBot?: TelegramBot): Promise<void> {
    if (existingBot) {
      this.bot = existingBot;
    } else if (appConfig.telegramBotToken) {
      this.bot = new TelegramBot(appConfig.telegramBotToken, { polling: false });
    }

    // Load last known thresholds
    await thresholdOptimizer.loadThresholds();

    logger.info('Daily auto optimizer initialized');
  }

  /**
   * Start the daily cron job
   */
  start(): void {
    if (this.cronJob) {
      logger.warn('Daily auto optimizer already running');
      return;
    }

    this.cronJob = new CronJob(
      CRON_SCHEDULE,
      async () => {
        await this.runOptimization();
      },
      null,
      true,
      SYDNEY_TIMEZONE
    );

    logger.info({
      schedule: CRON_SCHEDULE,
      timezone: SYDNEY_TIMEZONE,
      nextRun: this.cronJob.nextDate().toISO(),
    }, 'Daily auto optimizer started');
  }

  /**
   * Stop the cron job
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      logger.info('Daily auto optimizer stopped');
    }
  }

  /**
   * Run optimization manually (also called by cron)
   */
  async runOptimization(): Promise<OptimizationReport | null> {
    logger.info('Starting daily threshold optimization...');

    try {
      // Step 1: Get performance data
      const stats = await signalPerformanceTracker.getPerformanceStats(168); // Last 7 days

      if (stats.completedSignals < MIN_DATA_POINTS) {
        const message = this.formatInsufficientDataMessage(stats.completedSignals);
        await this.sendTelegramMessage(message);
        logger.info({ completedSignals: stats.completedSignals }, 'Insufficient data for optimization');
        return null;
      }

      // Step 2: Analyze factors
      const factorAnalysis = await this.analyzeFactors();

      // Step 2.5: Get tier performance data
      const tierStats = await signalPerformanceTracker.getTierPerformance(168); // 7 days
      const tierPerformance: TierPerformance[] = Object.entries(tierStats).map(([tier, data]) => ({
        tier,
        count: data.count,
        wins: data.wins,
        losses: data.losses,
        winRate: data.winRate,
        avgReturn: data.avgReturn,
      })).filter(t => t.count > 0); // Only include tiers with data

      // Step 3: Get current thresholds
      const previousThresholds = thresholdOptimizer.getCurrentThresholds();

      // Step 4: Calculate new thresholds
      const { newThresholds, changesApplied, reasoning } = this.calculateNewThresholds(
        previousThresholds,
        factorAnalysis,
        stats.winRate
      );

      // Step 5: Apply new thresholds if there are changes
      if (changesApplied.length > 0) {
        thresholdOptimizer.setThresholds(newThresholds);
        await this.saveThresholdsToDatabase(newThresholds);

        // Also update the signal generator constants
        await this.updateSignalGeneratorThresholds(newThresholds);
      }

      // Step 6: Build report
      const report: OptimizationReport = {
        timestamp: new Date(),
        dataPoints: stats.completedSignals,
        winRate: stats.winRate,
        previousWinRate: this.lastWinRate,
        factorAnalysis,
        tierPerformance,  // NEW: Include tier performance
        previousThresholds,
        newThresholds,
        changesApplied,
        reasoning,
      };

      // Update last known win rate
      this.lastWinRate = stats.winRate;

      // Step 7: Send Telegram notification
      const message = this.formatOptimizationReport(report);
      await this.sendTelegramMessage(message);

      logger.info({
        winRate: stats.winRate,
        changesApplied: changesApplied.length,
      }, 'Daily optimization complete');

      return report;
    } catch (error) {
      logger.error({ error }, 'Daily optimization failed');
      await this.sendTelegramMessage(`⚠️ *Daily Optimization Failed*\n\nError: ${error}`);
      return null;
    }
  }

  /**
   * Analyze factors from completed signals
   */
  private async analyzeFactors(): Promise<FactorStats[]> {
    const result = await pool.query(`
      SELECT * FROM signal_performance
      WHERE final_outcome IN ('WIN', 'LOSS')
      AND signal_time > NOW() - INTERVAL '7 days'
    `);

    const wins = result.rows.filter((s: any) => s.final_outcome === 'WIN');
    const losses = result.rows.filter((s: any) => s.final_outcome === 'LOSS');

    if (wins.length === 0 || losses.length === 0) {
      return [];
    }

    const factors = [
      { name: 'Momentum Score', field: 'momentum_score', higherBetter: true, thresholdKey: 'minMomentumScore' },
      { name: 'OnChain Score', field: 'onchain_score', higherBetter: true, thresholdKey: 'minOnChainScore' },
      { name: 'Safety Score', field: 'safety_score', higherBetter: true, thresholdKey: 'minSafetyScore' },
      { name: 'Bundle Risk', field: 'bundle_risk_score', higherBetter: false, thresholdKey: 'maxBundleRiskScore' },
      { name: 'Liquidity', field: 'entry_liquidity', higherBetter: true, thresholdKey: 'minLiquidity' },
      { name: 'Top10 Concentration', field: 'entry_top10_concentration', higherBetter: false, thresholdKey: 'maxTop10Concentration' },
    ];

    return factors.map(factor => {
      const winValues = wins.map((s: any) => parseFloat(s[factor.field]) || 0);
      const lossValues = losses.map((s: any) => parseFloat(s[factor.field]) || 0);

      const winAvg = winValues.reduce((a, b) => a + b, 0) / winValues.length;
      const lossAvg = lossValues.reduce((a, b) => a + b, 0) / lossValues.length;
      const diff = winAvg - lossAvg;

      let recommendation = '✓ OK';
      if (factor.higherBetter) {
        if (diff > 10) recommendation = '↑ RAISE';
        else if (diff < -10) recommendation = '⚠️ CHECK';
      } else {
        if (diff < -10) recommendation = '↓ LOWER';
        else if (diff > 10) recommendation = '⚠️ CHECK';
      }

      return {
        name: factor.name,
        winAvg: Math.round(winAvg * 10) / 10,
        lossAvg: Math.round(lossAvg * 10) / 10,
        diff: Math.round(diff * 10) / 10,
        recommendation,
      };
    });
  }

  /**
   * Calculate new thresholds based on analysis
   */
  private calculateNewThresholds(
    current: ThresholdSet,
    factors: FactorStats[],
    winRate: number
  ): { newThresholds: ThresholdSet; changesApplied: string[]; reasoning: string[] } {
    const newThresholds = { ...current };
    const changesApplied: string[] = [];
    const reasoning: string[] = [];

    // Map factor names to threshold keys
    const factorToThreshold: Record<string, keyof ThresholdSet> = {
      'Momentum Score': 'minMomentumScore',
      'OnChain Score': 'minOnChainScore',
      'Safety Score': 'minSafetyScore',
      'Bundle Risk': 'maxBundleRiskScore',
      'Liquidity': 'minLiquidity',
      'Top10 Concentration': 'maxTop10Concentration',
    };

    // Determine if we should tighten or loosen based on win rate
    // More conservative: only adjust when clearly outside target range
    const shouldTighten = winRate < TARGET_WIN_RATE - 3;  // < 27% (was < 25%)
    const shouldLoosen = winRate > TARGET_WIN_RATE + 8;   // > 38% (was > 45%)

    if (shouldTighten) {
      reasoning.push(`Win rate (${winRate.toFixed(1)}%) below target (${TARGET_WIN_RATE}%) - tightening thresholds`);
    } else if (shouldLoosen) {
      reasoning.push(`Win rate (${winRate.toFixed(1)}%) above target - could loosen for more signals`);
    } else {
      reasoning.push(`Win rate (${winRate.toFixed(1)}%) near target (${TARGET_WIN_RATE}%) - fine-tuning only`);
    }

    for (const factor of factors) {
      const thresholdKey = factorToThreshold[factor.name];
      if (!thresholdKey) continue;

      const currentValue = current[thresholdKey] as number;
      const isMaxThreshold = thresholdKey.startsWith('max');

      // Calculate adjustment based on win/loss difference
      // Use more aggressive adjustment for liquidity (strongest differentiator)
      const isLiquidityFactor = factor.name === 'Liquidity';
      const maxChangePercent = isLiquidityFactor ? MAX_LIQUIDITY_CHANGE_PERCENT : MAX_CHANGE_PERCENT;
      const adjustmentFactor = isLiquidityFactor ? LIQUIDITY_ADJUSTMENT_FACTOR : ADJUSTMENT_FACTOR;

      let adjustment = 0;
      let reason = '';

      if (shouldTighten && Math.abs(factor.diff) > 5) {
        if (isMaxThreshold) {
          // For max thresholds, lower the max to be stricter
          if (factor.diff < 0) {
            adjustment = Math.max(-currentValue * (maxChangePercent / 100), factor.diff * adjustmentFactor);
            reason = `Wins have lower ${factor.name} - lowering max`;
          }
        } else {
          // For min thresholds, raise the min to be stricter
          if (factor.diff > 0) {
            adjustment = Math.min(currentValue * (maxChangePercent / 100), factor.diff * adjustmentFactor);
            reason = `Wins have higher ${factor.name} - raising min`;
          }
        }
      } else if (shouldLoosen && Math.abs(factor.diff) < 3) {
        // Factor doesn't strongly differentiate - could loosen slightly
        if (isMaxThreshold) {
          adjustment = currentValue * 0.02; // Loosen by 2% (was 5%)
          reason = `${factor.name} not differentiating - loosening for volume`;
        } else {
          adjustment = -currentValue * 0.02; // Loosen by 2% (was 5%)
          reason = `${factor.name} not differentiating - loosening for volume`;
        }
      }

      if (Math.abs(adjustment) >= 1) {
        const newValue = Math.round(currentValue + adjustment);

        // Sanity bounds
        const bounds: Record<string, [number, number]> = {
          minMomentumScore: [5, 70],   // Lowered from 20 to allow more signals during learning
          minOnChainScore: [30, 75],
          minSafetyScore: [40, 80],
          maxBundleRiskScore: [20, 60],
          minLiquidity: [5000, 50000],
          maxTop10Concentration: [30, 70],
        };

        const [min, max] = bounds[thresholdKey] || [0, 100];
        const boundedValue = Math.max(min, Math.min(max, newValue));

        if (boundedValue !== currentValue) {
          (newThresholds[thresholdKey] as number) = boundedValue;
          const arrow = boundedValue > currentValue ? '↑' : '↓';
          changesApplied.push(`${factor.name}: ${currentValue} ${arrow} ${boundedValue}`);
          reasoning.push(reason);
        }
      }
    }

    if (changesApplied.length === 0) {
      reasoning.push('No significant changes needed - thresholds are well-calibrated');
    }

    return { newThresholds, changesApplied, reasoning };
  }

  /**
   * Save thresholds to database
   */
  private async saveThresholdsToDatabase(thresholds: ThresholdSet): Promise<void> {
    await pool.query(`
      INSERT INTO threshold_history (thresholds)
      VALUES ($1)
    `, [JSON.stringify(thresholds)]);
  }

  /**
   * Update signal generator thresholds in memory
   * Note: File changes require restart to take effect
   */
  private async updateSignalGeneratorThresholds(thresholds: ThresholdSet): Promise<void> {
    // The thresholds are now stored in the database and loaded by threshold-optimizer
    // Signal generator should read from thresholdOptimizer.getCurrentThresholds()
    logger.info({ thresholds }, 'Thresholds updated in database - will be used for new signals');
  }

  /**
   * Format optimization report for Telegram
   */
  private formatOptimizationReport(report: OptimizationReport): string {
    const lines: string[] = [];

    // Header
    lines.push('🤖 *ROSSYBOT DAILY OPTIMIZATION*');
    lines.push(`📅 ${report.timestamp.toLocaleDateString('en-AU', { timeZone: SYDNEY_TIMEZONE })}`);
    lines.push('');

    // Performance Summary
    lines.push('📊 *PERFORMANCE SUMMARY*');
    lines.push(`• Signals Analyzed: ${report.dataPoints}`);

    const winRateEmoji = report.winRate >= TARGET_WIN_RATE ? '✅' : '⚠️';
    lines.push(`• Win Rate: ${winRateEmoji} ${report.winRate.toFixed(1)}%`);

    if (report.previousWinRate !== null) {
      const change = report.winRate - report.previousWinRate;
      const changeEmoji = change >= 0 ? '📈' : '📉';
      lines.push(`• Change: ${changeEmoji} ${change >= 0 ? '+' : ''}${change.toFixed(1)}%`);
    }
    lines.push('');

    // Factor Analysis
    lines.push('🔍 *FACTOR ANALYSIS*');
    lines.push('```');
    lines.push('Factor          Win   Loss   Diff');
    lines.push('─'.repeat(35));
    for (const factor of report.factorAnalysis) {
      const name = factor.name.padEnd(14).slice(0, 14);
      const win = factor.winAvg.toFixed(0).padStart(5);
      const loss = factor.lossAvg.toFixed(0).padStart(6);
      const diff = (factor.diff >= 0 ? '+' : '') + factor.diff.toFixed(0);
      lines.push(`${name} ${win} ${loss}  ${diff.padStart(5)}`);
    }
    lines.push('```');
    lines.push('');

    // Tier Performance (NEW)
    if (report.tierPerformance.length > 0) {
      lines.push('📊 *TIER PERFORMANCE (7d)*');
      const tierEmojis: Record<string, string> = {
        RISING: '🚀',
        EMERGING: '🌱',
        GRADUATED: '🎓',
        ESTABLISHED: '🏛️',
        MICRO: '🔬',
        UNKNOWN: '❓',
      };
      for (const tier of report.tierPerformance) {
        const emoji = tierEmojis[tier.tier] || '📈';
        const winRateEmoji = tier.winRate >= 40 ? '✅' : tier.winRate >= 25 ? '⚠️' : '❌';
        const returnStr = tier.avgReturn >= 0 ? `+${tier.avgReturn.toFixed(0)}%` : `${tier.avgReturn.toFixed(0)}%`;
        lines.push(`${emoji} *${tier.tier}*: ${winRateEmoji} ${tier.winRate.toFixed(0)}% (${tier.wins}W/${tier.losses}L) | ${returnStr}`);
      }
      lines.push('');
    }

    // Reasoning
    lines.push('🧠 *ANALYSIS*');
    for (const reason of report.reasoning.slice(0, 3)) {
      lines.push(`• ${reason}`);
    }
    lines.push('');

    // Changes Applied
    if (report.changesApplied.length > 0) {
      lines.push('⚡ *CHANGES APPLIED*');
      for (const change of report.changesApplied) {
        lines.push(`• ${change}`);
      }
      lines.push('');

      // New Thresholds Summary
      lines.push('📋 *ACTIVE THRESHOLDS*');
      lines.push('```');
      lines.push(`Min Momentum:    ${report.newThresholds.minMomentumScore}`);
      lines.push(`Min OnChain:     ${report.newThresholds.minOnChainScore}`);
      lines.push(`Min Safety:      ${report.newThresholds.minSafetyScore}`);
      lines.push(`Max Bundle Risk: ${report.newThresholds.maxBundleRiskScore}`);
      lines.push(`Min Liquidity:   $${report.newThresholds.minLiquidity.toLocaleString()}`);
      lines.push(`Max Top10 Conc:  ${report.newThresholds.maxTop10Concentration}%`);
      lines.push('```');
    } else {
      lines.push('✅ *NO CHANGES NEEDED*');
      lines.push('Thresholds are performing well');
    }

    lines.push('');
    lines.push('_Next optimization: Tomorrow 6:00 AM AEDT_');

    return lines.join('\n');
  }

  /**
   * Format insufficient data message
   */
  private formatInsufficientDataMessage(count: number): string {
    return [
      '🤖 *ROSSYBOT DAILY OPTIMIZATION*',
      '',
      '⏳ *INSUFFICIENT DATA*',
      '',
      `• Completed Signals: ${count}`,
      `• Required: ${MIN_DATA_POINTS}`,
      '',
      'Need more completed signals before optimization can run.',
      'Signals complete after 48 hours of tracking.',
      '',
      '_Next check: Tomorrow 6:00 AM AEDT_',
    ].join('\n');
  }

  /**
   * Send message via Telegram
   */
  private async sendTelegramMessage(message: string): Promise<void> {
    if (!this.bot || !this.chatId) {
      logger.warn('Telegram bot not configured - skipping notification');
      return;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
      logger.info('Optimization report sent to Telegram');
    } catch (error) {
      logger.error({ error }, 'Failed to send Telegram message');
    }
  }

  /**
   * Get next scheduled run time
   */
  getNextRunTime(): Date | null {
    if (!this.cronJob) return null;
    return this.cronJob.nextDate().toJSDate();
  }
}

// ============ EXPORTS ============

export const dailyAutoOptimizer = new DailyAutoOptimizer();

export default {
  DailyAutoOptimizer,
  dailyAutoOptimizer,
};
