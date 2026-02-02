// ===========================================
// DATABASE CLIENT & SCHEMA
// ===========================================

import pg from 'pg';
import { appConfig } from '../config/index.js';
import { logger } from './logger.js';
import type {
  Kol,
  KolWallet,
  KolTrade,
  Position,
  KolTier,
  WalletType,
  AttributionConfidence,
  LinkMethod,
} from '../types/index.js';

const { Pool } = pg;

// Database connection pool
export const pool = new Pool({
  connectionString: appConfig.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error');
});

// ============ SCHEMA CREATION ============

export const SCHEMA_SQL = `
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- KOL Tier enum
DO $$ BEGIN
  CREATE TYPE kol_tier AS ENUM ('TIER_1', 'TIER_2', 'TIER_3');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Wallet Type enum
DO $$ BEGIN
  CREATE TYPE wallet_type AS ENUM ('MAIN', 'SIDE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Attribution Confidence enum
DO $$ BEGIN
  CREATE TYPE attribution_confidence AS ENUM ('HIGH', 'MEDIUM_HIGH', 'MEDIUM', 'LOW_MEDIUM', 'LOW');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Link Method enum
DO $$ BEGIN
  CREATE TYPE link_method AS ENUM (
    'DIRECT_KNOWN',
    'FUNDING_CLUSTER',
    'BEHAVIOURAL_MATCH',
    'TEMPORAL_CORRELATION',
    'CEX_WITHDRAWAL_PATTERN',
    'SHARED_TOKEN_OVERLAP'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Position Status enum
DO $$ BEGIN
  CREATE TYPE position_status AS ENUM ('OPEN', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- KOLs table
CREATE TABLE IF NOT EXISTS kols (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  handle VARCHAR(100) NOT NULL UNIQUE,
  follower_count INTEGER DEFAULT 0,
  tier kol_tier DEFAULT 'TIER_3',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- KOL Wallets table
CREATE TABLE IF NOT EXISTS kol_wallets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kol_id UUID REFERENCES kols(id) ON DELETE CASCADE,
  address VARCHAR(64) NOT NULL UNIQUE,
  wallet_type wallet_type NOT NULL,
  attribution_confidence attribution_confidence DEFAULT 'MEDIUM',
  link_method link_method NOT NULL,
  notes TEXT,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- KOL Trades table
CREATE TABLE IF NOT EXISTS kol_trades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kol_id UUID REFERENCES kols(id) ON DELETE CASCADE,
  wallet_id UUID REFERENCES kol_wallets(id) ON DELETE CASCADE,
  token_address VARCHAR(64) NOT NULL,
  token_ticker VARCHAR(20),
  entry_price DECIMAL(30, 18),
  exit_price DECIMAL(30, 18),
  entry_timestamp TIMESTAMP NOT NULL,
  exit_timestamp TIMESTAMP,
  roi DECIMAL(10, 4),
  is_win BOOLEAN,
  tx_signature VARCHAR(128),
  created_at TIMESTAMP DEFAULT NOW()
);

-- KOL Performance (materialized view alternative - we'll update via trigger/cron)
CREATE TABLE IF NOT EXISTS kol_performance (
  kol_id UUID PRIMARY KEY REFERENCES kols(id) ON DELETE CASCADE,
  total_trades INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  win_rate DECIMAL(5, 4) DEFAULT 0,
  avg_roi DECIMAL(10, 4) DEFAULT 0,
  median_roi DECIMAL(10, 4) DEFAULT 0,
  last_calculated TIMESTAMP DEFAULT NOW()
);

-- Positions table
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) NOT NULL,
  token_ticker VARCHAR(20),
  entry_price DECIMAL(30, 18) NOT NULL,
  current_price DECIMAL(30, 18),
  quantity DECIMAL(30, 10) NOT NULL,
  entry_timestamp TIMESTAMP DEFAULT NOW(),
  signal_id UUID,
  stop_loss DECIMAL(30, 18),
  take_profit_1 DECIMAL(30, 18),
  take_profit_2 DECIMAL(30, 18),
  take_profit_1_hit BOOLEAN DEFAULT FALSE,
  take_profit_2_hit BOOLEAN DEFAULT FALSE,
  trailing_stop_active BOOLEAN DEFAULT FALSE,
  trailing_stop_price DECIMAL(30, 18),
  status position_status DEFAULT 'OPEN',
  closed_at TIMESTAMP,
  close_reason TEXT,
  realized_pnl DECIMAL(20, 4),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Signal log table (for tracking sent signals and rate limiting)
CREATE TABLE IF NOT EXISTS signal_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) NOT NULL,
  signal_type VARCHAR(20) NOT NULL,
  score INTEGER,
  kol_handle VARCHAR(100),
  sent_at TIMESTAMP DEFAULT NOW()
);

-- Scam database (known rug wallets)
CREATE TABLE IF NOT EXISTS rug_wallets (
  address VARCHAR(64) PRIMARY KEY,
  rug_count INTEGER DEFAULT 1,
  first_seen TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW(),
  notes TEXT
);

-- Trade Type enum (for tracking buys AND sells)
DO $$ BEGIN
  CREATE TYPE trade_type AS ENUM ('BUY', 'SELL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Token Safety Cache table (Feature 1 & 5)
CREATE TABLE IF NOT EXISTS token_safety_cache (
  token_address VARCHAR(64) PRIMARY KEY,
  mint_authority_enabled BOOLEAN NOT NULL,
  freeze_authority_enabled BOOLEAN NOT NULL,
  lp_locked BOOLEAN NOT NULL,
  lp_lock_duration INTEGER,
  top10_holder_concentration DECIMAL(5, 2) NOT NULL,
  deployer_holding DECIMAL(5, 2) NOT NULL,
  token_age_mins INTEGER NOT NULL,
  rugcheck_score INTEGER,
  honeypot_risk BOOLEAN NOT NULL,
  safety_score INTEGER NOT NULL,
  flags TEXT[],
  -- Insider detection fields (Feature 5)
  same_block_buyers INTEGER DEFAULT 0,
  deployer_funded_buyers INTEGER DEFAULT 0,
  suspicious_patterns TEXT[],
  insider_risk_score INTEGER DEFAULT 0,
  -- Metadata
  checked_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '15 minutes'
);

-- Conviction Signals table (Feature 2)
CREATE TABLE IF NOT EXISTS conviction_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) NOT NULL,
  kol_id UUID REFERENCES kols(id) ON DELETE CASCADE,
  wallet_address VARCHAR(64) NOT NULL,
  kol_name VARCHAR(100) NOT NULL,
  buy_timestamp TIMESTAMP NOT NULL,
  sol_amount DECIMAL(20, 10),
  tx_signature VARCHAR(128),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Daily Stats table (Feature 8)
CREATE TABLE IF NOT EXISTS daily_stats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date DATE NOT NULL UNIQUE,
  signals_sent INTEGER DEFAULT 0,
  winners INTEGER DEFAULT 0,
  losers INTEGER DEFAULT 0,
  neutral INTEGER DEFAULT 0,
  best_performer_token VARCHAR(64),
  best_performer_ticker VARCHAR(20),
  best_performer_roi DECIMAL(10, 2),
  worst_performer_token VARCHAR(64),
  worst_performer_ticker VARCHAR(20),
  worst_performer_roi DECIMAL(10, 2),
  top_kol_handle VARCHAR(100),
  top_kol_wins INTEGER,
  top_kol_total INTEGER,
  simulated_entry_sol DECIMAL(20, 10),
  simulated_current_sol DECIMAL(20, 10),
  high_conviction_tokens JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Pump.fun Tokens table (Feature 4)
CREATE TABLE IF NOT EXISTS pumpfun_tokens (
  token_address VARCHAR(64) PRIMARY KEY,
  bonding_progress DECIMAL(5, 2) NOT NULL,
  current_market_cap DECIMAL(20, 2),
  target_market_cap DECIMAL(20, 2) DEFAULT 69000,
  estimated_time_to_migration INTEGER,
  is_migrated BOOLEAN DEFAULT FALSE,
  migration_detected_at TIMESTAMP,
  last_alert_progress INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- KOL Extended Performance table (Feature 7)
CREATE TABLE IF NOT EXISTS kol_extended_performance (
  kol_id UUID PRIMARY KEY REFERENCES kols(id) ON DELETE CASCADE,
  total_trades INTEGER DEFAULT 0,
  win_rate DECIMAL(5, 4) DEFAULT 0,
  avg_roi DECIMAL(10, 4) DEFAULT 0,
  avg_hold_time_hours DECIMAL(10, 2) DEFAULT 0,
  best_trade_token VARCHAR(64),
  best_trade_ticker VARCHAR(20),
  best_trade_roi DECIMAL(10, 4),
  worst_trade_token VARCHAR(64),
  worst_trade_ticker VARCHAR(20),
  worst_trade_roi DECIMAL(10, 4),
  last_7d_roi DECIMAL(10, 4) DEFAULT 0,
  last_7d_trades INTEGER DEFAULT 0,
  last_7d_wins INTEGER DEFAULT 0,
  consistency_score DECIMAL(5, 2) DEFAULT 0,
  last_calculated TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_kol_wallets_address ON kol_wallets(address);
CREATE INDEX IF NOT EXISTS idx_kol_wallets_kol_id ON kol_wallets(kol_id);
CREATE INDEX IF NOT EXISTS idx_kol_trades_kol_id ON kol_trades(kol_id);
CREATE INDEX IF NOT EXISTS idx_kol_trades_token ON kol_trades(token_address);
CREATE INDEX IF NOT EXISTS idx_kol_trades_timestamp ON kol_trades(entry_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_address);
CREATE INDEX IF NOT EXISTS idx_signal_log_token_time ON signal_log(token_address, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_log_sent_at ON signal_log(sent_at DESC);

-- New indexes for feature tables
CREATE INDEX IF NOT EXISTS idx_token_safety_expires ON token_safety_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_conviction_token ON conviction_signals(token_address);
CREATE INDEX IF NOT EXISTS idx_conviction_kol ON conviction_signals(kol_id);
CREATE INDEX IF NOT EXISTS idx_conviction_timestamp ON conviction_signals(buy_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats(date DESC);
CREATE INDEX IF NOT EXISTS idx_pumpfun_progress ON pumpfun_tokens(bonding_progress DESC);
CREATE INDEX IF NOT EXISTS idx_pumpfun_migrated ON pumpfun_tokens(is_migrated);

-- ============ MATURE TOKEN MODULE TABLES ============

-- Mature Signal Type enum
DO $$ BEGIN
  CREATE TYPE mature_signal_type AS ENUM (
    'ACCUMULATION_BREAKOUT',
    'SMART_ACCUMULATION',
    'KOL_REENTRY',
    'KOL_FIRST_BUY',
    'MULTI_KOL_CONVICTION',
    'VOLUME_BREAKOUT',
    'HOLDER_SURGE',
    'NARRATIVE_CATALYST'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Accumulation Pattern enum
DO $$ BEGIN
  CREATE TYPE accumulation_pattern AS ENUM (
    'WYCKOFF_SPRING',
    'RANGE_BREAK',
    'ASCENDING_TRIANGLE',
    'DOUBLE_BOTTOM',
    'CONSOLIDATION',
    'NONE'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Exit Recommendation enum
DO $$ BEGIN
  CREATE TYPE exit_recommendation AS ENUM (
    'FULL_EXIT',
    'PARTIAL_EXIT_75',
    'PARTIAL_EXIT_50',
    'PARTIAL_EXIT_25',
    'MOVE_STOP',
    'HOLD'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Mature Token Signals table
CREATE TABLE IF NOT EXISTS mature_token_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) NOT NULL,
  token_ticker VARCHAR(20),
  token_name VARCHAR(100),
  signal_type mature_signal_type NOT NULL,

  -- Scores
  composite_score INTEGER NOT NULL,
  accumulation_score INTEGER,
  breakout_score INTEGER,
  holder_dynamics_score INTEGER,
  volume_authenticity_score INTEGER,
  smart_money_score INTEGER,
  kol_activity_score INTEGER,
  contract_safety_score INTEGER,

  -- Confidence
  confidence VARCHAR(10) NOT NULL,
  recommendation VARCHAR(20) NOT NULL,
  risk_level INTEGER NOT NULL,

  -- Token data
  token_age_hours DECIMAL(10, 2),
  current_price DECIMAL(30, 18),
  market_cap DECIMAL(20, 2),
  volume_24h DECIMAL(20, 2),
  liquidity DECIMAL(20, 2),
  holder_count INTEGER,
  top10_concentration DECIMAL(5, 2),

  -- Trade setup
  entry_zone_low DECIMAL(30, 18),
  entry_zone_high DECIMAL(30, 18),
  position_size_percent DECIMAL(5, 2),
  stop_loss_price DECIMAL(30, 18),
  stop_loss_percent DECIMAL(5, 2),
  take_profit_1_price DECIMAL(30, 18),
  take_profit_1_percent DECIMAL(5, 2),
  take_profit_2_price DECIMAL(30, 18),
  take_profit_2_percent DECIMAL(5, 2),
  take_profit_3_price DECIMAL(30, 18),
  take_profit_3_percent DECIMAL(5, 2),
  max_hold_days INTEGER,

  -- Signals and flags
  bullish_signals TEXT[],
  bearish_signals TEXT[],
  warnings TEXT[],

  -- Metadata
  generated_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  telegram_message_id VARCHAR(50)
);

-- Accumulation Patterns table (historical tracking)
CREATE TABLE IF NOT EXISTS accumulation_patterns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) NOT NULL,
  pattern accumulation_pattern NOT NULL,
  pattern_confidence DECIMAL(5, 2) NOT NULL,

  -- Pattern metrics
  price_range_24h DECIMAL(10, 4),
  volume_decline_7d DECIMAL(10, 4),
  buy_volume_ratio DECIMAL(10, 4),
  new_holders_24h INTEGER,
  holder_retention_rate DECIMAL(5, 4),
  large_wallet_accumulation INTEGER,
  consolidation_days DECIMAL(5, 2),
  distance_from_ath DECIMAL(10, 4),

  -- Score
  accumulation_score INTEGER NOT NULL,

  -- Metadata
  detected_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  resolution_type VARCHAR(20) -- 'BREAKOUT', 'BREAKDOWN', 'CONTINUED'
);

-- Smart Money Activity table
CREATE TABLE IF NOT EXISTS smart_money_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) NOT NULL,
  wallet_address VARCHAR(64) NOT NULL,

  -- Activity type
  activity_type VARCHAR(20) NOT NULL, -- 'ACCUMULATION', 'DISTRIBUTION', 'NEW_POSITION'

  -- Transaction details
  sol_amount DECIMAL(20, 10),
  token_amount DECIMAL(30, 10),
  price_at_activity DECIMAL(30, 18),

  -- Wallet profile
  wallet_win_rate DECIMAL(5, 4),
  wallet_total_trades INTEGER,
  is_known_whale BOOLEAN DEFAULT FALSE,
  is_known_smart BOOLEAN DEFAULT FALSE,

  -- Metadata
  tx_signature VARCHAR(128),
  detected_at TIMESTAMP DEFAULT NOW()
);

-- Mature Token Watchlist table
CREATE TABLE IF NOT EXISTS mature_token_watchlist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) NOT NULL UNIQUE,
  token_ticker VARCHAR(20),

  -- Watch reason
  added_reason TEXT NOT NULL,
  current_score INTEGER,
  target_score INTEGER,
  target_conditions TEXT[],

  -- Key levels
  resistance_level DECIMAL(30, 18),
  support_level DECIMAL(30, 18),
  breakout_target DECIMAL(30, 18),
  volume_trigger DECIMAL(20, 2),

  -- Status
  is_active BOOLEAN DEFAULT TRUE,
  added_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  last_checked_at TIMESTAMP DEFAULT NOW(),
  promoted_to_signal_at TIMESTAMP,
  promoted_signal_id UUID REFERENCES mature_token_signals(id)
);

-- Mature Token Exit Signals table
CREATE TABLE IF NOT EXISTS mature_token_exit_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) NOT NULL,
  token_ticker VARCHAR(20),

  -- Exit details
  recommendation exit_recommendation NOT NULL,
  urgency VARCHAR(10) NOT NULL,
  reason TEXT NOT NULL,
  triggers TEXT[],

  -- Position status
  entry_price DECIMAL(30, 18),
  exit_price DECIMAL(30, 18),
  pnl_percent DECIMAL(10, 4),
  pnl_usd DECIMAL(20, 2),
  hold_time_hours DECIMAL(10, 2),

  -- Original signal reference
  original_signal_id UUID REFERENCES mature_token_signals(id),
  original_signal_type mature_signal_type,

  -- Metadata
  generated_at TIMESTAMP DEFAULT NOW(),
  telegram_message_id VARCHAR(50)
);

-- Mature token signal rate limiting table
CREATE TABLE IF NOT EXISTS mature_signal_rate_limit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) NOT NULL,
  signal_type mature_signal_type NOT NULL,
  sent_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for mature token tables
CREATE INDEX IF NOT EXISTS idx_mature_signals_token ON mature_token_signals(token_address);
CREATE INDEX IF NOT EXISTS idx_mature_signals_time ON mature_token_signals(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mature_signals_type ON mature_token_signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_mature_signals_score ON mature_token_signals(composite_score DESC);

CREATE INDEX IF NOT EXISTS idx_accumulation_token ON accumulation_patterns(token_address);
CREATE INDEX IF NOT EXISTS idx_accumulation_pattern ON accumulation_patterns(pattern);
CREATE INDEX IF NOT EXISTS idx_accumulation_time ON accumulation_patterns(detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_smart_money_token ON smart_money_activity(token_address);
CREATE INDEX IF NOT EXISTS idx_smart_money_wallet ON smart_money_activity(wallet_address);
CREATE INDEX IF NOT EXISTS idx_smart_money_time ON smart_money_activity(detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_mature_watchlist_active ON mature_token_watchlist(is_active);
CREATE INDEX IF NOT EXISTS idx_mature_watchlist_expires ON mature_token_watchlist(expires_at);

CREATE INDEX IF NOT EXISTS idx_mature_exit_token ON mature_token_exit_signals(token_address);
CREATE INDEX IF NOT EXISTS idx_mature_exit_time ON mature_token_exit_signals(generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_mature_rate_token_time ON mature_signal_rate_limit(token_address, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_mature_rate_time ON mature_signal_rate_limit(sent_at DESC);
`;

// ============ DATABASE OPERATIONS ============

export class Database {
  // ============ KOL OPERATIONS ============
  
  static async getKolByHandle(handle: string): Promise<Kol | null> {
    const result = await pool.query(
      'SELECT * FROM kols WHERE handle = $1',
      [handle]
    );
    if (result.rows.length === 0) return null;
    return this.mapKolRow(result.rows[0]);
  }
  
  static async getKolById(id: string): Promise<Kol | null> {
    const result = await pool.query(
      'SELECT * FROM kols WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return null;
    return this.mapKolRow(result.rows[0]);
  }
  
  static async getAllKols(): Promise<Kol[]> {
    const result = await pool.query(
      'SELECT * FROM kols ORDER BY tier ASC, follower_count DESC'
    );
    return result.rows.map(this.mapKolRow);
  }
  
  static async createKol(handle: string, followerCount: number, tier: KolTier): Promise<Kol> {
    const result = await pool.query(
      `INSERT INTO kols (handle, follower_count, tier)
       VALUES ($1, $2, $3)
       ON CONFLICT (handle) DO UPDATE SET
         follower_count = EXCLUDED.follower_count,
         tier = EXCLUDED.tier,
         updated_at = NOW()
       RETURNING *`,
      [handle, followerCount, tier]
    );
    return this.mapKolRow(result.rows[0]);
  }
  
  // ============ WALLET OPERATIONS ============
  
  static async getWalletByAddress(address: string): Promise<(KolWallet & { kol: Kol }) | null> {
    const result = await pool.query(
      `SELECT w.*, k.handle, k.follower_count, k.tier as kol_tier,
              k.created_at as kol_created_at, k.updated_at as kol_updated_at
       FROM kol_wallets w
       JOIN kols k ON w.kol_id = k.id
       WHERE w.address = $1`,
      [address]
    );
    if (result.rows.length === 0) return null;
    
    const row = result.rows[0];
    return {
      ...this.mapWalletRow(row),
      kol: {
        id: row.kol_id,
        handle: row.handle,
        followerCount: row.follower_count,
        tier: row.kol_tier as KolTier,
        createdAt: row.kol_created_at,
        updatedAt: row.kol_updated_at,
      },
    };
  }
  
  static async getWalletsByKol(kolId: string): Promise<KolWallet[]> {
    const result = await pool.query(
      'SELECT * FROM kol_wallets WHERE kol_id = $1',
      [kolId]
    );
    return result.rows.map(this.mapWalletRow);
  }
  
  static async getAllTrackedWallets(): Promise<(KolWallet & { kol: Kol })[]> {
    const result = await pool.query(
      `SELECT w.*, k.handle, k.follower_count, k.tier as kol_tier,
              k.created_at as kol_created_at, k.updated_at as kol_updated_at
       FROM kol_wallets w
       JOIN kols k ON w.kol_id = k.id
       WHERE w.attribution_confidence IN ('HIGH', 'MEDIUM_HIGH', 'MEDIUM')
       ORDER BY k.tier ASC, w.wallet_type ASC`
    );
    
    return result.rows.map((row) => ({
      ...this.mapWalletRow(row),
      kol: {
        id: row.kol_id,
        handle: row.handle,
        followerCount: row.follower_count,
        tier: row.kol_tier as KolTier,
        createdAt: row.kol_created_at,
        updatedAt: row.kol_updated_at,
      },
    }));
  }
  
  static async createWallet(
    kolId: string,
    address: string,
    walletType: WalletType,
    linkMethod: LinkMethod,
    confidence: AttributionConfidence,
    notes?: string
  ): Promise<KolWallet> {
    const result = await pool.query(
      `INSERT INTO kol_wallets (kol_id, address, wallet_type, link_method, attribution_confidence, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (address) DO UPDATE SET
         wallet_type = EXCLUDED.wallet_type,
         link_method = EXCLUDED.link_method,
         attribution_confidence = EXCLUDED.attribution_confidence,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [kolId, address, walletType, linkMethod, confidence, notes]
    );
    return this.mapWalletRow(result.rows[0]);
  }
  
  // ============ PERFORMANCE OPERATIONS ============
  // NOTE: KOL performance is now calculated by kol-analytics.ts (single source of truth)
  // The kol_performance table is deprecated - use kol_extended_performance via kolAnalytics.getKolStats()

  // ============ TRADE OPERATIONS ============
  
  static async recordTrade(
    kolId: string,
    walletId: string,
    tokenAddress: string,
    tokenTicker: string,
    entryPrice: number,
    entryTimestamp: Date,
    txSignature: string
  ): Promise<KolTrade> {
    const result = await pool.query(
      `INSERT INTO kol_trades (kol_id, wallet_id, token_address, token_ticker, entry_price, entry_timestamp, tx_signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [kolId, walletId, tokenAddress, tokenTicker, entryPrice, entryTimestamp, txSignature]
    );
    return this.mapTradeRow(result.rows[0]);
  }
  
  // ============ SIGNAL LOG OPERATIONS ============
  
  static async logSignal(tokenAddress: string, signalType: string, score: number, kolHandle?: string): Promise<void> {
    await pool.query(
      `INSERT INTO signal_log (token_address, signal_type, score, kol_handle)
       VALUES ($1, $2, $3, $4)`,
      [tokenAddress, signalType, score, kolHandle]
    );
  }
  
  static async getRecentSignalCount(hours: number): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM signal_log
       WHERE sent_at > NOW() - INTERVAL '${hours} hours'`
    );
    return parseInt(result.rows[0].count);
  }
  
  static async getLastSignalTime(tokenAddress: string): Promise<Date | null> {
    const result = await pool.query(
      `SELECT sent_at FROM signal_log
       WHERE token_address = $1
       ORDER BY sent_at DESC LIMIT 1`,
      [tokenAddress]
    );
    return result.rows.length > 0 ? result.rows[0].sent_at : null;
  }
  
  // ============ RUG DATABASE OPERATIONS ============
  
  static async isRugWallet(address: string): Promise<boolean> {
    const result = await pool.query(
      'SELECT 1 FROM rug_wallets WHERE address = $1',
      [address]
    );
    return result.rows.length > 0;
  }
  
  static async addRugWallet(address: string, notes?: string): Promise<void> {
    await pool.query(
      `INSERT INTO rug_wallets (address, notes)
       VALUES ($1, $2)
       ON CONFLICT (address) DO UPDATE SET
         rug_count = rug_wallets.rug_count + 1,
         last_seen = NOW()`,
      [address, notes]
    );
  }
  
  // ============ POSITION OPERATIONS ============
  
  static async getOpenPositions(): Promise<Position[]> {
    const result = await pool.query(
      `SELECT * FROM positions WHERE status = 'OPEN' ORDER BY entry_timestamp DESC`
    );
    return result.rows.map(this.mapPositionRow);
  }
  
  static async hasOpenPosition(tokenAddress: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM positions WHERE token_address = $1 AND status = 'OPEN'`,
      [tokenAddress]
    );
    return result.rows.length > 0;
  }
  
  // ============ ROW MAPPERS ============
  
  private static mapKolRow(row: any): Kol {
    return {
      id: row.id,
      handle: row.handle,
      followerCount: row.follower_count,
      tier: row.tier as KolTier,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  
  private static mapWalletRow(row: any): KolWallet {
    return {
      id: row.id,
      kolId: row.kol_id,
      address: row.address,
      walletType: row.wallet_type as WalletType,
      attributionConfidence: row.attribution_confidence as AttributionConfidence,
      linkMethod: row.link_method as LinkMethod,
      notes: row.notes,
      verified: row.verified,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  
  // mapPerformanceRow removed - use kolAnalytics.getKolStats() instead

  private static mapTradeRow(row: any): KolTrade {
    return {
      id: row.id,
      kolId: row.kol_id,
      walletId: row.wallet_id,
      tokenAddress: row.token_address,
      tokenTicker: row.token_ticker,
      entryPrice: parseFloat(row.entry_price),
      exitPrice: row.exit_price ? parseFloat(row.exit_price) : null,
      entryTimestamp: row.entry_timestamp,
      exitTimestamp: row.exit_timestamp,
      roi: row.roi ? parseFloat(row.roi) : null,
      isWin: row.is_win,
      createdAt: row.created_at,
    };
  }
  
  private static mapPositionRow(row: any): Position {
    return {
      id: row.id,
      tokenAddress: row.token_address,
      tokenTicker: row.token_ticker,
      entryPrice: parseFloat(row.entry_price),
      currentPrice: row.current_price ? parseFloat(row.current_price) : 0,
      quantity: parseFloat(row.quantity),
      entryTimestamp: row.entry_timestamp,
      signalId: row.signal_id,
      stopLoss: parseFloat(row.stop_loss),
      takeProfit1: parseFloat(row.take_profit_1),
      takeProfit2: parseFloat(row.take_profit_2),
      takeProfit1Hit: row.take_profit_1_hit,
      takeProfit2Hit: row.take_profit_2_hit,
      trailingStopActive: row.trailing_stop_active,
      trailingStopPrice: row.trailing_stop_price ? parseFloat(row.trailing_stop_price) : null,
      status: row.status,
      closedAt: row.closed_at,
      closeReason: row.close_reason,
      realizedPnl: row.realized_pnl ? parseFloat(row.realized_pnl) : null,
    };
  }

  // ============ MATURE TOKEN OPERATIONS ============

  static async saveMatureTokenSignal(signal: {
    tokenAddress: string;
    tokenTicker: string;
    tokenName: string;
    signalType: string;
    compositeScore: number;
    accumulationScore?: number;
    breakoutScore?: number;
    holderDynamicsScore?: number;
    volumeAuthenticityScore?: number;
    smartMoneyScore?: number;
    kolActivityScore?: number;
    contractSafetyScore?: number;
    confidence: string;
    recommendation: string;
    riskLevel: number;
    tokenAgeHours?: number;
    currentPrice?: number;
    marketCap?: number;
    volume24h?: number;
    liquidity?: number;
    holderCount?: number;
    top10Concentration?: number;
    entryZoneLow?: number;
    entryZoneHigh?: number;
    positionSizePercent?: number;
    stopLossPrice?: number;
    stopLossPercent?: number;
    takeProfit1Price?: number;
    takeProfit1Percent?: number;
    takeProfit2Price?: number;
    takeProfit2Percent?: number;
    takeProfit3Price?: number;
    takeProfit3Percent?: number;
    maxHoldDays?: number;
    bullishSignals?: string[];
    bearishSignals?: string[];
    warnings?: string[];
    expiresAt?: Date;
    telegramMessageId?: string;
  }): Promise<string> {
    const result = await pool.query(
      `INSERT INTO mature_token_signals (
        token_address, token_ticker, token_name, signal_type,
        composite_score, accumulation_score, breakout_score,
        holder_dynamics_score, volume_authenticity_score,
        smart_money_score, kol_activity_score, contract_safety_score,
        confidence, recommendation, risk_level,
        token_age_hours, current_price, market_cap, volume_24h,
        liquidity, holder_count, top10_concentration,
        entry_zone_low, entry_zone_high, position_size_percent,
        stop_loss_price, stop_loss_percent,
        take_profit_1_price, take_profit_1_percent,
        take_profit_2_price, take_profit_2_percent,
        take_profit_3_price, take_profit_3_percent,
        max_hold_days, bullish_signals, bearish_signals, warnings,
        expires_at, telegram_message_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
        $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39
      ) RETURNING id`,
      [
        signal.tokenAddress, signal.tokenTicker, signal.tokenName, signal.signalType,
        signal.compositeScore, signal.accumulationScore, signal.breakoutScore,
        signal.holderDynamicsScore, signal.volumeAuthenticityScore,
        signal.smartMoneyScore, signal.kolActivityScore, signal.contractSafetyScore,
        signal.confidence, signal.recommendation, signal.riskLevel,
        signal.tokenAgeHours, signal.currentPrice, signal.marketCap, signal.volume24h,
        signal.liquidity, signal.holderCount, signal.top10Concentration,
        signal.entryZoneLow, signal.entryZoneHigh, signal.positionSizePercent,
        signal.stopLossPrice, signal.stopLossPercent,
        signal.takeProfit1Price, signal.takeProfit1Percent,
        signal.takeProfit2Price, signal.takeProfit2Percent,
        signal.takeProfit3Price, signal.takeProfit3Percent,
        signal.maxHoldDays, signal.bullishSignals, signal.bearishSignals, signal.warnings,
        signal.expiresAt, signal.telegramMessageId
      ]
    );
    return result.rows[0].id;
  }

  static async getMatureSignalsToday(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM mature_token_signals
       WHERE generated_at > CURRENT_DATE`
    );
    return parseInt(result.rows[0].count);
  }

  static async getMatureSignalsLastHour(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM mature_token_signals
       WHERE generated_at > NOW() - INTERVAL '1 hour'`
    );
    return parseInt(result.rows[0].count);
  }

  static async getLastMatureSignalTime(tokenAddress: string): Promise<Date | null> {
    const result = await pool.query(
      `SELECT generated_at FROM mature_token_signals
       WHERE token_address = $1
       ORDER BY generated_at DESC LIMIT 1`,
      [tokenAddress]
    );
    return result.rows.length > 0 ? result.rows[0].generated_at : null;
  }

  static async logMatureSignalRateLimit(tokenAddress: string, signalType: string): Promise<void> {
    await pool.query(
      `INSERT INTO mature_signal_rate_limit (token_address, signal_type)
       VALUES ($1, $2)`,
      [tokenAddress, signalType]
    );
  }

  static async getActiveWatchlistTokens(): Promise<Array<{
    tokenAddress: string;
    tokenTicker: string;
    currentScore: number;
    targetScore: number;
    resistanceLevel: number;
    supportLevel: number;
    addedAt: Date;
  }>> {
    const result = await pool.query(
      `SELECT token_address, token_ticker, current_score, target_score,
              resistance_level, support_level, added_at
       FROM mature_token_watchlist
       WHERE is_active = true AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY added_at DESC`
    );
    return result.rows.map(row => ({
      tokenAddress: row.token_address,
      tokenTicker: row.token_ticker,
      currentScore: row.current_score,
      targetScore: row.target_score,
      resistanceLevel: row.resistance_level ? parseFloat(row.resistance_level) : 0,
      supportLevel: row.support_level ? parseFloat(row.support_level) : 0,
      addedAt: row.added_at,
    }));
  }

  static async addToMatureWatchlist(data: {
    tokenAddress: string;
    tokenTicker: string;
    addedReason: string;
    currentScore: number;
    targetScore: number;
    targetConditions?: string[];
    resistanceLevel?: number;
    supportLevel?: number;
    breakoutTarget?: number;
    volumeTrigger?: number;
    expiresAt?: Date;
  }): Promise<string> {
    const result = await pool.query(
      `INSERT INTO mature_token_watchlist (
        token_address, token_ticker, added_reason, current_score, target_score,
        target_conditions, resistance_level, support_level, breakout_target,
        volume_trigger, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (token_address) DO UPDATE SET
        current_score = EXCLUDED.current_score,
        last_checked_at = NOW()
      RETURNING id`,
      [
        data.tokenAddress, data.tokenTicker, data.addedReason,
        data.currentScore, data.targetScore, data.targetConditions,
        data.resistanceLevel, data.supportLevel, data.breakoutTarget,
        data.volumeTrigger, data.expiresAt
      ]
    );
    return result.rows[0].id;
  }

  static async removeFromMatureWatchlist(tokenAddress: string): Promise<void> {
    await pool.query(
      `UPDATE mature_token_watchlist SET is_active = false WHERE token_address = $1`,
      [tokenAddress]
    );
  }

  static async promoteWatchlistToSignal(tokenAddress: string, signalId: string): Promise<void> {
    await pool.query(
      `UPDATE mature_token_watchlist
       SET is_active = false, promoted_to_signal_at = NOW(), promoted_signal_id = $2
       WHERE token_address = $1`,
      [tokenAddress, signalId]
    );
  }

  static async saveMatureExitSignal(signal: {
    tokenAddress: string;
    tokenTicker: string;
    recommendation: string;
    urgency: string;
    reason: string;
    triggers?: string[];
    entryPrice?: number;
    exitPrice?: number;
    pnlPercent?: number;
    pnlUsd?: number;
    holdTimeHours?: number;
    originalSignalId?: string;
    originalSignalType?: string;
    telegramMessageId?: string;
  }): Promise<string> {
    const result = await pool.query(
      `INSERT INTO mature_token_exit_signals (
        token_address, token_ticker, recommendation, urgency, reason,
        triggers, entry_price, exit_price, pnl_percent, pnl_usd,
        hold_time_hours, original_signal_id, original_signal_type,
        telegram_message_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id`,
      [
        signal.tokenAddress, signal.tokenTicker, signal.recommendation,
        signal.urgency, signal.reason, signal.triggers,
        signal.entryPrice, signal.exitPrice, signal.pnlPercent, signal.pnlUsd,
        signal.holdTimeHours, signal.originalSignalId, signal.originalSignalType,
        signal.telegramMessageId
      ]
    );
    return result.rows[0].id;
  }

  static async getRecentMatureSignals(limit: number = 10): Promise<Array<{
    id: string;
    tokenAddress: string;
    tokenTicker: string;
    signalType: string;
    compositeScore: number;
    recommendation: string;
    generatedAt: Date;
  }>> {
    const result = await pool.query(
      `SELECT id, token_address, token_ticker, signal_type,
              composite_score, recommendation, generated_at
       FROM mature_token_signals
       ORDER BY generated_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(row => ({
      id: row.id,
      tokenAddress: row.token_address,
      tokenTicker: row.token_ticker,
      signalType: row.signal_type,
      compositeScore: row.composite_score,
      recommendation: row.recommendation,
      generatedAt: row.generated_at,
    }));
  }
}

export default Database;
