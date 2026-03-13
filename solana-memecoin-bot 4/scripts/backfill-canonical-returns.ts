// ===========================================
// SCRIPT: Backfill Canonical Returns
// One-time migration to simulate canonical exit strategy
// on all completed signals with price snapshot history.
//
// Run: npx tsx scripts/backfill-canonical-returns.ts
// ===========================================

import { pool } from '../src/utils/database.js';
import {
  calculateExitAction,
  applyExitDecision,
  calculateRealizedReturn,
  classifyOutcome,
  scoreToGrade,
  createInitialExitState,
  CANONICAL_EXIT_PARAMS,
  type PartialExitState,
} from '../src/modules/trading/exitStrategy.js';

async function backfillCanonicalReturns() {
  console.log('=== BACKFILL CANONICAL RETURNS ===');
  console.log('Simulating canonical exit strategy on historical signals...\n');

  // Get all completed signals that don't have canonical data yet
  const signalsResult = await pool.query(`
    SELECT signal_id, token_address, token_ticker, entry_price, onchain_score,
           final_outcome, final_return, signal_time,
           COALESCE(data_quality, 'legacy') as data_quality
    FROM signal_performance
    WHERE final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')
      AND COALESCE(data_quality, 'legacy') != 'canonical'
    ORDER BY signal_time ASC
  `);

  const signals = signalsResult.rows;
  console.log(`Found ${signals.length} pre-alignment signals to backfill.\n`);

  let simulated = 0;
  let lowConfidence = 0;
  let noSnapshots = 0;

  for (const signal of signals) {
    const signalId = signal.signal_id;
    const entryPrice = parseFloat(signal.entry_price);
    const onchainScore = parseFloat(signal.onchain_score) || 50;
    const grade = scoreToGrade(onchainScore);

    // Get all price snapshots for this signal, ordered by time
    const snapshotsResult = await pool.query(`
      SELECT price, price_change, hours_after_signal, snapshot_time
      FROM performance_snapshots
      WHERE signal_id = $1
      ORDER BY hours_after_signal ASC
    `, [signalId]);

    const snapshots = snapshotsResult.rows;

    if (snapshots.length === 0) {
      noSnapshots++;
      continue;
    }

    // Determine data quality: sparse snapshots = low confidence
    const dataQuality = snapshots.length >= 6 ? 'simulated' : 'low_confidence';
    if (dataQuality === 'low_confidence') lowConfidence++;

    // Simulate the canonical exit strategy through each snapshot
    let exitState = createInitialExitState(entryPrice, grade);
    const partialExits: Array<{ price: number; percentOfOriginal: number; timestamp: string; reason: string }> = [];
    let peakPrice = entryPrice;

    for (const snapshot of snapshots) {
      const currentPrice = parseFloat(snapshot.price);
      const hoursElapsed = parseFloat(snapshot.hours_after_signal);

      peakPrice = Math.max(peakPrice, currentPrice);
      exitState.peakPriceSinceEntry = peakPrice;

      // Ask the canonical exit strategy what would happen
      const decision = calculateExitAction(
        entryPrice,
        currentPrice,
        peakPrice,
        hoursElapsed,
        grade,
        exitState
      );

      if (decision.action !== 'NONE') {
        partialExits.push({
          price: currentPrice,
          percentOfOriginal: decision.sellPercent,
          timestamp: snapshot.snapshot_time,
          reason: decision.action,
        });

        exitState = applyExitDecision(exitState, decision, currentPrice);

        // If position fully closed, stop processing
        if (exitState.currentPositionPercent <= 0) break;
      }
    }

    // If position never fully closed, simulate time limit closure at last snapshot price
    if (exitState.currentPositionPercent > 0 && snapshots.length > 0) {
      const lastSnapshot = snapshots[snapshots.length - 1];
      const lastPrice = parseFloat(lastSnapshot.price);
      partialExits.push({
        price: lastPrice,
        percentOfOriginal: exitState.currentPositionPercent,
        timestamp: lastSnapshot.snapshot_time,
        reason: 'TIME_LIMIT',
      });
    }

    // Calculate canonical realized return
    const realizedReturn = calculateRealizedReturn(
      entryPrice,
      partialExits.map(e => ({
        exitPrice: e.price,
        percentOfOriginal: e.percentOfOriginal,
      }))
    );

    const outcomeCategory = classifyOutcome(realizedReturn);
    const exitReason = partialExits.length > 0
      ? partialExits[partialExits.length - 1].reason
      : 'UNKNOWN';

    // Store as simulated canonical data (don't overwrite original final_return)
    await pool.query(`
      UPDATE signal_performance
      SET
        realized_return = $1,
        partial_exits_json = $2,
        peak_price = $3,
        exit_reason = $4,
        outcome_category = $5,
        data_quality = $6
      WHERE signal_id = $7
    `, [
      realizedReturn * 100, // Store as percentage
      JSON.stringify(partialExits),
      peakPrice,
      exitReason,
      outcomeCategory,
      dataQuality,
      signalId,
    ]);

    simulated++;

    if (simulated % 10 === 0) {
      console.log(`  Processed ${simulated}/${signals.length}...`);
    }
  }

  console.log(`\n=== BACKFILL COMPLETE ===`);
  console.log(`Simulated: ${simulated}`);
  console.log(`Low confidence (sparse snapshots): ${lowConfidence}`);
  console.log(`Skipped (no snapshots): ${noSnapshots}`);
  console.log(`\nData quality tags:`);
  console.log(`  'canonical' — tracked with canonical exit strategy from day 1`);
  console.log(`  'simulated' — backfilled from 6+ snapshots`);
  console.log(`  'low_confidence' — backfilled from <6 snapshots`);
  console.log(`  'legacy' — no backfill possible (no snapshots)`);

  await pool.end();
}

backfillCanonicalReturns().catch(error => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
