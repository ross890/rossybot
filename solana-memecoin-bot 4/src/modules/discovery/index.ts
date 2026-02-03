// ===========================================
// TOKEN DISCOVERY MODULE
// Phase 1: Multi-source token discovery for comprehensive market coverage
// Phase 2: Smart Money auto-discovery (KOLScan alternative)
// ===========================================

export { volumeAnomalyScanner, VolumeAnomaly } from './volume-anomaly-scanner.js';
export { holderGrowthScanner, HolderGrowthSignal } from './holder-growth-scanner.js';
export { narrativeScanner, NarrativeToken } from './narrative-scanner.js';
export {
  smartMoneyScanner,
  SmartMoneyScanner,
  SMART_MONEY_THRESHOLDS,
  DiscoverySource,
  SmartMoneyStatus,
} from './smart-money-scanner.js';

import { volumeAnomalyScanner } from './volume-anomaly-scanner.js';
import { holderGrowthScanner } from './holder-growth-scanner.js';
import { narrativeScanner } from './narrative-scanner.js';
import { smartMoneyScanner } from './smart-money-scanner.js';
import { logger } from '../../utils/logger.js';

// ============ UNIFIED DISCOVERY ENGINE ============

class DiscoveryEngine {
  private isRunning = false;

  /**
   * Initialize all discovery scanners
   */
  async initialize(): Promise<void> {
    logger.info('Initializing discovery engine...');

    await Promise.all([
      volumeAnomalyScanner.initialize(),
      holderGrowthScanner.initialize(),
      narrativeScanner.initialize(),
      smartMoneyScanner.initialize(),
    ]);

    logger.info('Discovery engine initialized with all scanners (including Smart Money Scanner)');
  }

  /**
   * Start all discovery scanners
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Discovery engine already running');
      return;
    }

    this.isRunning = true;

    volumeAnomalyScanner.start();
    holderGrowthScanner.start();
    narrativeScanner.start();
    smartMoneyScanner.start();

    logger.info('Discovery engine started - all scanners active (including Smart Money Scanner)');
  }

  /**
   * Stop all discovery scanners
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    volumeAnomalyScanner.stop();
    holderGrowthScanner.stop();
    narrativeScanner.stop();
    smartMoneyScanner.stop();

    logger.info('Discovery engine stopped');
  }

  /**
   * Set notification callback for smart money alerts
   */
  setSmartMoneyNotifyCallback(callback: (message: string) => Promise<void>): void {
    smartMoneyScanner.setNotifyCallback(callback);
  }

  /**
   * Get smart money scanner stats
   */
  async getSmartMoneyStats() {
    return smartMoneyScanner.getStats();
  }

  /**
   * Format smart money stats for display
   */
  async formatSmartMoneyStats(): Promise<string> {
    return smartMoneyScanner.formatStatsMessage();
  }

  /**
   * Get all discovered token addresses (deduplicated)
   * This is the main interface for signal-generator to get candidates
   */
  async getAllDiscoveredTokens(): Promise<string[]> {
    const addresses = new Set<string>();

    try {
      // Get from volume anomaly scanner
      const volumeAnomalies = await volumeAnomalyScanner.getAnomalyAddresses();
      for (const addr of volumeAnomalies) {
        addresses.add(addr);
      }

      // Get from holder growth scanner
      const holderGrowth = await holderGrowthScanner.getGrowthAddresses();
      for (const addr of holderGrowth) {
        addresses.add(addr);
      }

      // Get from narrative scanner
      const narrativeTokens = narrativeScanner.getTokenAddresses();
      for (const addr of narrativeTokens) {
        addresses.add(addr);
      }

      logger.debug({
        volumeAnomalies: volumeAnomalies.length,
        holderGrowth: holderGrowth.length,
        narrativeTokens: narrativeTokens.length,
        unique: addresses.size,
      }, 'Discovery engine collected tokens');

    } catch (error) {
      logger.error({ error }, 'Error collecting discovered tokens');
    }

    return Array.from(addresses);
  }

  /**
   * Get detailed stats from all scanners
   */
  getStats(): {
    isRunning: boolean;
    volumeAnomalyStats: ReturnType<typeof volumeAnomalyScanner.getStats>;
    holderGrowthStats: ReturnType<typeof holderGrowthScanner.getStats>;
    narrativeStats: ReturnType<typeof narrativeScanner.getStats>;
  } {
    return {
      isRunning: this.isRunning,
      volumeAnomalyStats: volumeAnomalyScanner.getStats(),
      holderGrowthStats: holderGrowthScanner.getStats(),
      narrativeStats: narrativeScanner.getStats(),
    };
  }

  /**
   * Observe a trade for smart money tracking
   * Called from signal generator when a high-value trade is detected
   */
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
