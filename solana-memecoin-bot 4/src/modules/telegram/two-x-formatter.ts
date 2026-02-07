// ===========================================
// TELEGRAM 2X SIGNAL FORMATTER
// Formats the new 2x probability signal for Telegram
// ===========================================

import { TwoXSignal } from '../two-x-probability.js';

// ============ TYPES ============

export interface TwoXAlertData {
  ticker: string;
  tokenName: string;
  contractAddress: string;
  marketCap: number;
  twoXSignal: TwoXSignal;
  holdersNow: number;
  holders30minAgo: number;
  volume24h: number;
  volumeRollingAvg: number;
  liquidityUsd: number;
  kolName: string | null;
}

// ============ FORMATTER ============

/**
 * Format a 2x probability signal for Telegram
 */
export function formatTwoXAlert(data: TwoXAlertData): string {
  const {
    ticker,
    contractAddress,
    marketCap,
    twoXSignal,
    holdersNow,
    holders30minAgo,
    volume24h,
    volumeRollingAvg,
    liquidityUsd,
    kolName,
  } = data;

  const shortCA = `${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;
  const probPct = Math.round(twoXSignal.adjustedProbability * 100);
  const basePct = Math.round(twoXSignal.baseRate * 100);

  // Dev score display
  const devScore = twoXSignal.devScoreData;
  let devLine: string;
  if (devScore) {
    const devEmoji = devScore.score === 'CLEAN' ? '✅' :
                     devScore.score === 'NEW_DEV' ? '➖' :
                     devScore.score === 'CAUTION' ? '⚠️' : '🚫';
    devLine = `${devScore.score} (${devScore.totalLaunches} launches, ${devScore.launchesOver100k} over $100k) ${devEmoji}`;
  } else {
    devLine = 'Unknown ➖';
  }

  // RugCheck display
  const rugCheck = twoXSignal.rugCheck;
  let rugLine: string;
  if (rugCheck) {
    const rugEmoji = rugCheck.score === 'GOOD' ? '✅' : '⚠️';
    rugLine = `${rugCheck.score} ${rugEmoji}`;
  } else {
    rugLine = 'Pending ➖';
  }

  // Holder velocity
  let holderVelocityPct = 0;
  let holderEmoji = '➖';
  if (holders30minAgo > 0) {
    holderVelocityPct = Math.round(((holdersNow - holders30minAgo) / holders30minAgo) * 100);
    holderEmoji = holderVelocityPct > 15 ? '✅' :
                  holderVelocityPct <= 0 ? '⚠️' : '➖';
  }

  // KOL activity
  const kolLine = kolName ? `Detected: @${kolName} ✅` : 'None ➖';

  // Volume vs avg
  let volumeMultiple = 0;
  let volumeEmoji = '➖';
  if (volumeRollingAvg > 0) {
    volumeMultiple = volume24h / volumeRollingAvg;
    volumeEmoji = volumeMultiple > 3 ? '✅' :
                  volumeMultiple < 1 ? '⚠️' : '➖';
  }

  // Liquidity
  const liqEmoji = liquidityUsd > 25000 ? '✅' :
                   liquidityUsd < 15000 ? '⚠️' : '➖';

  // Build message
  const lines: string[] = [];

  lines.push(`🎯 ROSSYBOT 2X SIGNAL`);
  lines.push('');
  lines.push(`$${ticker} at $${formatMC(marketCap)} MC`);
  lines.push(`CA: ${shortCA}`);
  lines.push('');
  lines.push(`📊 2X PROBABILITY: ${probPct}%`);
  lines.push(`├─ Base rate (50k→100k): ${basePct}%`);
  lines.push(`├─ Dev Score: ${devLine}`);
  lines.push(`├─ RugCheck: ${rugLine}`);
  lines.push(`├─ Holder velocity: ${holderVelocityPct >= 0 ? '+' : ''}${holderVelocityPct}% in 30min ${holderEmoji}`);
  lines.push(`├─ KOL activity: ${kolLine}`);
  lines.push(`├─ Volume vs avg: ${volumeMultiple.toFixed(1)}x ${volumeEmoji}`);
  lines.push(`└─ Liquidity: $${formatMC(liquidityUsd)} ${liqEmoji}`);
  lines.push('');
  lines.push(`⚡ Confidence: ${twoXSignal.confidence}`);
  lines.push(`🎯 Target: $100k MC (2x from here)`);
  lines.push(`🛑 Invalidation: Below $35k MC`);
  lines.push('');
  lines.push(`🔗 DexScreener: https://dexscreener.com/solana/${contractAddress}`);
  lines.push(`🔗 RugCheck: https://rugcheck.xyz/tokens/${contractAddress}`);
  lines.push(`⏱️ ${new Date().toUTCString()}`);
  lines.push(`⚠️ DYOR. Not financial advice.`);

  return lines.join('\n');
}

/**
 * Format market cap value in human-readable form
 */
function formatMC(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 'k';
  return value.toFixed(0);
}
