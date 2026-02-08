// ===========================================
// MODULE 3: SCORING & RANKING SYSTEM
// ===========================================

import { appConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { kolWalletMonitor } from './kol-tracker.js';
import {
  TokenMetrics,
  SocialMetrics,
  KolMention,
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

// KOL-validated signal weights
// NOTE: socialMomentum uses on-chain proxy (no Twitter connected) — kept at reduced weight
const FACTOR_WEIGHTS = {
  onChainHealth: 0.25,
  socialMomentum: 0.10,     // On-chain proxy only, capped at 0.6
  kolConvictionMain: 0.25,
  kolConvictionSide: 0.15,
  scamRiskInverse: 0.25,
} as const;

// Discovery weights (metrics-only, no KOL)
// NOTE: socialMomentum uses on-chain proxy (no Twitter connected)
const DISCOVERY_WEIGHTS = {
  onChainHealth: 0.40,
  socialMomentum: 0.15,     // On-chain proxy only, capped at 0.6
  scamRiskInverse: 0.45,
} as const;

// KOL multiplier configuration
const KOL_MULTIPLIER = {
  NO_KOL: 1.0,              // Base score with no KOL
  SINGLE_SIDE_WALLET: 1.15, // Single side wallet buy
  SINGLE_MAIN_WALLET: 1.25, // Single main wallet buy
  MULTI_SIDE_WALLET: 1.30,  // Multiple side wallet buys
  MULTI_MAIN_WALLET: 1.45,  // Multiple main wallet buys
  MIXED_WALLETS: 1.40,      // Both main and side wallets
  HIGH_CONVICTION: 1.60,    // 3+ KOLs with main wallets
} as const;

// ============ SCORING THRESHOLDS ============

const THRESHOLDS = {
  // Score requirements
  MIN_SCORE_BUY: appConfig.trading.minScoreBuySignal,
  MIN_SCORE_WATCH: appConfig.trading.minScoreWatchSignal,
  MIN_SCORE_DISCOVERY: 45,  // Raised from 30 — quality over quantity

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
   * Calculate discovery score (metrics-only, no KOL required)
   * Used for discovery signals that identify promising tokens early
   */
  calculateDiscoveryScore(
    tokenAddress: string,
    metrics: TokenMetrics,
    socialMetrics: SocialMetrics,
    volumeAuthenticity: VolumeAuthenticityScore,
    scamFilter: ScamFilterOutput
  ): TokenScore {
    // Calculate factors (KOL factors will be 0)
    const factors: ScoreFactors = {
      onChainHealth: this.calculateOnChainHealth(metrics, volumeAuthenticity),
      socialMomentum: this.calculateSocialMomentum(socialMetrics),
      kolConvictionMain: 0, // No KOL for discovery
      kolConvictionSide: 0, // No KOL for discovery
      scamRiskInverse: this.calculateScamRiskInverse(scamFilter),
      narrativeBonus: this.calculateNarrativeBonus(metrics, socialMetrics),
      timingBonus: this.calculateTimingBonus(metrics),
    };

    // Calculate weighted composite using discovery weights (no KOL component)
    const baseScore =
      (factors.onChainHealth * DISCOVERY_WEIGHTS.onChainHealth) +
      (factors.socialMomentum * DISCOVERY_WEIGHTS.socialMomentum) +
      (factors.scamRiskInverse * DISCOVERY_WEIGHTS.scamRiskInverse);

    // Add bonuses
    const compositeScore = Math.min(100, baseScore + factors.narrativeBonus + factors.timingBonus);

    // Determine confidence (adjusted for no KOL data)
    const { confidence, confidenceBand, flags } = this.determineDiscoveryConfidence(
      metrics,
      scamFilter
    );

    // Determine risk level (higher base risk without KOL validation)
    const riskLevel = this.determineDiscoveryRiskLevel(compositeScore, scamFilter);

    logger.debug('Discovery score calculated', {
      token: tokenAddress,
      score: Math.round(compositeScore),
      factors,
    });

    return {
      tokenAddress,
      compositeScore: Math.round(compositeScore),
      factors,
      confidence,
      confidenceBand,
      flags: [...flags, 'DISCOVERY_SIGNAL'],
      riskLevel,
    };
  }

  /**
   * Calculate KOL multiplier based on activity
   * Returns a multiplier to apply to discovery scores when KOL buys
   */
  calculateKolMultiplier(kolActivities: KolWalletActivity[]): number {
    if (kolActivities.length === 0) {
      return KOL_MULTIPLIER.NO_KOL;
    }

    const mainWalletActivities = kolActivities.filter(a => a.wallet.walletType === WalletType.MAIN);
    const sideWalletActivities = kolActivities.filter(a => a.wallet.walletType === WalletType.SIDE);

    // High conviction: 3+ KOLs with main wallets
    if (mainWalletActivities.length >= 3) {
      return KOL_MULTIPLIER.HIGH_CONVICTION;
    }

    // Multiple main wallet buys
    if (mainWalletActivities.length >= 2) {
      return KOL_MULTIPLIER.MULTI_MAIN_WALLET;
    }

    // Mixed: both main and side wallets
    if (mainWalletActivities.length > 0 && sideWalletActivities.length > 0) {
      return KOL_MULTIPLIER.MIXED_WALLETS;
    }

    // Multiple side wallet buys
    if (sideWalletActivities.length >= 2) {
      return KOL_MULTIPLIER.MULTI_SIDE_WALLET;
    }

    // Single main wallet
    if (mainWalletActivities.length === 1) {
      return KOL_MULTIPLIER.SINGLE_MAIN_WALLET;
    }

    // Single side wallet
    return KOL_MULTIPLIER.SINGLE_SIDE_WALLET;
  }

  /**
   * Apply KOL multiplier to a discovery score to get KOL-validated score
   */
  applyKolMultiplier(
    discoveryScore: TokenScore,
    kolActivities: KolWalletActivity[]
  ): TokenScore {
    const multiplier = this.calculateKolMultiplier(kolActivities);
    const boostedScore = Math.min(150, discoveryScore.compositeScore * multiplier);

    // Update factors with KOL conviction
    const updatedFactors: ScoreFactors = {
      ...discoveryScore.factors,
      kolConvictionMain: this.calculateKolConviction(kolActivities, WalletType.MAIN),
      kolConvictionSide: this.calculateKolConviction(kolActivities, WalletType.SIDE),
    };

    // Remove discovery flag and add validation flag
    const updatedFlags = discoveryScore.flags
      .filter(f => f !== 'DISCOVERY_SIGNAL')
      .concat(['KOL_VALIDATED']);

    // Potentially improve confidence with KOL validation
    let confidence = discoveryScore.confidence;
    if (kolActivities.some(a => a.wallet.walletType === WalletType.MAIN)) {
      if (confidence === 'LOW') confidence = 'MEDIUM';
      else if (confidence === 'MEDIUM') confidence = 'HIGH';
    }

    // Re-evaluate risk with KOL data
    const riskLevel = this.determineRiskLevel(boostedScore,
      { result: 'PASS' as ScamFilterResult, flags: [], contractAnalysis: {} as any, bundleAnalysis: {} as any, devBehaviour: null, rugHistoryWallets: 0 },
      kolActivities
    );

    return {
      tokenAddress: discoveryScore.tokenAddress,
      compositeScore: Math.round(boostedScore),
      factors: updatedFactors,
      confidence,
      confidenceBand: discoveryScore.confidenceBand,
      flags: updatedFlags,
      riskLevel,
    };
  }

  /**
   * Determine confidence for discovery signals (no KOL data)
   */
  private determineDiscoveryConfidence(
    metrics: TokenMetrics,
    scamFilter: ScamFilterOutput
  ): { confidence: 'HIGH' | 'MEDIUM' | 'LOW'; confidenceBand: number; flags: string[] } {
    const flags: string[] = [];
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM'; // Start at MEDIUM for discovery (no KOL validation)
    let confidenceBand = 12;

    // Check data quality factors
    if (metrics.tokenAge < 60) {
      flags.push('VERY_NEW_TOKEN');
      confidence = 'LOW';
      confidenceBand = 20;
    } else if (metrics.tokenAge < 120) {
      flags.push('NEW_TOKEN');
      confidenceBand = 15;
    }

    if (metrics.liquidityPool < 25000) {
      flags.push('LOW_LIQUIDITY');
      if (confidence !== 'LOW') confidence = 'MEDIUM';
      confidenceBand = Math.max(confidenceBand, 15);
    }

    if (metrics.holderCount < 100) {
      flags.push('LOW_HOLDER_COUNT');
      // Note: Discovery signals start at MEDIUM, so no need to check for HIGH
    }

    // Add scam filter flags
    if (scamFilter.result === ScamFilterResult.FLAG) {
      flags.push(...scamFilter.flags.map(f => `SCAM_FLAG: ${f}`));
    }

    return { confidence, confidenceBand, flags };
  }

  /**
   * Determine risk level for discovery signals (higher base risk)
   */
  private determineDiscoveryRiskLevel(
    score: number,
    scamFilter: ScamFilterOutput
  ): RiskLevel {
    // Discovery signals start with higher risk threshold
    // Shift thresholds down by 5 points for discovery
    let risk: RiskLevel;

    if (score >= THRESHOLDS.RISK_VERY_LOW_MAX_SCORE + 5) {
      risk = RiskLevel.VERY_LOW;
    } else if (score >= THRESHOLDS.RISK_LOW_MAX_SCORE + 5) {
      risk = RiskLevel.LOW;
    } else if (score >= THRESHOLDS.RISK_MEDIUM_MAX_SCORE) {
      risk = RiskLevel.MEDIUM;
    } else if (score >= THRESHOLDS.RISK_HIGH_MAX_SCORE - 5) {
      risk = RiskLevel.HIGH;
    } else {
      risk = RiskLevel.VERY_HIGH;
    }

    // Discovery signals without KOL are at minimum MEDIUM risk
    if (risk < RiskLevel.MEDIUM) {
      risk = RiskLevel.MEDIUM;
    }

    // Increase risk for flagged tokens
    if (scamFilter.result === ScamFilterResult.FLAG && risk < RiskLevel.HIGH) {
      risk = RiskLevel.HIGH;
    }

    return risk;
  }

  /**
   * Calculate on-chain health score (0-100)
   * Performance data: Holder Count has +0.37 correlation (strongest factor)
   */
  private calculateOnChainHealth(
    metrics: TokenMetrics,
    volumeAuthenticity: VolumeAuthenticityScore
  ): number {
    let score = 0;

    // Volume/MCap ratio (0-20 points) - reduced from 25
    const volumeRatioScore = Math.min(20, (metrics.volumeMarketCapRatio / THRESHOLDS.IDEAL_VOLUME_MCAP_RATIO) * 20);
    score += volumeRatioScore;

    // Holder count (0-40 points) - INCREASED from 25 (strongest correlation)
    const holderScore = Math.min(40, (metrics.holderCount / THRESHOLDS.IDEAL_HOLDER_COUNT) * 40);
    score += holderScore;

    // Top 10 concentration (0-20 points) - lower is better
    const concentrationScore = Math.max(0, 20 - ((metrics.top10Concentration - THRESHOLDS.IDEAL_TOP10_CONCENTRATION) / 2));
    score += concentrationScore;

    // Volume authenticity (0-20 points) - reduced from 25
    const authenticityScore = volumeAuthenticity.score * 0.20;
    score += authenticityScore;

    return Math.min(100, Math.max(0, score));
  }
  
  /**
   * Calculate social momentum score (0-100)
   * Enhanced with X/Twitter KOL detection and velocity trending
   */
  private calculateSocialMomentum(socialMetrics: SocialMetrics): number {
    let score = 0;

    // Mention velocity (0-25 points)
    // Using a more realistic threshold - 50 mentions/hour is excellent for memecoins
    const velocityScore = Math.min(25, (socialMetrics.mentionVelocity1h / 50) * 25);
    score += velocityScore;

    // Engagement quality (0-20 points)
    const engagementScore = socialMetrics.engagementQuality * 20;
    score += engagementScore;

    // Account authenticity (0-20 points)
    const authenticityScore = socialMetrics.accountAuthenticity * 20;
    score += authenticityScore;

    // Sentiment polarity (0-15 points) - positive sentiment is better
    const sentimentScore = ((socialMetrics.sentimentPolarity + 1) / 2) * 15;
    score += sentimentScore;

    // KOL Twitter mention bonus (0-20 points) - significant boost for influencer attention
    if (socialMetrics.kolMentionDetected && socialMetrics.kolMentions.length > 0) {
      // Base bonus for any KOL mention
      let kolBonus = 10;

      // Additional bonus based on number of KOLs
      kolBonus += Math.min(10, socialMetrics.kolMentions.length * 3);

      // Check for high-tier KOL mentions (S/A tier)
      const highTierMentions = socialMetrics.kolMentions.filter(
        (k: KolMention) => k.tier === 'S' || k.tier === 'A'
      );
      if (highTierMentions.length > 0) {
        kolBonus += 5;
      }

      score += Math.min(20, kolBonus);

      logger.debug({
        kolCount: socialMetrics.kolMentions.length,
        highTierCount: highTierMentions.length,
        kolBonus,
      }, 'KOL Twitter mention bonus applied');
    }

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
   *
   * AUDIT FIX: Removed authority penalties here as they are already applied
   * in token-safety-checker.ts. Double-penalization was causing good early
   * tokens to be filtered out unnecessarily.
   */
  private calculateScamRiskInverse(scamFilter: ScamFilterOutput): number {
    if (scamFilter.result === ScamFilterResult.REJECT) {
      return 0;
    }

    let score = 100;

    // Deduct for each flag (reduced from 10 to 7)
    const flagPenalty = 7;
    score -= scamFilter.flags.length * flagPenalty;

    // AUDIT FIX: Authority penalties REMOVED - already applied in safety checker
    // This was causing triple-penalization:
    // 1. token-safety-checker.ts: -15 mint, -12 freeze
    // 2. Here (old): -30 each = -60 total
    // 3. onchain-scoring uses safety score which includes penalties
    // New: Only penalize for truly dangerous patterns, not authorities

    // Rug history is serious - keep penalty
    if (scamFilter.bundleAnalysis.hasRugHistory) {
      score -= 25;
    }

    // High bundled supply indicates insider risk (reduced from 15)
    if (scamFilter.bundleAnalysis.bundledSupplyPercent > 25) {
      score -= 15;
    } else if (scamFilter.bundleAnalysis.bundledSupplyPercent > 15) {
      score -= 8;
    }

    // Dev transferred to CEX is a dump signal
    if (scamFilter.devBehaviour?.transferredToCex) {
      score -= 35;
    }

    // Flag result gets base penalty
    if (scamFilter.result === ScamFilterResult.FLAG) {
      score = Math.min(score, 75);
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
   *
   * AUDIT FIX: Rebalanced to not overly penalize early tokens
   * Previous scoring gave only 5 points to < 30min tokens, making them unlikely to signal
   * The system is designed for early detection (MIN_TOKEN_AGE: 5 min in config)
   * New scoring provides more balanced bonuses across the age range
   */
  private calculateTimingBonus(metrics: TokenMetrics): number {
    const ageMinutes = metrics.tokenAge;

    // Very new tokens: reasonable bonus (early but tradeable)
    if (ageMinutes < 15) {
      return 8; // < 15 min - very early, some caution
    } else if (ageMinutes < 30) {
      return 12; // 15-30 min - early entry window
    } else if (ageMinutes < 60) {
      return 15; // 30-60 min - sweet spot for early entries
    } else if (ageMinutes < 180) {
      return 18; // 1-3 hours - proven with upside
    } else if (ageMinutes < 720) {
      return 20; // 3-12 hours - established, still good
    } else if (ageMinutes < 1440) {
      return 17; // 12-24 hours - mature
    } else if (ageMinutes < 4320) {
      return 14; // 1-3 days - established, less upside
    }

    return 10; // > 3 days - older token
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

  /**
   * Check if a token score meets discovery signal requirements (no KOL needed)
   *
   * AUDIT FIX: Removed strict authority requirements that were blocking most new tokens
   * Most new memecoins have authorities enabled initially (for liquidity adds, burns, etc.)
   * The safety checker already penalizes for authorities and blocks if BOTH are enabled
   * Requiring revocation here was causing double-filtering and missing good opportunities
   */
  meetsDiscoveryRequirements(
    score: TokenScore,
    scamFilter: ScamFilterOutput
  ): { meets: boolean; reason?: string } {
    // Score threshold for discovery
    if (score.compositeScore < THRESHOLDS.MIN_SCORE_DISCOVERY) {
      return {
        meets: false,
        reason: `Score ${score.compositeScore} below discovery minimum ${THRESHOLDS.MIN_SCORE_DISCOVERY}`,
      };
    }

    // Safety is non-negotiable even for discovery
    if (scamFilter.result === ScamFilterResult.REJECT) {
      return { meets: false, reason: 'Failed safety checks' };
    }

    // AUDIT FIX: Only require that NOT BOTH authorities are enabled
    // This aligns with token-safety-checker.ts:159-164 logic
    // Single authority enabled is acceptable for new tokens
    if (!scamFilter.contractAnalysis.mintAuthorityRevoked &&
        !scamFilter.contractAnalysis.freezeAuthorityRevoked) {
      return { meets: false, reason: 'Both mint and freeze authorities still enabled' };
    }

    // Check for known scam template
    if (scamFilter.contractAnalysis.isKnownScamTemplate) {
      return { meets: false, reason: 'Known scam template detected' };
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
  DISCOVERY_WEIGHTS,
  KOL_MULTIPLIER,
  THRESHOLDS,
  CURRENT_META_THEMES,
};
