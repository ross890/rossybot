// ===========================================
// DATABASE MIGRATION: PUMP.FUN DEV TRACKER
// ===========================================

import { pool } from '../src/utils/database.js';

const MIGRATION_SQL = `
-- ============ PUMP.FUN DEV TRACKER TABLES ============

-- Track pump.fun deployer wallets and their performance stats
CREATE TABLE IF NOT EXISTS pumpfun_devs (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT UNIQUE NOT NULL,
  alias TEXT,
  total_launches INTEGER DEFAULT 0,
  successful_launches INTEGER DEFAULT 0,
  best_peak_mc NUMERIC DEFAULT 0,
  avg_peak_mc NUMERIC DEFAULT 0,
  rug_count INTEGER DEFAULT 0,
  success_rate NUMERIC DEFAULT 0,
  last_launch_at TIMESTAMP,
  tracked_since TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Historical record of every token launched by tracked devs
CREATE TABLE IF NOT EXISTS pumpfun_dev_tokens (
  id SERIAL PRIMARY KEY,
  dev_id INTEGER REFERENCES pumpfun_devs(id),
  token_mint TEXT NOT NULL,
  token_name TEXT,
  token_symbol TEXT,
  launched_at TIMESTAMP,
  peak_mc NUMERIC DEFAULT 0,
  current_mc NUMERIC DEFAULT 0,
  hit_200k BOOLEAN DEFAULT false,
  hit_1m BOOLEAN DEFAULT false,
  is_rugged BOOLEAN DEFAULT false,
  migrated_to_raydium BOOLEAN DEFAULT false,
  platform TEXT DEFAULT 'pumpfun',
  signal_sent BOOLEAN DEFAULT false,
  signal_sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for pumpfun dev tracker
CREATE INDEX IF NOT EXISTS idx_pumpfun_devs_wallet ON pumpfun_devs(wallet_address);
CREATE INDEX IF NOT EXISTS idx_pumpfun_devs_active ON pumpfun_devs(is_active);
CREATE INDEX IF NOT EXISTS idx_pumpfun_dev_tokens_mint ON pumpfun_dev_tokens(token_mint);
CREATE INDEX IF NOT EXISTS idx_pumpfun_dev_tokens_dev ON pumpfun_dev_tokens(dev_id);
CREATE INDEX IF NOT EXISTS idx_pumpfun_dev_tokens_launched ON pumpfun_dev_tokens(launched_at DESC);
`;

async function migrate(): Promise<void> {
  console.log('Running Pump.fun Dev Tracker migration...');

  try {
    const client = await pool.connect();
    await client.query(MIGRATION_SQL);
    client.release();

    console.log('✅ Pump.fun Dev Tracker migration complete');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
