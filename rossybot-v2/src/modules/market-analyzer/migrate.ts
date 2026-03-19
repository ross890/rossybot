import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

async function migrate() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('Running market analyzer migrations...');

  // 1. Daily graduated token snapshots — one row per graduated token per analysis run
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ma_graduated_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      mint TEXT NOT NULL,
      symbol TEXT,
      name TEXT,
      -- Graduation data
      pair_address TEXT,
      dex_id TEXT,
      graduated_at TIMESTAMPTZ,
      created_at_estimate TIMESTAMPTZ,
      time_to_graduate_mins INT,
      -- Market data at graduation snapshot
      mcap_usd DECIMAL DEFAULT 0,
      liquidity_usd DECIMAL DEFAULT 0,
      volume_24h_usd DECIMAL DEFAULT 0,
      price_usd DECIMAL DEFAULT 0,
      -- Transaction metrics
      txns_24h_buys INT DEFAULT 0,
      txns_24h_sells INT DEFAULT 0,
      buy_sell_ratio DECIMAL DEFAULT 0,
      -- Price performance post-graduation
      price_change_h1 DECIMAL DEFAULT 0,
      price_change_h6 DECIMAL DEFAULT 0,
      price_change_h24 DECIMAL DEFAULT 0,
      -- Early buyer analysis
      total_early_buyers INT DEFAULT 0,
      known_alpha_buyers INT DEFAULT 0,
      known_alpha_addresses TEXT[] DEFAULT '{}',
      -- Analysis metadata
      analysis_date DATE NOT NULL,
      analyzed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(mint, analysis_date)
    )
  `);

  // 2. Early buyers for each graduated token — who bought during bonding curve
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ma_early_buyers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      graduated_token_id UUID REFERENCES ma_graduated_tokens(id) ON DELETE CASCADE,
      mint TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      tx_signature TEXT,
      buy_time TIMESTAMPTZ,
      estimated_sol_spent DECIMAL DEFAULT 0,
      is_known_alpha BOOLEAN DEFAULT FALSE,
      alpha_wallet_label TEXT,
      analysis_date DATE NOT NULL,
      UNIQUE(mint, wallet_address, analysis_date)
    )
  `);

  // 3. Wallet confluence — aggregated stats per wallet across graduated tokens
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ma_wallet_confluence (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      wallet_address TEXT NOT NULL,
      analysis_date DATE NOT NULL,
      -- How many graduated tokens this wallet bought early
      graduated_tokens_bought INT DEFAULT 0,
      total_graduated_tokens_analyzed INT DEFAULT 0,
      hit_rate DECIMAL DEFAULT 0,
      -- Average timing
      avg_buy_time_before_grad_mins DECIMAL DEFAULT 0,
      -- Token mints this wallet bought
      token_mints TEXT[] DEFAULT '{}',
      -- Is this wallet already tracked by rossybot?
      is_tracked_alpha BOOLEAN DEFAULT FALSE,
      alpha_wallet_label TEXT,
      -- Scoring
      confluence_score DECIMAL DEFAULT 0,
      UNIQUE(wallet_address, analysis_date)
    )
  `);

  // 4. Daily analysis summary — one row per day
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ma_daily_summary (
      analysis_date DATE PRIMARY KEY,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      -- Counts
      total_graduated INT DEFAULT 0,
      tokens_analyzed INT DEFAULT 0,
      tokens_failed INT DEFAULT 0,
      -- Aggregate metrics
      avg_time_to_graduate_mins DECIMAL DEFAULT 0,
      median_mcap_at_graduation DECIMAL DEFAULT 0,
      avg_liquidity_usd DECIMAL DEFAULT 0,
      avg_volume_24h DECIMAL DEFAULT 0,
      -- Alpha wallet overlap
      total_unique_early_buyers INT DEFAULT 0,
      known_alpha_overlap_count INT DEFAULT 0,
      known_alpha_overlap_pct DECIMAL DEFAULT 0,
      -- New wallet discoveries
      new_high_confluence_wallets INT DEFAULT 0,
      -- Top patterns
      top_confluence_wallets JSONB DEFAULT '[]',
      graduation_hour_distribution JSONB DEFAULT '{}',
      avg_buy_sell_ratio DECIMAL DEFAULT 0,
      -- Performance
      duration_seconds INT DEFAULT 0
    )
  `);

  // Indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ma_grad_tokens_date ON ma_graduated_tokens(analysis_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ma_grad_tokens_mint ON ma_graduated_tokens(mint)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ma_early_buyers_wallet ON ma_early_buyers(wallet_address)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ma_early_buyers_date ON ma_early_buyers(analysis_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ma_confluence_wallet ON ma_wallet_confluence(wallet_address)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ma_confluence_date ON ma_wallet_confluence(analysis_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ma_confluence_score ON ma_wallet_confluence(confluence_score DESC)`);

  console.log('Market analyzer migrations complete');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Market analyzer migration failed:', err);
  process.exit(1);
});
