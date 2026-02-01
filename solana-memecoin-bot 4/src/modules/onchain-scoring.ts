// ===========================================
// MODULE: ON-CHAIN SCORING ENGINE
// Pure on-chain metrics based scoring - NOT reliant on KOL tracking
// Uses momentum, safety, bundle analysis, and market dynamics
// ===========================================

import { logger } from '../utils/logger.js';
import { TokenMetrics } from '../types/index.js';
import { momentumAnalyzer, MomentumMetrics, MomentumScore } from './momentum-analyzer.js';
import { bundleDetector, BundleAnalysisResult } from './bundle-detector.js';
import { tokenSafetyChecker, TokenSafetyResult } from './safety/token-safety-checker.js';

// ============ TYPES ============

export interface OnChainScore {
  // Overall score
  total: number;                    // 0-100 composite score
  grade: 'A' | 'B' | 'C' | 'D' | 'F';

  // Component scores (each 0-100)
  components: {
    momentum: number;               // Buy pressure, volume velocity
    safety: number;                 // Contract safety, authorities
    bundleSafety: number;           // Insider/bundle risk (inverted)
    marketStructure: number;        // Liquidity, holder distribution
    timing: number;                 // Token age, launch phase
  };

  // Weighted breakdown
  weights: {
    momentum: number;
    safety: number;
    bundleSafety: number;
    marketStructure: number;
    timing: number;
  };

  // Risk assessment
  riskLevel: 'VERY_LOW' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';

  // Signals and flags
  bullishSignals: string[];
  bearishSignals: string[];
  warnings: string[];

  // Recommendation
  recommendation: 'STRONG_BUY' | 'BUY' | 'WATCH' | 'AVOID' | 'STRONG_AVOID';
  rationale: string[];

  // Metadata
  tokenAddress: string;
  analyzedAt: Date;
}

// ============ SCORING WEIGHTS ============

// Weights optimized for pure on-chain analysis (no KOL dependency)
const WEIGHTS = {
  momentum: 0.30,           // 30% - Buy/sell dynamics, volume velocity
  safety: 0.25,             // 25% - Contract safety, honeypot checks
  bundleSafety: 0.20,       // 20% - Insider/bundle risk
  marketStructure: 0.15,    // 15% - Liquidity, distribution
  timing: 0.10,             // 10% - Launch timing optimization
} as const;

// ============ THRESHOLDS ============

const THRESHOLDS = {
  // Grade thresholds
  GRADE_A: 80,
  GRADE_B: 65,
  GRADE_C: 50,
  GRADE_D: 35,

  // Recommendation thresholds
  STRONG_BUY: 80,
  BUY: 65,
  WATCH: 50,
  AVOID: 35,

  // Risk thresholds
  RISK_VERY_LOW: 80,
  RISK_LOW: 65,
  RISK_MEDIUM: 50,
  RISK_HIGH: 35,

  // Market structure ideals
  IDEAL_LIQUIDITY_RATIO: 0.10,     // 10% of mcap
  MIN_LIQUIDITY_USD: 15000,        // $15k minimum
  IDEAL_TOP10_CONCENTRATION: 25,   // 25% max
  MAX_TOP10_CONCENTRATION: 50,     // 50% reject threshold
  MIN_HOLDER_COUNT: 100,
  IDEAL_HOLDER_COUNT: 500,

  // Timing ideals
  OPTIMAL_AGE_MIN: 30,             // 30 minutes minimum
  OPTIMAL_AGE_MAX: 240,            // 4 hours maximum sweet spot
  TOO_EARLY_MIN: 15,               // Too early if < 15 min
  TOO_LATE_HOURS: 24,              // Too late if > 24 hours
} as const;

// ============ ON-CHAIN SCORING ENGINE CLASS ============

export class OnChainScoringEngine {
  /**
   * Calculate comprehensive on-chain score for a token
   */
  async calculateScore(
    tokenAddress: string,
    metrics: TokenMetrics
  ): Promise<OnChainScore> {
    // Gather all analysis data in parallel
    const [momentumMetrics, bundleAnalysis, safetyResult] = await Promise.all([
      momentumAnalyzer.analyze(tokenAddress),
      bundleDetector.analyze(tokenAddress),
      tokenSafetyChecker.checkTokenSafety(tokenAddress),
    ]);

    // Calculate momentum score
    const momentumScore = momentumMetrics
      ? momentumAnalyzer.calculateScore(momentumMetrics)
      : this.createDefaultMomentumScore();

    // Calculate component scores
    const components = {
      momentum: momentumScore.total,
      safety: safetyResult.safetyScore,
      bundleSafety: 100 - bundleAnalysis.riskScore, // Invert - higher = safer
      marketStructure: this.calculateMarketStructureScore(metrics),
      timing: this.calculateTimingScore(metrics.tokenAge),
    };

    // Calculate weighted total
    const total = Math.round(
      components.momentum * WEIGHTS.momentum +
      components.safety * WEIGHTS.safety +
      components.bundleSafety * WEIGHTS.bundleSafety +
      components.marketStructure * WEIGHTS.marketStructure +
      components.timing * WEIGHTS.timing
    );

    // Determine grade and risk level
    const grade = this.determineGrade(total);
    const riskLevel = this.determineRiskLevel(total, components, bundleAnalysis);
    const confidence = this.determineConfidence(momentumScore, safetyResult, bundleAnalysis);

    // Collect signals and warnings
    const { bullishSignals, bearishSignals, warnings } = this.collectSignals(
      momentumScore,
      safetyResult,
      bundleAnalysis,
      metrics
    );

    // Generate recommendation
    const { recommendation, rationale } = this.generateRecommendation(
      total,
      components,
      bullishSignals,
      bearishSignals,
      warnings,
      riskLevel
    );

    const score: OnChainScore = {
      total,
      grade,
      components,
      weights: { ...WEIGHTS },
      riskLevel,
      confidence,
      bullishSignals,
      bearishSignals,
      warnings,
      recommendation,
      rationale,
      tokenAddress,
      analyzedAt: new Date(),
    };

    logger.debug({
      tokenAddress: tokenAddress.slice(0, 8),
      total,
      grade,
      recommendation,
      components,
    }, 'On-chain score calculated');

    return score;
  }

  /**
   * Quick scoring for fast filtering (doesn't do full bundle analysis)
   */
  async quickScore(
    tokenAddress: string,
    metrics: TokenMetrics
  ): Promise<{ score: number; passesMinimum: boolean }> {
    // Quick checks
    const [momentumOk, bundleCheck, safetyResult] = await Promise.all([
      momentumAnalyzer.hasMinimumMomentum(tokenAddress),
      bundleDetector.quickBundleCheck(tokenAddress),
      tokenSafetyChecker.checkTokenSafety(tokenAddress),
    ]);

    // Quick score estimation
    let score = 50; // Start neutral

    // Momentum check
    if (momentumOk) {
      score += 15;
    } else {
      score -= 20;
    }

    // Bundle check
    if (!bundleCheck.suspected) {
      score += 10;
    } else if (bundleCheck.confidence === 'HIGH') {
      score -= 25;
    } else {
      score -= 10;
    }

    // Safety check
    if (safetyResult.safetyScore >= 70) {
      score += 15;
    } else if (safetyResult.safetyScore >= 50) {
      score += 5;
    } else {
      score -= 15;
    }

    // Market structure quick check
    if (metrics.top10Concentration > THRESHOLDS.MAX_TOP10_CONCENTRATION) {
      score -= 15;
    }
    if (metrics.liquidityPool < THRESHOLDS.MIN_LIQUIDITY_USD) {
      score -= 10;
    }
    if (metrics.holderCount < THRESHOLDS.MIN_HOLDER_COUNT) {
      score -= 10;
    }

    score = Math.max(0, Math.min(100, score));

    return {
      score,
      passesMinimum: score >= 45 && !bundleCheck.suspected,
    };
  }

  // ============ COMPONENT SCORING ============

  private calculateMarketStructureScore(metrics: TokenMetrics): number {
    let score = 0;

    // Liquidity score (0-35 points)
    const liquidityRatio = metrics.liquidityPool / Math.max(1, metrics.marketCap);
    if (liquidityRatio >= THRESHOLDS.IDEAL_LIQUIDITY_RATIO) {
      score += 35;
    } else if (liquidityRatio >= 0.05) {
      score += 25;
    } else if (liquidityRatio >= 0.03) {
      score += 15;
    } else {
      score += Math.round(liquidityRatio / 0.03 * 15);
    }

    // Absolute liquidity bonus
    if (metrics.liquidityPool >= 50000) {
      score += 5;
    } else if (metrics.liquidityPool < THRESHOLDS.MIN_LIQUIDITY_USD) {
      score -= 10;
    }

    // Holder distribution (0-30 points)
    if (metrics.top10Concentration <= THRESHOLDS.IDEAL_TOP10_CONCENTRATION) {
      score += 30;
    } else if (metrics.top10Concentration <= 35) {
      score += 22;
    } else if (metrics.top10Concentration <= THRESHOLDS.MAX_TOP10_CONCENTRATION) {
      score += 12;
    } else {
      // Too concentrated
      score -= 10;
    }

    // Holder count (0-25 points)
    if (metrics.holderCount >= THRESHOLDS.IDEAL_HOLDER_COUNT) {
      score += 25;
    } else if (metrics.holderCount >= 300) {
      score += 20;
    } else if (metrics.holderCount >= THRESHOLDS.MIN_HOLDER_COUNT) {
      score += 12;
    } else if (metrics.holderCount >= 50) {
      score += 5;
    }

    // Volume/MCap ratio (0-10 points)
    if (metrics.volumeMarketCapRatio >= 0.5) {
      score += 10;
    } else if (metrics.volumeMarketCapRatio >= 0.2) {
      score += 7;
    } else if (metrics.volumeMarketCapRatio >= 0.1) {
      score += 4;
    }

    return Math.max(0, Math.min(100, score));
  }

  private calculateTimingScore(ageMinutes: number): number {
    // Optimal entry window: 30 minutes to 4 hours
    // Peak window: 45 minutes to 2 hours

    if (ageMinutes < THRESHOLDS.TOO_EARLY_MIN) {
      // Too early - high risk, low score
      return Math.round(20 + (ageMinutes / THRESHOLDS.TOO_EARLY_MIN) * 30);
    }

    if (ageMinutes < THRESHOLDS.OPTIMAL_AGE_MIN) {
      // Getting better but still early
      return Math.round(50 + ((ageMinutes - THRESHOLDS.TOO_EARLY_MIN) / (THRESHOLDS.OPTIMAL_AGE_MIN - THRESHOLDS.TOO_EARLY_MIN)) * 30);
    }

    if (ageMinutes <= 120) {
      // Peak window: 30 min to 2 hours
      return 100;
    }

    if (ageMinutes <= THRESHOLDS.OPTIMAL_AGE_MAX) {
      // Good window: 2 to 4 hours
      return Math.round(90 - ((ageMinutes - 120) / (THRESHOLDS.OPTIMAL_AGE_MAX - 120)) * 20);
    }

    if (ageMinutes <= THRESHOLDS.TOO_LATE_HOURS * 60) {
      // Getting late: 4 to 24 hours
      const hoursOver = (ageMinutes - THRESHOLDS.OPTIMAL_AGE_MAX) / 60;
      return Math.round(70 - hoursOver * 3);
    }

    // Too late - already established or dead
    return 20;
  }

  // ============ ASSESSMENT HELPERS ============

  private determineGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= THRESHOLDS.GRADE_A) return 'A';
    if (score >= THRESHOLDS.GRADE_B) return 'B';
    if (score >= THRESHOLDS.GRADE_C) return 'C';
    if (score >= THRESHOLDS.GRADE_D) return 'D';
    return 'F';
  }

  private determineRiskLevel(
    score: number,
    components: OnChainScore['components'],
    bundleAnalysis: BundleAnalysisResult
  ): OnChainScore['riskLevel'] {
    // Bundle risk can override everything
    if (bundleAnalysis.riskLevel === 'CRITICAL') {
      return 'CRITICAL';
    }

    // Safety issues are serious
    if (components.safety < 40) {
      return 'CRITICAL';
    }

    // Use score-based risk assessment
    if (score >= THRESHOLDS.RISK_VERY_LOW && components.bundleSafety >= 70) {
      return 'VERY_LOW';
    }
    if (score >= THRESHOLDS.RISK_LOW) {
      return 'LOW';
    }
    if (score >= THRESHOLDS.RISK_MEDIUM) {
      return 'MEDIUM';
    }
    if (score >= THRESHOLDS.RISK_HIGH) {
      return 'HIGH';
    }
    return 'CRITICAL';
  }

  private determineConfidence(
    momentumScore: MomentumScore,
    safetyResult: TokenSafetyResult,
    bundleAnalysis: BundleAnalysisResult
  ): 'HIGH' | 'MEDIUM' | 'LOW' {
    let confidenceScore = 0;

    // Momentum confidence
    if (momentumScore.confidence === 'HIGH') confidenceScore += 3;
    else if (momentumScore.confidence === 'MEDIUM') confidenceScore += 2;
    else confidenceScore += 1;

    // Safety data quality
    if (safetyResult.safetyScore > 0) confidenceScore += 2;

    // Bundle analysis completeness
    if (bundleAnalysis.totalEarlyBuyers > 0) confidenceScore += 2;

    // No major warning flags
    if (momentumScore.flags.length === 0) confidenceScore += 1;

    if (confidenceScore >= 7) return 'HIGH';
    if (confidenceScore >= 5) return 'MEDIUM';
    return 'LOW';
  }

  private collectSignals(
    momentumScore: MomentumScore,
    safetyResult: TokenSafetyResult,
    bundleAnalysis: BundleAnalysisResult,
    metrics: TokenMetrics
  ): {
    bullishSignals: string[];
    bearishSignals: string[];
    warnings: string[];
  } {
    const bullishSignals: string[] = [];
    const bearishSignals: string[] = [];
    const warnings: string[] = [];

    // Momentum signals
    bullishSignals.push(...momentumScore.signals);
    bearishSignals.push(...momentumScore.flags.filter(f =>
      f.includes('PRESSURE') || f.includes('DUMPING') || f.includes('DECLINING')
    ));
    warnings.push(...momentumScore.flags.filter(f =>
      f.includes('BOT') || f.includes('VOLATILITY') || f.includes('DIVERSITY')
    ));

    // Safety signals
    if (safetyResult.safetyScore >= 80) {
      bullishSignals.push('SAFE_CONTRACT');
    }
    if (safetyResult.flags) {
      warnings.push(...safetyResult.flags);
    }

    // Bundle signals
    if (bundleAnalysis.riskScore <= 20) {
      bullishSignals.push('CLEAN_LAUNCH');
    }
    if (bundleAnalysis.flags.length > 0) {
      const critical = bundleAnalysis.flags.filter(f => f.includes('CRITICAL'));
      const other = bundleAnalysis.flags.filter(f => !f.includes('CRITICAL'));
      bearishSignals.push(...critical);
      warnings.push(...other);
    }

    // Market structure signals
    if (metrics.top10Concentration <= 25) {
      bullishSignals.push('WELL_DISTRIBUTED');
    }
    if (metrics.holderCount >= 500) {
      bullishSignals.push('STRONG_HOLDER_BASE');
    }
    if (metrics.volumeMarketCapRatio >= 0.5) {
      bullishSignals.push('HIGH_VELOCITY');
    }

    // Timing signals
    if (metrics.tokenAge >= 30 && metrics.tokenAge <= 120) {
      bullishSignals.push('OPTIMAL_TIMING');
    }
    if (metrics.tokenAge < 15) {
      warnings.push('VERY_NEW_TOKEN');
    }

    return { bullishSignals, bearishSignals, warnings };
  }

  private generateRecommendation(
    score: number,
    components: OnChainScore['components'],
    bullishSignals: string[],
    bearishSignals: string[],
    warnings: string[],
    riskLevel: OnChainScore['riskLevel']
  ): { recommendation: OnChainScore['recommendation']; rationale: string[] } {
    const rationale: string[] = [];

    // Critical risk overrides everything
    if (riskLevel === 'CRITICAL') {
      rationale.push('Critical risk level detected');
      if (bearishSignals.length > 0) {
        rationale.push(`Bearish: ${bearishSignals.slice(0, 3).join(', ')}`);
      }
      return { recommendation: 'STRONG_AVOID', rationale };
    }

    // High risk with low score
    if (riskLevel === 'HIGH' && score < 50) {
      rationale.push('High risk with below-average score');
      return { recommendation: 'STRONG_AVOID', rationale };
    }

    // Score-based recommendations with signal adjustments
    let recommendation: OnChainScore['recommendation'];

    if (score >= THRESHOLDS.STRONG_BUY && bullishSignals.length >= 3 && bearishSignals.length === 0) {
      recommendation = 'STRONG_BUY';
      rationale.push(`Excellent score (${score}) with strong bullish signals`);
      rationale.push(`Bullish: ${bullishSignals.slice(0, 3).join(', ')}`);
    } else if (score >= THRESHOLDS.BUY && bearishSignals.length <= 1) {
      recommendation = 'BUY';
      rationale.push(`Good score (${score}) with acceptable risk`);
      if (bullishSignals.length > 0) {
        rationale.push(`Bullish: ${bullishSignals.slice(0, 2).join(', ')}`);
      }
    } else if (score >= THRESHOLDS.WATCH) {
      recommendation = 'WATCH';
      rationale.push(`Moderate score (${score}) - monitor for improvement`);
      if (warnings.length > 0) {
        rationale.push(`Watch for: ${warnings.slice(0, 2).join(', ')}`);
      }
    } else if (score >= THRESHOLDS.AVOID) {
      recommendation = 'AVOID';
      rationale.push(`Below threshold (${score})`);
      if (bearishSignals.length > 0) {
        rationale.push(`Concerns: ${bearishSignals.slice(0, 2).join(', ')}`);
      }
    } else {
      recommendation = 'STRONG_AVOID';
      rationale.push(`Poor score (${score}) with multiple risk factors`);
    }

    // Downgrade for component failures
    if (components.safety < 50 && recommendation !== 'STRONG_AVOID' && recommendation !== 'AVOID') {
      recommendation = 'AVOID';
      rationale.push(`Safety score too low (${components.safety})`);
    }
    if (components.bundleSafety < 40 && recommendation !== 'STRONG_AVOID') {
      recommendation = recommendation === 'STRONG_BUY' ? 'BUY' :
                       recommendation === 'BUY' ? 'WATCH' : 'AVOID';
      rationale.push(`Bundle risk elevated (safety: ${components.bundleSafety})`);
    }

    return { recommendation, rationale };
  }

  private createDefaultMomentumScore(): MomentumScore {
    return {
      total: 50,
      breakdown: {
        buyPressure: 12,
        volumeMomentum: 12,
        tradeQuality: 12,
        holderGrowth: 14,
      },
      signals: [],
      flags: ['NO_MOMENTUM_DATA'],
      confidence: 'LOW',
    };
  }

  /**
   * Check if score meets minimum threshold for trading
   */
  meetsMinimumThreshold(score: OnChainScore): boolean {
    return (
      score.total >= 55 &&
      score.recommendation !== 'AVOID' &&
      score.recommendation !== 'STRONG_AVOID' &&
      score.riskLevel !== 'CRITICAL' &&
      score.components.safety >= 50 &&
      score.components.bundleSafety >= 40
    );
  }
}

// ============ EXPORTS ============

export const onChainScoringEngine = new OnChainScoringEngine();

export default {
  OnChainScoringEngine,
  onChainScoringEngine,
  WEIGHTS,
  THRESHOLDS,
};
