import axios, { type AxiosInstance } from 'axios';
import { config } from '../../config/index.js';
import { RateLimiter } from '../../utils/rate-limiter.js';

// ============================================================
// Nansen API v1 Client
// Docs: https://docs.nansen.ai/nansen-api-reference
// Auth: apiKey header (NOT Bearer token)
// Base URL: https://api.nansen.ai/api/v1
// All endpoints are POST
// ============================================================

// --- Response types ---

export interface TokenScreenerItem {
  chain: string;
  token_address: string;
  token_symbol: string;
  token_age_days: number;
  market_cap_usd: number;
  liquidity: number;
  price_usd: number;
  price_change: number;
  fdv: number;
  nof_traders: number;
  buy_volume: number;
  sell_volume: number;
  volume: number;
  netflow: number;
}

export interface PnlLeaderboardItem {
  trader_address: string;
  trader_address_label: string | null;
  price_usd: number;
  pnl_usd_realised: number;
  pnl_usd_unrealised: number;
  pnl_usd_total: number;
  holding_amount: number;
  holding_usd: number;
  max_balance_held: number;
  max_balance_held_usd: number;
  still_holding_balance_ratio: number;
  netflow_amount_usd: number;
  roi_percent_total: number;
  roi_percent_realised: number;
  nof_trades: number;
}

export interface FlowIntelligenceItem {
  smart_trader_net_flow_usd: number;
  smart_trader_wallet_count: number;
  whale_net_flow_usd: number;
  whale_wallet_count: number;
  top_pnl_net_flow_usd: number;
  top_pnl_wallet_count: number;
  fresh_wallets_net_flow_usd: number;
  fresh_wallets_wallet_count: number;
}

export interface SmartMoneyNetflowItem {
  token_address: string;
  token_symbol: string;
  net_flow_1h_usd: number;
  net_flow_24h_usd: number;
  net_flow_7d_usd: number;
  net_flow_30d_usd: number;
  chain: string;
  trader_count: number;
  market_cap_usd: number;
}

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

  /**
   * POST /token-screener
   * Find trending tokens with filters for mcap, liquidity, volume, traders.
   * 5 credits per call.
   */
  async tokenScreener(params: {
    mcapMin?: number;
    mcapMax?: number;
    liquidityMin?: number;
    minTraders?: number;
    limit?: number;
  }): Promise<TokenScreenerItem[]> {
    return this.rateLimiter.execute('token-screener', async () => {
      const body: Record<string, unknown> = {
        chains: ['solana'],
        timeframe: '24h',
        pagination: {
          page: 1,
          per_page: params.limit || 10,
        },
        order_by: [{ field: 'netflow', direction: 'DESC' }],
      };

      // Build filters — only include fields that have values
      const filters: Record<string, unknown> = {};
      if (params.mcapMin !== undefined || params.mcapMax !== undefined) {
        filters.market_cap_usd = {};
        if (params.mcapMin !== undefined) (filters.market_cap_usd as Record<string, number>).min = params.mcapMin;
        if (params.mcapMax !== undefined) (filters.market_cap_usd as Record<string, number>).max = params.mcapMax;
      }
      if (params.liquidityMin !== undefined) {
        filters.liquidity = { min: params.liquidityMin };
      }
      if (params.minTraders !== undefined) {
        filters.nof_traders = { min: params.minTraders };
      }
      if (Object.keys(filters).length > 0) {
        body.filters = filters;
      }

      const resp = await this.api.post('/token-screener', body);
      return (resp.data?.data || []) as TokenScreenerItem[];
    }) as Promise<TokenScreenerItem[]>;
  }

  /**
   * POST /tgm/pnl-leaderboard
   * Rank traders by PnL for a specific token.
   * Requires chain + token_address.
   */
  async tokenPnlLeaderboard(
    tokenAddress: string,
    params?: {
      pnlUsdMin?: number;
      tradesMin?: number;
      tradesMax?: number;
      holdingRatioMax?: number;
      limit?: number;
    },
  ): Promise<PnlLeaderboardItem[]> {
    return this.rateLimiter.execute('tgm/pnl-leaderboard', async () => {
      const body: Record<string, unknown> = {
        chain: 'solana',
        token_address: tokenAddress,
        pagination: {
          page: 1,
          per_page: params?.limit || 25,
        },
        order_by: [{ field: 'pnl_usd_total', direction: 'DESC' }],
      };

      const filters: Record<string, unknown> = {};
      if (params?.pnlUsdMin !== undefined) {
        filters.pnl_usd_realised = { min: params.pnlUsdMin };
      }
      if (params?.tradesMin !== undefined || params?.tradesMax !== undefined) {
        filters.nof_trades = {};
        if (params?.tradesMin !== undefined) (filters.nof_trades as Record<string, number>).min = params.tradesMin;
        if (params?.tradesMax !== undefined) (filters.nof_trades as Record<string, number>).max = params.tradesMax;
      }
      if (params?.holdingRatioMax !== undefined) {
        filters.still_holding_balance_ratio = { max: params.holdingRatioMax };
      }
      if (Object.keys(filters).length > 0) {
        body.filters = filters;
      }

      const resp = await this.api.post('/tgm/pnl-leaderboard', body);
      return (resp.data?.data || []) as PnlLeaderboardItem[];
    }) as Promise<PnlLeaderboardItem[]>;
  }

  /**
   * POST /tgm/flow-intelligence
   * Get smart money flow data for a specific token.
   * Valid timeframes: 5m, 1h, 6h, 12h, 1d, 7d
   */
  async tokenFlowIntelligence(
    tokenAddress: string,
    timeframe: '5m' | '1h' | '6h' | '12h' | '1d' | '7d' = '1d',
  ): Promise<FlowIntelligenceItem | null> {
    return this.rateLimiter.execute('tgm/flow-intelligence', async () => {
      const resp = await this.api.post('/tgm/flow-intelligence', {
        chain: 'solana',
        token_address: tokenAddress,
        timeframe,
      });
      const data = resp.data?.data;
      return Array.isArray(data) ? data[0] || null : data || null;
    }) as Promise<FlowIntelligenceItem | null>;
  }

  /**
   * POST /smart-money/netflow
   * Track net capital flows from smart traders across tokens.
   */
  async smartMoneyNetflow(params?: {
    mcapMin?: number;
    minTraders?: number;
    limit?: number;
  }): Promise<SmartMoneyNetflowItem[]> {
    return this.rateLimiter.execute('smart-money/netflow', async () => {
      const body: Record<string, unknown> = {
        chains: ['solana'],
        pagination: {
          page: 1,
          per_page: params?.limit || 20,
        },
        order_by: [{ field: 'net_flow_24h_usd', direction: 'DESC' }],
        filters: {
          include_stablecoins: false,
          include_native_tokens: false,
        },
      };

      if (params?.mcapMin) {
        (body.filters as Record<string, unknown>).market_cap_usd = { min: params.mcapMin };
      }
      if (params?.minTraders) {
        (body.filters as Record<string, unknown>).trader_count = { min: params.minTraders };
      }

      const resp = await this.api.post('/smart-money/netflow', body);
      return (resp.data?.data || []) as SmartMoneyNetflowItem[];
    }) as Promise<SmartMoneyNetflowItem[]>;
  }
}
