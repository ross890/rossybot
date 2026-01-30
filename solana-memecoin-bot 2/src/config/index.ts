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
  HELIUS_API_KEY: z.string().min(1),
  HELIUS_RPC_URL: z.string().url(),
  BIRDEYE_API_KEY: z.string().min(1),
  
  // Twitter/X API - supports both Bearer Token or Consumer Key/Secret
  TWITTER_BEARER_TOKEN: z.string().optional(),
  TWITTER_CONSUMER_KEY: z.string().optional(),
  TWITTER_CONSUMER_SECRET: z.string().optional(),
  
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  
  // System
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  
  // Trading (with defaults)
  MAX_MEMECOIN_PORTFOLIO_PERCENT: z.coerce.number().default(20),
  DEFAULT_POSITION_SIZE_PERCENT: z.coerce.number().default(2),
  MAX_SIGNALS_PER_HOUR: z.coerce.number().default(5),
  MAX_SIGNALS_PER_DAY: z.coerce.number().default(20),
  MIN_SCORE_BUY_SIGNAL: z.coerce.number().default(70),
  MIN_SCORE_WATCH_SIGNAL: z.coerce.number().default(55),
  
  // Screening (with defaults)
  MIN_MARKET_CAP: z.coerce.number().default(50000),
  MAX_MARKET_CAP: z.coerce.number().default(10000000),
  MIN_24H_VOLUME: z.coerce.number().default(20000),
  MIN_VOLUME_MCAP_RATIO: z.coerce.number().default(0.15),
  MIN_HOLDER_COUNT: z.coerce.number().default(100),
  MAX_TOP10_CONCENTRATION: z.coerce.number().default(50),
  MIN_LIQUIDITY_POOL: z.coerce.number().default(10000),
  MIN_TOKEN_AGE_MINUTES: z.coerce.number().default(30),
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
    birdeyeApiKey: env.BIRDEYE_API_KEY,
    twitterBearerToken: env.TWITTER_BEARER_TOKEN || '',
    twitterConsumerKey: env.TWITTER_CONSUMER_KEY || '',
    twitterConsumerSecret: env.TWITTER_CONSUMER_SECRET || '',
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
