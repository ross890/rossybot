// ===========================================
// MODULE: SIGNAL PERFORMANCE TRACKER
// Tracks actual outcomes of signals vs predictions
// Enables learning and threshold optimization
// ===========================================

import { logger } from '../../utils/logger.js';
import { Database, pool } from '../../utils/database.js';
import { dexScreenerClient } from '../onchain.js';

// ============ TYPES ============

export interface SignalRecord {
  id: string;
  tokenAddress: string;
  tokenTicker: string;
  signalType: 'ONCHAIN' | 'KOL' | 'DISCOVERY';

  // Signal metrics at time of signal
  entryPrice: number;
  entryMcap: number;
  momentumScore: number;
  onChainScore: number;
  safetyScore: number;
  bundleRiskScore: number;
  signalStrength: 'STRONG' | 'MODERATE' | 'WEAK';

  // Additional entry metrics for analysis
  entryLiquidity: number;
  entryTokenAge: number;  // in minutes
  entryHolderCount: number;
  entryTop10Concentration: number;
  entryBuySellRatio: number;
  entryUniqueBuyers: number;

  // Timestamps
  signalTime: Date;

  // Tracking status
  tracked: boolean;
  finalOutcome: 'WIN' | 'LOSS' | 'PENDING' | null;
}

export interface PerformanceSnapshot {
  signalId: string;
  tokenAddress: string;

  // Price data at snapshot
  price: number;
  priceChange: number;  // % change from entry
  mcap: number;

  // Timing
  hoursAfterSignal: number;
  snapshotTime: Date;

  // Would this have hit targets?
  hitStopLoss: boolean;    // -40%
  hitTakeProfit: boolean;  // +100%
}

export interface SignalPerformance {
  signalId: string;
  tokenAddress: string;
  tokenTicker: string;
  signalType: string;

  // Entry data
  entryPrice: number;
  momentumScore: number;
  onChainScore: number;
  signalStrength: string;

  // Performance at intervals
  return1h: number | null;
  return4h: number | null;
  return24h: number | null;
  maxReturn: number;
  minReturn: number;

  // Outcome
  hitStopLoss: boolean;
  hitTakeProfit: boolean;
  finalReturn: number;
  outcome: 'WIN' | 'LOSS' | 'PENDING';

  // Timing
  signalTime: Date;
  lastUpdate: Date;
}

export interface PerformanceStats {
  totalSignals: number;
  completedSignals: number;
  pendingSignals: number;

  // Win/Loss
  wins: number;
  losses: number;
  winRate: number;

  // Returns
  avgReturn: number;
  avgWinReturn: number;
  avgLossReturn: number;
  bestReturn: number;
  worstReturn: number;

  // By signal type
  bySignalType: {
    [key: string]: {
      count: number;
      winRate: number;
      avgReturn: number;
    };
  };

  // By score range
  byScoreRange: {
    high: { count: number; winRate: number; avgReturn: number };    // 70+
    medium: { count: number; winRate: number; avgReturn: number };  // 50-69
    low: { count: number; winRate: number; avgReturn: number };     // <50
  };

  // By signal strength
  byStrength: {
    STRONG: { count: number; winRate: number; avgReturn: number };
    MODERATE: { count: number; winRate: number; avgReturn: number };
    WEAK: { count: number; winRate: number; avgReturn: number };
  };

  // DUAL-TRACK: By signal track
  byTrack: {
    PROVEN_RUNNER: { count: number; winRate: number; avgReturn: number };
    EARLY_QUALITY: { count: number; winRate: number; avgReturn: number };
  };

  // Time period
  periodStart: Date;
  periodEnd: Date;
}

// ============ CONSTANTS ============

const TRACKING_INTERVALS_HOURS = [1, 4, 24];
const STOP_LOSS_PERCENT = -40;
const TAKE_PROFIT_PERCENT = 100;
const MAX_TRACKING_HOURS = 48;  // Stop tracking after 48 hours

// ============ SIGNAL PERFORMANCE TRACKER CLASS ============

export class SignalPerformanceTracker {
  private trackingTimer: NodeJS.Timeout | null = null;
  private readonly TRACKING_INTERVAL_MS = 15 * 60 * 1000; // Check every 15 minutes

  /**
   * Initialize the tracker and start background tracking
   */
  async initialize(): Promise<void> {
    // Ensure database tables exist
    await this.ensureTablesExist();

    // Start background tracking
    this.startTracking();

    logger.info('Signal Performance Tracker initialized');
  }

  /**
   * Record a new signal for tracking
   */
  async recordSignal(
    signalId: string,
    tokenAddress: string,
    tokenTicker: string,
    signalType: 'ONCHAIN' | 'KOL' | 'DISCOVERY',
    entryPrice: number,
    entryMcap: number,
    momentumScore: number,
    onChainScore: number,
    safetyScore: number,
    bundleRiskScore: number,
    signalStrength: 'STRONG' | 'MODERATE' | 'WEAK',
    // Additional metrics for deeper analysis
    additionalMetrics?: {
      liquidity?: number;
      tokenAge?: number;
      holderCount?: number;
      top10Concentration?: number;
      buySellRatio?: number;
      uniqueBuyers?: number;
      signalTrack?: string;      // DUAL-TRACK: 'PROVEN_RUNNER' | 'EARLY_QUALITY'
      kolReputation?: string;    // DUAL-TRACK: KOL tier for EARLY_QUALITY
    }
  ): Promise<void> {
    try {
      const metrics = additionalMetrics || {};

      await pool.query(`
        INSERT INTO signal_performance (
          signal_id, token_address, token_ticker, signal_type,
          entry_price, entry_mcap, momentum_score, onchain_score,
          safety_score, bundle_risk_score, signal_strength,
          entry_liquidity, entry_token_age, entry_holder_count,
          entry_top10_concentration, entry_buy_sell_ratio, entry_unique_buyers,
          signal_track, kol_reputation,
          signal_time, tracked, final_outcome
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), true, 'PENDING')
        ON CONFLICT (signal_id) DO NOTHING
      `, [
        signalId, tokenAddress, tokenTicker, signalType,
        entryPrice, entryMcap, momentumScore, onChainScore,
        safetyScore, bundleRiskScore, signalStrength,
        metrics.liquidity || 0,
        metrics.tokenAge || 0,
        metrics.holderCount || 0,
        metrics.top10Concentration || 0,
        metrics.buySellRatio || 0,
        metrics.uniqueBuyers || 0,
        metrics.signalTrack || 'PROVEN_RUNNER',  // Default to PROVEN_RUNNER for backwards compat
        metrics.kolReputation || null
      ]);

      logger.info({
        signalId,
        tokenTicker,
        entryPrice,
        onChainScore,
        liquidity: metrics.liquidity,
        tokenAge: metrics.tokenAge,
      }, 'Signal recorded for performance tracking');
    } catch (error) {
      logger.error({ error, signalId }, 'Failed to record signal for tracking');
    }
  }

  /**
   * Start background tracking of signal performance
   */
  startTracking(): void {
    if (this.trackingTimer) {
      clearInterval(this.trackingTimer);
    }

    // Run immediately
    this.trackAllPendingSignals();

    // Then run on interval
    this.trackingTimer = setInterval(
      () => this.trackAllPendingSignals(),
      this.TRACKING_INTERVAL_MS
    );

    logger.info('Signal performance tracking started');
  }

  /**
   * Stop background tracking
   */
  stopTracking(): void {
    if (this.trackingTimer) {
      clearInterval(this.trackingTimer);
      this.trackingTimer = null;
    }
    logger.info('Signal performance tracking stopped');
  }

  /**
   * Track all pending signals
   */
  private async trackAllPendingSignals(): Promise<void> {
    try {
      // Get all signals that are still being tracked
      const result = await pool.query(`
        SELECT * FROM signal_performance
        WHERE tracked = true
        AND final_outcome = 'PENDING'
        AND signal_time > NOW() - INTERVAL '48 hours'
      `);

      for (const signal of result.rows) {
        await this.trackSignal(signal);
      }

      logger.debug({ count: result.rows.length }, 'Tracked pending signals');
    } catch (error) {
      logger.error({ error }, 'Failed to track pending signals');
    }
  }

  /**
   * Track a single signal's performance
   */
  private async trackSignal(signal: any): Promise<void> {
    try {
      // Get current price
      const pairs = await dexScreenerClient.getTokenPairs(signal.token_address);
      if (pairs.length === 0) {
        logger.debug({ tokenAddress: signal.token_address }, 'No price data for signal');
        return;
      }

      const currentPrice = pairs[0].priceUsd ? parseFloat(pairs[0].priceUsd) : 0;
      const currentMcap = pairs[0].fdv || 0;

      if (currentPrice === 0) return;

      const entryPrice = parseFloat(signal.entry_price);
      const priceChange = ((currentPrice - entryPrice) / entryPrice) * 100;
      const hoursElapsed = (Date.now() - new Date(signal.signal_time).getTime()) / (1000 * 60 * 60);

      // Record snapshot
      await this.recordSnapshot(
        signal.signal_id,
        signal.token_address,
        currentPrice,
        priceChange,
        currentMcap,
        hoursElapsed
      );

      // Check if outcome is determined
      const hitStopLoss = priceChange <= STOP_LOSS_PERCENT;
      const hitTakeProfit = priceChange >= TAKE_PROFIT_PERCENT;
      const timeExpired = hoursElapsed >= MAX_TRACKING_HOURS;

      if (hitStopLoss || hitTakeProfit || timeExpired) {
        await this.finalizeSignal(
          signal.signal_id,
          hitTakeProfit ? 'WIN' : 'LOSS',
          priceChange
        );
      }

      // Update interval returns
      await this.updateIntervalReturns(signal.signal_id, hoursElapsed, priceChange);

    } catch (error) {
      logger.error({ error, signalId: signal.signal_id }, 'Failed to track signal');
    }
  }

  /**
   * Record a performance snapshot
   */
  private async recordSnapshot(
    signalId: string,
    tokenAddress: string,
    price: number,
    priceChange: number,
    mcap: number,
    hoursAfterSignal: number
  ): Promise<void> {
    try {
      await pool.query(`
        INSERT INTO performance_snapshots (
          signal_id, token_address, price, price_change, mcap,
          hours_after_signal, snapshot_time,
          hit_stop_loss, hit_take_profit
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)
      `, [
        signalId, tokenAddress, price, priceChange, mcap,
        hoursAfterSignal,
        priceChange <= STOP_LOSS_PERCENT,
        priceChange >= TAKE_PROFIT_PERCENT
      ]);
    } catch (error) {
      // Ignore duplicate snapshot errors
    }
  }

  /**
   * Update interval-specific returns (1h, 4h, 24h)
   */
  private async updateIntervalReturns(
    signalId: string,
    hoursElapsed: number,
    priceChange: number
  ): Promise<void> {
    try {
      // Update 1h return if we're past 1 hour and haven't set it
      if (hoursElapsed >= 1) {
        await pool.query(`
          UPDATE signal_performance
          SET return_1h = COALESCE(return_1h, $1)
          WHERE signal_id = $2 AND return_1h IS NULL
        `, [priceChange, signalId]);
      }

      // Update 4h return
      if (hoursElapsed >= 4) {
        await pool.query(`
          UPDATE signal_performance
          SET return_4h = COALESCE(return_4h, $1)
          WHERE signal_id = $2 AND return_4h IS NULL
        `, [priceChange, signalId]);
      }

      // Update 24h return
      if (hoursElapsed >= 24) {
        await pool.query(`
          UPDATE signal_performance
          SET return_24h = COALESCE(return_24h, $1)
          WHERE signal_id = $2 AND return_24h IS NULL
        `, [priceChange, signalId]);
      }

      // Update max/min returns
      await pool.query(`
        UPDATE signal_performance
        SET
          max_return = GREATEST(COALESCE(max_return, $1), $1),
          min_return = LEAST(COALESCE(min_return, $1), $1),
          last_update = NOW()
        WHERE signal_id = $2
      `, [priceChange, signalId]);

    } catch (error) {
      logger.error({ error, signalId }, 'Failed to update interval returns');
    }
  }

  /**
   * Finalize a signal's outcome
   */
  private async finalizeSignal(
    signalId: string,
    outcome: 'WIN' | 'LOSS',
    finalReturn: number
  ): Promise<void> {
    try {
      await pool.query(`
        UPDATE signal_performance
        SET
          final_outcome = $1,
          final_return = $2,
          hit_stop_loss = $3,
          hit_take_profit = $4,
          tracked = false,
          last_update = NOW()
        WHERE signal_id = $5
      `, [
        outcome,
        finalReturn,
        finalReturn <= STOP_LOSS_PERCENT,
        finalReturn >= TAKE_PROFIT_PERCENT,
        signalId
      ]);

      logger.info({
        signalId,
        outcome,
        finalReturn: `${finalReturn.toFixed(1)}%`,
      }, 'Signal outcome finalized');
    } catch (error) {
      logger.error({ error, signalId }, 'Failed to finalize signal');
    }
  }

  /**
   * Get performance statistics for a time period
   */
  async getPerformanceStats(hours: number = 168): Promise<PerformanceStats> {
    try {
      const result = await pool.query(`
        SELECT * FROM signal_performance
        WHERE signal_time > NOW() - INTERVAL '${hours} hours'
      `);

      const signals = result.rows;
      const completed = signals.filter((s: any) => s.final_outcome !== 'PENDING');
      const wins = completed.filter((s: any) => s.final_outcome === 'WIN');
      const losses = completed.filter((s: any) => s.final_outcome === 'LOSS');

      // Calculate returns
      const returns = completed.map((s: any) => parseFloat(s.final_return) || 0);
      const winReturns = wins.map((s: any) => parseFloat(s.final_return) || 0);
      const lossReturns = losses.map((s: any) => parseFloat(s.final_return) || 0);

      // By signal type
      const bySignalType: any = {};
      for (const type of ['ONCHAIN', 'KOL', 'DISCOVERY']) {
        const typeSignals = completed.filter((s: any) => s.signal_type === type);
        const typeWins = typeSignals.filter((s: any) => s.final_outcome === 'WIN');
        const typeReturns = typeSignals.map((s: any) => parseFloat(s.final_return) || 0);

        bySignalType[type] = {
          count: typeSignals.length,
          winRate: typeSignals.length > 0 ? (typeWins.length / typeSignals.length) * 100 : 0,
          avgReturn: typeReturns.length > 0 ? typeReturns.reduce((a: number, b: number) => a + b, 0) / typeReturns.length : 0,
        };
      }

      // By score range
      const highScore = completed.filter((s: any) => parseFloat(s.onchain_score) >= 70);
      const medScore = completed.filter((s: any) => parseFloat(s.onchain_score) >= 50 && parseFloat(s.onchain_score) < 70);
      const lowScore = completed.filter((s: any) => parseFloat(s.onchain_score) < 50);

      const byScoreRange = {
        high: this.calculateGroupStats(highScore),
        medium: this.calculateGroupStats(medScore),
        low: this.calculateGroupStats(lowScore),
      };

      // By signal strength
      const byStrength = {
        STRONG: this.calculateGroupStats(completed.filter((s: any) => s.signal_strength === 'STRONG')),
        MODERATE: this.calculateGroupStats(completed.filter((s: any) => s.signal_strength === 'MODERATE')),
        WEAK: this.calculateGroupStats(completed.filter((s: any) => s.signal_strength === 'WEAK')),
      };

      // DUAL-TRACK: By signal track
      const byTrack = {
        PROVEN_RUNNER: this.calculateGroupStats(completed.filter((s: any) => s.signal_track === 'PROVEN_RUNNER' || !s.signal_track)),
        EARLY_QUALITY: this.calculateGroupStats(completed.filter((s: any) => s.signal_track === 'EARLY_QUALITY')),
      };

      return {
        totalSignals: signals.length,
        completedSignals: completed.length,
        pendingSignals: signals.length - completed.length,

        wins: wins.length,
        losses: losses.length,
        winRate: completed.length > 0 ? (wins.length / completed.length) * 100 : 0,

        avgReturn: returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0,
        avgWinReturn: winReturns.length > 0 ? winReturns.reduce((a, b) => a + b, 0) / winReturns.length : 0,
        avgLossReturn: lossReturns.length > 0 ? lossReturns.reduce((a, b) => a + b, 0) / lossReturns.length : 0,
        bestReturn: returns.length > 0 ? Math.max(...returns) : 0,
        worstReturn: returns.length > 0 ? Math.min(...returns) : 0,

        bySignalType,
        byScoreRange,
        byStrength,
        byTrack,  // DUAL-TRACK: Stats split by signal track

        periodStart: new Date(Date.now() - hours * 60 * 60 * 1000),
        periodEnd: new Date(),
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get performance stats');
      throw error;
    }
  }

  /**
   * Calculate stats for a group of signals
   */
  private calculateGroupStats(signals: any[]): { count: number; winRate: number; avgReturn: number } {
    if (signals.length === 0) {
      return { count: 0, winRate: 0, avgReturn: 0 };
    }

    const wins = signals.filter((s: any) => s.final_outcome === 'WIN');
    const returns = signals.map((s: any) => parseFloat(s.final_return) || 0);

    return {
      count: signals.length,
      winRate: (wins.length / signals.length) * 100,
      avgReturn: returns.reduce((a, b) => a + b, 0) / returns.length,
    };
  }

  /**
   * Get factor correlations with winning trades
   */
  async getFactorCorrelations(): Promise<{
    factor: string;
    winningAvg: number;
    losingAvg: number;
    correlation: number;
  }[]> {
    try {
      const result = await pool.query(`
        SELECT * FROM signal_performance
        WHERE final_outcome IN ('WIN', 'LOSS')
      `);

      const wins = result.rows.filter((s: any) => s.final_outcome === 'WIN');
      const losses = result.rows.filter((s: any) => s.final_outcome === 'LOSS');

      if (wins.length === 0 || losses.length === 0) {
        return [];
      }

      // Core score factors
      const scoreFactors = ['momentum_score', 'onchain_score', 'safety_score', 'bundle_risk_score'];
      // Additional market factors (added for deeper analysis)
      const marketFactors = [
        'entry_liquidity',
        'entry_token_age',
        'entry_holder_count',
        'entry_top10_concentration',
        'entry_buy_sell_ratio',
        'entry_unique_buyers'
      ];

      const correlations = [];

      // Process score factors
      for (const factor of scoreFactors) {
        const winAvg = wins.reduce((sum: number, s: any) => sum + parseFloat(s[factor] || 0), 0) / wins.length;
        const lossAvg = losses.reduce((sum: number, s: any) => sum + parseFloat(s[factor] || 0), 0) / losses.length;

        // Simple correlation indicator (positive = factor correlates with wins)
        const correlation = factor === 'bundle_risk_score'
          ? (lossAvg - winAvg) / 100  // Lower bundle risk is better
          : (winAvg - lossAvg) / 100; // Higher scores are better

        correlations.push({
          factor: this.formatFactorName(factor),
          winningAvg: winAvg,
          losingAvg: lossAvg,
          correlation,
        });
      }

      // Process market factors
      for (const factor of marketFactors) {
        const winAvg = wins.reduce((sum: number, s: any) => sum + parseFloat(s[factor] || 0), 0) / wins.length;
        const lossAvg = losses.reduce((sum: number, s: any) => sum + parseFloat(s[factor] || 0), 0) / losses.length;

        // Determine correlation direction based on factor type
        let correlation: number;
        if (factor === 'entry_top10_concentration') {
          // Lower concentration is better
          correlation = (lossAvg - winAvg) / Math.max(winAvg, lossAvg, 1);
        } else if (factor === 'entry_liquidity') {
          // Normalize by dividing by larger value to get comparable scale
          correlation = (winAvg - lossAvg) / Math.max(winAvg, lossAvg, 1);
        } else {
          // Higher is better for most metrics
          correlation = winAvg !== 0 || lossAvg !== 0
            ? (winAvg - lossAvg) / Math.max(winAvg, lossAvg, 1)
            : 0;
        }

        correlations.push({
          factor: this.formatFactorName(factor),
          winningAvg: winAvg,
          losingAvg: lossAvg,
          correlation,
        });
      }

      return correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    } catch (error) {
      logger.error({ error }, 'Failed to get factor correlations');
      return [];
    }
  }

  /**
   * Format factor name for display
   */
  private formatFactorName(factor: string): string {
    return factor
      .replace(/_/g, ' ')
      .replace('entry ', '')
      .replace('score', '')
      .trim()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Ensure database tables exist
   */
  private async ensureTablesExist(): Promise<void> {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS signal_performance (
          signal_id VARCHAR(100) PRIMARY KEY,
          token_address VARCHAR(100) NOT NULL,
          token_ticker VARCHAR(50),
          signal_type VARCHAR(20) NOT NULL,

          entry_price DECIMAL(30, 18) NOT NULL,
          entry_mcap DECIMAL(30, 2),
          momentum_score DECIMAL(5, 2),
          onchain_score DECIMAL(5, 2),
          safety_score DECIMAL(5, 2),
          bundle_risk_score DECIMAL(5, 2),
          signal_strength VARCHAR(20),

          -- Additional entry metrics for deeper analysis
          entry_liquidity DECIMAL(30, 2) DEFAULT 0,
          entry_token_age DECIMAL(10, 2) DEFAULT 0,
          entry_holder_count INTEGER DEFAULT 0,
          entry_top10_concentration DECIMAL(5, 2) DEFAULT 0,
          entry_buy_sell_ratio DECIMAL(10, 2) DEFAULT 0,
          entry_unique_buyers INTEGER DEFAULT 0,

          -- DUAL-TRACK: Signal routing track
          signal_track VARCHAR(50) DEFAULT 'PROVEN_RUNNER',
          kol_reputation VARCHAR(50),

          signal_time TIMESTAMP NOT NULL,
          tracked BOOLEAN DEFAULT true,

          return_1h DECIMAL(10, 2),
          return_4h DECIMAL(10, 2),
          return_24h DECIMAL(10, 2),
          max_return DECIMAL(10, 2),
          min_return DECIMAL(10, 2),
          final_return DECIMAL(10, 2),

          hit_stop_loss BOOLEAN DEFAULT false,
          hit_take_profit BOOLEAN DEFAULT false,
          final_outcome VARCHAR(20) DEFAULT 'PENDING',

          last_update TIMESTAMP DEFAULT NOW(),

          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Add new columns if they don't exist (for existing tables)
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signal_performance' AND column_name = 'entry_liquidity') THEN
            ALTER TABLE signal_performance ADD COLUMN entry_liquidity DECIMAL(30, 2) DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signal_performance' AND column_name = 'entry_token_age') THEN
            ALTER TABLE signal_performance ADD COLUMN entry_token_age DECIMAL(10, 2) DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signal_performance' AND column_name = 'entry_holder_count') THEN
            ALTER TABLE signal_performance ADD COLUMN entry_holder_count INTEGER DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signal_performance' AND column_name = 'entry_top10_concentration') THEN
            ALTER TABLE signal_performance ADD COLUMN entry_top10_concentration DECIMAL(5, 2) DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signal_performance' AND column_name = 'entry_buy_sell_ratio') THEN
            ALTER TABLE signal_performance ADD COLUMN entry_buy_sell_ratio DECIMAL(10, 2) DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signal_performance' AND column_name = 'entry_unique_buyers') THEN
            ALTER TABLE signal_performance ADD COLUMN entry_unique_buyers INTEGER DEFAULT 0;
          END IF;
          -- DUAL-TRACK: Add signal track columns
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signal_performance' AND column_name = 'signal_track') THEN
            ALTER TABLE signal_performance ADD COLUMN signal_track VARCHAR(50) DEFAULT 'PROVEN_RUNNER';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signal_performance' AND column_name = 'kol_reputation') THEN
            ALTER TABLE signal_performance ADD COLUMN kol_reputation VARCHAR(50);
          END IF;
        END $$;
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS performance_snapshots (
          id SERIAL PRIMARY KEY,
          signal_id VARCHAR(100) NOT NULL,
          token_address VARCHAR(100) NOT NULL,

          price DECIMAL(30, 18) NOT NULL,
          price_change DECIMAL(10, 2) NOT NULL,
          mcap DECIMAL(30, 2),

          hours_after_signal DECIMAL(10, 2) NOT NULL,
          snapshot_time TIMESTAMP NOT NULL,

          hit_stop_loss BOOLEAN DEFAULT false,
          hit_take_profit BOOLEAN DEFAULT false,

          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Create indexes
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_signal_perf_time ON signal_performance(signal_time);
        CREATE INDEX IF NOT EXISTS idx_signal_perf_tracked ON signal_performance(tracked);
        CREATE INDEX IF NOT EXISTS idx_signal_perf_outcome ON signal_performance(final_outcome);
        CREATE INDEX IF NOT EXISTS idx_perf_snapshots_signal ON performance_snapshots(signal_id);
        CREATE INDEX IF NOT EXISTS idx_signal_perf_track ON signal_performance(signal_track);
      `);

      logger.info('Performance tracking tables ready');
    } catch (error) {
      logger.error({ error }, 'Failed to create performance tables');
    }
  }
}

// ============ EXPORTS ============

export const signalPerformanceTracker = new SignalPerformanceTracker();

export default {
  SignalPerformanceTracker,
  signalPerformanceTracker,
};
