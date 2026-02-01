// ===========================================
// AUTO TRADER
// Integrates signal generator with trade execution
// ===========================================

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import {
  tradeExecutor,
  TradeRequest,
  TradeResult,
  SignalCategory,
} from './trade-executor.js';
import { BuySignal, DiscoverySignal, SignalType, ConvictionLevel } from '../../types/index.js';

// ============ TYPES ============

export interface AutoTradeResult {
  action: 'AUTO_EXECUTED' | 'PENDING_CONFIRMATION' | 'SKIPPED' | 'FAILED';
  tradeResult?: TradeResult;
  confirmationId?: string;
  reason?: string;
}

// ============ AUTO TRADER CLASS ============

export class AutoTrader {
  private confirmationCallback?: (confirmation: any) => Promise<number | undefined>;

  /**
   * Set callback for sending confirmation requests to Telegram
   */
  setConfirmationCallback(callback: (confirmation: any) => Promise<number | undefined>): void {
    this.confirmationCallback = callback;
  }

  /**
   * Process a buy signal for auto-trading
   */
  async processSignal(
    signal: BuySignal | DiscoverySignal,
    conviction?: ConvictionLevel
  ): Promise<AutoTradeResult> {
    const tokenAddress = signal.tokenAddress;
    const tokenTicker = signal.tokenTicker;
    const tokenName = signal.tokenName;
    const score = signal.score.compositeScore;
    const signalType = signal.signalType;

    logger.info({
      tokenAddress,
      tokenTicker,
      score,
      signalType,
      hasConviction: !!conviction,
      isUltraConviction: conviction?.isUltraConviction,
      isHighConviction: conviction?.isHighConviction,
    }, 'Processing signal for auto-trade');

    // Check if auto-buy is enabled
    const autoBuyEnabled = await this.isAutoBuyEnabled();
    if (!autoBuyEnabled) {
      logger.info({ tokenAddress }, 'Auto-buy disabled, skipping');
      return { action: 'SKIPPED', reason: 'Auto-buy disabled' };
    }

    // Check if trading is enabled
    if (!tradeExecutor.isTradingEnabled()) {
      logger.info({ tokenAddress }, 'Trading paused, skipping');
      return { action: 'SKIPPED', reason: 'Trading paused' };
    }

    // Check if already have position
    if (await tradeExecutor.hasOpenPosition(tokenAddress)) {
      logger.info({ tokenAddress }, 'Already have position, skipping');
      return { action: 'SKIPPED', reason: 'Already have open position' };
    }

    // Check if blacklisted
    if (await tradeExecutor.isBlacklisted(tokenAddress)) {
      logger.info({ tokenAddress }, 'Token blacklisted, skipping');
      return { action: 'SKIPPED', reason: 'Token is blacklisted' };
    }

    // Determine signal category
    const category = tradeExecutor.determineSignalCategory(signalType, score, conviction);

    // Check if should auto-execute or require confirmation
    if (tradeExecutor.shouldAutoExecute(category)) {
      // Auto-execute the trade
      return await this.executeAutoTrade(signal, category, conviction);
    } else {
      // Request confirmation
      return await this.requestConfirmation(signal, category, conviction);
    }
  }

  /**
   * Execute an auto trade
   */
  private async executeAutoTrade(
    signal: BuySignal | DiscoverySignal,
    category: SignalCategory,
    conviction?: ConvictionLevel
  ): Promise<AutoTradeResult> {
    const currentPrice = signal.tokenMetrics.price;

    const request: TradeRequest = {
      tokenAddress: signal.tokenAddress,
      tokenTicker: signal.tokenTicker,
      tokenName: signal.tokenName,
      signalId: signal.id,
      signalType: signal.signalType,
      signalCategory: category,
      score: signal.score.compositeScore,
      currentPrice,
    };

    logger.info({
      tokenAddress: signal.tokenAddress,
      category,
      score: signal.score.compositeScore,
    }, 'Executing auto-trade');

    const result = await tradeExecutor.executeBuy(request);

    if (result.success) {
      logger.info({
        tokenAddress: signal.tokenAddress,
        solSpent: result.solSpent,
        tokensReceived: result.tokensReceived,
        signature: result.signature,
      }, 'Auto-trade executed successfully');

      return { action: 'AUTO_EXECUTED', tradeResult: result };
    } else {
      logger.error({
        tokenAddress: signal.tokenAddress,
        error: result.error,
      }, 'Auto-trade failed');

      return { action: 'FAILED', reason: result.error };
    }
  }

  /**
   * Request confirmation for a trade
   */
  private async requestConfirmation(
    signal: BuySignal | DiscoverySignal,
    category: SignalCategory,
    conviction?: ConvictionLevel
  ): Promise<AutoTradeResult> {
    if (!this.confirmationCallback) {
      logger.warn('No confirmation callback set, skipping confirmation');
      return { action: 'SKIPPED', reason: 'No confirmation handler' };
    }

    const confirmationWindow = tradeExecutor.getConfirmationWindow(category);
    const expiresAt = new Date(Date.now() + confirmationWindow * 1000);
    const suggestedSolAmount = await tradeExecutor.calculatePositionSize(category);

    const confirmationId = uuidv4();

    const confirmation = {
      id: confirmationId,
      signalId: signal.id,
      tokenAddress: signal.tokenAddress,
      tokenTicker: signal.tokenTicker,
      tokenName: signal.tokenName,
      signalType: signal.signalType,
      signalCategory: category,
      score: signal.score.compositeScore,
      currentPrice: signal.tokenMetrics.price,
      suggestedSolAmount,
      expiresAt,
    };

    logger.info({
      tokenAddress: signal.tokenAddress,
      category,
      confirmationWindow,
      suggestedSolAmount,
    }, 'Requesting trade confirmation');

    await this.confirmationCallback(confirmation);

    return { action: 'PENDING_CONFIRMATION', confirmationId };
  }

  /**
   * Check if auto-buy is enabled
   */
  private async isAutoBuyEnabled(): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT value FROM bot_settings WHERE key = 'auto_buy_enabled'`
      );
      return result.rows.length > 0 && result.rows[0].value === 'true';
    } catch (error) {
      return true; // Default to enabled
    }
  }

  /**
   * Manually trigger a buy (bypasses confirmation)
   */
  async manualBuy(
    tokenAddress: string,
    tokenTicker: string,
    solAmount: number
  ): Promise<TradeResult> {
    const request: TradeRequest = {
      tokenAddress,
      tokenTicker,
      tokenName: tokenTicker, // Use ticker as name if unknown
      signalId: `manual_${Date.now()}`,
      signalType: SignalType.BUY,
      signalCategory: 'MANUAL_CONFIRM',
      score: 0,
      currentPrice: 0, // Will be determined by swap
      requestedSolAmount: solAmount,
    };

    return await tradeExecutor.executeBuy(request);
  }
}

// ============ SINGLETON EXPORT ============

export const autoTrader = new AutoTrader();

export default autoTrader;
