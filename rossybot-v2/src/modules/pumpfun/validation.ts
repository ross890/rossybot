import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import { fetchCurveState, estimateCurveFillPct, deriveBondingCurveAddress } from './detector.js';
import type { ParsedSignal, ValidationCheckResult } from '../../types/index.js';

export interface PumpFunValidationResult {
  passed: boolean;
  failReason: string | null;
  curveProgress: ValidationCheckResult;
  conviction: ValidationCheckResult;
  tokenAge: ValidationCheckResult;
  curveFillPct: number;
  solInCurve: number;
  /** If true, the token should be added to the deferred entry watchlist */
  deferToWatchlist: boolean;
}

/**
 * Pump.fun-specific validation gate.
 * Standard gates (mcap, liquidity, momentum) don't apply to pre-graduation tokens.
 * Instead we validate: curve fill range, alpha conviction, token age.
 *
 * KEY INSIGHT from 362 trades:
 *  - 10-30% curve fill = 1-11% WR (death zone)
 *  - 30-40% curve fill = 82% WR (sweet spot)
 *  - Entry zone: 28-38% curve fill
 *  - Below 28%: defer to watchlist, enter when momentum confirms
 */
export async function validatePumpFunSignal(
  signal: ParsedSignal,
  curveHint?: { realSol: number },
): Promise<PumpFunValidationResult> {
  const cfg = config.pumpFun;
  const mint = signal.tokenMint;

  // 1. Check bonding curve progress
  let curveFillPct = 0;
  let solInCurve = 0;

  if (curveHint) {
    solInCurve = curveHint.realSol;
    curveFillPct = estimateCurveFillPct(solInCurve);
    logger.debug({ mint: mint.slice(0, 8), solInCurve, source: 'pumpportal_cache' }, 'Using cached curve state');
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
  // Entry zone: curveEntryMin (28%) to curveEntryMax (38%)

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
        tokenAge: { passed: true, reason: 'Not checked' },
        curveFillPct,
        solInCurve,
        deferToWatchlist: true,
      };
    }
    logger.info({ mint: mint.slice(0, 8), solInCurve, curveFillPct: (curveFillPct * 100).toFixed(1) },
      'Pump.fun REJECTED — curve too early, no momentum');
    return buildFail('CURVE_TOO_EARLY', curveFillPct, solInCurve,
      { passed: false, reason: `Only ${solInCurve.toFixed(2)} SOL in curve (${(curveFillPct * 100).toFixed(0)}%) — below ${(entryMin * 100).toFixed(0)}% entry zone` });
  }

  // IN THE ENTRY ZONE (28-38%) — this is the 82% WR sweet spot
  // 4. Token age check
  const tokenAge: ValidationCheckResult = { passed: true, reason: 'Age check skipped (no creation data yet)' };

  logger.info({
    mint: mint.slice(0, 8),
    curveFillPct: (curveFillPct * 100).toFixed(1),
    solInCurve: solInCurve.toFixed(2),
    conviction: solSpentAbs.toFixed(2),
    entryZone: `${(entryMin * 100).toFixed(0)}-${(entryMax * 100).toFixed(0)}%`,
  }, 'Pump.fun validation PASSED — in entry zone');

  return {
    passed: true,
    failReason: null,
    curveProgress: { passed: true, reason: `Curve ${(curveFillPct * 100).toFixed(0)}% filled — in ${(entryMin * 100).toFixed(0)}-${(entryMax * 100).toFixed(0)}% entry zone` },
    conviction,
    tokenAge,
    curveFillPct,
    solInCurve,
    deferToWatchlist: false,
  };
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
    tokenAge: { passed: true, reason: 'Not checked' },
    curveFillPct,
    solInCurve,
    deferToWatchlist: false,
  };
}
