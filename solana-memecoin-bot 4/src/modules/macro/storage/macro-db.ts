// ===========================================
// MACRO DATABASE OPERATIONS
// ===========================================
// Separate database operations for macro module
// Does not interfere with memecoin tables

import { pool } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';
import {
  MacroGannSignal,
  MacroSignalRecord,
  MacroPivotRecord,
  MacroMetricsRecord,
  GannPivot,
  PivotType,
} from '../types.js';

/**
 * Schema SQL for macro tables
 */
export const MACRO_SCHEMA_SQL = `
-- =============================================
-- MACRO GANN ANALYZER TABLES
-- Completely separate from memecoin tables
-- =============================================

-- Macro Gann Signals table
CREATE TABLE IF NOT EXISTS macro_gann_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMPTZ DEFAULT NOW(),

  -- Directional
  bias TEXT NOT NULL,
  bias_strength TEXT NOT NULL,
  action TEXT NOT NULL,

  -- Leverage
  suggested_leverage DECIMAL(4, 1),
  max_leverage DECIMAL(4, 1),
  leverage_reasoning TEXT,

  -- Gann Analysis
  gann_angle DECIMAL(8, 4),
  gann_angle_name TEXT,
  nearest_support DECIMAL(20, 2),
  nearest_resistance DECIMAL(20, 2),
  active_cycles JSONB,
  confluence_detected BOOLEAN DEFAULT FALSE,
  confluence_details JSONB,

  -- Metrics snapshots
  btc_price DECIMAL(20, 2),
  sol_price DECIMAL(20, 6),
  derivatives_metrics JSONB,
  orderbook_metrics JSONB,
  sentiment_metrics JSONB,

  -- Meta
  confidence INT,
  regime TEXT,
  summary TEXT
);

-- Macro Pivots table (for Gann analysis)
CREATE TABLE IF NOT EXISTS macro_gann_pivots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMPTZ NOT NULL,
  asset TEXT NOT NULL,
  pivot_type TEXT NOT NULL,
  price DECIMAL(20, 2) NOT NULL,
  timeframe TEXT NOT NULL,
  is_major BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Macro Live Metrics History
CREATE TABLE IF NOT EXISTS macro_live_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMPTZ DEFAULT NOW(),

  -- Prices
  btc_price DECIMAL(20, 2),
  sol_price DECIMAL(20, 6),

  -- On-chain / Derivatives
  exchange_net_flow DECIMAL(20, 2),
  whale_txns_count INT,
  liquidations_long DECIMAL(20, 2),
  liquidations_short DECIMAL(20, 2),
  open_interest DECIMAL(20, 2),
  funding_rate DECIMAL(10, 6),

  -- Order book
  bid_ask_imbalance DECIMAL(8, 4),
  depth_1pct_bids DECIMAL(20, 2),
  depth_1pct_asks DECIMAL(20, 2),

  -- Sentiment
  fear_greed INT,
  social_mentions INT,
  sentiment_polarity DECIMAL(8, 4)
);

-- Indexes for macro tables
CREATE INDEX IF NOT EXISTS idx_macro_signals_timestamp ON macro_gann_signals(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_macro_signals_bias ON macro_gann_signals(bias);
CREATE INDEX IF NOT EXISTS idx_macro_pivots_asset ON macro_gann_pivots(asset, timeframe);
CREATE INDEX IF NOT EXISTS idx_macro_pivots_timestamp ON macro_gann_pivots(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_macro_metrics_timestamp ON macro_live_metrics(timestamp DESC);
`;

/**
 * Macro Database Operations
 */
export class MacroDatabase {
  /**
   * Initialize macro schema
   */
  static async initializeSchema(): Promise<void> {
    try {
      await pool.query(MACRO_SCHEMA_SQL);
      logger.info('Macro database schema initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize macro schema');
      throw err;
    }
  }

  /**
   * Save a macro signal to the database
   */
  static async saveSignal(signal: MacroGannSignal): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO macro_gann_signals (
          id, timestamp, bias, bias_strength, action,
          suggested_leverage, max_leverage, leverage_reasoning,
          gann_angle, gann_angle_name, nearest_support, nearest_resistance,
          active_cycles, confluence_detected, confluence_details,
          btc_price, sol_price, derivatives_metrics, orderbook_metrics, sentiment_metrics,
          confidence, regime, summary
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23
        )`,
        [
          signal.id,
          signal.timestamp,
          signal.bias,
          signal.biasStrength,
          signal.action,
          signal.leverage.suggested,
          signal.leverage.maximum,
          signal.leverage.reasoning,
          signal.gann.currentAngle.currentAngle,
          signal.gann.currentAngle.closestGannAngle,
          signal.gann.nearestSupport,
          signal.gann.nearestResistance,
          JSON.stringify(signal.gann.activeCycles),
          !!signal.gann.confluence,
          signal.gann.confluence ? JSON.stringify(signal.gann.confluence) : null,
          signal.btcPrice,
          signal.solPrice,
          JSON.stringify(signal.derivatives),
          JSON.stringify(signal.orderBook),
          JSON.stringify(signal.sentiment),
          signal.confidence,
          signal.regime,
          signal.summary,
        ]
      );
    } catch (err) {
      logger.error({ err }, 'Failed to save macro signal');
      throw err;
    }
  }

  /**
   * Get recent signals
   */
  static async getRecentSignals(limit: number = 10): Promise<MacroSignalRecord[]> {
    const result = await pool.query(
      `SELECT * FROM macro_gann_signals ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );

    return result.rows.map(this.mapSignalRow);
  }

  /**
   * Save a pivot point
   */
  static async savePivot(pivot: GannPivot): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO macro_gann_pivots (timestamp, asset, pivot_type, price, timeframe, is_major)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          pivot.timestamp,
          pivot.asset,
          pivot.pivotType,
          pivot.price,
          pivot.timeframe,
          pivot.isMajor,
        ]
      );
    } catch (err) {
      logger.error({ err }, 'Failed to save pivot');
      throw err;
    }
  }

  /**
   * Get pivots for an asset
   */
  static async getPivots(
    asset: string = 'BTC',
    majorOnly: boolean = false
  ): Promise<GannPivot[]> {
    let query = `SELECT * FROM macro_gann_pivots WHERE asset = $1`;
    const params: any[] = [asset];

    if (majorOnly) {
      query += ' AND is_major = true';
    }

    query += ' ORDER BY timestamp DESC LIMIT 20';

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      asset: row.asset,
      pivotType: row.pivot_type as PivotType,
      price: parseFloat(row.price),
      timeframe: row.timeframe,
      isMajor: row.is_major,
    }));
  }

  /**
   * Save live metrics snapshot
   */
  static async saveMetricsSnapshot(signal: MacroGannSignal): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO macro_live_metrics (
          btc_price, sol_price,
          liquidations_long, liquidations_short, open_interest, funding_rate,
          bid_ask_imbalance, depth_1pct_bids, depth_1pct_asks,
          fear_greed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          signal.btcPrice,
          signal.solPrice,
          signal.derivatives.liquidations24h.long,
          signal.derivatives.liquidations24h.short,
          signal.derivatives.openInterest,
          signal.derivatives.fundingRate,
          signal.orderBook.bidAskImbalance,
          signal.orderBook.depth1Percent.bids,
          signal.orderBook.depth1Percent.asks,
          signal.sentiment.fearGreedIndex,
        ]
      );
    } catch (err) {
      logger.error({ err }, 'Failed to save metrics snapshot');
    }
  }

  /**
   * Get metrics history
   */
  static async getMetricsHistory(hours: number = 24): Promise<MacroMetricsRecord[]> {
    const result = await pool.query(
      `SELECT * FROM macro_live_metrics
       WHERE timestamp > NOW() - INTERVAL '${hours} hours'
       ORDER BY timestamp DESC`
    );

    return result.rows.map(this.mapMetricsRow);
  }

  /**
   * Clean old data (retention policy)
   */
  static async cleanOldData(retentionDays: number = 30): Promise<void> {
    try {
      await pool.query(
        `DELETE FROM macro_gann_signals WHERE timestamp < NOW() - INTERVAL '${retentionDays} days'`
      );
      await pool.query(
        `DELETE FROM macro_live_metrics WHERE timestamp < NOW() - INTERVAL '${retentionDays} days'`
      );
      logger.info({ retentionDays }, 'Cleaned old macro data');
    } catch (err) {
      logger.error({ err }, 'Failed to clean old macro data');
    }
  }

  /**
   * Map signal row to record
   */
  private static mapSignalRow(row: any): MacroSignalRecord {
    return {
      id: row.id,
      timestamp: row.timestamp,
      bias: row.bias,
      biasStrength: row.bias_strength,
      action: row.action,
      suggestedLeverage: parseFloat(row.suggested_leverage),
      maxLeverage: parseFloat(row.max_leverage),
      leverageReasoning: row.leverage_reasoning,
      gannAngle: parseFloat(row.gann_angle),
      gannAngleName: row.gann_angle_name,
      nearestSupport: parseFloat(row.nearest_support),
      nearestResistance: parseFloat(row.nearest_resistance),
      activeCycles: row.active_cycles || [],
      confluenceDetected: row.confluence_detected,
      confluenceDetails: row.confluence_details,
      onchainMetrics: row.derivatives_metrics,
      orderbookMetrics: row.orderbook_metrics,
      sentimentMetrics: row.sentiment_metrics,
      confidence: row.confidence,
      regime: row.regime,
      summary: row.summary,
    };
  }

  /**
   * Map metrics row to record
   */
  private static mapMetricsRow(row: any): MacroMetricsRecord {
    return {
      id: row.id,
      timestamp: row.timestamp,
      btcPrice: parseFloat(row.btc_price),
      solPrice: parseFloat(row.sol_price),
      exchangeNetFlow: parseFloat(row.exchange_net_flow || 0),
      whaleTxnsCount: row.whale_txns_count || 0,
      liquidationsLong: parseFloat(row.liquidations_long || 0),
      liquidationsShort: parseFloat(row.liquidations_short || 0),
      openInterest: parseFloat(row.open_interest || 0),
      fundingRate: parseFloat(row.funding_rate || 0),
      bidAskImbalance: parseFloat(row.bid_ask_imbalance || 0),
      depth1PctBids: parseFloat(row.depth_1pct_bids || 0),
      depth1PctAsks: parseFloat(row.depth_1pct_asks || 0),
      fearGreed: row.fear_greed || 50,
      socialMentions: row.social_mentions || 0,
      sentimentPolarity: parseFloat(row.sentiment_polarity || 0),
    };
  }
}

export default MacroDatabase;
