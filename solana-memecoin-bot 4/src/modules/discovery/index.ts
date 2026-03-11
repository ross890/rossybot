// ===========================================
// TOKEN DISCOVERY MODULE
// Stripped down: Only Smart Money Scanner remains.
// Volume anomaly, holder growth, narrative scanners REMOVED (bloat).
// ===========================================

export {
  smartMoneyScanner,
  SmartMoneyScanner,
  SMART_MONEY_THRESHOLDS,
  DiscoverySource,
  SmartMoneyStatus,
} from './smart-money-scanner.js';

import { smartMoneyScanner } from './smart-money-scanner.js';
import { logger } from '../../utils/logger.js';

// ============ UNIFIED DISCOVERY ENGINE ============

class DiscoveryEngine {
  private isRunning = false;

  async initialize(): Promise<void> {
    logger.info('Initializing discovery engine (smart money only)...');
    await smartMoneyScanner.initialize();
    logger.info('Discovery engine initialized');
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    smartMoneyScanner.start();
    logger.info('Discovery engine started (smart money scanner active)');
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    smartMoneyScanner.stop();
    logger.info('Discovery engine stopped');
  }

  setSmartMoneyNotifyCallback(callback: (message: string) => Promise<void>): void {
    smartMoneyScanner.setNotifyCallback(callback);
  }

  async getSmartMoneyStats() {
    return smartMoneyScanner.getStats();
  }

  async formatSmartMoneyStats(): Promise<string> {
    return smartMoneyScanner.formatStatsMessage();
  }

  /**
   * Get all discovered token addresses
   * With bloat scanners removed, this returns empty — candidates come from
   * DexScreener + Jupiter + KOL tracker in signal-generator.
   */
  async getAllDiscoveredTokens(): Promise<string[]> {
    return [];
  }

  getStats(): { isRunning: boolean } {
    return { isRunning: this.isRunning };
  }

  async observeTradeForSmartMoney(trade: {
    walletAddress: string;
    tokenAddress: string;
    tokenTicker?: string;
    tradeType: 'BUY' | 'SELL';
    solAmount: number;
    tokenAmount: number;
    priceAtTrade: number;
    tokenAgeAtTrade?: number;
    txSignature: string;
    blockTime: Date;
  }): Promise<void> {
    await smartMoneyScanner.observeTrade(trade);
  }
}

// ============ SINGLETON INSTANCE ============

export const discoveryEngine = new DiscoveryEngine();
