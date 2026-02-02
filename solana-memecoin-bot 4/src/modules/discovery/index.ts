// ===========================================
// TOKEN DISCOVERY MODULE
// Phase 1: Multi-source token discovery for comprehensive market coverage
// ===========================================

export { volumeAnomalyScanner, VolumeAnomaly } from './volume-anomaly-scanner.js';
export { holderGrowthScanner, HolderGrowthSignal } from './holder-growth-scanner.js';
export { narrativeScanner, NarrativeToken } from './narrative-scanner.js';

import { volumeAnomalyScanner } from './volume-anomaly-scanner.js';
import { holderGrowthScanner } from './holder-growth-scanner.js';
import { narrativeScanner } from './narrative-scanner.js';
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
    ]);

    logger.info('Discovery engine initialized with all scanners');
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

    logger.info('Discovery engine started - all scanners active');
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

    logger.info('Discovery engine stopped');
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
}

// ============ SINGLETON INSTANCE ============

export const discoveryEngine = new DiscoveryEngine();
