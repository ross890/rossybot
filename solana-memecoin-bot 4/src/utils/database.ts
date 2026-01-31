// ===========================================
// DATABASE CLIENT & SCHEMA
// ===========================================

import pg from 'pg';
import { appConfig } from '../config/index.js';
import { logger } from './logger.js';
import type {
  Kol,
  KolWallet,
  KolPerformance,
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
  
  static async getKolPerformance(kolId: string): Promise<KolPerformance | null> {
    const result = await pool.query(
      'SELECT * FROM kol_performance WHERE kol_id = $1',
      [kolId]
    );
    if (result.rows.length === 0) return null;
    return this.mapPerformanceRow(result.rows[0]);
  }
  
  static async updateKolPerformance(kolId: string): Promise<KolPerformance> {
    // Calculate performance from trades
    const stats = await pool.query(
      `SELECT 
         COUNT(*) as total_trades,
         COUNT(*) FILTER (WHERE is_win = true) as wins,
         COUNT(*) FILTER (WHERE is_win = false) as losses,
         AVG(roi) as avg_roi,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) as median_roi
       FROM kol_trades
       WHERE kol_id = $1 AND roi IS NOT NULL`,
      [kolId]
    );
    
    const s = stats.rows[0];
    const winRate = s.total_trades > 0 ? s.wins / s.total_trades : 0;
    
    const result = await pool.query(
      `INSERT INTO kol_performance (kol_id, total_trades, wins, losses, win_rate, avg_roi, median_roi, last_calculated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (kol_id) DO UPDATE SET
         total_trades = EXCLUDED.total_trades,
         wins = EXCLUDED.wins,
         losses = EXCLUDED.losses,
         win_rate = EXCLUDED.win_rate,
         avg_roi = EXCLUDED.avg_roi,
         median_roi = EXCLUDED.median_roi,
         last_calculated = NOW()
       RETURNING *`,
      [kolId, s.total_trades, s.wins, s.losses, winRate, s.avg_roi || 0, s.median_roi || 0]
    );
    
    return this.mapPerformanceRow(result.rows[0]);
  }
  
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
  
  private static mapPerformanceRow(row: any): KolPerformance {
    return {
      kolId: row.kol_id,
      totalTrades: row.total_trades,
      wins: row.wins,
      losses: row.losses,
      winRate: parseFloat(row.win_rate),
      avgRoi: parseFloat(row.avg_roi),
      medianRoi: parseFloat(row.median_roi),
      lastCalculated: row.last_calculated,
    };
  }
  
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
}

export default Database;
