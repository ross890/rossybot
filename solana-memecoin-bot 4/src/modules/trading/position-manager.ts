// ===========================================
// POSITION MANAGER
// Monitors positions for TP/SL and time decay
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { tradeExecutor, SignalCategory, DEFAULT_TRADE_CONFIG } from './trade-executor.js';
import { getTokenMetrics } from '../onchain.js';
import { momentumAnalyzer } from '../momentum-analyzer.js';

// ============ TYPES ============

export interface ManagedPosition {
  id: string;
  tokenAddress: string;
  tokenTicker: string;
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;      // HIT RATE IMPROVEMENT: Track peak for trailing stop
  quantity: number;
  entryTimestamp: Date;
  signalCategory: SignalCategory;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  tp1SellPercent: number;
  tp2SellPercent: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  pnlPercent: number;
  holdTimeHours: number;
  currentStopLoss: number; // Adjusted stop loss after time decay
  peakPnlPercent: number;  // HIT RATE IMPROVEMENT: Track peak PnL for trailing stop
}

export interface PositionCheckResult {
  // HIT RATE IMPROVEMENT: Added TRAILING_STOP and MOMENTUM_FADE actions
  action: 'NONE' | 'STOP_LOSS' | 'TAKE_PROFIT_1' | 'TAKE_PROFIT_2' | 'TIME_DECAY_STOP' | 'TRAILING_STOP' | 'MOMENTUM_FADE';
  sellPercent: number;
  reason: string;
}

// HIT RATE IMPROVEMENT: Configuration for advanced exit strategies
const TRAILING_STOP_CONFIG = {
  ACTIVATION_PNL: 40,     // Activate trailing stop when up 40%+
  RETRACE_PERCENT: 25,    // Exit if retraces 25% from peak
};

const MOMENTUM_FADE_CONFIG = {
  MIN_PNL_TO_CHECK: 15,   // Only check momentum fade if up 15%+
  MIN_SELL_PRESSURE: 1.5, // Sell:Buy ratio > 1.5 = fading
  PARTIAL_EXIT_PERCENT: 50, // Sell 50% on momentum fade
};

// ============ POSITION MANAGER CLASS ============

export class PositionManager {
  private isRunning = false;
  private monitorInterval: NodeJS.Timeout | null = null;
  // HIT RATE IMPROVEMENT: Reduced from 30s to 15s for faster exit detection
  private readonly MONITOR_INTERVAL_MS = 15 * 1000; // Check every 15 seconds
  private tablesVerified = false;
  // Cache for peak prices (in case DB column doesn't exist yet)
  private peakPriceCache: Map<string, number> = new Map();

  /**
   * Start monitoring positions
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Position manager already running');
      return;
    }

    this.isRunning = true;
    logger.info('Position manager started');

    // Run immediately, then on interval
    this.checkAllPositions();
    this.monitorInterval = setInterval(() => this.checkAllPositions(), this.MONITOR_INTERVAL_MS);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    logger.info('Position manager stopped');
  }

  /**
   * Check all open positions
   */
  async checkAllPositions(): Promise<void> {
    if (!tradeExecutor.isAutoSellEnabled()) {
      return;
    }

    try {
      const positions = await this.getOpenPositions();

      for (const position of positions) {
        try {
          await this.checkPosition(position);
        } catch (error) {
          logger.error({ error, positionId: position.id }, 'Error checking position');
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error in position check cycle');
    }
  }

  /**
   * Check a single position
   * HIT RATE IMPROVEMENT: Now includes momentum analysis for smarter exits
   */
  private async checkPosition(position: ManagedPosition): Promise<void> {
    // Get current price
    const metrics = await getTokenMetrics(position.tokenAddress);
    if (!metrics) {
      logger.warn({ tokenAddress: position.tokenAddress }, 'Could not get price for position check');
      return;
    }

    const currentPrice = metrics.price;
    const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

    // HIT RATE IMPROVEMENT: Track peak price for trailing stop
    const cachedPeak = this.peakPriceCache.get(position.id) || position.entryPrice;
    const newPeakPrice = Math.max(cachedPeak, currentPrice);
    if (currentPrice > cachedPeak) {
      this.peakPriceCache.set(position.id, newPeakPrice);
    }

    // Calculate peak PnL for trailing stop logic
    const peakPnlPercent = ((newPeakPrice - position.entryPrice) / position.entryPrice) * 100;

    // Update current price in database
    await this.updatePositionPrice(position.id, currentPrice);

    // HIT RATE IMPROVEMENT: Get momentum data for momentum-based exits
    let momentumData = null;
    try {
      momentumData = await momentumAnalyzer.analyze(position.tokenAddress);
    } catch {
      // Momentum data optional - continue without it
    }

    // Check what action to take (now with trailing stop and momentum data)
    const checkResult = this.evaluatePosition(
      position,
      currentPrice,
      pnlPercent,
      peakPnlPercent,
      momentumData
    );

    if (checkResult.action === 'NONE') {
      return;
    }

    logger.info({
      positionId: position.id,
      tokenTicker: position.tokenTicker,
      action: checkResult.action,
      pnlPercent,
      peakPnlPercent,
      reason: checkResult.reason,
    }, 'Position action triggered');

    // Execute the sell
    const sellResult = await tradeExecutor.executeSell({
      tokenAddress: position.tokenAddress,
      tokenTicker: position.tokenTicker,
      positionId: position.id,
      sellPercent: checkResult.sellPercent,
      reason: checkResult.reason,
    });

    if (sellResult.success) {
      // Update position state
      if (checkResult.action === 'TAKE_PROFIT_1') {
        await this.markTp1Hit(position.id);
      } else if (checkResult.action === 'TAKE_PROFIT_2') {
        await this.markTp2Hit(position.id);
      }

      // Clear peak price cache on full exit
      if (checkResult.sellPercent === 100) {
        this.peakPriceCache.delete(position.id);
      }

      // Notify via Telegram (would be called by signal generator/telegram bot)
      // telegramBot.sendPositionUpdate(...)
    }
  }

  /**
   * Evaluate position and determine action
   * HIT RATE IMPROVEMENT: Added trailing stop and momentum fade detection
   */
  private evaluatePosition(
    position: ManagedPosition,
    currentPrice: number,
    pnlPercent: number,
    peakPnlPercent: number = pnlPercent,
    momentumData: any = null
  ): PositionCheckResult {
    const config = DEFAULT_TRADE_CONFIG;
    const category = position.signalCategory;

    // ===== 1. STOP LOSS (highest priority) =====
    // Calculate time-adjusted stop loss
    const timeDecayConfig = config.timeDecayStops[category];
    let effectiveStopLoss = config.stopLosses[category];

    // Apply time decay if conditions met
    if (
      position.holdTimeHours >= timeDecayConfig.hours &&
      pnlPercent <= timeDecayConfig.threshold
    ) {
      effectiveStopLoss = timeDecayConfig.tightenTo;
    }

    // Check stop loss
    if (pnlPercent <= effectiveStopLoss) {
      const isTimeDecay = effectiveStopLoss !== config.stopLosses[category];
      return {
        action: isTimeDecay ? 'TIME_DECAY_STOP' : 'STOP_LOSS',
        sellPercent: 100,
        reason: isTimeDecay
          ? `TIME_DECAY_STOP: ${pnlPercent.toFixed(1)}% after ${position.holdTimeHours.toFixed(1)}h`
          : `STOP_LOSS: ${pnlPercent.toFixed(1)}%`,
      };
    }

    // ===== 2. TRAILING STOP (lock in gains) =====
    // HIT RATE IMPROVEMENT: Exit if we've gained 40%+ and then retraced 25%+
    // This prevents winners from becoming losers
    if (peakPnlPercent >= TRAILING_STOP_CONFIG.ACTIVATION_PNL) {
      const retracePercent = ((peakPnlPercent - pnlPercent) / peakPnlPercent) * 100;

      if (retracePercent >= TRAILING_STOP_CONFIG.RETRACE_PERCENT) {
        return {
          action: 'TRAILING_STOP',
          sellPercent: 100,
          reason: `TRAILING_STOP: Peak +${peakPnlPercent.toFixed(1)}% → Now +${pnlPercent.toFixed(1)}% (${retracePercent.toFixed(0)}% retrace)`,
        };
      }
    }

    // ===== 3. MOMENTUM FADE (early exit on fading momentum) =====
    // HIT RATE IMPROVEMENT: If we're up and momentum is fading, partial exit to lock gains
    if (
      momentumData &&
      pnlPercent >= MOMENTUM_FADE_CONFIG.MIN_PNL_TO_CHECK &&
      !position.tp1Hit // Don't momentum exit if we already took TP1
    ) {
      // Check if sell pressure is increasing (buySellRatio < 1 means more sells)
      const sellPressure = momentumData.sellCount5m > 0 && momentumData.buyCount5m > 0
        ? momentumData.sellCount5m / momentumData.buyCount5m
        : 0;

      // Also check volume fade (declining interest)
      const volumeFading = momentumData.volumeAcceleration < -0.3;

      if (sellPressure >= MOMENTUM_FADE_CONFIG.MIN_SELL_PRESSURE || volumeFading) {
        return {
          action: 'MOMENTUM_FADE',
          sellPercent: MOMENTUM_FADE_CONFIG.PARTIAL_EXIT_PERCENT,
          reason: `MOMENTUM_FADE: +${pnlPercent.toFixed(1)}% but selling pressure ${sellPressure.toFixed(1)}x, vol accel ${(momentumData.volumeAcceleration || 0).toFixed(2)}`,
        };
      }
    }

    // ===== 4. TAKE PROFIT 2 (only if TP1 already hit) =====
    const tp2Percent = config.takeProfits[category].tp2Percent;
    if (position.tp1Hit && !position.tp2Hit && pnlPercent >= tp2Percent) {
      return {
        action: 'TAKE_PROFIT_2',
        sellPercent: 100, // Sell remaining
        reason: `TAKE_PROFIT_2: ${pnlPercent.toFixed(1)}%`,
      };
    }

    // ===== 5. TAKE PROFIT 1 =====
    const tp1Percent = config.takeProfits[category].tp1Percent;
    if (!position.tp1Hit && pnlPercent >= tp1Percent) {
      return {
        action: 'TAKE_PROFIT_1',
        sellPercent: position.tp1SellPercent,
        reason: `TAKE_PROFIT_1: ${pnlPercent.toFixed(1)}%`,
      };
    }

    return { action: 'NONE', sellPercent: 0, reason: '' };
  }

  /**
   * Get all open positions with config
   */
  private async getOpenPositions(): Promise<ManagedPosition[]> {
    // Try query with position_config join, fall back to simpler query if table doesn't exist
    let result;
    try {
      result = await pool.query(`
        SELECT
          p.id,
          p.token_address,
          p.token_ticker,
          p.entry_price,
          p.current_price,
          p.quantity,
          p.entry_timestamp,
          p.stop_loss,
          p.take_profit_1,
          p.take_profit_2,
          p.take_profit_1_hit,
          p.take_profit_2_hit,
          COALESCE(pc.signal_category, 'MANUAL_CONFIRM') as signal_category,
          COALESCE(pc.tp1_sell_percent, 50) as tp1_sell_percent,
          COALESCE(pc.tp2_sell_percent, 50) as tp2_sell_percent
        FROM positions p
        LEFT JOIN position_config pc ON p.id = pc.position_id
        WHERE p.status = 'OPEN'
        ORDER BY p.entry_timestamp DESC
      `);
    } catch (error) {
      // If position_config table doesn't exist, use simpler query
      if (String(error).includes('position_config') || String(error).includes('does not exist')) {
        if (!this.tablesVerified) {
          logger.warn('position_config table not found - run npm run db:migrate:trading');
          this.tablesVerified = true; // Only log once
        }
        result = await pool.query(`
          SELECT
            id, token_address, token_ticker, entry_price, current_price, quantity,
            entry_timestamp, stop_loss, take_profit_1, take_profit_2,
            take_profit_1_hit, take_profit_2_hit,
            'MANUAL_CONFIRM' as signal_category,
            50 as tp1_sell_percent,
            50 as tp2_sell_percent
          FROM positions
          WHERE status = 'OPEN'
          ORDER BY entry_timestamp DESC
        `);
      } else {
        throw error;
      }
    }

    return result.rows.map(row => {
      const entryPrice = parseFloat(row.entry_price);
      const currentPrice = parseFloat(row.current_price || row.entry_price);
      const entryTime = new Date(row.entry_timestamp);
      const holdTimeHours = (Date.now() - entryTime.getTime()) / (1000 * 60 * 60);

      // HIT RATE IMPROVEMENT: Get peak price from cache (or use current as fallback)
      const cachedPeak = this.peakPriceCache.get(row.id);
      const peakPrice = cachedPeak ? Math.max(cachedPeak, currentPrice) : currentPrice;

      return {
        id: row.id,
        tokenAddress: row.token_address,
        tokenTicker: row.token_ticker,
        entryPrice,
        currentPrice,
        peakPrice,
        quantity: parseFloat(row.quantity),
        entryTimestamp: entryTime,
        signalCategory: row.signal_category as SignalCategory,
        stopLoss: parseFloat(row.stop_loss),
        takeProfit1: parseFloat(row.take_profit_1),
        takeProfit2: parseFloat(row.take_profit_2),
        tp1SellPercent: row.tp1_sell_percent,
        tp2SellPercent: row.tp2_sell_percent,
        tp1Hit: row.take_profit_1_hit,
        tp2Hit: row.take_profit_2_hit,
        pnlPercent: ((currentPrice - entryPrice) / entryPrice) * 100,
        peakPnlPercent: ((peakPrice - entryPrice) / entryPrice) * 100,
        holdTimeHours,
        currentStopLoss: parseFloat(row.stop_loss),
      };
    });
  }

  /**
   * Get position summary for display
   */
  async getPositionSummary(): Promise<{
    totalPositions: number;
    totalPnlPercent: number;
    totalPnlSol: number;
    positions: Array<{
      tokenTicker: string;
      pnlPercent: number;
      holdTimeHours: number;
      status: string;
    }>;
  }> {
    const positions = await this.getOpenPositions();

    let totalPnlSol = 0;
    const summaries = positions.map(p => {
      // Estimate SOL value of position
      const positionValue = p.quantity * p.currentPrice;
      const entryValue = p.quantity * p.entryPrice;
      totalPnlSol += positionValue - entryValue;

      let status = 'HOLDING';
      if (p.tp1Hit) status = 'TP1_HIT';
      if (p.pnlPercent <= DEFAULT_TRADE_CONFIG.stopLosses[p.signalCategory]) status = 'NEAR_STOP';

      return {
        tokenTicker: p.tokenTicker,
        pnlPercent: p.pnlPercent,
        holdTimeHours: p.holdTimeHours,
        status,
      };
    });

    const avgPnl = positions.length > 0
      ? positions.reduce((sum, p) => sum + p.pnlPercent, 0) / positions.length
      : 0;

    return {
      totalPositions: positions.length,
      totalPnlPercent: avgPnl,
      totalPnlSol,
      positions: summaries,
    };
  }

  /**
   * Manually close a position
   */
  async closePosition(tokenAddress: string, reason: string = 'MANUAL_CLOSE'): Promise<boolean> {
    const positions = await this.getOpenPositions();
    const position = positions.find(p => p.tokenAddress === tokenAddress);

    if (!position) {
      return false;
    }

    const result = await tradeExecutor.executeSell({
      tokenAddress: position.tokenAddress,
      tokenTicker: position.tokenTicker,
      positionId: position.id,
      sellPercent: 100,
      reason,
    });

    return result.success;
  }

  // ============ DATABASE HELPERS ============

  private async updatePositionPrice(positionId: string, currentPrice: number): Promise<void> {
    await pool.query(
      `UPDATE positions SET current_price = $2, updated_at = NOW() WHERE id = $1`,
      [positionId, currentPrice]
    );
  }

  private async markTp1Hit(positionId: string): Promise<void> {
    await pool.query(
      `UPDATE positions SET take_profit_1_hit = true, updated_at = NOW() WHERE id = $1`,
      [positionId]
    );
  }

  private async markTp2Hit(positionId: string): Promise<void> {
    await pool.query(
      `UPDATE positions SET take_profit_2_hit = true, updated_at = NOW() WHERE id = $1`,
      [positionId]
    );
  }
}

// ============ SINGLETON EXPORT ============

export const positionManager = new PositionManager();

export default positionManager;
