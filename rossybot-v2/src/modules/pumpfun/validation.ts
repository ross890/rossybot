import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import { fetchCurveState, estimateCurveFillPct, deriveBondingCurveAddress } from './detector.js';
import type { ParsedSignal, ValidationCheckResult } from '../../types/index.js';

export interface PumpFunValidationResult {
  passed: boolean;
  failReason: string | null;
  curveProgress: ValidationCheckResult;
  conviction: ValidationCheckResult;
  velocity: ValidationCheckResult;
  tokenAge: ValidationCheckResult;
  curveFillPct: number;
  solInCurve: number;
  /** Signal quality score 0-100 — higher = stronger entry signal */
  signalScore: number;
  /** If true, the token should be added to the deferred entry watchlist */
  deferToWatchlist: boolean;
}

export interface CurveHint {
  realSol: number;
  /** Current velocity in SOL/min (from PumpPortal/MoversTracker) */
  velocitySolPerMin?: number;
}

/**
 * Pump.fun-specific validation gate.
 * Standard gates (mcap, liquidity, momentum) don't apply to pre-graduation tokens.
 * Instead we validate: curve fill range, alpha conviction, curve velocity, token age.
 *
 * KEY INSIGHT from 540 trades:
 *  - 10-30% curve fill = 1-11% WR (death zone)
 *  - 30-40% curve fill = 82% WR (sweet spot)
 *  - Entry zone: 33-38% curve fill
 *  - Below 33%: defer to watchlist, enter when momentum confirms
 *  - Velocity < 1.0 SOL/min at entry = stalling token = dead weight
 */
export async function validatePumpFunSignal(
  signal: ParsedSignal,
  curveHint?: CurveHint,
): Promise<PumpFunValidationResult> {
  const cfg = config.pumpFun;
  const mint = signal.tokenMint;

  // 1. Check bonding curve progress
  let curveFillPct = 0;
  let solInCurve = 0;
  let velocitySolPerMin: number | undefined;

  if (curveHint) {
    solInCurve = curveHint.realSol;
    curveFillPct = estimateCurveFillPct(solInCurve);
    velocitySolPerMin = curveHint.velocitySolPerMin;
    logger.debug({ mint: mint.slice(0, 8), solInCurve, velocity: velocitySolPerMin, source: 'pumpportal_cache' }, 'Using cached curve state');
  } else {
    let bondingCurve = signal.pumpFunData?.bondingCurveAddress;
    if (!bondingCurve || bondingCurve === 'unknown') {
      try {
        bondingCurve = deriveBondingCurveAddress(mint);
      } catch {
        bondingCurve = undefined;
      }
    }

    if (bondingCurve) {
      const curveState = await fetchCurveState(bondingCurve);
      if (curveState?.exists) {
        solInCurve = curveState.solBalance;
        curveFillPct = estimateCurveFillPct(solInCurve);
      } else if (bondingCurve !== deriveBondingCurveAddress(mint)) {
        const pdaAddr = deriveBondingCurveAddress(mint);
        const pdaState = await fetchCurveState(pdaAddr);
        if (pdaState?.exists) {
          solInCurve = pdaState.solBalance;
          curveFillPct = estimateCurveFillPct(solInCurve);
        }
      }
    }
  }

  // 2. Check alpha wallet conviction (did they spend a meaningful amount?)
  const solSpentAbs = Math.abs(signal.solDelta);
  const convictionOk = solSpentAbs >= cfg.minConvictionSol;
  const conviction: ValidationCheckResult = convictionOk
    ? { passed: true, reason: `${solSpentAbs.toFixed(2)} SOL spent (min: ${cfg.minConvictionSol})` }
    : { passed: false, reason: `Only ${solSpentAbs.toFixed(2)} SOL spent — below ${cfg.minConvictionSol} conviction threshold` };

  if (!convictionOk) {
    logger.info({ mint: mint.slice(0, 8), solSpent: solSpentAbs, min: cfg.minConvictionSol },
      'Pump.fun REJECTED — low conviction buy');
    return buildFail('LOW_CONVICTION', curveFillPct, solInCurve, conviction);
  }

  // 3. Curve entry zone check — THE CRITICAL GATE
  // Data: 10-30% fill = 1-11% WR. 30-40% = 82% WR.
  // Entry zone: curveEntryMin (33%) to curveEntryMax (38%)

  const entryMin = cfg.curveEntryMin;
  const entryMax = cfg.curveEntryMax;

  // Too far along — no room for TP
  if (curveFillPct > entryMax) {
    logger.info({ mint: mint.slice(0, 8), curveFillPct: (curveFillPct * 100).toFixed(1) },
      'Pump.fun REJECTED — curve too far along, no room for scalp');
    return buildFail('CURVE_NEARLY_GRADUATED', curveFillPct, solInCurve,
      { passed: false, reason: `Curve ${(curveFillPct * 100).toFixed(0)}% filled — above ${(entryMax * 100).toFixed(0)}% entry max` });
  }

  // Below entry zone — defer to watchlist if enabled
  if (curveFillPct < entryMin) {
    if (cfg.deferredEntryEnabled) {
      logger.info({ mint: mint.slice(0, 8), solInCurve: solInCurve.toFixed(2), curveFillPct: (curveFillPct * 100).toFixed(1),
        entryMin: (entryMin * 100).toFixed(0) },
        'Pump.fun DEFERRED — below entry zone, watchlisting for momentum');
      return {
        passed: false,
        failReason: 'DEFERRED_TO_WATCHLIST',
        curveProgress: { passed: false, reason: `Curve ${(curveFillPct * 100).toFixed(0)}% — below ${(entryMin * 100).toFixed(0)}% entry zone, watching` },
        conviction,
        velocity: { passed: true, reason: 'Not checked (deferred)' },
        tokenAge: { passed: true, reason: 'Not checked' },
        curveFillPct,
        solInCurve,
        signalScore: 0,
        deferToWatchlist: true,
      };
    }
    logger.info({ mint: mint.slice(0, 8), solInCurve, curveFillPct: (curveFillPct * 100).toFixed(1) },
      'Pump.fun REJECTED — curve too early, no momentum');
    return buildFail('CURVE_TOO_EARLY', curveFillPct, solInCurve,
      { passed: false, reason: `Only ${solInCurve.toFixed(2)} SOL in curve (${(curveFillPct * 100).toFixed(0)}%) — below ${(entryMin * 100).toFixed(0)}% entry zone` });
  }

  // 4. Velocity enforcement — reject stalling tokens
  // Config: curveVelocityMin (1.0 SOL/min). Tokens below this are dead weight.
  const velocityCheck: ValidationCheckResult = velocitySolPerMin !== undefined
    ? velocitySolPerMin >= cfg.curveVelocityMin
      ? { passed: true, reason: `${velocitySolPerMin.toFixed(2)} SOL/min (min: ${cfg.curveVelocityMin})` }
      : { passed: false, reason: `Velocity ${velocitySolPerMin.toFixed(2)} SOL/min — below ${cfg.curveVelocityMin} minimum` }
    : { passed: true, reason: 'Velocity data unavailable — skipped' };

  if (velocitySolPerMin !== undefined && velocitySolPerMin < cfg.curveVelocityMin) {
    logger.info({
      mint: mint.slice(0, 8),
      velocity: velocitySolPerMin.toFixed(2),
      min: cfg.curveVelocityMin,
      curveFill: (curveFillPct * 100).toFixed(1),
    }, 'Pump.fun REJECTED — curve velocity too low (stalling)');
    return buildFail('LOW_VELOCITY', curveFillPct, solInCurve, velocityCheck);
  }

  // IN THE ENTRY ZONE (33-38%) — this is the 82% WR sweet spot
  // 5. Token age check
  const tokenAge: ValidationCheckResult = { passed: true, reason: 'Age check skipped (no creation data yet)' };

  // 6. Calculate signal quality score (0-100)
  const signalScore = calculateSignalScore(curveFillPct, solSpentAbs, velocitySolPerMin);

  logger.info({
    mint: mint.slice(0, 8),
    curveFillPct: (curveFillPct * 100).toFixed(1),
    solInCurve: solInCurve.toFixed(2),
    conviction: solSpentAbs.toFixed(2),
    velocity: velocitySolPerMin?.toFixed(2) || 'N/A',
    signalScore,
    entryZone: `${(entryMin * 100).toFixed(0)}-${(entryMax * 100).toFixed(0)}%`,
  }, 'Pump.fun validation PASSED — in entry zone');

  return {
    passed: true,
    failReason: null,
    curveProgress: { passed: true, reason: `Curve ${(curveFillPct * 100).toFixed(0)}% filled — in ${(entryMin * 100).toFixed(0)}-${(entryMax * 100).toFixed(0)}% entry zone` },
    conviction,
    velocity: velocityCheck,
    tokenAge,
    curveFillPct,
    solInCurve,
    signalScore,
    deferToWatchlist: false,
  };
}

/**
 * Signal quality score: 0-100.
 * Combines curve position, conviction size, and velocity into a single
 * quality metric. Higher score = stronger entry signal.
 *
 * Components:
 *  - Curve position (0-40): how close to the sweet spot (35-38%)
 *  - Conviction (0-30): alpha SOL spent (more = higher confidence)
 *  - Velocity (0-30): SOL/min inflow (faster = more momentum)
 */
function calculateSignalScore(
  curveFillPct: number,
  solSpent: number,
  velocitySolPerMin?: number,
): number {
  const cfg = config.pumpFun;

  // Curve position score (0-40)
  // Best: 35-38% (deep in the sweet spot). Adequate: 33-35%.
  // Linear scale: 33% = 20pts, 35% = 35pts, 37% = 40pts
  let curveScore: number;
  if (curveFillPct >= 0.35) {
    curveScore = Math.min(40, 35 + ((curveFillPct - 0.35) / 0.03) * 5);
  } else {
    curveScore = Math.max(0, 20 + ((curveFillPct - cfg.curveEntryMin) / 0.02) * 15);
  }

  // Conviction score (0-30)
  // Minimum: minConvictionSol (2.0) = 10pts. 5 SOL = 20pts. 10+ SOL = 30pts.
  const convictionScore = Math.min(30, 10 + ((solSpent - cfg.minConvictionSol) / 8) * 20);

  // Velocity score (0-30)
  // Minimum: curveVelocityMin (1.0) = 10pts. 3 SOL/min = 20pts. 5+ SOL/min = 30pts.
  let velocityScore = 15; // Default when no data available
  if (velocitySolPerMin !== undefined) {
    velocityScore = Math.min(30, 10 + ((velocitySolPerMin - cfg.curveVelocityMin) / 4) * 20);
  }

  return Math.round(Math.max(0, Math.min(100, curveScore + convictionScore + velocityScore)));
}

function buildFail(
  reason: string,
  curveFillPct: number,
  solInCurve: number,
  failedCheck: ValidationCheckResult,
): PumpFunValidationResult {
  return {
    passed: false,
    failReason: reason,
    curveProgress: failedCheck,
    conviction: { passed: true, reason: 'Not checked' },
    velocity: { passed: true, reason: 'Not checked' },
    tokenAge: { passed: true, reason: 'Not checked' },
    curveFillPct,
    solInCurve,
    signalScore: 0,
    deferToWatchlist: false,
  };
}
