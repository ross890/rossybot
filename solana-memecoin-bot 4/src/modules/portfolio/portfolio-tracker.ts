// ===========================================
// PORTFOLIO TRACKER MODULE
// Tracks user wallet holdings and sends TP/SL alerts
// Part of Established Token Strategy v2
// ===========================================

import axios from 'axios';
import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { Database } from '../../utils/database.js';
import { dexScreenerClient, getTokenMetrics } from '../onchain.js';
import {
  TokenTier,
  TIER_CONFIG,
  TAKE_PROFIT_CONFIG,
  getTokenTier,
  getStopLossForTier,
} from '../mature-token/types.js';

// ============ TYPES ============

interface WalletTokenBalance {
  tokenAddress: string;
  amount: number;
  decimals: number;
  uiAmount: number;
}

interface PortfolioPosition {
  id: string;
  walletAddress: string;
  tokenAddress: string;
  tokenTicker: string;
  tokenName: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  unrealizedPnlPercent: number;
  peakPnlPercent: number;
  tokenTier: string;
  stopLossPrice: number;
  stopLossPercent: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  takeProfit3Price: number;
  status: string;
  trailingStopActive: boolean;
  trailingStopPrice: number;
  telegramChatId: string;
}

interface AlertCheck {
  type: string;
  shouldAlert: boolean;
  message?: string;
  urgency?: 'HIGH' | 'MEDIUM' | 'LOW';
  newStatus?: string;
}

// ============ CONFIGURATION ============

const PORTFOLIO_CONFIG = {
  // Default user wallet to track
  defaultWalletAddress: '5q4fLUNhpWfokTj71T6JTjRhweerM9TNHMCrJCeffVVw',

  // Monitoring intervals
  priceCheckIntervalMs: 30 * 1000,  // Check prices every 30 seconds
  walletSyncIntervalMs: 5 * 60 * 1000,  // Sync wallet every 5 minutes

  // Alert thresholds (approaching TP/SL)
  approachingThresholdPercent: 5,  // Alert when within 5% of target

  // Trailing stop config (after TP3)
  trailingStopPercent: 20,  // 20% trailing stop after +100%

  // Rate limiting for alerts
  alertCooldownMinutes: 60,  // Don't repeat same alert type within 60 mins
};

// ============ HELIUS WALLET CLIENT ============

class HeliusWalletClient {
  private apiKey: string;
  private rpcUrl: string;

  constructor() {
    this.apiKey = appConfig.heliusApiKey;
    this.rpcUrl = appConfig.heliusRpcUrl;
  }

  /**
   * Get all token balances for a wallet
   */
  async getTokenBalances(walletAddress: string): Promise<WalletTokenBalance[]> {
    try {
      const response = await axios.post(this.rpcUrl, {
        jsonrpc: '2.0',
        id: 'token-balances',
        method: 'getTokenAccountsByOwner',
        params: [
          walletAddress,
          { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          { encoding: 'jsonParsed' },
        ],
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });

      const accounts = response.data.result?.value || [];
      const balances: WalletTokenBalance[] = [];

      for (const account of accounts) {
        const parsed = account.account.data.parsed;
        if (parsed && parsed.info) {
          const info = parsed.info;
          const uiAmount = info.tokenAmount?.uiAmount || 0;

          // Skip zero balances and very small amounts
          if (uiAmount > 0.0001) {
            balances.push({
              tokenAddress: info.mint,
              amount: parseInt(info.tokenAmount?.amount || '0'),
              decimals: info.tokenAmount?.decimals || 0,
              uiAmount,
            });
          }
        }
      }

      logger.debug({ walletAddress, tokenCount: balances.length }, 'Fetched wallet token balances');
      return balances;
    } catch (error: any) {
      logger.error({ error: error.message, walletAddress }, 'Failed to get wallet token balances');
      return [];
    }
  }

  /**
   * Get recent transactions for a wallet (to detect new buys)
   */
  async getRecentTransactions(walletAddress: string, limit = 50): Promise<any[]> {
    try {
      const response = await axios.post(this.rpcUrl, {
        jsonrpc: '2.0',
        id: 'recent-txs',
        method: 'getSignaturesForAddress',
        params: [walletAddress, { limit }],
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });

      return response.data.result || [];
    } catch (error: any) {
      logger.error({ error: error.message, walletAddress }, 'Failed to get recent transactions');
      return [];
    }
  }
}

// ============ PORTFOLIO TRACKER CLASS ============

export class PortfolioTracker {
  private heliusClient: HeliusWalletClient;
  private isRunning = false;
  private priceCheckInterval: NodeJS.Timeout | null = null;
  private walletSyncInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.heliusClient = new HeliusWalletClient();
  }

  /**
   * Initialize portfolio tracking for a wallet
   */
  async initializePortfolio(
    walletAddress: string,
    telegramChatId: string,
    label?: string
  ): Promise<{ portfolioId: string; isNew: boolean }> {
    const result = await Database.createUserPortfolio(walletAddress, telegramChatId, label);

    if (result.isNew) {
      logger.info({ walletAddress, portfolioId: result.id }, 'Created new portfolio tracking');

      // Initial sync of wallet holdings
      await this.syncWalletHoldings(walletAddress);
    } else {
      logger.info({ walletAddress, portfolioId: result.id }, 'Portfolio tracking already exists');
    }

    return { portfolioId: result.id, isNew: result.isNew };
  }

  /**
   * Sync wallet holdings with database
   * Detects new positions and closed positions
   */
  async syncWalletHoldings(walletAddress: string): Promise<{
    tokensFound: number;
    newPositions: number;
    closedPositions: number;
  }> {
    const startTime = Date.now();
    let tokensFound = 0;
    let newPositions = 0;
    let closedPositions = 0;
    let error: string | undefined;

    try {
      const portfolio = await Database.getUserPortfolio(walletAddress);
      if (!portfolio) {
        logger.warn({ walletAddress }, 'Portfolio not found for wallet');
        return { tokensFound: 0, newPositions: 0, closedPositions: 0 };
      }

      // Get current token balances from wallet
      const balances = await this.heliusClient.getTokenBalances(walletAddress);
      tokensFound = balances.length;

      // Get existing active positions
      const existingPositions = await Database.getActivePortfolioPositions(walletAddress);
      const existingTokens = new Set(existingPositions.map(p => p.tokenAddress));

      // Check for new positions (tokens in wallet but not tracked)
      for (const balance of balances) {
        if (!existingTokens.has(balance.tokenAddress)) {
          // New token detected - create position
          const position = await this.createPositionFromBalance(
            portfolio.id,
            walletAddress,
            balance
          );
          if (position) {
            newPositions++;
            logger.info({
              walletAddress,
              tokenAddress: balance.tokenAddress,
              ticker: position.tokenTicker,
            }, 'New portfolio position detected');
          }
        }
      }

      // Check for closed positions (tokens tracked but no longer in wallet)
      const currentTokens = new Set(balances.map(b => b.tokenAddress));
      for (const position of existingPositions) {
        if (!currentTokens.has(position.tokenAddress)) {
          // Token no longer in wallet - mark as closed
          const currentPrice = await this.getCurrentPrice(position.tokenAddress);
          await Database.closePortfolioPosition(
            position.id,
            currentPrice || position.currentPrice || position.entryPrice,
            null,
            'SOLD'
          );
          closedPositions++;
          logger.info({
            walletAddress,
            tokenAddress: position.tokenAddress,
            ticker: position.tokenTicker,
          }, 'Portfolio position closed (token sold)');
        }
      }

      // Update sync time
      await Database.updatePortfolioSyncTime(portfolio.id);

      // Log sync result
      await Database.logPortfolioSync({
        portfolioId: portfolio.id,
        walletAddress,
        tokensFound,
        newPositions,
        closedPositions,
        syncDurationMs: Date.now() - startTime,
        error,
      });

      logger.info({
        walletAddress,
        tokensFound,
        newPositions,
        closedPositions,
        durationMs: Date.now() - startTime,
      }, 'Wallet sync completed');

    } catch (err: any) {
      error = err.message;
      logger.error({ error, walletAddress }, 'Failed to sync wallet holdings');
    }

    return { tokensFound, newPositions, closedPositions };
  }

  /**
   * Create a position from a wallet balance
   */
  private async createPositionFromBalance(
    portfolioId: string,
    walletAddress: string,
    balance: WalletTokenBalance
  ): Promise<{ tokenTicker: string } | null> {
    try {
      // Get token metrics from DexScreener
      const pairs = await dexScreenerClient.getTokenPairs(balance.tokenAddress);
      if (!pairs || pairs.length === 0) {
        logger.debug({ tokenAddress: balance.tokenAddress }, 'No pairs found for token, skipping');
        return null;
      }

      const pair = pairs[0];
      const currentPrice = parseFloat(pair.priceUsd || '0');
      const marketCap = pair.fdv || 0;

      if (currentPrice === 0) {
        logger.debug({ tokenAddress: balance.tokenAddress }, 'Price is 0, skipping');
        return null;
      }

      // Determine tier
      const tier = getTokenTier(marketCap);

      // Calculate TP/SL levels
      const stopLossPercent = tier ? getStopLossForTier(tier) : 20;
      const stopLossPrice = currentPrice * (1 - stopLossPercent / 100);

      const tp1Price = currentPrice * (1 + TAKE_PROFIT_CONFIG.tp1.percent / 100);
      const tp2Price = currentPrice * (1 + TAKE_PROFIT_CONFIG.tp2.percent / 100);
      const tp3Price = currentPrice * (1 + TAKE_PROFIT_CONFIG.tp3.percent / 100);

      // Create position
      await Database.createPortfolioPosition({
        portfolioId,
        walletAddress,
        tokenAddress: balance.tokenAddress,
        tokenTicker: pair.baseToken?.symbol || 'UNKNOWN',
        tokenName: pair.baseToken?.name || 'Unknown Token',
        entryPrice: currentPrice,
        entryTimestamp: new Date(),  // Use now since we don't know actual buy time
        quantity: balance.uiAmount,
        entryMarketCap: marketCap,
        tokenTier: tier || undefined,
        stopLossPrice,
        stopLossPercent,
        takeProfit1Price: tp1Price,
        takeProfit2Price: tp2Price,
        takeProfit3Price: tp3Price,
      });

      return { tokenTicker: pair.baseToken?.symbol || 'UNKNOWN' };
    } catch (error: any) {
      logger.error({ error: error.message, tokenAddress: balance.tokenAddress }, 'Failed to create position');
      return null;
    }
  }

  /**
   * Get current price for a token
   */
  private async getCurrentPrice(tokenAddress: string): Promise<number | null> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs && pairs.length > 0) {
        return parseFloat(pairs[0].priceUsd || '0');
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check all positions for TP/SL alerts
   */
  async checkPositionsForAlerts(): Promise<void> {
    try {
      const positions = await Database.getAllActivePortfolioPositions();

      for (const position of positions) {
        // Get current price
        const currentPrice = await this.getCurrentPrice(position.tokenAddress);
        if (!currentPrice) continue;

        // Update position price
        const pairs = await dexScreenerClient.getTokenPairs(position.tokenAddress);
        const currentMarketCap = pairs?.[0]?.fdv || undefined;
        await Database.updatePortfolioPositionPrice(position.id, currentPrice, currentMarketCap);

        // Calculate current PnL
        const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        // Check for alerts
        const alerts = this.checkAlerts({
          ...position,
          currentPrice,
          unrealizedPnlPercent: pnlPercent,
        });

        // Process alerts
        for (const alert of alerts) {
          if (alert.shouldAlert) {
            // Check if we've already sent this alert recently
            const hasRecent = await Database.hasRecentAlert(
              position.id,
              alert.type,
              PORTFOLIO_CONFIG.alertCooldownMinutes
            );

            if (!hasRecent) {
              // Log the alert
              await Database.logPortfolioAlert({
                positionId: position.id,
                walletAddress: position.walletAddress,
                tokenAddress: position.tokenAddress,
                alertType: alert.type,
                priceAtAlert: currentPrice,
                pnlAtAlert: pnlPercent,
                message: alert.message,
              });

              // Update position status if needed
              if (alert.newStatus) {
                await Database.updatePortfolioPositionStatus(position.id, alert.newStatus);
              }

              // Send Telegram alert
              await this.sendTelegramAlert(position, alert, currentPrice, pnlPercent);
            }
          }
        }

        // Update trailing stop if active
        if (position.trailingStopActive && currentPrice > (position.trailingStopPrice || 0)) {
          const newTrailingStop = currentPrice * (1 - PORTFOLIO_CONFIG.trailingStopPercent / 100);
          if (newTrailingStop > (position.trailingStopPrice || 0)) {
            await Database.updateTrailingStop(position.id, newTrailingStop);
          }
        }
      }
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to check positions for alerts');
    }
  }

  /**
   * Check all alert conditions for a position
   */
  private checkAlerts(position: PortfolioPosition): AlertCheck[] {
    const alerts: AlertCheck[] = [];
    const pnl = position.unrealizedPnlPercent;
    const price = position.currentPrice;

    // ============ STOP LOSS ALERTS ============

    // Stop loss hit
    if (price <= position.stopLossPrice) {
      alerts.push({
        type: 'STOP_LOSS_HIT',
        shouldAlert: true,
        message: this.formatStopLossHitMessage(position),
        urgency: 'HIGH',
        newStatus: 'STOPPED_OUT',
      });
    }
    // Approaching stop loss (within 5%)
    else if (pnl <= -(position.stopLossPercent - PORTFOLIO_CONFIG.approachingThresholdPercent)) {
      alerts.push({
        type: 'STOP_APPROACHING',
        shouldAlert: true,
        message: this.formatStopApproachingMessage(position),
        urgency: 'MEDIUM',
      });
    }

    // ============ TAKE PROFIT ALERTS ============

    // TP1 hit (+30%)
    if (position.status === 'ACTIVE' && price >= position.takeProfit1Price) {
      alerts.push({
        type: 'TP1_HIT',
        shouldAlert: true,
        message: this.formatTPHitMessage(position, 1, TAKE_PROFIT_CONFIG.tp1.percent),
        urgency: 'HIGH',
        newStatus: 'TP1_HIT',
      });
    }
    // Approaching TP1
    else if (position.status === 'ACTIVE' && pnl >= (TAKE_PROFIT_CONFIG.tp1.percent - PORTFOLIO_CONFIG.approachingThresholdPercent)) {
      alerts.push({
        type: 'TP1_APPROACHING',
        shouldAlert: true,
        message: this.formatTPApproachingMessage(position, 1, TAKE_PROFIT_CONFIG.tp1.percent),
        urgency: 'MEDIUM',
      });
    }

    // TP2 hit (+60%)
    if (position.status === 'TP1_HIT' && price >= position.takeProfit2Price) {
      alerts.push({
        type: 'TP2_HIT',
        shouldAlert: true,
        message: this.formatTPHitMessage(position, 2, TAKE_PROFIT_CONFIG.tp2.percent),
        urgency: 'HIGH',
        newStatus: 'TP2_HIT',
      });
    }
    // Approaching TP2
    else if (position.status === 'TP1_HIT' && pnl >= (TAKE_PROFIT_CONFIG.tp2.percent - PORTFOLIO_CONFIG.approachingThresholdPercent)) {
      alerts.push({
        type: 'TP2_APPROACHING',
        shouldAlert: true,
        message: this.formatTPApproachingMessage(position, 2, TAKE_PROFIT_CONFIG.tp2.percent),
        urgency: 'MEDIUM',
      });
    }

    // TP3 hit (+100%)
    if (position.status === 'TP2_HIT' && price >= position.takeProfit3Price) {
      alerts.push({
        type: 'TP3_HIT',
        shouldAlert: true,
        message: this.formatTPHitMessage(position, 3, TAKE_PROFIT_CONFIG.tp3.percent),
        urgency: 'HIGH',
        newStatus: 'TP3_HIT',
      });
    }
    // Approaching TP3
    else if (position.status === 'TP2_HIT' && pnl >= (TAKE_PROFIT_CONFIG.tp3.percent - PORTFOLIO_CONFIG.approachingThresholdPercent)) {
      alerts.push({
        type: 'TP3_APPROACHING',
        shouldAlert: true,
        message: this.formatTPApproachingMessage(position, 3, TAKE_PROFIT_CONFIG.tp3.percent),
        urgency: 'MEDIUM',
      });
    }

    // ============ TRAILING STOP ALERTS ============

    if (position.trailingStopActive && position.trailingStopPrice && price <= position.trailingStopPrice) {
      alerts.push({
        type: 'TRAILING_STOP_HIT',
        shouldAlert: true,
        message: this.formatTrailingStopHitMessage(position),
        urgency: 'HIGH',
        newStatus: 'CLOSED',
      });
    }

    // ============ NEW HIGHS ============

    // New all-time high for position
    if (pnl > (position.peakPnlPercent || 0) && pnl >= 50 && pnl % 25 === 0) {
      alerts.push({
        type: 'NEW_HIGH',
        shouldAlert: true,
        message: this.formatNewHighMessage(position),
        urgency: 'LOW',
      });
    }

    return alerts;
  }

  // ============ MESSAGE FORMATTERS ============

  private formatStopLossHitMessage(position: PortfolioPosition): string {
    return `
🔴 *STOP LOSS HIT*

Token: *$${position.tokenTicker}*
Current: ${this.formatPrice(position.currentPrice)}
Entry: ${this.formatPrice(position.entryPrice)}
PnL: *${position.unrealizedPnlPercent.toFixed(2)}%*

⚠️ *ACTION: SELL NOW*
Consider exiting the position immediately.

[View on DEX](https://dexscreener.com/solana/${position.tokenAddress})
`.trim();
  }

  private formatStopApproachingMessage(position: PortfolioPosition): string {
    return `
⚠️ *APPROACHING STOP LOSS*

Token: *$${position.tokenTicker}*
Current: ${this.formatPrice(position.currentPrice)}
Stop: ${this.formatPrice(position.stopLossPrice)} (-${position.stopLossPercent}%)
PnL: *${position.unrealizedPnlPercent.toFixed(2)}%*

Monitor closely - near stop loss level.

[View on DEX](https://dexscreener.com/solana/${position.tokenAddress})
`.trim();
  }

  private formatTPHitMessage(position: PortfolioPosition, tpLevel: number, targetPercent: number): string {
    const sellPercent = tpLevel === 1 ? TAKE_PROFIT_CONFIG.tp1.sellPercent
      : tpLevel === 2 ? TAKE_PROFIT_CONFIG.tp2.sellPercent
      : TAKE_PROFIT_CONFIG.tp3.sellPercent;

    const emoji = tpLevel === 1 ? '🟢' : tpLevel === 2 ? '🟢🟢' : '🟢🟢🟢';

    return `
${emoji} *TAKE PROFIT ${tpLevel} HIT!*

Token: *$${position.tokenTicker}*
Current: ${this.formatPrice(position.currentPrice)}
Entry: ${this.formatPrice(position.entryPrice)}
PnL: *+${position.unrealizedPnlPercent.toFixed(2)}%*

✅ *ACTION: Sell ${sellPercent}% of position*
${tpLevel === 3 ? '📊 Trailing stop now active (-20%)' : `Next target: TP${tpLevel + 1}`}

[View on DEX](https://dexscreener.com/solana/${position.tokenAddress})
`.trim();
  }

  private formatTPApproachingMessage(position: PortfolioPosition, tpLevel: number, targetPercent: number): string {
    return `
📈 *Approaching TP${tpLevel}*

Token: *$${position.tokenTicker}*
Current: ${this.formatPrice(position.currentPrice)}
Target: +${targetPercent}%
PnL: *+${position.unrealizedPnlPercent.toFixed(2)}%*

Prepare to take profits soon.

[View on DEX](https://dexscreener.com/solana/${position.tokenAddress})
`.trim();
  }

  private formatTrailingStopHitMessage(position: PortfolioPosition): string {
    return `
📊 *TRAILING STOP HIT*

Token: *$${position.tokenTicker}*
Current: ${this.formatPrice(position.currentPrice)}
Trail Stop: ${this.formatPrice(position.trailingStopPrice)}
Peak PnL: +${position.peakPnlPercent?.toFixed(2) || '?'}%
Final PnL: *+${position.unrealizedPnlPercent.toFixed(2)}%*

✅ Excellent trade! Locked in profits.

[View on DEX](https://dexscreener.com/solana/${position.tokenAddress})
`.trim();
  }

  private formatNewHighMessage(position: PortfolioPosition): string {
    return `
🚀 *NEW HIGH*

Token: *$${position.tokenTicker}*
PnL: *+${position.unrealizedPnlPercent.toFixed(2)}%*

Position is at new all-time high!

[View on DEX](https://dexscreener.com/solana/${position.tokenAddress})
`.trim();
  }

  private formatPrice(price: number): string {
    if (price < 0.00001) return `$${price.toExponential(2)}`;
    if (price < 0.001) return `$${price.toFixed(6)}`;
    if (price < 1) return `$${price.toFixed(4)}`;
    return `$${price.toFixed(2)}`;
  }

  // ============ TELEGRAM INTEGRATION ============

  private async sendTelegramAlert(
    position: PortfolioPosition,
    alert: AlertCheck,
    currentPrice: number,
    pnlPercent: number
  ): Promise<void> {
    try {
      const chatId = position.telegramChatId || appConfig.telegramChatId;
      const url = `https://api.telegram.org/bot${appConfig.telegramBotToken}/sendMessage`;

      await axios.post(url, {
        chat_id: chatId,
        text: alert.message,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
      });

      logger.info({
        alertType: alert.type,
        tokenTicker: position.tokenTicker,
        pnlPercent: pnlPercent.toFixed(2),
      }, 'Portfolio alert sent');
    } catch (error: any) {
      logger.error({ error: error.message, alertType: alert.type }, 'Failed to send Telegram alert');
    }
  }

  // ============ MONITORING CONTROL ============

  /**
   * Start portfolio monitoring
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Portfolio tracker already running');
      return;
    }

    this.isRunning = true;

    // Start price checking interval
    this.priceCheckInterval = setInterval(
      () => this.checkPositionsForAlerts(),
      PORTFOLIO_CONFIG.priceCheckIntervalMs
    );

    // Start wallet sync interval
    this.walletSyncInterval = setInterval(
      async () => {
        const portfolios = await Database.getActiveUserPortfolios();
        for (const portfolio of portfolios) {
          await this.syncWalletHoldings(portfolio.walletAddress);
        }
      },
      PORTFOLIO_CONFIG.walletSyncIntervalMs
    );

    logger.info('Portfolio tracker started');
  }

  /**
   * Stop portfolio monitoring
   */
  stop(): void {
    if (this.priceCheckInterval) {
      clearInterval(this.priceCheckInterval);
      this.priceCheckInterval = null;
    }

    if (this.walletSyncInterval) {
      clearInterval(this.walletSyncInterval);
      this.walletSyncInterval = null;
    }

    this.isRunning = false;
    logger.info('Portfolio tracker stopped');
  }

  /**
   * Get portfolio summary for a wallet
   */
  async getPortfolioSummary(walletAddress: string): Promise<{
    totalPositions: number;
    activePositions: number;
    totalPnlPercent: number;
    positionsByStatus: Record<string, number>;
    topPerformers: Array<{ ticker: string; pnlPercent: number }>;
    worstPerformers: Array<{ ticker: string; pnlPercent: number }>;
  }> {
    const positions = await Database.getActivePortfolioPositions(walletAddress);

    const activePositions = positions.filter(p =>
      ['ACTIVE', 'TP1_HIT', 'TP2_HIT'].includes(p.status)
    );

    // Calculate total PnL (weighted average)
    let totalValue = 0;
    let totalCost = 0;
    for (const pos of activePositions) {
      if (pos.currentPrice && pos.entryPrice && pos.quantity) {
        totalValue += pos.currentPrice * pos.quantity;
        totalCost += pos.entryPrice * pos.quantity;
      }
    }
    const totalPnlPercent = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;

    // Count by status
    const positionsByStatus: Record<string, number> = {};
    for (const pos of positions) {
      positionsByStatus[pos.status] = (positionsByStatus[pos.status] || 0) + 1;
    }

    // Top and worst performers
    const sorted = activePositions
      .filter(p => p.unrealizedPnlPercent !== null)
      .sort((a, b) => (b.unrealizedPnlPercent || 0) - (a.unrealizedPnlPercent || 0));

    const topPerformers = sorted.slice(0, 3).map(p => ({
      ticker: p.tokenTicker,
      pnlPercent: p.unrealizedPnlPercent || 0,
    }));

    const worstPerformers = sorted.slice(-3).reverse().map(p => ({
      ticker: p.tokenTicker,
      pnlPercent: p.unrealizedPnlPercent || 0,
    }));

    return {
      totalPositions: positions.length,
      activePositions: activePositions.length,
      totalPnlPercent,
      positionsByStatus,
      topPerformers,
      worstPerformers,
    };
  }
}

// ============ SINGLETON INSTANCE ============

export const portfolioTracker = new PortfolioTracker();
export default portfolioTracker;
