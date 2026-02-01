// ===========================================
// SCRIPT: Query Today's Performance Data
// Analyzes signal performance for threshold optimization
// ===========================================

import pg from 'pg';
import { config } from 'dotenv';

config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

interface SignalData {
  signal_id: string;
  token_address: string;
  token_ticker: string;
  signal_type: string;
  entry_price: string;
  entry_mcap: string;
  momentum_score: string;
  onchain_score: string;
  safety_score: string;
  bundle_risk_score: string;
  signal_strength: string;
  entry_liquidity: string;
  entry_token_age: string;
  entry_holder_count: string;
  entry_top10_concentration: string;
  entry_buy_sell_ratio: string;
  entry_unique_buyers: string;
  signal_time: Date;
  return_1h: string | null;
  return_4h: string | null;
  return_24h: string | null;
  max_return: string | null;
  min_return: string | null;
  final_return: string | null;
  hit_stop_loss: boolean;
  hit_take_profit: boolean;
  final_outcome: string;
}

async function queryTodayPerformance() {
  console.log('\n' + '='.repeat(60));
  console.log('ROSSYBOT PERFORMANCE ANALYSIS - TODAY');
  console.log('='.repeat(60) + '\n');

  try {
    // Get today's signals
    const todayResult = await pool.query(`
      SELECT * FROM signal_performance
      WHERE signal_time > CURRENT_DATE
      ORDER BY signal_time DESC
    `);

    // Get last 24 hours for more context
    const last24hResult = await pool.query(`
      SELECT * FROM signal_performance
      WHERE signal_time > NOW() - INTERVAL '24 hours'
      ORDER BY signal_time DESC
    `);

    // Get completed signals from last 7 days for correlation analysis
    const completedResult = await pool.query(`
      SELECT * FROM signal_performance
      WHERE final_outcome IN ('WIN', 'LOSS')
      AND signal_time > NOW() - INTERVAL '7 days'
      ORDER BY signal_time DESC
    `);

    const todaySignals: SignalData[] = todayResult.rows;
    const last24hSignals: SignalData[] = last24hResult.rows;
    const completedSignals: SignalData[] = completedResult.rows;

    // ============ TODAY'S SUMMARY ============
    console.log('TODAY\'S SIGNALS');
    console.log('-'.repeat(40));
    console.log(`Total Signals: ${todaySignals.length}`);

    if (todaySignals.length > 0) {
      const byType = groupBy(todaySignals, 'signal_type');
      const byStrength = groupBy(todaySignals, 'signal_strength');

      console.log('\nBy Type:');
      for (const [type, signals] of Object.entries(byType)) {
        console.log(`  ${type}: ${signals.length}`);
      }

      console.log('\nBy Strength:');
      for (const [strength, signals] of Object.entries(byStrength)) {
        console.log(`  ${strength}: ${signals.length}`);
      }

      // List today's signals
      console.log('\nToday\'s Signal Details:');
      console.log('-'.repeat(80));
      for (const signal of todaySignals) {
        const returnStr = signal.final_return
          ? `${parseFloat(signal.final_return).toFixed(1)}%`
          : (signal.max_return ? `Max: ${parseFloat(signal.max_return).toFixed(1)}%` : 'Tracking...');
        const outcome = signal.final_outcome || 'PENDING';
        console.log(
          `  ${signal.token_ticker?.padEnd(10) || 'N/A'} | ` +
          `${signal.signal_type.padEnd(10)} | ` +
          `Str: ${signal.signal_strength?.padEnd(8) || 'N/A'} | ` +
          `OnChain: ${parseFloat(signal.onchain_score || '0').toFixed(0).padStart(3)} | ` +
          `Mom: ${parseFloat(signal.momentum_score || '0').toFixed(0).padStart(3)} | ` +
          `Safety: ${parseFloat(signal.safety_score || '0').toFixed(0).padStart(3)} | ` +
          `Bundle: ${parseFloat(signal.bundle_risk_score || '0').toFixed(0).padStart(3)} | ` +
          `${outcome.padEnd(7)} | ${returnStr}`
        );
      }
    }

    // ============ LAST 24H PERFORMANCE ============
    console.log('\n\n' + '='.repeat(60));
    console.log('LAST 24 HOURS PERFORMANCE');
    console.log('='.repeat(60));

    const completed24h = last24hSignals.filter(s => s.final_outcome === 'WIN' || s.final_outcome === 'LOSS');
    const wins24h = completed24h.filter(s => s.final_outcome === 'WIN');
    const losses24h = completed24h.filter(s => s.final_outcome === 'LOSS');

    console.log(`\nTotal: ${last24hSignals.length} | Completed: ${completed24h.length} | Pending: ${last24hSignals.length - completed24h.length}`);
    console.log(`Wins: ${wins24h.length} | Losses: ${losses24h.length} | Win Rate: ${completed24h.length > 0 ? ((wins24h.length / completed24h.length) * 100).toFixed(1) : 0}%`);

    if (completed24h.length > 0) {
      const avgReturn = completed24h.reduce((sum, s) => sum + parseFloat(s.final_return || '0'), 0) / completed24h.length;
      const avgWinReturn = wins24h.length > 0 ? wins24h.reduce((sum, s) => sum + parseFloat(s.final_return || '0'), 0) / wins24h.length : 0;
      const avgLossReturn = losses24h.length > 0 ? losses24h.reduce((sum, s) => sum + parseFloat(s.final_return || '0'), 0) / losses24h.length : 0;

      console.log(`\nReturns:`);
      console.log(`  Average: ${avgReturn.toFixed(1)}%`);
      console.log(`  Avg Win: ${avgWinReturn.toFixed(1)}%`);
      console.log(`  Avg Loss: ${avgLossReturn.toFixed(1)}%`);
    }

    // ============ 7-DAY FACTOR ANALYSIS ============
    if (completedSignals.length >= 5) {
      console.log('\n\n' + '='.repeat(60));
      console.log('7-DAY FACTOR CORRELATION ANALYSIS');
      console.log('='.repeat(60));

      const wins = completedSignals.filter(s => s.final_outcome === 'WIN');
      const losses = completedSignals.filter(s => s.final_outcome === 'LOSS');

      console.log(`\nData: ${completedSignals.length} completed signals (${wins.length} wins, ${losses.length} losses)`);
      console.log(`Win Rate: ${((wins.length / completedSignals.length) * 100).toFixed(1)}%`);

      // Factor Analysis
      const factors = [
        { name: 'Momentum Score', field: 'momentum_score', higherBetter: true },
        { name: 'OnChain Score', field: 'onchain_score', higherBetter: true },
        { name: 'Safety Score', field: 'safety_score', higherBetter: true },
        { name: 'Bundle Risk', field: 'bundle_risk_score', higherBetter: false },
        { name: 'Liquidity', field: 'entry_liquidity', higherBetter: true },
        { name: 'Token Age (min)', field: 'entry_token_age', higherBetter: null },
        { name: 'Holder Count', field: 'entry_holder_count', higherBetter: true },
        { name: 'Top10 Conc %', field: 'entry_top10_concentration', higherBetter: false },
        { name: 'Buy/Sell Ratio', field: 'entry_buy_sell_ratio', higherBetter: true },
        { name: 'Unique Buyers', field: 'entry_unique_buyers', higherBetter: true },
      ];

      console.log('\nFactor Comparison (Winning vs Losing Signals):');
      console.log('-'.repeat(80));
      console.log('Factor'.padEnd(20) + 'Win Avg'.padStart(12) + 'Loss Avg'.padStart(12) + 'Diff'.padStart(12) + 'Signal'.padStart(12));
      console.log('-'.repeat(80));

      for (const factor of factors) {
        const winAvg = average(wins.map(s => parseFloat((s as any)[factor.field] || '0')));
        const lossAvg = average(losses.map(s => parseFloat((s as any)[factor.field] || '0')));
        const diff = winAvg - lossAvg;

        let signal = '';
        if (factor.higherBetter === true) {
          signal = diff > 5 ? '++ RAISE MIN' : diff < -5 ? '-- CHECK' : '~ OK';
        } else if (factor.higherBetter === false) {
          signal = diff < -5 ? '++ LOWER MAX' : diff > 5 ? '-- CHECK' : '~ OK';
        } else {
          signal = Math.abs(diff) > 10 ? '? REVIEW' : '~ OK';
        }

        console.log(
          factor.name.padEnd(20) +
          winAvg.toFixed(1).padStart(12) +
          lossAvg.toFixed(1).padStart(12) +
          (diff >= 0 ? '+' : '') + diff.toFixed(1).padStart(11) +
          signal.padStart(12)
        );
      }

      // ============ THRESHOLD RECOMMENDATIONS ============
      console.log('\n\n' + '='.repeat(60));
      console.log('THRESHOLD OPTIMIZATION RECOMMENDATIONS');
      console.log('='.repeat(60));

      const currentThresholds = {
        minMomentumScore: 35,
        minOnChainScore: 45,
        minSafetyScore: 50,
        maxBundleRiskScore: 50,
        minLiquidity: 15000,
        maxTop10Concentration: 50,
      };

      console.log('\nCurrent Thresholds:');
      console.log(`  Min Momentum Score: ${currentThresholds.minMomentumScore}`);
      console.log(`  Min OnChain Score: ${currentThresholds.minOnChainScore}`);
      console.log(`  Min Safety Score: ${currentThresholds.minSafetyScore}`);
      console.log(`  Max Bundle Risk: ${currentThresholds.maxBundleRiskScore}`);
      console.log(`  Min Liquidity: $${currentThresholds.minLiquidity.toLocaleString()}`);
      console.log(`  Max Top10 Concentration: ${currentThresholds.maxTop10Concentration}%`);

      // Generate recommendations
      const winRate = (wins.length / completedSignals.length) * 100;
      console.log('\nRecommendations:');

      if (winRate < 25) {
        console.log('  [!] Win rate below 25% - Consider TIGHTENING thresholds');

        // Specific recommendations based on factor analysis
        const winMomentum = average(wins.map(s => parseFloat(s.momentum_score || '0')));
        const lossMomentum = average(losses.map(s => parseFloat(s.momentum_score || '0')));
        if (winMomentum > lossMomentum + 10) {
          console.log(`  [+] Raise Min Momentum: ${currentThresholds.minMomentumScore} -> ${Math.round(winMomentum - 10)}`);
        }

        const winOnChain = average(wins.map(s => parseFloat(s.onchain_score || '0')));
        const lossOnChain = average(losses.map(s => parseFloat(s.onchain_score || '0')));
        if (winOnChain > lossOnChain + 10) {
          console.log(`  [+] Raise Min OnChain: ${currentThresholds.minOnChainScore} -> ${Math.round(winOnChain - 10)}`);
        }

        const winSafety = average(wins.map(s => parseFloat(s.safety_score || '0')));
        const lossSafety = average(losses.map(s => parseFloat(s.safety_score || '0')));
        if (winSafety > lossSafety + 10) {
          console.log(`  [+] Raise Min Safety: ${currentThresholds.minSafetyScore} -> ${Math.round(winSafety - 10)}`);
        }

        const winBundle = average(wins.map(s => parseFloat(s.bundle_risk_score || '0')));
        const lossBundle = average(losses.map(s => parseFloat(s.bundle_risk_score || '0')));
        if (winBundle < lossBundle - 10) {
          console.log(`  [+] Lower Max Bundle Risk: ${currentThresholds.maxBundleRiskScore} -> ${Math.round(winBundle + 10)}`);
        }
      } else if (winRate > 40 && completedSignals.length < 20) {
        console.log('  [i] Win rate above 40% but signal volume low - Consider LOOSENING thresholds for more opportunities');
      } else {
        console.log('  [OK] Win rate acceptable - Monitor and fine-tune as needed');
      }

      // Show worst performing signals
      console.log('\n\nWorst Performing Signals (Last 7 Days):');
      console.log('-'.repeat(80));
      const worstSignals = completedSignals
        .filter(s => s.final_return !== null)
        .sort((a, b) => parseFloat(a.final_return!) - parseFloat(b.final_return!))
        .slice(0, 5);

      for (const signal of worstSignals) {
        console.log(
          `  ${signal.token_ticker?.padEnd(10) || 'N/A'} | ` +
          `Return: ${parseFloat(signal.final_return!).toFixed(1).padStart(7)}% | ` +
          `OnChain: ${parseFloat(signal.onchain_score || '0').toFixed(0)} | ` +
          `Mom: ${parseFloat(signal.momentum_score || '0').toFixed(0)} | ` +
          `Safety: ${parseFloat(signal.safety_score || '0').toFixed(0)} | ` +
          `Bundle: ${parseFloat(signal.bundle_risk_score || '0').toFixed(0)} | ` +
          `Liq: $${parseFloat(signal.entry_liquidity || '0').toFixed(0)}`
        );
      }

      // Show best performing signals
      console.log('\nBest Performing Signals (Last 7 Days):');
      console.log('-'.repeat(80));
      const bestSignals = completedSignals
        .filter(s => s.final_return !== null)
        .sort((a, b) => parseFloat(b.final_return!) - parseFloat(a.final_return!))
        .slice(0, 5);

      for (const signal of bestSignals) {
        console.log(
          `  ${signal.token_ticker?.padEnd(10) || 'N/A'} | ` +
          `Return: ${parseFloat(signal.final_return!).toFixed(1).padStart(7)}% | ` +
          `OnChain: ${parseFloat(signal.onchain_score || '0').toFixed(0)} | ` +
          `Mom: ${parseFloat(signal.momentum_score || '0').toFixed(0)} | ` +
          `Safety: ${parseFloat(signal.safety_score || '0').toFixed(0)} | ` +
          `Bundle: ${parseFloat(signal.bundle_risk_score || '0').toFixed(0)} | ` +
          `Liq: $${parseFloat(signal.entry_liquidity || '0').toFixed(0)}`
        );
      }
    } else {
      console.log('\n[!] Need at least 5 completed signals for factor analysis');
      console.log(`    Current completed: ${completedSignals.length}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('END OF REPORT');
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('Error querying performance data:', error);
  } finally {
    await pool.end();
  }
}

function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
  return arr.reduce((groups, item) => {
    const val = String(item[key] || 'UNKNOWN');
    groups[val] = groups[val] || [];
    groups[val].push(item);
    return groups;
  }, {} as Record<string, T[]>);
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

queryTodayPerformance();
