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

// AUDIT FIX: Dynamic threshold integration
// The threshold optimizer learns optimal values - we should use them
interface DynamicThresholds {
  minSafetyScore: number;
  maxBundleRiskScore: number;
}

// Default thresholds if optimizer not available
const DEFAULT_DYNAMIC_THRESHOLDS: DynamicThresholds = {
  minSafetyScore: 20,
  maxBundleRiskScore: 80,
};

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

// HIT RATE IMPROVEMENT: Reweighted based on deeper correlation analysis
//
// Key insight: Token Age +0.84 correlation is MISLEADING - it's selection bias
// (older tokens survived, not that age predicts success). The actionable signals are:
// - Holder Count: +0.36 (genuine predictor - more holders = more organic)
// - Momentum: Actionable signal (buy pressure, volume velocity)
// - Safety: Avoids rugs (critical for loss prevention)
// - Bundle Safety: Insider detection (critical for avoiding dumps)
//
// Previous weights over-emphasized timing (25%) which doesn't help prediction.
const WEIGHTS = {
  momentum: 0.30,           // 30% - INCREASED (most actionable signal)
  safety: 0.25,             // 25% - Keep high (avoids rugs)
  bundleSafety: 0.20,       // 20% - INCREASED (insider detection critical)
  marketStructure: 0.15,    // 15% - INCREASED (holder count is +0.36 correlation)
  timing: 0.10,             // 10% - DECREASED (age is selection bias, not predictive)
} as const;

// ============ THRESHOLDS ============

const THRESHOLDS = {
  // Grade thresholds — tightened for quality
  GRADE_A: 75,
  GRADE_B: 55,
  GRADE_C: 40,
  GRADE_D: 25,

  // Recommendation thresholds — raised to reduce weak signals
  STRONG_BUY: 75,
  BUY: 55,
  WATCH: 40,
  AVOID: 25,

  // Risk thresholds — tightened
  RISK_VERY_LOW: 75,
  RISK_LOW: 55,
  RISK_MEDIUM: 40,
  RISK_HIGH: 25,

  // Market structure ideals — tightened for quality
  IDEAL_LIQUIDITY_RATIO: 0.04,     // 4% of mcap
  MIN_LIQUIDITY_USD: 5000,          // $5K minimum — avoid illiquid death traps
  IDEAL_TOP10_CONCENTRATION: 45,   // 45% max
  MAX_TOP10_CONCENTRATION: 80,     // 80% reject threshold
  MIN_HOLDER_COUNT: 15,             // 15 min holders — need some distribution
  IDEAL_HOLDER_COUNT: 100,          // 100 ideal

  // Timing ideals
  OPTIMAL_AGE_MIN: 5,              // 5 minutes minimum
  OPTIMAL_AGE_MAX: 720,            // 12 hours maximum sweet spot
  TOO_EARLY_MIN: 2,                // Too early only if < 2 min
  TOO_LATE_HOURS: 48,              // Too late if > 48 hours
} as const;

// ============ ON-CHAIN SCORING ENGINE CLASS ============

export class OnChainScoringEngine {
  // AUDIT FIX: Store dynamic thresholds from optimizer
  private dynamicThresholds: DynamicThresholds = { ...DEFAULT_DYNAMIC_THRESHOLDS };

  /**
   * Update thresholds from the optimizer
   * Called by signal generator when thresholds change
   */
  setDynamicThresholds(thresholds: Partial<DynamicThresholds>): void {
    this.dynamicThresholds = {
      ...this.dynamicThresholds,
      ...thresholds,
    };
    logger.debug({ thresholds: this.dynamicThresholds }, 'On-chain scoring thresholds updated');
  }

  /**
   * Get current thresholds
   */
  getDynamicThresholds(): DynamicThresholds {
    return { ...this.dynamicThresholds };
  }

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

    // Performance data analysis:
    // - Holder Count: +0.37 correlation (STRONGEST - increase weight)
    // - Liquidity: -0.23 correlation (higher liquidity = worse, adjust scoring)
    // - Top10 Concentration: +0.01 (neutral)

    // Liquidity score (0-20 points)
    // Performance data shows -0.07 correlation: LOWER liquidity = better returns
    // Sweet spot is $5k-$15k for max memecoin gains (enough to trade, low enough for volatility)
    const liquidityRatio = metrics.liquidityPool / Math.max(1, metrics.marketCap);
    if (metrics.liquidityPool >= 5000 && metrics.liquidityPool <= 15000) {
      // OPTIMAL: Low but tradeable liquidity = max upside potential
      score += 20;
    } else if (metrics.liquidityPool > 15000 && metrics.liquidityPool <= 30000) {
      // Good: Still has upside
      score += 16;
    } else if (metrics.liquidityPool >= THRESHOLDS.MIN_LIQUIDITY_USD && metrics.liquidityPool < 5000) {
      // Adequate but very low - risky but high potential
      score += 14;
    } else if (metrics.liquidityPool > 30000 && metrics.liquidityPool <= 75000) {
      // Higher liquidity - reduced upside potential
      score += 10;
    } else if (metrics.liquidityPool > 75000) {
      // Very high liquidity - established token, limited upside (penalize more)
      score += 5;
    } else if (metrics.liquidityPool >= THRESHOLDS.MIN_LIQUIDITY_USD * 0.5) {
      // Below minimum but not critically low
      score += 8;
    }
    // Below 50% of minimum liquidity = 0 points (too risky to trade)

    // Holder count (0-40 points) - INCREASED from 25 (strongest positive correlation)
    if (metrics.holderCount >= THRESHOLDS.IDEAL_HOLDER_COUNT) {
      score += 40;
    } else if (metrics.holderCount >= 300) {
      score += 35;
    } else if (metrics.holderCount >= 150) {
      score += 28;
    } else if (metrics.holderCount >= 75) {
      score += 20;
    } else if (metrics.holderCount >= THRESHOLDS.MIN_HOLDER_COUNT) {
      score += 12;
    } else if (metrics.holderCount >= 10) {
      score += 5;
    }

    // Holder distribution (0-25 points)
    if (metrics.top10Concentration <= THRESHOLDS.IDEAL_TOP10_CONCENTRATION) {
      score += 25;
    } else if (metrics.top10Concentration <= 50) {
      score += 20;
    } else if (metrics.top10Concentration <= THRESHOLDS.MAX_TOP10_CONCENTRATION) {
      score += 12;
    } else {
      // Too concentrated - risky
      score += 0;
    }

    // Volume/MCap ratio (0-15 points)
    if (metrics.volumeMarketCapRatio >= 0.5) {
      score += 15;
    } else if (metrics.volumeMarketCapRatio >= 0.2) {
      score += 12;
    } else if (metrics.volumeMarketCapRatio >= 0.1) {
      score += 8;
    } else if (metrics.volumeMarketCapRatio >= 0.05) {
      score += 4;
    }

    return Math.max(0, Math.min(100, score));
  }

  private calculateTimingScore(ageMinutes: number): number {
    // AUDIT FIX: Rebalanced to not overly penalize early tokens
    // The system is designed for early detection (MIN_TOKEN_AGE: 5 min)
    // Old scoring gave 30-50 to early tokens, making them unlikely to signal
    // New scoring: early tokens start at 60, optimal window expanded

    if (ageMinutes < 5) {
      // < 5 min: Very early, still risky but not disqualifying
      return 55 + (ageMinutes * 2); // 55-65
    }

    if (ageMinutes < THRESHOLDS.TOO_EARLY_MIN) {
      // 5-15 min: Early but tradeable
      return 65 + ((ageMinutes - 5) / 10) * 10; // 65-75
    }

    if (ageMinutes < THRESHOLDS.OPTIMAL_AGE_MIN) {
      // 15-30 min: Good early entry window
      return 75 + ((ageMinutes - THRESHOLDS.TOO_EARLY_MIN) / 15) * 10; // 75-85
    }

    if (ageMinutes < 60) {
      // 30-60 min: Sweet spot for early entries
      return 85;
    }

    if (ageMinutes < 120) {
      // 1-2 hours: Strong timing
      return 90;
    }

    if (ageMinutes <= THRESHOLDS.OPTIMAL_AGE_MAX) {
      // 2-4 hours: Proven with good upside
      return 95;
    }

    if (ageMinutes <= 720) {
      // 4-12 hours: Established, good for follow-up
      return 85;
    }

    if (ageMinutes <= THRESHOLDS.TOO_LATE_HOURS * 60) {
      // 12-24 hours: Mature token
      return 75;
    }

    if (ageMinutes <= 4320) {
      // 1-3 days: Established
      return 65;
    }

    // > 3 days - Older token, limited upside
    return 55;
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
    // AUDIT FIX: Now uses dynamic thresholds from the optimizer
    const maxBundleRisk = this.dynamicThresholds.maxBundleRiskScore;
    const minSafety = this.dynamicThresholds.minSafetyScore;

    // Bundle risk can override everything
    if (bundleAnalysis.riskLevel === 'CRITICAL') {
      return 'CRITICAL';
    }

    // AUDIT FIX: Use dynamic bundle risk threshold
    // Critical if significantly above threshold
    if (bundleAnalysis.riskScore >= maxBundleRisk + 20) {
      return 'CRITICAL';
    }
    // High if above threshold
    if (bundleAnalysis.riskScore >= maxBundleRisk) {
      return 'HIGH';
    }

    // Safety issues - CRITICAL if very low (honeypot likely)
    if (components.safety < minSafety - 15) {
      return 'CRITICAL';
    }

    // Use score-based risk assessment with dynamic thresholds
    const bundleSafetyThreshold = 100 - maxBundleRisk; // Convert risk to safety
    if (score >= THRESHOLDS.RISK_VERY_LOW &&
        components.bundleSafety >= bundleSafetyThreshold &&
        components.safety >= minSafety + 10) {
      return 'VERY_LOW';
    }
    if (score >= THRESHOLDS.RISK_LOW && components.bundleSafety >= bundleSafetyThreshold - 20) {
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
    // Thresholds lowered to generate more signals for early tokens
    let recommendation: OnChainScore['recommendation'];

    if (score >= THRESHOLDS.STRONG_BUY && bullishSignals.length >= 2 && bearishSignals.length === 0) {
      recommendation = 'STRONG_BUY';
      rationale.push(`Excellent score (${score}) with strong bullish signals`);
      rationale.push(`Bullish: ${bullishSignals.slice(0, 3).join(', ')}`);
    } else if (score >= THRESHOLDS.BUY && bearishSignals.length <= 2) {
      recommendation = 'BUY';
      rationale.push(`Good score (${score}) with acceptable risk`);
      if (bullishSignals.length > 0) {
        rationale.push(`Bullish: ${bullishSignals.slice(0, 2).join(', ')}`);
      }
    } else if (score >= 30) {  // ALIGNED WITH minOnChainScore (30) - prevents threshold conflict
      // Previously set to 40, which caused conflict:
      // - minOnChainScore: 30 (tokens with score >= 30 should pass)
      // - WATCH threshold: 40 (tokens 30-39 got AVOID and were blocked)
      // Now aligned to 30 so tokens 30-39 get WATCH (can generate signals) not AVOID (blocked)
      recommendation = 'WATCH';
      rationale.push(`Moderate score (${score}) - monitor for improvement`);
      if (warnings.length > 0) {
        rationale.push(`Watch for: ${warnings.slice(0, 2).join(', ')}`);
      }
    } else if (score >= 20) {  // Lowered from 25 to 20 - gives AVOID more range
      recommendation = 'AVOID';
      rationale.push(`Below threshold (${score})`);
      if (bearishSignals.length > 0) {
        rationale.push(`Concerns: ${bearishSignals.slice(0, 2).join(', ')}`);
      }
    } else {
      recommendation = 'STRONG_AVOID';
      rationale.push(`Poor score (${score}) with multiple risk factors`);
    }

    // Downgrade for component failures - relaxed thresholds
    if (components.safety < 30 && recommendation !== 'STRONG_AVOID' && recommendation !== 'AVOID') {
      recommendation = 'WATCH';  // Downgrade to WATCH, not AVOID
      rationale.push(`Safety score low (${components.safety}) - use caution`);
    }
    if (components.bundleSafety < 30 && recommendation !== 'STRONG_AVOID') {
      // Only downgrade by one level
      recommendation = recommendation === 'STRONG_BUY' ? 'BUY' :
                       recommendation === 'BUY' ? 'WATCH' : recommendation;
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
   * IMPROVEMENT: Now uses dynamic thresholds from the optimizer instead of hardcoded values
   * This allows the system to learn and adapt optimal thresholds from performance data
   */
  meetsMinimumThreshold(score: OnChainScore): boolean {
    // Use dynamic thresholds from optimizer (or defaults if not set)
    const minSafety = Math.max(25, this.dynamicThresholds.minSafetyScore - 15); // Floor at 25
    const minBundleSafety = 100 - this.dynamicThresholds.maxBundleRiskScore; // Convert risk to safety

    return (
      score.total >= 35 &&                          // Base threshold
      score.recommendation !== 'STRONG_AVOID' &&    // Only block STRONG_AVOID
      score.riskLevel !== 'CRITICAL' &&
      score.components.safety >= minSafety &&       // Dynamic from optimizer
      score.components.bundleSafety >= minBundleSafety  // Dynamic from optimizer
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
