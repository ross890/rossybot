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
  // Helius can be disabled when rate limited - uses Birdeye fallback for security checks
  // Set HELIUS_DISABLED=true to run without Helius (top10 concentration defaults to 50%)
  HELIUS_DISABLED: z.string().optional().transform(val => val?.toLowerCase() === 'true'),
  HELIUS_API_KEY: z.string().optional().default(''),
  HELIUS_RPC_URL: z.string().optional().default('https://mainnet.helius-rpc.com'),
  BIRDEYE_API_KEY: z.string().min(1),

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
  MIN_SCORE_BUY_SIGNAL: z.coerce.number().default(70),
  MIN_SCORE_WATCH_SIGNAL: z.coerce.number().default(55),

  // Learning mode (default: true - allows more signals for ML training)
  // When enabled: relaxes signal filtering to collect more data for model training
  // Set to false once you have enough data and want stricter signal quality
  LEARNING_MODE: z.coerce.boolean().default(true),

  // Strategy toggles - control which signal generation strategies are active
  // EARLY_STRATEGY: Original strategy for new tokens (5min-90min old, high volume signals)
  // MATURE_STRATEGY: New strategy for established tokens (21+ days old, high quality signals)
  ENABLE_EARLY_STRATEGY: z.string().optional().transform(val => val?.toLowerCase() === 'true').default('false'),
  ENABLE_MATURE_STRATEGY: z.string().optional().transform(val => val?.toLowerCase() !== 'false').default('true'),
  
  // Screening (with defaults) - Aggressively optimized for early entries
  MIN_MARKET_CAP: z.coerce.number().default(10000),      // Lowered from 25k - catch microcaps early
  MAX_MARKET_CAP: z.coerce.number().default(25000000),   // Raised from 15M for broader range
  MIN_24H_VOLUME: z.coerce.number().default(3000),       // Lowered from 8k - very early tokens have low volume
  MIN_VOLUME_MCAP_RATIO: z.coerce.number().default(0.05), // Lowered from 0.10 - more flexibility
  MIN_HOLDER_COUNT: z.coerce.number().default(20),       // Lowered from 50 - very early = few holders
  MAX_TOP10_CONCENTRATION: z.coerce.number().default(75), // Raised from 60% - early tokens very concentrated
  MIN_LIQUIDITY_POOL: z.coerce.number().default(2000),   // Lowered from 5k - early liquidity pools small
  MIN_TOKEN_AGE_MINUTES: z.coerce.number().default(5),   // Lowered from 15 mins - catch tokens faster
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
    birdeyeApiKey: env.BIRDEYE_API_KEY,
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
  };
}

export const appConfig = loadConfig();
export default appConfig;
