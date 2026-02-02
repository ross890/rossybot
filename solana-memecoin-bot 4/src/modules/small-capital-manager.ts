// ===========================================
// MODULE: SMALL CAPITAL MANAGER
// Position sizing and risk management for accounts < 10 SOL
// Optimized for 1 SOL starting capital (~$150)
// ===========================================

import { logger } from '../utils/logger.js';
import { MomentumScore } from './momentum-analyzer.js';
import { BundleAnalysisResult } from './bundle-detector.js';

// ============ TYPES ============

export interface PortfolioState {
  totalSol: number;
  availableSol: number;
  openPositions: number;
  maxPositions: number;
  dailyTradesExecuted: number;
  dailyPnl: number;
  winStreak: number;
  loseStreak: number;
}

export interface PositionSize {
  solAmount: number;
  percentOfPortfolio: number;
  maxLossSol: number;
  rationale: string[];
}

export interface SmallCapitalConfig {
  // Portfolio limits
  initialCapitalSol: number;       // Starting capital
  maxOpenPositions: number;        // Max concurrent positions
  maxDailyTrades: number;          // Max trades per day
  maxPortfolioRisk: number;        // Max % of portfolio at risk

  // Position sizing
  basePositionPercent: number;     // Base position size %
  minPositionSol: number;          // Minimum position in SOL
  maxPositionPercent: number;      // Maximum position size %

  // Risk management
  stopLossPercent: number;         // Default stop loss
  takeProfitPercent: number;       // Default take profit
  trailingStopPercent: number;     // Trailing stop activation

  // Scaling rules
  scaleDownAfterLosses: number;    // Reduce size after N losses
  scaleUpAfterWins: number;        // Increase size after N wins
  maxScaleMultiplier: number;      // Maximum scale up
  minScaleMultiplier: number;      // Minimum scale down
}

export interface SignalQuality {
  momentumScore: number;           // 0-100
  safetyScore: number;             // 0-100
  bundleRiskScore: number;         // 0-100 (inverted - higher = safer)
  kolValidated: boolean;
  multiKolConfirmed: boolean;
  signalStrength: 'STRONG' | 'MODERATE' | 'WEAK';
}

// ============ DEFAULT CONFIG FOR 1 SOL ============

const DEFAULT_CONFIG: SmallCapitalConfig = {
  // Portfolio limits - very conservative for 1 SOL
  initialCapitalSol: 1.0,
  maxOpenPositions: 2,             // Only 2 positions max
  maxDailyTrades: 5,               // Max 5 trades/day
  maxPortfolioRisk: 30,            // Max 30% at risk at once

  // Position sizing - small positions to survive losses
  basePositionPercent: 10,         // 10% base = 0.1 SOL
  minPositionSol: 0.05,            // Minimum 0.05 SOL (~$7.50)
  maxPositionPercent: 20,          // Maximum 20% = 0.2 SOL

  // Risk management - wider stops for volatile memecoins
  stopLossPercent: 40,             // 40% stop loss (memecoins are volatile)
  takeProfitPercent: 100,          // 100% take profit (2x)
  trailingStopPercent: 30,         // Trail after 50% gain

  // Scaling rules
  scaleDownAfterLosses: 2,         // Scale down after 2 consecutive losses
  scaleUpAfterWins: 3,             // Scale up after 3 consecutive wins
  maxScaleMultiplier: 1.5,         // Max 1.5x position size
  minScaleMultiplier: 0.5,         // Min 0.5x position size
};

// ============ SMALL CAPITAL MANAGER CLASS ============

export class SmallCapitalManager {
  private config: SmallCapitalConfig;
  private portfolioState: PortfolioState;

  constructor(config: Partial<SmallCapitalConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.portfolioState = {
      totalSol: this.config.initialCapitalSol,
      availableSol: this.config.initialCapitalSol,
      openPositions: 0,
      maxPositions: this.config.maxOpenPositions,
      dailyTradesExecuted: 0,
      dailyPnl: 0,
      winStreak: 0,
      loseStreak: 0,
    };

    logger.info({
      initialCapital: this.config.initialCapitalSol,
      maxPositions: this.config.maxOpenPositions,
      basePositionPercent: this.config.basePositionPercent,
    }, 'SmallCapitalManager initialized');
  }

  // ============ POSITION SIZING ============

  /**
   * Calculate optimal position size based on signal quality and portfolio state
   */
  calculatePositionSize(signalQuality: SignalQuality): PositionSize {
    const rationale: string[] = [];

    // Check if we can trade
    if (!this.canOpenPosition()) {
      return {
        solAmount: 0,
        percentOfPortfolio: 0,
        maxLossSol: 0,
        rationale: ['Cannot open position - limit reached'],
      };
    }

    // Start with base position
    let positionPercent = this.config.basePositionPercent;
    rationale.push(`Base position: ${positionPercent}%`);

    // Adjust for signal strength
    const strengthMultiplier = this.getStrengthMultiplier(signalQuality);
    positionPercent *= strengthMultiplier;
    rationale.push(`Signal strength (${signalQuality.signalStrength}): ${strengthMultiplier}x`);

    // Adjust for momentum score
    const momentumMultiplier = this.getMomentumMultiplier(signalQuality.momentumScore);
    positionPercent *= momentumMultiplier;
    rationale.push(`Momentum score (${signalQuality.momentumScore}): ${momentumMultiplier}x`);

    // Adjust for safety
    const safetyMultiplier = this.getSafetyMultiplier(signalQuality.safetyScore);
    positionPercent *= safetyMultiplier;
    rationale.push(`Safety score (${signalQuality.safetyScore}): ${safetyMultiplier}x`);

    // Adjust for bundle risk
    const bundleMultiplier = this.getBundleMultiplier(signalQuality.bundleRiskScore);
    positionPercent *= bundleMultiplier;
    rationale.push(`Bundle safety (${signalQuality.bundleRiskScore}): ${bundleMultiplier}x`);

    // Adjust for win/loss streak
    const streakMultiplier = this.getStreakMultiplier();
    positionPercent *= streakMultiplier;
    if (streakMultiplier !== 1.0) {
      rationale.push(`Streak adjustment: ${streakMultiplier}x`);
    }

    // Bonus for multi-KOL confirmation
    if (signalQuality.multiKolConfirmed) {
      positionPercent *= 1.25;
      rationale.push('Multi-KOL confirmed: 1.25x');
    }

    // Apply limits
    positionPercent = Math.max(
      (this.config.minPositionSol / this.portfolioState.totalSol) * 100,
      Math.min(this.config.maxPositionPercent, positionPercent)
    );

    // Calculate SOL amount
    const solAmount = (positionPercent / 100) * this.portfolioState.totalSol;
    const finalSolAmount = Math.max(this.config.minPositionSol, Math.min(solAmount, this.portfolioState.availableSol));

    // Calculate max loss
    const maxLossSol = finalSolAmount * (this.config.stopLossPercent / 100);

    rationale.push(`Final position: ${finalSolAmount.toFixed(4)} SOL (${((finalSolAmount / this.portfolioState.totalSol) * 100).toFixed(1)}%)`);
    rationale.push(`Max loss: ${maxLossSol.toFixed(4)} SOL`);

    return {
      solAmount: Math.round(finalSolAmount * 10000) / 10000,
      percentOfPortfolio: Math.round((finalSolAmount / this.portfolioState.totalSol) * 1000) / 10,
      maxLossSol: Math.round(maxLossSol * 10000) / 10000,
      rationale,
    };
  }

  /**
   * Determine signal quality classification
   *
   * UPDATED: Uses weighted scoring instead of strict AND gates
   * Previous logic required ALL thresholds to pass, causing 100% WEAK signals.
   *
   * New approach: Weighted average based on performance correlations:
   * - Safety: 35% weight (critical for avoiding rugs)
   * - Bundle Safety: 35% weight (insider detection)
   * - Momentum: 30% weight (less predictive than expected per data)
   *
   * This allows a token with excellent safety but low momentum to still
   * be MODERATE/STRONG instead of always being marked WEAK.
   */
  classifySignal(
    momentumScore: MomentumScore,
    safetyScore: number,
    bundleAnalysis: BundleAnalysisResult,
    kolValidated: boolean = false,
    multiKol: boolean = false
  ): SignalQuality {
    // Calculate bundle safety (inverted - higher = safer)
    const bundleSafety = 100 - bundleAnalysis.riskScore;

    // WEIGHTED APPROACH: Use weights aligned with actual performance correlations
    // Safety is most important for avoiding rugs, momentum less predictive
    const weightedScore =
      momentumScore.total * 0.30 +   // 30% weight (reduced from equal weighting)
      safetyScore * 0.35 +            // 35% weight (safety matters most)
      bundleSafety * 0.35;            // 35% weight (insider detection crucial)

    // Determine signal strength using weighted score
    // Removed strict AND gates that were causing 100% WEAK classification
    let signalStrength: 'STRONG' | 'MODERATE' | 'WEAK';

    if (weightedScore >= 55) {
      // STRONG: High weighted score indicates overall quality
      signalStrength = 'STRONG';
    } else if (weightedScore >= 40) {
      // MODERATE: Decent weighted score
      signalStrength = 'MODERATE';
    } else {
      signalStrength = 'WEAK';
    }

    // Critical safety floor: If safety is critically low, cap at MODERATE max
    // This prevents high-momentum scam tokens from being marked STRONG
    if (safetyScore < 30 && signalStrength === 'STRONG') {
      signalStrength = 'MODERATE';
    }

    // KOL validation can upgrade signal strength
    if (kolValidated && signalStrength === 'WEAK' && weightedScore >= 30) {
      signalStrength = 'MODERATE';
    }
    if (multiKol && signalStrength === 'MODERATE') {
      signalStrength = 'STRONG';
    }

    return {
      momentumScore: momentumScore.total,
      safetyScore,
      bundleRiskScore: bundleSafety,
      kolValidated,
      multiKolConfirmed: multiKol,
      signalStrength,
    };
  }

  // ============ MULTIPLIER CALCULATIONS ============

  private getStrengthMultiplier(quality: SignalQuality): number {
    switch (quality.signalStrength) {
      case 'STRONG': return 1.3;
      case 'MODERATE': return 1.0;
      case 'WEAK': return 0.6;
      default: return 0.5;
    }
  }

  private getMomentumMultiplier(score: number): number {
    if (score >= 80) return 1.3;
    if (score >= 65) return 1.15;
    if (score >= 50) return 1.0;
    if (score >= 35) return 0.8;
    return 0.6;
  }

  private getSafetyMultiplier(score: number): number {
    if (score >= 80) return 1.2;
    if (score >= 65) return 1.1;
    if (score >= 50) return 1.0;
    if (score >= 35) return 0.75;
    return 0.5;
  }

  private getBundleMultiplier(safetyScore: number): number {
    if (safetyScore >= 80) return 1.15;
    if (safetyScore >= 60) return 1.0;
    if (safetyScore >= 40) return 0.8;
    return 0.5; // High bundle risk
  }

  private getStreakMultiplier(): number {
    // Scale down after losses
    if (this.portfolioState.loseStreak >= this.config.scaleDownAfterLosses) {
      return Math.max(
        this.config.minScaleMultiplier,
        1 - (this.portfolioState.loseStreak - this.config.scaleDownAfterLosses + 1) * 0.15
      );
    }

    // Scale up after wins (conservative)
    if (this.portfolioState.winStreak >= this.config.scaleUpAfterWins) {
      return Math.min(
        this.config.maxScaleMultiplier,
        1 + (this.portfolioState.winStreak - this.config.scaleUpAfterWins + 1) * 0.1
      );
    }

    return 1.0;
  }

  // ============ PORTFOLIO STATE MANAGEMENT ============

  /**
   * Check if we can open a new position
   */
  canOpenPosition(): boolean {
    // Check open positions limit
    if (this.portfolioState.openPositions >= this.config.maxOpenPositions) {
      logger.debug('Cannot open position: max open positions reached');
      return false;
    }

    // Check daily trade limit
    if (this.portfolioState.dailyTradesExecuted >= this.config.maxDailyTrades) {
      logger.debug('Cannot open position: daily trade limit reached');
      return false;
    }

    // Check available capital
    if (this.portfolioState.availableSol < this.config.minPositionSol) {
      logger.debug('Cannot open position: insufficient available capital');
      return false;
    }

    return true;
  }

  /**
   * Record a new position opening
   */
  openPosition(solAmount: number): void {
    this.portfolioState.openPositions++;
    this.portfolioState.availableSol -= solAmount;
    this.portfolioState.dailyTradesExecuted++;

    logger.info({
      solAmount,
      openPositions: this.portfolioState.openPositions,
      availableSol: this.portfolioState.availableSol,
    }, 'Position opened');
  }

  /**
   * Record a position close
   */
  closePosition(solAmount: number, pnl: number, isWin: boolean): void {
    this.portfolioState.openPositions = Math.max(0, this.portfolioState.openPositions - 1);
    this.portfolioState.availableSol += solAmount + pnl;
    this.portfolioState.totalSol += pnl;
    this.portfolioState.dailyPnl += pnl;

    if (isWin) {
      this.portfolioState.winStreak++;
      this.portfolioState.loseStreak = 0;
    } else {
      this.portfolioState.loseStreak++;
      this.portfolioState.winStreak = 0;
    }

    logger.info({
      pnl,
      isWin,
      newTotal: this.portfolioState.totalSol,
      winStreak: this.portfolioState.winStreak,
      loseStreak: this.portfolioState.loseStreak,
    }, 'Position closed');
  }

  /**
   * Reset daily counters (call at start of each day)
   */
  resetDaily(): void {
    this.portfolioState.dailyTradesExecuted = 0;
    this.portfolioState.dailyPnl = 0;
    logger.info('Daily counters reset');
  }

  /**
   * Get current portfolio state
   */
  getPortfolioState(): PortfolioState {
    return { ...this.portfolioState };
  }

  /**
   * Update portfolio state from external source
   */
  updatePortfolioState(state: Partial<PortfolioState>): void {
    this.portfolioState = { ...this.portfolioState, ...state };
  }

  // ============ SIGNAL FILTERING ============

  /**
   * Determine if a signal meets minimum requirements for small capital trading
   * More stringent than standard requirements
   */
  meetsMinimumRequirements(quality: SignalQuality): { passes: boolean; reasons: string[] } {
    const reasons: string[] = [];

    // Momentum must be decent
    if (quality.momentumScore < 45) {
      reasons.push(`Momentum score too low: ${quality.momentumScore} < 45`);
    }

    // Safety must be acceptable
    if (quality.safetyScore < 50) {
      reasons.push(`Safety score too low: ${quality.safetyScore} < 50`);
    }

    // Bundle risk must not be critical
    if (quality.bundleRiskScore < 30) { // Inverted scale
      reasons.push(`Bundle risk too high: safety ${quality.bundleRiskScore} < 30`);
    }

    // For weak signals, require KOL validation
    if (quality.signalStrength === 'WEAK' && !quality.kolValidated) {
      reasons.push('Weak signal without KOL validation');
    }

    return {
      passes: reasons.length === 0,
      reasons,
    };
  }

  /**
   * Calculate risk/reward ratio for a potential trade
   */
  calculateRiskReward(
    entryPrice: number,
    stopLossPercent: number = this.config.stopLossPercent,
    takeProfitPercent: number = this.config.takeProfitPercent
  ): { ratio: number; acceptable: boolean } {
    const risk = stopLossPercent;
    const reward = takeProfitPercent;
    const ratio = reward / risk;

    // For small capital, we need at least 2:1 R:R
    return {
      ratio: Math.round(ratio * 100) / 100,
      acceptable: ratio >= 2.0,
    };
  }

  // ============ KELLY CRITERION (OPTIONAL) ============

  /**
   * Calculate position size using Kelly Criterion
   * Used as a reference, not for actual sizing (too aggressive)
   */
  calculateKellySize(winRate: number, avgWin: number, avgLoss: number): number {
    // Kelly formula: f* = (bp - q) / b
    // where b = avgWin/avgLoss, p = winRate, q = 1-p
    const b = avgWin / Math.abs(avgLoss);
    const p = winRate;
    const q = 1 - p;

    const kelly = (b * p - q) / b;

    // Use fractional Kelly (25%) for safety
    const fractionalKelly = kelly * 0.25;

    // Cap at max position size
    return Math.max(0, Math.min(fractionalKelly * 100, this.config.maxPositionPercent));
  }
}

// ============ EXPORTS ============

export const smallCapitalManager = new SmallCapitalManager();

export default {
  SmallCapitalManager,
  smallCapitalManager,
  DEFAULT_CONFIG,
};
