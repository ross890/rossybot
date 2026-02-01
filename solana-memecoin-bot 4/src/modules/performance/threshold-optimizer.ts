// ===========================================
// MODULE: THRESHOLD OPTIMIZER
// Automatically adjusts signal thresholds based on historical performance
// Uses factor correlations and win rate analysis to optimize
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { signalPerformanceTracker, PerformanceStats } from './signal-performance-tracker.js';

// ============ TYPES ============

export interface ThresholdRecommendation {
  factor: string;
  currentValue: number;
  recommendedValue: number;
  changeDirection: 'INCREASE' | 'DECREASE' | 'MAINTAIN';
  changePercent: number;
  reason: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface OptimizationResult {
  timestamp: Date;
  dataPoints: number;
  currentWinRate: number;
  targetWinRate: number;

  recommendations: ThresholdRecommendation[];

  // Current vs optimal thresholds
  currentThresholds: ThresholdSet;
  recommendedThresholds: ThresholdSet;

  // Auto-applied changes
  autoApplied: boolean;
  appliedChanges: string[];
}

export interface ThresholdSet {
  minMomentumScore: number;
  minOnChainScore: number;
  minSafetyScore: number;
  maxBundleRiskScore: number;
  minLiquidity: number;
  maxTop10Concentration: number;
}

export interface FactorAnalysis {
  factor: string;
  winningAvg: number;
  losingAvg: number;
  separation: number;  // How well this factor separates wins from losses
  optimalThreshold: number;
  confidenceScore: number;
}

// ============ CONSTANTS ============

// Default thresholds (moderate - balanced for data collection + quality)
const DEFAULT_THRESHOLDS: ThresholdSet = {
  minMomentumScore: 25,      // Moderate - still allows good signal volume
  minOnChainScore: 30,       // Moderate - filters obvious low quality
  minSafetyScore: 40,        // Moderate - some safety filtering
  maxBundleRiskScore: 60,    // Moderate - allows some risk
  minLiquidity: 8000,        // Moderate - filters very low liquidity
  maxTop10Concentration: 60, // Moderate - some concentration allowed
};

// Target performance
const TARGET_WIN_RATE = 30;  // 30% win rate target
// AUDIT FIX: Aligned with win-predictor MIN_SAMPLES_FOR_PREDICTION (15)
// Previously required 50 which meant very long wait for optimization
const MIN_DATA_POINTS = 20;  // Minimum completed signals for optimization
const MAX_THRESHOLD_CHANGE = 15;  // Max change per optimization cycle (%)

// ============ THRESHOLD OPTIMIZER CLASS ============

export class ThresholdOptimizer {
  private currentThresholds: ThresholdSet;
  private lastOptimization: Date | null = null;

  constructor() {
    this.currentThresholds = { ...DEFAULT_THRESHOLDS };
  }

  /**
   * Get current thresholds
   */
  getCurrentThresholds(): ThresholdSet {
    return { ...this.currentThresholds };
  }

  /**
   * Set thresholds manually
   */
  setThresholds(thresholds: Partial<ThresholdSet>): void {
    this.currentThresholds = {
      ...this.currentThresholds,
      ...thresholds,
    };
    logger.info({ thresholds: this.currentThresholds }, 'Thresholds updated manually');
  }

  /**
   * Reset thresholds to default values
   */
  async resetThresholds(): Promise<ThresholdSet> {
    this.currentThresholds = { ...DEFAULT_THRESHOLDS };

    // Save reset thresholds to database (so they persist)
    await this.saveThresholds(this.currentThresholds);

    logger.info({ thresholds: this.currentThresholds }, 'Thresholds reset to defaults');
    return { ...this.currentThresholds };
  }

  /**
   * Get default thresholds (for comparison)
   */
  getDefaultThresholds(): ThresholdSet {
    return { ...DEFAULT_THRESHOLDS };
  }

  /**
   * Run optimization analysis and get recommendations
   */
  async optimize(autoApply: boolean = false): Promise<OptimizationResult> {
    logger.info('Starting threshold optimization analysis');

    try {
      // Get performance data
      const stats = await signalPerformanceTracker.getPerformanceStats(168); // Last 7 days
      const factorAnalysis = await this.analyzeFactors();

      // Check if we have enough data
      if (stats.completedSignals < MIN_DATA_POINTS) {
        logger.info({
          completedSignals: stats.completedSignals,
          required: MIN_DATA_POINTS
        }, 'Insufficient data for optimization');

        return {
          timestamp: new Date(),
          dataPoints: stats.completedSignals,
          currentWinRate: stats.winRate,
          targetWinRate: TARGET_WIN_RATE,
          recommendations: [],
          currentThresholds: this.currentThresholds,
          recommendedThresholds: this.currentThresholds,
          autoApplied: false,
          appliedChanges: [`Insufficient data: ${stats.completedSignals}/${MIN_DATA_POINTS} signals needed`],
        };
      }

      // Generate recommendations
      const recommendations = this.generateRecommendations(stats, factorAnalysis);
      const recommendedThresholds = this.calculateRecommendedThresholds(recommendations);

      // Auto-apply if enabled and confidence is sufficient
      const appliedChanges: string[] = [];
      let autoApplied = false;

      if (autoApply && recommendations.length > 0) {
        const highConfidenceRecs = recommendations.filter(r => r.confidence === 'HIGH');

        if (highConfidenceRecs.length > 0 || stats.winRate < TARGET_WIN_RATE - 10) {
          // Apply changes
          this.currentThresholds = recommendedThresholds;
          autoApplied = true;

          for (const rec of recommendations) {
            if (rec.changeDirection !== 'MAINTAIN') {
              appliedChanges.push(
                `${rec.factor}: ${rec.currentValue} → ${rec.recommendedValue} (${rec.reason})`
              );
            }
          }

          // Save to database
          await this.saveThresholds(recommendedThresholds);

          logger.info({
            appliedChanges,
            newThresholds: recommendedThresholds
          }, 'Auto-applied threshold changes');
        }
      }

      this.lastOptimization = new Date();

      return {
        timestamp: new Date(),
        dataPoints: stats.completedSignals,
        currentWinRate: stats.winRate,
        targetWinRate: TARGET_WIN_RATE,
        recommendations,
        currentThresholds: this.currentThresholds,
        recommendedThresholds,
        autoApplied,
        appliedChanges,
      };
    } catch (error) {
      logger.error({ error }, 'Threshold optimization failed');
      throw error;
    }
  }

  /**
   * Analyze factors and their correlation with winning trades
   */
  private async analyzeFactors(): Promise<FactorAnalysis[]> {
    try {
      const result = await pool.query(`
        SELECT * FROM signal_performance
        WHERE final_outcome IN ('WIN', 'LOSS')
        AND signal_time > NOW() - INTERVAL '14 days'
      `);

      const wins = result.rows.filter((s: any) => s.final_outcome === 'WIN');
      const losses = result.rows.filter((s: any) => s.final_outcome === 'LOSS');

      if (wins.length === 0 || losses.length === 0) {
        return [];
      }

      const analyses: FactorAnalysis[] = [];

      // Analyze momentum score
      analyses.push(this.analyzeFactor(
        'momentum_score',
        wins,
        losses,
        true  // Higher is better
      ));

      // Analyze on-chain score
      analyses.push(this.analyzeFactor(
        'onchain_score',
        wins,
        losses,
        true
      ));

      // Analyze safety score
      analyses.push(this.analyzeFactor(
        'safety_score',
        wins,
        losses,
        true
      ));

      // Analyze bundle risk score
      analyses.push(this.analyzeFactor(
        'bundle_risk_score',
        wins,
        losses,
        false  // Lower is better
      ));

      return analyses.sort((a, b) => b.separation - a.separation);
    } catch (error) {
      logger.error({ error }, 'Factor analysis failed');
      return [];
    }
  }

  /**
   * Analyze a single factor
   */
  private analyzeFactor(
    factorName: string,
    wins: any[],
    losses: any[],
    higherIsBetter: boolean
  ): FactorAnalysis {
    const winValues = wins.map(s => parseFloat(s[factorName]) || 0);
    const lossValues = losses.map(s => parseFloat(s[factorName]) || 0);

    const winAvg = winValues.reduce((a, b) => a + b, 0) / winValues.length;
    const lossAvg = lossValues.reduce((a, b) => a + b, 0) / lossValues.length;

    // Calculate standard deviation
    const winStd = this.standardDeviation(winValues);
    const lossStd = this.standardDeviation(lossValues);

    // Separation score: how well the factor separates wins from losses
    // Higher separation = more useful factor
    const avgStd = (winStd + lossStd) / 2;
    const separation = avgStd > 0 ? Math.abs(winAvg - lossAvg) / avgStd : 0;

    // Calculate optimal threshold
    // For "higher is better" factors: find value that maximizes win ratio
    // For "lower is better" factors: find value that minimizes loss ratio
    const optimalThreshold = higherIsBetter
      ? Math.max(winAvg - winStd, lossAvg)  // Slightly below winning average
      : Math.min(winAvg + winStd, lossAvg); // Slightly above winning average

    // Confidence based on sample size and separation
    const totalSamples = wins.length + losses.length;
    const confidenceScore = Math.min(
      separation * (totalSamples / MIN_DATA_POINTS),
      1.0
    );

    return {
      factor: factorName,
      winningAvg: winAvg,
      losingAvg: lossAvg,
      separation,
      optimalThreshold,
      confidenceScore,
    };
  }

  /**
   * Calculate standard deviation
   */
  private standardDeviation(values: number[]): number {
    if (values.length === 0) return 0;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squareDiffs = values.map(v => Math.pow(v - avg, 2));
    return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  /**
   * Generate threshold recommendations based on analysis
   */
  private generateRecommendations(
    stats: PerformanceStats,
    factorAnalysis: FactorAnalysis[]
  ): ThresholdRecommendation[] {
    const recommendations: ThresholdRecommendation[] = [];

    // Map factor names to threshold keys
    const factorMapping: { [key: string]: keyof ThresholdSet } = {
      'momentum_score': 'minMomentumScore',
      'onchain_score': 'minOnChainScore',
      'safety_score': 'minSafetyScore',
      'bundle_risk_score': 'maxBundleRiskScore',
    };

    for (const analysis of factorAnalysis) {
      const thresholdKey = factorMapping[analysis.factor];
      if (!thresholdKey) continue;

      const currentValue = this.currentThresholds[thresholdKey] as number;
      const isMaxThreshold = thresholdKey.startsWith('max');

      // Determine recommendation based on win rate and factor analysis
      let recommendedValue = currentValue;
      let changeDirection: 'INCREASE' | 'DECREASE' | 'MAINTAIN' = 'MAINTAIN';
      let reason = '';

      if (stats.winRate < TARGET_WIN_RATE - 5) {
        // Win rate too low - tighten thresholds
        if (isMaxThreshold) {
          // For max thresholds (like bundle risk), decrease to be stricter
          recommendedValue = Math.max(
            currentValue - (currentValue * MAX_THRESHOLD_CHANGE / 100),
            analysis.winningAvg
          );
          if (recommendedValue < currentValue) {
            changeDirection = 'DECREASE';
            reason = `Low win rate (${stats.winRate.toFixed(1)}%): tightening to reduce bad signals`;
          }
        } else {
          // For min thresholds, increase to be stricter
          recommendedValue = Math.min(
            currentValue + (currentValue * MAX_THRESHOLD_CHANGE / 100),
            analysis.winningAvg
          );
          if (recommendedValue > currentValue) {
            changeDirection = 'INCREASE';
            reason = `Low win rate (${stats.winRate.toFixed(1)}%): raising threshold to filter weaker signals`;
          }
        }
      } else if (stats.winRate > TARGET_WIN_RATE + 10 && stats.totalSignals < 20) {
        // Win rate high but few signals - loosen thresholds
        if (isMaxThreshold) {
          recommendedValue = Math.min(
            currentValue + (currentValue * MAX_THRESHOLD_CHANGE / 100),
            analysis.losingAvg
          );
          if (recommendedValue > currentValue) {
            changeDirection = 'INCREASE';
            reason = `High win rate (${stats.winRate.toFixed(1)}%) but few signals: loosening for more opportunities`;
          }
        } else {
          recommendedValue = Math.max(
            currentValue - (currentValue * MAX_THRESHOLD_CHANGE / 100),
            analysis.losingAvg
          );
          if (recommendedValue < currentValue) {
            changeDirection = 'DECREASE';
            reason = `High win rate (${stats.winRate.toFixed(1)}%) but few signals: loosening for more opportunities`;
          }
        }
      } else if (analysis.separation > 0.5) {
        // Strong factor - adjust towards optimal threshold
        recommendedValue = Math.round(
          currentValue + (analysis.optimalThreshold - currentValue) * 0.3  // Move 30% towards optimal
        );

        if (Math.abs(recommendedValue - currentValue) > 2) {
          changeDirection = recommendedValue > currentValue ? 'INCREASE' : 'DECREASE';
          reason = `Strong signal factor: adjusting towards optimal (${analysis.optimalThreshold.toFixed(0)})`;
        }
      }

      // Calculate confidence
      let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
      if (analysis.confidenceScore > 0.7 && stats.completedSignals >= 20) {
        confidence = 'HIGH';
      } else if (analysis.confidenceScore > 0.4 && stats.completedSignals >= MIN_DATA_POINTS) {
        confidence = 'MEDIUM';
      }

      recommendations.push({
        factor: this.formatFactorName(analysis.factor),
        currentValue,
        recommendedValue: Math.round(recommendedValue),
        changeDirection,
        changePercent: currentValue > 0
          ? ((recommendedValue - currentValue) / currentValue) * 100
          : 0,
        reason: reason || 'No change needed',
        confidence,
      });
    }

    return recommendations;
  }

  /**
   * Calculate recommended thresholds from recommendations
   */
  private calculateRecommendedThresholds(
    recommendations: ThresholdRecommendation[]
  ): ThresholdSet {
    const newThresholds = { ...this.currentThresholds };

    // Map factor display names back to threshold keys
    const nameMapping: { [key: string]: keyof ThresholdSet } = {
      'Momentum Score': 'minMomentumScore',
      'OnChain Score': 'minOnChainScore',
      'Safety Score': 'minSafetyScore',
      'Bundle Risk Score': 'maxBundleRiskScore',
    };

    for (const rec of recommendations) {
      const key = nameMapping[rec.factor];
      if (key && rec.changeDirection !== 'MAINTAIN') {
        (newThresholds[key] as number) = rec.recommendedValue;
      }
    }

    return newThresholds;
  }

  /**
   * Format factor name for display
   */
  private formatFactorName(factor: string): string {
    return factor
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Save thresholds to database for persistence
   */
  private async saveThresholds(thresholds: ThresholdSet): Promise<void> {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS threshold_history (
          id SERIAL PRIMARY KEY,
          thresholds JSONB NOT NULL,
          applied_at TIMESTAMP DEFAULT NOW()
        )
      `);

      await pool.query(`
        INSERT INTO threshold_history (thresholds)
        VALUES ($1)
      `, [JSON.stringify(thresholds)]);

      logger.info('Thresholds saved to history');
    } catch (error) {
      logger.error({ error }, 'Failed to save thresholds');
    }
  }

  /**
   * Load latest thresholds from database, initializing with defaults if empty
   */
  async loadThresholds(): Promise<void> {
    try {
      // Ensure table exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS threshold_history (
          id SERIAL PRIMARY KEY,
          thresholds JSONB NOT NULL,
          applied_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // One-time migration: Reset to moderate defaults (v2 - Feb 2026)
      // This ensures everyone starts fresh with the new balanced thresholds
      const migrationKey = 'threshold_migration_v2_moderate';
      const migrationCheck = await pool.query(`
        SELECT 1 FROM threshold_history
        WHERE thresholds->>'_migration' = $1
        LIMIT 1
      `, [migrationKey]);

      if (migrationCheck.rows.length === 0) {
        // Migration not applied - reset to new defaults
        logger.info('Applying threshold migration v2: resetting to moderate defaults');
        await pool.query('DELETE FROM threshold_history');
        await pool.query(`
          INSERT INTO threshold_history (thresholds)
          VALUES ($1)
        `, [JSON.stringify({ ...DEFAULT_THRESHOLDS, _migration: migrationKey })]);
        this.currentThresholds = { ...DEFAULT_THRESHOLDS };
        logger.info({ thresholds: this.currentThresholds }, 'Migration complete: moderate thresholds applied');
        return;
      }

      const result = await pool.query(`
        SELECT thresholds FROM threshold_history
        ORDER BY applied_at DESC
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        const savedThresholds = result.rows[0].thresholds;
        // Remove migration key from loaded thresholds
        delete savedThresholds._migration;
        this.currentThresholds = {
          ...DEFAULT_THRESHOLDS,
          ...savedThresholds,
        };
        logger.info({ thresholds: this.currentThresholds }, 'Loaded thresholds from database');
      } else {
        // No thresholds saved - initialize with defaults
        logger.info('No saved thresholds found, initializing with defaults');
        await this.saveThresholds(DEFAULT_THRESHOLDS);
        this.currentThresholds = { ...DEFAULT_THRESHOLDS };
        logger.info({ thresholds: this.currentThresholds }, 'Initialized default thresholds in database');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to load thresholds, using defaults');
      this.currentThresholds = { ...DEFAULT_THRESHOLDS };
    }
  }

  /**
   * Get optimization summary for Telegram report
   */
  async getOptimizationSummary(): Promise<string> {
    const result = await this.optimize(false);

    let summary = '🎯 **Threshold Optimization**\n\n';

    summary += `📊 Data Points: ${result.dataPoints}\n`;
    summary += `📈 Current Win Rate: ${result.currentWinRate.toFixed(1)}%\n`;
    summary += `🎯 Target Win Rate: ${result.targetWinRate}%\n\n`;

    if (result.recommendations.length === 0) {
      summary += '_Insufficient data for recommendations_\n';
      return summary;
    }

    summary += '**Current Thresholds:**\n';
    summary += `• Min Momentum: ${result.currentThresholds.minMomentumScore}\n`;
    summary += `• Min OnChain: ${result.currentThresholds.minOnChainScore}\n`;
    summary += `• Min Safety: ${result.currentThresholds.minSafetyScore}\n`;
    summary += `• Max Bundle Risk: ${result.currentThresholds.maxBundleRiskScore}\n\n`;

    const changesNeeded = result.recommendations.filter(r => r.changeDirection !== 'MAINTAIN');

    if (changesNeeded.length > 0) {
      summary += '**Recommended Changes:**\n';
      for (const rec of changesNeeded) {
        const arrow = rec.changeDirection === 'INCREASE' ? '↑' : '↓';
        summary += `${arrow} ${rec.factor}: ${rec.currentValue} → ${rec.recommendedValue}\n`;
        summary += `   _${rec.reason}_\n`;
      }
    } else {
      summary += '✅ _All thresholds are optimally configured_\n';
    }

    return summary;
  }
}

// ============ EXPORTS ============

export const thresholdOptimizer = new ThresholdOptimizer();

export default {
  ThresholdOptimizer,
  thresholdOptimizer,
};
