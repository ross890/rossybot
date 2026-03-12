// ===========================================
// MODULE: TRENDING TICKER SCANNER
// Scheduled scan of trending Solana memecoins from DexScreener + GMGN.
// Produces a clean Telegram digest of what's hot — replaces fake social metrics.
// Runs on a configurable schedule (default: every 12 hours).
// ===========================================

import { logger } from '../../utils/logger.js';
import { dexScreenerClient, getTokenMetrics } from '../onchain.js';
import { appConfig } from '../../config/index.js';

// ============ TYPES ============

export interface TrendingToken {
  address: string;
  ticker: string;
  name: string;
  marketCap: number;
  volume24h: number;
  holderCount: number;
  smartBuys24h: number;        // GMGN smart money buys
  smartSells24h: number;       // GMGN smart money sells
  boostCount: number;          // DexScreener boosts
  hasPaidDex: boolean;         // Paid DexScreener profile
  sources: ('GMGN' | 'DEXSCREENER')[];
  netSmartFlow: number;        // smart buys - smart sells
  trendScore: number;          // Composite trending score
}

export interface TrendingDigest {
  tokens: TrendingToken[];
  scannedAt: Date;
  gmgnCount: number;
  dexScreenerCount: number;
}

// ============ CONSTANTS ============

const GMGN_BASE_URL = 'https://gmgn.ai';
const GMGN_RANK_PATH = '/defi/quotation/v1/rank/sol/swaps';

// Only show tokens in our target range
const MIN_MCAP = 30_000;
const MAX_MCAP = 1_000_000;
const MIN_VOLUME = 2_000;

// How many tokens to include in digest
const DIGEST_SIZE = 15;

// ============ TRENDING SCANNER CLASS ============

class TrendingScanner {
  private lastDigest: TrendingDigest | null = null;
  private scanTimer: NodeJS.Timeout | null = null;

  /**
   * Start scheduled scanning.
   */
  start(intervalMs: number = 12 * 60 * 60 * 1000): void {
    if (this.scanTimer) return;

    logger.info({ intervalHours: intervalMs / 3600000 }, 'Starting trending scanner');

    // Run immediately, then on schedule
    this.scan().catch(err => logger.error({ err }, 'Initial trending scan failed'));
    this.scanTimer = setInterval(() => {
      this.scan().catch(err => logger.error({ err }, 'Scheduled trending scan failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /**
   * Run a full trending scan. Returns the digest.
   */
  async scan(): Promise<TrendingDigest> {
    logger.info('Running trending ticker scan...');

    const tokenMap = new Map<string, Partial<TrendingToken>>();

    // Source 1: GMGN smart money ranking (includes rich metadata)
    const gmgnTokens = await this.fetchGmgnTrending();
    let gmgnCount = 0;
    for (const token of gmgnTokens) {
      const existing = tokenMap.get(token.address) || { address: token.address, sources: [] };
      existing.ticker = token.ticker;
      existing.name = token.name;
      existing.marketCap = token.marketCap;
      existing.volume24h = token.volume;
      existing.holderCount = token.holderCount;
      existing.smartBuys24h = token.smartBuys;
      existing.smartSells24h = token.smartSells;
      existing.sources = [...(existing.sources || []), 'GMGN'];
      tokenMap.set(token.address, existing);
      gmgnCount++;
    }

    // Source 2: DexScreener boosted/trending
    let dexCount = 0;
    try {
      const dexTrending = await dexScreenerClient.getTrendingSolanaTokens(50);
      for (const address of dexTrending) {
        const existing = tokenMap.get(address) || { address, sources: [] };
        existing.sources = [...(existing.sources || []), 'DEXSCREENER'];

        // Get boost/profile info
        try {
          const info = await dexScreenerClient.getTokenInfo(address);
          existing.boostCount = info.boostCount || 0;
          existing.hasPaidDex = info.hasPaidDexscreener || false;
        } catch {
          existing.boostCount = existing.boostCount || 0;
          existing.hasPaidDex = existing.hasPaidDex || false;
        }

        tokenMap.set(address, existing);
        dexCount++;
      }
    } catch (error) {
      logger.debug({ error }, 'DexScreener trending fetch failed');
    }

    // Enrich tokens missing metadata (from DexScreener-only sources)
    const enrichPromises: Promise<void>[] = [];
    for (const [address, token] of tokenMap) {
      if (!token.ticker || !token.marketCap) {
        enrichPromises.push(
          getTokenMetrics(address).then(metrics => {
            if (metrics) {
              token.ticker = token.ticker || metrics.ticker;
              token.name = token.name || metrics.name;
              token.marketCap = token.marketCap || metrics.marketCap;
              token.volume24h = token.volume24h || metrics.volume24h;
              token.holderCount = token.holderCount || metrics.holderCount;
            }
          }).catch(() => {})
        );
      }
    }
    await Promise.allSettled(enrichPromises);

    // Filter and score
    const scored: TrendingToken[] = [];
    for (const [_, token] of tokenMap) {
      const mcap = token.marketCap || 0;
      const vol = token.volume24h || 0;

      // Skip tokens outside our range or missing key data
      if (!token.ticker || mcap < MIN_MCAP || mcap > MAX_MCAP || vol < MIN_VOLUME) continue;

      const smartBuys = token.smartBuys24h || 0;
      const smartSells = token.smartSells24h || 0;
      const netSmartFlow = smartBuys - smartSells;
      const boosts = token.boostCount || 0;
      const multiSource = (token.sources || []).length >= 2;

      // Trending score
      let score = 0;
      score += Math.min(30, netSmartFlow * 3);           // Net smart money flow (max 30)
      score += Math.min(20, (vol / mcap) * 100);          // Volume/mcap ratio (max 20)
      score += Math.min(15, boosts * 3);                   // DexScreener boosts (max 15)
      score += multiSource ? 15 : 0;                       // Multi-source bonus
      score += (token.hasPaidDex ? 10 : 0);                // Paid DexScreener = dev spending money
      score += Math.min(10, (token.holderCount || 0) / 50); // Holder bonus (max 10)

      scored.push({
        address: token.address!,
        ticker: token.ticker || 'UNKNOWN',
        name: token.name || 'Unknown',
        marketCap: mcap,
        volume24h: vol,
        holderCount: token.holderCount || 0,
        smartBuys24h: smartBuys,
        smartSells24h: smartSells,
        boostCount: boosts,
        hasPaidDex: token.hasPaidDex || false,
        sources: token.sources as ('GMGN' | 'DEXSCREENER')[],
        netSmartFlow,
        trendScore: Math.round(Math.min(100, Math.max(0, score))),
      });
    }

    // Sort by trend score, take top N
    scored.sort((a, b) => b.trendScore - a.trendScore);
    const topTokens = scored.slice(0, DIGEST_SIZE);

    const digest: TrendingDigest = {
      tokens: topTokens,
      scannedAt: new Date(),
      gmgnCount,
      dexScreenerCount: dexCount,
    };

    this.lastDigest = digest;

    logger.info({
      totalCandidates: tokenMap.size,
      afterFilter: scored.length,
      topTokens: topTokens.length,
      gmgnCount,
      dexCount,
    }, 'Trending scan complete');

    return digest;
  }

  /**
   * Get the last digest (without re-scanning).
   */
  getLastDigest(): TrendingDigest | null {
    return this.lastDigest;
  }

  /**
   * Format digest for Telegram.
   */
  formatDigest(digest: TrendingDigest): string {
    const time = digest.scannedAt.toISOString().replace('T', ' ').slice(0, 16);

    let msg = `\n`;
    msg += `═══════════════════════════════\n`;
    msg += `📡  *TRENDING TICKER SCAN*\n`;
    msg += `    ${time} UTC\n`;
    msg += `═══════════════════════════════\n\n`;

    msg += `_Sources: GMGN (${digest.gmgnCount}) · DexScreener (${digest.dexScreenerCount})_\n`;
    msg += `_Filter: $${(MIN_MCAP/1000).toFixed(0)}K-$${(MAX_MCAP/1000000).toFixed(0)}M mcap_\n\n`;

    if (digest.tokens.length === 0) {
      msg += `No trending tokens in range.\n`;
      msg += `═══════════════════════════════\n`;
      return msg;
    }

    for (let i = 0; i < digest.tokens.length; i++) {
      const t = digest.tokens[i];
      const rank = i + 1;

      // Source badges
      const srcBadges = t.sources.includes('GMGN') && t.sources.includes('DEXSCREENER')
        ? '🔵🟢' : t.sources.includes('GMGN') ? '🔵' : '🟢';

      // Smart money flow indicator
      const flowEmoji = t.netSmartFlow > 3 ? '🔥' : t.netSmartFlow > 0 ? '📈' : t.netSmartFlow === 0 ? '➖' : '📉';

      msg += `*${rank}.* \`$${this.escapeMarkdown(t.ticker)}\` ${srcBadges}\n`;
      msg += `   MCap: \`$${this.formatNumber(t.marketCap)}\` · Vol: \`$${this.formatNumber(t.volume24h)}\`\n`;
      msg += `   ${flowEmoji} Smart: +${t.smartBuys24h}/-${t.smartSells24h}`;
      if (t.boostCount > 0) msg += ` · 🚀 ${t.boostCount} boosts`;
      if (t.hasPaidDex) msg += ` · 💰 Paid`;
      msg += `\n`;
      msg += `   Holders: ${t.holderCount} · Score: *${t.trendScore}/100*\n`;
      msg += `   [Chart](https://dexscreener.com/solana/${t.address}) · [Buy](https://jup.ag/swap/SOL-${t.address})\n`;

      if (i < digest.tokens.length - 1) msg += `\n`;
    }

    msg += `\n═══════════════════════════════\n`;
    msg += `_🔵 GMGN · 🟢 DexScreener_\n`;
    msg += `_Smart money flow = buys − sells (24h)_\n`;

    return msg;
  }

  /**
   * Fetch GMGN trending with full metadata (not just addresses).
   */
  private async fetchGmgnTrending(): Promise<Array<{
    address: string;
    ticker: string;
    name: string;
    marketCap: number;
    volume: number;
    holderCount: number;
    smartBuys: number;
    smartSells: number;
  }>> {
    const results: Array<{
      address: string;
      ticker: string;
      name: string;
      marketCap: number;
      volume: number;
      holderCount: number;
      smartBuys: number;
      smartSells: number;
    }> = [];

    for (const tf of ['1h', '5m']) {
      try {
        const url = `${GMGN_BASE_URL}${GMGN_RANK_PATH}/${tf}?orderby=swaps&direction=desc&limit=50&filters[]=not_honeypot`;

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Referer': 'https://gmgn.ai/',
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) continue;

        const data = await response.json() as any;
        if (data.code !== 0 || !data.data?.rank) continue;

        for (const token of data.data.rank) {
          const addr = token.address || token.token_address || token.contract_address;
          if (!addr) continue;

          // Skip if we already have this token from a previous timeframe
          if (results.some(r => r.address === addr)) continue;

          results.push({
            address: addr,
            ticker: token.symbol || 'UNKNOWN',
            name: token.name || token.symbol || 'Unknown',
            marketCap: token.market_cap || 0,
            volume: token.volume || 0,
            holderCount: token.holder_count || 0,
            smartBuys: token.smart_buy_24h || 0,
            smartSells: token.smart_sell_24h || 0,
          });
        }
      } catch (error) {
        logger.debug({ error, tf: tf }, 'GMGN trending fetch failed for timeframe');
      }
    }

    return results;
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  }

  private formatNumber(num: number): string {
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return num.toFixed(0);
  }
}

export const trendingScanner = new TrendingScanner();
