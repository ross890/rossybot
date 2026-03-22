import { logger } from '../../utils/logger.js';
import { query, getOne, testConnection } from '../../db/database.js';
import {
  fetchGraduatedTokens24h,
  type GraduatedToken,
} from './graduated-fetcher.js';
import { findEarlyBuyersEnhanced, type EarlyBuyer } from './early-buyer-analyzer.js';
import {
  analyzeWalletConfluence,
  saveConfluenceResults,
  findRecurringHighConfluenceWallets,
  measureAlphaOverlap,
} from './wallet-confluence.js';
import {
  analyzeGraduationPatterns,
  identifyProfitableGraduations,
  segmentByMcap,
} from './pattern-analyzer.js';
import { sendDailyReport } from './report-generator.js';

/** Minimum confluence score to consider a wallet a "new discovery" */
const NEW_DISCOVERY_MIN_SCORE = 25;

/** Ensure market analyzer tables exist (idempotent) */
let tablesEnsured = false;
async function ensureTables(): Promise<void> {
  if (tablesEnsured) return;
  await query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await query(`
    CREATE TABLE IF NOT EXISTS ma_graduated_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      mint TEXT NOT NULL, symbol TEXT, name TEXT,
      pair_address TEXT, dex_id TEXT, graduated_at TIMESTAMPTZ, created_at_estimate TIMESTAMPTZ,
      time_to_graduate_mins INT,
      mcap_usd DECIMAL DEFAULT 0, liquidity_usd DECIMAL DEFAULT 0, volume_24h_usd DECIMAL DEFAULT 0, price_usd DECIMAL DEFAULT 0,
      txns_24h_buys INT DEFAULT 0, txns_24h_sells INT DEFAULT 0, buy_sell_ratio DECIMAL DEFAULT 0,
      price_change_h1 DECIMAL DEFAULT 0, price_change_h6 DECIMAL DEFAULT 0, price_change_h24 DECIMAL DEFAULT 0,
      total_early_buyers INT DEFAULT 0, known_alpha_buyers INT DEFAULT 0, known_alpha_addresses TEXT[] DEFAULT '{}',
      analysis_date DATE NOT NULL, analyzed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(mint, analysis_date)
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS ma_early_buyers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      graduated_token_id UUID REFERENCES ma_graduated_tokens(id) ON DELETE CASCADE,
      mint TEXT NOT NULL, wallet_address TEXT NOT NULL, tx_signature TEXT,
      buy_time TIMESTAMPTZ, estimated_sol_spent DECIMAL DEFAULT 0,
      is_known_alpha BOOLEAN DEFAULT FALSE, alpha_wallet_label TEXT,
      analysis_date DATE NOT NULL,
      UNIQUE(mint, wallet_address, analysis_date)
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS ma_wallet_confluence (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      wallet_address TEXT NOT NULL, analysis_date DATE NOT NULL,
      graduated_tokens_bought INT DEFAULT 0, total_graduated_tokens_analyzed INT DEFAULT 0, hit_rate DECIMAL DEFAULT 0,
      avg_buy_time_before_grad_mins DECIMAL DEFAULT 0,
      token_mints TEXT[] DEFAULT '{}',
      is_tracked_alpha BOOLEAN DEFAULT FALSE, alpha_wallet_label TEXT,
      confluence_score DECIMAL DEFAULT 0,
      UNIQUE(wallet_address, analysis_date)
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS ma_daily_summary (
      analysis_date DATE PRIMARY KEY, started_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ,
      total_graduated INT DEFAULT 0, tokens_analyzed INT DEFAULT 0, tokens_failed INT DEFAULT 0,
      avg_time_to_graduate_mins DECIMAL DEFAULT 0, median_mcap_at_graduation DECIMAL DEFAULT 0,
      avg_liquidity_usd DECIMAL DEFAULT 0, avg_volume_24h DECIMAL DEFAULT 0,
      total_unique_early_buyers INT DEFAULT 0, known_alpha_overlap_count INT DEFAULT 0, known_alpha_overlap_pct DECIMAL DEFAULT 0,
      new_high_confluence_wallets INT DEFAULT 0,
      top_confluence_wallets JSONB DEFAULT '[]', graduation_hour_distribution JSONB DEFAULT '{}',
      avg_buy_sell_ratio DECIMAL DEFAULT 0, duration_seconds INT DEFAULT 0
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_grad_tokens_date ON ma_graduated_tokens(analysis_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_grad_tokens_mint ON ma_graduated_tokens(mint)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_early_buyers_wallet ON ma_early_buyers(wallet_address)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_early_buyers_date ON ma_early_buyers(analysis_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_confluence_wallet ON ma_wallet_confluence(wallet_address)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_confluence_date ON ma_wallet_confluence(analysis_date)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ma_confluence_score ON ma_wallet_confluence(confluence_score DESC)`);
  tablesEnsured = true;
  logger.info('Market analyzer tables ensured');
}

/**
 * Run the full daily market analysis pipeline.
 *
 * This is the main entry point — designed to run once per day (end of day UTC).
 * It analyzes EVERY graduated pump.fun token from the last 24 hours.
 */
export interface AnalysisResult {
  status: 'skipped' | 'empty' | 'complete';
  message: string;
  totalGraduated: number;
  tokensAnalyzed: number;
  newDiscoveries: number;
  durationSeconds: number;
}

export async function runDailyAnalysis(opts?: { force?: boolean }): Promise<AnalysisResult> {
  const startTime = Date.now();

  // Auto-create tables on first run
  await ensureTables();

  const analysisDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  logger.info({ analysisDate }, 'Starting daily pump.fun market analysis');

  // Check if already run today
  const existing = await getOne<{ analysis_date: string }>(
    `SELECT analysis_date FROM ma_daily_summary WHERE analysis_date = $1`,
    [analysisDate],
  );
  if (existing && !opts?.force) {
    logger.warn({ analysisDate }, 'Analysis already run today — skipping (use force to re-run)');
    return { status: 'skipped', message: 'Already run today — use /market force to re-run', totalGraduated: 0, tokensAnalyzed: 0, newDiscoveries: 0, durationSeconds: 0 };
  }
  if (existing && opts?.force) {
    // Delete previous run so we can re-analyze
    await query(`DELETE FROM ma_early_buyers WHERE analysis_date = $1`, [analysisDate]);
    await query(`DELETE FROM ma_wallet_confluence WHERE analysis_date = $1`, [analysisDate]);
    await query(`DELETE FROM ma_graduated_tokens WHERE analysis_date = $1`, [analysisDate]);
    await query(`DELETE FROM ma_daily_summary WHERE analysis_date = $1`, [analysisDate]);
    logger.info({ analysisDate }, 'Force mode: cleared previous analysis');
  }

  // Create summary row
  await query(
    `INSERT INTO ma_daily_summary (analysis_date, started_at) VALUES ($1, NOW())
     ON CONFLICT (analysis_date) DO NOTHING`,
    [analysisDate],
  );

  // ===== PHASE 1: Fetch graduated tokens =====
  // Primary: Helius on-chain graduation sigs → enrich with DexScreener
  // Secondary: DexScreener token-boosts for any missed
  logger.info('Phase 1: Fetching graduated tokens (Helius + DexScreener)...');

  const graduatedTokens = await fetchGraduatedTokens24h();

  logger.info({ count: graduatedTokens.length }, 'Phase 1 complete: graduated tokens fetched');

  if (graduatedTokens.length === 0) {
    logger.warn('No graduated tokens found — ending analysis');
    await updateSummary(analysisDate, 0, 0, 0, startTime);
    const dur = Math.round((Date.now() - startTime) / 1000);
    return { status: 'empty', message: 'No graduated tokens found in last 24h — Helius may be rate-limited or no tokens graduated', totalGraduated: 0, tokensAnalyzed: 0, newDiscoveries: 0, durationSeconds: dur };
  }

  // ===== PHASE 2: Save graduated tokens & analyze early buyers =====
  logger.info('Phase 2: Analyzing early buyers...');

  const allEarlyBuyers = new Map<string, EarlyBuyer[]>();
  let tokensAnalyzed = 0;
  let tokensFailed = 0;

  for (let i = 0; i < graduatedTokens.length; i++) {
    const token = graduatedTokens[i];

    try {
      // Save graduated token to DB
      const result = await query<{ id: string }>(
        `INSERT INTO ma_graduated_tokens
           (mint, symbol, name, pair_address, dex_id, graduated_at, created_at_estimate,
            mcap_usd, liquidity_usd, volume_24h_usd, price_usd,
            txns_24h_buys, txns_24h_sells, buy_sell_ratio,
            price_change_h1, price_change_h6, price_change_h24,
            analysis_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (mint, analysis_date) DO UPDATE SET
           mcap_usd = EXCLUDED.mcap_usd,
           liquidity_usd = EXCLUDED.liquidity_usd,
           volume_24h_usd = EXCLUDED.volume_24h_usd,
           analyzed_at = NOW()
         RETURNING id`,
        [
          token.mint,
          token.symbol,
          token.name,
          token.pairAddress,
          token.dexId,
          token.pairCreatedAt > 0 ? new Date(token.pairCreatedAt) : null,
          null, // creation time estimate — would need on-chain lookup
          token.mcapUsd,
          token.liquidityUsd,
          token.volume24h,
          token.priceUsd,
          token.txns24hBuys,
          token.txns24hSells,
          token.buySellRatio,
          token.priceChangeH1,
          token.priceChangeH6,
          token.priceChangeH24,
          analysisDate,
        ],
      );

      const tokenDbId = result.rows[0]?.id;

      // Find early buyers
      const graduationTimeMs = token.pairCreatedAt || Date.now();
      const earlyBuyers = await findEarlyBuyersEnhanced(token.mint, graduationTimeMs);
      allEarlyBuyers.set(token.mint, earlyBuyers);

      // Save early buyers to DB
      for (const buyer of earlyBuyers) {
        await query(
          `INSERT INTO ma_early_buyers
             (graduated_token_id, mint, wallet_address, tx_signature, buy_time,
              estimated_sol_spent, is_known_alpha, alpha_wallet_label, analysis_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (mint, wallet_address, analysis_date) DO NOTHING`,
          [
            tokenDbId,
            token.mint,
            buyer.walletAddress,
            buyer.txSignature,
            buyer.buyTime,
            buyer.estimatedSolSpent,
            buyer.isKnownAlpha,
            buyer.alphaWalletLabel,
            analysisDate,
          ],
        );
      }

      // Update graduated token with early buyer count
      const knownAlphaBuyers = earlyBuyers.filter((b) => b.isKnownAlpha);
      await query(
        `UPDATE ma_graduated_tokens SET
           total_early_buyers = $1,
           known_alpha_buyers = $2,
           known_alpha_addresses = $3
         WHERE id = $4`,
        [
          earlyBuyers.length,
          knownAlphaBuyers.length,
          knownAlphaBuyers.map((b) => b.walletAddress),
          tokenDbId,
        ],
      );

      tokensAnalyzed++;

      // Progress log every 10 tokens
      if ((i + 1) % 10 === 0 || i === graduatedTokens.length - 1) {
        logger.info({
          progress: `${i + 1}/${graduatedTokens.length}`,
          earlyBuyers: earlyBuyers.length,
          knownAlpha: knownAlphaBuyers.length,
        }, `Analyzed: ${token.symbol}`);
      }

      // Rate limit between tokens (Helius + DexScreener)
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      tokensFailed++;
      logger.error({ err, mint: token.mint.slice(0, 8), symbol: token.symbol }, 'Failed to analyze token');
    }
  }

  logger.info({ analyzed: tokensAnalyzed, failed: tokensFailed }, 'Phase 2 complete');

  // ===== PHASE 3: Wallet confluence analysis =====
  logger.info('Phase 3: Analyzing wallet confluence...');

  const confluenceResults = await analyzeWalletConfluence(
    graduatedTokens,
    allEarlyBuyers,
    analysisDate,
  );

  await saveConfluenceResults(confluenceResults, analysisDate);

  // Count new discoveries
  const newDiscoveries = confluenceResults.filter(
    (w) => !w.isTrackedAlpha && w.confluenceScore >= NEW_DISCOVERY_MIN_SCORE,
  ).length;

  // Alpha overlap
  const alphaOverlap = await measureAlphaOverlap(allEarlyBuyers);

  logger.info({
    totalWallets: confluenceResults.length,
    newDiscoveries,
    alphaOverlap: alphaOverlap.knownAlphaCount,
  }, 'Phase 3 complete');

  // ===== PHASE 4: Pattern analysis =====
  logger.info('Phase 4: Analyzing graduation patterns...');

  const patterns = analyzeGraduationPatterns(graduatedTokens, allEarlyBuyers);
  const profitability = identifyProfitableGraduations(graduatedTokens);
  const mcapSegments = segmentByMcap(graduatedTokens);

  // Find recurring high-confluence wallets (multi-day)
  const recurringWallets = await findRecurringHighConfluenceWallets(7, 20);

  logger.info({
    profitRate: `${(profitability.profitRate * 100).toFixed(0)}%`,
    healthyGrads: patterns.healthyGraduations,
    recurringHighConfluence: recurringWallets.length,
  }, 'Phase 4 complete');

  // ===== PHASE 5: Update summary & send report =====
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  await updateSummary(analysisDate, graduatedTokens.length, tokensAnalyzed, tokensFailed, startTime, {
    patterns,
    confluenceResults,
    alphaOverlap,
    newDiscoveries,
  });

  // Send Telegram report
  await sendDailyReport({
    analysisDate,
    totalGraduated: graduatedTokens.length,
    tokensAnalyzed,
    patterns,
    topConfluenceWallets: confluenceResults.slice(0, 20),
    alphaOverlap,
    profitability,
    mcapSegments,
    newDiscoveries,
    durationSeconds,
  });

  logger.info({
    analysisDate,
    totalGraduated: graduatedTokens.length,
    tokensAnalyzed,
    tokensFailed,
    durationSeconds,
    newDiscoveries,
  }, 'Daily market analysis complete');

  return {
    status: 'complete',
    message: `Analyzed ${tokensAnalyzed} graduated tokens, found ${newDiscoveries} new high-confluence wallets`,
    totalGraduated: graduatedTokens.length,
    tokensAnalyzed,
    newDiscoveries,
    durationSeconds,
  };
}

async function updateSummary(
  analysisDate: string,
  totalGraduated: number,
  tokensAnalyzed: number,
  tokensFailed: number,
  startTime: number,
  extra?: {
    patterns: ReturnType<typeof analyzeGraduationPatterns>;
    confluenceResults: Array<{ walletAddress: string; confluenceScore: number; isTrackedAlpha: boolean }>;
    alphaOverlap: { totalUniqueEarlyBuyers: number; knownAlphaCount: number; knownAlphaPct: number };
    newDiscoveries: number;
  },
): Promise<void> {
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  const topWallets = extra?.confluenceResults
    .slice(0, 10)
    .map((w) => ({
      address: w.walletAddress.slice(0, 12),
      score: Math.round(w.confluenceScore),
      isAlpha: w.isTrackedAlpha,
    })) || [];

  await query(
    `UPDATE ma_daily_summary SET
       completed_at = NOW(),
       total_graduated = $2,
       tokens_analyzed = $3,
       tokens_failed = $4,
       avg_time_to_graduate_mins = $5,
       median_mcap_at_graduation = $6,
       avg_liquidity_usd = $7,
       avg_volume_24h = $8,
       total_unique_early_buyers = $9,
       known_alpha_overlap_count = $10,
       known_alpha_overlap_pct = $11,
       new_high_confluence_wallets = $12,
       top_confluence_wallets = $13,
       graduation_hour_distribution = $14,
       avg_buy_sell_ratio = $15,
       duration_seconds = $16
     WHERE analysis_date = $1`,
    [
      analysisDate,
      totalGraduated,
      tokensAnalyzed,
      tokensFailed,
      extra?.patterns.avgTimeToGraduateMins || 0,
      extra?.patterns.medianMcapUsd || 0,
      extra?.patterns.medianLiquidityUsd || 0,
      extra?.patterns.avgVolumeUsd || 0,
      extra?.alphaOverlap.totalUniqueEarlyBuyers || 0,
      extra?.alphaOverlap.knownAlphaCount || 0,
      extra?.alphaOverlap.knownAlphaPct || 0,
      extra?.newDiscoveries || 0,
      JSON.stringify(topWallets),
      JSON.stringify(extra?.patterns.graduationHourDistribution || {}),
      extra?.patterns.avgBuySellRatio || 0,
      durationSeconds,
    ],
  );
}
