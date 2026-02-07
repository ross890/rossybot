// ===========================================
// DATABASE MIGRATION: 2x Probability & Dev Scoring
// Creates token_tracking, dev_wallet_cache, and api_log tables
// ===========================================

import { config } from 'dotenv';
config();

import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

const MIGRATION_SQL = `
-- ============ API CALL LOGGING ============
-- For monitoring rate limits and debugging across all services

CREATE TABLE IF NOT EXISTS api_log (
  id SERIAL PRIMARY KEY,
  service VARCHAR(32),
  endpoint VARCHAR(256),
  status_code INTEGER,
  response_time_ms INTEGER,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_log_service ON api_log(service, timestamp);

-- Auto-purge old logs (keep 7 days)
-- Run manually or via cron: DELETE FROM api_log WHERE timestamp < NOW() - INTERVAL '7 days';

-- ============ CORE TOKEN TRACKING TABLE ============
-- Tracks tokens that hit $50k MC for backtesting 2x conversion rate

CREATE TABLE IF NOT EXISTS token_tracking (
  id SERIAL PRIMARY KEY,
  contract_address VARCHAR(64) NOT NULL UNIQUE,
  pair_address VARCHAR(64),
  ticker VARCHAR(32),
  deployer_wallet VARCHAR(64),

  -- Launch data
  launch_timestamp TIMESTAMPTZ,

  -- $50k milestone
  first_50k_timestamp TIMESTAMPTZ,
  mc_at_50k NUMERIC,
  holders_at_50k INTEGER,
  volume_24h_at_50k NUMERIC,
  liquidity_at_50k NUMERIC,

  -- Peak data
  peak_mc NUMERIC,
  peak_mc_timestamp TIMESTAMPTZ,
  time_50k_to_peak_minutes INTEGER,

  -- Outcome flags
  hit_100k BOOLEAN DEFAULT FALSE,
  hit_250k BOOLEAN DEFAULT FALSE,
  hit_500k BOOLEAN DEFAULT FALSE,
  hit_1m BOOLEAN DEFAULT FALSE,
  time_50k_to_100k_minutes INTEGER,

  -- RugCheck results (Layer 1)
  rugcheck_score VARCHAR(16),
  mint_authority_revoked BOOLEAN,
  freeze_authority_revoked BOOLEAN,
  lp_locked BOOLEAN,
  top10_holder_pct NUMERIC,
  rugcheck_raw JSONB,

  -- Dev scoring (Layer 2)
  dev_total_launches INTEGER,
  dev_launches_over_100k INTEGER,
  dev_score VARCHAR(16),

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tt_deployer ON token_tracking(deployer_wallet);
CREATE INDEX IF NOT EXISTS idx_tt_hit_100k ON token_tracking(hit_100k);
CREATE INDEX IF NOT EXISTS idx_tt_first_50k ON token_tracking(first_50k_timestamp);
CREATE INDEX IF NOT EXISTS idx_tt_dev_score ON token_tracking(dev_score);
CREATE INDEX IF NOT EXISTS idx_tt_contract ON token_tracking(contract_address);

-- ============ DEV WALLET HISTORY CACHE ============
-- Caches deployer wallet analysis to avoid re-fetching (TTL: 24 hours)

CREATE TABLE IF NOT EXISTS dev_wallet_cache (
  deployer_wallet VARCHAR(64) PRIMARY KEY,
  total_launches INTEGER,
  launches_over_100k INTEGER,
  known_tokens JSONB,
  dev_score VARCHAR(16),
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- ============ 2x PROBABILITY CONFIG TABLE ============
-- Stores configurable base rates and modifier weights
-- Easily tunable without code changes

CREATE TABLE IF NOT EXISTS probability_config (
  key VARCHAR(64) PRIMARY KEY,
  value NUMERIC NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default configuration values
INSERT INTO probability_config (key, value, description) VALUES
  ('base_rate', 0.32, 'Base conversion rate: % of tokens hitting $50k that reach $100k'),
  ('mod_dev_red_flag', -1.0, 'Dev RED_FLAG: auto-skip (sentinel value)'),
  ('mod_dev_caution', -0.08, 'Dev CAUTION modifier'),
  ('mod_dev_clean', 0.10, 'Dev CLEAN modifier'),
  ('mod_dev_new', 0.00, 'Dev NEW_DEV modifier (neutral)'),
  ('mod_rugcheck_warning', -0.10, 'RugCheck WARNING (non-critical) modifier'),
  ('mod_rugcheck_good', 0.00, 'RugCheck GOOD modifier'),
  ('mod_holder_velocity_positive', 0.10, 'Holder velocity >15% in 30min'),
  ('mod_holder_velocity_negative', -0.05, 'Holder velocity flat/declining'),
  ('mod_volume_acceleration', 0.08, 'Volume >3x rolling average'),
  ('mod_kol_buy_detected', 0.12, 'KOL buy detected in last 1hr'),
  ('mod_liquidity_high', 0.05, 'LP > $25k'),
  ('mod_liquidity_low', -0.05, 'LP < $15k'),
  ('min_probability_threshold', 0.30, 'Minimum probability to fire alert'),
  ('high_confidence_threshold', 0.45, 'Threshold for HIGH confidence'),
  ('alert_cooldown_hours', 4, 'Hours between alerts for same token'),
  ('max_alerts_per_hour', 10, 'Maximum alerts per hour across all signals')
ON CONFLICT (key) DO NOTHING;

-- ============ HELPER FUNCTION ============
-- Auto-update updated_at timestamp

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to token_tracking
DROP TRIGGER IF EXISTS update_token_tracking_updated_at ON token_tracking;
CREATE TRIGGER update_token_tracking_updated_at
  BEFORE UPDATE ON token_tracking
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

async function migrate() {
  console.log('Running 2x Probability & Dev Scoring migration...');

  const client = await pool.connect();
  try {
    await client.query(MIGRATION_SQL);
    console.log('Migration complete. Tables created:');
    console.log('  - api_log');
    console.log('  - token_tracking');
    console.log('  - dev_wallet_cache');
    console.log('  - probability_config');

    // Verify tables exist
    const result = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('api_log', 'token_tracking', 'dev_wallet_cache', 'probability_config')
      ORDER BY table_name
    `);
    console.log('\nVerified tables:', result.rows.map(r => r.table_name).join(', '));
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
