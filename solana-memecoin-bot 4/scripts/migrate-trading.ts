// ===========================================
// TRADING MODULE DATABASE MIGRATION
// Run this after the main migration
// ===========================================

import pg from 'pg';
import { config } from 'dotenv';

config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const TRADING_SCHEMA_SQL = `
-- ============ TRADING MODULE TABLES ============

-- Bot Settings table (key-value store for runtime config)
CREATE TABLE IF NOT EXISTS bot_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Token Blacklist table
CREATE TABLE IF NOT EXISTS token_blacklist (
  token_address VARCHAR(64) PRIMARY KEY,
  reason TEXT,
  added_by VARCHAR(50) DEFAULT 'manual',
  added_at TIMESTAMP DEFAULT NOW()
);

-- Position Config table (extends positions with trading strategy data)
CREATE TABLE IF NOT EXISTS position_config (
  position_id UUID PRIMARY KEY REFERENCES positions(id) ON DELETE CASCADE,
  signal_category VARCHAR(20) NOT NULL,
  tp1_sell_percent INTEGER DEFAULT 50,
  tp2_sell_percent INTEGER DEFAULT 50,
  original_stop_loss DECIMAL(30, 18),
  time_decay_applied BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Trade History table (all executed trades)
CREATE TABLE IF NOT EXISTS trade_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  position_id UUID REFERENCES positions(id) ON DELETE SET NULL,
  token_address VARCHAR(64) NOT NULL,
  token_ticker VARCHAR(20),
  trade_type VARCHAR(10) NOT NULL, -- 'BUY' or 'SELL'
  sol_amount DECIMAL(20, 10) NOT NULL,
  token_amount DECIMAL(30, 10) NOT NULL,
  price DECIMAL(30, 18) NOT NULL,
  tx_signature VARCHAR(128),
  reason TEXT,
  executed_at TIMESTAMP DEFAULT NOW()
);

-- Pending Confirmations table (for manual approval signals)
CREATE TABLE IF NOT EXISTS pending_confirmations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  signal_id VARCHAR(100) NOT NULL,
  token_address VARCHAR(64) NOT NULL,
  token_ticker VARCHAR(20),
  token_name VARCHAR(100),
  signal_type VARCHAR(30) NOT NULL,
  signal_category VARCHAR(30) NOT NULL,
  score INTEGER NOT NULL,
  current_price DECIMAL(30, 18) NOT NULL,
  suggested_sol_amount DECIMAL(20, 10),
  telegram_message_id VARCHAR(50),
  expires_at TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING', -- 'PENDING', 'CONFIRMED', 'EXPIRED', 'SKIPPED'
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

-- Trading Stats table (daily aggregates)
CREATE TABLE IF NOT EXISTS trading_stats (
  date DATE PRIMARY KEY,
  total_trades INTEGER DEFAULT 0,
  buy_trades INTEGER DEFAULT 0,
  sell_trades INTEGER DEFAULT 0,
  total_sol_spent DECIMAL(20, 10) DEFAULT 0,
  total_sol_received DECIMAL(20, 10) DEFAULT 0,
  realized_pnl DECIMAL(20, 10) DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  loss_count INTEGER DEFAULT 0,
  best_trade_pnl DECIMAL(10, 4),
  best_trade_token VARCHAR(20),
  worst_trade_pnl DECIMAL(10, 4),
  worst_trade_token VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Insert default settings
INSERT INTO bot_settings (key, value) VALUES
  ('trading_enabled', 'true'),
  ('auto_sell_enabled', 'true'),
  ('auto_buy_enabled', 'true'),
  ('max_single_trade', '10'),
  ('default_slippage', '1000'),
  ('min_trade_sol', '0.05')
ON CONFLICT (key) DO NOTHING;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_token_blacklist_address ON token_blacklist(token_address);
CREATE INDEX IF NOT EXISTS idx_trade_history_position ON trade_history(position_id);
CREATE INDEX IF NOT EXISTS idx_trade_history_token ON trade_history(token_address);
CREATE INDEX IF NOT EXISTS idx_trade_history_time ON trade_history(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_confirmations_status ON pending_confirmations(status);
CREATE INDEX IF NOT EXISTS idx_pending_confirmations_expires ON pending_confirmations(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_confirmations_token ON pending_confirmations(token_address);
CREATE INDEX IF NOT EXISTS idx_trading_stats_date ON trading_stats(date DESC);

-- Add columns to existing positions table if they don't exist
DO $$
BEGIN
  -- Add current_price if not exists
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'positions' AND column_name = 'current_price') THEN
    ALTER TABLE positions ADD COLUMN current_price DECIMAL(30, 18);
  END IF;
END $$;
`;

async function runMigration() {
  console.log('Running trading module migration...');

  try {
    await pool.query(TRADING_SCHEMA_SQL);
    console.log('Trading tables created successfully!');

    // Verify tables
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('bot_settings', 'token_blacklist', 'position_config', 'trade_history', 'pending_confirmations', 'trading_stats')
    `);

    console.log('Created/verified tables:');
    tables.rows.forEach(row => console.log(`  - ${row.table_name}`));

    // Show current settings
    const settings = await pool.query('SELECT key, value FROM bot_settings ORDER BY key');
    console.log('\nBot settings:');
    settings.rows.forEach(row => console.log(`  ${row.key}: ${row.value}`));

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
