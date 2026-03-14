import axios, { type AxiosInstance } from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { RateLimiter } from '../../utils/rate-limiter.js';

export class NansenClient {
  private api: AxiosInstance;
  private rateLimiter: RateLimiter;

  constructor() {
    this.api = axios.create({
      baseURL: config.nansen.baseUrl,
      timeout: 30_000,
      headers: {
        'Authorization': `Bearer ${config.nansen.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    this.rateLimiter = new RateLimiter('nansen', config.nansen.maxCallsPerMin);
  }

  get usage() {
    return this.rateLimiter.getUsage();
  }

  /** Token discovery screener — find trending Solana memecoins */
  async tokenDiscoveryScreener(params: {
    mcapMin?: number;
    mcapMax?: number;
    liquidityMin?: number;
    limit?: number;
  }): Promise<unknown[]> {
    return this.rateLimiter.execute('token_discovery_screener', async () => {
      const resp = await this.api.get('/token/discovery-screener', {
        params: {
          chains: 'solana',
          sectors: 'Memecoins',
          mcapMin: params.mcapMin,
          mcapMax: params.mcapMax,
          liquidityMin: params.liquidityMin,
          sortBy: 'netflow',
          sortOrder: 'desc',
          limit: params.limit || 10,
        },
      });
      return resp.data?.data || resp.data || [];
    }) as Promise<unknown[]>;
  }

  /** PnL leaderboard for a specific token */
  async tokenPnlLeaderboard(tokenAddress: string, params?: {
    pnlUsdMin?: number;
    roiMin?: number;
    tradesMin?: number;
    tradesMax?: number;
    holdingRatioMax?: number;
    limit?: number;
  }): Promise<unknown[]> {
    return this.rateLimiter.execute('token_pnl_leaderboard', async () => {
      const resp = await this.api.get(`/token/${tokenAddress}/pnl-leaderboard`, {
        params: {
          chain: 'solana',
          pnlUsdTotalMin: params?.pnlUsdMin || 1000,
          roiPercentTotalMin: params?.roiMin || 100,
          nofTradesMin: params?.tradesMin || 10,
          nofTradesMax: params?.tradesMax || 100,
          holdingRatioMax: params?.holdingRatioMax || 0.3,
          limit: params?.limit || 25,
        },
      });
      return resp.data?.data || resp.data || [];
    }) as Promise<unknown[]>;
  }

  /** Smart traders and funds token balances */
  async smartTradersBalances(): Promise<unknown[]> {
    return this.rateLimiter.execute('smart_traders_balances', async () => {
      const resp = await this.api.get('/smart-traders-and-funds/token-balances', {
        params: { chain: 'solana' },
      });
      return resp.data?.data || resp.data || [];
    }) as Promise<unknown[]>;
  }

  /** Token DEX trades — event-triggered validation */
  async tokenDexTrades(tokenAddress: string): Promise<unknown[]> {
    return this.rateLimiter.execute('token_dex_trades', async () => {
      const resp = await this.api.get(`/token/${tokenAddress}/dex-trades`, {
        params: { chain: 'solana', limit: 50 },
      });
      return resp.data?.data || resp.data || [];
    }) as Promise<unknown[]>;
  }

  /** Token OHLCV */
  async tokenOhlcv(tokenAddress: string, interval = '1h'): Promise<unknown[]> {
    return this.rateLimiter.execute('token_ohlcv', async () => {
      const resp = await this.api.get(`/token/${tokenAddress}/ohlcv`, {
        params: { chain: 'solana', interval },
      });
      return resp.data?.data || resp.data || [];
    }) as Promise<unknown[]>;
  }

  /** Token flows */
  async tokenFlows(tokenAddress: string): Promise<unknown> {
    return this.rateLimiter.execute('token_flows', async () => {
      const resp = await this.api.get(`/token/${tokenAddress}/flows`, {
        params: { chain: 'solana' },
      });
      return resp.data?.data || resp.data || {};
    });
  }

  /** Token recent flows summary */
  async tokenRecentFlowsSummary(tokenAddress: string): Promise<unknown> {
    return this.rateLimiter.execute('token_recent_flows_summary', async () => {
      const resp = await this.api.get(`/token/${tokenAddress}/recent-flows-summary`, {
        params: { chain: 'solana' },
      });
      return resp.data?.data || resp.data || {};
    });
  }

  /** Token who bought/sold */
  async tokenWhoBoughtSold(tokenAddress: string): Promise<unknown[]> {
    return this.rateLimiter.execute('token_who_bought_sold', async () => {
      const resp = await this.api.get(`/token/${tokenAddress}/who-bought-sold`, {
        params: { chain: 'solana' },
      });
      return resp.data?.data || resp.data || [];
    }) as Promise<unknown[]>;
  }
}
