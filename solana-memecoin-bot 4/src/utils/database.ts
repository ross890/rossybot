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

-- Wallet Source enum (verified vs manual alpha)
DO $$ BEGIN
  CREATE TYPE wallet_source AS ENUM ('VERIFIED', 'MANUAL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Alpha Wallet Status enum
DO $$ BEGIN
  CREATE TYPE alpha_wallet_status AS ENUM ('PROBATION', 'ACTIVE', 'TRUSTED', 'SUSPENDED', 'REMOVED');
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

-- ============ GRADUATION PIPELINE (Established Token Strategy v2) ============

-- Graduation Pipeline table - tracks pump.fun tokens during 21-day observation period
-- Part of Established Token Strategy v2 - repurposes pump.fun monitor as intelligence
CREATE TABLE IF NOT EXISTS graduation_pipeline (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) UNIQUE NOT NULL,
  token_name VARCHAR(200),
  ticker VARCHAR(20),

  -- Launch data (from pump.fun)
  pump_fun_mint VARCHAR(64),
  launch_timestamp TIMESTAMP,
  graduation_timestamp TIMESTAMP,

  -- Observation metrics (collected during 21-day waiting period)
  launch_bundle_percent DECIMAL(5, 2),
  dev_sell_percent DECIMAL(5, 2),
  initial_holder_count INTEGER,
  holder_retention_rate DECIMAL(5, 2),
  growth_trajectory VARCHAR(50),  -- organic, manipulated, mixed
  kol_involvement_count INTEGER DEFAULT 0,
  first_dump_recovered BOOLEAN,
  peak_market_cap DECIMAL(20, 2),
  lowest_market_cap DECIMAL(20, 2),

  -- Quality scoring (calculated at end of observation)
  graduation_quality_score INTEGER,  -- 0-100
  quality_factors JSONB,

  -- Status
  observation_start TIMESTAMP DEFAULT NOW(),
  observation_end TIMESTAMP,  -- observation_start + 21 days
  promoted_to_universe BOOLEAN DEFAULT FALSE,
  promoted_at TIMESTAMP,
  rejection_reason VARCHAR(200),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for graduation pipeline
CREATE INDEX IF NOT EXISTS idx_graduation_pipeline_promoted ON graduation_pipeline(promoted_to_universe);
CREATE INDEX IF NOT EXISTS idx_graduation_pipeline_observation ON graduation_pipeline(observation_end);
CREATE INDEX IF NOT EXISTS idx_graduation_pipeline_token ON graduation_pipeline(token_address);

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

-- ============ ALPHA WALLET TABLES ============

-- Alpha Wallets table - user-submitted wallets for tracking
CREATE TABLE IF NOT EXISTS alpha_wallets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  address VARCHAR(64) NOT NULL UNIQUE,
  label VARCHAR(100),
  source wallet_source DEFAULT 'MANUAL',
  status alpha_wallet_status DEFAULT 'PROBATION',
  added_by VARCHAR(50) NOT NULL,  -- Telegram user ID
  added_at TIMESTAMP DEFAULT NOW(),

  -- Performance metrics (rolling 30 days)
  total_trades INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  win_rate DECIMAL(5, 4) DEFAULT 0,
  avg_roi DECIMAL(10, 4) DEFAULT 0,

  -- Lifecycle tracking
  probation_ends_at TIMESTAMP,
  last_trade_at TIMESTAMP,
  last_evaluated_at TIMESTAMP,
  suspended_at TIMESTAMP,
  suspension_count INTEGER DEFAULT 0,

  -- Signal weight (0-1.0)
  signal_weight DECIMAL(3, 2) DEFAULT 0.30,

  updated_at TIMESTAMP DEFAULT NOW()
);

-- Alpha Wallet Trades table - track all trades from alpha wallets
CREATE TABLE IF NOT EXISTS alpha_wallet_trades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id UUID REFERENCES alpha_wallets(id) ON DELETE CASCADE,
  wallet_address VARCHAR(64) NOT NULL,
  token_address VARCHAR(64) NOT NULL,
  token_ticker VARCHAR(20),
  trade_type trade_type NOT NULL,
  sol_amount DECIMAL(20, 10),
  token_amount DECIMAL(30, 10),
  price_at_trade DECIMAL(30, 18),
  tx_signature VARCHAR(128) UNIQUE,
  timestamp TIMESTAMP NOT NULL,

  -- For completed round-trips (sell linked to buy)
  entry_trade_id UUID REFERENCES alpha_wallet_trades(id),
  roi DECIMAL(10, 4),
  is_win BOOLEAN,
  hold_time_hours DECIMAL(10, 2),

  created_at TIMESTAMP DEFAULT NOW()
);

-- Alpha Wallet Evaluation Log - audit trail of status changes
CREATE TABLE IF NOT EXISTS alpha_wallet_evaluations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id UUID REFERENCES alpha_wallets(id) ON DELETE CASCADE,
  wallet_address VARCHAR(64) NOT NULL,
  previous_status alpha_wallet_status,
  new_status alpha_wallet_status NOT NULL,
  win_rate DECIMAL(5, 4),
  total_trades INTEGER,
  avg_roi DECIMAL(10, 4),
  recommendation VARCHAR(20) NOT NULL,
  reason TEXT NOT NULL,
  evaluated_at TIMESTAMP DEFAULT NOW()
);

-- Alpha wallet indexes
CREATE INDEX IF NOT EXISTS idx_alpha_wallets_address ON alpha_wallets(address);
CREATE INDEX IF NOT EXISTS idx_alpha_wallets_status ON alpha_wallets(status);
CREATE INDEX IF NOT EXISTS idx_alpha_wallets_added_by ON alpha_wallets(added_by);
CREATE INDEX IF NOT EXISTS idx_alpha_wallet_trades_wallet ON alpha_wallet_trades(wallet_id);
CREATE INDEX IF NOT EXISTS idx_alpha_wallet_trades_token ON alpha_wallet_trades(token_address);
CREATE INDEX IF NOT EXISTS idx_alpha_wallet_trades_timestamp ON alpha_wallet_trades(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alpha_wallet_trades_signature ON alpha_wallet_trades(tx_signature);
CREATE INDEX IF NOT EXISTS idx_alpha_wallet_evaluations_wallet ON alpha_wallet_evaluations(wallet_id);

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

-- ============ DEPLOYMENT LOGS & PERFORMANCE DATA ============

-- Deployment log severity enum
DO $$ BEGIN
  CREATE TYPE deployment_log_severity AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Deployment log category enum
DO $$ BEGIN
  CREATE TYPE deployment_log_category AS ENUM (
    'SIGNAL',
    'TRADE',
    'KOL',
    'SAFETY',
    'DISCOVERY',
    'PERFORMANCE',
    'SYSTEM',
    'API',
    'DATABASE'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Deployment logs table - stores operational logs for analysis
CREATE TABLE IF NOT EXISTS deployment_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  severity deployment_log_severity NOT NULL DEFAULT 'INFO',
  category deployment_log_category NOT NULL DEFAULT 'SYSTEM',
  message TEXT NOT NULL,
  context JSONB,
  token_address VARCHAR(64),
  kol_handle VARCHAR(100),
  signal_id VARCHAR(100),
  error_stack TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Performance metrics snapshots - periodic system health data
CREATE TABLE IF NOT EXISTS performance_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  metric_name VARCHAR(100) NOT NULL,
  metric_value DECIMAL(20, 6) NOT NULL,
  metric_unit VARCHAR(50),
  tags JSONB,
  recorded_at TIMESTAMP DEFAULT NOW()
);

-- System health snapshots - aggregated system performance over time
CREATE TABLE IF NOT EXISTS system_health_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Signal metrics
  signals_generated_1h INTEGER DEFAULT 0,
  signals_sent_1h INTEGER DEFAULT 0,
  signals_filtered_1h INTEGER DEFAULT 0,
  avg_signal_score DECIMAL(5, 2),

  -- Trade metrics
  trades_executed_1h INTEGER DEFAULT 0,
  trade_success_rate DECIMAL(5, 4),
  avg_trade_roi DECIMAL(10, 4),

  -- KOL metrics
  active_kol_wallets INTEGER DEFAULT 0,
  kol_trades_detected_1h INTEGER DEFAULT 0,

  -- API health
  birdeye_latency_ms INTEGER,
  helius_latency_ms INTEGER,
  dexscreener_latency_ms INTEGER,
  api_error_count_1h INTEGER DEFAULT 0,

  -- Database health
  db_pool_size INTEGER,
  db_active_connections INTEGER,
  db_query_avg_ms INTEGER,

  -- Memory & CPU
  memory_usage_mb DECIMAL(10, 2),
  cpu_usage_percent DECIMAL(5, 2),

  snapshot_time TIMESTAMP DEFAULT NOW()
);

-- Win/loss analysis for strategy insights
CREATE TABLE IF NOT EXISTS trade_outcome_analysis (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address VARCHAR(64) NOT NULL,
  token_ticker VARCHAR(20),
  signal_id VARCHAR(100),

  -- Entry conditions
  entry_price DECIMAL(30, 18),
  entry_mcap DECIMAL(20, 2),
  entry_liquidity DECIMAL(20, 2),
  entry_holder_count INTEGER,
  entry_token_age_mins INTEGER,

  -- Scores at entry
  composite_score INTEGER,
  safety_score INTEGER,
  momentum_score INTEGER,

  -- KOL info
  kol_handle VARCHAR(100),
  kol_tier VARCHAR(20),

  -- Outcome
  outcome VARCHAR(20), -- WIN, LOSS, PENDING
  peak_roi DECIMAL(10, 4),
  final_roi DECIMAL(10, 4),
  hold_time_hours DECIMAL(10, 2),
  exit_reason TEXT,

  -- Analysis flags
  contributing_factors JSONB,
  warnings JSONB,

  analyzed_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for deployment logs and performance
CREATE INDEX IF NOT EXISTS idx_deployment_logs_time ON deployment_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployment_logs_severity ON deployment_logs(severity);
CREATE INDEX IF NOT EXISTS idx_deployment_logs_category ON deployment_logs(category);
CREATE INDEX IF NOT EXISTS idx_deployment_logs_token ON deployment_logs(token_address);
CREATE INDEX IF NOT EXISTS idx_deployment_logs_signal ON deployment_logs(signal_id);

CREATE INDEX IF NOT EXISTS idx_perf_metrics_name ON performance_metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_time ON performance_metrics(recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_system_health_time ON system_health_snapshots(snapshot_time DESC);

CREATE INDEX IF NOT EXISTS idx_trade_outcome_token ON trade_outcome_analysis(token_address);
CREATE INDEX IF NOT EXISTS idx_trade_outcome_time ON trade_outcome_analysis(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_outcome_outcome ON trade_outcome_analysis(outcome);
CREATE INDEX IF NOT EXISTS idx_trade_outcome_kol ON trade_outcome_analysis(kol_handle);

-- ============ SMART MONEY AUTO-DISCOVERY TABLES ============
-- Replicates KOLScan functionality: auto-discovers profitable traders

-- Smart Money Candidate Status enum
DO $$ BEGIN
  CREATE TYPE smart_money_status AS ENUM (
    'MONITORING',     -- Being monitored, collecting trade data
    'EVALUATING',     -- Has enough trades, being evaluated
    'PROMOTED',       -- Promoted to alpha wallet tracking
    'REJECTED',       -- Did not meet thresholds
    'INACTIVE'        -- No recent activity, paused monitoring
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Smart Money Discovery Source enum
DO $$ BEGIN
  CREATE TYPE discovery_source AS ENUM (
    'PUMPFUN_TRADER',      -- High-volume pump.fun trader
    'RAYDIUM_TRADER',      -- Profitable raydium trader
    'EARLY_BUYER',         -- Consistently early on winners
    'HIGH_WIN_RATE',       -- Discovered via win rate analysis
    'WHALE_TRACKER',       -- Large wallet with good performance
    'REFERRAL'             -- Referred by another smart money wallet
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Smart Money Candidates table - wallets being evaluated for tracking
CREATE TABLE IF NOT EXISTS smart_money_candidates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  address VARCHAR(64) NOT NULL UNIQUE,

  -- Discovery info
  discovery_source discovery_source NOT NULL,
  discovered_at TIMESTAMP DEFAULT NOW(),
  discovery_reason TEXT,

  -- Status
  status smart_money_status DEFAULT 'MONITORING',

  -- Performance metrics (rolling window)
  total_trades INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  win_rate DECIMAL(5, 4) DEFAULT 0,
  avg_roi DECIMAL(10, 4) DEFAULT 0,
  total_profit_sol DECIMAL(20, 10) DEFAULT 0,

  -- Quality metrics
  unique_tokens_traded INTEGER DEFAULT 0,
  avg_entry_timing_percentile DECIMAL(5, 2) DEFAULT 50, -- How early they enter (0-100, lower = earlier)
  avg_hold_time_hours DECIMAL(10, 2) DEFAULT 0,
  largest_win_roi DECIMAL(10, 4) DEFAULT 0,
  largest_loss_roi DECIMAL(10, 4) DEFAULT 0,
  consistency_score DECIMAL(5, 2) DEFAULT 0, -- Std dev of ROI, lower = more consistent

  -- Trade size metrics
  avg_trade_size_sol DECIMAL(20, 10) DEFAULT 0,
  min_trade_size_sol DECIMAL(20, 10) DEFAULT 0,
  max_trade_size_sol DECIMAL(20, 10) DEFAULT 0,

  -- Activity tracking
  first_trade_seen TIMESTAMP,
  last_trade_seen TIMESTAMP,
  monitoring_started_at TIMESTAMP DEFAULT NOW(),

  -- Evaluation results
  evaluated_at TIMESTAMP,
  evaluation_score INTEGER DEFAULT 0,
  promotion_eligible BOOLEAN DEFAULT FALSE,
  rejection_reason TEXT,

  -- Link to alpha wallet if promoted
  promoted_wallet_id UUID REFERENCES alpha_wallets(id),
  promoted_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Smart Money Trades table - tracks all observed trades from candidates
CREATE TABLE IF NOT EXISTS smart_money_trades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id UUID REFERENCES smart_money_candidates(id) ON DELETE CASCADE,
  wallet_address VARCHAR(64) NOT NULL,

  -- Token info
  token_address VARCHAR(64) NOT NULL,
  token_ticker VARCHAR(20),
  token_name VARCHAR(100),

  -- Trade details
  trade_type VARCHAR(10) NOT NULL, -- 'BUY' or 'SELL'
  sol_amount DECIMAL(20, 10),
  token_amount DECIMAL(30, 10),
  price_at_trade DECIMAL(30, 18),

  -- Timing metrics
  token_age_at_trade INTEGER, -- Token age in minutes when trade happened
  entry_percentile DECIMAL(5, 2), -- What % of holders they were (lower = earlier)

  -- Transaction
  tx_signature VARCHAR(128) UNIQUE,
  block_time TIMESTAMP NOT NULL,

  -- For round-trip tracking (sells linked to buys)
  entry_trade_id UUID REFERENCES smart_money_trades(id),
  roi DECIMAL(10, 4),
  is_win BOOLEAN,
  hold_time_hours DECIMAL(10, 2),

  created_at TIMESTAMP DEFAULT NOW()
);

-- Smart Money Evaluation Log - audit trail of evaluations
CREATE TABLE IF NOT EXISTS smart_money_evaluations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id UUID REFERENCES smart_money_candidates(id) ON DELETE CASCADE,
  wallet_address VARCHAR(64) NOT NULL,

  -- Metrics at evaluation time
  total_trades INTEGER NOT NULL,
  win_rate DECIMAL(5, 4) NOT NULL,
  avg_roi DECIMAL(10, 4) NOT NULL,
  total_profit_sol DECIMAL(20, 10),
  unique_tokens INTEGER,
  consistency_score DECIMAL(5, 2),

  -- Evaluation result
  evaluation_score INTEGER NOT NULL,
  passed_win_rate BOOLEAN NOT NULL,
  passed_min_trades BOOLEAN NOT NULL,
  passed_profit BOOLEAN NOT NULL,
  passed_consistency BOOLEAN NOT NULL,

  -- Outcome
  result VARCHAR(20) NOT NULL, -- 'PROMOTE', 'REJECT', 'CONTINUE_MONITORING'
  reason TEXT NOT NULL,

  evaluated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for smart money tables
CREATE INDEX IF NOT EXISTS idx_smart_money_address ON smart_money_candidates(address);
CREATE INDEX IF NOT EXISTS idx_smart_money_status ON smart_money_candidates(status);
CREATE INDEX IF NOT EXISTS idx_smart_money_win_rate ON smart_money_candidates(win_rate DESC);
CREATE INDEX IF NOT EXISTS idx_smart_money_last_trade ON smart_money_candidates(last_trade_seen DESC);
CREATE INDEX IF NOT EXISTS idx_smart_money_promotion ON smart_money_candidates(promotion_eligible);

CREATE INDEX IF NOT EXISTS idx_smart_money_trades_candidate ON smart_money_trades(candidate_id);
CREATE INDEX IF NOT EXISTS idx_smart_money_trades_wallet ON smart_money_trades(wallet_address);
CREATE INDEX IF NOT EXISTS idx_smart_money_trades_token ON smart_money_trades(token_address);
CREATE INDEX IF NOT EXISTS idx_smart_money_trades_time ON smart_money_trades(block_time DESC);
CREATE INDEX IF NOT EXISTS idx_smart_money_trades_sig ON smart_money_trades(tx_signature);

CREATE INDEX IF NOT EXISTS idx_smart_money_eval_candidate ON smart_money_evaluations(candidate_id);
CREATE INDEX IF NOT EXISTS idx_smart_money_eval_time ON smart_money_evaluations(evaluated_at DESC);
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

  // ============ ALPHA WALLET OPERATIONS ============

  static async createAlphaWallet(
    address: string,
    addedBy: string,
    label?: string
  ): Promise<{ id: string; isNew: boolean }> {
    // Check if wallet already exists
    const existing = await pool.query(
      'SELECT id FROM alpha_wallets WHERE address = $1',
      [address]
    );

    if (existing.rows.length > 0) {
      return { id: existing.rows[0].id, isNew: false };
    }

    const result = await pool.query(
      `INSERT INTO alpha_wallets (address, label, added_by, status, signal_weight)
       VALUES ($1, $2, $3, 'PROBATION', 0.30)
       RETURNING id`,
      [address, label || null, addedBy]
    );

    return { id: result.rows[0].id, isNew: true };
  }

  static async getAlphaWalletByAddress(address: string): Promise<any | null> {
    const result = await pool.query(
      'SELECT * FROM alpha_wallets WHERE address = $1',
      [address]
    );
    if (result.rows.length === 0) return null;
    return this.mapAlphaWalletRow(result.rows[0]);
  }

  static async getAlphaWalletById(id: string): Promise<any | null> {
    const result = await pool.query(
      'SELECT * FROM alpha_wallets WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return null;
    return this.mapAlphaWalletRow(result.rows[0]);
  }

  static async getAllAlphaWallets(includeRemoved: boolean = false): Promise<any[]> {
    const query = includeRemoved
      ? 'SELECT * FROM alpha_wallets ORDER BY added_at DESC'
      : `SELECT * FROM alpha_wallets WHERE status != 'REMOVED' ORDER BY added_at DESC`;

    const result = await pool.query(query);
    return result.rows.map(this.mapAlphaWalletRow);
  }

  static async getActiveAlphaWallets(): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM alpha_wallets
       WHERE status IN ('PROBATION', 'ACTIVE', 'TRUSTED')
       ORDER BY signal_weight DESC, win_rate DESC`
    );
    return result.rows.map(this.mapAlphaWalletRow);
  }

  static async updateAlphaWalletStatus(
    walletId: string,
    status: string,
    signalWeight: number
  ): Promise<void> {
    const updates: string[] = [
      `status = '${status}'`,
      `signal_weight = ${signalWeight}`,
      'updated_at = NOW()',
    ];

    if (status === 'SUSPENDED') {
      updates.push('suspended_at = NOW()');
      updates.push('suspension_count = suspension_count + 1');
    }

    await pool.query(
      `UPDATE alpha_wallets SET ${updates.join(', ')} WHERE id = $1`,
      [walletId]
    );
  }

  static async updateAlphaWalletPerformance(
    walletId: string,
    totalTrades: number,
    wins: number,
    losses: number,
    winRate: number,
    avgRoi: number
  ): Promise<void> {
    await pool.query(
      `UPDATE alpha_wallets SET
        total_trades = $2,
        wins = $3,
        losses = $4,
        win_rate = $5,
        avg_roi = $6,
        last_evaluated_at = NOW(),
        updated_at = NOW()
       WHERE id = $1`,
      [walletId, totalTrades, wins, losses, winRate, avgRoi]
    );
  }

  static async removeAlphaWallet(walletId: string): Promise<void> {
    await pool.query(
      `UPDATE alpha_wallets SET status = 'REMOVED', updated_at = NOW() WHERE id = $1`,
      [walletId]
    );
  }

  static async deleteAlphaWallet(walletId: string): Promise<void> {
    await pool.query('DELETE FROM alpha_wallets WHERE id = $1', [walletId]);
  }

  static async recordAlphaWalletTrade(trade: {
    walletId: string;
    walletAddress: string;
    tokenAddress: string;
    tokenTicker?: string;
    tradeType: 'BUY' | 'SELL';
    solAmount: number;
    tokenAmount: number;
    priceAtTrade: number;
    txSignature: string;
    timestamp: Date;
    entryTradeId?: string;
    roi?: number;
    isWin?: boolean;
    holdTimeHours?: number;
  }): Promise<string> {
    const result = await pool.query(
      `INSERT INTO alpha_wallet_trades (
        wallet_id, wallet_address, token_address, token_ticker,
        trade_type, sol_amount, token_amount, price_at_trade,
        tx_signature, timestamp, entry_trade_id, roi, is_win, hold_time_hours
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (tx_signature) DO NOTHING
      RETURNING id`,
      [
        trade.walletId, trade.walletAddress, trade.tokenAddress, trade.tokenTicker,
        trade.tradeType, trade.solAmount, trade.tokenAmount, trade.priceAtTrade,
        trade.txSignature, trade.timestamp, trade.entryTradeId,
        trade.roi, trade.isWin, trade.holdTimeHours
      ]
    );

    // Update last_trade_at
    await pool.query(
      `UPDATE alpha_wallets SET last_trade_at = $2, updated_at = NOW() WHERE id = $1`,
      [trade.walletId, trade.timestamp]
    );

    return result.rows[0]?.id || '';
  }

  static async getAlphaWalletTrades(
    walletId: string,
    limit: number = 100
  ): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM alpha_wallet_trades
       WHERE wallet_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [walletId, limit]
    );
    return result.rows.map(this.mapAlphaWalletTradeRow);
  }

  static async getAlphaWalletTradesInWindow(
    walletId: string,
    windowDays: number = 30
  ): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM alpha_wallet_trades
       WHERE wallet_id = $1
         AND timestamp > NOW() - INTERVAL '${windowDays} days'
       ORDER BY timestamp DESC`,
      [walletId]
    );
    return result.rows.map(this.mapAlphaWalletTradeRow);
  }

  static async getOpenBuyTrades(walletId: string, tokenAddress: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM alpha_wallet_trades
       WHERE wallet_id = $1
         AND token_address = $2
         AND trade_type = 'BUY'
         AND id NOT IN (
           SELECT entry_trade_id FROM alpha_wallet_trades
           WHERE entry_trade_id IS NOT NULL
         )
       ORDER BY timestamp ASC`,
      [walletId, tokenAddress]
    );
    return result.rows.map(this.mapAlphaWalletTradeRow);
  }

  static async logAlphaWalletEvaluation(evaluation: {
    walletId: string;
    walletAddress: string;
    previousStatus: string | null;
    newStatus: string;
    winRate: number;
    totalTrades: number;
    avgRoi: number;
    recommendation: string;
    reason: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO alpha_wallet_evaluations (
        wallet_id, wallet_address, previous_status, new_status,
        win_rate, total_trades, avg_roi, recommendation, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        evaluation.walletId, evaluation.walletAddress,
        evaluation.previousStatus, evaluation.newStatus,
        evaluation.winRate, evaluation.totalTrades, evaluation.avgRoi,
        evaluation.recommendation, evaluation.reason
      ]
    );
  }

  static async isAlphaWalletTracked(address: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM alpha_wallets WHERE address = $1 AND status != 'REMOVED'`,
      [address]
    );
    return result.rows.length > 0;
  }

  private static mapAlphaWalletRow(row: any): any {
    return {
      id: row.id,
      address: row.address,
      label: row.label,
      source: row.source,
      status: row.status,
      addedBy: row.added_by,
      addedAt: row.added_at,
      totalTrades: row.total_trades,
      wins: row.wins,
      losses: row.losses,
      winRate: parseFloat(row.win_rate) || 0,
      avgRoi: parseFloat(row.avg_roi) || 0,
      probationEndsAt: row.probation_ends_at,
      lastTradeAt: row.last_trade_at,
      lastEvaluatedAt: row.last_evaluated_at,
      suspendedAt: row.suspended_at,
      suspensionCount: row.suspension_count,
      signalWeight: parseFloat(row.signal_weight) || 0.30,
      updatedAt: row.updated_at,
    };
  }

  private static mapAlphaWalletTradeRow(row: any): any {
    return {
      id: row.id,
      walletId: row.wallet_id,
      walletAddress: row.wallet_address,
      tokenAddress: row.token_address,
      tokenTicker: row.token_ticker,
      tradeType: row.trade_type,
      solAmount: parseFloat(row.sol_amount) || 0,
      tokenAmount: parseFloat(row.token_amount) || 0,
      priceAtTrade: parseFloat(row.price_at_trade) || 0,
      txSignature: row.tx_signature,
      timestamp: row.timestamp,
      entryTradeId: row.entry_trade_id,
      roi: row.roi ? parseFloat(row.roi) : null,
      isWin: row.is_win,
      holdTimeHours: row.hold_time_hours ? parseFloat(row.hold_time_hours) : null,
      createdAt: row.created_at,
    };
  }

  // ============ SMART MONEY DISCOVERY OPERATIONS ============

  static async createSmartMoneyCandidate(
    address: string,
    discoverySource: string,
    discoveryReason?: string
  ): Promise<{ id: string; isNew: boolean }> {
    // Check if already exists
    const existing = await pool.query(
      'SELECT id, status FROM smart_money_candidates WHERE address = $1',
      [address]
    );

    if (existing.rows.length > 0) {
      // Reactivate if previously rejected/inactive
      const row = existing.rows[0];
      if (row.status === 'REJECTED' || row.status === 'INACTIVE') {
        await pool.query(
          `UPDATE smart_money_candidates
           SET status = 'MONITORING', updated_at = NOW()
           WHERE id = $1`,
          [row.id]
        );
      }
      return { id: row.id, isNew: false };
    }

    const result = await pool.query(
      `INSERT INTO smart_money_candidates (address, discovery_source, discovery_reason)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [address, discoverySource, discoveryReason]
    );

    return { id: result.rows[0].id, isNew: true };
  }

  static async getSmartMoneyCandidateByAddress(address: string): Promise<any | null> {
    const result = await pool.query(
      'SELECT * FROM smart_money_candidates WHERE address = $1',
      [address]
    );
    if (result.rows.length === 0) return null;
    return this.mapSmartMoneyCandidateRow(result.rows[0]);
  }

  static async getSmartMoneyCandidateById(id: string): Promise<any | null> {
    const result = await pool.query(
      'SELECT * FROM smart_money_candidates WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return null;
    return this.mapSmartMoneyCandidateRow(result.rows[0]);
  }

  static async getSmartMoneyCandidatesByStatus(status: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM smart_money_candidates
       WHERE status = $1
       ORDER BY win_rate DESC, total_trades DESC`,
      [status]
    );
    return result.rows.map(this.mapSmartMoneyCandidateRow);
  }

  static async getSmartMoneyCandidatesForEvaluation(minTrades: number = 10): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM smart_money_candidates
       WHERE status = 'MONITORING'
         AND total_trades >= $1
       ORDER BY total_trades DESC`,
      [minTrades]
    );
    return result.rows.map(this.mapSmartMoneyCandidateRow);
  }

  static async getPromotionEligibleCandidates(): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM smart_money_candidates
       WHERE promotion_eligible = true
         AND status = 'MONITORING'
       ORDER BY evaluation_score DESC`
    );
    return result.rows.map(this.mapSmartMoneyCandidateRow);
  }

  static async recordSmartMoneyTrade(trade: {
    candidateId: string;
    walletAddress: string;
    tokenAddress: string;
    tokenTicker?: string;
    tokenName?: string;
    tradeType: 'BUY' | 'SELL';
    solAmount: number;
    tokenAmount: number;
    priceAtTrade: number;
    tokenAgeAtTrade?: number;
    entryPercentile?: number;
    txSignature: string;
    blockTime: Date;
    entryTradeId?: string;
    roi?: number;
    isWin?: boolean;
    holdTimeHours?: number;
  }): Promise<string | null> {
    const result = await pool.query(
      `INSERT INTO smart_money_trades (
        candidate_id, wallet_address, token_address, token_ticker, token_name,
        trade_type, sol_amount, token_amount, price_at_trade,
        token_age_at_trade, entry_percentile, tx_signature, block_time,
        entry_trade_id, roi, is_win, hold_time_hours
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (tx_signature) DO NOTHING
      RETURNING id`,
      [
        trade.candidateId, trade.walletAddress, trade.tokenAddress,
        trade.tokenTicker, trade.tokenName, trade.tradeType,
        trade.solAmount, trade.tokenAmount, trade.priceAtTrade,
        trade.tokenAgeAtTrade, trade.entryPercentile, trade.txSignature, trade.blockTime,
        trade.entryTradeId, trade.roi, trade.isWin, trade.holdTimeHours
      ]
    );

    // Update candidate activity tracking
    await pool.query(
      `UPDATE smart_money_candidates SET
        last_trade_seen = $2,
        first_trade_seen = COALESCE(first_trade_seen, $2),
        updated_at = NOW()
       WHERE id = $1`,
      [trade.candidateId, trade.blockTime]
    );

    return result.rows[0]?.id || null;
  }

  static async getSmartMoneyOpenBuys(candidateId: string, tokenAddress: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM smart_money_trades
       WHERE candidate_id = $1
         AND token_address = $2
         AND trade_type = 'BUY'
         AND id NOT IN (
           SELECT entry_trade_id FROM smart_money_trades
           WHERE entry_trade_id IS NOT NULL
         )
       ORDER BY block_time ASC`,
      [candidateId, tokenAddress]
    );
    return result.rows.map(this.mapSmartMoneyTradeRow);
  }

  static async getSmartMoneyTradesInWindow(
    candidateId: string,
    windowDays: number = 30
  ): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM smart_money_trades
       WHERE candidate_id = $1
         AND block_time > NOW() - INTERVAL '${windowDays} days'
       ORDER BY block_time DESC`,
      [candidateId]
    );
    return result.rows.map(this.mapSmartMoneyTradeRow);
  }

  static async updateSmartMoneyCandidatePerformance(
    candidateId: string,
    metrics: {
      totalTrades: number;
      wins: number;
      losses: number;
      winRate: number;
      avgRoi: number;
      totalProfitSol: number;
      uniqueTokensTraded: number;
      avgEntryTimingPercentile?: number;
      avgHoldTimeHours?: number;
      largestWinRoi?: number;
      largestLossRoi?: number;
      consistencyScore?: number;
      avgTradeSizeSol?: number;
      minTradeSizeSol?: number;
      maxTradeSizeSol?: number;
    }
  ): Promise<void> {
    await pool.query(
      `UPDATE smart_money_candidates SET
        total_trades = $2,
        wins = $3,
        losses = $4,
        win_rate = $5,
        avg_roi = $6,
        total_profit_sol = $7,
        unique_tokens_traded = $8,
        avg_entry_timing_percentile = COALESCE($9, avg_entry_timing_percentile),
        avg_hold_time_hours = COALESCE($10, avg_hold_time_hours),
        largest_win_roi = COALESCE($11, largest_win_roi),
        largest_loss_roi = COALESCE($12, largest_loss_roi),
        consistency_score = COALESCE($13, consistency_score),
        avg_trade_size_sol = COALESCE($14, avg_trade_size_sol),
        min_trade_size_sol = COALESCE($15, min_trade_size_sol),
        max_trade_size_sol = COALESCE($16, max_trade_size_sol),
        updated_at = NOW()
       WHERE id = $1`,
      [
        candidateId,
        metrics.totalTrades,
        metrics.wins,
        metrics.losses,
        metrics.winRate,
        metrics.avgRoi,
        metrics.totalProfitSol,
        metrics.uniqueTokensTraded,
        metrics.avgEntryTimingPercentile,
        metrics.avgHoldTimeHours,
        metrics.largestWinRoi,
        metrics.largestLossRoi,
        metrics.consistencyScore,
        metrics.avgTradeSizeSol,
        metrics.minTradeSizeSol,
        metrics.maxTradeSizeSol
      ]
    );
  }

  static async updateSmartMoneyCandidateStatus(
    candidateId: string,
    status: string,
    evaluationScore?: number,
    promotionEligible?: boolean,
    rejectionReason?: string
  ): Promise<void> {
    await pool.query(
      `UPDATE smart_money_candidates SET
        status = $2,
        evaluation_score = COALESCE($3, evaluation_score),
        promotion_eligible = COALESCE($4, promotion_eligible),
        rejection_reason = $5,
        evaluated_at = NOW(),
        updated_at = NOW()
       WHERE id = $1`,
      [candidateId, status, evaluationScore, promotionEligible, rejectionReason]
    );
  }

  static async promoteSmartMoneyCandidate(
    candidateId: string,
    alphaWalletId: string
  ): Promise<void> {
    await pool.query(
      `UPDATE smart_money_candidates SET
        status = 'PROMOTED',
        promoted_wallet_id = $2,
        promoted_at = NOW(),
        updated_at = NOW()
       WHERE id = $1`,
      [candidateId, alphaWalletId]
    );
  }

  static async logSmartMoneyEvaluation(evaluation: {
    candidateId: string;
    walletAddress: string;
    totalTrades: number;
    winRate: number;
    avgRoi: number;
    totalProfitSol?: number;
    uniqueTokens?: number;
    consistencyScore?: number;
    evaluationScore: number;
    passedWinRate: boolean;
    passedMinTrades: boolean;
    passedProfit: boolean;
    passedConsistency: boolean;
    result: 'PROMOTE' | 'REJECT' | 'CONTINUE_MONITORING';
    reason: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO smart_money_evaluations (
        candidate_id, wallet_address, total_trades, win_rate, avg_roi,
        total_profit_sol, unique_tokens, consistency_score, evaluation_score,
        passed_win_rate, passed_min_trades, passed_profit, passed_consistency,
        result, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        evaluation.candidateId, evaluation.walletAddress, evaluation.totalTrades,
        evaluation.winRate, evaluation.avgRoi, evaluation.totalProfitSol,
        evaluation.uniqueTokens, evaluation.consistencyScore, evaluation.evaluationScore,
        evaluation.passedWinRate, evaluation.passedMinTrades, evaluation.passedProfit,
        evaluation.passedConsistency, evaluation.result, evaluation.reason
      ]
    );
  }

  static async isSmartMoneyCandidate(address: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM smart_money_candidates
       WHERE address = $1 AND status NOT IN ('REJECTED', 'INACTIVE')`,
      [address]
    );
    return result.rows.length > 0;
  }

  static async getSmartMoneyStats(): Promise<{
    totalCandidates: number;
    monitoring: number;
    promoted: number;
    rejected: number;
    avgWinRate: number;
  }> {
    const result = await pool.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'MONITORING') as monitoring,
         COUNT(*) FILTER (WHERE status = 'PROMOTED') as promoted,
         COUNT(*) FILTER (WHERE status = 'REJECTED') as rejected,
         AVG(win_rate) FILTER (WHERE total_trades >= 5) as avg_win_rate
       FROM smart_money_candidates`
    );
    const row = result.rows[0];
    return {
      totalCandidates: parseInt(row.total) || 0,
      monitoring: parseInt(row.monitoring) || 0,
      promoted: parseInt(row.promoted) || 0,
      rejected: parseInt(row.rejected) || 0,
      avgWinRate: parseFloat(row.avg_win_rate) || 0,
    };
  }

  private static mapSmartMoneyCandidateRow(row: any): any {
    return {
      id: row.id,
      address: row.address,
      discoverySource: row.discovery_source,
      discoveredAt: row.discovered_at,
      discoveryReason: row.discovery_reason,
      status: row.status,
      totalTrades: row.total_trades,
      wins: row.wins,
      losses: row.losses,
      winRate: parseFloat(row.win_rate) || 0,
      avgRoi: parseFloat(row.avg_roi) || 0,
      totalProfitSol: parseFloat(row.total_profit_sol) || 0,
      uniqueTokensTraded: row.unique_tokens_traded,
      avgEntryTimingPercentile: parseFloat(row.avg_entry_timing_percentile) || 50,
      avgHoldTimeHours: parseFloat(row.avg_hold_time_hours) || 0,
      largestWinRoi: parseFloat(row.largest_win_roi) || 0,
      largestLossRoi: parseFloat(row.largest_loss_roi) || 0,
      consistencyScore: parseFloat(row.consistency_score) || 0,
      avgTradeSizeSol: parseFloat(row.avg_trade_size_sol) || 0,
      minTradeSizeSol: parseFloat(row.min_trade_size_sol) || 0,
      maxTradeSizeSol: parseFloat(row.max_trade_size_sol) || 0,
      firstTradeSeen: row.first_trade_seen,
      lastTradeSeen: row.last_trade_seen,
      monitoringStartedAt: row.monitoring_started_at,
      evaluatedAt: row.evaluated_at,
      evaluationScore: row.evaluation_score,
      promotionEligible: row.promotion_eligible,
      rejectionReason: row.rejection_reason,
      promotedWalletId: row.promoted_wallet_id,
      promotedAt: row.promoted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private static mapSmartMoneyTradeRow(row: any): any {
    return {
      id: row.id,
      candidateId: row.candidate_id,
      walletAddress: row.wallet_address,
      tokenAddress: row.token_address,
      tokenTicker: row.token_ticker,
      tokenName: row.token_name,
      tradeType: row.trade_type,
      solAmount: parseFloat(row.sol_amount) || 0,
      tokenAmount: parseFloat(row.token_amount) || 0,
      priceAtTrade: parseFloat(row.price_at_trade) || 0,
      tokenAgeAtTrade: row.token_age_at_trade,
      entryPercentile: parseFloat(row.entry_percentile) || 50,
      txSignature: row.tx_signature,
      blockTime: row.block_time,
      entryTradeId: row.entry_trade_id,
      roi: row.roi ? parseFloat(row.roi) : null,
      isWin: row.is_win,
      holdTimeHours: row.hold_time_hours ? parseFloat(row.hold_time_hours) : null,
      createdAt: row.created_at,
    };
  }
}

export default Database;
