// ===========================================
// GMGN.AI CLIENT
// Fetches trending Solana tokens from GMGN's ranking API
// Uses undocumented quotation endpoint (no API key needed)
// ===========================================

import { logger } from '../utils/logger.js';

const GMGN_BASE_URL = 'https://gmgn.ai';
const GMGN_RANK_PATH = '/defi/quotation/v1/rank/sol/swaps';

// Cache to avoid hammering GMGN on every scan cycle
let cachedTokens: string[] = [];
let lastFetchTime = 0;
const CACHE_TTL_MS = 60_000; // 1 minute cache

interface GmgnTokenData {
  address?: string;
  token_address?: string;
  contract_address?: string;
  symbol?: string;
  market_cap?: number;
  volume?: number;
  holder_count?: number;
  smart_buy_24h?: number;
  smart_sell_24h?: number;
  open_timestamp?: number;
}

interface GmgnRankResponse {
  code: number;
  msg: string;
  data?: {
    rank?: GmgnTokenData[];
  };
}

/**
 * Fetch trending Solana tokens from GMGN ranked by smart money activity.
 * Falls back to volume ranking if smart money sort fails.
 */
async function fetchGmgnTrending(limit: number = 50): Promise<string[]> {
  // Return cached if fresh
  const now = Date.now();
  if (now - lastFetchTime < CACHE_TTL_MS && cachedTokens.length > 0) {
    return cachedTokens;
  }

  const addresses: Set<string> = new Set();

  // Fetch from two timeframes for breadth
  const timeframes = ['1h', '5m'];

  for (const tf of timeframes) {
    try {
      const url = `${GMGN_BASE_URL}${GMGN_RANK_PATH}/${tf}?orderby=swaps&direction=desc&limit=${limit}&filters[]=not_honeypot`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://gmgn.ai/',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        logger.debug({ status: response.status, tf }, 'GMGN ranking API returned non-OK status');
        continue;
      }

      const data = (await response.json()) as GmgnRankResponse;

      if (data.code !== 0 || !data.data?.rank) {
        logger.debug({ code: data.code, msg: data.msg, tf }, 'GMGN ranking API returned error');
        continue;
      }

      for (const token of data.data.rank) {
        const addr = token.address || token.token_address || token.contract_address;
        if (addr && addr.length >= 32) {
          addresses.add(addr);
        }
      }

      logger.debug({ count: data.data.rank.length, tf }, 'GMGN tokens fetched');
    } catch (error) {
      logger.debug({ error, tf }, 'GMGN fetch failed');
    }
  }

  if (addresses.size > 0) {
    cachedTokens = Array.from(addresses);
    lastFetchTime = now;
  }

  return Array.from(addresses);
}

export const gmgnClient = {
  getTrendingSolanaTokens: fetchGmgnTrending,
};
