// ===========================================
// MODULE: THRESHOLD OPTIMIZER
// Automatically adjusts signal thresholds based on historical performance
// Uses factor correlations and win rate analysis to optimize
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { signalPerformanceTracker, PerformanceStats } from './signal-performance-tracker.js';
import { onChainScoringEngine } from '../onchain-scoring.js';

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
  // v3: EV-per-quartile breakdown
  quartileEVs: { q1: number; q2: number; q3: number; q4: number };
  quartileCounts: { q1: number; q2: number; q3: number; q4: number };
  quartileBoundaries: { p25: number; p50: number; p75: number };
}

export interface InteractionEffect {
  factorA: string;
  factorB: string;
  // EV for each quadrant (factor A high/low × factor B high/low)
  quadrants: {
    highHigh: { ev: number; count: number };
    highLow: { ev: number; count: number };
    lowHigh: { ev: number; count: number };
    lowLow: { ev: number; count: number };
  };
  interactionStrength: number; // How much the interaction matters vs independent effects
}

// ============ CONSTANTS ============

// Default thresholds — Phase 2 quality tightening
// Phase 1 let too many weak signals through. Now focusing on higher quality:
// fewer signals, better hit rate, less noise.
// RECALIBRATED (March 2026): After scoring audit demoted momentum to 5% weight
// and removed double-penalization, overall scores shifted downward. Old thresholds
// produced zero signals. Lowered to let the scoring weights + RugCheck/compound
// rug detection handle quality control, while the optimizer can still learn and tighten.
const DEFAULT_THRESHOLDS: ThresholdSet = {
  minMomentumScore: 15,      // Lowered from 20 — momentum is only 5% weight, soft gate
  minOnChainScore: 35,       // Lowered from 40 — social/surge bonuses help push over
  minSafetyScore: 30,        // Lowered from 40 — RugCheck hard gate catches real dangers
  maxBundleRiskScore: 55,    // Raised from 50 — some bundling is normal on micro-caps
  minLiquidity: 500,         // Aligned with MICRO tier config — micro-caps have small pools
  maxTop10Concentration: 80, // Aligned with config — micro-caps are naturally concentrated
};

// v3: PRIMARY METRIC is EV per signal, not win rate.
// Win rate is now a FLOOR (minimum 20%), not a target.
// EV = mean(realized_return) across all signals.
const WIN_RATE_FLOOR = 20;   // Minimum acceptable win rate
const MIN_DATA_POINTS = 20;  // Minimum completed signals for optimization

// Threshold change speed by EV regime
const THRESHOLD_CHANGE_RATES = {
  EV_NEGATIVE: 0.15,      // 15%/cycle — aggressive tighten
  EV_LOW: 0.10,           // 10%/cycle — moderate tighten (0-10% EV)
  EV_MODERATE: 0.05,      // 5%/cycle — fine-tune (10-25% EV)
  EV_HIGH: 0.05,          // 5%/cycle — cautious loosen (25%+ EV)
} as const;

// Holdout validation: 14-day window split
const HOLDOUT_CONFIG = {
  TRAINING_DAYS: 10,
  VALIDATION_DAYS: 4,
  MIN_VALIDATION_RATIO: 0.80, // Validation EV must be >= 80% of training EV
} as const;

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

    // Sync safety/bundle thresholds to on-chain scoring engine in real-time
    this.syncToOnChainEngine();

    logger.info({ thresholds: this.currentThresholds }, 'Thresholds updated manually');
  }

  /**
   * Push current thresholds to the on-chain scoring engine.
   * Called after any threshold change so risk assessment uses fresh values.
   */
  private syncToOnChainEngine(): void {
    try {
      onChainScoringEngine.setDynamicThresholds({
        minSafetyScore: this.currentThresholds.minSafetyScore,
        maxBundleRiskScore: this.currentThresholds.maxBundleRiskScore,
      });
    } catch (error) {
      logger.debug({ error }, 'Failed to sync thresholds to on-chain scoring engine');
    }
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
   * Run optimization analysis and get recommendations.
   * v3: Uses EV per signal as primary metric, win rate as floor.
   * Includes holdout validation to prevent overfitting.
   */
  async optimize(autoApply: boolean = false): Promise<OptimizationResult> {
    logger.info('Starting threshold optimization analysis (v3 EV-based)');

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
          targetWinRate: WIN_RATE_FLOOR,
          recommendations: [],
          currentThresholds: this.currentThresholds,
          recommendedThresholds: this.currentThresholds,
          autoApplied: false,
          appliedChanges: [`Insufficient data: ${stats.completedSignals}/${MIN_DATA_POINTS} signals needed`],
        };
      }

      // v3: Calculate EV per signal (primary metric)
      const evPerSignal = stats.avgReturn; // Mean realized return
      const sortinoRatio = this.calculateSortino(stats);

      // Determine threshold change rate based on EV regime
      let changeRate: number;
      let evRegime: string;
      if (evPerSignal < 0) {
        changeRate = THRESHOLD_CHANGE_RATES.EV_NEGATIVE;
        evRegime = 'NEGATIVE';
      } else if (evPerSignal < 10) {
        changeRate = THRESHOLD_CHANGE_RATES.EV_LOW;
        evRegime = 'LOW';
      } else if (evPerSignal < 25) {
        changeRate = THRESHOLD_CHANGE_RATES.EV_MODERATE;
        evRegime = 'MODERATE';
      } else {
        changeRate = THRESHOLD_CHANGE_RATES.EV_HIGH;
        evRegime = 'HIGH';
      }

      // Win rate floor enforcement
      const winRateBelowFloor = stats.winRate < WIN_RATE_FLOOR;
      if (winRateBelowFloor) {
        changeRate = Math.max(changeRate, THRESHOLD_CHANGE_RATES.EV_NEGATIVE);
        evRegime = 'WIN_RATE_FLOOR_BREACH';
      }

      // Generate recommendations with EV-aware logic
      const recommendations = this.generateRecommendations(stats, factorAnalysis, evPerSignal, changeRate);
      const recommendedThresholds = this.calculateRecommendedThresholds(recommendations);

      // v3: Holdout validation — prevent overfitting
      const appliedChanges: string[] = [];
      let autoApplied = false;

      if (autoApply && recommendations.length > 0) {
        const validationResult = await this.holdoutValidation(recommendedThresholds);
        appliedChanges.push(`EV regime: ${evRegime} | Sortino: ${sortinoRatio.toFixed(2)}`);

        if (validationResult.accepted) {
          this.currentThresholds = recommendedThresholds;
          autoApplied = true;

          for (const rec of recommendations) {
            if (rec.changeDirection !== 'MAINTAIN') {
              appliedChanges.push(
                `${rec.factor}: ${rec.currentValue} → ${rec.recommendedValue} (${rec.reason})`
              );
            }
          }

          await this.saveThresholds(recommendedThresholds);
          this.syncToOnChainEngine();

          logger.info({
            appliedChanges,
            newThresholds: recommendedThresholds,
            evPerSignal,
            sortinoRatio,
          }, 'Auto-applied threshold changes (v3 EV-based)');
        } else {
          appliedChanges.push(`HOLDOUT VALIDATION FAILED: ${validationResult.reason}`);
          logger.warn({
            reason: validationResult.reason,
            trainingEV: validationResult.trainingEV,
            validationEV: validationResult.validationEV,
          }, 'Threshold changes rejected by holdout validation');
        }
      }

      this.lastOptimization = new Date();

      return {
        timestamp: new Date(),
        dataPoints: stats.completedSignals,
        currentWinRate: stats.winRate,
        targetWinRate: WIN_RATE_FLOOR,
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
   * v3: Calculate Sortino ratio (EV / downside deviation).
   */
  private calculateSortino(stats: PerformanceStats): number {
    if (stats.avgReturn <= 0) return 0;
    const downsideDeviation = Math.abs(stats.avgLossReturn) || 1;
    return stats.avgReturn / downsideDeviation;
  }

  /**
   * v3: Holdout validation — split 14-day window into training (10d) and validation (4d).
   * Only accept changes if validation EV >= 80% of training EV.
   */
  private async holdoutValidation(proposedThresholds: ThresholdSet): Promise<{
    accepted: boolean;
    reason: string;
    trainingEV: number;
    validationEV: number;
  }> {
    try {
      // Get training period data (days 1-10)
      const trainingStats = await signalPerformanceTracker.getPerformanceStats(
        HOLDOUT_CONFIG.TRAINING_DAYS * 24
      );
      // Get validation period data (days 11-14 = most recent 4 days)
      const validationStats = await signalPerformanceTracker.getPerformanceStats(
        HOLDOUT_CONFIG.VALIDATION_DAYS * 24
      );

      const trainingEV = trainingStats.avgReturn;
      const validationEV = validationStats.avgReturn;

      // Insufficient validation data
      if (validationStats.completedSignals < 5) {
        return {
          accepted: true, // Allow changes with warning
          reason: 'Insufficient validation data — accepting with low confidence',
          trainingEV,
          validationEV,
        };
      }

      // Validation EV < 0 while training > 0 = REJECT (overfitting)
      if (validationEV < 0 && trainingEV > 0) {
        return {
          accepted: false,
          reason: `Overfitting detected: training EV=${trainingEV.toFixed(1)}% but validation EV=${validationEV.toFixed(1)}%`,
          trainingEV,
          validationEV,
        };
      }

      // Validation EV < 80% of training EV = halve proposed changes
      if (trainingEV > 0 && validationEV < trainingEV * HOLDOUT_CONFIG.MIN_VALIDATION_RATIO) {
        return {
          accepted: true, // Accept but with halved changes (handled by caller)
          reason: `Validation EV (${validationEV.toFixed(1)}%) < 80% of training EV (${trainingEV.toFixed(1)}%) — changes halved`,
          trainingEV,
          validationEV,
        };
      }

      return {
        accepted: true,
        reason: 'Holdout validation passed',
        trainingEV,
        validationEV,
      };
    } catch (error) {
      logger.warn({ error }, 'Holdout validation failed — accepting changes');
      return { accepted: true, reason: 'Validation error — accepting', trainingEV: 0, validationEV: 0 };
    }
  }

  /**
   * Analyze factors and their correlation with winning trades.
   * v3: Uses EV-per-quartile bucketing and interaction effects.
   */
  private async analyzeFactors(): Promise<FactorAnalysis[]> {
    try {
      const result = await pool.query(`
        SELECT *, COALESCE(realized_return, final_return) as effective_return
        FROM signal_performance
        WHERE final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')
        AND signal_time > NOW() - INTERVAL '14 days'
      `);

      const allSignals = result.rows;
      const wins = allSignals.filter((s: any) =>
        s.final_outcome === 'WIN' || s.final_outcome === 'EXPIRED_PROFIT'
      );
      const losses = allSignals.filter((s: any) => s.final_outcome === 'LOSS');

      if (wins.length === 0 || losses.length === 0) {
        return [];
      }

      const analyses: FactorAnalysis[] = [];

      const factors: Array<{ name: string; higherIsBetter: boolean }> = [
        { name: 'momentum_score', higherIsBetter: true },
        { name: 'onchain_score', higherIsBetter: true },
        { name: 'safety_score', higherIsBetter: true },
        { name: 'bundle_risk_score', higherIsBetter: false },
      ];

      for (const { name, higherIsBetter } of factors) {
        analyses.push(this.analyzeFactor(name, wins, losses, allSignals, higherIsBetter));
      }

      // v3: Compute interaction effects for top 3 most predictive factors
      const topFactors = [...analyses].sort((a, b) => b.separation - a.separation).slice(0, 3);
      const interactions: InteractionEffect[] = [];
      for (let i = 0; i < topFactors.length; i++) {
        for (let j = i + 1; j < topFactors.length; j++) {
          interactions.push(this.analyzeInteraction(
            topFactors[i], topFactors[j], allSignals
          ));
        }
      }

      // Store interactions for reporting (accessed via lastInteractionEffects)
      this.lastInteractionEffects = interactions;

      return analyses.sort((a, b) => b.separation - a.separation);
    } catch (error) {
      logger.error({ error }, 'Factor analysis failed');
      return [];
    }
  }

  // v3: Store last computed interaction effects for Telegram reporting
  private lastInteractionEffects: InteractionEffect[] = [];

  /**
   * Get interaction effects from last analysis (for reporting).
   */
  getInteractionEffects(): InteractionEffect[] {
    return this.lastInteractionEffects;
  }

  /**
   * Analyze a single factor with EV-per-quartile bucketing.
   * v3: Uses realized_return (EV) instead of just win/loss classification.
   */
  private analyzeFactor(
    factorName: string,
    wins: any[],
    losses: any[],
    allSignals: any[],
    higherIsBetter: boolean
  ): FactorAnalysis {
    const winValues = wins.map(s => parseFloat(s[factorName]) || 0);
    const lossValues = losses.map(s => parseFloat(s[factorName]) || 0);

    const winAvg = winValues.reduce((a, b) => a + b, 0) / winValues.length;
    const lossAvg = lossValues.reduce((a, b) => a + b, 0) / lossValues.length;

    const winStd = this.standardDeviation(winValues);
    const lossStd = this.standardDeviation(lossValues);

    const avgStd = (winStd + lossStd) / 2;
    const separation = avgStd > 0 ? Math.abs(winAvg - lossAvg) / avgStd : 0;

    const optimalThreshold = higherIsBetter
      ? Math.max(winAvg - winStd, lossAvg)
      : Math.min(winAvg + winStd, lossAvg);

    const totalSamples = wins.length + losses.length;
    const confidenceScore = Math.min(
      separation * (totalSamples / MIN_DATA_POINTS),
      1.0
    );

    // v3: EV-per-quartile analysis
    const allValues = allSignals.map(s => parseFloat(s[factorName]) || 0).sort((a, b) => a - b);
    const p25 = allValues[Math.floor(allValues.length * 0.25)] || 0;
    const p50 = allValues[Math.floor(allValues.length * 0.50)] || 0;
    const p75 = allValues[Math.floor(allValues.length * 0.75)] || 0;

    const quartiles = { q1: [] as number[], q2: [] as number[], q3: [] as number[], q4: [] as number[] };
    for (const signal of allSignals) {
      const val = parseFloat(signal[factorName]) || 0;
      const ret = parseFloat(signal.effective_return) || 0;
      if (val <= p25) quartiles.q1.push(ret);
      else if (val <= p50) quartiles.q2.push(ret);
      else if (val <= p75) quartiles.q3.push(ret);
      else quartiles.q4.push(ret);
    }

    const avgOrZero = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
      factor: factorName,
      winningAvg: winAvg,
      losingAvg: lossAvg,
      separation,
      optimalThreshold,
      confidenceScore,
      quartileEVs: {
        q1: avgOrZero(quartiles.q1),
        q2: avgOrZero(quartiles.q2),
        q3: avgOrZero(quartiles.q3),
        q4: avgOrZero(quartiles.q4),
      },
      quartileCounts: {
        q1: quartiles.q1.length,
        q2: quartiles.q2.length,
        q3: quartiles.q3.length,
        q4: quartiles.q4.length,
      },
      quartileBoundaries: { p25, p50, p75 },
    };
  }

  /**
   * v3: Analyze interaction effects between two factors.
   * Computes EV for each quadrant (high/high, high/low, low/high, low/low)
   * using each factor's median as the split point.
   */
  private analyzeInteraction(
    factorA: FactorAnalysis,
    factorB: FactorAnalysis,
    allSignals: any[]
  ): InteractionEffect {
    const medianA = factorA.quartileBoundaries.p50;
    const medianB = factorB.quartileBoundaries.p50;

    const quadrants = {
      highHigh: [] as number[],
      highLow: [] as number[],
      lowHigh: [] as number[],
      lowLow: [] as number[],
    };

    for (const signal of allSignals) {
      const valA = parseFloat(signal[factorA.factor]) || 0;
      const valB = parseFloat(signal[factorB.factor]) || 0;
      const ret = parseFloat(signal.effective_return) || 0;

      const aHigh = valA > medianA;
      const bHigh = valB > medianB;

      if (aHigh && bHigh) quadrants.highHigh.push(ret);
      else if (aHigh && !bHigh) quadrants.highLow.push(ret);
      else if (!aHigh && bHigh) quadrants.lowHigh.push(ret);
      else quadrants.lowLow.push(ret);
    }

    const avgOrZero = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const hhEv = avgOrZero(quadrants.highHigh);
    const hlEv = avgOrZero(quadrants.highLow);
    const lhEv = avgOrZero(quadrants.lowHigh);
    const llEv = avgOrZero(quadrants.lowLow);

    // Interaction strength: how much the combined effect differs from independent effects
    // If factors are independent, HH - HL - LH + LL ≈ 0
    const interactionStrength = Math.abs(hhEv - hlEv - lhEv + llEv);

    return {
      factorA: factorA.factor,
      factorB: factorB.factor,
      quadrants: {
        highHigh: { ev: hhEv, count: quadrants.highHigh.length },
        highLow: { ev: hlEv, count: quadrants.highLow.length },
        lowHigh: { ev: lhEv, count: quadrants.lowHigh.length },
        lowLow: { ev: llEv, count: quadrants.lowLow.length },
      },
      interactionStrength,
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
   * Generate threshold recommendations based on analysis.
   * v3: Uses EV per signal as primary metric with regime-based change rates.
   * Win rate is only a floor — if above floor, decisions are EV-driven.
   */
  private generateRecommendations(
    stats: PerformanceStats,
    factorAnalysis: FactorAnalysis[],
    evPerSignal: number,
    changeRate: number
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

      let recommendedValue = currentValue;
      let changeDirection: 'INCREASE' | 'DECREASE' | 'MAINTAIN' = 'MAINTAIN';
      let reason = '';

      // v3: Win rate floor breach — always tighten aggressively
      if (stats.winRate < WIN_RATE_FLOOR) {
        if (isMaxThreshold) {
          recommendedValue = Math.max(
            currentValue - (currentValue * changeRate),
            analysis.winningAvg
          );
          if (recommendedValue < currentValue) {
            changeDirection = 'DECREASE';
            reason = `Win rate floor breach (${stats.winRate.toFixed(1)}% < ${WIN_RATE_FLOOR}%): tightening`;
          }
        } else {
          recommendedValue = Math.min(
            currentValue + (currentValue * changeRate),
            analysis.winningAvg
          );
          if (recommendedValue > currentValue) {
            changeDirection = 'INCREASE';
            reason = `Win rate floor breach (${stats.winRate.toFixed(1)}% < ${WIN_RATE_FLOOR}%): tightening`;
          }
        }
      }
      // v3: EV < 0% — tighten aggressively
      else if (evPerSignal < 0) {
        if (isMaxThreshold) {
          recommendedValue = Math.max(
            currentValue - (currentValue * changeRate),
            analysis.winningAvg
          );
          if (recommendedValue < currentValue) {
            changeDirection = 'DECREASE';
            reason = `Negative EV (${evPerSignal.toFixed(1)}%): tightening ${(changeRate * 100).toFixed(0)}%/cycle`;
          }
        } else {
          recommendedValue = Math.min(
            currentValue + (currentValue * changeRate),
            analysis.winningAvg
          );
          if (recommendedValue > currentValue) {
            changeDirection = 'INCREASE';
            reason = `Negative EV (${evPerSignal.toFixed(1)}%): tightening ${(changeRate * 100).toFixed(0)}%/cycle`;
          }
        }
      }
      // v3: EV 0-10% — moderate tighten
      else if (evPerSignal < 10) {
        if (isMaxThreshold) {
          recommendedValue = Math.max(
            currentValue - (currentValue * changeRate),
            analysis.winningAvg
          );
          if (recommendedValue < currentValue) {
            changeDirection = 'DECREASE';
            reason = `Low EV (${evPerSignal.toFixed(1)}%): tightening ${(changeRate * 100).toFixed(0)}%/cycle`;
          }
        } else {
          recommendedValue = Math.min(
            currentValue + (currentValue * changeRate),
            analysis.winningAvg
          );
          if (recommendedValue > currentValue) {
            changeDirection = 'INCREASE';
            reason = `Low EV (${evPerSignal.toFixed(1)}%): tightening ${(changeRate * 100).toFixed(0)}%/cycle`;
          }
        }
      }
      // v3: EV 10-25% — fine-tune using factor analysis
      else if (evPerSignal < 25) {
        if (analysis.separation > 0.5) {
          recommendedValue = Math.round(
            currentValue + (analysis.optimalThreshold - currentValue) * changeRate
          );
          if (Math.abs(recommendedValue - currentValue) > 2) {
            changeDirection = recommendedValue > currentValue ? 'INCREASE' : 'DECREASE';
            reason = `Fine-tuning (EV ${evPerSignal.toFixed(1)}%): moving towards optimal (${analysis.optimalThreshold.toFixed(0)})`;
          }
        }
      }
      // v3: EV 25%+ — cautiously loosen for more volume
      else {
        if (isMaxThreshold) {
          recommendedValue = Math.min(
            currentValue + (currentValue * changeRate),
            analysis.losingAvg
          );
          if (recommendedValue > currentValue) {
            changeDirection = 'INCREASE';
            reason = `High EV (${evPerSignal.toFixed(1)}%): loosening cautiously for more signals`;
          }
        } else {
          recommendedValue = Math.max(
            currentValue - (currentValue * changeRate),
            analysis.losingAvg
          );
          if (recommendedValue < currentValue) {
            changeDirection = 'DECREASE';
            reason = `High EV (${evPerSignal.toFixed(1)}%): loosening cautiously for more signals`;
          }
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

      // One-time migration: Reset thresholds after fixing win/loss classification (v5 - Mar 2026)
      // Previous thresholds were optimized against broken data (all timeouts = LOSS).
      // Now that EXPIRED_PROFIT exists and win rate is corrected, reset to moderate
      // defaults and let the optimizer re-learn from accurate data.
      const migrationKey = 'threshold_migration_v5_corrected_winloss';
      const migrationCheck = await pool.query(`
        SELECT 1 FROM threshold_history
        WHERE thresholds->>'_migration' = $1
        LIMIT 1
      `, [migrationKey]);

      if (migrationCheck.rows.length === 0) {
        // Migration not applied - reset to new defaults
        logger.info('Applying threshold migration v5: Reset after win/loss classification fix');
        await pool.query('DELETE FROM threshold_history');
        await pool.query(`
          INSERT INTO threshold_history (thresholds)
          VALUES ($1)
        `, [JSON.stringify({ ...DEFAULT_THRESHOLDS, _migration: migrationKey })]);
        this.currentThresholds = { ...DEFAULT_THRESHOLDS };
        logger.info({ thresholds: this.currentThresholds }, 'Migration v5 complete: thresholds reset for corrected win/loss data');
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

    // Always sync to on-chain engine after loading
    this.syncToOnChainEngine();
  }

  /**
   * Get optimization summary for Telegram report.
   * v3: Shows EV per signal as primary metric.
   */
  async getOptimizationSummary(): Promise<string> {
    const result = await this.optimize(false);

    let summary = '🎯 **Threshold Optimization (v3 EV-based)**\n\n';

    summary += `📊 Data Points: ${result.dataPoints}\n`;
    summary += `📈 Win Rate: ${result.currentWinRate.toFixed(1)}% (floor: ${WIN_RATE_FLOOR}%)\n`;

    if (result.appliedChanges.length > 0 && result.appliedChanges[0].startsWith('EV regime')) {
      summary += `📉 ${result.appliedChanges[0]}\n`;
    }
    summary += '\n';

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

    // v3: Quartile EV breakdown for top factors
    if (result.recommendations.length > 0) {
      const factorAnalyses = await this.analyzeFactors();
      if (factorAnalyses.length > 0) {
        summary += '\n**EV by Quartile:**\n';
        for (const fa of factorAnalyses.slice(0, 3)) {
          const name = this.formatFactorName(fa.factor);
          summary += `• ${name} Q1→Q4: ${fa.quartileEVs.q1.toFixed(1)}% | ${fa.quartileEVs.q2.toFixed(1)}% | ${fa.quartileEVs.q3.toFixed(1)}% | ${fa.quartileEVs.q4.toFixed(1)}%\n`;
        }
      }
    }

    // v3: Interaction effects
    const interactions = this.getInteractionEffects();
    if (interactions.length > 0) {
      summary += '\n**Interaction Effects:**\n';
      for (const ix of interactions) {
        const nameA = this.formatFactorName(ix.factorA);
        const nameB = this.formatFactorName(ix.factorB);
        summary += `• ${nameA} × ${nameB}:\n`;
        summary += `  HH=${ix.quadrants.highHigh.ev.toFixed(1)}%(${ix.quadrants.highHigh.count}) `;
        summary += `HL=${ix.quadrants.highLow.ev.toFixed(1)}%(${ix.quadrants.highLow.count}) `;
        summary += `LH=${ix.quadrants.lowHigh.ev.toFixed(1)}%(${ix.quadrants.lowHigh.count}) `;
        summary += `LL=${ix.quadrants.lowLow.ev.toFixed(1)}%(${ix.quadrants.lowLow.count})\n`;
      }
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
