import type { FullValidationResult, DexScreenerPair } from '../../types/index.js';
import type { ValidatedSignal } from './entry-engine.js';

export interface WalletEv {
  trades: number;
  winRate: number;
  avgPnl: number;
  nansenRoi: number;
  nansenTrades: number;
  nansenPnlUsd: number;
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
  walletRejected: boolean; // true if best wallet fails hard quality floor
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

  const walletResult = scoreWalletQuality(signal.walletAddresses, walletEvs);
  const momentum = scoreMomentum(dex);
  const mcapFit = scoreMcapFit(dex);
  const liquidityRatio = scoreLiquidity(dex);
  const confluence = scoreConfluence(signal.walletCount);

  const total = walletResult.score + momentum + mcapFit + liquidityRatio + confluence;

  return {
    total,
    breakdown: {
      walletQuality: walletResult.score,
      momentum,
      mcapFit,
      liquidityRatio,
      confluence,
    },
    walletRejected: walletResult.rejected,
  };
}

// --- Wallet Quality (0-35) ---
// Uses our trade data when available, falls back to Nansen data for unproven wallets.
// Hard floor: blended win rate must be >= 50% and blended avg PnL >= 25%.
function scoreWalletQuality(
  addresses: string[],
  evMap: Map<string, WalletEv>,
): { score: number; rejected: boolean } {
  if (addresses.length === 0) return { score: 0, rejected: true };

  let bestScore = 0;
  let anyWalletPassesFloor = false;

  for (const addr of addresses) {
    const ev = evMap.get(addr);
    if (!ev) continue;

    // Blend our data with Nansen data.
    // If we have 5+ of our own trades, trust our data fully.
    // Otherwise, blend with Nansen stats weighted by how few of our trades we have.
    const ourWeight = Math.min(1.0, ev.trades / 5);
    const nansenWeight = 1.0 - ourWeight;

    // Estimate Nansen win rate from ROI: ROI > 100% maps to ~0.65 WR, > 500% to ~0.80
    const nansenEstWinRate = ev.nansenTrades > 0
      ? Math.min(0.85, 0.50 + Math.max(0, ev.nansenRoi) / 1000)
      : 0;
    // Nansen avg PnL: use ROI / trade count as rough per-trade avg, capped
    const nansenEstAvgPnl = ev.nansenTrades > 0
      ? Math.min(50, Math.max(0, ev.nansenRoi / Math.max(1, ev.nansenTrades)))
      : 0;

    const blendedWinRate = ourWeight * ev.winRate + nansenWeight * nansenEstWinRate;
    const blendedAvgPnl = ourWeight * ev.avgPnl + nansenWeight * nansenEstAvgPnl;

    // Hard floor: 50% win rate AND 25% avg PnL (blended)
    // For wallets with 0 of our trades, Nansen data must be strong enough
    if (blendedWinRate >= 0.50 && blendedAvgPnl >= 25) {
      anyWalletPassesFloor = true;
    }

    // Confidence: ramp from 0.3 (no our trades, Nansen only) to 1.0 (10+ our trades)
    // Nansen trades provide a smaller confidence boost
    const nansenConfBoost = Math.min(0.2, (ev.nansenTrades / 50) * 0.2);
    const confidence = Math.min(1.0, 0.3 + (ev.trades / 10) * 0.7 + nansenConfBoost);

    // Win rate component (0-15): 50% = 0, 70% = 10.5, 90% = 15
    const wrScore = Math.max(0, (blendedWinRate - 0.5) * 37.5);

    // EV component (0-20): 0% = 5, 10% = 15, 20%+ = 20
    const evScore = Math.min(20, Math.max(0, 5 + blendedAvgPnl));

    const walletScore = (wrScore + evScore) * confidence;
    bestScore = Math.max(bestScore, walletScore);
  }

  return {
    score: Math.min(35, bestScore),
    rejected: !anyWalletPassesFloor,
  };
}

// --- Momentum (0-25) ---
// Scores both upward momentum AND dip-buying opportunities using buy ratio context.
// Buy ratio = h24 buys / (buys + sells). High buy ratio on a dip = smart accumulation.
function scoreMomentum(dex: DexScreenerPair | null): number {
  if (!dex) return 0; // No data = no free points

  const h24 = dex.priceChange?.h24 || 0;
  const h1 = dex.priceChange?.h1 || 0;

  // Buy ratio from transaction counts
  const txns = dex.txns?.h24;
  const totalTxns = (txns?.buys ?? 0) + (txns?.sells ?? 0);
  const buyRatio = totalTxns > 0 ? (txns?.buys ?? 0) / totalTxns : 0.5;

  let momentumScore: number;

  if (h24 >= 0) {
    // --- Positive momentum (unchanged logic) ---
    if (h24 <= 100) {
      momentumScore = (h24 / 100) * 22;
    } else if (h24 <= 200) {
      momentumScore = 22 - ((h24 - 100) / 100) * 7;
    } else {
      momentumScore = 15 - Math.min(10, (h24 - 200) / 100 * 5);
    }
  } else {
    // --- Negative momentum: score based on dip severity + buy ratio ---
    // A dip with heavy buying = accumulation opportunity
    // A dip with heavy selling = capitulation, avoid

    if (buyRatio >= 0.50) {
      // Accumulation: buyers active despite price drop — reward this
      if (h24 >= -5) {
        // Tiny pullback with buyers: 8-10 pts
        momentumScore = 8 + buyRatio * 4; // 8-10
      } else if (h24 >= -25) {
        // Moderate dip with accumulation: 5-8 pts
        const dipDepth = Math.abs(h24) / 25; // 0-1 normalized
        momentumScore = 8 - dipDepth * 3;    // 8 → 5
        // Extra reward for very high buy ratio (smart money conviction)
        if (buyRatio >= 0.60) momentumScore += 2;
      } else {
        // Deep dip (-25% to -50%) with buyers still active: 3-5 pts
        const dipDepth = Math.min(1, (Math.abs(h24) - 25) / 25);
        momentumScore = 5 - dipDepth * 2;    // 5 → 3
        if (buyRatio >= 0.55) momentumScore += 1;
      }
    } else if (buyRatio >= 0.40) {
      // Mixed: roughly equal buys and sells — cautious score
      momentumScore = Math.max(0, 3 - Math.abs(h24) / 20);
    } else {
      // Capitulation: sells dominating — no points
      momentumScore = 0;
    }
  }

  momentumScore = Math.max(0, momentumScore);

  // 1h recency bonus: positive recent movement is good (+3 max)
  const recencyBonus = h1 > 0 ? Math.min(3, (h1 / 20) * 3) : 0;

  return Math.min(25, momentumScore + recencyBonus);
}

// --- MCap Sweet Spot (0-20) ---
// Micro cap ideal range: $50K-$500K. Too low = risky, too high = limited upside
function scoreMcapFit(dex: DexScreenerPair | null): number {
  if (!dex) return 0; // No data = no free points

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
  if (!dex) return 0; // No data = no free points

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
