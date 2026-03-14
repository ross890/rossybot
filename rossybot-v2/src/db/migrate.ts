import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('Running rossybot-v2 migrations...');

  await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  // 1. alpha_wallets
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alpha_wallets (
      address TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'NANSEN_SEED',
      nansen_tags TEXT[] DEFAULT '{}',
      nansen_pnl_usd DECIMAL DEFAULT 0,
      nansen_roi_percent DECIMAL DEFAULT 0,
      nansen_holding_ratio DECIMAL DEFAULT 0,
      nansen_trade_count INT DEFAULT 0,
      nansen_realized_pnl DECIMAL DEFAULT 0,
      nansen_unrealized_pnl DECIMAL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'B',
      min_capital_tier TEXT NOT NULL DEFAULT 'MICRO',
      helius_subscribed BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE,
      discovered_at TIMESTAMPTZ DEFAULT NOW(),
      last_validated_at TIMESTAMPTZ DEFAULT NOW(),
      our_total_trades INT DEFAULT 0,
      our_win_rate DECIMAL DEFAULT 0,
      our_avg_pnl_percent DECIMAL DEFAULT 0,
      our_avg_hold_time_mins INT DEFAULT 0,
      consecutive_losses INT DEFAULT 0
    )
  `);

  // 2. wallet_transactions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      wallet_address TEXT NOT NULL,
      tx_signature TEXT UNIQUE NOT NULL,
      block_time TIMESTAMPTZ NOT NULL,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      detection_lag_ms INT DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'OTHER',
      token_mint TEXT,
      token_symbol TEXT,
      amount DECIMAL DEFAULT 0,
      estimated_sol_value DECIMAL,
      raw_tx JSONB DEFAULT '{}'
    )
  `);

  // 3. signal_events
  await pool.query(`
    CREATE TABLE IF NOT EXISTS signal_events (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      wallet_addresses TEXT[] DEFAULT '{}',
      wallet_count INT DEFAULT 0,
      first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      detection_source TEXT NOT NULL DEFAULT 'HELIUS_WS',
      validation_result TEXT NOT NULL DEFAULT 'PASSED',
      validation_details JSONB DEFAULT '{}',
      momentum_data JSONB DEFAULT '{}',
      capital_tier TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      position_id UUID
    )
  `);

  // 4. positions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      entry_price DECIMAL NOT NULL,
      entry_sol DECIMAL NOT NULL,
      entry_tx TEXT,
      entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      alpha_buy_time TIMESTAMPTZ,
      execution_lag_seconds INT DEFAULT 0,
      signal_wallet TEXT,
      signal_wallet_count INT DEFAULT 1,
      capital_tier_at_entry TEXT NOT NULL,
      confluence_score DECIMAL,
      confluence_details JSONB,
      momentum_at_entry JSONB DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'OPEN',
      current_price DECIMAL DEFAULT 0,
      peak_price DECIMAL DEFAULT 0,
      pnl_sol DECIMAL DEFAULT 0,
      pnl_percent DECIMAL DEFAULT 0,
      fees_paid_sol DECIMAL DEFAULT 0,
      net_pnl_sol DECIMAL DEFAULT 0,
      exit_reason TEXT,
      partial_exits JSONB DEFAULT '[]',
      closed_at TIMESTAMPTZ,
      hold_time_mins INT
    )
  `);

  // 5. alpha_wallet_exits
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alpha_wallet_exits (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      position_id UUID REFERENCES positions(id),
      wallet_address TEXT NOT NULL,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      detection_lag_ms INT DEFAULT 0,
      sell_percentage DECIMAL DEFAULT 0,
      tx_signature TEXT NOT NULL,
      our_action TEXT,
      detection_source TEXT NOT NULL DEFAULT 'HELIUS_WS'
    )
  `);

  // 6. wallet_discovery_log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_discovery_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      run_at TIMESTAMPTZ DEFAULT NOW(),
      tokens_screened INT DEFAULT 0,
      wallets_evaluated INT DEFAULT 0,
      wallets_added INT DEFAULT 0,
      wallets_removed INT DEFAULT 0,
      details JSONB DEFAULT '{}'
    )
  `);

  // 7. daily_stats
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      date DATE PRIMARY KEY,
      starting_capital_sol DECIMAL DEFAULT 0,
      ending_capital_sol DECIMAL DEFAULT 0,
      capital_tier TEXT,
      trades_entered INT DEFAULT 0,
      trades_exited INT DEFAULT 0,
      total_pnl_sol DECIMAL DEFAULT 0,
      total_fees_sol DECIMAL DEFAULT 0,
      net_pnl_sol DECIMAL DEFAULT 0,
      win_count INT DEFAULT 0,
      loss_count INT DEFAULT 0,
      avg_hold_time_mins INT DEFAULT 0,
      avg_execution_lag_secs INT DEFAULT 0,
      avg_helius_detection_lag_ms INT DEFAULT 0,
      signals_detected INT DEFAULT 0,
      signals_skipped INT DEFAULT 0,
      alpha_exits_detected INT DEFAULT 0,
      nansen_api_calls INT DEFAULT 0,
      helius_ws_uptime_percent DECIMAL DEFAULT 100,
      helius_ws_reconnects INT DEFAULT 0
    )
  `);

  // 8. api_call_log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_call_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      status_code INT,
      duration_ms INT,
      error TEXT
    )
  `);

  // 9. ws_health
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ws_health (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      event TEXT NOT NULL,
      details JSONB DEFAULT '{}',
      reconnect_attempt INT DEFAULT 0,
      subscribed_wallets INT DEFAULT 0
    )
  `);

  // 10. capital_tier_changes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS capital_tier_changes (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      changed_at TIMESTAMPTZ DEFAULT NOW(),
      old_tier TEXT NOT NULL,
      new_tier TEXT NOT NULL,
      capital_at_change DECIMAL NOT NULL
    )
  `);

  // --- Shadow positions (Phase 1) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shadow_positions (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      entry_price DECIMAL NOT NULL,
      entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      alpha_buy_time TIMESTAMPTZ,
      signal_wallets TEXT[] DEFAULT '{}',
      capital_tier TEXT NOT NULL,
      simulated_entry_sol DECIMAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      current_price DECIMAL DEFAULT 0,
      peak_price DECIMAL DEFAULT 0,
      pnl_percent DECIMAL DEFAULT 0,
      exit_reason TEXT,
      closed_at TIMESTAMPTZ,
      hold_time_mins INT,
      partial_exits JSONB DEFAULT '[]'
    )
  `);

  // --- Indexes ---
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_address)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_token ON wallet_transactions(token_mint)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_type ON wallet_transactions(type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_signal_events_token ON signal_events(token_address)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_address)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_shadow_positions_status ON shadow_positions(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ws_health_event ON ws_health(event)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_call_log_provider ON api_call_log(provider, timestamp)`);

  console.log('✅ All migrations complete');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
