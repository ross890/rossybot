// ===========================================
// SMART MONEY TRACKER
// Tracks whale and smart wallet activity for mature tokens
// ===========================================

import { logger } from '../../utils/logger.js';
import { heliusClient, dexScreenerClient } from '../onchain.js';
import { SmartMoneyMetrics, SMART_MONEY_THRESHOLDS } from './types.js';
import { appConfig } from '../../config/index.js';

// ============ CONSTANTS ============

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const WHALE_THRESHOLD_PERCENT = 1; // 1% of supply = whale
const SMART_MONEY_MIN_WIN_RATE = 0.55; // 55% win rate to be considered "smart"

// ============ CLASS ============

export class SmartMoneyTracker {
  private cache: Map<string, { metrics: SmartMoneyMetrics; timestamp: number }> = new Map();

  // Known smart money wallets (would be populated from database in production)
  private knownSmartWallets: Set<string> = new Set();

  /**
   * Analyze smart money activity for a mature token
   */
  async analyze(tokenAddress: string): Promise<SmartMoneyMetrics> {
    // Check cache
    const cached = this.cache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.metrics;
    }

    try {
      const [accumulationData, walletData, flowData] = await Promise.all([
        this.getAccumulationMetrics(tokenAddress),
        this.getWalletProfilingMetrics(tokenAddress),
        this.getFlowMetrics(tokenAddress),
      ]);

      const metrics: SmartMoneyMetrics = {
        ...accumulationData,
        ...walletData,
        ...flowData,
        smartMoneyScore: 0,
      };

      metrics.smartMoneyScore = this.calculateScore(metrics);

      // Cache result
      this.cache.set(tokenAddress, { metrics, timestamp: Date.now() });

      logger.debug({
        tokenAddress: tokenAddress.slice(0, 8),
        score: metrics.smartMoneyScore,
        whaleAccumulation: metrics.whaleAccumulation,
      }, 'Smart money analysis complete');

      return metrics;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to analyze smart money');
      return this.getDefaultMetrics();
    }
  }

  /**
   * Get accumulation signals from whale activity
   */
  private async getAccumulationMetrics(tokenAddress: string): Promise<{
    smartMoneyInflow24h: number;
    whaleAccumulation: number;
    avgWhaleBuySize: number;
    whaleBuySellRatio: number;
  }> {
    // Skip when Helius is disabled - return defaults
    if (appConfig.heliusDisabled) {
      return this.getDefaultAccumulationMetrics();
    }

    try {
      const [holderData, pairs] = await Promise.all([
        heliusClient.getTokenHolders(tokenAddress),
        dexScreenerClient.getTokenPairs(tokenAddress),
      ]);

      const holders = holderData.topHolders || [];
      const pair = pairs[0] as any;

      if (!pair) {
        return this.getDefaultAccumulationMetrics();
      }

      // Calculate total supply
      const totalSupply = holders.reduce((sum: number, h) => sum + h.amount, 0);

      // Identify whales (> 1% of supply)
      const whales = holders.filter((h) => {
        const balance = h.amount;
        return (balance / totalSupply) * 100 >= WHALE_THRESHOLD_PERCENT;
      });

      // Whale buy/sell analysis
      const buys24h = pair.txns?.h24?.buys || 0;
      const sells24h = pair.txns?.h24?.sells || 0;
      const vol24h = pair.volume?.h24 || 0;

      // Estimate whale portion of volume (whales typically 20-40% of volume)
      const whaleVolume = vol24h * 0.3;

      // Whale accumulation count (estimate based on holder patterns)
      // In production, would track individual whale wallet transactions
      const whaleBuyRatio = buys24h > sells24h ? 1.2 : 0.8;
      const whaleAccumulation = Math.floor(whales.length * (whaleBuyRatio > 1 ? 0.6 : 0.3));

      // Average whale buy size
      const avgWhaleBuySize = whaleAccumulation > 0 ? whaleVolume / whaleAccumulation : 0;

      // Whale buy/sell ratio
      const whaleBuySellRatio = buys24h > 0 ? (buys24h / sells24h) * 1.2 : 1;

      // Smart money inflow (estimated from large transactions)
      const smartMoneyInflow24h = whaleAccumulation > 0 ? whaleVolume * 0.5 : 0;

      return {
        smartMoneyInflow24h,
        whaleAccumulation,
        avgWhaleBuySize,
        whaleBuySellRatio,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get accumulation metrics');
      return this.getDefaultAccumulationMetrics();
    }
  }

  /**
   * Get wallet profiling metrics
   */
  private async getWalletProfilingMetrics(tokenAddress: string): Promise<{
    profitableWalletRatio: number;
    avgWalletWinRate: number;
    topTraderHoldings: number;
  }> {
    // Skip when Helius is disabled - return defaults
    if (appConfig.heliusDisabled) {
      return {
        profitableWalletRatio: 0.4,
        avgWalletWinRate: 0.5,
        topTraderHoldings: 0,
      };
    }

    try {
      const holderData = await heliusClient.getTokenHolders(tokenAddress);
      const holders = holderData.topHolders || [];

      // In production, would cross-reference each wallet with performance data
      // For now, estimate based on holder patterns

      // Profitable wallet ratio (estimate - wallets that bought lower than current)
      // Higher holder retention typically means more are in profit
      const profitableWalletRatio = 0.45; // Default estimate

      // Average wallet win rate (from known smart money database)
      const knownHolders = holders.filter((h) =>
        this.knownSmartWallets.has(h.address)
      );
      const avgWalletWinRate = knownHolders.length > 0 ? SMART_MONEY_MIN_WIN_RATE : 0.5;

      // Top trader holdings (% held by top performers)
      const totalSupply = holders.reduce((sum: number, h) => sum + h.amount, 0);
      const topTraderBalance = knownHolders.reduce((sum: number, h) => sum + h.amount, 0);
      const topTraderHoldings = totalSupply > 0
        ? (topTraderBalance / totalSupply) * 100
        : 0;

      return {
        profitableWalletRatio,
        avgWalletWinRate,
        topTraderHoldings,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get wallet profiling metrics');
      return {
        profitableWalletRatio: 0.4,
        avgWalletWinRate: 0.5,
        topTraderHoldings: 0,
      };
    }
  }

  /**
   * Get flow metrics (exchange, DEX, staking)
   */
  private async getFlowMetrics(tokenAddress: string): Promise<{
    exchangeNetFlow: number;
    dexLiquidityAdds: number;
    stakingIncrease: number;
    bridgeInflows: number;
    multiChainInterest: boolean;
  }> {
    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      const pair = pairs[0] as any;

      if (!pair) {
        return this.getDefaultFlowMetrics();
      }

      // Exchange net flow (positive = outflow from exchanges = bullish)
      // In production, would track CEX wallet movements
      const buys = pair.txns?.h24?.buys || 0;
      const sells = pair.txns?.h24?.sells || 0;
      const exchangeNetFlow = buys > sells ? (buys - sells) * 100 : (sells - buys) * -100;

      // DEX liquidity additions
      const liquidity = pair.liquidity?.usd || 0;
      // Estimate liquidity adds from current pool size
      const dexLiquidityAdds = liquidity > 100000 ? 3 : liquidity > 50000 ? 2 : liquidity > 20000 ? 1 : 0;

      // Staking (not typically applicable for memecoins)
      const stakingIncrease = 0;

      // Bridge inflows (cross-chain interest)
      // Would need to track bridge contracts
      const bridgeInflows = 0;
      const multiChainInterest = false;

      return {
        exchangeNetFlow,
        dexLiquidityAdds,
        stakingIncrease,
        bridgeInflows,
        multiChainInterest,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get flow metrics');
      return this.getDefaultFlowMetrics();
    }
  }

  /**
   * Calculate smart money score
   */
  private calculateScore(metrics: SmartMoneyMetrics): number {
    let score = 0;

    // Smart Money Inflow Score (0-25)
    if (metrics.smartMoneyInflow24h >= 50000) score += 25;
    else if (metrics.smartMoneyInflow24h >= 25000) score += 20;
    else if (metrics.smartMoneyInflow24h >= 10000) score += 15;
    else if (metrics.smartMoneyInflow24h >= 5000) score += 10;
    else if (metrics.smartMoneyInflow24h >= 1000) score += 5;

    // Whale Accumulation Score (0-20)
    if (metrics.whaleAccumulation >= 5) score += 20;
    else if (metrics.whaleAccumulation >= 3) score += 15;
    else if (metrics.whaleAccumulation >= 2) score += 10;
    else if (metrics.whaleAccumulation >= 1) score += 5;

    // Whale Buy/Sell Ratio Score (0-20)
    if (metrics.whaleBuySellRatio >= 3.0) score += 20;
    else if (metrics.whaleBuySellRatio >= 2.5) score += 16;
    else if (metrics.whaleBuySellRatio >= 2.0) score += 12;
    else if (metrics.whaleBuySellRatio >= 1.5) score += 8;
    else if (metrics.whaleBuySellRatio >= 1.2) score += 4;

    // Profitable Wallet Ratio Score (0-15)
    if (metrics.profitableWalletRatio >= 0.6) score += 15;
    else if (metrics.profitableWalletRatio >= 0.5) score += 12;
    else if (metrics.profitableWalletRatio >= 0.4) score += 8;
    else if (metrics.profitableWalletRatio >= 0.3) score += 4;

    // Exchange Net Flow Score (0-10) - Outflow is bullish
    if (metrics.exchangeNetFlow < -1000) score += 10; // Strong outflow
    else if (metrics.exchangeNetFlow < -500) score += 8;
    else if (metrics.exchangeNetFlow < 0) score += 5;
    else if (metrics.exchangeNetFlow < 500) score += 2;
    // Inflow (positive) = no points (bearish)

    // DEX Liquidity Adds Score (0-10)
    if (metrics.dexLiquidityAdds >= 3) score += 10;
    else if (metrics.dexLiquidityAdds >= 2) score += 7;
    else if (metrics.dexLiquidityAdds >= 1) score += 4;

    return Math.min(100, score);
  }

  /**
   * Check if smart money is accumulating
   */
  isSmartMoneyAccumulating(metrics: SmartMoneyMetrics): boolean {
    return (
      metrics.smartMoneyScore >= 50 &&
      metrics.whaleAccumulation >= SMART_MONEY_THRESHOLDS.whaleAccumulation.min &&
      metrics.whaleBuySellRatio >= SMART_MONEY_THRESHOLDS.whaleBuySellRatio.min
    );
  }

  /**
   * Add known smart money wallet
   */
  addSmartWallet(address: string): void {
    this.knownSmartWallets.add(address);
  }

  /**
   * Remove smart money wallet
   */
  removeSmartWallet(address: string): void {
    this.knownSmartWallets.delete(address);
  }

  /**
   * Get default metrics
   */
  private getDefaultMetrics(): SmartMoneyMetrics {
    return {
      smartMoneyInflow24h: 0,
      whaleAccumulation: 0,
      avgWhaleBuySize: 0,
      whaleBuySellRatio: 1,
      profitableWalletRatio: 0.4,
      avgWalletWinRate: 0.5,
      topTraderHoldings: 0,
      exchangeNetFlow: 0,
      dexLiquidityAdds: 0,
      stakingIncrease: 0,
      bridgeInflows: 0,
      multiChainInterest: false,
      smartMoneyScore: 0,
    };
  }

  private getDefaultAccumulationMetrics() {
    return {
      smartMoneyInflow24h: 0,
      whaleAccumulation: 0,
      avgWhaleBuySize: 0,
      whaleBuySellRatio: 1,
    };
  }

  private getDefaultFlowMetrics() {
    return {
      exchangeNetFlow: 0,
      dexLiquidityAdds: 0,
      stakingIncrease: 0,
      bridgeInflows: 0,
      multiChainInterest: false,
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// ============ EXPORTS ============

export const smartMoneyTracker = new SmartMoneyTracker();

export default {
  SmartMoneyTracker,
  smartMoneyTracker,
};
