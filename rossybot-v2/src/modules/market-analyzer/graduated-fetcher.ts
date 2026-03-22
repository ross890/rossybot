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
 * PRIMARY strategy: Helius on-chain graduation signatures (most reliable)
 * SECONDARY strategy: DexScreener token-boosts/latest for trending graduated tokens
 */
export async function fetchGraduatedTokens24h(): Promise<GraduatedToken[]> {
  const graduated: Map<string, GraduatedToken> = new Map();

  logger.info('Fetching graduated tokens from last 24h...');

  // Strategy 1 (PRIMARY): Helius on-chain — query PumpSwap migration program
  const heliusMints = await fetchMintsViaHelius();
  logger.info({ count: heliusMints.length }, 'Helius: found graduation mints');

  // Enrich each mint with DexScreener data (batch to avoid rate limits)
  for (let i = 0; i < heliusMints.length; i++) {
    const mint = heliusMints[i];
    if (graduated.has(mint)) continue;

    const enriched = await enrichTokenWithDex(mint);
    if (enriched) {
      graduated.set(mint, enriched);
    }

    // Progress log every 20 tokens
    if ((i + 1) % 20 === 0) {
      logger.info({ progress: `${i + 1}/${heliusMints.length}`, found: graduated.size }, 'Enriching mints...');
    }
  }

  // Strategy 2 (SECONDARY): DexScreener token-boosts for any we missed
  await fetchFromTokenBoosts(graduated);

  const tokens = Array.from(graduated.values());
  logger.info({ count: tokens.length, heliusMints: heliusMints.length }, 'Graduated tokens fetched');
  return tokens;
}

/**
 * Fetch graduated token mints via Helius on-chain data.
 * Queries the PumpSwap migration authority for recent graduation transactions,
 * then parses token mints from those transactions.
 */
async function fetchMintsViaHelius(): Promise<string[]> {
  const sigs = await fetchGraduatedViaHelius();
  if (sigs.length === 0) return [];

  // Parse up to 100 recent graduation txs
  const mints = await parseGraduationTxs(sigs.slice(0, 100));
  return mints;
}

/**
 * Fetch token-boosts/latest from DexScreener — these are recently trending tokens.
 * Filter for Solana pumpswap/raydium pairs as a supplemental source.
 */
async function fetchFromTokenBoosts(graduated: Map<string, GraduatedToken>): Promise<void> {
  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;

  try {
    const profileUrl = 'https://api.dexscreener.com/token-boosts/latest/v1';
    const profiles = await rateLimitedGet<Array<{ chainId: string; tokenAddress: string }>>(profileUrl);
    if (!profiles || !Array.isArray(profiles)) return;

    const solanaMints = profiles
      .filter((p) => p.chainId === 'solana')
      .map((p) => p.tokenAddress)
      .filter((m) => !graduated.has(m))
      .slice(0, 20);

    logger.info({ count: solanaMints.length }, 'DexScreener token-boosts: checking Solana tokens');

    for (const mint of solanaMints) {
      const tokenUrl = `${DEXSCREENER_BASE}/tokens/${mint}`;
      const tokenData = await rateLimitedGet<{ pairs: DexPairRaw[] }>(tokenUrl);
      if (!tokenData?.pairs) continue;

      for (const pair of tokenData.pairs) {
        if (pair.chainId !== 'solana') continue;
        // Accept pumpswap (post-March 2025) or raydium (legacy graduation)
        if (!isPumpGraduatedPair(pair)) continue;
        if (!pair.pairCreatedAt || pair.pairCreatedAt < cutoff24h) continue;

        addPairToMap(graduated, pair);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'DexScreener token-boosts fetch failed — continuing with Helius data');
  }
}

/**
 * Check if a DexScreener pair represents a graduated pump.fun token.
 */
function isPumpGraduatedPair(pair: DexPairRaw): boolean {
  const dex = (pair.dexId || '').toLowerCase();
  return dex === 'pumpswap' || dex === 'pump_swap' || dex === 'raydium';
}

/**
 * Fetch graduated tokens using Helius — query the PumpSwap migration authority
 * for recent graduation transactions.
 *
 * Known migration authorities / programs:
 * - 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg (PumpSwap migration authority)
 * - BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskCH9CKW2bRQ (pump.fun fee account)
 */
export async function fetchGraduatedViaHelius(): Promise<string[]> {
  // Try multiple known addresses to maximize coverage
  const migrationAddresses = [
    '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', // PumpSwap migration authority
    'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskCH9CKW2bRQ', // pump.fun fee account
  ];

  const allSigs: string[] = [];
  const seen = new Set<string>();

  for (const address of migrationAddresses) {
    try {
      const resp = await axios.post(config.helius.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [
          address,
          { limit: 200 },
        ],
      }, { timeout: 20_000 });

      const sigs = resp.data?.result || [];
      const validSigs = sigs
        .filter((s: { err: unknown }) => !s.err)
        .map((s: { signature: string }) => s.signature);

      for (const sig of validSigs) {
        if (!seen.has(sig)) {
          seen.add(sig);
          allSigs.push(sig);
        }
      }

      logger.info({ address: address.slice(0, 8), sigs: validSigs.length }, 'Helius: fetched graduation signatures');
    } catch (err) {
      logger.error({ err, address: address.slice(0, 8) }, 'Failed to fetch graduation signatures via Helius');
    }
  }

  return allSigs;
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

  logger.info({ signatures: signatures.length, uniqueMints: mints.size }, 'Parsed graduation tx mints');
  return Array.from(mints);
}

/**
 * Enrich a token mint with DexScreener data to build a GraduatedToken record.
 */
export async function enrichTokenWithDex(mint: string): Promise<GraduatedToken | null> {
  const url = `${DEXSCREENER_BASE}/tokens/${mint}`;
  const data = await rateLimitedGet<{ pairs: DexPairRaw[] }>(url, 2500);
  if (!data?.pairs?.length) return null;

  // Find the pumpswap or raydium pair (graduated pair)
  const pair = data.pairs.find((p) => isPumpGraduatedPair(p))
    // Fallback: if no pumpswap/raydium pair, take the first Solana pair
    // (dexId naming may vary — e.g. 'pumpfun' for post-migration pairs)
    || data.pairs.find((p) => p.chainId === 'solana');

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
