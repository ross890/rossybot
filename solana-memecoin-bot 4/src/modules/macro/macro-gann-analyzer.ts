// ===========================================
// MACRO GANN ANALYZER - MAIN ORCHESTRATOR
// ===========================================
// Standalone module that coordinates all macro analysis
// Completely separate from memecoin signals

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import {
  MacroGannSignal,
  MacroConfig,
  DEFAULT_MACRO_CONFIG,
  GannAnalysis,
  GannPivot,
  PivotType,
  DerivativesMetrics,
  SentimentMetrics,
  WhaleActivityMetrics,
  OrderBookMetrics,
} from './types.js';

// Gann modules
import { gannSquareOfNine } from './gann/square-of-nine.js';
import { gannTimeCycles } from './gann/time-cycles.js';
import { gannAngles } from './gann/gann-angles.js';
import { gannConfluenceDetector } from './gann/confluence-detector.js';

// Data feeds
import { binanceClient } from './data-feeds/binance-client.js';
import { coinalyzeClient } from './data-feeds/coinalyze-client.js';
import { fearGreedClient } from './data-feeds/fear-greed-client.js';

// Analyzers
import { macroSignalGenerator } from './analyzers/signal-generator.js';

// Alerts
import { macroTelegramFormatter } from './alerts/macro-telegram.js';

/**
 * Macro Gann Analyzer
 *
 * Main orchestrator for the macro analysis module.
 * Coordinates data feeds, Gann analysis, and signal generation.
 *
 * This module is COMPLETELY ISOLATED from the memecoin signals.
 * It provides informational signals only.
 */
export class MacroGannAnalyzer extends EventEmitter {
  private config: MacroConfig;
  private isRunning = false;
  private refreshIntervals: NodeJS.Timeout[] = [];

  // Cached data
  private btcPrice = 0;
  private solPrice = 0;
  private pivots: GannPivot[] = [];
  private lastSignal: MacroGannSignal | null = null;
  private lastSignalTime = 0;

  // Cached metrics
  private derivativesCache: DerivativesMetrics | null = null;
  private sentimentCache: SentimentMetrics | null = null;
  private orderBookCache: OrderBookMetrics | null = null;

  constructor(config: Partial<MacroConfig> = {}) {
    super();
    this.config = { ...DEFAULT_MACRO_CONFIG, ...config };
  }

  /**
   * Initialize the analyzer
   */
  async initialize(): Promise<void> {
    logger.info('Initializing Macro Gann Analyzer...');

    try {
      // Fetch initial prices
      await this.refreshPrices();

      // Initialize default pivots if none exist
      if (this.pivots.length === 0) {
        await this.initializeDefaultPivots();
      }

      // Connect to Binance WebSocket for order book
      await binanceClient.connectOrderBook('btcusdt');

      // Listen for order book updates
      binanceClient.on('orderbook', () => {
        this.orderBookCache = binanceClient.getOrderBookMetrics();
      });

      // Fetch initial data
      await this.refreshDerivatives();
      await this.refreshSentiment();

      logger.info({
        btcPrice: this.btcPrice,
        solPrice: this.solPrice,
        pivotsCount: this.pivots.length,
      }, 'Macro Gann Analyzer initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Macro Gann Analyzer');
      throw err;
    }
  }

  /**
   * Start the analyzer (begin periodic updates)
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Macro Gann Analyzer already running');
      return;
    }

    this.isRunning = true;

    // Set up refresh intervals
    this.refreshIntervals.push(
      setInterval(() => this.refreshPrices(), 30000),  // 30 seconds
      setInterval(() => this.refreshDerivatives(), this.config.derivativesRefreshMs),
      setInterval(() => this.refreshSentiment(), this.config.sentimentRefreshMs),
      setInterval(() => this.generateAndEmitSignal(), this.config.gannRecalcMs),
    );

    // Generate initial signal
    this.generateAndEmitSignal();

    logger.info('Macro Gann Analyzer started');
  }

  /**
   * Stop the analyzer
   */
  stop(): void {
    this.isRunning = false;

    // Clear all intervals
    for (const interval of this.refreshIntervals) {
      clearInterval(interval);
    }
    this.refreshIntervals = [];

    // Disconnect WebSocket
    binanceClient.disconnect();

    logger.info('Macro Gann Analyzer stopped');
  }

  /**
   * Initialize default pivots (ATH/ATL)
   */
  private async initializeDefaultPivots(): Promise<void> {
    // Use approximate ATH for BTC (can be updated)
    const btcAth: GannPivot = {
      timestamp: new Date('2024-03-14'),
      asset: 'BTC',
      pivotType: PivotType.HIGH,
      price: 73750,
      timeframe: '1d',
      isMajor: true,
    };

    // Recent significant low
    const btcLow: GannPivot = {
      timestamp: new Date('2024-01-23'),
      asset: 'BTC',
      pivotType: PivotType.LOW,
      price: 38500,
      timeframe: '1d',
      isMajor: true,
    };

    this.pivots = [btcAth, btcLow];
  }

  /**
   * Add a new pivot point
   */
  addPivot(pivot: GannPivot): void {
    this.pivots.push(pivot);
    logger.info({ pivot }, 'New pivot added to Macro Gann Analyzer');
  }

  /**
   * Refresh price data
   */
  private async refreshPrices(): Promise<void> {
    try {
      const [btc, sol] = await Promise.all([
        binanceClient.getBtcPrice(),
        binanceClient.getSolPrice(),
      ]);

      this.btcPrice = btc;
      this.solPrice = sol;
    } catch (err) {
      logger.error({ err }, 'Failed to refresh prices');
    }
  }

  /**
   * Refresh derivatives data
   */
  private async refreshDerivatives(): Promise<void> {
    try {
      // Try Coinalyze first (aggregated data)
      if (coinalyzeClient.isEnabled()) {
        this.derivativesCache = await coinalyzeClient.getDerivativesMetrics('BTC');
      } else {
        // Fallback to Binance only
        const [funding, oi] = await Promise.all([
          binanceClient.getFundingRate('BTCUSDT'),
          binanceClient.getOpenInterest('BTCUSDT'),
        ]);

        this.derivativesCache = {
          fundingRate: funding.fundingRate,
          openInterest: oi.openInterest,
          oiChange24h: 0,  // Not available without Coinalyze
          liquidations24h: { long: 0, short: 0, total: 0 },  // Not available without Coinalyze
        };
      }
    } catch (err) {
      logger.error({ err }, 'Failed to refresh derivatives');
    }
  }

  /**
   * Refresh sentiment data
   */
  private async refreshSentiment(): Promise<void> {
    try {
      const fearGreed = await fearGreedClient.getIndex();

      this.sentimentCache = {
        fearGreedIndex: fearGreed.value,
        fearGreedClassification: fearGreed.classification,
        socialScore: 0,  // Would need LunarCrush for this
        sentimentPolarity: 0,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to refresh sentiment');
    }
  }

  /**
   * Perform Gann analysis
   */
  private performGannAnalysis(): GannAnalysis {
    // Get the most relevant pivot (most recent major pivot)
    const majorPivot = this.pivots.find((p) => p.isMajor) || this.pivots[0];

    if (!majorPivot) {
      // Return default analysis if no pivots
      return {
        currentAngle: {
          currentAngle: 0,
          closestGannAngle: 'ANGLE_1X1' as any,
          trendStrength: 'MODERATE' as any,
          direction: 'UP',
          isAbove1x1: false,
        },
        squareOf9Levels: { support: [], resistance: [], cardinalCross: [] },
        activeCycles: [],
        confluence: null,
        nearestSupport: this.btcPrice * 0.9,
        nearestResistance: this.btcPrice * 1.1,
      };
    }

    // Calculate Gann angle from pivot
    const currentAngle = gannAngles.calculateCurrentAngle(
      majorPivot.price,
      majorPivot.timestamp,
      this.btcPrice,
      new Date(),
      this.config.gannPriceScale
    );

    // Calculate Square of 9 levels
    const squareOf9Levels = gannSquareOfNine.calculateAllLevels(this.btcPrice);

    // Calculate time cycles from all pivots
    let activeCycles: any[] = [];
    for (const pivot of this.pivots.filter((p) => p.isMajor)) {
      const cycles = gannTimeCycles.calculateUpcomingCycles(pivot, '4h', 30);
      activeCycles = [...activeCycles, ...cycles];
    }

    // Sort by soonest first
    activeCycles.sort((a, b) => a.barsRemaining - b.barsRemaining);

    // Detect confluence
    const confluence = gannConfluenceDetector.detectConfluence(
      this.btcPrice,
      squareOf9Levels,
      activeCycles,
      {
        pricePercent: this.config.confluenceTolerancePrice,
        barsWindow: this.config.confluenceToleranceBars,
      }
    );

    // Find nearest support/resistance
    const { nearestSupport, nearestResistance } = gannSquareOfNine.findNearestLevels(
      this.btcPrice,
      squareOf9Levels
    );

    return {
      currentAngle,
      squareOf9Levels,
      activeCycles: activeCycles.slice(0, 10),  // Limit to top 10
      confluence,
      nearestSupport,
      nearestResistance,
    };
  }

  /**
   * Generate and emit a new signal
   */
  private async generateAndEmitSignal(): Promise<void> {
    if (!this.btcPrice || !this.derivativesCache || !this.sentimentCache) {
      logger.debug('Skipping signal generation - missing data');
      return;
    }

    try {
      // Perform Gann analysis
      const gannAnalysis = this.performGannAnalysis();

      // Build whale activity (placeholder - would need whale tracking)
      const whaleActivity: WhaleActivityMetrics = {
        recentLargeTransfers: 0,
        exchangeFlowBias: 'NEUTRAL',
        netFlow24h: 0,
      };

      // Generate signal
      const signal = macroSignalGenerator.generateSignal(
        gannAnalysis,
        this.derivativesCache,
        this.orderBookCache,
        this.sentimentCache,
        whaleActivity,
        this.btcPrice,
        this.solPrice
      );

      this.lastSignal = signal;
      this.lastSignalTime = Date.now();

      // Emit the signal
      this.emit('signal', signal);

      logger.debug({
        bias: signal.bias,
        action: signal.action,
        confidence: signal.confidence,
      }, 'Macro signal generated');
    } catch (err) {
      logger.error({ err }, 'Failed to generate macro signal');
    }
  }

  /**
   * Get the latest signal
   */
  getLatestSignal(): MacroGannSignal | null {
    return this.lastSignal;
  }

  /**
   * Get formatted signal for Telegram
   */
  getFormattedSignal(): string | null {
    if (!this.lastSignal) return null;
    return macroTelegramFormatter.formatSignal(this.lastSignal);
  }

  /**
   * Get formatted levels for Telegram
   */
  getFormattedLevels(): string | null {
    if (!this.lastSignal) return null;
    return macroTelegramFormatter.formatLevels(this.lastSignal);
  }

  /**
   * Get formatted cycles for Telegram
   */
  getFormattedCycles(): string | null {
    if (!this.lastSignal) return null;
    return macroTelegramFormatter.formatCyclesDetail(this.lastSignal);
  }

  /**
   * Get formatted metrics for Telegram
   */
  getFormattedMetrics(): string | null {
    if (!this.lastSignal) return null;
    return macroTelegramFormatter.formatMetricsUpdate(this.lastSignal);
  }

  /**
   * Get current status
   */
  getStatus(): {
    isRunning: boolean;
    btcPrice: number;
    solPrice: number;
    lastSignalTime: number;
    pivotsCount: number;
    hasDerivatives: boolean;
    hasSentiment: boolean;
    hasOrderBook: boolean;
  } {
    return {
      isRunning: this.isRunning,
      btcPrice: this.btcPrice,
      solPrice: this.solPrice,
      lastSignalTime: this.lastSignalTime,
      pivotsCount: this.pivots.length,
      hasDerivatives: !!this.derivativesCache,
      hasSentiment: !!this.sentimentCache,
      hasOrderBook: !!this.orderBookCache,
    };
  }

  /**
   * Force refresh all data and generate new signal
   */
  async forceRefresh(): Promise<MacroGannSignal | null> {
    await Promise.all([
      this.refreshPrices(),
      this.refreshDerivatives(),
      this.refreshSentiment(),
    ]);

    await this.generateAndEmitSignal();
    return this.lastSignal;
  }
}

// Export singleton instance
export const macroGannAnalyzer = new MacroGannAnalyzer();
