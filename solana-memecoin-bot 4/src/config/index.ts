// ===========================================
// CONFIGURATION LOADER
// ===========================================

import { config } from 'dotenv';
import { z } from 'zod';
import type { AppConfig } from '../types/index.js';

// Load .env file
config();

// Environment validation schema
const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  // APIs
  // Helius can be disabled when rate limited - security checks return permissive defaults
  // Set HELIUS_DISABLED=true to run without Helius (top10 concentration defaults to 50%)
  HELIUS_DISABLED: z.string().optional().transform(val => val?.toLowerCase() === 'true'),
  HELIUS_API_KEY: z.string().optional().default(''),
  HELIUS_RPC_URL: z.string().optional().default('https://mainnet.helius-rpc.com'),

  // Twitter/X API - supports both Bearer Token or Consumer Key/Secret
  TWITTER_BEARER_TOKEN: z.string().optional(),
  TWITTER_CONSUMER_KEY: z.string().optional(),
  TWITTER_CONSUMER_SECRET: z.string().optional(),
  // Twitter API toggle: auto-enables when credentials exist, set to "false" to force-disable
  // Explicitly parse string "true"/"false" from env vars (Railway passes strings)
  TWITTER_ENABLED: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),

  // Trading Wallet (optional - trading disabled if not set)
  BOT_WALLET_PRIVATE_KEY: z.string().optional(),
  
  // System
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  
  // Trading (with defaults)
  MAX_MEMECOIN_PORTFOLIO_PERCENT: z.coerce.number().default(20),
  DEFAULT_POSITION_SIZE_PERCENT: z.coerce.number().default(2),
  MAX_SIGNALS_PER_HOUR: z.coerce.number().default(50),   // Increased from 5 for better data collection
  MAX_SIGNALS_PER_DAY: z.coerce.number().default(200),   // Increased from 20 for learning phase
  MIN_SCORE_BUY_SIGNAL: z.coerce.number().default(45),
  MIN_SCORE_WATCH_SIGNAL: z.coerce.number().default(30),

  // Learning mode (default: true - allows more signals for ML training)
  // When enabled: relaxes signal filtering to collect more data for model training
  // Set to false once you have enough data and want stricter signal quality
  LEARNING_MODE: z.coerce.boolean().default(true),

  // Strategy toggles - control which signal generation strategies are active
  // EARLY_STRATEGY: Original strategy for new tokens (5min-90min old, high volume signals)
  // MATURE_STRATEGY: New strategy for established tokens (21+ days old, high quality signals)
  ENABLE_EARLY_STRATEGY: z.string().optional().transform(val => val?.toLowerCase() !== 'false').default('true'),
  ENABLE_MATURE_STRATEGY: z.string().optional().transform(val => val?.toLowerCase() !== 'false').default('true'),
  
  // Pump.fun Dev Tracker
  PUMPFUN_DEV_TRACKER_ENABLED: z.string().optional().transform(val => val?.toLowerCase() !== 'false').default('true'),
  DEV_MIN_LAUNCHES: z.coerce.number().default(5),
  DEV_MIN_SUCCESS_RATE: z.coerce.number().default(0.20),
  DEV_MAX_RUG_RATE: z.coerce.number().default(0.50),
  DEV_MIN_BEST_PEAK_MC: z.coerce.number().default(200000),
  DEV_STATS_UPDATE_INTERVAL_MS: z.coerce.number().default(1800000),    // 30 minutes
  DEV_DISCOVERY_INTERVAL_MS: z.coerce.number().default(86400000),      // 24 hours
  DEV_SIGNAL_COOLDOWN_MS: z.coerce.number().default(300000),           // 5 minutes
  SOLSCAN_API_KEY: z.string().optional().default(''),

  // Screening (with defaults) - Aggressively optimized for early entries
  MIN_MARKET_CAP: z.coerce.number().default(50000),       // No tokens below $50K MC
  MAX_MARKET_CAP: z.coerce.number().default(25000000),   // Raised from 15M for broader range
  MIN_24H_VOLUME: z.coerce.number().default(500),        // Lowered from 3k - very early tokens have tiny volume
  MIN_VOLUME_MCAP_RATIO: z.coerce.number().default(0.01), // Lowered from 0.05 - more flexibility for early tokens
  MIN_HOLDER_COUNT: z.coerce.number().default(5),        // Lowered from 20 - brand new tokens have few holders
  MAX_TOP10_CONCENTRATION: z.coerce.number().default(90), // Raised from 75% - memecoins are concentrated by nature
  MIN_LIQUIDITY_POOL: z.coerce.number().default(500),    // Lowered from 2k - early gems start with tiny liquidity
  MIN_TOKEN_AGE_MINUTES: z.coerce.number().default(1),   // Lowered from 5 mins - only reject truly instant tokens
});

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  
  if (!parsed.success) {
    console.error('❌ Invalid environment configuration:');
    console.error(parsed.error.format());
    process.exit(1);
  }
  
  const env = parsed.data;
  
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    heliusApiKey: env.HELIUS_API_KEY,
    heliusRpcUrl: env.HELIUS_RPC_URL,
    heliusDisabled: env.HELIUS_DISABLED || false,
    twitterBearerToken: env.TWITTER_BEARER_TOKEN || '',
    twitterConsumerKey: env.TWITTER_CONSUMER_KEY || '',
    twitterConsumerSecret: env.TWITTER_CONSUMER_SECRET || '',
    // Auto-enable Twitter if credentials exist, unless explicitly disabled
    twitterEnabled: env.TWITTER_ENABLED !== undefined
      ? env.TWITTER_ENABLED.toLowerCase() === 'true'
      : !!(env.TWITTER_BEARER_TOKEN || (env.TWITTER_CONSUMER_KEY && env.TWITTER_CONSUMER_SECRET)),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    
    trading: {
      maxMemecoinPortfolioPercent: env.MAX_MEMECOIN_PORTFOLIO_PERCENT,
      defaultPositionSizePercent: env.DEFAULT_POSITION_SIZE_PERCENT,
      maxSignalsPerHour: env.MAX_SIGNALS_PER_HOUR,
      maxSignalsPerDay: env.MAX_SIGNALS_PER_DAY,
      minScoreBuySignal: env.MIN_SCORE_BUY_SIGNAL,
      minScoreWatchSignal: env.MIN_SCORE_WATCH_SIGNAL,
      learningMode: env.LEARNING_MODE,
      enableEarlyStrategy: env.ENABLE_EARLY_STRATEGY,
      enableMatureStrategy: env.ENABLE_MATURE_STRATEGY,
    },
    
    screening: {
      minMarketCap: env.MIN_MARKET_CAP,
      maxMarketCap: env.MAX_MARKET_CAP,
      min24hVolume: env.MIN_24H_VOLUME,
      minVolumeMarketCapRatio: env.MIN_VOLUME_MCAP_RATIO,
      minHolderCount: env.MIN_HOLDER_COUNT,
      maxTop10Concentration: env.MAX_TOP10_CONCENTRATION,
      minLiquidityPool: env.MIN_LIQUIDITY_POOL,
      minTokenAgeMinutes: env.MIN_TOKEN_AGE_MINUTES,
    },

    solscanApiKey: env.SOLSCAN_API_KEY,

    devTracker: {
      enabled: env.PUMPFUN_DEV_TRACKER_ENABLED,
      minLaunches: env.DEV_MIN_LAUNCHES,
      minSuccessRate: env.DEV_MIN_SUCCESS_RATE,
      maxRugRate: env.DEV_MAX_RUG_RATE,
      minBestPeakMc: env.DEV_MIN_BEST_PEAK_MC,
      statsUpdateIntervalMs: env.DEV_STATS_UPDATE_INTERVAL_MS,
      discoveryIntervalMs: env.DEV_DISCOVERY_INTERVAL_MS,
      signalCooldownMs: env.DEV_SIGNAL_COOLDOWN_MS,
    },
  };
}

export const appConfig = loadConfig();
export default appConfig;
