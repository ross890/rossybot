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
}

/**
 * Pump.fun-specific validation gate.
 * Standard gates (mcap, liquidity, momentum) don't apply to pre-graduation tokens.
 * Instead we validate: curve velocity, alpha conviction, token age.
 */
export async function validatePumpFunSignal(
  signal: ParsedSignal,
): Promise<PumpFunValidationResult> {
  const cfg = config.pumpFun;
  const mint = signal.tokenMint;

  // 1. Check bonding curve progress
  // Prefer PDA derivation (deterministic) over heuristic-detected address
  let bondingCurve = signal.pumpFunData?.bondingCurveAddress;
  if (!bondingCurve || bondingCurve === 'unknown') {
    try {
      bondingCurve = deriveBondingCurveAddress(mint);
    } catch {
      bondingCurve = undefined;
    }
  }
  let curveFillPct = 0;
  let solInCurve = 0;

  if (bondingCurve) {
    const curveState = await fetchCurveState(bondingCurve);
    if (curveState?.exists) {
      solInCurve = curveState.solBalance;
      curveFillPct = estimateCurveFillPct(solInCurve);
    } else if (bondingCurve !== deriveBondingCurveAddress(mint)) {
      // Heuristic address returned no data — retry with PDA
      const pdaAddr = deriveBondingCurveAddress(mint);
      const pdaState = await fetchCurveState(pdaAddr);
      if (pdaState?.exists) {
        bondingCurve = pdaAddr;
        solInCurve = pdaState.solBalance;
        curveFillPct = estimateCurveFillPct(solInCurve);
      }
    }
  }

  // Reject if curve is already >65% filled — need room for 75% TP / 85% hard exit
  if (curveFillPct > 0.65) {
    logger.info({ mint: mint.slice(0, 8), curveFillPct: (curveFillPct * 100).toFixed(1) },
      'Pump.fun REJECTED — curve too far along, no room for scalp');
    return buildFail('CURVE_NEARLY_GRADUATED', curveFillPct, solInCurve,
      { passed: false, reason: `Curve ${(curveFillPct * 100).toFixed(0)}% filled — too close to TP/exit zone` });
  }

  // Reject if curve is too empty (<10%) — need some momentum before we enter.
  // Lowered from 20% — earlier entry = more room for 75% TP. Exits now work properly.
  const solSpentAbs = Math.abs(signal.solDelta);
  if (curveFillPct < 0.10) {
    logger.info({ mint: mint.slice(0, 8), solInCurve, curveFillPct: (curveFillPct * 100).toFixed(1) },
      'Pump.fun REJECTED — curve too early, no momentum');
    return buildFail('CURVE_TOO_EARLY', curveFillPct, solInCurve,
      { passed: false, reason: `Only ${solInCurve.toFixed(2)} SOL in curve (${(curveFillPct * 100).toFixed(0)}%) — too early` });
  }

  // 2. Check alpha wallet conviction (did they spend a meaningful amount?)
  const solSpent = solSpentAbs;
  const convictionOk = solSpent >= cfg.minConvictionSol;
  const conviction: ValidationCheckResult = convictionOk
    ? { passed: true, reason: `${solSpent.toFixed(2)} SOL spent (min: ${cfg.minConvictionSol})` }
    : { passed: false, reason: `Only ${solSpent.toFixed(2)} SOL spent — below ${cfg.minConvictionSol} conviction threshold` };

  if (!convictionOk) {
    logger.info({ mint: mint.slice(0, 8), solSpent, min: cfg.minConvictionSol },
      'Pump.fun REJECTED — low conviction buy');
    return buildFail('LOW_CONVICTION', curveFillPct, solInCurve, conviction);
  }

  // 3. Token age check — skip pump.fun tokens older than maxTokenAgeMins
  // We estimate age from detection lag (rough proxy — real age would need creation tx lookup)
  const tokenAge: ValidationCheckResult = { passed: true, reason: 'Age check skipped (no creation data yet)' };

  logger.info({
    mint: mint.slice(0, 8),
    curveFillPct: (curveFillPct * 100).toFixed(1),
    solInCurve: solInCurve.toFixed(2),
    conviction: solSpent.toFixed(2),
  }, 'Pump.fun validation PASSED');

  return {
    passed: true,
    failReason: null,
    curveProgress: { passed: true, reason: `Curve ${(curveFillPct * 100).toFixed(0)}% filled (${solInCurve.toFixed(1)} SOL)` },
    conviction,
    tokenAge,
    curveFillPct,
    solInCurve,
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
  };
}
