// ===========================================
// MODULE 3: SCORING & RANKING SYSTEM
// ===========================================

import { appConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { kolWalletMonitor } from './kol-tracker.js';
import {
  TokenMetrics,
  SocialMetrics,
  VolumeAuthenticityScore,
  ScamFilterOutput,
  KolWalletActivity,
  ScoreFactors,
  TokenScore,
  RiskLevel,
  ScamFilterResult,
  WalletType,
} from '../types/index.js';

// ============ SCORING WEIGHTS ============

const FACTOR_WEIGHTS = {
  onChainHealth: 0.20,
  socialMomentum: 0.15,
  kolConvictionMain: 0.25,
  kolConvictionSide: 0.15,
  scamRiskInverse: 0.25,
} as const;

// ============ SCORING THRESHOLDS ============

const THRESHOLDS = {
  // Score requirements
  MIN_SCORE_BUY: appConfig.trading.minScoreBuySignal,
  MIN_SCORE_WATCH: appConfig.trading.minScoreWatchSignal,
  
  // Risk levels
  RISK_VERY_LOW_MAX_SCORE: 85,
  RISK_LOW_MAX_SCORE: 75,
  RISK_MEDIUM_MAX_SCORE: 65,
  RISK_HIGH_MAX_SCORE: 55,
  
  // On-chain health
  IDEAL_VOLUME_MCAP_RATIO: 0.3,
  IDEAL_HOLDER_COUNT: 500,
  IDEAL_TOP10_CONCENTRATION: 30,
  
  // Social
  IDEAL_MENTION_VELOCITY: 100,
  
  // Narrative multipliers
  NARRATIVE_STRONG_MULTIPLIER: 1.3,
  NARRATIVE_MODERATE_MULTIPLIER: 1.15,
  NARRATIVE_WEAK_MULTIPLIER: 1.0,
} as const;

// ============ CURRENT META THEMES ============
// Update this periodically based on market observation

const CURRENT_META_THEMES = [
  'AI',
  'agent',
  'political',
  'trump',
  'maga',
  'pepe',
  'doge',
  'cat',
  'dog',
  'meme revival',
  'solana native',
] as const;

// ============ SCORING ENGINE ============

export class ScoringEngine {
  /**
   * Calculate complete token score
   */
  calculateScore(
    tokenAddress: string,
    metrics: TokenMetrics,
    socialMetrics: SocialMetrics,
    volumeAuthenticity: VolumeAuthenticityScore,
    scamFilter: ScamFilterOutput,
    kolActivities: KolWalletActivity[]
  ): TokenScore {
    // Calculate individual factors
    const factors: ScoreFactors = {
      onChainHealth: this.calculateOnChainHealth(metrics, volumeAuthenticity),
      socialMomentum: this.calculateSocialMomentum(socialMetrics),
      kolConvictionMain: this.calculateKolConviction(kolActivities, WalletType.MAIN),
      kolConvictionSide: this.calculateKolConviction(kolActivities, WalletType.SIDE),
      scamRiskInverse: this.calculateScamRiskInverse(scamFilter),
      narrativeBonus: this.calculateNarrativeBonus(metrics, socialMetrics),
      timingBonus: this.calculateTimingBonus(metrics),
    };
    
    // Calculate weighted composite
    const baseScore = 
      (factors.onChainHealth * FACTOR_WEIGHTS.onChainHealth) +
      (factors.socialMomentum * FACTOR_WEIGHTS.socialMomentum) +
      (factors.kolConvictionMain * FACTOR_WEIGHTS.kolConvictionMain) +
      (factors.kolConvictionSide * FACTOR_WEIGHTS.kolConvictionSide) +
      (factors.scamRiskInverse * FACTOR_WEIGHTS.scamRiskInverse);
    
    // Add bonuses
    const compositeScore = Math.min(150, baseScore + factors.narrativeBonus + factors.timingBonus);
    
    // Determine confidence and flags
    const { confidence, confidenceBand, flags } = this.determineConfidence(
      metrics,
      kolActivities,
      scamFilter
    );
    
    // Determine risk level
    const riskLevel = this.determineRiskLevel(compositeScore, scamFilter, kolActivities);
    
    return {
      tokenAddress,
      compositeScore: Math.round(compositeScore),
      factors,
      confidence,
      confidenceBand,
      flags,
      riskLevel,
    };
  }
  
  /**
   * Calculate on-chain health score (0-100)
   */
  private calculateOnChainHealth(
    metrics: TokenMetrics,
    volumeAuthenticity: VolumeAuthenticityScore
  ): number {
    let score = 0;
    
    // Volume/MCap ratio (0-25 points)
    const volumeRatioScore = Math.min(25, (metrics.volumeMarketCapRatio / THRESHOLDS.IDEAL_VOLUME_MCAP_RATIO) * 25);
    score += volumeRatioScore;
    
    // Holder count (0-25 points)
    const holderScore = Math.min(25, (metrics.holderCount / THRESHOLDS.IDEAL_HOLDER_COUNT) * 25);
    score += holderScore;
    
    // Top 10 concentration (0-25 points) - lower is better
    const concentrationScore = Math.max(0, 25 - ((metrics.top10Concentration - THRESHOLDS.IDEAL_TOP10_CONCENTRATION) / 2));
    score += concentrationScore;
    
    // Volume authenticity (0-25 points)
    const authenticityScore = volumeAuthenticity.score * 0.25;
    score += authenticityScore;
    
    return Math.min(100, Math.max(0, score));
  }
  
  /**
   * Calculate social momentum score (0-100)
   */
  private calculateSocialMomentum(socialMetrics: SocialMetrics): number {
    let score = 0;
    
    // Mention velocity (0-30 points)
    const velocityScore = Math.min(30, (socialMetrics.mentionVelocity1h / THRESHOLDS.IDEAL_MENTION_VELOCITY) * 30);
    score += velocityScore;
    
    // Engagement quality (0-25 points)
    const engagementScore = socialMetrics.engagementQuality * 25;
    score += engagementScore;
    
    // Account authenticity (0-25 points)
    const authenticityScore = socialMetrics.accountAuthenticity * 25;
    score += authenticityScore;
    
    // Sentiment polarity (0-20 points) - positive sentiment is better
    const sentimentScore = ((socialMetrics.sentimentPolarity + 1) / 2) * 20;
    score += sentimentScore;
    
    return Math.min(100, Math.max(0, score));
  }
  
  /**
   * Calculate KOL conviction score for a specific wallet type (0-100)
   */
  private calculateKolConviction(
    activities: KolWalletActivity[],
    walletType: WalletType
  ): number {
    const filtered = activities.filter(a => a.wallet.walletType === walletType);
    
    if (filtered.length === 0) {
      return 0;
    }
    
    let totalWeight = 0;
    
    for (const activity of filtered) {
      const weight = kolWalletMonitor.calculateSignalWeight(activity);
      
      // Scale by buy size (normalised)
      const sizeMultiplier = Math.min(2, activity.transaction.solAmount / 10);
      
      totalWeight += weight * sizeMultiplier;
    }
    
    // Normalise to 0-100 (cap at 100)
    return Math.min(100, totalWeight * 50);
  }
  
  /**
   * Calculate inverse scam risk score (0-100)
   * Higher score = lower scam risk = better
   */
  private calculateScamRiskInverse(scamFilter: ScamFilterOutput): number {
    if (scamFilter.result === ScamFilterResult.REJECT) {
      return 0;
    }
    
    let score = 100;
    
    // Deduct for each flag
    const flagPenalty = 10;
    score -= scamFilter.flags.length * flagPenalty;
    
    // Additional deductions for specific risks
    if (!scamFilter.contractAnalysis.mintAuthorityRevoked) {
      score -= 30;
    }
    if (!scamFilter.contractAnalysis.freezeAuthorityRevoked) {
      score -= 30;
    }
    if (scamFilter.bundleAnalysis.hasRugHistory) {
      score -= 25;
    }
    if (scamFilter.bundleAnalysis.bundledSupplyPercent > 15) {
      score -= 15;
    }
    if (scamFilter.devBehaviour?.transferredToCex) {
      score -= 40;
    }
    
    // Flag result gets base penalty
    if (scamFilter.result === ScamFilterResult.FLAG) {
      score = Math.min(score, 70);
    }
    
    return Math.max(0, score);
  }
  
  /**
   * Calculate narrative bonus (0-30)
   */
  private calculateNarrativeBonus(
    metrics: TokenMetrics,
    socialMetrics: SocialMetrics
  ): number {
    if (!socialMetrics.narrativeFit) {
      return 0;
    }
    
    const narrative = socialMetrics.narrativeFit.toLowerCase();
    
    // Check if narrative matches current meta themes
    const isStrongMatch = CURRENT_META_THEMES.some(theme => 
      narrative.includes(theme.toLowerCase()) || 
      metrics.name.toLowerCase().includes(theme.toLowerCase()) ||
      metrics.ticker.toLowerCase().includes(theme.toLowerCase())
    );
    
    if (isStrongMatch) {
      return 25;
    }
    
    // Moderate match if KOL mentions align with narrative
    if (socialMetrics.kolMentions.length > 0) {
      return 15;
    }
    
    return 5;
  }
  
  /**
   * Calculate timing bonus (0-20)
   * Earlier in lifecycle = higher bonus
   */
  private calculateTimingBonus(metrics: TokenMetrics): number {
    const ageMinutes = metrics.tokenAge;
    
    if (ageMinutes < 60) {
      return 20; // < 1 hour
    } else if (ageMinutes < 180) {
      return 15; // 1-3 hours
    } else if (ageMinutes < 360) {
      return 10; // 3-6 hours
    } else if (ageMinutes < 720) {
      return 5; // 6-12 hours
    }
    
    return 0; // > 12 hours
  }
  
  /**
   * Determine confidence level and flags
   */
  private determineConfidence(
    metrics: TokenMetrics,
    kolActivities: KolWalletActivity[],
    scamFilter: ScamFilterOutput
  ): { confidence: 'HIGH' | 'MEDIUM' | 'LOW'; confidenceBand: number; flags: string[] } {
    const flags: string[] = [];
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH';
    let confidenceBand = 5;
    
    // Check data quality factors
    if (metrics.tokenAge < 120) {
      flags.push('NEW_TOKEN');
      confidence = 'MEDIUM';
      confidenceBand = 15;
    } else if (metrics.tokenAge < 60) {
      confidence = 'LOW';
      confidenceBand = 15;
    }
    
    if (metrics.liquidityPool < 25000) {
      flags.push('LOW_LIQUIDITY');
      if (confidence === 'HIGH') confidence = 'MEDIUM';
      confidenceBand = Math.max(confidenceBand, 10);
    }
    
    // Check KOL factors
    const mainWalletActivities = kolActivities.filter(a => a.wallet.walletType === WalletType.MAIN);
    const sideWalletActivities = kolActivities.filter(a => a.wallet.walletType === WalletType.SIDE);
    
    if (kolActivities.length === 1) {
      flags.push('SINGLE_KOL');
    }
    
    if (mainWalletActivities.length === 0 && sideWalletActivities.length > 0) {
      flags.push('SIDE_ONLY');
      if (confidence === 'HIGH') confidence = 'MEDIUM';
    }
    
    // Check for low sample KOLs
    const lowSampleKols = kolActivities.filter(a => a.performance.totalTrades < 10);
    if (lowSampleKols.length > 0) {
      flags.push('LOW_SAMPLE_KOL');
    }
    
    // Add scam filter flags
    if (scamFilter.result === ScamFilterResult.FLAG) {
      flags.push(...scamFilter.flags.map(f => `SCAM_FLAG: ${f}`));
    }
    
    return { confidence, confidenceBand, flags };
  }
  
  /**
   * Determine overall risk level
   */
  private determineRiskLevel(
    score: number,
    scamFilter: ScamFilterOutput,
    kolActivities: KolWalletActivity[]
  ): RiskLevel {
    // Base risk on score
    let risk: RiskLevel;
    
    if (score >= THRESHOLDS.RISK_VERY_LOW_MAX_SCORE) {
      risk = RiskLevel.VERY_LOW;
    } else if (score >= THRESHOLDS.RISK_LOW_MAX_SCORE) {
      risk = RiskLevel.LOW;
    } else if (score >= THRESHOLDS.RISK_MEDIUM_MAX_SCORE) {
      risk = RiskLevel.MEDIUM;
    } else if (score >= THRESHOLDS.RISK_HIGH_MAX_SCORE) {
      risk = RiskLevel.HIGH;
    } else {
      risk = RiskLevel.VERY_HIGH;
    }
    
    // Increase risk for flagged tokens
    if (scamFilter.result === ScamFilterResult.FLAG && risk < RiskLevel.MEDIUM) {
      risk = RiskLevel.MEDIUM;
    }
    
    // Increase risk if only side wallets
    const hasMainWallet = kolActivities.some(a => a.wallet.walletType === WalletType.MAIN);
    if (!hasMainWallet && risk < RiskLevel.MEDIUM) {
      risk = RiskLevel.MEDIUM;
    }
    
    return risk;
  }
  
  /**
   * Check if a token score meets buy signal requirements
   */
  meetsBuyRequirements(
    score: TokenScore,
    kolActivities: KolWalletActivity[]
  ): { meets: boolean; reason?: string } {
    // Score threshold
    if (score.compositeScore < THRESHOLDS.MIN_SCORE_BUY) {
      return { 
        meets: false, 
        reason: `Score ${score.compositeScore} below minimum ${THRESHOLDS.MIN_SCORE_BUY}` 
      };
    }
    
    // Must have at least one KOL activity
    if (kolActivities.length === 0) {
      return { meets: false, reason: 'No KOL activity detected' };
    }
    
    // At least one KOL must meet signal requirements
    const validActivities = kolActivities.filter(a => kolWalletMonitor.meetsSignalRequirements(a));
    if (validActivities.length === 0) {
      return { meets: false, reason: 'No KOL activity meets confidence requirements' };
    }
    
    return { meets: true };
  }
}

// ============ EXPORTS ============

export const scoringEngine = new ScoringEngine();

export default {
  ScoringEngine,
  scoringEngine,
  FACTOR_WEIGHTS,
  THRESHOLDS,
  CURRENT_META_THEMES,
};
