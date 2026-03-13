// ===========================================
// MODULE: MARKET REGIME DETECTOR
// Detects bull/bear regimes using SOL price + memecoin volume
// Phase 4.1 — adapts thresholds to market conditions
// ===========================================

import { logger } from '../utils/logger.js';

// ============ TYPES ============

export type MarketRegime =
  | 'BULL_HIGH_ACTIVITY'
  | 'BULL_LOW_ACTIVITY'
  | 'BEAR_HIGH_ACTIVITY'
  | 'BEAR_LOW_ACTIVITY'
  | 'NEUTRAL';

export interface RegimeAdjustments {
  thresholdMultiplier: number;    // 0.85 = loosen 15%, 1.15 = tighten 15%
  stopWidthMultiplier: number;    // 1.05 = wider stops, 0.95 = tighter
  minScoreOverride: number | null; // null = use default, 65 = override
  description: string;
}

export interface RegimeSnapshot {
  regime: MarketRegime;
  adjustments: RegimeAdjustments;
  solPriceChange24h: number;
  volumeVs7dAvg: number;
  detectedAt: Date;
}

// ============ REGIME ADJUSTMENTS ============

const REGIME_MAP: Record<MarketRegime, RegimeAdjustments> = {
  BULL_HIGH_ACTIVITY: {
    thresholdMultiplier: 0.90,   // Loosen 10%
    stopWidthMultiplier: 1.05,   // Wider stops 5%
    minScoreOverride: null,
    description: 'Bull market + high activity — more signals, wider stops',
  },
  BULL_LOW_ACTIVITY: {
    thresholdMultiplier: 1.0,    // Default
    stopWidthMultiplier: 1.0,
    minScoreOverride: null,
    description: 'Selective bull — default thresholds',
  },
  BEAR_HIGH_ACTIVITY: {
    thresholdMultiplier: 1.10,   // Tighten 10%
    stopWidthMultiplier: 0.95,   // Tighter stops
    minScoreOverride: null,
    description: 'Bear + high activity (liquidation cascades) — tighter thresholds',
  },
  BEAR_LOW_ACTIVITY: {
    thresholdMultiplier: 1.15,   // Tighten 15%
    stopWidthMultiplier: 0.95,   // Tighter stops
    minScoreOverride: 65,
    description: 'Bear market + low activity — strictest thresholds, min score 65',
  },
  NEUTRAL: {
    thresholdMultiplier: 1.0,
    stopWidthMultiplier: 1.0,
    minScoreOverride: null,
    description: 'Neutral market — default thresholds',
  },
};

// ============ CONFIGURATION ============

const CONFIG = {
  // SOL price thresholds
  BULL_SOL_CHANGE_24H: 3,     // SOL up 3%+ in 24h = bull
  BEAR_SOL_CHANGE_24H: -3,    // SOL down 3%+ in 24h = bear

  // Volume thresholds (vs 7-day average)
  HIGH_ACTIVITY_RATIO: 1.3,   // 30% above 7d average
  LOW_ACTIVITY_RATIO: 0.7,    // 30% below 7d average

  // Check interval
  CHECK_INTERVAL_MS: 60 * 60 * 1000, // 1 hour

  // DexScreener SOL pair for price data
  SOL_USDC_PAIR: 'So11111111111111111111111111111111111111112',
} as const;

// ============ REGIME DETECTOR CLASS ============

export class RegimeDetector {
  private currentRegime: MarketRegime = 'NEUTRAL';
  private lastCheck = 0;
  private checkTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  // Rolling volume data for 7-day average
  private dailyVolumes: number[] = [];
  private readonly MAX_DAILY_VOLUMES = 7;

  // SOL price tracking
  private solPriceChange24h = 0;
  private totalMemeVolume24h = 0;

  // ============ LIFECYCLE ============

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Check immediately
    this.checkRegime();

    // Schedule hourly checks
    this.checkTimer = setInterval(() => this.checkRegime(), CONFIG.CHECK_INTERVAL_MS);

    logger.info('Regime detector started');
  }

  stop(): void {
    this.isRunning = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    logger.info('Regime detector stopped');
  }

  // ============ REGIME DETECTION ============

  /**
   * Check market conditions and update regime.
   */
  async checkRegime(): Promise<void> {
    try {
      // Fetch SOL price data from DexScreener
      const solData = await this.fetchSolData();
      if (solData) {
        this.solPriceChange24h = solData.priceChange24h;
        this.totalMemeVolume24h = solData.totalMemeVolume;
      }

      // Determine regime
      const isBull = this.solPriceChange24h > CONFIG.BULL_SOL_CHANGE_24H;
      const isBear = this.solPriceChange24h < CONFIG.BEAR_SOL_CHANGE_24H;

      // Calculate volume ratio vs 7-day average
      const avgVolume = this.dailyVolumes.length > 0
        ? this.dailyVolumes.reduce((a, b) => a + b, 0) / this.dailyVolumes.length
        : this.totalMemeVolume24h; // Use current as baseline if no history

      const volumeRatio = avgVolume > 0 ? this.totalMemeVolume24h / avgVolume : 1;
      const isHighActivity = volumeRatio > CONFIG.HIGH_ACTIVITY_RATIO;
      const isLowActivity = volumeRatio < CONFIG.LOW_ACTIVITY_RATIO;

      let newRegime: MarketRegime = 'NEUTRAL';

      if (isBull && isHighActivity) {
        newRegime = 'BULL_HIGH_ACTIVITY';
      } else if (isBull && isLowActivity) {
        newRegime = 'BULL_LOW_ACTIVITY';
      } else if (isBear && isHighActivity) {
        newRegime = 'BEAR_HIGH_ACTIVITY';
      } else if (isBear && isLowActivity) {
        newRegime = 'BEAR_LOW_ACTIVITY';
      }

      if (newRegime !== this.currentRegime) {
        const previousRegime = this.currentRegime;
        this.currentRegime = newRegime;

        logger.info({
          previousRegime,
          newRegime,
          solChange24h: this.solPriceChange24h,
          volumeRatio,
        }, 'Market regime changed');
      }

      this.lastCheck = Date.now();
    } catch (error) {
      logger.debug({ error }, 'Regime check failed');
    }
  }

  /**
   * Update daily volume snapshot (called from daily optimizer).
   */
  recordDailyVolume(volume: number): void {
    this.dailyVolumes.push(volume);
    if (this.dailyVolumes.length > this.MAX_DAILY_VOLUMES) {
      this.dailyVolumes.shift();
    }
  }

  // ============ PUBLIC API ============

  /**
   * Get current regime and adjustments.
   */
  getCurrentRegime(): RegimeSnapshot {
    return {
      regime: this.currentRegime,
      adjustments: REGIME_MAP[this.currentRegime],
      solPriceChange24h: this.solPriceChange24h,
      volumeVs7dAvg: this.dailyVolumes.length > 0
        ? this.totalMemeVolume24h / (this.dailyVolumes.reduce((a, b) => a + b, 0) / this.dailyVolumes.length)
        : 1,
      detectedAt: new Date(),
    };
  }

  /**
   * Get regime adjustments for the current regime.
   * Use these to modify thresholds in the signal pipeline.
   */
  getAdjustments(): RegimeAdjustments {
    return REGIME_MAP[this.currentRegime];
  }

  /**
   * Get regime string for signal metadata.
   */
  getRegimeLabel(): string {
    return this.currentRegime;
  }

  // ============ DATA FETCHING ============

  private async fetchSolData(): Promise<{
    priceChange24h: number;
    totalMemeVolume: number;
  } | null> {
    try {
      // Fetch SOL/USDC price data
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${CONFIG.SOL_USDC_PAIR}`,
        { signal: AbortSignal.timeout(10000) }
      );

      if (!response.ok) return null;

      const data = await response.json() as any;
      const pairs = data.pairs || [];
      if (pairs.length === 0) return null;

      // Get SOL price change from the main pair
      const mainPair = pairs[0];
      const priceChange24h = mainPair.priceChange?.h24 || 0;

      // Estimate total memecoin volume from other Solana pairs
      const totalMemeVolume = pairs
        .filter((p: any) => p.chainId === 'solana')
        .reduce((sum: number, p: any) => sum + (p.volume?.h24 || 0), 0);

      return { priceChange24h, totalMemeVolume };
    } catch (error) {
      logger.debug({ error }, 'Failed to fetch SOL data for regime detection');
      return null;
    }
  }

  /**
   * Format regime status for Telegram report.
   */
  formatReport(): string {
    const snapshot = this.getCurrentRegime();
    const adj = snapshot.adjustments;

    const regimeEmoji = this.currentRegime.includes('BULL') ? '🟢' :
                        this.currentRegime.includes('BEAR') ? '🔴' : '⚪';

    const lines = [
      `${regimeEmoji} *MARKET REGIME: ${this.currentRegime}*`,
      `SOL 24h: ${this.solPriceChange24h >= 0 ? '+' : ''}${this.solPriceChange24h.toFixed(1)}%`,
      `Volume vs 7d avg: ${(snapshot.volumeVs7dAvg * 100).toFixed(0)}%`,
      `Thresholds: ${adj.thresholdMultiplier < 1 ? 'loosened' : adj.thresholdMultiplier > 1 ? 'tightened' : 'normal'} (${((adj.thresholdMultiplier - 1) * 100).toFixed(0)}%)`,
      adj.minScoreOverride ? `Min score override: ${adj.minScoreOverride}` : '',
    ].filter(Boolean);

    return lines.join('\n');
  }
}

// ============ EXPORTS ============

export const regimeDetector = new RegimeDetector();

export default {
  RegimeDetector,
  regimeDetector,
};
