// ===========================================
// TOKEN DISCOVERY MODULE
// Smart Money Scanner + Wallet Discovery Engine
// ===========================================

export {
  smartMoneyScanner,
  SmartMoneyScanner,
  SMART_MONEY_THRESHOLDS,
  DiscoverySource,
  SmartMoneyStatus,
} from './smart-money-scanner.js';

export {
  walletDiscoveryEngine,
  WalletDiscoveryEngine,
} from './wallet-discovery.js';

export { rotationDetector, type RotationSignal } from './rotation-detector.js';
export { firstBuyerQuality, type FirstBuyerQuality } from './first-buyer-quality.js';
export { bondingVelocityTracker, type BondingVelocity } from './bonding-velocity.js';
export { walletClustering, type ClusterAnalysis } from './wallet-clustering.js';
export { trendingScanner, type TrendingDigest, type TrendingToken } from './trending-scanner.js';

// Phase 2: New discovery sources
export { twitterScanner, TwitterScanner, type SocialVelocity } from './twitterScanner.js';
export { whaleDetector, WhaleDetector, type WhaleBuy, type WhaleCluster, type WhaleScoreBonus } from './whaleDetector.js';
export { liquidityMonitor, LiquidityMonitor, type LiquidityEvent, type LiquidityScoreBonus } from './liquidityMonitor.js';

import { smartMoneyScanner } from './smart-money-scanner.js';
import { walletDiscoveryEngine } from './wallet-discovery.js';
import { twitterScanner } from './twitterScanner.js';
import { whaleDetector } from './whaleDetector.js';
import { logger } from '../../utils/logger.js';

// ============ UNIFIED DISCOVERY ENGINE ============

class DiscoveryEngine {
  private isRunning = false;

  async initialize(): Promise<void> {
    logger.info('Initializing discovery engine...');
    await smartMoneyScanner.initialize();
    await twitterScanner.initialize();
    await whaleDetector.initialize();
    logger.info('Discovery engine initialized (smart money + twitter + whale detector)');
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    smartMoneyScanner.start();
    walletDiscoveryEngine.start();
    twitterScanner.start();
    logger.info('Discovery engine started (smart money + wallet discovery + twitter active)');
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    smartMoneyScanner.stop();
    walletDiscoveryEngine.stop();
    twitterScanner.stop();
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
