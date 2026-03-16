import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import { ValidationResult, type FullValidationResult, type TierConfig } from '../../types/index.js';
import { fetchDexPair, checkLiquidity, checkMomentum, checkMarketCap, checkTokenAge } from './dexscreener.js';

/**
 * Validation gate — only enforces market cap range.
 * All other gates (rug check, liquidity, momentum, age) are logged but not enforced.
 * The wallet quality IS the validation — smart wallets are the edge.
 */
export async function validateToken(
  tokenMint: string,
  tierCfg: TierConfig,
): Promise<FullValidationResult> {
  const start = Date.now();

  // Fetch DexScreener data for market cap check + metadata
  const dexPair = await fetchDexPair(tokenMint);

  const skip = { passed: true, reason: 'Skipped (wallet quality is the validation)' };

  // No DexScreener data — allow through, we trust the wallets
  if (!dexPair) {
    const durationMs = Date.now() - start;
    logger.info({ mint: tokenMint.slice(0, 8), durationMs }, 'No DexScreener data — allowing (wallet-validated)');
    return {
      passed: true,
      failReason: null,
      safety: skip,
      liquidity: skip,
      momentum: skip,
      mcap: { passed: true, reason: 'No dex data to check' },
      age: skip,
      dexData: null,
      rugCheck: null,
      durationMs,
    };
  }

  // Only enforced gate: Market Cap — filter out tokens way outside our range
  const mcap = checkMarketCap(dexPair, tierCfg);
  if (!mcap.passed) {
    return buildResult(ValidationResult.FAILED_MCAP, dexPair, start, mcap);
  }

  // Enforce liquidity gate — no point entering if we can't exit
  const liquidity = checkLiquidity(dexPair, tierCfg);
  if (!liquidity.passed) {
    logger.info({ mint: tokenMint.slice(0, 8), liquidity: dexPair.liquidity?.usd, min: tierCfg.liquidityMin }, 'Token REJECTED — insufficient liquidity');
    return buildResult(ValidationResult.FAILED_LIQUIDITY, dexPair, start, { passed: false, reason: `Liquidity $${dexPair.liquidity?.usd || 0} below minimum $${tierCfg.liquidityMin}` });
  }

  // Enforce momentum gate — reject tokens dumping or overheated
  const momentum = checkMomentum(dexPair, tierCfg);
  if (!momentum.passed) {
    logger.info({ mint: tokenMint.slice(0, 8), h24: dexPair.priceChange?.h24 }, 'Token REJECTED — momentum out of range');
    return buildResult(ValidationResult.FAILED_MOMENTUM, dexPair, start, { passed: false, reason: `Momentum ${dexPair.priceChange?.h24}% outside ${tierCfg.momentumMin}-${tierCfg.momentumMax}%` });
  }

  // Token age (logged only)
  const age = checkTokenAge(dexPair, tierCfg);

  const durationMs = Date.now() - start;
  logger.info({
    mint: tokenMint.slice(0, 8),
    durationMs,
    mcap: dexPair.marketCap || dexPair.fdv,
    liquidity: dexPair.liquidity?.usd,
  }, 'Token validation PASSED');

  return {
    passed: true,
    failReason: null,
    safety: skip,
    liquidity,
    momentum,
    mcap,
    age,
    dexData: dexPair,
    rugCheck: null,
    durationMs,
  };
}

function buildResult(
  failReason: ValidationResult,
  dexData: import('../../types/index.js').DexScreenerPair | null,
  start: number,
  mcap: { passed: boolean; reason?: string; details?: Record<string, unknown> },
): FullValidationResult {
  const durationMs = Date.now() - start;
  const skip = { passed: true, reason: 'Skipped (wallet quality is the validation)' };
  return {
    passed: false,
    failReason,
    safety: skip,
    liquidity: skip,
    momentum: skip,
    mcap,
    age: skip,
    dexData,
    rugCheck: null,
    durationMs,
  };
}
