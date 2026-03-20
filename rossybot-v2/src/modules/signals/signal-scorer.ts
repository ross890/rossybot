import type { FullValidationResult, DexScreenerPair } from '../../types/index.js';
import type { ValidatedSignal } from './entry-engine.js';

export interface WalletEv {
  trades: number;
  winRate: number;
  avgPnl: number;
  nansenRoi: number;
  nansenTrades: number;
  nansenPnlUsd: number;
  tier: string;           // 'A' (proven quick-flipper) or 'B' (standard)
  shortTermAlpha: number; // 0-100 alpha score from hold-time analysis
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
// Soft floor: wallets below quality thresholds get a penalty multiplier (not binary rejection).
// Only truly terrible wallets (<30% WR AND <5% PnL) trigger hard rejection.
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
    // Also infer from PnL USD when trade count is missing (seed wallets with backfilled data)
    const hasNansenData = ev.nansenTrades > 0 || ev.nansenPnlUsd > 0;
    const nansenEstWinRate = hasNansenData
      ? Math.min(0.85, 0.50 + Math.max(0, ev.nansenRoi) / 1000)
      : 0;

    // Nansen avg PnL estimate: use ROI when available, but also factor in absolute PnL.
    // A wallet with $201K PnL but 1% ROI is a high-volume profitable trader — don't penalize for low ROI.
    // sqrt(27) * 3 = 15.6%, sqrt(100) * 3 = 30%, sqrt(500) * 3 = 50% (capped)
    const nansenRoiEstPnl = ev.nansenRoi > 0
      ? Math.min(50, Math.sqrt(ev.nansenRoi) * 3)
      : 0;
    // PnL USD floor: $100K+ → 25%, $50K+ → 20%, $20K+ → 15%, $5K+ → 10%
    const nansenPnlFloor = ev.nansenPnlUsd >= 100_000 ? 25
      : ev.nansenPnlUsd >= 50_000 ? 20
      : ev.nansenPnlUsd >= 20_000 ? 15
      : ev.nansenPnlUsd >= 5_000 ? 10
      : 0;
    const nansenEstAvgPnl = Math.max(nansenRoiEstPnl, nansenPnlFloor);

    const blendedWinRate = ourWeight * ev.winRate + nansenWeight * nansenEstWinRate;
    const blendedAvgPnl = ourWeight * ev.avgPnl + nansenWeight * nansenEstAvgPnl;

    // Soft floor: penalty multiplier for wallets below quality thresholds.
    // Relaxed further — new wallets with Nansen data should be able to enter.
    let floorPenalty = 1.0;
    if (blendedWinRate < 0.35) {
      floorPenalty *= Math.max(0.6, blendedWinRate / 0.35);
    }
    if (blendedAvgPnl < 5) {
      floorPenalty *= Math.max(0.6, blendedAvgPnl / 5);
    }

    // Hard reject only for truly terrible wallets:
    // - <30% WR AND <5% avg PnL → reject (was 40%/10% — too strict, killing unproven wallets)
    // - Alpha score <10 with 5+ trades → reject (need more data before rejecting on alpha score)
    const meetsQuality = blendedWinRate >= 0.30 || blendedAvgPnl >= 5;
    const failsAlpha = ev.shortTermAlpha < 10 && ev.trades >= 5;
    if (meetsQuality && !failsAlpha) {
      anyWalletPassesFloor = true;
    }

    // Confidence: ramp from 0.4 (no our trades, Nansen only) to 1.0 (10+ our trades)
    // Nansen data provides a confidence boost based on trades AND PnL USD.
    // High-PnL wallets ($50K+) are Nansen-verified profitable — trust them more even with 0 our-trades.
    const nansenTradeBoost = Math.min(0.15, (ev.nansenTrades / 50) * 0.15);
    const nansenPnlBoost = ev.nansenPnlUsd >= 100_000 ? 0.20
      : ev.nansenPnlUsd >= 50_000 ? 0.15
      : ev.nansenPnlUsd >= 20_000 ? 0.10
      : ev.nansenPnlUsd >= 5_000 ? 0.05
      : 0;
    const confidence = Math.min(1.0, 0.4 + (ev.trades / 10) * 0.6 + nansenTradeBoost + nansenPnlBoost);

    // Win rate component (0-15): 50% = 0, 70% = 10.5, 90% = 15
    const wrScore = Math.max(0, (blendedWinRate - 0.5) * 37.5);

    // EV component (0-20): 0% = 5, 10% = 15, 20%+ = 20
    const evScore = Math.min(20, Math.max(0, 5 + blendedAvgPnl));

    // Base score with confidence and soft floor
    let walletScore = (wrScore + evScore) * confidence * floorPenalty;

    // Tier A bonus: proven quick-flippers with >40 alpha score get +3
    if (ev.tier === 'A' && ev.shortTermAlpha > 40) {
      walletScore += 3;
    }

    // PnL USD bonus: wallets with significant realized PnL get a bump
    // Nansen-verified profitable traders deserve credit even with low ROI %
    if (ev.nansenPnlUsd >= 100_000) {
      walletScore += 4;
    } else if (ev.nansenPnlUsd >= 50_000) {
      walletScore += 3;
    } else if (ev.nansenPnlUsd >= 20_000) {
      walletScore += 2;
    } else if (ev.nansenPnlUsd >= 5_000) {
      walletScore += 1;
    }

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
// Micro cap ideal range: $30K-$500K — aligned with MICRO tier mcapMin of $30K
function scoreMcapFit(dex: DexScreenerPair | null): number {
  if (!dex) return 0; // No data = no free points

  const mcap = dex.marketCap || dex.fdv || 0;
  if (mcap <= 0) return 0;

  // Sweet spot curve: peaks at $30K-$300K for micro tier
  // $30K-$100K is where the biggest moves happen (2-10x potential)
  if (mcap < 30_000) return 5;        // Below tier minimum, risky
  if (mcap < 100_000) return 18;      // Early micro — high upside (was 12 at $50K-$100K)
  if (mcap <= 300_000) return 20;     // Sweet spot
  if (mcap <= 500_000) return 16;     // Still good
  if (mcap <= 1_000_000) return 12;   // Decent
  if (mcap <= 2_000_000) return 8;    // Less upside
  if (mcap <= 5_000_000) return 5;    // Marginal
  return 2;                            // Low upside for micro capital
}

// --- Liquidity Ratio (0-10) ---
// Enough liquidity relative to position = lower slippage risk
// Adjusted for MICRO tier — trading with <1 SOL, lower liq is acceptable
function scoreLiquidity(dex: DexScreenerPair | null): number {
  if (!dex) return 0; // No data = no free points

  const liq = dex.liquidity?.usd || 0;
  if (liq <= 0) return 0;

  // At MICRO tier (0.003-0.3 SOL positions), even $5K liq is fine
  if (liq >= 100_000) return 10;
  if (liq >= 50_000) return 9;
  if (liq >= 20_000) return 8;
  if (liq >= 10_000) return 7;
  if (liq >= 5_000) return 5;         // $5K is new liquidityMin — give decent score
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
