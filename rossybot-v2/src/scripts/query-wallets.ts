#!/usr/bin/env tsx
/**
 * Direct database query tool for wallet inspection and debugging.
 *
 * Usage:
 *   npx tsx src/scripts/query-wallets.ts                  # Show all active wallets with performance
 *   npx tsx src/scripts/query-wallets.ts --all            # Include inactive wallets
 *   npx tsx src/scripts/query-wallets.ts --sql "SELECT ..." # Run arbitrary SQL query
 *   npx tsx src/scripts/query-wallets.ts --top 20         # Show top 20 by score
 *   npx tsx src/scripts/query-wallets.ts --losers         # Show wallets that would be filtered
 *
 * Requires DATABASE_URL in .env
 */

import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set in .env');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

async function main() {
  const args = process.argv.slice(2);

  try {
    if (args.includes('--sql')) {
      const sqlIdx = args.indexOf('--sql');
      const sql = args[sqlIdx + 1];
      if (!sql) { console.error('Provide SQL after --sql'); process.exit(1); }
      const result = await pool.query(sql);
      console.table(result.rows);
      console.log(`${result.rowCount} row(s)`);
      return;
    }

    if (args.includes('--losers')) {
      const result = await pool.query(`
        SELECT address, label, source, active,
               COALESCE(our_total_trades, 0) as trades,
               ROUND(COALESCE(our_win_rate, 0) * 100) as "WR%",
               ROUND(COALESCE(our_avg_pnl_percent, 0) * 100, 1) as "avgPnL%",
               COALESCE(consecutive_losses, 0) as consL,
               COALESCE(short_term_alpha_score, 0) as alpha,
               COALESCE(round_trips_analyzed, 0) as rounds,
               COALESCE(median_hold_time_mins, 0) as "holdMins"
        FROM alpha_wallets
        WHERE COALESCE(our_total_trades, 0) >= 3
          AND (
            COALESCE(our_win_rate, 0) < 0.40
            OR COALESCE(our_avg_pnl_percent, 0) < -0.05
            OR COALESCE(consecutive_losses, 0) >= 2
            OR (COALESCE(round_trips_analyzed, 0) >= 3 AND COALESCE(short_term_alpha_score, 0) < 15)
          )
        ORDER BY COALESCE(our_win_rate, 0) ASC
      `);
      console.log('\n=== WALLETS THAT WOULD BE FILTERED (bad quality) ===\n');
      console.table(result.rows);
      console.log(`${result.rowCount} wallet(s) with bad track records`);
      return;
    }

    const showAll = args.includes('--all');
    const topIdx = args.indexOf('--top');
    const limit = topIdx >= 0 ? parseInt(args[topIdx + 1]) || 50 : 200;

    const activeFilter = showAll ? '' : 'WHERE active = TRUE';
    const result = await pool.query(`
      SELECT
        address,
        label,
        source,
        active,
        pumpfun_only as pf,
        tier,
        COALESCE(our_total_trades, 0) as trades,
        ROUND(COALESCE(our_win_rate, 0) * 100) as "WR%",
        ROUND(COALESCE(our_avg_pnl_percent, 0) * 100, 1) as "avgPnL%",
        COALESCE(consecutive_losses, 0) as "consL",
        COALESCE(short_term_alpha_score, 0) as alpha,
        COALESCE(round_trips_analyzed, 0) as rounds,
        COALESCE(median_hold_time_mins, 0) as "holdMins",
        ROUND(COALESCE(nansen_pnl_usd, 0)) as "nansenPnL",
        ROUND(COALESCE(nansen_roi_percent, 0)) as "nansenROI",
        CASE
          WHEN last_active_at IS NOT NULL
          THEN ROUND(EXTRACT(EPOCH FROM (NOW() - last_active_at)) / 3600)
          ELSE NULL
        END as "lastActiveH"
      FROM alpha_wallets
      ${activeFilter}
      ORDER BY
        COALESCE(our_total_trades, 0) DESC,
        COALESCE(our_win_rate, 0) DESC
      LIMIT $1
    `, [limit]);

    const activeCount = await pool.query('SELECT COUNT(*) as c FROM alpha_wallets WHERE active = TRUE');
    const totalCount = await pool.query('SELECT COUNT(*) as c FROM alpha_wallets');

    console.log(`\n=== WALLET ROSTER (${showAll ? 'all' : 'active only'}) ===`);
    console.log(`Active: ${activeCount.rows[0].c} / Total: ${totalCount.rows[0].c}\n`);
    console.table(result.rows);

    // Summary stats
    const withTrades = result.rows.filter((r: Record<string, number>) => r.trades > 0);
    if (withTrades.length > 0) {
      const avgWR = withTrades.reduce((s: number, r: Record<string, number>) => s + Number(r['WR%']), 0) / withTrades.length;
      const avgPnL = withTrades.reduce((s: number, r: Record<string, number>) => s + Number(r['avgPnL%']), 0) / withTrades.length;
      console.log(`\nWallets with trade data: ${withTrades.length}`);
      console.log(`Avg WR: ${avgWR.toFixed(1)}% | Avg PnL: ${avgPnL.toFixed(1)}%`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
