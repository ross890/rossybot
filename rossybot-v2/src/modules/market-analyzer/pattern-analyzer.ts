import { logger } from '../../utils/logger.js';
import type { GraduatedToken } from './graduated-fetcher.js';
import type { EarlyBuyer } from './early-buyer-analyzer.js';

export interface GraduationPatterns {
  // Timing patterns
  avgTimeToGraduateMins: number;
  medianTimeToGraduateMins: number;
  graduationHourDistribution: Record<number, number>; // hour (0-23) → count
  peakGraduationHour: number;
  // Market metrics at graduation
  medianMcapUsd: number;
  avgMcapUsd: number;
  medianLiquidityUsd: number;
  avgVolumeUsd: number;
  // Buy/sell dynamics
  avgBuySellRatio: number;
  tokensWithBuyDominance: number; // buy ratio > 0.55
  tokensWithSellDominance: number; // buy ratio < 0.45
  // Post-graduation performance
  avgPriceChangeH1: number;
  avgPriceChangeH6: number;
  avgPriceChangeH24: number;
  pctPositiveH1: number;  // % of tokens up after 1h
  pctPositiveH24: number; // % of tokens up after 24h
  // Early buyer patterns
  avgEarlyBuyersPerToken: number;
  avgSolPerEarlyBuyer: number;
  tokensWithAlphaBuyers: number;
  tokensWithAlphaBuyersPct: number;
  // Name/symbol patterns
  commonWords: Array<{ word: string; count: number }>;
  avgSymbolLength: number;
  // Risk metrics
  rugPullIndicators: number; // tokens where price dropped >90% after graduation
  healthyGraduations: number; // tokens maintaining >50% of graduation price
}

/**
 * Analyze patterns across all graduated tokens to identify what makes
 * a token successfully graduate and perform well post-graduation.
 */
export function analyzeGraduationPatterns(
  tokens: GraduatedToken[],
  allEarlyBuyers: Map<string, EarlyBuyer[]>,
): GraduationPatterns {
  if (tokens.length === 0) {
    return emptyPatterns();
  }

  // --- Timing patterns ---
  const graduationHours = tokens
    .filter((t) => t.pairCreatedAt > 0)
    .map((t) => new Date(t.pairCreatedAt).getUTCHours());

  const hourDist: Record<number, number> = {};
  for (let h = 0; h < 24; h++) hourDist[h] = 0;
  for (const h of graduationHours) hourDist[h]++;

  const peakHour = Object.entries(hourDist)
    .sort(([, a], [, b]) => b - a)[0]?.[0] || '0';

  // --- Market metrics ---
  const mcaps = tokens.map((t) => t.mcapUsd).filter((v) => v > 0).sort((a, b) => a - b);
  const liquidity = tokens.map((t) => t.liquidityUsd).filter((v) => v > 0).sort((a, b) => a - b);
  const volumes = tokens.map((t) => t.volume24h).filter((v) => v > 0);

  // --- Buy/sell dynamics ---
  const buyRatios = tokens.map((t) => t.buySellRatio).filter((v) => v > 0);
  const buyDominant = tokens.filter((t) => t.buySellRatio > 0.55).length;
  const sellDominant = tokens.filter((t) => t.buySellRatio < 0.45).length;

  // --- Post-graduation performance ---
  const priceChangesH1 = tokens.map((t) => t.priceChangeH1).filter((v) => v !== 0);
  const priceChangesH24 = tokens.map((t) => t.priceChangeH24).filter((v) => v !== 0);
  const positiveH1 = priceChangesH1.filter((v) => v > 0).length;
  const positiveH24 = priceChangesH24.filter((v) => v > 0).length;

  // --- Early buyer patterns ---
  const earlyBuyerCounts: number[] = [];
  const solPerBuyer: number[] = [];
  let tokensWithAlpha = 0;

  for (const token of tokens) {
    const buyers = allEarlyBuyers.get(token.mint) || [];
    earlyBuyerCounts.push(buyers.length);

    for (const b of buyers) {
      solPerBuyer.push(b.estimatedSolSpent);
    }

    if (buyers.some((b) => b.isKnownAlpha)) {
      tokensWithAlpha++;
    }
  }

  // --- Name/symbol patterns ---
  const wordCounts = new Map<string, number>();
  for (const t of tokens) {
    const words = (t.name + ' ' + t.symbol)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);

    for (const w of words) {
      wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    }
  }
  const commonWords = Array.from(wordCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([word, count]) => ({ word, count }));

  const symbolLengths = tokens.map((t) => t.symbol.length);

  // --- Risk metrics ---
  const rugPulls = tokens.filter((t) => t.priceChangeH24 < -90).length;
  const healthy = tokens.filter((t) => t.priceChangeH24 > -50).length;

  const patterns: GraduationPatterns = {
    avgTimeToGraduateMins: 0, // Will be populated from on-chain creation time
    medianTimeToGraduateMins: 0,
    graduationHourDistribution: hourDist,
    peakGraduationHour: Number(peakHour),
    medianMcapUsd: median(mcaps),
    avgMcapUsd: avg(mcaps),
    medianLiquidityUsd: median(liquidity),
    avgVolumeUsd: avg(volumes),
    avgBuySellRatio: avg(buyRatios),
    tokensWithBuyDominance: buyDominant,
    tokensWithSellDominance: sellDominant,
    avgPriceChangeH1: avg(priceChangesH1),
    avgPriceChangeH6: avg(tokens.map((t) => t.priceChangeH6)),
    avgPriceChangeH24: avg(priceChangesH24),
    pctPositiveH1: priceChangesH1.length > 0 ? (positiveH1 / priceChangesH1.length) * 100 : 0,
    pctPositiveH24: priceChangesH24.length > 0 ? (positiveH24 / priceChangesH24.length) * 100 : 0,
    avgEarlyBuyersPerToken: avg(earlyBuyerCounts),
    avgSolPerEarlyBuyer: avg(solPerBuyer),
    tokensWithAlphaBuyers: tokensWithAlpha,
    tokensWithAlphaBuyersPct: tokens.length > 0 ? (tokensWithAlpha / tokens.length) * 100 : 0,
    commonWords,
    avgSymbolLength: avg(symbolLengths),
    rugPullIndicators: rugPulls,
    healthyGraduations: healthy,
  };

  logger.info({
    tokens: tokens.length,
    medianMcap: `$${patterns.medianMcapUsd.toLocaleString()}`,
    avgBuySellRatio: patterns.avgBuySellRatio.toFixed(2),
    pctPositiveH1: `${patterns.pctPositiveH1.toFixed(0)}%`,
    tokensWithAlpha: `${tokensWithAlpha}/${tokens.length}`,
  }, 'Graduation pattern analysis complete');

  return patterns;
}

/**
 * Identify tokens that would have been profitable Rossybot entries.
 * This is the key backtest: if we had entered at graduation, how would we have done?
 */
export function identifyProfitableGraduations(tokens: GraduatedToken[]): {
  profitable: GraduatedToken[];
  unprofitable: GraduatedToken[];
  profitRate: number;
  avgWinPct: number;
  avgLossPct: number;
  bestToken: GraduatedToken | null;
  worstToken: GraduatedToken | null;
} {
  // Consider a token "profitable" if it went up at least 20% within 24h of graduation
  // (matching Rossybot's MICRO tier stop loss as the minimum worthwhile move)
  const profitable = tokens.filter((t) => t.priceChangeH24 > 20);
  const unprofitable = tokens.filter((t) => t.priceChangeH24 <= 20);

  const winPcts = profitable.map((t) => t.priceChangeH24);
  const lossPcts = unprofitable.map((t) => t.priceChangeH24);

  const sorted = [...tokens].sort((a, b) => b.priceChangeH24 - a.priceChangeH24);

  return {
    profitable,
    unprofitable,
    profitRate: tokens.length > 0 ? profitable.length / tokens.length : 0,
    avgWinPct: avg(winPcts),
    avgLossPct: avg(lossPcts),
    bestToken: sorted[0] || null,
    worstToken: sorted[sorted.length - 1] || null,
  };
}

/**
 * Segment graduated tokens into tiers based on market cap to identify
 * which mcap ranges produce the best outcomes.
 */
export function segmentByMcap(tokens: GraduatedToken[]): Array<{
  range: string;
  count: number;
  avgPriceChangeH24: number;
  profitRate: number;
}> {
  const ranges = [
    { label: '<$50K', min: 0, max: 50_000 },
    { label: '$50K-$100K', min: 50_000, max: 100_000 },
    { label: '$100K-$500K', min: 100_000, max: 500_000 },
    { label: '$500K-$1M', min: 500_000, max: 1_000_000 },
    { label: '$1M-$5M', min: 1_000_000, max: 5_000_000 },
    { label: '>$5M', min: 5_000_000, max: Infinity },
  ];

  return ranges.map((range) => {
    const inRange = tokens.filter((t) => t.mcapUsd >= range.min && t.mcapUsd < range.max);
    const profitable = inRange.filter((t) => t.priceChangeH24 > 20);

    return {
      range: range.label,
      count: inRange.length,
      avgPriceChangeH24: avg(inRange.map((t) => t.priceChangeH24)),
      profitRate: inRange.length > 0 ? profitable.length / inRange.length : 0,
    };
  });
}

// --- Helpers ---

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function emptyPatterns(): GraduationPatterns {
  return {
    avgTimeToGraduateMins: 0,
    medianTimeToGraduateMins: 0,
    graduationHourDistribution: {},
    peakGraduationHour: 0,
    medianMcapUsd: 0,
    avgMcapUsd: 0,
    medianLiquidityUsd: 0,
    avgVolumeUsd: 0,
    avgBuySellRatio: 0,
    tokensWithBuyDominance: 0,
    tokensWithSellDominance: 0,
    avgPriceChangeH1: 0,
    avgPriceChangeH6: 0,
    avgPriceChangeH24: 0,
    pctPositiveH1: 0,
    pctPositiveH24: 0,
    avgEarlyBuyersPerToken: 0,
    avgSolPerEarlyBuyer: 0,
    tokensWithAlphaBuyers: 0,
    tokensWithAlphaBuyersPct: 0,
    commonWords: [],
    avgSymbolLength: 0,
    rugPullIndicators: 0,
    healthyGraduations: 0,
  };
}
