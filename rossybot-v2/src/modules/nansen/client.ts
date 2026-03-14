import axios, { type AxiosInstance } from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { RateLimiter } from '../../utils/rate-limiter.js';

export class NansenClient {
  private api: AxiosInstance;
  private rateLimiter: RateLimiter;

  constructor() {
    this.api = axios.create({
      baseURL: 'https://api.nansen.ai/api/v1',
      timeout: 30_000,
      headers: {
        'apiKey': config.nansen.apiKey,
        'Content-Type': 'application/json',
      },
    });
    this.rateLimiter = new RateLimiter('nansen', config.nansen.maxCallsPerMin);
  }

  get usage() {
    return this.rateLimiter.getUsage();
  }

  /** Token screener — find trending Solana memecoins */
  async tokenScreener(params: {
    mcapMin?: number;
    mcapMax?: number;
    liquidityMin?: number;
    limit?: number;
  }): Promise<unknown[]> {
    return this.rateLimiter.execute('token-screener', async () => {
      const resp = await this.api.post('/token-screener', {
        chains: ['solana'],
        timeframe: '24h',
        pagination: {
          page: 1,
          per_page: params.limit || 10,
        },
        filters: {
          market_cap_usd: { min: params.mcapMin, max: params.mcapMax },
          liquidity_usd: { min: params.liquidityMin },
        },
        order_by: [{ field: 'buy_volume', direction: 'DESC' }],
      });
      return resp.data?.data || [];
    }) as Promise<unknown[]>;
  }

  /** PnL leaderboard for a specific token */
  async tokenPnlLeaderboard(chain: string, tokenAddress: string, params?: {
    pnlUsdMin?: number;
    tradesMin?: number;
    tradesMax?: number;
    limit?: number;
  }): Promise<unknown[]> {
    return this.rateLimiter.execute('tgm/pnl-leaderboard', async () => {
      const resp = await this.api.post('/tgm/pnl-leaderboard', {
        chain,
        token_address: tokenAddress,
        pagination: {
          page: 1,
          per_page: params?.limit || 25,
        },
        filters: {
          pnl_usd_realised: params?.pnlUsdMin ? { min: params.pnlUsdMin } : undefined,
          nof_trades: {
            min: params?.tradesMin || 10,
            max: params?.tradesMax || 100,
          },
        },
        order_by: [{ field: 'pnl_usd_realised', direction: 'DESC' }],
      });
      return resp.data?.data || [];
    }) as Promise<unknown[]>;
  }

  /** Flow intelligence for a token */
  async tokenFlowIntelligence(chain: string, tokenAddress: string, timeframe = '1d'): Promise<unknown> {
    return this.rateLimiter.execute('tgm/flow-intelligence', async () => {
      const resp = await this.api.post('/tgm/flow-intelligence', {
        chain,
        token_address: tokenAddress,
        timeframe,
      });
      return resp.data?.data || {};
    });
  }

  /** Smart money netflow */
  async smartMoneyNetflow(chain: string): Promise<unknown[]> {
    return this.rateLimiter.execute('smart-money/netflow', async () => {
      const resp = await this.api.post('/smart-money/netflow', {
        chains: [chain],
        timeframe: '24h',
        pagination: { page: 1, per_page: 20 },
      });
      return resp.data?.data || [];
    }) as Promise<unknown[]>;
  }
}
