// ===========================================
// MODULE: CANONICAL EXIT STRATEGY
// Single source of truth for all exit decisions.
// Signal generator, performance tracker, and auto-trader
// all call this same function.
// ===========================================

import { logger } from '../../utils/logger.js';

// ============ TYPES ============

export interface PartialExitState {
  tp1Hit: boolean;
  tp2Hit: boolean;
  currentPositionPercent: number; // 100 = full, 67 after TP1, 34 after TP2
  stopPrice: number;
  trailingStopActive: boolean;
  peakPriceSinceEntry: number;
}

export type ExitAction =
  | 'NONE'
  | 'STOP_LOSS'
  | 'TAKE_PROFIT_1'
  | 'TAKE_PROFIT_2'
  | 'TRAILING_STOP'
  | 'TIME_LIMIT'
  | 'BREAKEVEN_STOP';

export interface ExitDecision {
  action: ExitAction;
  sellPercent: number;        // % of ORIGINAL position to sell (0-100)
  newStopPrice: number;       // Updated stop price after this action
  reason: string;
  trailingStopActive: boolean;
}

export type ScoreGrade = 'STRONG_BUY' | 'BUY' | 'WATCH';

// ============ CANONICAL EXIT PARAMETERS ============

// Stop loss by score grade — higher conviction = more room
const STOP_LOSS_BY_GRADE: Record<ScoreGrade, number> = {
  STRONG_BUY: -0.30,  // Score >= 75: -30%
  BUY: -0.25,         // Score 55-74: -25%
  WATCH: -0.20,       // Score 30-54: -20%
};

// Take profit levels (as fraction of entry price increase)
const TP1_PERCENT = 0.50;    // +50%
const TP1_SELL_PERCENT = 33; // Sell 33% of original position

const TP2_PERCENT = 1.50;    // +150%
const TP2_SELL_PERCENT = 33; // Sell 33% of original position (50% of remaining)

// After TP2: trailing stop on final 34%
// Trailing stop tightens as price rises
const TRAILING_STOP_TIERS = [
  { minGain: 5.00, trail: 0.10 }, // +500%+: trail 10% below peak
  { minGain: 3.00, trail: 0.15 }, // +300%-500%: trail 15% below peak
  { minGain: 1.50, trail: 0.20 }, // +150%-300%: trail 20% below peak (default after TP2)
];

// Time limit
const MAX_HOLD_HOURS = 48;

// ============ CORE FUNCTION ============

/**
 * Calculate the exit action given current market state and position state.
 * This is the SINGLE SOURCE OF TRUTH for all exit decisions.
 *
 * @param entryPrice - Price at which position was entered
 * @param currentPrice - Current market price
 * @param peakPrice - Highest price since entry (for trailing stop)
 * @param elapsedHours - Hours since entry
 * @param scoreGrade - Score grade at entry (determines stop loss width)
 * @param state - Current partial exit state
 * @returns ExitDecision with action, sell percent, and updated stop price
 */
export function calculateExitAction(
  entryPrice: number,
  currentPrice: number,
  peakPrice: number,
  elapsedHours: number,
  scoreGrade: ScoreGrade,
  state: PartialExitState
): ExitDecision {
  // Update peak price
  const effectivePeak = Math.max(peakPrice, currentPrice, state.peakPriceSinceEntry);

  const priceChangeFromEntry = (currentPrice - entryPrice) / entryPrice;
  const priceChangeFromPeak = effectivePeak > 0
    ? (currentPrice - effectivePeak) / effectivePeak
    : 0;

  // --- Priority 1: Check trailing stop (after TP2) ---
  if (state.trailingStopActive && state.currentPositionPercent > 0) {
    const trailPercent = getTrailingStopPercent(effectivePeak, entryPrice);
    const trailingStopPrice = effectivePeak * (1 - trailPercent);

    if (currentPrice <= trailingStopPrice) {
      return {
        action: 'TRAILING_STOP',
        sellPercent: state.currentPositionPercent, // Sell all remaining
        newStopPrice: trailingStopPrice,
        reason: `Trailing stop hit: price $${currentPrice.toFixed(6)} <= trail $${trailingStopPrice.toFixed(6)} (${(trailPercent * 100).toFixed(0)}% below peak $${effectivePeak.toFixed(6)})`,
        trailingStopActive: false,
      };
    }
  }

  // --- Priority 2: Check stop loss ---
  if (!state.tp1Hit) {
    // Pre-TP1: use score-based stop loss
    const stopLossPercent = STOP_LOSS_BY_GRADE[scoreGrade];
    const stopLossPrice = entryPrice * (1 + stopLossPercent);

    if (currentPrice <= stopLossPrice) {
      return {
        action: 'STOP_LOSS',
        sellPercent: state.currentPositionPercent, // Sell all remaining
        newStopPrice: stopLossPrice,
        reason: `Stop loss hit: ${(stopLossPercent * 100).toFixed(0)}% (grade: ${scoreGrade})`,
        trailingStopActive: false,
      };
    }
  } else if (state.tp1Hit && !state.trailingStopActive) {
    // Post-TP1, pre-TP2: stop is at breakeven
    if (currentPrice <= entryPrice) {
      return {
        action: 'BREAKEVEN_STOP',
        sellPercent: state.currentPositionPercent,
        newStopPrice: entryPrice,
        reason: 'Breakeven stop hit after TP1',
        trailingStopActive: false,
      };
    }
  }

  // --- Priority 3: Check time limit ---
  if (elapsedHours >= MAX_HOLD_HOURS && state.currentPositionPercent > 0) {
    return {
      action: 'TIME_LIMIT',
      sellPercent: state.currentPositionPercent,
      newStopPrice: state.stopPrice,
      reason: `Time limit: ${MAX_HOLD_HOURS}h max hold exceeded`,
      trailingStopActive: false,
    };
  }

  // --- Priority 4: Check take profit levels ---

  // TP2: +150%
  if (!state.tp2Hit && state.tp1Hit && priceChangeFromEntry >= TP2_PERCENT) {
    const newTrailingStopPrice = effectivePeak * (1 - 0.20); // 20% trail initially
    return {
      action: 'TAKE_PROFIT_2',
      sellPercent: TP2_SELL_PERCENT,
      newStopPrice: newTrailingStopPrice,
      reason: `TP2 hit: +${(priceChangeFromEntry * 100).toFixed(1)}% — selling ${TP2_SELL_PERCENT}%, activating trailing stop`,
      trailingStopActive: true,
    };
  }

  // TP1: +50%
  if (!state.tp1Hit && priceChangeFromEntry >= TP1_PERCENT) {
    return {
      action: 'TAKE_PROFIT_1',
      sellPercent: TP1_SELL_PERCENT,
      newStopPrice: entryPrice, // Move stop to breakeven
      reason: `TP1 hit: +${(priceChangeFromEntry * 100).toFixed(1)}% — selling ${TP1_SELL_PERCENT}%, stop → breakeven`,
      trailingStopActive: false,
    };
  }

  // --- No action needed ---
  // Update trailing stop price if trailing is active (ratchet up only)
  let newStopPrice = state.stopPrice;
  if (state.trailingStopActive) {
    const trailPercent = getTrailingStopPercent(effectivePeak, entryPrice);
    const newTrailingStop = effectivePeak * (1 - trailPercent);
    newStopPrice = Math.max(state.stopPrice, newTrailingStop); // Ratchet up only
  }

  return {
    action: 'NONE',
    sellPercent: 0,
    newStopPrice,
    reason: '',
    trailingStopActive: state.trailingStopActive,
  };
}

// ============ HELPERS ============

/**
 * Get trailing stop percentage based on how far above entry the peak is.
 * Tighter trails at higher gains to lock in more profit.
 */
function getTrailingStopPercent(peakPrice: number, entryPrice: number): number {
  const peakGain = (peakPrice - entryPrice) / entryPrice;

  for (const tier of TRAILING_STOP_TIERS) {
    if (peakGain >= tier.minGain) {
      return tier.trail;
    }
  }

  // Default: 20% trail
  return 0.20;
}

/**
 * Get the initial stop loss price for a new position.
 */
export function getInitialStopLoss(entryPrice: number, scoreGrade: ScoreGrade): number {
  const stopPercent = STOP_LOSS_BY_GRADE[scoreGrade];
  return entryPrice * (1 + stopPercent);
}

/**
 * Get the score grade from a numeric score.
 */
export function scoreToGrade(score: number): ScoreGrade {
  if (score >= 75) return 'STRONG_BUY';
  if (score >= 55) return 'BUY';
  return 'WATCH';
}

/**
 * Create initial partial exit state for a new position.
 */
export function createInitialExitState(entryPrice: number, scoreGrade: ScoreGrade): PartialExitState {
  return {
    tp1Hit: false,
    tp2Hit: false,
    currentPositionPercent: 100,
    stopPrice: getInitialStopLoss(entryPrice, scoreGrade),
    trailingStopActive: false,
    peakPriceSinceEntry: entryPrice,
  };
}

/**
 * Apply an exit decision to the current state, returning the new state.
 */
export function applyExitDecision(
  state: PartialExitState,
  decision: ExitDecision,
  currentPrice: number
): PartialExitState {
  const newState = { ...state };

  newState.peakPriceSinceEntry = Math.max(state.peakPriceSinceEntry, currentPrice);
  newState.stopPrice = decision.newStopPrice;
  newState.trailingStopActive = decision.trailingStopActive;

  switch (decision.action) {
    case 'TAKE_PROFIT_1':
      newState.tp1Hit = true;
      newState.currentPositionPercent = state.currentPositionPercent - decision.sellPercent;
      break;

    case 'TAKE_PROFIT_2':
      newState.tp2Hit = true;
      newState.currentPositionPercent = state.currentPositionPercent - decision.sellPercent;
      break;

    case 'STOP_LOSS':
    case 'BREAKEVEN_STOP':
    case 'TRAILING_STOP':
    case 'TIME_LIMIT':
      newState.currentPositionPercent = 0; // Fully closed
      break;

    case 'NONE':
      // Just update peak and trailing stop
      break;
  }

  return newState;
}

/**
 * Calculate the realized return from a series of partial exits.
 *
 * Each exit records: { exitPrice, percentOfOriginal }
 * Realized return = sum of (exitPrice/entryPrice - 1) * percentOfOriginal / 100
 */
export function calculateRealizedReturn(
  entryPrice: number,
  partialExits: Array<{ exitPrice: number; percentOfOriginal: number }>
): number {
  let totalReturn = 0;

  for (const exit of partialExits) {
    const exitReturn = (exit.exitPrice / entryPrice - 1) * (exit.percentOfOriginal / 100);
    totalReturn += exitReturn;
  }

  return totalReturn; // As a decimal (e.g., 1.68 = +168%)
}

/**
 * Classify the outcome based on realized return.
 */
export function classifyOutcome(realizedReturn: number): string {
  if (realizedReturn > 3.00) return 'MASSIVE_WIN';
  if (realizedReturn > 1.00) return 'BIG_WIN';
  if (realizedReturn > 0.30) return 'MEDIUM_WIN';
  if (realizedReturn > 0) return 'SMALL_WIN';
  if (realizedReturn > -0.15) return 'SMALL_LOSS';
  return 'FULL_STOP';
}

// ============ CANONICAL PARAMETERS EXPORT ============
// For use by other modules that need to know the exit levels

export const CANONICAL_EXIT_PARAMS = {
  TP1_PERCENT,
  TP1_SELL_PERCENT,
  TP2_PERCENT,
  TP2_SELL_PERCENT,
  MAX_HOLD_HOURS,
  STOP_LOSS_BY_GRADE,
  TRAILING_STOP_TIERS,
} as const;

export default {
  calculateExitAction,
  getInitialStopLoss,
  scoreToGrade,
  createInitialExitState,
  applyExitDecision,
  calculateRealizedReturn,
  classifyOutcome,
  CANONICAL_EXIT_PARAMS,
};
