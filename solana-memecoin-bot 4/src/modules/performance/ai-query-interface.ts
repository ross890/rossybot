// ===========================================
// MODULE: AI QUERY INTERFACE
// Generates comprehensive summaries for AI analysis
// This module provides all the data needed to answer
// "How is rossybot performing?" questions
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import {
  deploymentLogsReader,
  LogSummary,
  PerformanceSummary,
  WinLossAnalysis,
} from './deployment-logs-reader.js';
import { signalPerformanceTracker, PerformanceStats } from './signal-performance-tracker.js';
import { thresholdOptimizer } from './threshold-optimizer.js';

// ============ TYPES ============

export interface BotPerformanceReport {
  generatedAt: Date;
  reportPeriodHours: number;

  // Overall Health
  overallHealth: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'CRITICAL';
  healthScore: number; // 0-100

  // Signal Performance
  signals: {
    totalGenerated: number;
    totalSent: number;
    totalFiltered: number;
    filterRate: number;
    byType: {
      onchain: number;
      kol: number;
      discovery: number;
    };
    byTrack: {
      provenRunner: { count: number; winRate: number };
      earlyQuality: { count: number; winRate: number };
    };
  };

  // Trading Performance
  trading: {
    totalTrades: number;
    wins: number;
    losses: number;
    pending: number;
    winRate: number;
    avgWinRoi: number;
    avgLossRoi: number;
    bestTrade: { token: string; roi: number } | null;
    worstTrade: { token: string; roi: number } | null;
  };

  // KOL Performance
  kolPerformance: {
    activeKols: number;
    tradesDetected: number;
    topPerformers: Array<{
      handle: string;
      wins: number;
      losses: number;
      winRate: number;
    }>;
    bottomPerformers: Array<{
      handle: string;
      wins: number;
      losses: number;
      winRate: number;
    }>;
  };

  // System Health
  systemHealth: {
    apiHealthScore: number;
    dbHealthScore: number;
    memoryUsageMb: number;
    errorCount: number;
    topErrors: Array<{ message: string; count: number }>;
  };

  // Recommendations
  recommendations: Array<{
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    category: string;
    issue: string;
    suggestion: string;
  }>;

  // Current Thresholds
  currentThresholds: {
    minOnChainScore: number;
    minMomentumScore: number;
    minSafetyScore: number;
    maxBundleRiskScore: number;
  };

  // Factor Correlations (what's working/not working)
  factorAnalysis: {
    workingWell: string[];
    needsImprovement: string[];
    correlations: Array<{
      factor: string;
      correlation: number;
      insight: string;
    }>;
  };
}

export interface QuickStatus {
  status: 'RUNNING' | 'DEGRADED' | 'ERROR';
  uptime: string;
  signalsLast24h: number;
  winRateLast7d: number;
  topIssue: string | null;
}

// ============ AI QUERY INTERFACE CLASS ============

export class AIQueryInterface {
  private startTime: Date = new Date();

  /**
   * Get a comprehensive performance report
   * Use this to answer "How is rossybot performing?" questions
   */
  async getPerformanceReport(hours: number = 168): Promise<BotPerformanceReport> {
    try {
      // Gather all data in parallel
      const [
        logSummary,
        perfSummary,
        winLossAnalysis,
        signalStats,
        factorCorrelations,
        topTrades,
        bottomTrades,
      ] = await Promise.all([
        deploymentLogsReader.getLogSummary(hours),
        deploymentLogsReader.getPerformanceSummary(hours).catch(() => null),
        deploymentLogsReader.getWinLossAnalysis(hours).catch(() => null),
        signalPerformanceTracker.getPerformanceStats(hours).catch(() => null),
        signalPerformanceTracker.getFactorCorrelations().catch(() => []),
        this.getTopTrades(hours, 'best'),
        this.getTopTrades(hours, 'worst'),
      ]);

      // Get current thresholds
      const thresholds = thresholdOptimizer.getCurrentThresholds();

      // Calculate health scores
      const healthScore = this.calculateHealthScore(logSummary, perfSummary, signalStats);
      const overallHealth = this.getHealthLevel(healthScore);

      // Generate recommendations
      const recommendations = this.generateRecommendations(
        logSummary,
        perfSummary,
        winLossAnalysis,
        signalStats,
        factorCorrelations
      );

      // Analyze factors
      const factorAnalysis = this.analyzeFactors(factorCorrelations, signalStats);

      return {
        generatedAt: new Date(),
        reportPeriodHours: hours,

        overallHealth,
        healthScore,

        signals: {
          totalGenerated: perfSummary?.signalsGenerated || signalStats?.totalSignals || 0,
          totalSent: perfSummary?.signalsSent || signalStats?.completedSignals || 0,
          totalFiltered: perfSummary?.signalsFiltered || 0,
          filterRate: perfSummary?.filterRate || 0,
          byType: {
            onchain: signalStats?.bySignalType?.ONCHAIN?.count || 0,
            kol: signalStats?.bySignalType?.KOL?.count || 0,
            discovery: signalStats?.bySignalType?.DISCOVERY?.count || 0,
          },
          byTrack: {
            provenRunner: {
              count: signalStats?.byTrack?.PROVEN_RUNNER?.count || 0,
              winRate: signalStats?.byTrack?.PROVEN_RUNNER?.winRate || 0,
            },
            earlyQuality: {
              count: signalStats?.byTrack?.EARLY_QUALITY?.count || 0,
              winRate: signalStats?.byTrack?.EARLY_QUALITY?.winRate || 0,
            },
          },
        },

        trading: {
          totalTrades: winLossAnalysis?.totalTrades || signalStats?.completedSignals || 0,
          wins: winLossAnalysis?.wins || signalStats?.wins || 0,
          losses: winLossAnalysis?.losses || signalStats?.losses || 0,
          pending: winLossAnalysis?.pending || signalStats?.pendingSignals || 0,
          winRate: winLossAnalysis?.winRate || signalStats?.winRate || 0,
          avgWinRoi: winLossAnalysis?.avgWinRoi || signalStats?.avgWinReturn || 0,
          avgLossRoi: winLossAnalysis?.avgLossRoi || signalStats?.avgLossReturn || 0,
          bestTrade: topTrades.length > 0 ? topTrades[0] : null,
          worstTrade: bottomTrades.length > 0 ? bottomTrades[0] : null,
        },

        kolPerformance: {
          activeKols: perfSummary?.signalsSent || 0, // Approximate
          tradesDetected: winLossAnalysis?.byKol?.reduce((sum, k) => sum + k.wins + k.losses, 0) || 0,
          topPerformers: (winLossAnalysis?.byKol || [])
            .filter(k => k.winRate >= 50)
            .slice(0, 5)
            .map(k => ({ handle: k.kolHandle, wins: k.wins, losses: k.losses, winRate: k.winRate })),
          bottomPerformers: (winLossAnalysis?.byKol || [])
            .filter(k => k.winRate < 50)
            .sort((a, b) => a.winRate - b.winRate)
            .slice(0, 5)
            .map(k => ({ handle: k.kolHandle, wins: k.wins, losses: k.losses, winRate: k.winRate })),
        },

        systemHealth: {
          apiHealthScore: perfSummary?.apiHealthScore || 100,
          dbHealthScore: perfSummary?.dbHealthScore || 100,
          memoryUsageMb: perfSummary?.avgMemoryUsageMb || 0,
          errorCount: logSummary.bySeverity.ERROR + logSummary.bySeverity.CRITICAL,
          topErrors: logSummary.topErrors.slice(0, 5),
        },

        recommendations,

        currentThresholds: {
          minOnChainScore: thresholds.minOnChainScore,
          minMomentumScore: thresholds.minMomentumScore,
          minSafetyScore: thresholds.minSafetyScore,
          maxBundleRiskScore: thresholds.maxBundleRiskScore,
        },

        factorAnalysis,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to generate performance report');
      throw error;
    }
  }

  /**
   * Get a quick status check
   */
  async getQuickStatus(): Promise<QuickStatus> {
    try {
      const [logSummary, signalStats] = await Promise.all([
        deploymentLogsReader.getLogSummary(24).catch(() => null),
        signalPerformanceTracker.getPerformanceStats(168).catch(() => null),
      ]);

      const errorCount = logSummary?.bySeverity?.ERROR || 0;
      const criticalCount = logSummary?.bySeverity?.CRITICAL || 0;

      let status: 'RUNNING' | 'DEGRADED' | 'ERROR' = 'RUNNING';
      if (criticalCount > 0) {
        status = 'ERROR';
      } else if (errorCount > 10) {
        status = 'DEGRADED';
      }

      const uptimeMs = Date.now() - this.startTime.getTime();
      const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
      const uptimeDays = Math.floor(uptimeHours / 24);
      const uptime = uptimeDays > 0
        ? `${uptimeDays}d ${uptimeHours % 24}h`
        : `${uptimeHours}h`;

      return {
        status,
        uptime,
        signalsLast24h: logSummary?.byCategory?.SIGNAL || 0,
        winRateLast7d: signalStats?.winRate || 0,
        topIssue: logSummary?.topErrors?.[0]?.message || null,
      };
    } catch (error) {
      return {
        status: 'ERROR',
        uptime: 'unknown',
        signalsLast24h: 0,
        winRateLast7d: 0,
        topIssue: 'Failed to fetch status',
      };
    }
  }

  /**
   * Get specific insights based on a question
   */
  async answerQuestion(question: string): Promise<string> {
    const questionLower = question.toLowerCase();

    // Analyze the question and fetch relevant data
    if (questionLower.includes('win rate') || questionLower.includes('winning')) {
      const stats = await signalPerformanceTracker.getPerformanceStats(168);
      return this.formatWinRateAnswer(stats);
    }

    if (questionLower.includes('kol') || questionLower.includes('influencer')) {
      const analysis = await deploymentLogsReader.getWinLossAnalysis(168);
      return this.formatKolAnswer(analysis);
    }

    if (questionLower.includes('error') || questionLower.includes('problem')) {
      const summary = await deploymentLogsReader.getLogSummary(24);
      return this.formatErrorAnswer(summary);
    }

    if (questionLower.includes('threshold') || questionLower.includes('setting')) {
      const thresholds = thresholdOptimizer.getCurrentThresholds();
      return this.formatThresholdAnswer(thresholds);
    }

    if (questionLower.includes('signal') || questionLower.includes('filter')) {
      const perfSummary = await deploymentLogsReader.getPerformanceSummary(24);
      return this.formatSignalAnswer(perfSummary);
    }

    // Default: return full report summary
    const report = await this.getPerformanceReport(168);
    return this.formatFullSummary(report);
  }

  /**
   * Get actionable tweaks based on current performance
   */
  async getSuggestedTweaks(): Promise<Array<{
    parameter: string;
    currentValue: number;
    suggestedValue: number;
    reason: string;
    expectedImpact: string;
  }>> {
    const [stats, correlations, analysis] = await Promise.all([
      signalPerformanceTracker.getPerformanceStats(168).catch(() => null),
      signalPerformanceTracker.getFactorCorrelations().catch(() => []),
      deploymentLogsReader.getWinLossAnalysis(168).catch(() => null),
    ]);

    const tweaks: Array<{
      parameter: string;
      currentValue: number;
      suggestedValue: number;
      reason: string;
      expectedImpact: string;
    }> = [];

    const thresholds = thresholdOptimizer.getCurrentThresholds();

    // Check if win rate is low
    if (stats && stats.winRate < 30) {
      // Suggest raising minimum scores
      tweaks.push({
        parameter: 'minOnChainScore',
        currentValue: thresholds.minOnChainScore,
        suggestedValue: Math.min(50, thresholds.minOnChainScore + 10),
        reason: `Win rate is low (${stats.winRate.toFixed(1)}%), need stricter filtering`,
        expectedImpact: 'Fewer signals but higher quality',
      });
    }

    // Check momentum correlation
    const momentumCorr = correlations.find(c => c.factor.toLowerCase().includes('momentum'));
    if (momentumCorr && momentumCorr.correlation > 0.2) {
      tweaks.push({
        parameter: 'minMomentumScore',
        currentValue: thresholds.minMomentumScore,
        suggestedValue: Math.min(60, thresholds.minMomentumScore + 5),
        reason: 'Momentum shows strong correlation with wins',
        expectedImpact: 'Focus on high-momentum tokens',
      });
    }

    // Check safety correlation
    const safetyCorr = correlations.find(c => c.factor.toLowerCase().includes('safety'));
    if (safetyCorr && safetyCorr.winningAvg > safetyCorr.losingAvg + 10) {
      tweaks.push({
        parameter: 'minSafetyScore',
        currentValue: thresholds.minSafetyScore,
        suggestedValue: Math.round(safetyCorr.winningAvg * 0.9),
        reason: `Winning trades have higher safety scores (${safetyCorr.winningAvg.toFixed(0)} vs ${safetyCorr.losingAvg.toFixed(0)})`,
        expectedImpact: 'Avoid more scam/rug tokens',
      });
    }

    // Check bundle risk
    const bundleCorr = correlations.find(c => c.factor.toLowerCase().includes('bundle'));
    if (bundleCorr && bundleCorr.losingAvg > bundleCorr.winningAvg + 10) {
      tweaks.push({
        parameter: 'maxBundleRiskScore',
        currentValue: thresholds.maxBundleRiskScore,
        suggestedValue: Math.round(bundleCorr.winningAvg * 1.1),
        reason: `Losing trades have higher bundle risk (${bundleCorr.losingAvg.toFixed(0)} vs ${bundleCorr.winningAvg.toFixed(0)})`,
        expectedImpact: 'Filter out more bundled/insider launches',
      });
    }

    // Check if filter rate is too high (not enough signals)
    if (stats && stats.totalSignals < 10 && stats.winRate > 40) {
      tweaks.push({
        parameter: 'minOnChainScore',
        currentValue: thresholds.minOnChainScore,
        suggestedValue: Math.max(20, thresholds.minOnChainScore - 5),
        reason: 'Very few signals but decent win rate - can afford to be less strict',
        expectedImpact: 'More trading opportunities',
      });
    }

    return tweaks;
  }

  // ============ HELPER METHODS ============

  private async getTopTrades(
    hours: number,
    type: 'best' | 'worst'
  ): Promise<Array<{ token: string; roi: number }>> {
    try {
      const order = type === 'best' ? 'DESC' : 'ASC';
      const result = await pool.query(`
        SELECT token_ticker, final_return
        FROM signal_performance
        WHERE signal_time > NOW() - INTERVAL '${hours} hours'
          AND final_outcome IS NOT NULL
        ORDER BY final_return ${order}
        LIMIT 3
      `);

      return result.rows.map((r: any) => ({
        token: r.token_ticker,
        roi: parseFloat(r.final_return) || 0,
      }));
    } catch {
      return [];
    }
  }

  private calculateHealthScore(
    logSummary: LogSummary | null,
    perfSummary: PerformanceSummary | null,
    signalStats: PerformanceStats | null
  ): number {
    let score = 100;

    // Deduct for errors
    if (logSummary) {
      score -= Math.min(20, logSummary.bySeverity.ERROR * 2);
      score -= Math.min(30, logSummary.bySeverity.CRITICAL * 10);
    }

    // Deduct for low win rate
    if (signalStats && signalStats.winRate < 30) {
      score -= (30 - signalStats.winRate);
    }

    // Deduct for API issues
    if (perfSummary && perfSummary.apiHealthScore < 90) {
      score -= (90 - perfSummary.apiHealthScore) / 2;
    }

    return Math.max(0, Math.round(score));
  }

  private getHealthLevel(score: number): 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'CRITICAL' {
    if (score >= 90) return 'EXCELLENT';
    if (score >= 75) return 'GOOD';
    if (score >= 50) return 'FAIR';
    if (score >= 25) return 'POOR';
    return 'CRITICAL';
  }

  private generateRecommendations(
    logSummary: LogSummary | null,
    perfSummary: PerformanceSummary | null,
    winLoss: WinLossAnalysis | null,
    stats: PerformanceStats | null,
    correlations: any[]
  ): BotPerformanceReport['recommendations'] {
    const recommendations: BotPerformanceReport['recommendations'] = [];

    // Check for critical errors
    if (logSummary && logSummary.bySeverity.CRITICAL > 0) {
      recommendations.push({
        priority: 'HIGH',
        category: 'System',
        issue: `${logSummary.bySeverity.CRITICAL} critical errors detected`,
        suggestion: 'Review error logs and fix critical issues immediately',
      });
    }

    // Check win rate
    if (stats && stats.winRate < 25) {
      recommendations.push({
        priority: 'HIGH',
        category: 'Strategy',
        issue: `Win rate is very low (${stats.winRate.toFixed(1)}%)`,
        suggestion: 'Increase minimum score thresholds or add stricter safety filters',
      });
    } else if (stats && stats.winRate < 35) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'Strategy',
        issue: `Win rate below target (${stats.winRate.toFixed(1)}%)`,
        suggestion: 'Review factor correlations and adjust thresholds accordingly',
      });
    }

    // Check signal volume
    if (stats && stats.totalSignals < 5) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'Signals',
        issue: 'Very few signals generated',
        suggestion: 'Consider lowering minimum thresholds to increase signal volume',
      });
    }

    // Check filter rate
    if (perfSummary && perfSummary.filterRate > 95) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'Signals',
        issue: `Very high filter rate (${perfSummary.filterRate.toFixed(1)}%)`,
        suggestion: 'Most tokens are being filtered - review if thresholds are too strict',
      });
    }

    // Check API health
    if (perfSummary && perfSummary.apiHealthScore < 80) {
      recommendations.push({
        priority: 'HIGH',
        category: 'System',
        issue: 'API health issues detected',
        suggestion: 'Check API rate limits and connectivity',
      });
    }

    // Check correlations for insights
    const strongCorrelations = correlations.filter(c => Math.abs(c.correlation) > 0.15);
    if (strongCorrelations.length > 0) {
      const bestFactor = strongCorrelations.sort((a, b) => b.correlation - a.correlation)[0];
      if (bestFactor.correlation > 0) {
        recommendations.push({
          priority: 'LOW',
          category: 'Optimization',
          issue: `${bestFactor.factor} shows strong positive correlation with wins`,
          suggestion: `Consider weighting ${bestFactor.factor} higher in scoring`,
        });
      }
    }

    return recommendations;
  }

  private analyzeFactors(
    correlations: any[],
    stats: PerformanceStats | null
  ): BotPerformanceReport['factorAnalysis'] {
    const workingWell: string[] = [];
    const needsImprovement: string[] = [];
    const insights: Array<{ factor: string; correlation: number; insight: string }> = [];

    for (const corr of correlations) {
      if (corr.correlation > 0.1) {
        workingWell.push(corr.factor);
        insights.push({
          factor: corr.factor,
          correlation: corr.correlation,
          insight: `Higher ${corr.factor} correlates with winning trades`,
        });
      } else if (corr.correlation < -0.1) {
        needsImprovement.push(corr.factor);
        insights.push({
          factor: corr.factor,
          correlation: corr.correlation,
          insight: `Higher ${corr.factor} correlates with losing trades - consider filtering`,
        });
      }
    }

    // Add track analysis if available
    if (stats?.byTrack) {
      if (stats.byTrack.PROVEN_RUNNER?.winRate > stats.byTrack.EARLY_QUALITY?.winRate + 10) {
        workingWell.push('PROVEN_RUNNER track');
        insights.push({
          factor: 'Signal Track',
          correlation: 0.15,
          insight: 'PROVEN_RUNNER track outperforming EARLY_QUALITY - older tokens are safer',
        });
      } else if (stats.byTrack.EARLY_QUALITY?.winRate > stats.byTrack.PROVEN_RUNNER?.winRate + 10) {
        workingWell.push('EARLY_QUALITY track');
        insights.push({
          factor: 'Signal Track',
          correlation: 0.15,
          insight: 'EARLY_QUALITY track outperforming - early entry with KOL validation works well',
        });
      }
    }

    return {
      workingWell,
      needsImprovement,
      correlations: insights,
    };
  }

  // Format helpers for answerQuestion
  private formatWinRateAnswer(stats: PerformanceStats | null): string {
    if (!stats) return 'Unable to fetch win rate data.';

    return `**Win Rate Analysis (Last 7 Days)**

- Overall Win Rate: ${stats.winRate.toFixed(1)}%
- Total Signals: ${stats.totalSignals}
- Wins: ${stats.wins} | Losses: ${stats.losses} | Pending: ${stats.pendingSignals}

**By Signal Strength:**
- STRONG: ${stats.byStrength.STRONG.winRate.toFixed(1)}% (${stats.byStrength.STRONG.count} signals)
- MODERATE: ${stats.byStrength.MODERATE.winRate.toFixed(1)}% (${stats.byStrength.MODERATE.count} signals)
- WEAK: ${stats.byStrength.WEAK.winRate.toFixed(1)}% (${stats.byStrength.WEAK.count} signals)

**By Track:**
- PROVEN_RUNNER: ${stats.byTrack.PROVEN_RUNNER.winRate.toFixed(1)}% (${stats.byTrack.PROVEN_RUNNER.count} signals)
- EARLY_QUALITY: ${stats.byTrack.EARLY_QUALITY.winRate.toFixed(1)}% (${stats.byTrack.EARLY_QUALITY.count} signals)

Average Win: +${stats.avgWinReturn.toFixed(1)}% | Average Loss: ${stats.avgLossReturn.toFixed(1)}%`;
  }

  private formatKolAnswer(analysis: WinLossAnalysis | null): string {
    if (!analysis) return 'Unable to fetch KOL performance data.';

    const topKols = analysis.byKol.slice(0, 5);
    const kolList = topKols.map(k =>
      `- ${k.kolHandle}: ${k.winRate.toFixed(0)}% win rate (${k.wins}W/${k.losses}L)`
    ).join('\n');

    return `**KOL Performance Analysis**

**Top Performing KOLs:**
${kolList || 'No KOL data available'}

Total KOL-linked trades: ${analysis.byKol.reduce((sum, k) => sum + k.wins + k.losses, 0)}`;
  }

  private formatErrorAnswer(summary: LogSummary | null): string {
    if (!summary) return 'Unable to fetch error data.';

    const errorList = summary.topErrors.slice(0, 5).map(e =>
      `- ${e.message} (${e.count} occurrences)`
    ).join('\n');

    return `**Error Analysis (Last 24 Hours)**

- Total Errors: ${summary.bySeverity.ERROR}
- Critical Errors: ${summary.bySeverity.CRITICAL}
- Error Rate: ${summary.errorRate.toFixed(2)}%

**Top Errors:**
${errorList || 'No errors found'}`;
  }

  private formatThresholdAnswer(thresholds: any): string {
    return `**Current Thresholds**

- Min On-Chain Score: ${thresholds.minOnChainScore}
- Min Momentum Score: ${thresholds.minMomentumScore}
- Min Safety Score: ${thresholds.minSafetyScore}
- Max Bundle Risk Score: ${thresholds.maxBundleRiskScore}

These thresholds are automatically optimized based on performance data.`;
  }

  private formatSignalAnswer(summary: PerformanceSummary | null): string {
    if (!summary) return 'Unable to fetch signal data.';

    return `**Signal Generation (Last 24 Hours)**

- Signals Generated: ${summary.signalsGenerated}
- Signals Sent: ${summary.signalsSent}
- Signals Filtered: ${summary.signalsFiltered}
- Filter Rate: ${summary.filterRate.toFixed(1)}%

API Health: ${summary.apiHealthScore}/100
DB Health: ${summary.dbHealthScore}/100`;
  }

  private formatFullSummary(report: BotPerformanceReport): string {
    const recList = report.recommendations.slice(0, 3).map(r =>
      `- [${r.priority}] ${r.issue}: ${r.suggestion}`
    ).join('\n');

    return `**Rossybot Performance Summary**

**Overall Health:** ${report.overallHealth} (${report.healthScore}/100)

**Trading Performance (Last 7 Days):**
- Win Rate: ${report.trading.winRate.toFixed(1)}%
- Wins: ${report.trading.wins} | Losses: ${report.trading.losses}
- Avg Win: +${report.trading.avgWinRoi.toFixed(1)}% | Avg Loss: ${report.trading.avgLossRoi.toFixed(1)}%

**Signals:**
- Generated: ${report.signals.totalGenerated}
- Filter Rate: ${report.signals.filterRate.toFixed(1)}%

**Top Recommendations:**
${recList || 'No recommendations at this time'}

**What's Working:**
${report.factorAnalysis.workingWell.join(', ') || 'Analyzing...'}

**Needs Attention:**
${report.factorAnalysis.needsImprovement.join(', ') || 'None identified'}`;
  }
}

// ============ EXPORTS ============

export const aiQueryInterface = new AIQueryInterface();

export default {
  AIQueryInterface,
  aiQueryInterface,
};
