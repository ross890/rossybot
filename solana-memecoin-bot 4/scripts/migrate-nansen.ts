// ===========================================
// DATABASE MIGRATION — NANSEN INTEGRATION
// Adds Nansen-specific columns to engine_wallets and signal_log
// ===========================================

import { pool } from '../src/utils/database.js';

const NANSEN_MIGRATION_SQL = `
-- ============ NANSEN COLUMNS ON ENGINE WALLETS ============

-- Nansen label (e.g., 'Smart Trader', '30D Smart Trader', 'Fund')
ALTER TABLE engine_wallets ADD COLUMN IF NOT EXISTS nansen_label VARCHAR(50);

-- Nansen 30-day PnL (USD, realized)
ALTER TABLE engine_wallets ADD COLUMN IF NOT EXISTS nansen_pnl_30d DECIMAL(15,2);

-- Nansen win rate (0.00 to 1.00)
ALTER TABLE engine_wallets ADD COLUMN IF NOT EXISTS nansen_win_rate DECIMAL(5,4);

-- Number of tokens traded (from Nansen profiler)
ALTER TABLE engine_wallets ADD COLUMN IF NOT EXISTS nansen_token_count INTEGER;

-- Top 5 tokens by PnL (JSON array)
ALTER TABLE engine_wallets ADD COLUMN IF NOT EXISTS nansen_top5_tokens JSONB;

-- Average buy size in USD
ALTER TABLE engine_wallets ADD COLUMN IF NOT EXISTS nansen_avg_buy_size DECIMAL(15,2);

-- Last time Nansen data was refreshed
ALTER TABLE engine_wallets ADD COLUMN IF NOT EXISTS nansen_last_refreshed TIMESTAMP;

-- Whether this wallet is eligible for fast-track graduation
ALTER TABLE engine_wallets ADD COLUMN IF NOT EXISTS fast_track_eligible BOOLEAN DEFAULT FALSE;

-- ============ NANSEN COLUMNS ON SIGNAL_LOG ============

-- Nansen flow enrichment bonus applied to scoring
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS nansen_flow_bonus INTEGER DEFAULT 0;

-- Number of Nansen-labelled smart traders in token flow
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS nansen_smart_trader_count INTEGER;

-- Number of Nansen-labelled whales in token flow
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS nansen_whale_count INTEGER;

-- Exchange net flow (negative = accumulation off exchange, bullish)
ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS nansen_exchange_net_flow DECIMAL(15,2);
`;

async function migrateNansen(): Promise<void> {
  console.log('Running Nansen integration migration...');

  try {
    const client = await pool.connect();
    await client.query(NANSEN_MIGRATION_SQL);
    client.release();

    console.log('✅ Nansen migration complete');
    console.log('   Added columns to engine_wallets:');
    console.log('     - nansen_label, nansen_pnl_30d, nansen_win_rate');
    console.log('     - nansen_token_count, nansen_top5_tokens, nansen_avg_buy_size');
    console.log('     - nansen_last_refreshed, fast_track_eligible');
    console.log('   Added columns to signal_log:');
    console.log('     - nansen_flow_bonus, nansen_smart_trader_count');
    console.log('     - nansen_whale_count, nansen_exchange_net_flow');
  } catch (error) {
    console.error('❌ Nansen migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrateNansen();
