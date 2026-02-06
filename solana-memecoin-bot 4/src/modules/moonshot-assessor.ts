// ===========================================
// MODULE: MOONSHOT POTENTIAL ASSESSOR
// ===========================================
// Scoring logic based on patterns from successful memecoins
// that reached $5M+ market cap within 2 weeks

import { logger } from '../utils/logger.js';
import {
  TokenMetrics,
  TokenSafetyResult,
  VolumeAuthenticityScore,
  SocialMetrics,
  MoonshotAssessment,
  MoonshotFactors,
} from '../types/index.js';

// ============ EMPIRICAL PATTERNS FROM SUCCESSFUL MEMECOINS ============
// Based on analysis of tokens that reached $5M+ MC within 2 weeks

const MOONSHOT_PATTERNS = {
  // Volume patterns - loosened for early memecoin entries
  VOLUME: {
    IDEAL_VOLUME_MCAP_RATIO: 0.5,      // 50% volume/mcap in first day is bullish
    MIN_VOLUME_FOR_SCORE: 2000,         // $2k minimum 24h volume (was $10k)
    EXCELLENT_VOLUME_MCAP: 1.0,         // 100%+ ratio is exceptional
  },

  // Holder growth - loosened dramatically for early entries
  HOLDERS: {
    IDEAL_GROWTH_PER_HOUR: 10,          // 10+ new holders/hour (was 50)
    MIN_HOLDERS_EARLY: 15,              // 15 holders minimum (was 100)
    IDEAL_HOLDERS_1H: 40,               // 40+ holders in first hour (was 200)
    MAX_TOP10_CONCENTRATION: 70,        // <70% top 10 (was 40% - memecoins are concentrated)
    IDEAL_TOP10_CONCENTRATION: 40,      // <40% is excellent (was 25%)
  },

  // Liquidity health - loosened for early gems
  LIQUIDITY: {
    IDEAL_RATIO: 0.10,                  // 10% of mcap in liquidity is healthy
    MIN_RATIO: 0.01,                    // <1% is concerning (was 3%)
    MAX_RATIO: 0.25,                    // >25% might indicate manipulation
    MIN_ABSOLUTE: 1000,                 // $1k minimum liquidity (was $15k)
  },

  // Token age sweet spots - wider window
  AGE: {
    TOO_EARLY_MINS: 2,                  // <2 min = very risky (was 15)
    OPTIMAL_MIN_MINS: 5,                // 5 min+ = tradeable (was 30)
    OPTIMAL_MAX_MINS: 720,              // <12 hours = still early (was 4 hours)
    LATE_MINS: 2160,                    // >36 hours = might have missed pump (was 12h)
    TOO_LATE_MINS: 4320,               // >72 hours = probably too late (was 24h)
  },

  // Narrative/meta themes that perform well
  STRONG_NARRATIVES: [
    'ai', 'agent', 'gpt', 'llm', 'neural',  // AI meta
    'trump', 'maga', 'biden', 'political',   // Political
    'pepe', 'wojak', 'chad', 'doge', 'shib', // Classic memes
    'cat', 'dog', 'frog', 'inu',             // Animal memes
    'sol', 'solana', 'jup', 'bonk',          // Solana ecosystem
    'elon', 'musk', 'tesla',                 // Elon influence
  ],

  // Ticker patterns that go viral
  VIRAL_TICKER_PATTERNS: {
    IDEAL_LENGTH_MIN: 3,
    IDEAL_LENGTH_MAX: 5,
    CAPS_PREFERRED: true,
  },
} as const;

// ============ WEIGHT CONFIGURATION ============

const FACTOR_WEIGHTS = {
  volumeVelocity: 0.18,
  holderGrowthRate: 0.15,
  liquidityRatio: 0.12,
  holderDistribution: 0.12,
  narrativeScore: 0.15,
  memeticPotential: 0.08,
  contractSafety: 0.12,
  ageOptimality: 0.08,
} as const;

// ============ MOONSHOT ASSESSOR CLASS ============

export class MoonshotAssessor {
  /**
   * Assess moonshot potential of a token
   */
  assess(
    metrics: TokenMetrics,
    safetyResult: TokenSafetyResult,
    volumeAuthenticity: VolumeAuthenticityScore,
    socialMetrics?: SocialMetrics
  ): MoonshotAssessment {
    const factors: MoonshotFactors = {
      volumeVelocity: this.assessVolumeVelocity(metrics, volumeAuthenticity),
      holderGrowthRate: this.assessHolderGrowth(metrics),
      liquidityRatio: this.assessLiquidity(metrics),
      holderDistribution: this.assessHolderDistribution(metrics),
      narrativeScore: this.assessNarrative(metrics, socialMetrics),
      memeticPotential: this.assessMemeticPotential(metrics),
      contractSafety: this.assessContractSafety(safetyResult),
      ageOptimality: this.assessAgeOptimality(metrics),
    };

    // Calculate weighted score
    const score = this.calculateWeightedScore(factors);

    // Determine grade
    const grade = this.scoreToGrade(score);

    // Identify matched patterns
    const matchedPatterns = this.identifyMatchedPatterns(metrics, factors, socialMetrics);

    // Estimate potential
    const estimatedPotential = this.estimatePotential(score, factors);

    logger.debug('Moonshot assessment completed', {
      token: metrics.address,
      ticker: metrics.ticker,
      score,
      grade,
      estimatedPotential,
      factors,
    });

    return {
      score: Math.round(score),
      grade,
      factors,
      matchedPatterns,
      estimatedPotential,
    };
  }

  /**
   * Assess volume velocity (0-100)
   * High volume relative to market cap indicates strong interest
   */
  private assessVolumeVelocity(
    metrics: TokenMetrics,
    volumeAuthenticity: VolumeAuthenticityScore
  ): number {
    // Base score from volume/mcap ratio
    const ratio = metrics.volumeMarketCapRatio;
    let score = 0;

    if (ratio >= MOONSHOT_PATTERNS.VOLUME.EXCELLENT_VOLUME_MCAP) {
      score = 100;
    } else if (ratio >= MOONSHOT_PATTERNS.VOLUME.IDEAL_VOLUME_MCAP_RATIO) {
      score = 70 + (ratio / MOONSHOT_PATTERNS.VOLUME.EXCELLENT_VOLUME_MCAP) * 30;
    } else {
      score = (ratio / MOONSHOT_PATTERNS.VOLUME.IDEAL_VOLUME_MCAP_RATIO) * 70;
    }

    // Penalize low absolute volume
    if (metrics.volume24h < MOONSHOT_PATTERNS.VOLUME.MIN_VOLUME_FOR_SCORE) {
      score *= 0.5;
    }

    // Adjust for volume authenticity (wash trading detection)
    const authenticityMultiplier = 0.5 + (volumeAuthenticity.score / 200);
    score *= authenticityMultiplier;

    // Heavy penalty if wash trading suspected
    if (volumeAuthenticity.isWashTradingSuspected) {
      score *= 0.3;
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Assess holder growth rate (0-100)
   * Rapid organic holder acquisition is bullish
   */
  private assessHolderGrowth(metrics: TokenMetrics): number {
    let score = 0;

    // Check absolute holder count relative to age
    const holdersPerMinute = metrics.holderCount / Math.max(1, metrics.tokenAge);
    const idealRate = MOONSHOT_PATTERNS.HOLDERS.IDEAL_GROWTH_PER_HOUR / 60;

    score = Math.min(60, (holdersPerMinute / idealRate) * 60);

    // Bonus for strong 1h change
    if (metrics.holderChange1h > 0) {
      const changeScore = Math.min(40, metrics.holderChange1h * 2);
      score += changeScore;
    }

    // Penalty for too few holders
    if (metrics.holderCount < MOONSHOT_PATTERNS.HOLDERS.MIN_HOLDERS_EARLY) {
      score *= (metrics.holderCount / MOONSHOT_PATTERNS.HOLDERS.MIN_HOLDERS_EARLY);
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Assess liquidity health (0-100)
   * Healthy liquidity ratio indicates sustainable trading
   */
  private assessLiquidity(metrics: TokenMetrics): number {
    const liquidityRatio = metrics.liquidityPool / Math.max(1, metrics.marketCap);
    let score = 0;

    // Score based on ratio being in healthy range
    if (liquidityRatio >= MOONSHOT_PATTERNS.LIQUIDITY.MIN_RATIO &&
        liquidityRatio <= MOONSHOT_PATTERNS.LIQUIDITY.MAX_RATIO) {
      // In healthy range
      const distanceFromIdeal = Math.abs(liquidityRatio - MOONSHOT_PATTERNS.LIQUIDITY.IDEAL_RATIO);
      score = 100 - (distanceFromIdeal * 300);
    } else if (liquidityRatio < MOONSHOT_PATTERNS.LIQUIDITY.MIN_RATIO) {
      // Too low - risky
      score = (liquidityRatio / MOONSHOT_PATTERNS.LIQUIDITY.MIN_RATIO) * 40;
    } else {
      // Too high - might indicate manipulation
      score = 60 - ((liquidityRatio - MOONSHOT_PATTERNS.LIQUIDITY.MAX_RATIO) * 100);
    }

    // Penalty for too low absolute liquidity
    if (metrics.liquidityPool < MOONSHOT_PATTERNS.LIQUIDITY.MIN_ABSOLUTE) {
      score *= (metrics.liquidityPool / MOONSHOT_PATTERNS.LIQUIDITY.MIN_ABSOLUTE);
    }

    // Bonus for LP locked
    if (metrics.lpLocked) {
      score = Math.min(100, score + 15);
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Assess holder distribution (0-100)
   * Lower concentration = more decentralized = healthier
   */
  private assessHolderDistribution(metrics: TokenMetrics): number {
    const concentration = metrics.top10Concentration;
    let score = 0;

    if (concentration <= MOONSHOT_PATTERNS.HOLDERS.IDEAL_TOP10_CONCENTRATION) {
      score = 100;
    } else if (concentration <= MOONSHOT_PATTERNS.HOLDERS.MAX_TOP10_CONCENTRATION) {
      // Linear decrease from 100 to 70
      const range = MOONSHOT_PATTERNS.HOLDERS.MAX_TOP10_CONCENTRATION -
                    MOONSHOT_PATTERNS.HOLDERS.IDEAL_TOP10_CONCENTRATION;
      const excess = concentration - MOONSHOT_PATTERNS.HOLDERS.IDEAL_TOP10_CONCENTRATION;
      score = 100 - (excess / range) * 30;
    } else {
      // Above max - significant penalty
      score = 70 - (concentration - MOONSHOT_PATTERNS.HOLDERS.MAX_TOP10_CONCENTRATION);
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Assess narrative alignment (0-100)
   * Strong narrative fit with current meta increases moonshot potential
   */
  private assessNarrative(metrics: TokenMetrics, socialMetrics?: SocialMetrics): number {
    let score = 30; // Base score for having any narrative

    const nameAndTicker = `${metrics.name} ${metrics.ticker}`.toLowerCase();

    // Check for strong narrative themes
    let strongMatchCount = 0;
    for (const theme of MOONSHOT_PATTERNS.STRONG_NARRATIVES) {
      if (nameAndTicker.includes(theme)) {
        strongMatchCount++;
      }
    }

    if (strongMatchCount >= 2) {
      score = 100; // Multiple theme matches = very strong
    } else if (strongMatchCount === 1) {
      score = 80; // Single strong theme match
    }

    // Boost from social metrics if available
    if (socialMetrics) {
      if (socialMetrics.kolMentionDetected) {
        score = Math.min(100, score + 15);
      }
      if (socialMetrics.narrativeFit) {
        score = Math.min(100, score + 10);
      }
      // Positive sentiment boost
      if (socialMetrics.sentimentPolarity > 0.5) {
        score = Math.min(100, score + 10);
      }
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Assess memetic potential (0-100)
   * Viral-friendly tickers and names
   */
  private assessMemeticPotential(metrics: TokenMetrics): number {
    let score = 50; // Base score

    const ticker = metrics.ticker;
    const name = metrics.name;

    // Ticker length analysis
    if (ticker.length >= MOONSHOT_PATTERNS.VIRAL_TICKER_PATTERNS.IDEAL_LENGTH_MIN &&
        ticker.length <= MOONSHOT_PATTERNS.VIRAL_TICKER_PATTERNS.IDEAL_LENGTH_MAX) {
      score += 20;
    }

    // All caps bonus (memes often use caps)
    if (ticker === ticker.toUpperCase()) {
      score += 10;
    }

    // Short memorable name
    if (name.length <= 10) {
      score += 10;
    }

    // Easy to pronounce (no complex character combinations)
    if (/^[a-zA-Z]+$/.test(ticker)) {
      score += 10;
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Assess contract safety (0-100)
   * Safe contracts are prerequisite for sustainable growth
   */
  private assessContractSafety(safetyResult: TokenSafetyResult): number {
    let score = 100;

    // Critical safety checks
    if (safetyResult.mintAuthorityEnabled) {
      score -= 40; // Can mint more tokens = major red flag
    }

    if (safetyResult.freezeAuthorityEnabled) {
      score -= 30; // Can freeze wallets = major red flag
    }

    if (safetyResult.honeypotRisk) {
      score -= 50; // Honeypot = instant reject
    }

    // Insider risk
    if (safetyResult.insiderAnalysis.insiderRiskScore > 50) {
      score -= 20;
    }

    // Deployer holding too much
    if (safetyResult.deployerHolding > 10) {
      score -= 15;
    }

    // Use safety score from the safety result as additional input
    const safetyInfluence = (safetyResult.safetyScore / 100) * 20;
    score = score * 0.8 + safetyInfluence;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Assess age optimality (0-100)
   * Sweet spot is 30min - 4hrs for moonshot entries
   */
  private assessAgeOptimality(metrics: TokenMetrics): number {
    const age = metrics.tokenAge; // in minutes
    let score = 0;

    if (age < MOONSHOT_PATTERNS.AGE.TOO_EARLY_MINS) {
      // Too early - very risky
      score = 20 + (age / MOONSHOT_PATTERNS.AGE.TOO_EARLY_MINS) * 30;
    } else if (age < MOONSHOT_PATTERNS.AGE.OPTIMAL_MIN_MINS) {
      // Early but okay
      score = 50 + ((age - MOONSHOT_PATTERNS.AGE.TOO_EARLY_MINS) /
               (MOONSHOT_PATTERNS.AGE.OPTIMAL_MIN_MINS - MOONSHOT_PATTERNS.AGE.TOO_EARLY_MINS)) * 30;
    } else if (age <= MOONSHOT_PATTERNS.AGE.OPTIMAL_MAX_MINS) {
      // Optimal range
      score = 100;
    } else if (age <= MOONSHOT_PATTERNS.AGE.LATE_MINS) {
      // Getting late but still viable
      score = 100 - ((age - MOONSHOT_PATTERNS.AGE.OPTIMAL_MAX_MINS) /
               (MOONSHOT_PATTERNS.AGE.LATE_MINS - MOONSHOT_PATTERNS.AGE.OPTIMAL_MAX_MINS)) * 40;
    } else if (age <= MOONSHOT_PATTERNS.AGE.TOO_LATE_MINS) {
      // Late
      score = 60 - ((age - MOONSHOT_PATTERNS.AGE.LATE_MINS) /
               (MOONSHOT_PATTERNS.AGE.TOO_LATE_MINS - MOONSHOT_PATTERNS.AGE.LATE_MINS)) * 40;
    } else {
      // Too late for moonshot
      score = 20;
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Calculate weighted score from factors
   */
  private calculateWeightedScore(factors: MoonshotFactors): number {
    return (
      factors.volumeVelocity * FACTOR_WEIGHTS.volumeVelocity +
      factors.holderGrowthRate * FACTOR_WEIGHTS.holderGrowthRate +
      factors.liquidityRatio * FACTOR_WEIGHTS.liquidityRatio +
      factors.holderDistribution * FACTOR_WEIGHTS.holderDistribution +
      factors.narrativeScore * FACTOR_WEIGHTS.narrativeScore +
      factors.memeticPotential * FACTOR_WEIGHTS.memeticPotential +
      factors.contractSafety * FACTOR_WEIGHTS.contractSafety +
      factors.ageOptimality * FACTOR_WEIGHTS.ageOptimality
    );
  }

  /**
   * Convert score to letter grade
   */
  private scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= 70) return 'A';
    if (score >= 50) return 'B';
    if (score >= 35) return 'C';
    if (score >= 20) return 'D';
    return 'F';
  }

  /**
   * Identify which patterns the token matches
   */
  private identifyMatchedPatterns(
    metrics: TokenMetrics,
    factors: MoonshotFactors,
    socialMetrics?: SocialMetrics
  ): string[] {
    const patterns: string[] = [];

    // Volume patterns
    if (factors.volumeVelocity >= 80) {
      patterns.push('HIGH_VOLUME_VELOCITY');
    }
    if (metrics.volumeMarketCapRatio >= MOONSHOT_PATTERNS.VOLUME.EXCELLENT_VOLUME_MCAP) {
      patterns.push('EXCEPTIONAL_VOLUME_RATIO');
    }

    // Holder patterns
    if (factors.holderGrowthRate >= 70) {
      patterns.push('RAPID_HOLDER_GROWTH');
    }
    if (metrics.top10Concentration <= MOONSHOT_PATTERNS.HOLDERS.IDEAL_TOP10_CONCENTRATION) {
      patterns.push('WELL_DISTRIBUTED');
    }

    // Liquidity patterns
    if (factors.liquidityRatio >= 80) {
      patterns.push('HEALTHY_LIQUIDITY');
    }
    if (metrics.lpLocked) {
      patterns.push('LP_LOCKED');
    }

    // Narrative patterns
    const nameAndTicker = `${metrics.name} ${metrics.ticker}`.toLowerCase();
    for (const theme of ['ai', 'agent', 'political', 'trump', 'pepe', 'doge']) {
      if (nameAndTicker.includes(theme)) {
        patterns.push(`NARRATIVE_${theme.toUpperCase()}`);
      }
    }

    // Social patterns
    if (socialMetrics?.kolMentionDetected) {
      patterns.push('KOL_MENTIONED');
    }

    // Age patterns
    if (factors.ageOptimality >= 90) {
      patterns.push('OPTIMAL_AGE');
    }

    // Safety patterns
    if (factors.contractSafety >= 90) {
      patterns.push('SAFE_CONTRACT');
    }

    return patterns;
  }

  /**
   * Estimate moonshot potential based on score and factors
   */
  private estimatePotential(
    score: number,
    factors: MoonshotFactors
  ): 'HIGH' | 'MEDIUM' | 'LOW' {
    // High potential requires high score AND key factors strong
    if (score >= 70 &&
        factors.contractSafety >= 70 &&
        factors.volumeVelocity >= 60) {
      return 'HIGH';
    }

    // Medium potential
    if (score >= 55 && factors.contractSafety >= 50) {
      return 'MEDIUM';
    }

    return 'LOW';
  }

  /**
   * Check if token meets minimum moonshot threshold for discovery signal
   */
  meetsDiscoveryThreshold(assessment: MoonshotAssessment): boolean {
    // Minimum score of 30 for discovery (was 55)
    if (assessment.score < 30) {
      return false;
    }

    // Must have at least D grade (was C)
    if (assessment.grade === 'F') {
      return false;
    }

    // Contract safety - only reject extreme cases (was 50)
    if (assessment.factors.contractSafety < 20) {
      return false;
    }

    return true;
  }
}

// ============ EXPORTS ============

export const moonshotAssessor = new MoonshotAssessor();

export default {
  MoonshotAssessor,
  moonshotAssessor,
  MOONSHOT_PATTERNS,
  FACTOR_WEIGHTS,
};
