// ===========================================
// STANDALONE DEXSCREENER TOKEN CRAWLER
// Lightweight service for Railway deployment
// Only requires DATABASE_URL — no Telegram, Redis, or Helius
//
// Polls DexScreener for Solana tokens hitting $50k MC,
// tracks them through $100k/$250k/$500k/$1M milestones,
// and populates the token_tracking table for backtest analysis.
// ===========================================

import pg from 'pg';
import axios, { AxiosInstance } from 'axios';
import pino from 'pino';
import express from 'express';
import { config } from 'dotenv';

config();

const { Pool } = pg;

// ============ CONFIGURATION ============

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const logger = pino({ level: LOG_LEVEL });

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Database pool error');
});

// ============ CRAWLER CONFIG ============

const CONFIG = {
  // Discovery: how often to fetch new tokens from DexScreener
  DISCOVERY_INTERVAL_MS: 3 * 60 * 1000, // 3 minutes

  // Polling tiers: how often to re-check tracked tokens
  ACTIVE_POLL_MS: 30 * 1000,     // Active ($50k-$90k): every 30s
  CANDIDATE_POLL_MS: 2 * 60 * 1000, // Candidate (approaching $50k): every 2 min
  BACKGROUND_POLL_MS: 5 * 60 * 1000, // Background (>$100k, monitoring): every 5 min

  // Market cap milestones
  MC_50K: 50_000,
  MC_100K: 100_000,
  MC_250K: 250_000,
  MC_500K: 500_000,
  MC_1M: 1_000_000,

  // Stop tracking after 48 hours
  MAX_TRACKING_MS: 48 * 60 * 60 * 1000,

  // DexScreener rate limiting
  MIN_REQUEST_INTERVAL_MS: 500, // Max 2 req/sec
  CACHE_TTL_MS: 30 * 1000,

  // RugCheck
  RUGCHECK_BASE_URL: 'https://api.rugcheck.xyz/v1',
  RUGCHECK_CACHE_TTL_MS: 60 * 60 * 1000, // 1 hour
};

// ============ TYPES ============

interface TrackedToken {
  contractAddress: string;
  pairAddress: string | null;
  ticker: string;
  marketCap: number;
  firstTrackedAt: number;
  tier: 'ACTIVE' | 'CANDIDATE' | 'BACKGROUND';
  lastPolled: number;
}

interface DexScreenerPairData {
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  fdv: number;
  volume: { h24: number };
  liquidity: { usd: number };
  pairCreatedAt?: number;
  boosts?: { active: number };
}

// ============ DEXSCREENER CLIENT ============

class DexScreenerCrawlerClient {
  private client: AxiosInstance;
  private cache = new Map<string, { data: DexScreenerPairData[]; expiry: number }>();
  private lastDexRequestTime = 0;
  private lastBoostRequestTime = 0;
  private rateLimitBackoff = 0;

  // Cache for boost/profile results (shared across methods, 30s TTL)
  private boostCache: { data: any[]; expiry: number } | null = null;
  private topBoostCache: { data: any[]; expiry: number } | null = null;
  private profileCache: { data: any[]; expiry: number } | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.dexscreener.com',
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; SolanaBot/1.0)',
      },
    });

    // Cache cleanup every 5 minutes
    setInterval(() => {
      const now = Date.now();
      for (const [key, val] of this.cache) {
        if (val.expiry < now) this.cache.delete(key);
      }
    }, 5 * 60 * 1000);
  }

  // DEX endpoints rate limit: 300 req/min
  private async dexRateLimit(): Promise<void> {
    const wait = CONFIG.MIN_REQUEST_INTERVAL_MS + this.rateLimitBackoff - (Date.now() - this.lastDexRequestTime);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastDexRequestTime = Date.now();
  }

  // Boost/profile endpoints rate limit: 60 req/min
  private async boostRateLimit(): Promise<void> {
    const wait = 1100 + this.rateLimitBackoff - (Date.now() - this.lastBoostRequestTime);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastBoostRequestTime = Date.now();
  }

  async getTokenPairs(address: string): Promise<DexScreenerPairData[]> {
    const cached = this.cache.get(address);
    if (cached && cached.expiry > Date.now()) return cached.data;

    await this.dexRateLimit();
    try {
      const res = await this.client.get(`/token-pairs/v1/solana/${address}`);
      const rawPairs = Array.isArray(res.data) ? res.data : (res.data.pairs || []);
      const pairs = rawPairs.filter((p: any) => p.chainId === 'solana') || [];
      this.cache.set(address, { data: pairs, expiry: Date.now() + CONFIG.CACHE_TTL_MS });

      if (this.rateLimitBackoff > 0) {
        this.rateLimitBackoff = Math.max(0, Math.floor(this.rateLimitBackoff / 2));
      }
      return pairs;
    } catch (err: any) {
      if (err?.response?.status === 429) {
        this.rateLimitBackoff = Math.min(10000, (this.rateLimitBackoff || 500) * 2);
        logger.warn({ backoff: this.rateLimitBackoff }, 'DexScreener rate limited');
      }
      return [];
    }
  }

  private async fetchBoostData(): Promise<any[]> {
    const now = Date.now();
    if (this.boostCache && this.boostCache.expiry > now) return this.boostCache.data;
    await this.boostRateLimit();
    const res = await this.client.get('/token-boosts/latest/v1');
    const data = res.data || [];
    this.boostCache = { data, expiry: now + CONFIG.CACHE_TTL_MS };
    return data;
  }

  private async fetchTopBoostData(): Promise<any[]> {
    const now = Date.now();
    if (this.topBoostCache && this.topBoostCache.expiry > now) return this.topBoostCache.data;
    await this.boostRateLimit();
    const res = await this.client.get('/token-boosts/top/v1');
    const data = res.data || [];
    this.topBoostCache = { data, expiry: now + CONFIG.CACHE_TTL_MS };
    return data;
  }

  private async fetchProfileData(): Promise<any[]> {
    const now = Date.now();
    if (this.profileCache && this.profileCache.expiry > now) return this.profileCache.data;
    await this.boostRateLimit();
    const res = await this.client.get('/token-profiles/latest/v1');
    const data = res.data || [];
    this.profileCache = { data, expiry: now + CONFIG.CACHE_TTL_MS };
    return data;
  }

  async getNewSolanaPairs(limit = 50): Promise<string[]> {
    // Try token-boosts/latest first
    try {
      const data = await this.fetchBoostData();
      const pairs = data.filter((p: any) => p.chainId === 'solana').slice(0, limit);
      if (pairs.length > 0) return pairs.map((p: any) => p.tokenAddress).filter(Boolean);
    } catch { /* try next */ }

    // Fallback 1: token-boosts/top
    try {
      const data = await this.fetchTopBoostData();
      const pairs = data.filter((p: any) => p.chainId === 'solana').slice(0, limit);
      if (pairs.length > 0) return pairs.map((p: any) => p.tokenAddress).filter(Boolean);
    } catch { /* try next */ }

    // Fallback 2: token-profiles
    try {
      const data = await this.fetchProfileData();
      const profiles = data.filter((p: any) => p.chainId === 'solana').slice(0, limit);
      return profiles.map((p: any) => p.tokenAddress).filter(Boolean);
    } catch {
      return [];
    }
  }

  async getTrendingSolana(limit = 50): Promise<string[]> {
    const addresses: string[] = [];

    // Source 1: token-boosts/latest
    try {
      const data = await this.fetchBoostData();
      for (const t of data) {
        if (t.chainId === 'solana' && t.tokenAddress && !addresses.includes(t.tokenAddress)) {
          addresses.push(t.tokenAddress);
          if (addresses.length >= limit) break;
        }
      }
    } catch { /* continue */ }

    // Source 2: token-boosts/top (sorted by amount)
    if (addresses.length < limit) {
      try {
        const data = await this.fetchTopBoostData();
        for (const t of data) {
          if (t.chainId === 'solana' && t.tokenAddress && !addresses.includes(t.tokenAddress)) {
            addresses.push(t.tokenAddress);
            if (addresses.length >= limit) break;
          }
        }
      } catch { /* continue */ }
    }

    // Source 3: token-profiles
    if (addresses.length < limit) {
      try {
        const data = await this.fetchProfileData();
        for (const t of data) {
          if (t.chainId === 'solana' && t.tokenAddress && !addresses.includes(t.tokenAddress)) {
            addresses.push(t.tokenAddress);
            if (addresses.length >= limit) break;
          }
        }
      } catch { /* continue */ }
    }

    return addresses;
  }
}

// ============ RUGCHECK CLIENT (LIGHTWEIGHT) ============

class RugCheckLite {
  private cache = new Map<string, { data: any; expiry: number }>();

  async check(address: string): Promise<{ score: string; risks: string[] } | null> {
    const cached = this.cache.get(address);
    if (cached && cached.expiry > Date.now()) return cached.data;

    try {
      const res = await axios.get(`${CONFIG.RUGCHECK_BASE_URL}/tokens/${address}/report`, {
        timeout: 8000,
      });
      const data = res.data;
      const risks = (data.risks || []).map((r: any) => r.name || r.description).filter(Boolean);

      let score = 'GOOD';
      const hasCritical = risks.some((r: string) =>
        /mint.*authority|freeze.*authority|honeypot/i.test(r)
      );
      if (hasCritical) score = 'DANGER';
      else if (risks.length > 2) score = 'WARNING';

      const result = { score, risks };
      this.cache.set(address, { data: result, expiry: Date.now() + CONFIG.RUGCHECK_CACHE_TTL_MS });

      // Store in DB
      await pool.query(
        `UPDATE token_tracking SET
          rugcheck_score = $1, rugcheck_raw = $2,
          mint_authority_revoked = $3, freeze_authority_revoked = $4,
          lp_locked = $5
        WHERE contract_address = $6`,
        [
          score,
          JSON.stringify(data),
          !risks.some((r: string) => /mint.*authority/i.test(r)),
          !risks.some((r: string) => /freeze.*authority/i.test(r)),
          !risks.some((r: string) => /lp.*unlock|liquidity.*unlock/i.test(r)),
          address,
        ]
      ).catch(() => {});

      return result;
    } catch {
      return null;
    }
  }
}

// ============ TOKEN CRAWLER ============

class StandaloneCrawler {
  private dex = new DexScreenerCrawlerClient();
  private rugcheck = new RugCheckLite();
  private tracked = new Map<string, TrackedToken>();
  private discoveryTimer: NodeJS.Timeout | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private stats = { discovered: 0, tracked: 0, hit100k: 0, hit250k: 0, hit500k: 0, hit1m: 0 };

  async initialize(): Promise<void> {
    logger.info('Initializing standalone crawler...');

    // Ensure tables exist
    await this.ensureTables();

    // Load tokens we're still tracking from DB
    const result = await pool.query(`
      SELECT contract_address, pair_address, ticker, peak_mc, first_50k_timestamp, created_at
      FROM token_tracking
      WHERE first_50k_timestamp IS NOT NULL
        AND hit_100k = FALSE
        AND created_at > NOW() - INTERVAL '48 hours'
    `);

    for (const row of result.rows) {
      this.tracked.set(row.contract_address, {
        contractAddress: row.contract_address,
        pairAddress: row.pair_address,
        ticker: row.ticker || 'UNKNOWN',
        marketCap: Number(row.peak_mc) || 50000,
        firstTrackedAt: new Date(row.created_at).getTime(),
        tier: this.classifyTier(Number(row.peak_mc) || 50000),
        lastPolled: 0,
      });
    }

    // Also load tokens that hit $100k but still monitoring for higher milestones
    const monitoring = await pool.query(`
      SELECT contract_address, pair_address, ticker, peak_mc, first_50k_timestamp, created_at
      FROM token_tracking
      WHERE hit_100k = TRUE AND hit_1m = FALSE
        AND created_at > NOW() - INTERVAL '48 hours'
    `);

    for (const row of monitoring.rows) {
      if (!this.tracked.has(row.contract_address)) {
        this.tracked.set(row.contract_address, {
          contractAddress: row.contract_address,
          pairAddress: row.pair_address,
          ticker: row.ticker || 'UNKNOWN',
          marketCap: Number(row.peak_mc) || 100000,
          firstTrackedAt: new Date(row.created_at).getTime(),
          tier: 'BACKGROUND',
          lastPolled: 0,
        });
      }
    }

    logger.info({ trackedCount: this.tracked.size }, 'Crawler initialized, loaded existing tokens');
  }

  start(): void {
    logger.info('Starting crawler...');

    // Discovery: find new tokens every 3 minutes
    this.discoverNewTokens();
    this.discoveryTimer = setInterval(() => this.discoverNewTokens(), CONFIG.DISCOVERY_INTERVAL_MS);

    // Polling: check tracked tokens for milestones
    this.pollTrackedTokens();
    this.pollingTimer = setInterval(() => this.pollTrackedTokens(), CONFIG.ACTIVE_POLL_MS);

    // Stats logging every 10 minutes
    setInterval(() => this.logStats(), 10 * 60 * 1000);
  }

  stop(): void {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    logger.info('Crawler stopped');
  }

  getStats() {
    return {
      ...this.stats,
      currentlyTracked: this.tracked.size,
      byTier: this.getTierCounts(),
    };
  }

  // ---- Discovery ----

  private async discoverNewTokens(): Promise<void> {
    try {
      const [profiles, trending] = await Promise.all([
        this.dex.getNewSolanaPairs(50),
        this.dex.getTrendingSolana(50),
      ]);

      const newAddresses = new Set<string>();
      for (const addr of [...profiles, ...trending]) {
        if (!this.tracked.has(addr)) newAddresses.add(addr);
      }

      this.stats.discovered += newAddresses.size;

      logger.info({
        profiles: profiles.length,
        trending: trending.length,
        newCandidates: newAddresses.size,
        tracked: this.tracked.size,
      }, 'Discovery scan complete');

      // Check each new token for $50k MC
      for (const address of newAddresses) {
        try {
          const pairs = await this.dex.getTokenPairs(address);
          if (!pairs.length) continue;

          const pair = pairs[0];
          const mc = pair.fdv || 0;

          if (mc >= CONFIG.MC_50K) {
            await this.startTracking(address, pair);
          }
        } catch (err) {
          logger.debug({ address: address.slice(0, 8) }, 'Failed to check token');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Discovery failed');
    }
  }

  private async startTracking(address: string, pair: DexScreenerPairData): Promise<void> {
    const mc = pair.fdv || 0;
    const ticker = pair.baseToken?.symbol || 'UNKNOWN';

    try {
      await pool.query(
        `INSERT INTO token_tracking (
          contract_address, pair_address, ticker,
          launch_timestamp, first_50k_timestamp, mc_at_50k,
          volume_24h_at_50k, liquidity_at_50k, peak_mc, peak_mc_timestamp
        ) VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $5, NOW())
        ON CONFLICT (contract_address) DO UPDATE SET
          peak_mc = GREATEST(token_tracking.peak_mc, $5),
          peak_mc_timestamp = CASE WHEN $5 > token_tracking.peak_mc THEN NOW() ELSE token_tracking.peak_mc_timestamp END,
          updated_at = NOW()`,
        [
          address,
          pair.pairAddress || null,
          ticker,
          pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null,
          mc,
          pair.volume?.h24 || 0,
          pair.liquidity?.usd || 0,
        ]
      );

      this.tracked.set(address, {
        contractAddress: address,
        pairAddress: pair.pairAddress || null,
        ticker,
        marketCap: mc,
        firstTrackedAt: Date.now(),
        tier: this.classifyTier(mc),
        lastPolled: Date.now(),
      });

      this.stats.tracked++;

      logger.info({
        address: address.slice(0, 8),
        ticker,
        mc: Math.round(mc).toLocaleString(),
        liq: Math.round(pair.liquidity?.usd || 0).toLocaleString(),
        vol24h: Math.round(pair.volume?.h24 || 0).toLocaleString(),
      }, 'New token tracked at $50k+ MC');

      // Fire-and-forget RugCheck
      this.rugcheck.check(address).catch(() => {});
    } catch (err) {
      logger.error({ err, address: address.slice(0, 8) }, 'Failed to insert tracked token');
    }
  }

  // ---- Polling ----

  private async pollTrackedTokens(): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [address, token] of this.tracked) {
      // Expire after 48 hours
      if (now - token.firstTrackedAt > CONFIG.MAX_TRACKING_MS) {
        toRemove.push(address);
        continue;
      }

      // Check if due for poll based on tier
      const interval = this.getTierInterval(token.tier);
      if (now - token.lastPolled < interval) continue;

      try {
        const pairs = await this.dex.getTokenPairs(address);
        if (!pairs.length) continue;

        const pair = pairs[0];
        const currentMC = pair.fdv || 0;

        token.marketCap = currentMC;
        token.lastPolled = now;
        token.tier = this.classifyTier(currentMC);

        await this.updateMilestones(address, currentMC);
      } catch {
        // Skip, will retry next poll
      }
    }

    for (const addr of toRemove) {
      this.tracked.delete(addr);
      logger.debug({ address: addr.slice(0, 8) }, 'Token expired (48h limit)');
    }
  }

  private async updateMilestones(address: string, currentMC: number): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT peak_mc, first_50k_timestamp, hit_100k, hit_250k, hit_500k, hit_1m
         FROM token_tracking WHERE contract_address = $1`,
        [address]
      );

      if (!result.rows.length) return;
      const row = result.rows[0];
      const prevPeak = Number(row.peak_mc) || 0;
      const first50k = row.first_50k_timestamp ? new Date(row.first_50k_timestamp) : null;

      const updates: string[] = [];
      const params: any[] = [];
      let idx = 1;

      // Update peak MC
      if (currentMC > prevPeak) {
        updates.push(`peak_mc = $${idx}, peak_mc_timestamp = NOW()`);
        params.push(currentMC);
        idx++;

        if (first50k) {
          const mins = Math.round((Date.now() - first50k.getTime()) / 60000);
          updates.push(`time_50k_to_peak_minutes = $${idx}`);
          params.push(mins);
          idx++;
        }
      }

      // Milestone flags
      if (!row.hit_100k && currentMC >= CONFIG.MC_100K) {
        updates.push('hit_100k = TRUE');
        if (first50k) {
          const mins = Math.round((Date.now() - first50k.getTime()) / 60000);
          updates.push(`time_50k_to_100k_minutes = $${idx}`);
          params.push(mins);
          idx++;
        }
        this.stats.hit100k++;
        logger.info({ address: address.slice(0, 8), mc: currentMC }, 'MILESTONE: $100k (2x)');
      }

      if (!row.hit_250k && currentMC >= CONFIG.MC_250K) {
        updates.push('hit_250k = TRUE');
        this.stats.hit250k++;
        logger.info({ address: address.slice(0, 8), mc: currentMC }, 'MILESTONE: $250k (5x)');
      }

      if (!row.hit_500k && currentMC >= CONFIG.MC_500K) {
        updates.push('hit_500k = TRUE');
        this.stats.hit500k++;
        logger.info({ address: address.slice(0, 8), mc: currentMC }, 'MILESTONE: $500k (10x)');
      }

      if (!row.hit_1m && currentMC >= CONFIG.MC_1M) {
        updates.push('hit_1m = TRUE');
        this.stats.hit1m++;
        logger.info({ address: address.slice(0, 8), mc: currentMC }, 'MILESTONE: $1M (20x)!');
      }

      if (updates.length > 0) {
        params.push(address);
        await pool.query(
          `UPDATE token_tracking SET ${updates.join(', ')}, updated_at = NOW()
           WHERE contract_address = $${idx}`,
          params
        );
      }
    } catch (err) {
      logger.debug({ err, address: address.slice(0, 8) }, 'Failed to update milestones');
    }
  }

  // ---- Helpers ----

  private classifyTier(mc: number): 'ACTIVE' | 'CANDIDATE' | 'BACKGROUND' {
    if (mc >= 50000 && mc < 90000) return 'ACTIVE';
    if (mc >= 30000 && mc < 50000) return 'CANDIDATE';
    return 'BACKGROUND';
  }

  private getTierInterval(tier: string): number {
    switch (tier) {
      case 'ACTIVE': return CONFIG.ACTIVE_POLL_MS;
      case 'CANDIDATE': return CONFIG.CANDIDATE_POLL_MS;
      default: return CONFIG.BACKGROUND_POLL_MS;
    }
  }

  private getTierCounts() {
    let active = 0, candidate = 0, background = 0;
    for (const t of this.tracked.values()) {
      if (t.tier === 'ACTIVE') active++;
      else if (t.tier === 'CANDIDATE') candidate++;
      else background++;
    }
    return { active, candidate, background };
  }

  private logStats(): void {
    const tiers = this.getTierCounts();
    logger.info({
      tracked: this.tracked.size,
      ...tiers,
      milestones: {
        discovered: this.stats.discovered,
        tracked: this.stats.tracked,
        hit100k: this.stats.hit100k,
        hit250k: this.stats.hit250k,
        hit500k: this.stats.hit500k,
        hit1m: this.stats.hit1m,
      },
    }, 'Crawler stats');
  }

  private async ensureTables(): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS token_tracking (
        id SERIAL PRIMARY KEY,
        contract_address VARCHAR(64) NOT NULL UNIQUE,
        pair_address VARCHAR(64),
        ticker VARCHAR(32),
        deployer_wallet VARCHAR(64),
        launch_timestamp TIMESTAMPTZ,
        first_50k_timestamp TIMESTAMPTZ,
        mc_at_50k NUMERIC,
        holders_at_50k INTEGER,
        volume_24h_at_50k NUMERIC,
        liquidity_at_50k NUMERIC,
        peak_mc NUMERIC,
        peak_mc_timestamp TIMESTAMPTZ,
        time_50k_to_peak_minutes INTEGER,
        hit_100k BOOLEAN DEFAULT FALSE,
        hit_250k BOOLEAN DEFAULT FALSE,
        hit_500k BOOLEAN DEFAULT FALSE,
        hit_1m BOOLEAN DEFAULT FALSE,
        time_50k_to_100k_minutes INTEGER,
        rugcheck_score VARCHAR(16),
        mint_authority_revoked BOOLEAN,
        freeze_authority_revoked BOOLEAN,
        lp_locked BOOLEAN,
        top10_holder_pct NUMERIC,
        rugcheck_raw JSONB,
        dev_total_launches INTEGER,
        dev_launches_over_100k INTEGER,
        dev_score VARCHAR(16),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tt_contract ON token_tracking(contract_address);
      CREATE INDEX IF NOT EXISTS idx_tt_hit_100k ON token_tracking(hit_100k);
      CREATE INDEX IF NOT EXISTS idx_tt_first_50k ON token_tracking(first_50k_timestamp);
      CREATE INDEX IF NOT EXISTS idx_tt_dev_score ON token_tracking(dev_score);
      CREATE INDEX IF NOT EXISTS idx_tt_deployer ON token_tracking(deployer_wallet);

      CREATE TABLE IF NOT EXISTS probability_config (
        key VARCHAR(64) PRIMARY KEY,
        value NUMERIC NOT NULL,
        description TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO probability_config (key, value, description) VALUES
        ('base_rate', 0.32, 'Base conversion rate')
      ON CONFLICT (key) DO NOTHING;
    `);
    logger.info('Database tables verified');
  }
}

// ============ HEALTH CHECK SERVER ============

function startHealthServer(crawler: StandaloneCrawler): void {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), ...crawler.getStats() });
  });

  app.get('/stats', async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE hit_100k = TRUE) as hit_100k,
          COUNT(*) FILTER (WHERE hit_250k = TRUE) as hit_250k,
          COUNT(*) FILTER (WHERE hit_500k = TRUE) as hit_500k,
          COUNT(*) FILTER (WHERE hit_1m = TRUE) as hit_1m,
          ROUND(
            COALESCE(
              COUNT(*) FILTER (WHERE hit_100k = TRUE)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 0
            ), 1
          ) as conversion_pct
        FROM token_tracking
        WHERE first_50k_timestamp IS NOT NULL
      `);
      res.json({ ...result.rows[0], crawlerStats: crawler.getStats() });
    } catch (err) {
      res.status(500).json({ error: 'Database query failed' });
    }
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'Health server listening');
  });
}

// ============ MAIN ============

async function main(): Promise<void> {
  logger.info('='.repeat(50));
  logger.info('ROSSYBOT DEXSCREENER TOKEN CRAWLER');
  logger.info('='.repeat(50));

  const crawler = new StandaloneCrawler();
  await crawler.initialize();

  startHealthServer(crawler);
  crawler.start();

  logger.info('Crawler is running. Tracking tokens from $50k MC through milestones.');
  logger.info('Endpoints: GET /health, GET /stats');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    crawler.stop();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
