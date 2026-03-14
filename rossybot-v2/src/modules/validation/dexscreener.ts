import axios from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { DexScreenerPair, ValidationCheckResult, TierConfig } from '../../types/index.js';

const DEXSCREENER_BASE = config.dexScreener.baseUrl;

export async function fetchDexPair(tokenMint: string): Promise<DexScreenerPair | null> {
  try {
    const resp = await axios.get(`${DEXSCREENER_BASE}/tokens/${tokenMint}`, {
      timeout: 10_000,
    });

    const pairs: DexScreenerPair[] = resp.data?.pairs || [];
    if (pairs.length === 0) return null;

    // Return the pair with highest liquidity
    return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  } catch (err) {
    logger.error({ err, mint: tokenMint }, 'DexScreener API error');
    return null;
  }
}

export function checkLiquidity(pair: DexScreenerPair, tierCfg: TierConfig): ValidationCheckResult {
  const liq = pair.liquidity?.usd || 0;
  const passed = liq >= tierCfg.liquidityMin;
  return {
    passed,
    reason: passed ? undefined : `Liquidity $${liq.toLocaleString()} < $${tierCfg.liquidityMin.toLocaleString()}`,
    details: { liquidityUsd: liq, required: tierCfg.liquidityMin },
  };
}

export function checkMomentum(pair: DexScreenerPair, tierCfg: TierConfig): ValidationCheckResult {
  const window = tierCfg.momentumWindow;
  const priceChange = window === '6h' ? pair.priceChange?.h6 : pair.priceChange?.h24;
  const volume = window === '6h' ? pair.volume?.h6 : pair.volume?.h24;
  const vol24 = pair.volume?.h24 || 1;
  const volMultiplier = volume / Math.max(vol24 / (window === '6h' ? 4 : 1), 1);

  if (priceChange === undefined || priceChange === null) {
    return { passed: false, reason: 'No price change data' };
  }

  const reasons: string[] = [];

  // Must be up within range
  if (priceChange < tierCfg.momentumMin) {
    reasons.push(`Price change ${priceChange.toFixed(1)}% < ${tierCfg.momentumMin}% min`);
  }
  if (priceChange > tierCfg.momentumMax) {
    reasons.push(`Price change ${priceChange.toFixed(1)}% > ${tierCfg.momentumMax}% (too hot)`);
  }

  // Volume check
  if (volMultiplier < tierCfg.volumeMultiplierMin) {
    reasons.push(`Volume ${volMultiplier.toFixed(1)}x < ${tierCfg.volumeMultiplierMin}x avg`);
  }

  const passed = reasons.length === 0;
  return {
    passed,
    reason: passed ? undefined : reasons.join('; '),
    details: { priceChange, volumeMultiplier: volMultiplier, window },
  };
}

export function checkMarketCap(pair: DexScreenerPair, tierCfg: TierConfig): ValidationCheckResult {
  const mcap = pair.marketCap || pair.fdv || 0;

  if (mcap < tierCfg.mcapMin) {
    return { passed: false, reason: `MCap $${mcap.toLocaleString()} < $${tierCfg.mcapMin.toLocaleString()}` };
  }
  if (mcap > tierCfg.mcapMax) {
    return { passed: false, reason: `MCap $${mcap.toLocaleString()} > $${tierCfg.mcapMax.toLocaleString()}` };
  }

  return { passed: true, details: { mcap } };
}

export function checkTokenAge(pair: DexScreenerPair, tierCfg: TierConfig): ValidationCheckResult {
  if (tierCfg.tokenMaxAgeDays === null) {
    return { passed: true }; // No age limit for MEDIUM/FULL
  }

  const createdAt = pair.pairCreatedAt;
  if (!createdAt) {
    return { passed: false, reason: 'No creation date' };
  }

  const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
  const passed = ageDays <= tierCfg.tokenMaxAgeDays;

  return {
    passed,
    reason: passed ? undefined : `Token age ${ageDays.toFixed(0)}d > ${tierCfg.tokenMaxAgeDays}d`,
    details: { ageDays, maxDays: tierCfg.tokenMaxAgeDays },
  };
}

export function getPriceUsd(pair: DexScreenerPair): number {
  return parseFloat(pair.priceUsd || '0');
}
