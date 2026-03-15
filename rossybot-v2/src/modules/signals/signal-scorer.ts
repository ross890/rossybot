import type { FullValidationResult, DexScreenerPair } from '../../types/index.js';
import type { ValidatedSignal } from './entry-engine.js';

export interface WalletEv {
  trades: number;
  winRate: number;
  avgPnl: number;
}

export interface SignalScore {
  total: number;
  breakdown: {
    walletQuality: number;   // 0-35 pts
    momentum: number;        // 0-25 pts
    mcapFit: number;         // 0-20 pts
    liquidityRatio: number;  // 0-10 pts
    confluence: number;      // 0-10 pts
  };
}

/**
 * Score a validated signal on 0-100 scale.
 * Higher = better opportunity.
 */
export function scoreSignal(
  signal: ValidatedSignal,
  walletEvs: Map<string, WalletEv>,
): SignalScore {
  const dex = signal.validation.dexData;

  const walletQuality = scoreWalletQuality(signal.walletAddresses, walletEvs);
  const momentum = scoreMomentum(dex);
  const mcapFit = scoreMcapFit(dex);
  const liquidityRatio = scoreLiquidity(dex);
  const confluence = scoreConfluence(signal.walletCount);

  const total = walletQuality + momentum + mcapFit + liquidityRatio + confluence;

  return {
    total,
    breakdown: { walletQuality, momentum, mcapFit, liquidityRatio, confluence },
  };
}

// --- Wallet Quality (0-35) ---
// Best wallets have high EV, high win rate, and enough trades for confidence
function scoreWalletQuality(addresses: string[], evMap: Map<string, WalletEv>): number {
  if (addresses.length === 0) return 0;

  let bestScore = 0;
  for (const addr of addresses) {
    const ev = evMap.get(addr);
    if (!ev) continue;

    // Confidence weight: ramp from 0.3 (new) to 1.0 (10+ trades)
    const confidence = Math.min(1.0, 0.3 + (ev.trades / 10) * 0.7);

    // Win rate component (0-15): 50% = 0, 70% = 10.5, 90% = 15
    const wrScore = Math.max(0, (ev.winRate - 0.5) * 37.5);

    // EV component (0-20): 0% = 5, 10% = 15, 20%+ = 20
    const evScore = Math.min(20, Math.max(0, 5 + ev.avgPnl));

    const walletScore = (wrScore + evScore) * confidence;
    bestScore = Math.max(bestScore, walletScore);
  }

  // If all wallets are new (no stats), give a baseline score
  if (bestScore === 0 && addresses.length > 0) {
    return 10; // Neutral — we have wallets but no track record
  }

  return Math.min(35, bestScore);
}

// --- Momentum (0-25) ---
// Sweet spot: strong 24h momentum (40-120%), not overheated
function scoreMomentum(dex: DexScreenerPair | null): number {
  if (!dex) return 5;

  const h24 = dex.priceChange?.h24 || 0;
  const h1 = dex.priceChange?.h1 || 0;

  // 24h momentum: 0% = 0, 50% = 15, 100% = 22, 200%+ = 15 (overheated penalty)
  let momentumScore: number;
  if (h24 <= 0) {
    momentumScore = 0;
  } else if (h24 <= 100) {
    momentumScore = (h24 / 100) * 22;
  } else if (h24 <= 200) {
    // Diminishing returns, slight penalty for overheated
    momentumScore = 22 - ((h24 - 100) / 100) * 7;
  } else {
    momentumScore = 15 - Math.min(10, (h24 - 200) / 100 * 5);
  }
  momentumScore = Math.max(0, momentumScore);

  // 1h recency bonus: positive recent movement is good (+3 max)
  const recencyBonus = h1 > 0 ? Math.min(3, (h1 / 20) * 3) : 0;

  return Math.min(25, momentumScore + recencyBonus);
}

// --- MCap Sweet Spot (0-20) ---
// Micro cap ideal range: $50K-$500K. Too low = risky, too high = limited upside
function scoreMcapFit(dex: DexScreenerPair | null): number {
  if (!dex) return 5;

  const mcap = dex.marketCap || dex.fdv || 0;
  if (mcap <= 0) return 0;

  // Sweet spot curve: peaks at $100K-$300K for micro tier
  if (mcap < 50_000) return 5;        // Too micro, risky
  if (mcap < 100_000) return 12;      // Getting interesting
  if (mcap <= 300_000) return 20;     // Sweet spot
  if (mcap <= 500_000) return 18;     // Still good
  if (mcap <= 1_000_000) return 14;   // Decent
  if (mcap <= 2_000_000) return 10;   // Less upside
  if (mcap <= 5_000_000) return 6;    // Marginal
  return 3;                            // Low upside for micro capital
}

// --- Liquidity Ratio (0-10) ---
// Enough liquidity relative to position = lower slippage risk
function scoreLiquidity(dex: DexScreenerPair | null): number {
  if (!dex) return 3;

  const liq = dex.liquidity?.usd || 0;
  if (liq <= 0) return 0;

  // $20K+ liq is comfortable for 0.5 SOL positions
  if (liq >= 100_000) return 10;
  if (liq >= 50_000) return 8;
  if (liq >= 20_000) return 6;
  if (liq >= 10_000) return 4;
  return 2;
}

// --- Confluence (0-10) ---
// More wallets buying = stronger signal
function scoreConfluence(walletCount: number): number {
  if (walletCount >= 4) return 10;
  if (walletCount >= 3) return 8;
  if (walletCount >= 2) return 5;
  return 2; // Single wallet (shadow mode)
}

/**
 * Format a signal score for Telegram display
 */
export function formatScoreForTelegram(score: SignalScore): string {
  const { breakdown: b } = score;
  const bar = (val: number, max: number) => {
    const filled = Math.round((val / max) * 5);
    return '█'.repeat(filled) + '░'.repeat(5 - filled);
  };

  return [
    `├ Signal Score: ${score.total.toFixed(0)}/100`,
    `│  Wallet  ${bar(b.walletQuality, 35)} ${b.walletQuality.toFixed(0)}/35`,
    `│  Moment  ${bar(b.momentum, 25)} ${b.momentum.toFixed(0)}/25`,
    `│  MCap    ${bar(b.mcapFit, 20)} ${b.mcapFit.toFixed(0)}/20`,
    `│  Liq     ${bar(b.liquidityRatio, 10)} ${b.liquidityRatio.toFixed(0)}/10`,
    `│  Conflu  ${bar(b.confluence, 10)} ${b.confluence.toFixed(0)}/10`,
  ].join('\n');
}
