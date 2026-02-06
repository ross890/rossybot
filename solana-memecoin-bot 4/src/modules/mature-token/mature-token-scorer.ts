// ===========================================
// MATURE TOKEN SCORER
// Composite scoring engine for mature tokens (24hrs+)
// ===========================================

import { logger } from '../../utils/logger.js';
import { tokenSafetyChecker } from '../safety/token-safety-checker.js';
import { bundleDetector } from '../bundle-detector.js';
import { accumulationDetector } from './accumulation-detector.js';
import { breakoutAnalyzer } from './breakout-analyzer.js';
import { holderDynamicsAnalyzer } from './holder-dynamics.js';
import { volumeProfileAnalyzer } from './volume-profile.js';
import { smartMoneyTracker } from './smart-money-tracker.js';
import { kolReentryDetector } from './kol-reentry-detector.js';
import { technicalAnalysis, TechnicalIndicators } from './technical-analysis.js';
import {
  MatureTokenScore,
  AccumulationMetrics,
  BreakoutMetrics,
  HolderDynamicsMetrics,
  VolumeProfileMetrics,
  SmartMoneyMetrics,
  KolReentryMetrics,
  SCORING_WEIGHTS,
  SCORE_MULTIPLIERS,
  SIGNAL_THRESHOLDS,
} from './types.js';
import { TokenMetrics, TokenSafetyResult } from '../../types/index.js';

// ============ CLASS ============

export class MatureTokenScorer {
  /**
   * Calculate comprehensive score for a mature token
   */
  async calculateScore(
    tokenAddress: string,
    tokenMetrics: TokenMetrics,
    currentPrice: number
  ): Promise<{
    score: MatureTokenScore;
    accumulationMetrics: AccumulationMetrics;
    breakoutMetrics: BreakoutMetrics;
    holderDynamics: HolderDynamicsMetrics;
    volumeProfile: VolumeProfileMetrics;
    smartMoneyMetrics: SmartMoneyMetrics;
    kolReentryMetrics: KolReentryMetrics;
    safetyResult: TokenSafetyResult;
    technicalIndicators: TechnicalIndicators;
  }> {
    // Gather all metrics in parallel
    const [
      accumulationMetrics,
      breakoutMetrics,
      holderDynamics,
      volumeProfile,
      smartMoneyMetrics,
      kolReentryMetrics,
      safetyResult,
      bundleAnalysis,
      technicalIndicators,
    ] = await Promise.all([
      accumulationDetector.analyze(tokenAddress),
      breakoutAnalyzer.analyze(tokenAddress),
      holderDynamicsAnalyzer.analyze(tokenAddress),
      volumeProfileAnalyzer.analyze(tokenAddress),
      smartMoneyTracker.analyze(tokenAddress),
      kolReentryDetector.analyze(tokenAddress, currentPrice),
      tokenSafetyChecker.checkTokenSafety(tokenAddress),
      bundleDetector.analyze(tokenAddress),
      technicalAnalysis.analyze(tokenAddress),
    ]);

    // Override breakout RSI with real RSI from technical analysis
    const enhancedBreakoutMetrics: BreakoutMetrics = {
      ...breakoutMetrics,
      rsi14: technicalIndicators.rsi14,  // Use real RSI from OHLCV data
      macdCrossover: technicalIndicators.macdCrossover === 'BULLISH',
      ema9CrossEma21: technicalIndicators.emaCrossover === 'BULLISH',
    };

    // Recalculate breakout score with real technical data
    const adjustedBreakoutScore = this.adjustBreakoutScoreWithTechnicals(
      breakoutMetrics.breakoutScore,
      technicalIndicators
    );

    // Calculate component scores
    const components = {
      accumulationScore: accumulationMetrics.accumulationScore,
      breakoutScore: adjustedBreakoutScore,
      holderDynamicsScore: holderDynamics.holderDynamicsScore,
      volumeAuthenticityScore: volumeProfile.volumeAuthenticityScore,
      smartMoneyScore: smartMoneyMetrics.smartMoneyScore,
      kolActivityScore: kolReentryMetrics.kolActivityScore,
      narrativeMomentumScore: this.calculateNarrativeScore(tokenMetrics),
      contractSafetyScore: safetyResult.safetyScore,
      bundleRiskScore: 100 - bundleAnalysis.riskScore, // Invert - higher = safer
    };

    // Calculate weighted composite score
    let compositeScore = this.calculateWeightedScore(components);

    // Apply multipliers
    compositeScore = this.applyMultipliers(
      compositeScore,
      kolReentryMetrics,
      smartMoneyMetrics,
      accumulationMetrics,
      breakoutMetrics,
      volumeProfile
    );

    // Determine confidence and recommendation
    const confidence = this.determineConfidence(components, accumulationMetrics, breakoutMetrics);
    const recommendation = this.determineRecommendation(compositeScore, components);

    // Collect signals and warnings
    const { bullishSignals, bearishSignals, warnings } = this.collectSignals(
      accumulationMetrics,
      enhancedBreakoutMetrics,
      holderDynamics,
      volumeProfile,
      smartMoneyMetrics,
      kolReentryMetrics,
      safetyResult,
      bundleAnalysis,
      technicalIndicators
    );

    const score: MatureTokenScore = {
      ...components,
      compositeScore: Math.round(compositeScore),
      confidence,
      recommendation,
      bullishSignals,
      bearishSignals,
      warnings,
    };

    logger.debug({
      tokenAddress: tokenAddress.slice(0, 8),
      compositeScore: score.compositeScore,
      confidence,
      recommendation,
      components,
      technicalBias: technicalIndicators.bias,
      rsi14: technicalIndicators.rsi14.toFixed(1),
    }, 'Mature token score calculated');

    return {
      score,
      accumulationMetrics,
      breakoutMetrics: enhancedBreakoutMetrics,
      holderDynamics,
      volumeProfile,
      smartMoneyMetrics,
      kolReentryMetrics,
      safetyResult,
      technicalIndicators,
    };
  }

  /**
   * Adjust breakout score with real technical analysis data
   */
  private adjustBreakoutScoreWithTechnicals(
    baseScore: number,
    technicals: TechnicalIndicators
  ): number {
    let adjustment = 0;

    // RSI adjustment (-15 to +15)
    if (technicals.rsi14 >= 40 && technicals.rsi14 <= 60) {
      adjustment += 10; // Neutral zone - good entry
    } else if (technicals.rsi14 >= 30 && technicals.rsi14 <= 70) {
      adjustment += 5; // Healthy range
    } else if (technicals.rsi14 < 30) {
      adjustment += 15; // Oversold - potential reversal
    } else if (technicals.rsi14 > 70) {
      adjustment -= 10; // Overbought - caution
    }

    // MACD adjustment (-10 to +15)
    if (technicals.macdCrossover === 'BULLISH') {
      adjustment += 15;
    } else if (technicals.macdCrossover === 'BEARISH') {
      adjustment -= 10;
    } else if (technicals.macdHistogram > 0) {
      adjustment += 5;
    }

    // EMA adjustment (-10 to +10)
    if (technicals.emaCrossover === 'BULLISH') {
      adjustment += 10;
    } else if (technicals.emaCrossover === 'BEARISH') {
      adjustment -= 10;
    }

    // Price vs EMA adjustment (-5 to +5)
    if (technicals.priceVsEma === 'ABOVE_ALL') {
      adjustment += 5;
    } else if (technicals.priceVsEma === 'BELOW_ALL') {
      adjustment -= 5;
    }

    // Technical bias multiplier
    if (technicals.bias === 'BULLISH') {
      adjustment += 5;
    } else if (technicals.bias === 'BEARISH') {
      adjustment -= 5;
    }

    const adjustedScore = baseScore + adjustment;
    return Math.max(0, Math.min(100, adjustedScore));
  }

  /**
   * Calculate weighted score from components
   */
  private calculateWeightedScore(components: Record<string, number>): number {
    let score = 0;

    score += components.accumulationScore * SCORING_WEIGHTS.accumulationScore;
    score += components.breakoutScore * SCORING_WEIGHTS.breakoutScore;
    score += components.holderDynamicsScore * SCORING_WEIGHTS.holderDynamicsScore;
    score += components.volumeAuthenticityScore * SCORING_WEIGHTS.volumeAuthenticityScore;
    score += components.smartMoneyScore * SCORING_WEIGHTS.smartMoneyScore;
    score += components.kolActivityScore * SCORING_WEIGHTS.kolActivityScore;
    score += components.narrativeMomentumScore * SCORING_WEIGHTS.narrativeMomentumScore;
    score += components.contractSafetyScore * SCORING_WEIGHTS.contractSafetyScore;
    score += components.bundleRiskScore * SCORING_WEIGHTS.bundleRiskScore;

    return score;
  }

  /**
   * Apply score multipliers based on signals
   */
  private applyMultipliers(
    score: number,
    kolMetrics: KolReentryMetrics,
    smartMoneyMetrics: SmartMoneyMetrics,
    accumulationMetrics: AccumulationMetrics,
    breakoutMetrics: BreakoutMetrics,
    volumeProfile: VolumeProfileMetrics
  ): number {
    let multiplier = 1.0;

    // KOL multipliers
    if (kolMetrics.kolBuys24h >= 2) {
      multiplier *= SCORE_MULTIPLIERS.multiKolBuy;
    } else if (kolMetrics.kolBuys24h >= 1) {
      multiplier *= SCORE_MULTIPLIERS.singleKolBuy;
    }

    if (kolMetrics.tier1KolCount >= 1) {
      multiplier *= SCORE_MULTIPLIERS.tier1KolBuy;
    }

    // Smart money multipliers
    if (smartMoneyMetrics.whaleAccumulation >= 3) {
      multiplier *= SCORE_MULTIPLIERS.whaleAccumulation;
    }

    if (smartMoneyMetrics.smartMoneyInflow24h >= 25000) {
      multiplier *= SCORE_MULTIPLIERS.smartMoneyInflow;
    }

    // Accumulation multiplier
    if (accumulationMetrics.accumulationScore >= 70) {
      multiplier *= SCORE_MULTIPLIERS.strongAccumulation;
    }

    // Breakout multiplier
    if (breakoutAnalyzer.isActiveBreakout(breakoutMetrics)) {
      multiplier *= SCORE_MULTIPLIERS.breakoutConfirmed;
    }

    // Negative multipliers
    if (volumeProfile.botActivityScore > 60) {
      multiplier *= SCORE_MULTIPLIERS.highBotActivity;
    }

    if (volumeProfile.organicVolumeRatio < 0.4) {
      multiplier *= SCORE_MULTIPLIERS.lowLiquidity;
    }

    return Math.min(100, score * multiplier);
  }

  /**
   * Calculate narrative momentum score
   */
  private calculateNarrativeScore(metrics: TokenMetrics): number {
    const name = (metrics.name + ' ' + metrics.ticker).toLowerCase();
    let score = 40; // Base score

    // AI/tech themed (currently hot narrative)
    if (name.includes('ai') || name.includes('agent') || name.includes('gpt') || name.includes('neural')) {
      score = 85;
    }
    // Political (can be viral)
    else if (name.includes('trump') || name.includes('maga') || name.includes('biden')) {
      score = 75;
    }
    // Classic meme themes
    else if (name.includes('pepe') || name.includes('doge') || name.includes('shib') || name.includes('cat')) {
      score = 70;
    }
    // Elon/space themed
    else if (name.includes('elon') || name.includes('tesla') || name.includes('mars') || name.includes('rocket')) {
      score = 65;
    }

    return score;
  }

  /**
   * Determine confidence level
   */
  private determineConfidence(
    components: Record<string, number>,
    accumulationMetrics: AccumulationMetrics,
    breakoutMetrics: BreakoutMetrics
  ): 'HIGH' | 'MEDIUM' | 'LOW' {
    let confidenceScore = 0;

    // High component scores increase confidence
    if (components.accumulationScore >= 60) confidenceScore += 2;
    if (components.breakoutScore >= 50) confidenceScore += 2;
    if (components.holderDynamicsScore >= 50) confidenceScore += 1;
    if (components.volumeAuthenticityScore >= 60) confidenceScore += 2;
    if (components.smartMoneyScore >= 50) confidenceScore += 1;
    if (components.kolActivityScore >= 40) confidenceScore += 2;
    if (components.contractSafetyScore >= 70) confidenceScore += 1;

    // Pattern detection increases confidence
    if (accumulationMetrics.patternConfidence >= 70) confidenceScore += 1;
    if (breakoutMetrics.breakoutProbability >= 0.6) confidenceScore += 1;

    if (confidenceScore >= 10) return 'HIGH';
    if (confidenceScore >= 6) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Determine recommendation
   */
  private determineRecommendation(
    compositeScore: number,
    components: Record<string, number>
  ): 'STRONG_BUY' | 'BUY' | 'WATCH' | 'AVOID' {
    // Check STRONG_BUY conditions
    if (
      compositeScore >= SIGNAL_THRESHOLDS.STRONG_BUY.compositeScore &&
      components.accumulationScore >= SIGNAL_THRESHOLDS.STRONG_BUY.minAccumulation &&
      components.breakoutScore >= SIGNAL_THRESHOLDS.STRONG_BUY.minBreakout &&
      components.contractSafetyScore >= SIGNAL_THRESHOLDS.STRONG_BUY.minSafety
    ) {
      return 'STRONG_BUY';
    }

    // Check BUY conditions
    if (
      compositeScore >= SIGNAL_THRESHOLDS.BUY.compositeScore &&
      components.accumulationScore >= SIGNAL_THRESHOLDS.BUY.minAccumulation &&
      components.contractSafetyScore >= SIGNAL_THRESHOLDS.BUY.minSafety
    ) {
      return 'BUY';
    }

    // Check WATCH conditions
    if (
      compositeScore >= SIGNAL_THRESHOLDS.WATCH.compositeScore &&
      components.contractSafetyScore >= SIGNAL_THRESHOLDS.WATCH.minSafety
    ) {
      return 'WATCH';
    }

    return 'AVOID';
  }

  /**
   * Collect signals and warnings from all analyzers
   */
  private collectSignals(
    accumulation: AccumulationMetrics,
    breakout: BreakoutMetrics,
    holderDynamics: HolderDynamicsMetrics,
    volumeProfile: VolumeProfileMetrics,
    smartMoney: SmartMoneyMetrics,
    kolMetrics: KolReentryMetrics,
    safety: TokenSafetyResult,
    bundle: any,
    technicals: TechnicalIndicators
  ): {
    bullishSignals: string[];
    bearishSignals: string[];
    warnings: string[];
  } {
    const bullishSignals: string[] = [];
    const bearishSignals: string[] = [];
    const warnings: string[] = [];

    // Technical analysis signals (NEW)
    if (technicals.macdCrossover === 'BULLISH') {
      bullishSignals.push('MACD_BULLISH_CROSS');
    } else if (technicals.macdCrossover === 'BEARISH') {
      bearishSignals.push('MACD_BEARISH_CROSS');
    }

    if (technicals.emaCrossover === 'BULLISH') {
      bullishSignals.push('EMA_BULLISH_CROSS');
    } else if (technicals.emaCrossover === 'BEARISH') {
      bearishSignals.push('EMA_BEARISH_CROSS');
    }

    if (technicals.rsiTrend === 'OVERSOLD') {
      bullishSignals.push(`RSI_OVERSOLD_${technicals.rsi14.toFixed(0)}`);
    } else if (technicals.rsiTrend === 'OVERBOUGHT') {
      warnings.push(`RSI_OVERBOUGHT_${technicals.rsi14.toFixed(0)}`);
    }

    if (technicals.priceVsEma === 'ABOVE_ALL') {
      bullishSignals.push('PRICE_ABOVE_ALL_EMAS');
    } else if (technicals.priceVsEma === 'BELOW_ALL') {
      bearishSignals.push('PRICE_BELOW_ALL_EMAS');
    }

    if (technicals.bias === 'BULLISH' && technicals.technicalScore >= 65) {
      bullishSignals.push(`TECH_BULLISH_${technicals.technicalScore}`);
    } else if (technicals.bias === 'BEARISH' && technicals.technicalScore <= 35) {
      bearishSignals.push(`TECH_BEARISH_${technicals.technicalScore}`);
    }

    // Distance to support/resistance
    if (technicals.distanceToResistance < 5 && technicals.distanceToResistance > 0) {
      bullishSignals.push('NEAR_BREAKOUT_LEVEL');
    }
    if (technicals.distanceToSupport < 5 && technicals.distanceToSupport > 0) {
      warnings.push('NEAR_SUPPORT_LEVEL');
    }

    // Accumulation signals
    if (accumulation.accumulationScore >= 70) {
      bullishSignals.push(`STRONG_ACCUMULATION (${accumulation.pattern})`);
    } else if (accumulation.accumulationScore >= 50) {
      bullishSignals.push('ACCUMULATING');
    }

    if (accumulation.buyVolumeRatio >= 2.0) {
      bullishSignals.push('HEAVY_BUY_PRESSURE');
    }

    // Breakout signals
    if (breakoutAnalyzer.isActiveBreakout(breakout)) {
      bullishSignals.push('BREAKOUT_IN_PROGRESS');
    } else if (breakoutAnalyzer.isBreakoutLikely(breakout)) {
      bullishSignals.push('BREAKOUT_SETUP');
    }

    if (breakout.volumeExpansion >= 3.0) {
      bullishSignals.push('VOLUME_EXPLOSION');
    }

    // Holder dynamics signals
    if (holderDynamics.holderGrowth24h >= 10) {
      bullishSignals.push('RAPID_HOLDER_GROWTH');
    }

    if (holderDynamics.diamondHandsRatio >= 0.5) {
      bullishSignals.push('STRONG_HOLDER_BASE');
    }

    if (holderDynamics.buyerSellerRatio < 0.8) {
      bearishSignals.push('SELLING_PRESSURE');
    }

    // Smart money signals
    if (smartMoney.whaleAccumulation >= 3) {
      bullishSignals.push('WHALE_ACCUMULATION');
    }

    if (smartMoney.smartMoneyInflow24h >= 25000) {
      bullishSignals.push('SMART_MONEY_INFLOW');
    }

    if (smartMoney.exchangeNetFlow < -1000) {
      bearishSignals.push('SELL PRESSURE');
    }

    // KOL signals
    if (kolMetrics.tier1KolCount >= 1) {
      bullishSignals.push('TIER1_KOL_ACTIVE');
    }

    if (kolMetrics.kolBuys24h >= 2) {
      bullishSignals.push('MULTI_KOL_INTEREST');
    }

    if (kolMetrics.kolSentiment === 'BEARISH') {
      bearishSignals.push('KOL_SENTIMENT_NEGATIVE');
    }

    // Volume signals
    if (volumeProfile.organicVolumeRatio < 0.5) {
      warnings.push('LOW_ORGANIC_VOLUME');
    }

    if (volumeProfile.botActivityScore > 50) {
      warnings.push('HIGH_BOT_ACTIVITY');
    }

    if (volumeProfile.washTradingScore > 40) {
      warnings.push('WASH_TRADING_SUSPECTED');
    }

    // Safety signals
    if (safety.safetyScore < 50) {
      warnings.push(`LOW_SAFETY_SCORE_${safety.safetyScore}`);
    }

    if (safety.mintAuthorityEnabled) {
      warnings.push('MINT_AUTHORITY_ENABLED');
    }

    if (safety.freezeAuthorityEnabled) {
      warnings.push('FREEZE_AUTHORITY_ENABLED');
    }

    // Bundle signals
    if (bundle.riskScore > 50) {
      warnings.push(`HIGH_BUNDLE_RISK_${bundle.riskScore}`);
    }

    if (bundle.riskLevel === 'HIGH') {
      bearishSignals.push('INSIDER_RISK_DETECTED');
    }

    return { bullishSignals, bearishSignals, warnings };
  }

  /**
   * Check if token meets minimum thresholds for signal
   */
  meetsSignalThreshold(score: MatureTokenScore): boolean {
    return (
      score.compositeScore >= SIGNAL_THRESHOLDS.WATCH.compositeScore &&
      score.recommendation !== 'AVOID' &&
      score.contractSafetyScore >= 40
    );
  }

  /**
   * Check if token is strong buy candidate
   */
  isStrongBuyCandidate(score: MatureTokenScore): boolean {
    return score.recommendation === 'STRONG_BUY';
  }

  /**
   * Get signal strength
   */
  getSignalStrength(score: MatureTokenScore): 'STRONG' | 'MODERATE' | 'WEAK' {
    if (score.recommendation === 'STRONG_BUY' && score.confidence === 'HIGH') {
      return 'STRONG';
    }
    if (score.recommendation === 'BUY' || score.confidence === 'MEDIUM') {
      return 'MODERATE';
    }
    return 'WEAK';
  }
}

// ============ EXPORTS ============

export const matureTokenScorer = new MatureTokenScorer();

export default {
  MatureTokenScorer,
  matureTokenScorer,
};
