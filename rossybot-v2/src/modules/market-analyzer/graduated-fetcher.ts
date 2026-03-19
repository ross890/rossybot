import axios from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const DEXSCREENER_BASE = config.dexScreener.baseUrl;

export interface GraduatedToken {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  pairCreatedAt: number; // unix ms — proxy for graduation time
  mcapUsd: number;
  liquidityUsd: number;
  volume24h: number;
  priceUsd: number;
  txns24hBuys: number;
  txns24hSells: number;
  buySellRatio: number;
  priceChangeH1: number;
  priceChangeH6: number;
  priceChangeH24: number;
}

/**
 * Rate-limited request helper. DexScreener allows ~30 req/min on free tier.
 */
async function rateLimitedGet<T>(url: string, delayMs = 2200): Promise<T | null> {
  await new Promise((r) => setTimeout(r, delayMs));
  try {
    const resp = await axios.get<T>(url, { timeout: 15_000 });
    return resp.data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ url: url.slice(0, 80), err: msg }, 'DexScreener request failed');
    return null;
  }
}

/**
 * Fetch graduated pump.fun tokens from the last 24 hours.
 *
 * Strategy: Use DexScreener's token-profiles/latest endpoint to find new pumpswap pairs,
 * combined with the search API to find recently created pumpswap/raydium pairs.
 *
 * DexScreener doesn't have a direct "graduated pump.fun" endpoint, so we:
 * 1. Search for pumpswap pairs sorted by creation time
 * 2. Filter to pairs created in the last 24h
 * 3. Deduplicate by base token mint
 */
export async function fetchGraduatedTokens24h(): Promise<GraduatedToken[]> {
  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  const graduated: Map<string, GraduatedToken> = new Map();

  logger.info('Fetching graduated tokens from last 24h...');

  // Strategy 1: DexScreener search for pumpswap pairs
  // The /pairs endpoint with chainId lets us get pairs from specific DEXes
  // We'll paginate through recent pumpswap pairs
  await fetchPumpswapPairs(graduated, cutoff24h);

  // Strategy 2: Also check for raydium migrations (legacy path)
  await fetchRaydiumMigrations(graduated, cutoff24h);

  const tokens = Array.from(graduated.values());
  logger.info({ count: tokens.length }, 'Graduated tokens fetched');
  return tokens;
}

/**
 * Fetch recent pumpswap pairs from DexScreener.
 * PumpSwap is pump.fun's own AMM — tokens migrate here after bonding curve completion.
 */
async function fetchPumpswapPairs(
  graduated: Map<string, GraduatedToken>,
  cutoff24h: number,
): Promise<void> {
  // DexScreener search endpoint: search by "pumpswap" returns recent pumpswap pairs
  // We paginate by searching with different terms that cover graduated tokens
  const searchTerms = ['pumpswap'];

  for (const term of searchTerms) {
    const url = `https://api.dexscreener.com/latest/dex/search?q=${term}`;
    const data = await rateLimitedGet<{ pairs: DexPairRaw[] }>(url);
    if (!data?.pairs) continue;

    for (const pair of data.pairs) {
      if (pair.chainId !== 'solana') continue;
      if (pair.dexId !== 'pumpswap' && pair.dexId !== 'pump_swap') continue;
      if (!pair.pairCreatedAt || pair.pairCreatedAt < cutoff24h) continue;

      addPairToMap(graduated, pair);
    }
  }

  // DexScreener /dex/pairs/solana/pumpswap — get pairs directly by dex
  // This may not exist as a public endpoint, but try it
  const dexUrl = `https://api.dexscreener.com/latest/dex/pairs/solana`;
  // Not directly queryable by dex name — we use token profiles instead

  // Strategy: fetch the latest token profiles and cross-reference
  const profileUrl = 'https://api.dexscreener.com/token-profiles/latest/v1';
  const profiles = await rateLimitedGet<Array<{ chainId: string; tokenAddress: string }>>(profileUrl);
  if (profiles && Array.isArray(profiles)) {
    // Batch lookup tokens from profiles
    const solanaMints = profiles
      .filter((p) => p.chainId === 'solana')
      .map((p) => p.tokenAddress)
      .slice(0, 30); // Limit to avoid rate limiting

    for (let i = 0; i < solanaMints.length; i += 5) {
      const batch = solanaMints.slice(i, i + 5);
      for (const mint of batch) {
        const tokenUrl = `${DEXSCREENER_BASE}/tokens/${mint}`;
        const tokenData = await rateLimitedGet<{ pairs: DexPairRaw[] }>(tokenUrl);
        if (!tokenData?.pairs) continue;

        for (const pair of tokenData.pairs) {
          if (pair.chainId !== 'solana') continue;
          if (pair.dexId !== 'pumpswap' && pair.dexId !== 'pump_swap') continue;
          if (!pair.pairCreatedAt || pair.pairCreatedAt < cutoff24h) continue;

          addPairToMap(graduated, pair);
        }
      }
    }
  }
}

/**
 * Fetch recently graduated tokens that migrated to Raydium (legacy migration path).
 */
async function fetchRaydiumMigrations(
  graduated: Map<string, GraduatedToken>,
  cutoff24h: number,
): Promise<void> {
  // Search for recent Raydium pairs that could be pump.fun graduations
  // These typically have very small initial liquidity and pair with SOL
  const url = `https://api.dexscreener.com/latest/dex/search?q=raydium`;
  const data = await rateLimitedGet<{ pairs: DexPairRaw[] }>(url);
  if (!data?.pairs) return;

  for (const pair of data.pairs) {
    if (pair.chainId !== 'solana') continue;
    if (pair.dexId !== 'raydium') continue;
    if (!pair.pairCreatedAt || pair.pairCreatedAt < cutoff24h) continue;

    // Raydium pairs from pump.fun graduation typically:
    // - Quote token is SOL
    // - Relatively low initial liquidity
    // - Young pair age
    if (pair.quoteToken?.symbol === 'SOL' || pair.quoteToken?.symbol === 'WSOL') {
      addPairToMap(graduated, pair);
    }
  }
}

/**
 * Fetch graduated tokens using Helius DAS API for recently created pumpswap pools.
 * This is an alternative strategy that queries on-chain data directly.
 */
export async function fetchGraduatedViaHelius(): Promise<string[]> {
  try {
    // Use Helius getSignaturesForAddress on the PumpSwap migration program
    // to find recent graduation transactions
    const resp = await axios.post(config.helius.rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [
        // PumpSwap migration authority — this address receives LP when tokens graduate
        '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
        { limit: 100 },
      ],
    }, { timeout: 15_000 });

    const sigs = resp.data?.result || [];
    return sigs
      .filter((s: { err: unknown }) => !s.err)
      .map((s: { signature: string }) => s.signature);
  } catch (err) {
    logger.error({ err }, 'Failed to fetch graduation signatures via Helius');
    return [];
  }
}

/**
 * Given a list of graduation tx signatures, parse them to extract token mints.
 */
export async function parseGraduationTxs(signatures: string[]): Promise<string[]> {
  const mints: Set<string> = new Set();

  // Process in batches of 5 to stay within rate limits
  for (let i = 0; i < signatures.length; i += 5) {
    const batch = signatures.slice(i, i + 5);

    for (const sig of batch) {
      try {
        const resp = await axios.post(config.helius.rpcUrl, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }, { timeout: 10_000 });

        const tx = resp.data?.result;
        if (!tx) continue;

        // Extract token mints from postTokenBalances
        const postBalances = tx.meta?.postTokenBalances || [];
        for (const bal of postBalances) {
          if (bal.mint && bal.mint !== 'So11111111111111111111111111111111111111112') {
            mints.add(bal.mint);
          }
        }
      } catch {
        // Skip failed tx parses
      }
    }

    // Rate limit between batches
    if (i + 5 < signatures.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return Array.from(mints);
}

/**
 * Enrich a token mint with DexScreener data to build a GraduatedToken record.
 */
export async function enrichTokenWithDex(mint: string): Promise<GraduatedToken | null> {
  const url = `${DEXSCREENER_BASE}/tokens/${mint}`;
  const data = await rateLimitedGet<{ pairs: DexPairRaw[] }>(url, 2500);
  if (!data?.pairs?.length) return null;

  // Find the pumpswap or raydium pair
  const pair = data.pairs.find((p) =>
    p.dexId === 'pumpswap' || p.dexId === 'pump_swap',
  ) || data.pairs.find((p) =>
    p.dexId === 'raydium',
  );

  if (!pair) return null;

  const totalTxns = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
  const buySellRatio = totalTxns > 0 ? (pair.txns?.h24?.buys ?? 0) / totalTxns : 0;

  return {
    mint: pair.baseToken?.address || mint,
    symbol: pair.baseToken?.symbol || 'UNKNOWN',
    name: pair.baseToken?.name || 'Unknown Token',
    pairAddress: pair.pairAddress || '',
    dexId: pair.dexId || 'unknown',
    pairCreatedAt: pair.pairCreatedAt || 0,
    mcapUsd: pair.marketCap || pair.fdv || 0,
    liquidityUsd: pair.liquidity?.usd || 0,
    volume24h: pair.volume?.h24 || 0,
    priceUsd: parseFloat(pair.priceUsd || '0'),
    txns24hBuys: pair.txns?.h24?.buys || 0,
    txns24hSells: pair.txns?.h24?.sells || 0,
    buySellRatio,
    priceChangeH1: pair.priceChange?.h1 || 0,
    priceChangeH6: pair.priceChange?.h6 || 0,
    priceChangeH24: pair.priceChange?.h24 || 0,
  };
}

// --- Internal types ---

interface DexPairRaw {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken?: { address: string; name: string; symbol: string };
  quoteToken?: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: { h1?: { buys: number; sells: number }; h6?: { buys: number; sells: number }; h24?: { buys: number; sells: number } };
  volume?: { h1?: number; h6?: number; h24?: number };
  priceChange?: { h1?: number; h6?: number; h24?: number };
  liquidity?: { usd: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

function addPairToMap(map: Map<string, GraduatedToken>, pair: DexPairRaw): void {
  const mint = pair.baseToken?.address;
  if (!mint || map.has(mint)) return;

  const totalTxns = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
  const buySellRatio = totalTxns > 0 ? (pair.txns?.h24?.buys ?? 0) / totalTxns : 0;

  map.set(mint, {
    mint,
    symbol: pair.baseToken?.symbol || 'UNKNOWN',
    name: pair.baseToken?.name || 'Unknown Token',
    pairAddress: pair.pairAddress || '',
    dexId: pair.dexId || 'unknown',
    pairCreatedAt: pair.pairCreatedAt || 0,
    mcapUsd: pair.marketCap || pair.fdv || 0,
    liquidityUsd: pair.liquidity?.usd || 0,
    volume24h: pair.volume?.h24 || 0,
    priceUsd: parseFloat(pair.priceUsd || '0'),
    txns24hBuys: pair.txns?.h24?.buys || 0,
    txns24hSells: pair.txns?.h24?.sells || 0,
    buySellRatio,
    priceChangeH1: pair.priceChange?.h1 || 0,
    priceChangeH6: pair.priceChange?.h6 || 0,
    priceChangeH24: pair.priceChange?.h24 || 0,
  });
}
