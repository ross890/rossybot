// ===========================================
// MODULE: WIN PREDICTOR
// Machine learning-inspired prediction system
// Learns from historical performance to predict win probability
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { TokenMetrics } from '../../types/index.js';

// ============ TYPES ============

export interface SignalFeatures {
  // Core scores
  momentumScore: number;
  onChainScore: number;
  safetyScore: number;
  bundleRiskScore: number;

  // Market metrics
  liquidity: number;
  tokenAge: number;  // minutes
  holderCount: number;
  top10Concentration: number;
  buySellRatio: number;
  uniqueBuyers: number;
  marketCap: number;
  volumeMarketCapRatio: number;
}

export interface WinPrediction {
  winProbability: number;           // 0-100%
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  predictedReturn: number;          // Expected return %

  // Pattern matching
  matchedWinPatterns: string[];
  matchedLossPatterns: string[];

  // Risk factors
  riskFactors: string[];
  bullishFactors: string[];

  // Recommendation
  recommendedAction: 'STRONG_BUY' | 'BUY' | 'WATCH' | 'SKIP';
  positionSizeMultiplier: number;   // 0.5 - 1.5x

  // Timing prediction
  predictedOptimalHoldTime: number; // hours
  earlyExitRisk: number;            // 0-100% (likelihood of early stop-loss)

  // Explanation
  reasoning: string[];
}

export interface FeatureWeight {
  feature: string;
  weight: number;           // Learned weight
  winningAvg: number;       // Average for winning trades
  losingAvg: number;        // Average for losing trades
  threshold: number;        // Optimal threshold
  importance: number;       // How predictive this feature is
}

export interface WinningPattern {
  id: string;
  name: string;
  description: string;
  conditions: PatternCondition[];
  winRate: number;
  avgReturn: number;
  sampleSize: number;
}

interface PatternCondition {
  feature: string;
  operator: '>' | '<' | '>=' | '<=' | 'between';
  value: number;
  upperValue?: number;  // For 'between' operator
}

// ============ CONSTANTS ============

// AUDIT FIX: Lowered initial thresholds to start generating predictions earlier
// Previously required 30 samples which meant ~2-3 weeks of no ML benefit
const MIN_SAMPLES_FOR_PREDICTION = 15;  // Reduced from 30 - start learning sooner
const MIN_PATTERN_SAMPLES = 5;           // Reduced from 10 - discover patterns with less data
const FEATURE_NORMALIZATION: { [key: string]: { min: number; max: number } } = {
  momentumScore: { min: 0, max: 100 },
  onChainScore: { min: 0, max: 100 },
  safetyScore: { min: 0, max: 100 },
  bundleRiskScore: { min: 0, max: 100 },
  liquidity: { min: 1000, max: 500000 },
  tokenAge: { min: 5, max: 10000 },
  holderCount: { min: 10, max: 5000 },
  top10Concentration: { min: 10, max: 90 },
  buySellRatio: { min: 0.1, max: 10 },
  uniqueBuyers: { min: 1, max: 500 },
  marketCap: { min: 10000, max: 25000000 },
  volumeMarketCapRatio: { min: 0.01, max: 2 },
};

// ============ WIN PREDICTOR CLASS ============

export class WinPredictor {
  private featureWeights: Map<string, FeatureWeight> = new Map();
  private winningPatterns: WinningPattern[] = [];
  private losingPatterns: WinningPattern[] = [];
  private lastTrainingTime: Date | null = null;
  private readonly RETRAIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // Retrain weekly for statistical significance

  /**
   * Initialize the predictor and load/train model
   */
  async initialize(): Promise<void> {
    await this.trainModel();
    logger.info('Win Predictor initialized');
  }

  /**
   * Train the model from historical data
   */
  async trainModel(): Promise<void> {
    try {
      logger.info('Training win prediction model...');

      // Load completed signals
      const result = await pool.query(`
        SELECT * FROM signal_performance
        WHERE final_outcome IN ('WIN', 'LOSS')
        ORDER BY signal_time DESC
        LIMIT 1000
      `);

      const signals = result.rows;
      if (signals.length < MIN_SAMPLES_FOR_PREDICTION) {
        logger.warn({ count: signals.length }, 'Insufficient data for training');
        return;
      }

      const wins = signals.filter((s: any) => s.final_outcome === 'WIN');
      const losses = signals.filter((s: any) => s.final_outcome === 'LOSS');

      logger.info({ wins: wins.length, losses: losses.length }, 'Training data loaded');

      // Learn feature weights
      await this.learnFeatureWeights(wins, losses);

      // Discover winning patterns
      await this.discoverPatterns(wins, losses);

      this.lastTrainingTime = new Date();
      logger.info({
        features: this.featureWeights.size,
        winPatterns: this.winningPatterns.length,
        lossPatterns: this.losingPatterns.length,
      }, 'Model training complete');

    } catch (error) {
      logger.error({ error }, 'Failed to train model');
    }
  }

  /**
   * Predict win probability for a new signal
   */
  async predict(features: SignalFeatures): Promise<WinPrediction> {
    // Check if retraining is needed
    if (this.shouldRetrain()) {
      await this.trainModel();
    }

    // If no model trained, return default
    if (this.featureWeights.size === 0) {
      return this.getDefaultPrediction(features);
    }

    const reasoning: string[] = [];
    const riskFactors: string[] = [];
    const bullishFactors: string[] = [];

    // Calculate feature-weighted score
    let weightedScore = 0;
    let totalWeight = 0;

    for (const [featureName, weight] of this.featureWeights) {
      const value = this.getFeatureValue(features, featureName);
      if (value === undefined) continue;

      const normalizedValue = this.normalizeFeature(featureName, value);
      const contribution = normalizedValue * weight.weight * weight.importance;

      weightedScore += contribution;
      totalWeight += Math.abs(weight.weight) * weight.importance;

      // Track significant factors
      if (weight.importance > 0.15) {
        const isGood = value >= weight.threshold === (weight.weight > 0);
        if (isGood) {
          bullishFactors.push(`${this.formatFeatureName(featureName)}: ${this.formatValue(featureName, value)} (above winning avg)`);
        } else {
          riskFactors.push(`${this.formatFeatureName(featureName)}: ${this.formatValue(featureName, value)} (below winning avg)`);
        }
      }
    }

    // Normalize to 0-1 range
    const baseScore = totalWeight > 0 ? (weightedScore / totalWeight + 1) / 2 : 0.3;

    // Pattern matching boost
    const matchedWinPatterns = this.matchPatterns(features, this.winningPatterns);
    const matchedLossPatterns = this.matchPatterns(features, this.losingPatterns);

    let patternBoost = 0;
    for (const pattern of matchedWinPatterns) {
      patternBoost += (pattern.winRate - 50) / 200; // Max +25% from patterns
      reasoning.push(`Matches "${pattern.name}" pattern (${pattern.winRate.toFixed(0)}% WR)`);
    }
    for (const pattern of matchedLossPatterns) {
      patternBoost -= (50 - pattern.winRate) / 200; // Penalty for loss patterns
      riskFactors.push(`Matches loss pattern: ${pattern.name}`);
    }

    // Calculate final probability
    let winProbability = Math.min(95, Math.max(5, (baseScore + patternBoost) * 100));

    // Timing-based adjustments
    const timingPrediction = this.predictTiming(features);

    // Determine confidence
    const confidence = this.calculateConfidence(features, matchedWinPatterns.length);

    // Calculate expected return
    const predictedReturn = this.calculateExpectedReturn(winProbability, matchedWinPatterns);

    // Determine recommendation
    const recommendedAction = this.determineAction(winProbability, confidence, riskFactors.length);

    // Position size multiplier based on confidence
    const positionSizeMultiplier = this.calculatePositionMultiplier(winProbability, confidence);

    return {
      winProbability: Math.round(winProbability * 10) / 10,
      confidence,
      predictedReturn: Math.round(predictedReturn * 10) / 10,

      matchedWinPatterns: matchedWinPatterns.map(p => p.name),
      matchedLossPatterns: matchedLossPatterns.map(p => p.name),

      riskFactors,
      bullishFactors,

      recommendedAction,
      positionSizeMultiplier,

      predictedOptimalHoldTime: timingPrediction.optimalHoldTime,
      earlyExitRisk: timingPrediction.earlyExitRisk,

      reasoning: [
        `Base score: ${(baseScore * 100).toFixed(1)}% (from ${this.featureWeights.size} features)`,
        `Pattern boost: ${(patternBoost * 100).toFixed(1)}%`,
        `Matched ${matchedWinPatterns.length} winning patterns`,
        ...reasoning,
      ],
    };
  }

  /**
   * Learn feature weights from historical data
   */
  private async learnFeatureWeights(wins: any[], losses: any[]): Promise<void> {
    const features = [
      'momentum_score',
      'onchain_score',
      'safety_score',
      'bundle_risk_score',
      'entry_liquidity',
      'entry_token_age',
      'entry_holder_count',
      'entry_top10_concentration',
      'entry_buy_sell_ratio',
      'entry_unique_buyers',
    ];

    this.featureWeights.clear();

    for (const feature of features) {
      const winValues = wins.map(s => parseFloat(s[feature]) || 0).filter(v => v !== 0);
      const lossValues = losses.map(s => parseFloat(s[feature]) || 0).filter(v => v !== 0);

      if (winValues.length < 5 || lossValues.length < 5) continue;

      const winAvg = winValues.reduce((a, b) => a + b, 0) / winValues.length;
      const lossAvg = lossValues.reduce((a, b) => a + b, 0) / lossValues.length;

      const winStd = this.standardDeviation(winValues);
      const lossStd = this.standardDeviation(lossValues);

      // Calculate separation (how well feature separates wins from losses)
      const avgStd = (winStd + lossStd) / 2;
      const separation = avgStd > 0 ? Math.abs(winAvg - lossAvg) / avgStd : 0;

      // Determine if higher is better
      const higherIsBetter = feature === 'bundle_risk_score' || feature === 'entry_top10_concentration'
        ? lossAvg > winAvg
        : winAvg > lossAvg;

      // Calculate weight (-1 to 1)
      const weight = higherIsBetter ? separation / 3 : -separation / 3;

      // Calculate importance (0 to 1)
      const importance = Math.min(1, separation / 2);

      // Optimal threshold
      const threshold = (winAvg + lossAvg) / 2;

      this.featureWeights.set(this.normalizeFeatureName(feature), {
        feature,
        weight: Math.max(-1, Math.min(1, weight)),
        winningAvg: winAvg,
        losingAvg: lossAvg,
        threshold,
        importance,
      });
    }

    // Log top features
    const sortedWeights = Array.from(this.featureWeights.entries())
      .sort((a, b) => b[1].importance - a[1].importance)
      .slice(0, 5);

    logger.info({
      topFeatures: sortedWeights.map(([name, w]) => ({
        name,
        importance: w.importance.toFixed(2),
        weight: w.weight.toFixed(2),
      }))
    }, 'Feature weights learned');
  }

  /**
   * Discover winning and losing patterns
   */
  private async discoverPatterns(wins: any[], losses: any[]): Promise<void> {
    this.winningPatterns = [];
    this.losingPatterns = [];

    // Define pattern templates to test
    const patternTemplates: { name: string; conditions: PatternCondition[] }[] = [
      // High holder count patterns
      {
        name: 'High Holder Growth',
        conditions: [
          { feature: 'holderCount', operator: '>=', value: 200 },
          { feature: 'momentumScore', operator: '>=', value: 40 },
        ],
      },
      {
        name: 'Strong Holder Base',
        conditions: [
          { feature: 'holderCount', operator: '>=', value: 500 },
        ],
      },
      // Proven token patterns
      {
        name: 'Proven Survivor',
        conditions: [
          { feature: 'tokenAge', operator: '>=', value: 240 }, // 4+ hours
          { feature: 'holderCount', operator: '>=', value: 100 },
        ],
      },
      {
        name: 'Mature Token',
        conditions: [
          { feature: 'tokenAge', operator: '>=', value: 720 }, // 12+ hours
          { feature: 'safetyScore', operator: '>=', value: 50 },
        ],
      },
      // Safety patterns
      {
        name: 'High Safety',
        conditions: [
          { feature: 'safetyScore', operator: '>=', value: 65 },
          { feature: 'bundleRiskScore', operator: '<=', value: 30 },
        ],
      },
      // Momentum patterns
      {
        name: 'Strong Momentum',
        conditions: [
          { feature: 'momentumScore', operator: '>=', value: 55 },
          { feature: 'buySellRatio', operator: '>=', value: 1.5 },
        ],
      },
      // Liquidity sweet spot
      {
        name: 'Optimal Liquidity',
        conditions: [
          { feature: 'liquidity', operator: 'between', value: 8000, upperValue: 50000 },
          { feature: 'holderCount', operator: '>=', value: 50 },
        ],
      },
      // Concentrated ownership (risky)
      {
        name: 'Whale Dominated',
        conditions: [
          { feature: 'top10Concentration', operator: '>=', value: 60 },
        ],
      },
      // Too new (risky)
      {
        name: 'Too New',
        conditions: [
          { feature: 'tokenAge', operator: '<', value: 30 },
        ],
      },
      // Low holder (risky)
      {
        name: 'Low Holders',
        conditions: [
          { feature: 'holderCount', operator: '<', value: 50 },
        ],
      },
      // DUAL-TRACK: Early Quality with high safety (track-based pattern)
      {
        name: 'Early Quality Safe',
        conditions: [
          { feature: 'tokenAge', operator: '<', value: 45 },
          { feature: 'safetyScore', operator: '>=', value: 70 },
          { feature: 'bundleRiskScore', operator: '<=', value: 35 },
        ],
      },
      // DUAL-TRACK: Proven Runner with momentum (track-based pattern)
      {
        name: 'Proven with Momentum',
        conditions: [
          { feature: 'tokenAge', operator: '>=', value: 90 },
          { feature: 'momentumScore', operator: '>=', value: 45 },
          { feature: 'holderCount', operator: '>=', value: 100 },
        ],
      },
    ];

    // Test each pattern against historical data
    for (const template of patternTemplates) {
      const matchingWins = wins.filter(s => this.signalMatchesPattern(s, template.conditions));
      const matchingLosses = losses.filter(s => this.signalMatchesPattern(s, template.conditions));

      const total = matchingWins.length + matchingLosses.length;
      if (total < MIN_PATTERN_SAMPLES) continue;

      const winRate = (matchingWins.length / total) * 100;
      const avgReturn = this.calculateAvgReturn([...matchingWins, ...matchingLosses]);

      const pattern: WinningPattern = {
        id: template.name.toLowerCase().replace(/\s+/g, '_'),
        name: template.name,
        description: this.describePattern(template.conditions),
        conditions: template.conditions,
        winRate,
        avgReturn,
        sampleSize: total,
      };

      // Classify as winning or losing pattern
      if (winRate >= 40) {
        this.winningPatterns.push(pattern);
      } else if (winRate < 25) {
        this.losingPatterns.push(pattern);
      }
    }

    // Sort by effectiveness
    this.winningPatterns.sort((a, b) => b.winRate - a.winRate);
    this.losingPatterns.sort((a, b) => a.winRate - b.winRate);

    logger.info({
      winningPatterns: this.winningPatterns.map(p => ({ name: p.name, winRate: p.winRate.toFixed(1) })),
      losingPatterns: this.losingPatterns.map(p => ({ name: p.name, winRate: p.winRate.toFixed(1) })),
    }, 'Patterns discovered');
  }

  /**
   * Check if a signal matches pattern conditions
   */
  private signalMatchesPattern(signal: any, conditions: PatternCondition[]): boolean {
    for (const condition of conditions) {
      const value = this.getSignalFeatureValue(signal, condition.feature);
      if (value === undefined) return false;

      switch (condition.operator) {
        case '>':
          if (!(value > condition.value)) return false;
          break;
        case '<':
          if (!(value < condition.value)) return false;
          break;
        case '>=':
          if (!(value >= condition.value)) return false;
          break;
        case '<=':
          if (!(value <= condition.value)) return false;
          break;
        case 'between':
          if (!(value >= condition.value && value <= (condition.upperValue || condition.value))) return false;
          break;
      }
    }
    return true;
  }

  /**
   * Get feature value from raw signal data
   */
  private getSignalFeatureValue(signal: any, feature: string): number | undefined {
    const mapping: { [key: string]: string } = {
      momentumScore: 'momentum_score',
      onChainScore: 'onchain_score',
      safetyScore: 'safety_score',
      bundleRiskScore: 'bundle_risk_score',
      liquidity: 'entry_liquidity',
      tokenAge: 'entry_token_age',
      holderCount: 'entry_holder_count',
      top10Concentration: 'entry_top10_concentration',
      buySellRatio: 'entry_buy_sell_ratio',
      uniqueBuyers: 'entry_unique_buyers',
    };

    const dbField = mapping[feature] || feature;
    const value = parseFloat(signal[dbField]);
    return isNaN(value) ? undefined : value;
  }

  /**
   * Match features against patterns
   */
  private matchPatterns(features: SignalFeatures, patterns: WinningPattern[]): WinningPattern[] {
    const matched: WinningPattern[] = [];

    for (const pattern of patterns) {
      let matches = true;
      for (const condition of pattern.conditions) {
        const value = this.getFeatureValue(features, condition.feature);
        if (value === undefined) {
          matches = false;
          break;
        }

        switch (condition.operator) {
          case '>':
            if (!(value > condition.value)) matches = false;
            break;
          case '<':
            if (!(value < condition.value)) matches = false;
            break;
          case '>=':
            if (!(value >= condition.value)) matches = false;
            break;
          case '<=':
            if (!(value <= condition.value)) matches = false;
            break;
          case 'between':
            if (!(value >= condition.value && value <= (condition.upperValue || condition.value))) matches = false;
            break;
        }

        if (!matches) break;
      }

      if (matches) {
        matched.push(pattern);
      }
    }

    return matched;
  }

  /**
   * Predict optimal timing
   */
  private predictTiming(features: SignalFeatures): { optimalHoldTime: number; earlyExitRisk: number } {
    // Based on performance data: wins avg 3.5h, losses avg 1.3h
    // Tokens with certain characteristics tend to move faster

    let optimalHoldTime = 3.5; // Default to winning average
    let earlyExitRisk = 30;    // Default risk

    // New tokens are higher risk for early exit
    if (features.tokenAge < 60) {
      earlyExitRisk += 20;
      optimalHoldTime = 2.0; // Shorter hold for new tokens
    } else if (features.tokenAge > 720) {
      earlyExitRisk -= 15;
      optimalHoldTime = 5.0; // Longer hold for mature tokens
    }

    // Low holder count = higher early exit risk
    if (features.holderCount < 50) {
      earlyExitRisk += 25;
    } else if (features.holderCount > 300) {
      earlyExitRisk -= 15;
    }

    // High momentum = faster moves
    if (features.momentumScore > 60) {
      optimalHoldTime = Math.max(1.5, optimalHoldTime - 1);
    }

    // High concentration = pump and dump risk
    if (features.top10Concentration > 50) {
      earlyExitRisk += 20;
    }

    return {
      optimalHoldTime: Math.round(optimalHoldTime * 10) / 10,
      earlyExitRisk: Math.min(90, Math.max(10, earlyExitRisk)),
    };
  }

  /**
   * Calculate confidence level
   */
  private calculateConfidence(features: SignalFeatures, patternMatches: number): 'HIGH' | 'MEDIUM' | 'LOW' {
    let confidenceScore = 50;

    // Boost for pattern matches
    confidenceScore += patternMatches * 15;

    // Boost for data completeness
    const filledFeatures = Object.values(features).filter(v => v !== undefined && v !== 0).length;
    confidenceScore += (filledFeatures / 12) * 20;

    // Boost for feature weights availability
    confidenceScore += Math.min(20, this.featureWeights.size * 2);

    if (confidenceScore >= 75) return 'HIGH';
    if (confidenceScore >= 50) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Calculate expected return
   */
  private calculateExpectedReturn(winProbability: number, matchedPatterns: WinningPattern[]): number {
    // Base expected return
    const avgWinReturn = 80;  // Typical winning return
    const avgLossReturn = -35; // Typical losing return

    let expectedReturn = (winProbability / 100 * avgWinReturn) + ((100 - winProbability) / 100 * avgLossReturn);

    // Adjust based on matched patterns
    for (const pattern of matchedPatterns) {
      if (pattern.avgReturn > 0) {
        expectedReturn = (expectedReturn + pattern.avgReturn) / 2;
      }
    }

    return expectedReturn;
  }

  /**
   * Determine recommended action
   */
  private determineAction(
    winProbability: number,
    confidence: 'HIGH' | 'MEDIUM' | 'LOW',
    riskFactorCount: number
  ): 'STRONG_BUY' | 'BUY' | 'WATCH' | 'SKIP' {
    if (winProbability >= 55 && confidence === 'HIGH' && riskFactorCount <= 1) {
      return 'STRONG_BUY';
    }
    if (winProbability >= 45 && confidence !== 'LOW' && riskFactorCount <= 2) {
      return 'BUY';
    }
    if (winProbability >= 35) {
      return 'WATCH';
    }
    return 'SKIP';
  }

  /**
   * Calculate position size multiplier
   */
  private calculatePositionMultiplier(winProbability: number, confidence: 'HIGH' | 'MEDIUM' | 'LOW'): number {
    let multiplier = 1.0;

    // Probability adjustment
    if (winProbability >= 55) multiplier += 0.2;
    else if (winProbability >= 45) multiplier += 0.1;
    else if (winProbability < 35) multiplier -= 0.3;

    // Confidence adjustment
    if (confidence === 'HIGH') multiplier += 0.15;
    else if (confidence === 'LOW') multiplier -= 0.2;

    return Math.max(0.5, Math.min(1.5, multiplier));
  }

  // ============ HELPER METHODS ============

  private getFeatureValue(features: SignalFeatures, name: string): number | undefined {
    const normalizedName = this.normalizeFeatureName(name);
    return (features as any)[normalizedName];
  }

  private normalizeFeatureName(name: string): string {
    // Convert DB column names to camelCase
    return name
      .replace(/^entry_/, '')
      .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
      .replace(/^([a-z])/, (letter) => letter.toLowerCase());
  }

  private formatFeatureName(name: string): string {
    return name
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  }

  private formatValue(feature: string, value: number): string {
    if (feature.includes('liquidity') || feature.includes('Liquidity')) {
      return `$${value.toLocaleString()}`;
    }
    if (feature.includes('Age') || feature.includes('age')) {
      return value >= 60 ? `${(value / 60).toFixed(1)}h` : `${value.toFixed(0)}min`;
    }
    if (feature.includes('Ratio') || feature.includes('ratio')) {
      return value.toFixed(2);
    }
    return value.toFixed(1);
  }

  private normalizeFeature(name: string, value: number): number {
    const norm = FEATURE_NORMALIZATION[name];
    if (!norm) return value / 100;
    return (value - norm.min) / (norm.max - norm.min);
  }

  private standardDeviation(values: number[]): number {
    if (values.length === 0) return 0;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squareDiffs = values.map(v => Math.pow(v - avg, 2));
    return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  private calculateAvgReturn(signals: any[]): number {
    const returns = signals.map(s => parseFloat(s.final_return) || 0);
    if (returns.length === 0) return 0;
    return returns.reduce((a, b) => a + b, 0) / returns.length;
  }

  private describePattern(conditions: PatternCondition[]): string {
    return conditions.map(c => {
      if (c.operator === 'between') {
        return `${c.feature} ${c.value}-${c.upperValue}`;
      }
      return `${c.feature} ${c.operator} ${c.value}`;
    }).join(', ');
  }

  private shouldRetrain(): boolean {
    if (!this.lastTrainingTime) return true;
    return Date.now() - this.lastTrainingTime.getTime() > this.RETRAIN_INTERVAL_MS;
  }

  private getDefaultPrediction(features: SignalFeatures): WinPrediction {
    // Simple heuristic when no model is trained
    const score = (features.momentumScore + features.safetyScore + (100 - features.bundleRiskScore)) / 3;

    return {
      winProbability: 30,
      confidence: 'LOW',
      predictedReturn: 0,
      matchedWinPatterns: [],
      matchedLossPatterns: [],
      riskFactors: ['Insufficient training data for prediction'],
      bullishFactors: [],
      recommendedAction: 'WATCH',
      positionSizeMultiplier: 0.5,
      predictedOptimalHoldTime: 3.5,
      earlyExitRisk: 50,
      reasoning: ['Default prediction - model not yet trained'],
    };
  }

  /**
   * Get summary of learned model for debugging/display
   */
  getModelSummary(): {
    featureWeights: Array<{ feature: string; weight: number; importance: number }>;
    winningPatterns: Array<{ name: string; winRate: number }>;
    losingPatterns: Array<{ name: string; winRate: number }>;
    lastTrained: Date | null;
  } {
    return {
      featureWeights: Array.from(this.featureWeights.entries())
        .map(([name, w]) => ({
          feature: name,
          weight: Math.round(w.weight * 100) / 100,
          importance: Math.round(w.importance * 100) / 100,
        }))
        .sort((a, b) => b.importance - a.importance),
      winningPatterns: this.winningPatterns.map(p => ({
        name: p.name,
        winRate: Math.round(p.winRate),
      })),
      losingPatterns: this.losingPatterns.map(p => ({
        name: p.name,
        winRate: Math.round(p.winRate),
      })),
      lastTrained: this.lastTrainingTime,
    };
  }
}

// ============ EXPORTS ============

export const winPredictor = new WinPredictor();

export default {
  WinPredictor,
  winPredictor,
};
