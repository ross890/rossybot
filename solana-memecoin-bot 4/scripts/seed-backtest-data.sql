-- ============================================================
-- BACKTEST SEED DATA FOR ROSSYBOT 2x SIGNAL CONVERSION ANALYSIS
-- ============================================================
-- Generates ~500 realistic token_tracking records based on:
--   - Base conversion rate ~32% ($50k -> $100k)
--   - Dev score distribution: CLEAN (40%), NEW_DEV (30%), CAUTION (20%), RED_FLAG (10%)
--   - RugCheck distribution: GOOD (60%), WARNING (30%), UNKNOWN (10%)
--   - Holder brackets: <200 (15%), 200-500 (35%), 500-1000 (30%), 1000+ (20%)
--   - Liquidity brackets: <$15k (20%), $15k-$25k (30%), $25k-$50k (30%), $50k+ (20%)
--   - Conversion rates vary by factor (CLEAN devs convert better, RED_FLAG worse, etc.)
-- ============================================================

-- Helper: Use generate_series + random() to create realistic data
-- We'll insert 500 tokens spanning the last 30 days

INSERT INTO token_tracking (
  contract_address, pair_address, ticker, deployer_wallet,
  launch_timestamp, first_50k_timestamp,
  mc_at_50k, holders_at_50k, volume_24h_at_50k, liquidity_at_50k,
  peak_mc, peak_mc_timestamp, time_50k_to_peak_minutes,
  hit_100k, hit_250k, hit_500k, hit_1m,
  time_50k_to_100k_minutes,
  rugcheck_score, mint_authority_revoked, freeze_authority_revoked, lp_locked,
  top10_holder_pct,
  dev_total_launches, dev_launches_over_100k, dev_score,
  created_at
)
SELECT
  -- Contract address (unique random hex-like string)
  'So' || md5(random()::text || i::text) || substring(md5((random()*1000)::text) from 1 for 8) as contract_address,
  -- Pair address
  'Pa' || md5(random()::text) as pair_address,
  -- Ticker (random 3-5 char)
  upper(substring(md5(random()::text) from 1 for (3 + floor(random()*3)::int))) as ticker,
  -- Deployer wallet
  'Dw' || md5(random()::text) as deployer_wallet,

  -- Launch timestamp: random time in the last 35 days
  NOW() - (random() * interval '35 days') as launch_timestamp,
  -- First 50k timestamp: 15min to 8hrs after launch
  NOW() - (random() * interval '30 days') as first_50k_timestamp,

  -- MC at 50k: around 48k-55k (they hit the 50k threshold at varying MCs)
  48000 + random() * 7000 as mc_at_50k,

  -- Holders at 50k: distributed across brackets
  CASE
    WHEN random() < 0.15 THEN floor(50 + random() * 150)::int     -- <200 bracket
    WHEN random() < 0.50 THEN floor(200 + random() * 300)::int    -- 200-500 bracket
    WHEN random() < 0.80 THEN floor(500 + random() * 500)::int    -- 500-1000 bracket
    ELSE floor(1000 + random() * 2000)::int                        -- 1000+ bracket
  END as holders_at_50k,

  -- Volume 24h at 50k: $5k to $200k
  5000 + random() * 195000 as volume_24h_at_50k,

  -- Liquidity at 50k: distributed across brackets
  CASE
    WHEN random() < 0.20 THEN 5000 + random() * 10000    -- <$15k
    WHEN random() < 0.50 THEN 15000 + random() * 10000   -- $15k-$25k
    WHEN random() < 0.80 THEN 25000 + random() * 25000   -- $25k-$50k
    ELSE 50000 + random() * 100000                         -- $50k+
  END as liquidity_at_50k,

  -- Peak MC: will set based on outcome
  NULL as peak_mc,
  NULL as peak_mc_timestamp,
  NULL as time_50k_to_peak_minutes,

  -- Outcome: temporarily FALSE, we'll update based on conversion logic
  FALSE as hit_100k,
  FALSE as hit_250k,
  FALSE as hit_500k,
  FALSE as hit_1m,
  NULL as time_50k_to_100k_minutes,

  -- RugCheck score distribution
  CASE
    WHEN random() < 0.60 THEN 'GOOD'
    WHEN random() < 0.90 THEN 'WARNING'
    ELSE NULL  -- UNKNOWN
  END as rugcheck_score,

  -- Safety flags
  random() > 0.15 as mint_authority_revoked,   -- 85% revoked
  random() > 0.10 as freeze_authority_revoked,  -- 90% revoked
  random() > 0.25 as lp_locked,                 -- 75% locked

  -- Top10 holder %
  15 + random() * 60 as top10_holder_pct,

  -- Dev scoring
  CASE
    WHEN random() < 0.10 THEN floor(1 + random() * 3)::int   -- RED_FLAG: 1-3 launches
    WHEN random() < 0.30 THEN floor(1 + random() * 5)::int   -- CAUTION: 1-5 launches
    WHEN random() < 0.60 THEN 1                                -- NEW_DEV: 1 launch
    ELSE floor(2 + random() * 10)::int                         -- CLEAN: 2-11 launches
  END as dev_total_launches,

  CASE
    WHEN random() < 0.10 THEN 0                                -- RED_FLAG
    WHEN random() < 0.30 THEN floor(random() * 2)::int        -- CAUTION
    WHEN random() < 0.60 THEN 0                                -- NEW_DEV
    ELSE floor(1 + random() * 5)::int                          -- CLEAN
  END as dev_launches_over_100k,

  -- Dev score distribution: CLEAN 40%, NEW_DEV 30%, CAUTION 20%, RED_FLAG 10%
  CASE
    WHEN random() < 0.10 THEN 'RED_FLAG'
    WHEN random() < 0.30 THEN 'CAUTION'
    WHEN random() < 0.60 THEN 'NEW_DEV'
    ELSE 'CLEAN'
  END as dev_score,

  NOW() - (random() * interval '30 days') as created_at

FROM generate_series(1, 500) as i;

-- ============================================================
-- Now apply conversion outcomes based on the 2x signal model
-- Base rate: 32%, modified by dev_score and rugcheck_score
-- ============================================================

-- CLEAN devs + GOOD rugcheck: ~42% conversion (base + dev_clean + rugcheck_good = 0.32 + 0.10 + 0 = 0.42)
UPDATE token_tracking SET
  hit_100k = TRUE,
  time_50k_to_100k_minutes = floor(5 + random() * 120)::int,
  peak_mc = 100000 + random() * 400000,
  hit_250k = random() < 0.25,
  hit_500k = random() < 0.10,
  hit_1m = random() < 0.03
WHERE dev_score = 'CLEAN' AND rugcheck_score = 'GOOD'
  AND random() < 0.42
  AND hit_100k = FALSE;

-- CLEAN devs + WARNING rugcheck: ~32% conversion (0.32 + 0.10 - 0.10 = 0.32)
UPDATE token_tracking SET
  hit_100k = TRUE,
  time_50k_to_100k_minutes = floor(10 + random() * 150)::int,
  peak_mc = 100000 + random() * 300000,
  hit_250k = random() < 0.18,
  hit_500k = random() < 0.06,
  hit_1m = random() < 0.02
WHERE dev_score = 'CLEAN' AND (rugcheck_score = 'WARNING' OR rugcheck_score IS NULL)
  AND random() < 0.32
  AND hit_100k = FALSE;

-- NEW_DEV + GOOD: ~32% conversion (0.32 + 0.00 + 0 = 0.32)
UPDATE token_tracking SET
  hit_100k = TRUE,
  time_50k_to_100k_minutes = floor(8 + random() * 180)::int,
  peak_mc = 100000 + random() * 250000,
  hit_250k = random() < 0.15,
  hit_500k = random() < 0.05,
  hit_1m = random() < 0.01
WHERE dev_score = 'NEW_DEV' AND rugcheck_score = 'GOOD'
  AND random() < 0.32
  AND hit_100k = FALSE;

-- NEW_DEV + WARNING/UNKNOWN: ~22% conversion (0.32 + 0.00 - 0.10 = 0.22)
UPDATE token_tracking SET
  hit_100k = TRUE,
  time_50k_to_100k_minutes = floor(15 + random() * 200)::int,
  peak_mc = 100000 + random() * 200000,
  hit_250k = random() < 0.10,
  hit_500k = random() < 0.03,
  hit_1m = random() < 0.005
WHERE dev_score = 'NEW_DEV' AND (rugcheck_score = 'WARNING' OR rugcheck_score IS NULL)
  AND random() < 0.22
  AND hit_100k = FALSE;

-- CAUTION + GOOD: ~24% conversion (0.32 - 0.08 + 0 = 0.24)
UPDATE token_tracking SET
  hit_100k = TRUE,
  time_50k_to_100k_minutes = floor(20 + random() * 180)::int,
  peak_mc = 100000 + random() * 200000,
  hit_250k = random() < 0.10,
  hit_500k = random() < 0.03,
  hit_1m = random() < 0.005
WHERE dev_score = 'CAUTION' AND rugcheck_score = 'GOOD'
  AND random() < 0.24
  AND hit_100k = FALSE;

-- CAUTION + WARNING/UNKNOWN: ~14% conversion (0.32 - 0.08 - 0.10 = 0.14)
UPDATE token_tracking SET
  hit_100k = TRUE,
  time_50k_to_100k_minutes = floor(30 + random() * 200)::int,
  peak_mc = 100000 + random() * 150000,
  hit_250k = random() < 0.05,
  hit_500k = random() < 0.01,
  hit_1m = FALSE
WHERE dev_score = 'CAUTION' AND (rugcheck_score = 'WARNING' OR rugcheck_score IS NULL)
  AND random() < 0.14
  AND hit_100k = FALSE;

-- RED_FLAG: 0% conversion (auto-skip in the model, sentinel -1.0)
-- These should NOT convert - leave as FALSE

-- ============================================================
-- Set peak data for non-converting tokens
-- ============================================================
UPDATE token_tracking SET
  peak_mc = 50000 + random() * 40000,  -- peaked between $50k-$90k (didn't reach $100k)
  time_50k_to_peak_minutes = floor(5 + random() * 300)::int
WHERE hit_100k = FALSE;

-- Set peak timestamps for all tokens
UPDATE token_tracking SET
  peak_mc_timestamp = first_50k_timestamp + (time_50k_to_peak_minutes || ' minutes')::interval
WHERE time_50k_to_peak_minutes IS NOT NULL AND first_50k_timestamp IS NOT NULL;

-- Set time_50k_to_peak for converting tokens (use time to 100k + some extra)
UPDATE token_tracking SET
  time_50k_to_peak_minutes = time_50k_to_100k_minutes + floor(random() * 60)::int
WHERE hit_100k = TRUE AND time_50k_to_100k_minutes IS NOT NULL;

-- ============================================================
-- Add higher-bracket holder conversion boost
-- Tokens with more holders at $50k are slightly more likely to convert
-- This models the real-world observation that more distributed tokens perform better
-- ============================================================

-- Boost: some tokens with 1000+ holders that didn't convert, flip ~15% more
UPDATE token_tracking SET
  hit_100k = TRUE,
  time_50k_to_100k_minutes = floor(10 + random() * 90)::int,
  peak_mc = 100000 + random() * 300000,
  hit_250k = random() < 0.20,
  hit_500k = random() < 0.08,
  hit_1m = random() < 0.02
WHERE holders_at_50k >= 1000 AND hit_100k = FALSE AND dev_score != 'RED_FLAG'
  AND random() < 0.15;

-- Boost: high-liquidity tokens ($50k+) that didn't convert, flip ~10% more
UPDATE token_tracking SET
  hit_100k = TRUE,
  time_50k_to_100k_minutes = floor(8 + random() * 100)::int,
  peak_mc = 100000 + random() * 350000,
  hit_250k = random() < 0.18,
  hit_500k = random() < 0.07
WHERE liquidity_at_50k >= 50000 AND hit_100k = FALSE AND dev_score != 'RED_FLAG'
  AND random() < 0.10;
