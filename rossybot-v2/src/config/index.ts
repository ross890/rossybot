import { z } from 'zod';
import dotenv from 'dotenv';
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
    discoveryIntervalMs: 1 * 60 * 60 * 1000, // 1 hour
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
  minCapitalForStandardTrading: 5.0, // 5 SOL
  pumpFun: {
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    positionSizeMultiplier: 0.75,      // 75% of normal tier sizing
    staleTimeKillMins: 5,              // Exit if no movement in 5 min (curve fills are fast or DOA)
    stopLoss: -0.20,                   // 20% stop loss
    hardKill: -0.25,                   // 25% hard kill
    // --- Curve scalp strategy: exit BEFORE graduation ---
    curveProfitTarget: 0.75,           // Sell when curve hits 75% filled
    curveHardExit: 0.85,              // Force-exit at 85% — NEVER hold through graduation
    graduationSellPct: 100,            // Sell 100% on any graduation (no lottery holds)
    minConvictionSol: 1.0,             // Alpha must spend ≥1.0 SOL
    minCurveVelocity: 0.1,            // 0.1 SOL/min curve velocity
    maxTokenAgeMins: 15,               // Only tokens <15min old (was 30 — tighter, curve plays resolve fast)
    maxPositions: 3,                   // Max 3 pump.fun positions
    slippageBps: 500,                  // 5% slippage for bonding curve
    confluenceBonus: true,             // Track multi-wallet convergence on same token
  },
} as const;

// --- Capital Tier Configurations ---

export const TIER_CONFIGS: Record<CapitalTier, TierConfig> = {
  [CapitalTier.MICRO]: {
    tier: CapitalTier.MICRO,
    maxPositions: 4,
    walletsMonitored: 50,
    positionSizePct: 0.30,            // 30% per position (was 25% — small capital needs more concentration)
    minPositionSol: 0.003,            // 0.003 SOL min (was 0.3 — bot couldn't trade with 0.025 SOL balance)
    profitTarget: 0.40,                // 40% TP (was 50% — take profits slightly earlier)
    stopLoss: -0.20,                  // 20% stop (was 15% — less whipsaw on volatile micro-caps)
    hardKill: -0.25,                  // 25% hard kill (was 20% — give more room before force-exit)
    partialExitsEnabled: false,
    walletConfluenceRequired: 1,
    confluenceWindow: 30,
    timeKills: [
      { hours: 1, minPnlPct: -0.05 },  // Cut losers at 1h (was 2h — memecoins resolve fast)
      { hours: 2, minPnlPct: 0.10 },   // Must be +10% by 2h (was 4h/+15% — tighter)
      { hours: 6, minPnlPct: 0.20 },   // Must be +20% by 6h (was 12h/+25% — don't hold overnight)
    ],
    hardTimeHours: 12,                // 12h hard cap (was 48h — memecoins are fast, don't hold bags)
    mcapMin: 30_000,
    mcapMax: 10_000_000,
    liquidityMin: 5_000,              // $5K min (was $10K — micro-cap tokens often have lower liq)
    momentumWindow: '24h',
    momentumMin: -50,
    momentumMax: 300,
    volumeMultiplierMin: 1,
    tokenMaxAgeDays: 14,              // 14 days max age (was 30 — stale tokens less interesting)
    minSignalScore: 45,               // Raised from 35 — filter out low-quality signals
  },
  [CapitalTier.SMALL]: {
    tier: CapitalTier.SMALL,
    maxPositions: 3,
    walletsMonitored: 5,
    positionSizePct: 0.40,
    minPositionSol: 0.3,
    profitTarget: 0.40,
    stopLoss: -0.20,
    hardKill: -0.25,
    partialExitsEnabled: false,
    walletConfluenceRequired: 1,
    confluenceWindow: 30,
    timeKills: [
      { hours: 1, minPnlPct: 0.05 },
      { hours: 4, minPnlPct: 0.15 },
      { hours: 12, minPnlPct: 0.25 },
    ],
    hardTimeHours: 48,
    mcapMin: 200_000,
    mcapMax: 2_000_000,
    liquidityMin: 30_000,
    momentumWindow: '24h',
    momentumMin: -50,
    momentumMax: 200,
    volumeMultiplierMin: 1,
    tokenMaxAgeDays: 30,
    minSignalScore: 35,
  },
  [CapitalTier.MEDIUM]: {
    tier: CapitalTier.MEDIUM,
    maxPositions: 5,
    walletsMonitored: 10,
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
    mcapMin: 100_000,
    mcapMax: 10_000_000,
    liquidityMin: 75_000,
    momentumWindow: '6h',
    momentumMin: -50,
    momentumMax: 80,
    volumeMultiplierMin: 1,
    tokenMaxAgeDays: null,
    minSignalScore: 45,
  },
  [CapitalTier.FULL]: {
    tier: CapitalTier.FULL,
    maxPositions: 5,
    walletsMonitored: 20,
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
    mcapMin: 100_000,
    mcapMax: 50_000_000,
    liquidityMin: 50_000,
    momentumWindow: '6h',
    momentumMin: -50,
    momentumMax: 80,
    volumeMultiplierMin: 1,
    tokenMaxAgeDays: null,
    minSignalScore: 50,
  },
};

// Seed wallets
export const SEED_WALLETS = [
  { address: '7Z5VhcNSpMpaTVqRg8QTkySw6syfcTehTx8CqRPvf9bg', label: 'nansen_smart_1', minTier: CapitalTier.MICRO },
  { address: '2sqTwLCEqKxmyUq79HVL4bwS6QjvfMtnqnZznLFmwJMi', label: 'nansen_349roi', minTier: CapitalTier.MICRO },
  { address: '5MigbXPuoCBzzDXBHMxRKudWmby4BVDQckZLAB6ti1RF', label: 'nansen_sniper', minTier: CapitalTier.MICRO },
  { address: 'raTD4azgmsFHVWe4qrRhhSbgiUVtgbWYEMgXKzNX6FK', label: 'nansen_sniper_2', minTier: CapitalTier.SMALL },
  { address: 'FUHyQNZ4bLZF7f4EfrxcKHfh9u7uz98ALvvMAKMj4QBo', label: 'nansen_realizer', minTier: CapitalTier.SMALL },
  { address: '7iRo63BzGA3BoXyNhrhR3WNzBzRN1WP4bDik4Q5t9fDR', label: 'nansen_okc', minTier: CapitalTier.MEDIUM },
  { address: 'DP4QTfM8HUvUP8hHXuGpTinoJYrYV6XhuFLPP3EYrChq', label: 'nansen_active_1', minTier: CapitalTier.MEDIUM },
  { address: 'AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51', label: 'alpha_big_conviction', minTier: CapitalTier.MICRO },
];

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
    maxPositions: 20,         // 20 concurrent (was 2)
    mcapMin: 50_000,          // $50K (was $200K)
    mcapMax: 10_000_000,      // $10M (was $2M) — $30M+ is noise at micro capital
    liquidityMin: 5_000,      // $5K (was $20K)
    momentumMin: -60,           // allow deeper dips in shadow mode for data collection
    momentumMax: 500,         // up to 500% (was 200%)
    volumeMultiplierMin: 1,   // 1x (was 2x)
    tokenMaxAgeDays: null,    // no age limit (was 30d)
  };
}
