// ===========================================
// COINALYZE FREE API CLIENT
// ===========================================
// Free API for aggregated OI, funding rates, and liquidations
// Requires free API key from coinalyze.net (40 requests/minute)

import { logger } from '../../../utils/logger.js';
import {
  CoinalyzeOI,
  CoinalyzeFunding,
  CoinalyzeLiquidation,
  DerivativesMetrics,
} from '../types.js';

/**
 * Simple rate limiter
 */
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private maxTokens: number;
  private refillRate: number;

  constructor(maxTokens: number = 40, refillIntervalMs: number = 60000) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.refillRate = maxTokens / refillIntervalMs;
  }

  async acquire(): Promise<void> {
    // Refill tokens based on time passed
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;

    if (this.tokens < 1) {
      // Wait until we have a token
      const waitTime = (1 - this.tokens) / this.refillRate;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.tokens = 0;
    } else {
      this.tokens -= 1;
    }
  }
}

/**
 * Coinalyze Free API Client
 *
 * Provides aggregated derivatives data across multiple exchanges.
 * Free tier: 40 requests/minute with API key
 *
 * Sign up at: https://coinalyze.net/
 */
export class CoinalyzeClient {
  private apiKey: string | null;
  private baseUrl = 'https://api.coinalyze.net/v1';
  private rateLimiter: RateLimiter;
  private enabled: boolean;

  // Symbol mappings for Coinalyze
  // Format: BTCUSD_PERP.A = Aggregated Bitcoin Perpetual
  private readonly SYMBOLS = {
    BTC: 'BTCUSD_PERP.A',
    ETH: 'ETHUSD_PERP.A',
    SOL: 'SOLUSD_PERP.A',
  };

  constructor(apiKey?: string) {
    this.apiKey = apiKey || null;
    this.rateLimiter = new RateLimiter(40, 60000);  // 40/min
    this.enabled = !!apiKey;

    if (!this.enabled) {
      logger.warn('Coinalyze API key not configured - using Binance fallback only');
    }
  }

  /**
   * Set API key (can be set after initialization)
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.enabled = true;
    logger.info('Coinalyze API key configured');
  }

  /**
   * Check if client is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Make authenticated request
   */
  private async request<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    if (!this.enabled || !this.apiKey) {
      throw new Error('Coinalyze API key not configured');
    }

    await this.rateLimiter.acquire();

    const queryParams = new URLSearchParams({
      ...params,
      api_key: this.apiKey,
    });

    const url = `${this.baseUrl}${endpoint}?${queryParams.toString()}`;

    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Coinalyze API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get current open interest (aggregated)
   */
  async getOpenInterest(asset: 'BTC' | 'ETH' | 'SOL' = 'BTC'): Promise<CoinalyzeOI> {
    const symbol = this.SYMBOLS[asset];

    const data = await this.request<any[]>('/open-interest', {
      symbols: symbol,
    });

    if (!data || data.length === 0) {
      throw new Error('No open interest data returned');
    }

    const item = data[0];
    return {
      symbol: asset,
      openInterest: item.openInterest,
      openInterestUsd: item.openInterestUsd,
      timestamp: item.timestamp,
    };
  }

  /**
   * Get current funding rate (aggregated)
   */
  async getFundingRate(asset: 'BTC' | 'ETH' | 'SOL' = 'BTC'): Promise<CoinalyzeFunding> {
    const symbol = this.SYMBOLS[asset];

    const data = await this.request<any[]>('/funding-rate', {
      symbols: symbol,
    });

    if (!data || data.length === 0) {
      throw new Error('No funding rate data returned');
    }

    const item = data[0];
    return {
      symbol: asset,
      fundingRate: item.fundingRate,
      timestamp: item.timestamp,
    };
  }

  /**
   * Get predicted funding rate
   */
  async getPredictedFunding(asset: 'BTC' | 'ETH' | 'SOL' = 'BTC'): Promise<number> {
    const symbol = this.SYMBOLS[asset];

    const data = await this.request<any[]>('/predicted-funding-rate', {
      symbols: symbol,
    });

    if (!data || data.length === 0) {
      throw new Error('No predicted funding data returned');
    }

    return data[0].predictedFundingRate;
  }

  /**
   * Get liquidation history (24h)
   */
  async getLiquidations(asset: 'BTC' | 'ETH' | 'SOL' = 'BTC'): Promise<CoinalyzeLiquidation> {
    const symbol = this.SYMBOLS[asset];
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

    const data = await this.request<any[]>('/liquidation-history', {
      symbols: symbol,
      from: Math.floor(oneDayAgo / 1000).toString(),
    });

    // Aggregate liquidations
    let longLiquidations = 0;
    let shortLiquidations = 0;

    for (const item of data || []) {
      longLiquidations += item.longLiquidationsUsd || 0;
      shortLiquidations += item.shortLiquidationsUsd || 0;
    }

    return {
      symbol: asset,
      longLiquidations,
      shortLiquidations,
      timestamp: Date.now(),
    };
  }

  /**
   * Get open interest history for trend analysis
   */
  async getOpenInterestHistory(
    asset: 'BTC' | 'ETH' | 'SOL' = 'BTC',
    hours: number = 24
  ): Promise<Array<{ timestamp: number; value: number }>> {
    const symbol = this.SYMBOLS[asset];
    const fromTime = Date.now() - hours * 60 * 60 * 1000;

    const data = await this.request<any[]>('/open-interest-history', {
      symbols: symbol,
      interval: '1h',
      from: Math.floor(fromTime / 1000).toString(),
    });

    return (data || []).map((item) => ({
      timestamp: item.timestamp,
      value: item.openInterestUsd,
    }));
  }

  /**
   * Calculate OI change percentage
   */
  async getOIChange24h(asset: 'BTC' | 'ETH' | 'SOL' = 'BTC'): Promise<number> {
    const history = await this.getOpenInterestHistory(asset, 24);

    if (history.length < 2) {
      return 0;
    }

    const oldest = history[0].value;
    const newest = history[history.length - 1].value;

    if (oldest === 0) return 0;

    return ((newest - oldest) / oldest) * 100;
  }

  /**
   * Get aggregated derivatives metrics
   */
  async getDerivativesMetrics(asset: 'BTC' | 'ETH' | 'SOL' = 'BTC'): Promise<DerivativesMetrics> {
    try {
      const [funding, oi, oiChange, liquidations] = await Promise.all([
        this.getFundingRate(asset),
        this.getOpenInterest(asset),
        this.getOIChange24h(asset),
        this.getLiquidations(asset),
      ]);

      return {
        fundingRate: funding.fundingRate,
        openInterest: oi.openInterestUsd,
        oiChange24h: oiChange,
        liquidations24h: {
          long: liquidations.longLiquidations,
          short: liquidations.shortLiquidations,
          total: liquidations.longLiquidations + liquidations.shortLiquidations,
        },
      };
    } catch (err) {
      logger.error({ err, asset }, 'Failed to get Coinalyze derivatives metrics');
      throw err;
    }
  }
}

// Export factory function (needs API key at runtime)
export function createCoinalyzeClient(apiKey?: string): CoinalyzeClient {
  return new CoinalyzeClient(apiKey);
}

// Default instance (may be disabled without API key)
export const coinalyzeClient = new CoinalyzeClient(process.env.COINALYZE_API_KEY);
