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
    positionSizeMultiplier: 1.20,      // 120% of normal tier sizing — tighter entry/exit controls justify bigger bets
    staleTimeKillMins: 1.5,            // Exit if no movement in 90s (was 3min — data shows avg hold is 2min, stalls resolve faster)
    profitTarget: 0.10,                 // 10% PnL take profit (realistic for curve scalps)
    stopLoss: -0.15,                   // 15% stop loss (tighter — cut losers fast)
    hardKill: -0.20,                   // 20% hard kill
    // --- Curve scalp strategy: DEFERRED ENTRY (don't enter at alpha's entry, wait for momentum) ---
    curveProfitTarget: 0.40,           // Sell when curve hits 40% filled (was 30% — now entering higher, need room to TP)
    curveHardExit: 0.50,              // Force-exit at 50% (was 45% — adjusted for higher entry)
    curveEntryMin: 0.28,              // MINIMUM 28% curve fill to enter — below this is 1-11% WR death zone
    curveEntryMax: 0.38,              // Maximum 38% curve fill — above this no room for TP
    curveVelocityMin: 0.3,            // Minimum 0.3 SOL/min curve growth rate to confirm momentum
    graduationSellPct: 100,            // Sell 100% on any graduation (no lottery holds)
    minConvictionSol: 0.50,            // Alpha must spend ≥0.50 SOL — raised to filter throwaway buys causing -100% wipeouts
    minCurveVelocity: 0.1,            // 0.1 SOL/min curve velocity (legacy — curveVelocityMin is the active check)
    maxTokenAgeMins: 15,               // Only tokens <15min old (was 30 — tighter, curve plays resolve fast)
    maxPositions: 3,                   // Max 3 pump.fun positions
    slippageBps: 500,                  // 5% slippage for bonding curve
    confluenceBonus: true,             // Track multi-wallet convergence on same token
    // --- Deferred entry watchlist ---
    deferredEntryEnabled: true,        // When alpha buys early, add to watchlist instead of entering immediately
    deferredEntryMaxWaitMs: 5 * 60_000, // Max 5 min to wait for curve to reach entry zone
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
export const SEED_WALLETS: Array<{
  address: string;
  label: string;
  minTier: CapitalTier;
  pumpfunOnly?: boolean;
}> = [
  // --- Nansen / general alpha wallets ---
  { address: '7Z5VhcNSpMpaTVqRg8QTkySw6syfcTehTx8CqRPvf9bg', label: 'nansen_smart_1', minTier: CapitalTier.MICRO },
  { address: '2sqTwLCEqKxmyUq79HVL4bwS6QjvfMtnqnZznLFmwJMi', label: 'nansen_349roi', minTier: CapitalTier.MICRO },
  { address: '5MigbXPuoCBzzDXBHMxRKudWmby4BVDQckZLAB6ti1RF', label: 'nansen_sniper', minTier: CapitalTier.MICRO },
  { address: 'raTD4azgmsFHVWe4qrRhhSbgiUVtgbWYEMgXKzNX6FK', label: 'nansen_sniper_2', minTier: CapitalTier.SMALL },
  { address: 'FUHyQNZ4bLZF7f4EfrxcKHfh9u7uz98ALvvMAKMj4QBo', label: 'nansen_realizer', minTier: CapitalTier.SMALL },
  { address: '7iRo63BzGA3BoXyNhrhR3WNzBzRN1WP4bDik4Q5t9fDR', label: 'nansen_okc', minTier: CapitalTier.MEDIUM },
  { address: 'DP4QTfM8HUvUP8hHXuGpTinoJYrYV6XhuFLPP3EYrChq', label: 'nansen_active_1', minTier: CapitalTier.MEDIUM },
  { address: 'AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51', label: 'alpha_big_conviction', minTier: CapitalTier.MICRO },

  // --- Pump.fun bonding curve alpha wallets (Tier 1 — verified across multiple sources) ---
  // $3.3M realized profit. Early Pump.fun entries. Top trade: TRUMP $749K→$1.55M. (Nansen Smart Money)
  { address: '3xqUaVuAWsppb8yaSPJ2hvdvfjteMq2EbdCc3CLguaTE', label: 'pf_nansen_3m3_profit', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  // $4.3M realized PnL. Gaming token specialist. 52% win rate, 192 tokens/90d. (Nansen Smart Money)
  { address: '9UWZFoiCHeYRLmzmDJhdMrP7wgrTw7DMSpPiT2eHgJHe', label: 'pf_nansen_4m3_gaming', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  // AI token specialist. ~$1M profit. 28,876% gain on CATG. (Nansen Smart Money)
  { address: 'BKVaB3eNrGUVRCj3M4LiodKypBTzrpatoo7VBhmdv3eY', label: 'pf_nansen_ai_specialist', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  // High win rate in early launches. Flagged as insider on KOLSCAN + GMGN.
  { address: 'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm', label: 'pf_kolscan_insider', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  // Consistent 50x+ flips on Raydium-migrated tokens. Dominates Pump.fun launches. (Axiom Leaderboard)
  { address: '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t', label: 'pf_axiom_50x_flipper', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  // High win rates on Dune "Solana Alpha Wallets" dashboard. Active across trading bots. (Dune Analytics)
  { address: '8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd', label: 'pf_dune_high_wr', minTier: CapitalTier.MICRO, pumpfunOnly: true },

  // --- Top pump.fun graduation wallets (30-day realized profit leaders) ---
  { address: 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn', label: 'grad_587m_top1', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: 'j1oeQoPeuEDmjvyMwBmCWexzCQup77kbKKxV59CnYbd', label: 'grad_43m_top2', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: 'suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK', label: 'grad_27m_top3', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: 'j1oAbxxiDUWvoHxEDhWE7THLjEkDQW2cSHYn2vttxTF', label: 'grad_17m_top4', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '7dGrdJRYtsNR8UYxZ3TnifXGjGc9eRYLq9sELwYpuuUu', label: 'grad_16m_top5', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: 'DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj', label: 'grad_10m_top6', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '73LnJ7G9ffBDjEBGgJDdgvLUhD5APLonKrNiHsKDCw5B', label: 'grad_8m_top7', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o', label: 'grad_7m_top8', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '54Pz1e35z9uoFdnxtzjp7xZQoFiofqhdayQWBMN7dsuy', label: 'grad_6m_top9', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '56S29mZ3wqvw8hATuUUFqKhGcSGYFASRRFNT38W8q7G3', label: 'grad_6m_top10', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '2ezv4U5HmPpkt2xLsKnw1FyyGmjFBeW7c166p99Hw2xB', label: 'grad_6m_top11', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: 'JDd3hy3gQn2V982mi1zqhNqUw1GfV2UL6g76STojCJPN', label: 'grad_5m_top13', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh', label: 'grad_4m_top16', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '4hSXPtxZgXFpo6Vxq9yqxNjcBoqWN3VoaPJWonUtupzD', label: 'grad_4m_top17', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '9FNz4MjPUmnJqTf6yEDbL1D4SsHVh7uA8zRHhR5K138r', label: 'grad_3m_top18', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk', label: 'grad_3m_top19', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '9ZzjXiwkGRDBwVHJitfx8AmnN2YUbnqW6M1tH38juEeJ', label: 'grad_3m_top20', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '2rbMgYvzAb3xDk6vXrzKkY3VwsmyDZsJTkvB3JJYsRzA', label: 'grad_3m_top22', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: 'AJ6MGExeK7FXmeKkKPmALjcdXVStXYokYNv9uVfDRtvo', label: 'grad_3m_top23', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '3tc4BVAdzjr1JpeZu6NAjLHyp4kK3iic7TexMBYGJ4Xk', label: 'grad_3m_top24', minTier: CapitalTier.MICRO, pumpfunOnly: true },
  { address: '86AEJExyjeNNgcp7GrAvCXTDicf5aGWgoERbXFiG1EdD', label: 'grad_3m_top25', minTier: CapitalTier.MICRO, pumpfunOnly: true },
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
