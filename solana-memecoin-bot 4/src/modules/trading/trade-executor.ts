// ===========================================
// TRADE EXECUTOR
// Orchestrates buy/sell operations with conviction-based sizing
// ===========================================

import { logger } from '../../utils/logger.js';
import { botWallet, WalletBalance } from './wallet.js';
import { jupiterClient, SwapResult } from './jupiter.js';
import { raydiumClient } from './raydium.js';
import { Database, pool } from '../../utils/database.js';
import { SignalType, BuySignal, DiscoverySignal, ConvictionLevel } from '../../types/index.js';

// ============ TYPES ============

export type SignalCategory =
  | 'ULTRA_CONVICTION'    // 3+ KOLs buying
  | 'HIGH_CONVICTION'     // 2 KOLs buying
  | 'SCORE_90_PLUS'       // Score >= 90
  | 'KOL_VALIDATION'      // KOL validates discovery
  | 'MANUAL_CONFIRM';     // Lower scores requiring confirmation

export interface TradeConfig {
  // Position sizing (% of portfolio)
  positionSizes: Record<SignalCategory, { min: number; max: number }>;

  // Stop losses (negative %)
  stopLosses: Record<SignalCategory, number>;

  // Time decay stops
  timeDecayStops: Record<SignalCategory, { threshold: number; hours: number; tightenTo: number }>;

  // Take profits
  takeProfits: Record<SignalCategory, { tp1Percent: number; tp1Sell: number; tp2Percent: number; tp2Sell: number }>;

  // Confirmation windows (seconds)
  confirmationWindows: Record<SignalCategory, number>;

  // General limits
  maxSingleTradeSol: number;
  minTradeSol: number;
  defaultSlippageBps: number;
}

export interface TradeRequest {
  tokenAddress: string;
  tokenTicker: string;
  tokenName: string;
  signalId: string;
  signalType: SignalType;
  signalCategory: SignalCategory;
  score: number;
  currentPrice: number;
  requestedSolAmount?: number; // Override position sizing
}

export interface TradeResult {
  success: boolean;
  signature?: string;
  tokenAddress: string;
  tokenTicker: string;
  solSpent: number;
  tokensReceived: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  positionId?: string;
  error?: string;
}

export interface SellRequest {
  tokenAddress: string;
  tokenTicker: string;
  positionId: string;
  sellPercent: number;
  reason: string;
}

export interface SellResult {
  success: boolean;
  signature?: string;
  tokenAddress: string;
  tokensSold: number;
  solReceived: number;
  pnlPercent: number;
  pnlSol: number;
  error?: string;
}

// ============ DEFAULT TRADE CONFIG ============

export const DEFAULT_TRADE_CONFIG: TradeConfig = {
  positionSizes: {
    ULTRA_CONVICTION: { min: 15, max: 20 },
    HIGH_CONVICTION: { min: 10, max: 12 },
    SCORE_90_PLUS: { min: 8, max: 10 },
    KOL_VALIDATION: { min: 6, max: 8 },
    MANUAL_CONFIRM: { min: 4, max: 5 },
  },

  stopLosses: {
    ULTRA_CONVICTION: -65,
    HIGH_CONVICTION: -55,
    SCORE_90_PLUS: -45,
    KOL_VALIDATION: -40,
    MANUAL_CONFIRM: -35,
  },

  timeDecayStops: {
    ULTRA_CONVICTION: { threshold: -40, hours: 6, tightenTo: -50 },
    HIGH_CONVICTION: { threshold: -35, hours: 4, tightenTo: -45 },
    SCORE_90_PLUS: { threshold: -30, hours: 3, tightenTo: -35 },
    KOL_VALIDATION: { threshold: -25, hours: 2, tightenTo: -30 },
    MANUAL_CONFIRM: { threshold: -20, hours: 1, tightenTo: -25 },
  },

  takeProfits: {
    ULTRA_CONVICTION: { tp1Percent: 400, tp1Sell: 30, tp2Percent: 1500, tp2Sell: 70 },
    HIGH_CONVICTION: { tp1Percent: 300, tp1Sell: 35, tp2Percent: 800, tp2Sell: 65 },
    SCORE_90_PLUS: { tp1Percent: 200, tp1Sell: 40, tp2Percent: 500, tp2Sell: 60 },
    KOL_VALIDATION: { tp1Percent: 150, tp1Sell: 45, tp2Percent: 350, tp2Sell: 55 },
    MANUAL_CONFIRM: { tp1Percent: 100, tp1Sell: 50, tp2Percent: 250, tp2Sell: 50 },
  },

  confirmationWindows: {
    ULTRA_CONVICTION: 0,      // Auto-buy
    HIGH_CONVICTION: 0,       // Auto-buy
    SCORE_90_PLUS: 0,         // Auto-buy
    KOL_VALIDATION: 120,      // 2 minutes
    MANUAL_CONFIRM: 300,      // 5 minutes
  },

  maxSingleTradeSol: 10,
  minTradeSol: 0.05,
  defaultSlippageBps: 1000, // 10%
};

// ============ TRADE EXECUTOR CLASS ============

export class TradeExecutor {
  private config: TradeConfig;
  private tradingEnabled: boolean = true;
  private autoSellEnabled: boolean = true;

  constructor(config: TradeConfig = DEFAULT_TRADE_CONFIG) {
    this.config = config;
  }

  /**
   * Initialize the trade executor
   */
  async initialize(): Promise<boolean> {
    // Load settings from database
    await this.loadSettings();

    // Initialize wallet
    const walletReady = await botWallet.initialize();

    if (!walletReady) {
      logger.warn('Trade executor initialized but wallet not ready - trading disabled');
      this.tradingEnabled = false;
    }

    logger.info({ tradingEnabled: this.tradingEnabled }, 'Trade executor initialized');
    return walletReady;
  }

  /**
   * Load settings from database
   */
  private async loadSettings(): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT key, value FROM bot_settings WHERE key IN ('trading_enabled', 'auto_sell_enabled', 'max_single_trade', 'default_slippage')`
      );

      for (const row of result.rows) {
        switch (row.key) {
          case 'trading_enabled':
            this.tradingEnabled = row.value === 'true';
            break;
          case 'auto_sell_enabled':
            this.autoSellEnabled = row.value === 'true';
            break;
          case 'max_single_trade':
            this.config.maxSingleTradeSol = parseFloat(row.value);
            break;
          case 'default_slippage':
            this.config.defaultSlippageBps = parseInt(row.value);
            break;
        }
      }
    } catch (error) {
      // Settings table might not exist yet
      logger.debug({ error }, 'Failed to load settings, using defaults');
    }
  }

  /**
   * Determine signal category from signal data
   */
  determineSignalCategory(
    signalType: SignalType,
    score: number,
    conviction?: ConvictionLevel
  ): SignalCategory {
    // Ultra conviction: 3+ KOLs
    if (conviction?.isUltraConviction) {
      return 'ULTRA_CONVICTION';
    }

    // High conviction: 2 KOLs
    if (conviction?.isHighConviction) {
      return 'HIGH_CONVICTION';
    }

    // Score 90+
    if (score >= 90) {
      return 'SCORE_90_PLUS';
    }

    // KOL validation of discovery
    if (signalType === SignalType.KOL_VALIDATION) {
      return 'KOL_VALIDATION';
    }

    // Everything else requires confirmation
    return 'MANUAL_CONFIRM';
  }

  /**
   * Check if signal should auto-execute
   */
  shouldAutoExecute(category: SignalCategory): boolean {
    return this.config.confirmationWindows[category] === 0;
  }

  /**
   * Get confirmation window for a category
   */
  getConfirmationWindow(category: SignalCategory): number {
    return this.config.confirmationWindows[category];
  }

  /**
   * Calculate position size in SOL
   */
  async calculatePositionSize(category: SignalCategory): Promise<number> {
    const balance = await botWallet.getSolBalance();
    const sizeConfig = this.config.positionSizes[category];

    // Use midpoint of range
    const percent = (sizeConfig.min + sizeConfig.max) / 2;
    let solAmount = balance.sol * (percent / 100);

    // Apply limits
    solAmount = Math.min(solAmount, this.config.maxSingleTradeSol);
    solAmount = Math.max(solAmount, this.config.minTradeSol);

    // Don't spend more than available (keep 0.01 SOL for fees)
    solAmount = Math.min(solAmount, balance.sol - 0.01);

    return Math.floor(solAmount * 1000) / 1000; // Round to 3 decimals
  }

  /**
   * Check if token is blacklisted
   */
  async isBlacklisted(tokenAddress: string): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT 1 FROM token_blacklist WHERE token_address = $1`,
        [tokenAddress]
      );
      return result.rows.length > 0;
    } catch (error) {
      return false; // If table doesn't exist, not blacklisted
    }
  }

  /**
   * Check if already have open position
   */
  async hasOpenPosition(tokenAddress: string): Promise<boolean> {
    return Database.hasOpenPosition(tokenAddress);
  }

  /**
   * Execute a buy trade
   */
  async executeBuy(request: TradeRequest): Promise<TradeResult> {
    const { tokenAddress, tokenTicker, tokenName, signalId, signalCategory, score, currentPrice } = request;

    // Pre-flight checks
    if (!this.tradingEnabled) {
      return this.failedResult(tokenAddress, tokenTicker, 'Trading is disabled');
    }

    if (!botWallet.isReady()) {
      return this.failedResult(tokenAddress, tokenTicker, 'Wallet not initialized');
    }

    if (await this.isBlacklisted(tokenAddress)) {
      return this.failedResult(tokenAddress, tokenTicker, 'Token is blacklisted');
    }

    if (await this.hasOpenPosition(tokenAddress)) {
      return this.failedResult(tokenAddress, tokenTicker, 'Already have open position');
    }

    // Calculate position size
    const solAmount = request.requestedSolAmount || await this.calculatePositionSize(signalCategory);

    if (solAmount < this.config.minTradeSol) {
      return this.failedResult(tokenAddress, tokenTicker, `Position size ${solAmount} SOL below minimum ${this.config.minTradeSol}`);
    }

    if (!await botWallet.hasSufficientBalance(solAmount)) {
      return this.failedResult(tokenAddress, tokenTicker, 'Insufficient balance');
    }

    logger.info({
      tokenAddress,
      tokenTicker,
      solAmount,
      signalCategory,
      score,
    }, 'Executing buy trade');

    // Try Jupiter first, then Raydium as fallback
    let swapResult: SwapResult;

    swapResult = await jupiterClient.buyToken(
      tokenAddress,
      solAmount,
      this.config.defaultSlippageBps
    );

    if (!swapResult.success) {
      logger.info({ tokenAddress }, 'Jupiter failed, trying Raydium fallback');
      const raydiumResult = await raydiumClient.buyToken(
        tokenAddress,
        solAmount,
        this.config.defaultSlippageBps
      );

      if (raydiumResult.success) {
        swapResult = {
          success: true,
          signature: raydiumResult.signature,
          inputAmount: raydiumResult.inputAmount,
          outputAmount: raydiumResult.outputAmount,
          priceImpact: raydiumResult.priceImpact,
        };
      }
    }

    if (!swapResult.success) {
      return this.failedResult(tokenAddress, tokenTicker, swapResult.error || 'Swap failed');
    }

    // Calculate price levels
    const entryPrice = currentPrice; // Use signal price as entry
    const stopLossPercent = this.config.stopLosses[signalCategory];
    const tpConfig = this.config.takeProfits[signalCategory];

    const stopLoss = entryPrice * (1 + stopLossPercent / 100);
    const takeProfit1 = entryPrice * (1 + tpConfig.tp1Percent / 100);
    const takeProfit2 = entryPrice * (1 + tpConfig.tp2Percent / 100);

    // Record position in database
    const positionId = await this.recordPosition({
      tokenAddress,
      tokenTicker,
      tokenName,
      entryPrice,
      quantity: swapResult.outputAmount,
      signalId,
      signalCategory,
      stopLoss,
      takeProfit1,
      takeProfit2,
      tp1SellPercent: tpConfig.tp1Sell,
      tp2SellPercent: tpConfig.tp2Sell,
    });

    // Record trade in history
    await this.recordTrade({
      positionId,
      tokenAddress,
      tokenTicker,
      tradeType: 'BUY',
      solAmount: swapResult.inputAmount,
      tokenAmount: swapResult.outputAmount,
      price: entryPrice,
      signature: swapResult.signature || '',
    });

    logger.info({
      positionId,
      tokenAddress,
      tokenTicker,
      solSpent: swapResult.inputAmount,
      tokensReceived: swapResult.outputAmount,
      signature: swapResult.signature,
    }, 'Buy trade successful');

    return {
      success: true,
      signature: swapResult.signature,
      tokenAddress,
      tokenTicker,
      solSpent: swapResult.inputAmount,
      tokensReceived: swapResult.outputAmount,
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      positionId,
    };
  }

  /**
   * Execute a sell trade
   */
  async executeSell(request: SellRequest): Promise<SellResult> {
    const { tokenAddress, tokenTicker, positionId, sellPercent, reason } = request;

    if (!this.tradingEnabled) {
      return { success: false, tokenAddress, tokensSold: 0, solReceived: 0, pnlPercent: 0, pnlSol: 0, error: 'Trading disabled' };
    }

    if (!botWallet.isReady()) {
      return { success: false, tokenAddress, tokensSold: 0, solReceived: 0, pnlPercent: 0, pnlSol: 0, error: 'Wallet not initialized' };
    }

    // Get current token balance
    const balance = await botWallet.getTokenBalance(tokenAddress);
    if (balance <= 0) {
      return { success: false, tokenAddress, tokensSold: 0, solReceived: 0, pnlPercent: 0, pnlSol: 0, error: 'No tokens to sell' };
    }

    const amountToSell = balance * (sellPercent / 100);

    logger.info({
      tokenAddress,
      tokenTicker,
      sellPercent,
      amountToSell,
      reason,
    }, 'Executing sell trade');

    // Try Jupiter first
    let swapResult = await jupiterClient.sellToken(
      tokenAddress,
      amountToSell,
      this.config.defaultSlippageBps
    );

    if (!swapResult.success) {
      logger.info({ tokenAddress }, 'Jupiter sell failed, trying Raydium');
      const raydiumResult = await raydiumClient.sellToken(
        tokenAddress,
        amountToSell,
        this.config.defaultSlippageBps
      );

      if (raydiumResult.success) {
        swapResult = {
          success: true,
          signature: raydiumResult.signature,
          inputAmount: raydiumResult.inputAmount,
          outputAmount: raydiumResult.outputAmount,
          priceImpact: raydiumResult.priceImpact,
        };
      }
    }

    if (!swapResult.success) {
      return { success: false, tokenAddress, tokensSold: 0, solReceived: 0, pnlPercent: 0, pnlSol: 0, error: swapResult.error };
    }

    // Get position for PNL calculation
    const position = await this.getPosition(positionId);
    let pnlPercent = 0;
    let pnlSol = 0;

    if (position) {
      const currentPrice = swapResult.outputAmount / amountToSell;
      pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      pnlSol = swapResult.outputAmount - (position.entryPrice * amountToSell);
    }

    // Record trade
    await this.recordTrade({
      positionId,
      tokenAddress,
      tokenTicker,
      tradeType: 'SELL',
      solAmount: swapResult.outputAmount,
      tokenAmount: amountToSell,
      price: swapResult.outputAmount / amountToSell,
      signature: swapResult.signature || '',
      reason,
    });

    // Update position if full sell
    if (sellPercent >= 100) {
      await this.closePosition(positionId, reason, pnlSol);
    } else {
      await this.updatePositionQuantity(positionId, balance - amountToSell);
    }

    logger.info({
      positionId,
      tokenAddress,
      tokensSold: amountToSell,
      solReceived: swapResult.outputAmount,
      pnlPercent,
      pnlSol,
      signature: swapResult.signature,
    }, 'Sell trade successful');

    return {
      success: true,
      signature: swapResult.signature,
      tokenAddress,
      tokensSold: amountToSell,
      solReceived: swapResult.outputAmount,
      pnlPercent,
      pnlSol,
    };
  }

  /**
   * Emergency close all positions
   */
  async closeAllPositions(): Promise<{ closed: number; failed: number }> {
    const positions = await Database.getOpenPositions();
    let closed = 0;
    let failed = 0;

    for (const position of positions) {
      const result = await this.executeSell({
        tokenAddress: position.tokenAddress,
        tokenTicker: position.tokenTicker,
        positionId: position.id,
        sellPercent: 100,
        reason: 'EMERGENCY_CLOSE_ALL',
      });

      if (result.success) {
        closed++;
      } else {
        failed++;
      }
    }

    return { closed, failed };
  }

  // ============ DATABASE HELPERS ============

  private async recordPosition(data: {
    tokenAddress: string;
    tokenTicker: string;
    tokenName: string;
    entryPrice: number;
    quantity: number;
    signalId: string;
    signalCategory: SignalCategory;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    tp1SellPercent: number;
    tp2SellPercent: number;
  }): Promise<string> {
    const result = await pool.query(
      `INSERT INTO positions (
        token_address, token_ticker, entry_price, quantity, signal_id,
        stop_loss, take_profit_1, take_profit_2, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN')
      RETURNING id`,
      [
        data.tokenAddress,
        data.tokenTicker,
        data.entryPrice,
        data.quantity,
        data.signalId,
        data.stopLoss,
        data.takeProfit1,
        data.takeProfit2,
      ]
    );

    // Store additional data in new table
    await pool.query(
      `INSERT INTO position_config (
        position_id, signal_category, tp1_sell_percent, tp2_sell_percent
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (position_id) DO UPDATE SET
        signal_category = EXCLUDED.signal_category`,
      [result.rows[0].id, data.signalCategory, data.tp1SellPercent, data.tp2SellPercent]
    );

    return result.rows[0].id;
  }

  private async recordTrade(data: {
    positionId: string;
    tokenAddress: string;
    tokenTicker: string;
    tradeType: 'BUY' | 'SELL';
    solAmount: number;
    tokenAmount: number;
    price: number;
    signature: string;
    reason?: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO trade_history (
        position_id, token_address, token_ticker, trade_type,
        sol_amount, token_amount, price, tx_signature, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        data.positionId,
        data.tokenAddress,
        data.tokenTicker,
        data.tradeType,
        data.solAmount,
        data.tokenAmount,
        data.price,
        data.signature,
        data.reason,
      ]
    );
  }

  private async getPosition(positionId: string): Promise<{ entryPrice: number } | null> {
    const result = await pool.query(
      `SELECT entry_price FROM positions WHERE id = $1`,
      [positionId]
    );
    return result.rows.length > 0 ? { entryPrice: parseFloat(result.rows[0].entry_price) } : null;
  }

  private async closePosition(positionId: string, reason: string, pnl: number): Promise<void> {
    await pool.query(
      `UPDATE positions SET
        status = 'CLOSED',
        closed_at = NOW(),
        close_reason = $2,
        realized_pnl = $3,
        updated_at = NOW()
      WHERE id = $1`,
      [positionId, reason, pnl]
    );
  }

  private async updatePositionQuantity(positionId: string, newQuantity: number): Promise<void> {
    await pool.query(
      `UPDATE positions SET quantity = $2, updated_at = NOW() WHERE id = $1`,
      [positionId, newQuantity]
    );
  }

  private failedResult(tokenAddress: string, tokenTicker: string, error: string): TradeResult {
    logger.warn({ tokenAddress, tokenTicker, error }, 'Trade failed');
    return {
      success: false,
      tokenAddress,
      tokenTicker,
      solSpent: 0,
      tokensReceived: 0,
      entryPrice: 0,
      stopLoss: 0,
      takeProfit1: 0,
      takeProfit2: 0,
      error,
    };
  }

  // ============ GETTERS/SETTERS ============

  isTradingEnabled(): boolean {
    return this.tradingEnabled;
  }

  setTradingEnabled(enabled: boolean): void {
    this.tradingEnabled = enabled;
    pool.query(
      `INSERT INTO bot_settings (key, value) VALUES ('trading_enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [enabled.toString()]
    ).catch(err => logger.error({ err }, 'Failed to save trading_enabled setting'));
  }

  isAutoSellEnabled(): boolean {
    return this.autoSellEnabled;
  }

  setAutoSellEnabled(enabled: boolean): void {
    this.autoSellEnabled = enabled;
    pool.query(
      `INSERT INTO bot_settings (key, value) VALUES ('auto_sell_enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [enabled.toString()]
    ).catch(err => logger.error({ err }, 'Failed to save auto_sell_enabled setting'));
  }

  getConfig(): TradeConfig {
    return this.config;
  }

  updateConfig(updates: Partial<TradeConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}

// ============ SINGLETON EXPORT ============

export const tradeExecutor = new TradeExecutor();

export default tradeExecutor;
