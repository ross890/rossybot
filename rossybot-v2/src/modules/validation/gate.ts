import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import { ValidationResult, type FullValidationResult, type TierConfig } from '../../types/index.js';
import { checkRugSafety } from './rugcheck.js';
import { fetchDexPair, checkLiquidity, checkMomentum, checkMarketCap, checkTokenAge } from './dexscreener.js';

/**
 * Validation gate — runs RugCheck + DexScreener checks in parallel.
 * Must complete within 30 seconds.
 */
export async function validateToken(
  tokenMint: string,
  tierCfg: TierConfig,
): Promise<FullValidationResult> {
  const start = Date.now();
  const isShadow = config.shadowMode;

  // Shadow mode: skip RugCheck entirely — no real capital at risk, maximize signal coverage
  // Live mode: run RugCheck + DexScreener in parallel
  const [rugResult, dexPair] = await Promise.all([
    isShadow
      ? Promise.resolve({ result: null, check: { passed: true, reason: 'Skipped (shadow mode)' } })
      : checkRugSafety(tokenMint),
    fetchDexPair(tokenMint),
  ]);

  // Check 1: Safety (skipped in shadow mode)
  const safety = rugResult.check;
  if (!safety.passed) {
    return buildResult(ValidationResult.FAILED_SAFETY, safety, dexPair, rugResult.result, start);
  }

  // Need DexScreener data for remaining checks
  if (!dexPair) {
    // Shadow mode: allow even without DexScreener data — just track the position
    if (isShadow) {
      logger.info({ mint: tokenMint.slice(0, 8) }, 'No DexScreener data — allowing in shadow mode');
    } else {
      return buildResult(
        ValidationResult.FAILED_LIQUIDITY,
        { passed: true },
        null,
        rugResult.result,
        start,
        { passed: false, reason: 'No DexScreener data' },
      );
    }
  }

  // In shadow mode with no dex data, pass all checks
  if (!dexPair && isShadow) {
    const durationMs = Date.now() - start;
    return {
      passed: true,
      failReason: null,
      safety,
      liquidity: { passed: true, reason: 'Skipped (no dex data, shadow mode)' },
      momentum: { passed: true, reason: 'Skipped (no dex data, shadow mode)' },
      mcap: { passed: true, reason: 'Skipped (no dex data, shadow mode)' },
      age: { passed: true, reason: 'Skipped (no dex data, shadow mode)' },
      dexData: null,
      rugCheck: null,
      durationMs,
    };
  }

  // Check 2: Liquidity
  const liquidity = checkLiquidity(dexPair!, tierCfg);
  if (!liquidity.passed) {
    if (!isShadow) {
      return buildResult(ValidationResult.FAILED_LIQUIDITY, safety, dexPair, rugResult.result, start, liquidity);
    }
    logger.info({ mint: tokenMint.slice(0, 8), reason: liquidity.reason }, 'Liquidity check failed — allowing in shadow mode');
  }

  // Check 3: Momentum
  const momentum = checkMomentum(dexPair!, tierCfg);
  if (!momentum.passed && !isShadow) {
    return buildResult(ValidationResult.FAILED_MOMENTUM, safety, dexPair, rugResult.result, start, liquidity, momentum);
  }

  // Check 4: Market Cap
  const mcap = checkMarketCap(dexPair!, tierCfg);
  if (!mcap.passed && !isShadow) {
    return buildResult(ValidationResult.FAILED_MCAP, safety, dexPair, rugResult.result, start, liquidity, momentum, mcap);
  }

  // Check 5: Token Age (MICRO/SMALL only)
  const age = checkTokenAge(dexPair!, tierCfg);
  if (!age.passed && !isShadow) {
    return buildResult(ValidationResult.FAILED_AGE, safety, dexPair, rugResult.result, start, liquidity, momentum, mcap, age);
  }

  const durationMs = Date.now() - start;
  logger.info({
    mint: tokenMint.slice(0, 8),
    durationMs,
    mcap: dexPair?.marketCap || dexPair?.fdv,
    liquidity: dexPair?.liquidity?.usd,
  }, 'Token validation PASSED');

  return {
    passed: true,
    failReason: null,
    safety,
    liquidity,
    momentum,
    mcap,
    age,
    dexData: dexPair,
    rugCheck: rugResult.result,
    durationMs,
  };
}

function buildResult(
  failReason: ValidationResult,
  safety: { passed: boolean; reason?: string; details?: Record<string, unknown> },
  dexData: import('../../types/index.js').DexScreenerPair | null,
  rugCheck: import('../../types/index.js').RugCheckResult | null,
  start: number,
  liquidity?: { passed: boolean; reason?: string; details?: Record<string, unknown> },
  momentum?: { passed: boolean; reason?: string; details?: Record<string, unknown> },
  mcap?: { passed: boolean; reason?: string; details?: Record<string, unknown> },
  age?: { passed: boolean; reason?: string; details?: Record<string, unknown> },
): FullValidationResult {
  const durationMs = Date.now() - start;
  return {
    passed: false,
    failReason,
    safety,
    liquidity: liquidity || { passed: false, reason: 'Not checked' },
    momentum: momentum || { passed: false, reason: 'Not checked' },
    mcap: mcap || { passed: false, reason: 'Not checked' },
    age: age || { passed: false, reason: 'Not checked' },
    dexData,
    rugCheck,
    durationMs,
  };
}
