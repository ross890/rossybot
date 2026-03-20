import { z } from 'zod';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CapitalTier, type TierConfig } from '../types/index.js';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string(),
  HELIUS_API_KEY: z.string(),
  HELIUS_RPC_URL: z.string().optional(),
  HELIUS_WS_URL: z.string().optional(),
  NANSEN_API_KEY: z.string(),
  WALLET_PRIVATE_KEY: z.string().optional().default(''),
  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_CHAT_ID: z.string(),
  JUPITER_API_URL: z.string().default('https://api.jup.ag/swap/v1'),
  JUPITER_API_KEY: z.string().optional().default(''),
  SHADOW_MODE: z.string().default('false'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Missing environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  database: {
    url: env.DATABASE_URL,
  },
  helius: {
    apiKey: env.HELIUS_API_KEY,
    rpcUrl: env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`,
    wsUrl: env.HELIUS_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`,
    pingIntervalMs: 30_000,
    pongTimeoutMs: 10_000,
    staleTimeoutMs: 1_800_000, // 30 minutes — wallets may not trade for hours
    maxReconnectAttempts: 5,
    reconnectDelays: [1000, 2000, 5000, 10000, 30000],
    fallbackPollIntervalMs: 15_000,
  },
  nansen: {
    apiKey: env.NANSEN_API_KEY,
    baseUrl: 'https://api.nansen.ai/v1',
    maxCallsPerMin: 80,
    discoveryIntervalMs: 15 * 60 * 1000, // 15 min (was 30min — more frequent discovery = more wallets found)
    flowMonitorIntervalMs: 2 * 60 * 60 * 1000, // 2 hours
    screenerIntervalMs: 5 * 60 * 1000, // 5 min
    leaderboardIntervalMs: 15 * 60 * 1000, // 15 min
  },
  wallet: {
    privateKey: env.WALLET_PRIVATE_KEY,
  },
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
  },
  jupiter: {
    apiUrl: env.JUPITER_API_URL,
    apiKey: env.JUPITER_API_KEY,
    defaultSlippageBps: 150, // 1.5%
    thinLiquiditySlippageBps: 300, // 3%
    maxRetries: 1,
  },
  shadowMode: env.SHADOW_MODE === 'true',
  dexScreener: {
    baseUrl: 'https://api.dexscreener.com/latest/dex',
    priceCheckIntervalMs: 10_000, // 10 seconds
  },
  rugCheck: {
    baseUrl: 'https://api.rugcheck.xyz/v1',
  },
  dailyLossLimitPct: 0.30, // 30%
  // Minimum SOL balance before standard V2 (migrated/Raydium) trading unlocks.
  // Below this, only pump.fun bonding curve trades are executed — faster compounding with small capital.
  minCapitalForStandardTrading: 0.5, // 0.5 SOL (was 5 — need DEX trades for data even at low capital)
  pumpFun: {
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    positionSizeMultiplier: 1.20,      // 120% of normal tier sizing — tighter entry/exit controls justify bigger bets
    staleTimeKillMins: 0.75,           // Exit if no movement in 45s (was 60s — stalls at 30%+ are dead weight, data shows 23min stalls slipping through)
    profitTarget: 0.10,                 // 10% PnL take profit (realistic for curve scalps)
    stopLoss: -0.10,                   // 10% stop loss (was -15% — data shows SLs firing at -25% due to check delay, tighter SL = -12-15% actual)
    hardKill: -0.15,                   // 15% hard kill (was -20% — matches old SL, absolute floor)
    // --- Curve scalp strategy: DEFERRED ENTRY (don't enter at alpha's entry, wait for momentum) ---
    // Data (532t): 0-30% = -4.38◎ (death zone). 30-35% = 31%WR (best). 35%+ = 31-36%WR.
    // Curve TP exits show LOSSES because sqrt PnL estimate >> actual swap output after slippage+fees.
    // Strategy: enter at 30%+, TP earlier (36%), gate on velocity, tighter SL to limit damage.
    curveProfitTarget: 0.36,           // Sell at 36% curve fill (unchanged — tokens stall at 30-35%, take profit here)
    curveHardExit: 0.45,              // Force-exit at 45% (unchanged — pre-graduation safety valve)
    curveEntryMin: 0.33,              // MINIMUM 33% curve fill (30-35% zone: 31%WR but -1.37 SOL net — 33%+ captures the stronger half)
    curveEntryMax: 0.38,              // Maximum 38% curve fill — above this no room for TP
    curveVelocityMin: 0.5,            // Minimum 0.5 SOL/min velocity to enter (filter stalling tokens)
    graduationSellPct: 100,            // Sell 100% on any graduation (no lottery holds)
    minConvictionSol: 1.25,            // Alpha must spend ≥1.25 SOL (was 0.75 — data: tiny buys <1 SOL = spray/noise, big losses)
    minCurveVelocity: 0.1,            // 0.1 SOL/min curve velocity (legacy — curveVelocityMin is the active check)
    maxTokenAgeMins: 10,               // Only tokens <10min old (curve scalps resolve in 2-5min, stale tokens = stalls)
    maxPositions: 2,                   // Max 2 pump.fun positions (was 3 — fewer = more capital focus, faster exits)
    slippageBps: 400,                  // 4% slippage (was 5% — 5% eats entire TP profit, tighter preserves gains)
    confluenceBonus: true,             // Track multi-wallet convergence on same token
    // --- Deferred entry watchlist ---
    deferredEntryEnabled: false,        // DISABLED — 8 trades, 0% WR, -0.83 SOL. Deferred entries consistently lose.
    deferredEntryMaxWaitMs: 2 * 60_000, // Max 2 min to wait (moot while disabled)
  },
  // --- Graduation Bounce Discovery ---
  // Monitors freshly graduated pump.fun tokens for the post-graduation dip/recovery pattern.
  // Thesis: tokens dump 30-60% after graduation, then bounce 50-200% as new buyers enter.
  graduationDiscovery: {
    enabled: true,
    // --- Detection ---
    maxMonitored: 50,                    // Max tokens to monitor simultaneously
    priceCheckIntervalMs: 15_000,        // Check prices every 15s (DexScreener rate-friendly)
    monitorWindowMins: 60,               // Monitor for up to 60 min post-graduation
    // --- Graduation filters ---
    minGraduationMcap: 30_000,           // $30K min mcap at graduation (most are ~$69K)
    minGraduationLiquidity: 5_000,       // $5K min liquidity
    // --- Dip/Recovery signal thresholds ---
    minDipPct: 0.25,                     // Must dip at least 25% from graduation price
    minRecoveryPct: 0.15,               // Must bounce at least 15% from the bottom
    minStabilityChecks: 2,               // 2 consecutive stable/rising price checks (~30s)
    minBuyRatio: 0.45,                   // At least 45% of txns are buys (not still dumping)
    minTimeSinceGradMins: 3,             // Wait at least 3 min after graduation (let the initial dump play out)
    // --- Entry gate ---
    minEntryMcap: 20_000,               // $20K min mcap at entry (post-dip, may be lower than graduation)
    minEntryLiquidity: 5_000,            // $5K min liquidity at entry
    // --- Position management ---
    maxPositions: 2,                     // Max 2 concurrent graduation bounce positions
    positionSizeMultiplier: 0.80,        // 80% of normal tier sizing (higher risk than alpha-led trades)
    profitTarget: 0.50,                  // 50% take profit (graduated tokens can run big)
    stopLoss: -0.20,                     // 20% stop loss
    hardKill: -0.30,                     // 30% hard kill
    trailingActivationPct: 0.25,         // Activate trailing stop at +25%
    trailingStopPct: 0.15,              // Trail by 15% from peak (sell if drops 15% from highest PnL)
    staleTimeMins: 30,                   // Cut if still losing after 30 min
    hardTimeHours: 4,                    // 4h max hold (graduation bounces resolve within hours)
    slippageBps: 300,                    // 3% slippage (freshly graduated = thin liquidity)
  },
} as const;

// --- Capital Tier Configurations ---

export const TIER_CONFIGS: Record<CapitalTier, TierConfig> = {
  [CapitalTier.MICRO]: {
    tier: CapitalTier.MICRO,
    maxPositions: 5,                   // 5 max (was 3 — need more concurrent trades for data collection)
    walletsMonitored: 15,
    positionSizePct: 0.15,            // 15% per position (was 25% — more positions = smaller each, 5×15%=75%)
    minPositionSol: 0.003,
    profitTarget: 0.40,
    stopLoss: -0.20,
    hardKill: -0.25,
    partialExitsEnabled: false,
    walletConfluenceRequired: 1,
    confluenceWindow: 30,
    timeKills: [
      { hours: 1, minPnlPct: -0.05 },
      { hours: 2, minPnlPct: 0.10 },
      { hours: 6, minPnlPct: 0.20 },
    ],
    hardTimeHours: 12,
    momentumExtensionEnabled: true,
    momentumExtensionHours: 1,
    momentumExtensionMaxPerWindow: 1,
    momentumExtensionMinPnl: -0.02,
    mcapMin: 10_000,                   // $10K min (was $30K — catch early tokens with low mcap)
    mcapMax: 15_000_000,               // $15M max (was $10M — wider net)
    liquidityMin: 2_000,              // $2K min (was $5K — micro positions can exit thin pools)
    momentumWindow: '24h',
    momentumMin: -60,                  // -60% (was -50% — allow deeper dip buys)
    momentumMax: 500,                  // +500% (was +300% — don't reject hot runners, data is data)
    volumeMultiplierMin: 0.5,          // 0.5x (was 1x — less restrictive volume gate)
    tokenMaxAgeDays: null,             // No age limit (was 14 — older tokens can have renewed interest)
    minSignalScore: 20,               // 20 (was 35 — cast much wider net for data collection)
    reentryEnabled: true,
    reentryCooldownMins: 15,
    reentryMaxPerToken: 1,
    reentrySizeMultiplier: 0.60,
  },
  [CapitalTier.SMALL]: {
    tier: CapitalTier.SMALL,
    maxPositions: 5,                   // 5 max (was 3 — more positions for data)
    walletsMonitored: 35,
    positionSizePct: 0.12,            // 12% per position (was 20% — 5×12%=60%, room for pump.fun too)
    minPositionSol: 0.15,              // 0.15 SOL min (was 0.3 — allow smaller bets to get more trades on)
    profitTarget: 0.40,
    stopLoss: -0.20,
    hardKill: -0.25,
    partialExitsEnabled: false,
    walletConfluenceRequired: 1,
    confluenceWindow: 30,
    timeKills: [
      { hours: 1, minPnlPct: -0.05 },
      { hours: 2, minPnlPct: 0.10 },
      { hours: 6, minPnlPct: 0.20 },
    ],
    hardTimeHours: 24,
    momentumExtensionEnabled: true,
    momentumExtensionHours: 1,
    momentumExtensionMaxPerWindow: 1,
    momentumExtensionMinPnl: -0.02,
    mcapMin: 15_000,                   // $15K min (was $50K — catch earlier)
    mcapMax: 15_000_000,               // $15M max (was $5M — wider net)
    liquidityMin: 3_000,              // $3K min (was $15K — small positions can handle thin pools)
    momentumWindow: '24h',
    momentumMin: -60,                  // -60% (was -50%)
    momentumMax: 500,                  // +500% (was +200% — don't reject runners)
    volumeMultiplierMin: 0.5,          // 0.5x (was 1x)
    tokenMaxAgeDays: null,             // No age limit (was 30)
    minSignalScore: 20,               // 20 (was 35 — much wider net for data)
    reentryEnabled: true,
    reentryCooldownMins: 15,
    reentryMaxPerToken: 1,
    reentrySizeMultiplier: 0.60,
  },
  [CapitalTier.MEDIUM]: {
    tier: CapitalTier.MEDIUM,
    maxPositions: 5,
    walletsMonitored: 20,              // 20 WS slots (was 10 — more capital = broader coverage)
    positionSizePct: 0.15,
    minPositionSol: 0.3,
    profitTarget: 0.30,
    stopLoss: -0.15,
    hardKill: -0.20,
    partialExitsEnabled: true,
    walletConfluenceRequired: 2,
    confluenceWindow: 60,
    timeKills: [
      { hours: 1, minPnlPct: 0.05 },
      { hours: 4, minPnlPct: 0.15 },
    ],
    hardTimeHours: 48,
    momentumExtensionEnabled: true,
    momentumExtensionHours: 2,        // MEDIUM: extend by 2h (larger positions need more room)
    momentumExtensionMaxPerWindow: 2, // Max 2 extensions per window
    momentumExtensionMinPnl: 0.0,     // Must be breakeven or better
    mcapMin: 100_000,
    mcapMax: 10_000_000,
    liquidityMin: 75_000,
    momentumWindow: '6h',
    momentumMin: -50,
    momentumMax: 80,
    volumeMultiplierMin: 1,
    tokenMaxAgeDays: null,
    minSignalScore: 45,
    reentryEnabled: true,
    reentryCooldownMins: 30,           // 30 min cooldown for MEDIUM
    reentryMaxPerToken: 1,
    reentrySizeMultiplier: 0.50,       // 50% size on re-entry (more cautious with bigger positions)
  },
  [CapitalTier.FULL]: {
    tier: CapitalTier.FULL,
    maxPositions: 5,
    walletsMonitored: 30,              // 30 WS slots (was 20 — max coverage for large capital)
    positionSizePct: 0.10,
    minPositionSol: 0.3,
    profitTarget: 0.25,
    stopLoss: -0.15,
    hardKill: -0.20,
    partialExitsEnabled: true,
    walletConfluenceRequired: 1,
    confluenceWindow: 60,
    timeKills: [
      { hours: 1, minPnlPct: 0.05 },
      { hours: 4, minPnlPct: 0.15 },
      { hours: 12, minPnlPct: 0.25 },
    ],
    hardTimeHours: 48,
    momentumExtensionEnabled: true,
    momentumExtensionHours: 2,
    momentumExtensionMaxPerWindow: 2,
    momentumExtensionMinPnl: 0.0,
    mcapMin: 100_000,
    mcapMax: 50_000_000,
    liquidityMin: 50_000,
    momentumWindow: '6h',
    momentumMin: -50,
    momentumMax: 80,
    volumeMultiplierMin: 1,
    tokenMaxAgeDays: null,
    minSignalScore: 50,
    reentryEnabled: true,
    reentryCooldownMins: 30,
    reentryMaxPerToken: 1,
    reentrySizeMultiplier: 0.50,
  },
};

// Seed wallets — loaded from wallets.json (edit that file to add/remove wallets)
export type SeedWallet = {
  address: string;
  label: string;
  minTier: CapitalTier;
  pumpfunOnly?: boolean;
};

function loadSeedWallets(): SeedWallet[] {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const walletsPath = resolve(__dirname, '../../wallets.json');
  try {
    const raw = JSON.parse(readFileSync(walletsPath, 'utf-8'));
    const tierMap: Record<string, CapitalTier> = {
      MICRO: CapitalTier.MICRO,
      SMALL: CapitalTier.SMALL,
      MEDIUM: CapitalTier.MEDIUM,
      FULL: CapitalTier.FULL,
    };
    return (raw.wallets || []).map((w: { address: string; label: string; minTier: string; pumpfunOnly?: boolean }) => ({
      address: w.address,
      label: w.label,
      minTier: tierMap[w.minTier] ?? CapitalTier.MICRO,
      pumpfunOnly: w.pumpfunOnly ?? false,
    }));
  } catch (err) {
    console.error(`Failed to load wallets.json from ${walletsPath}:`, err);
    return [];
  }
}

export const SEED_WALLETS: SeedWallet[] = loadSeedWallets();

export function getTierForCapital(capitalSol: number): CapitalTier {
  if (capitalSol >= 50) return CapitalTier.FULL;
  if (capitalSol >= 10) return CapitalTier.MEDIUM;
  if (capitalSol >= 3) return CapitalTier.SMALL;
  return CapitalTier.MICRO;
}

export function getTierConfig(tier: CapitalTier): TierConfig {
  const base = TIER_CONFIGS[tier];
  if (!config.shadowMode) return base;

  // Shadow mode: loosen thresholds but still enforce gates
  return {
    ...base,
    walletsMonitored: 75,      // Max WS coverage in shadow mode for data collection (was 50 — more slots = more signals)
    maxPositions: 20,         // 20 concurrent — shadow mode is data collection, not risk-managed
    positionSizePct: 0.10,    // 10% per shadow position (was 5% — user wants 0.5-1 SOL bids for bigger wins)
    minSignalScore: 15,       // 15 — shadow mode = max data collection, score is informational only
    mcapMin: 10_000,          // $10K — match relaxed MICRO min
    mcapMax: 15_000_000,      // $15M
    liquidityMin: 2_000,      // $2K — match relaxed MICRO min
    momentumMin: -70,           // allow deep dips
    momentumMax: 1000,        // up to 1000%
    volumeMultiplierMin: 0.3, // 0.3x — very loose
    tokenMaxAgeDays: null,    // no age limit
  };
}
