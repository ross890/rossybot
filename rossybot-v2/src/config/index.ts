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
  WALLET_PRIVATE_KEY: z.string(),
  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_CHAT_ID: z.string(),
  JUPITER_API_URL: z.string().default('https://quote-api.jup.ag/v6'),
  SHADOW_MODE: z.string().default('true'),
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
    wsUrl: env.HELIUS_WS_URL || `wss://atlas-mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`,
    pingIntervalMs: 30_000,
    pongTimeoutMs: 10_000,
    staleTimeoutMs: 120_000, // 2 minutes
    maxReconnectAttempts: 5,
    reconnectDelays: [1000, 2000, 5000, 10000, 30000],
    fallbackPollIntervalMs: 15_000,
  },
  nansen: {
    apiKey: env.NANSEN_API_KEY,
    baseUrl: 'https://api.nansen.ai/v1',
    maxCallsPerMin: 80,
    discoveryIntervalMs: 4 * 60 * 60 * 1000, // 4 hours
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
} as const;

// --- Capital Tier Configurations ---

export const TIER_CONFIGS: Record<CapitalTier, TierConfig> = {
  [CapitalTier.MICRO]: {
    tier: CapitalTier.MICRO,
    maxPositions: 2,
    walletsMonitored: 3,
    positionSizePct: 0.50,
    minPositionSol: 0.3,
    profitTarget: 0.50,
    stopLoss: -0.20,
    hardKill: -0.25,
    partialExitsEnabled: false,
    walletConfluenceRequired: 2,
    confluenceWindow: 30,
    timeKills: [
      { hours: 1, minPnlPct: 0.05 },
      { hours: 4, minPnlPct: 0.15 },
      { hours: 12, minPnlPct: 0.25 },
    ],
    hardTimeHours: 48,
    mcapMin: 200_000,
    mcapMax: 2_000_000,
    liquidityMin: 100_000,
    momentumWindow: '24h',
    momentumMin: 20,
    momentumMax: 200,
    volumeMultiplierMin: 2,
    tokenMaxAgeDays: 30,
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
    walletConfluenceRequired: 2,
    confluenceWindow: 30,
    timeKills: [
      { hours: 1, minPnlPct: 0.05 },
      { hours: 4, minPnlPct: 0.15 },
      { hours: 12, minPnlPct: 0.25 },
    ],
    hardTimeHours: 48,
    mcapMin: 200_000,
    mcapMax: 2_000_000,
    liquidityMin: 100_000,
    momentumWindow: '24h',
    momentumMin: 20,
    momentumMax: 200,
    volumeMultiplierMin: 2,
    tokenMaxAgeDays: 30,
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
    momentumMin: 10,
    momentumMax: 80,
    volumeMultiplierMin: 2,
    tokenMaxAgeDays: null,
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
    momentumMin: 10,
    momentumMax: 80,
    volumeMultiplierMin: 2,
    tokenMaxAgeDays: null,
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
];

export function getTierForCapital(capitalSol: number): CapitalTier {
  if (capitalSol >= 50) return CapitalTier.FULL;
  if (capitalSol >= 10) return CapitalTier.MEDIUM;
  if (capitalSol >= 3) return CapitalTier.SMALL;
  return CapitalTier.MICRO;
}

export function getTierConfig(tier: CapitalTier): TierConfig {
  return TIER_CONFIGS[tier];
}
