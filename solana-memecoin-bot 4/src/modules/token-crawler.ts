// ===========================================
// TOKEN DATA CRAWLER (Task A)
// Collects token data from DexScreener for backtesting
// Tracks $50k → $100k MC conversion rates
// ===========================================

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { pool } from '../utils/database.js';
import { dexScreenerRateLimiter, TTLCache } from '../utils/rate-limiter.js';
import { dexScreenerClient } from './onchain.js';
import { rugCheckClient } from './rugcheck.js';
import { devWalletScorer } from './dev-scorer.js';

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
  info?: {
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
}

// ============ CONFIGURATION ============

const CRAWLER_CONFIG = {
  // Poll intervals per tier
  TIER_1_INTERVAL_MS: 30 * 1000,    // Active signals ($50k-$90k): 30 seconds
  TIER_2_INTERVAL_MS: 2 * 60 * 1000, // Candidates (approaching $50k): 2 minutes
  TIER_3_INTERVAL_MS: 5 * 60 * 1000, // Background (general scan): 5 minutes

  // Discovery interval
  DISCOVERY_INTERVAL_MS: 3 * 60 * 1000, // Discover new tokens every 3 minutes

  // Market cap thresholds
  MC_THRESHOLD_50K: 50000,
  MC_THRESHOLD_100K: 100000,
  MC_THRESHOLD_250K: 250000,
  MC_THRESHOLD_500K: 500000,
  MC_THRESHOLD_1M: 1000000,

  // Token expiry — stop tracking after 48 hours if no milestones hit
  MAX_TRACKING_DURATION_MS: 48 * 60 * 60 * 1000,
};

// Cache DexScreener pair responses for 30 seconds
const pairDataCache = new TTLCache<DexScreenerPairData[]>(500);
const PAIR_CACHE_TTL_MS = 30 * 1000;

// ============ CRAWLER CLASS ============

class TokenCrawler {
  private isRunning = false;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private trackedTokens: Map<string, TrackedToken> = new Map();

  /**
   * Initialize the crawler — load tracked tokens from DB
   */
  async initialize(): Promise<void> {
    logger.info('Initializing token crawler...');

    try {
      // Load tokens we're currently tracking from DB
      const result = await pool.query(`
        SELECT contract_address, pair_address, ticker, peak_mc, first_50k_timestamp, created_at
        FROM token_tracking
        WHERE first_50k_timestamp IS NOT NULL
          AND hit_100k = FALSE
          AND created_at > NOW() - INTERVAL '48 hours'
      `);

      for (const row of result.rows) {
        this.trackedTokens.set(row.contract_address, {
          contractAddress: row.contract_address,
          pairAddress: row.pair_address,
          ticker: row.ticker,
          marketCap: Number(row.peak_mc) || 50000,
          firstTrackedAt: new Date(row.created_at).getTime(),
          tier: this.classifyTier(Number(row.peak_mc) || 50000),
          lastPolled: 0,
        });
      }

      logger.info({ trackedCount: this.trackedTokens.size }, 'Token crawler initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize token crawler');
    }
  }

  /**
   * Start the crawler background service
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('Starting token crawler...');

    // Run discovery immediately, then on interval
    this.discoverNewTokens();
    this.discoveryTimer = setInterval(
      () => this.discoverNewTokens(),
      CRAWLER_CONFIG.DISCOVERY_INTERVAL_MS
    );

    // Run polling loop
    this.pollTrackedTokens();
    this.pollingTimer = setInterval(
      () => this.pollTrackedTokens(),
      CRAWLER_CONFIG.TIER_1_INTERVAL_MS // Use fastest interval, skip tokens not yet due
    );
  }

  /**
   * Stop the crawler
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.pollingTimer) clearInterval(this.pollingTimer);

    logger.info('Token crawler stopped');
  }

  /**
   * Discover new Solana tokens from DexScreener bulk endpoints
   */
  private async discoverNewTokens(): Promise<void> {
    try {
      // Source 1: Latest token profiles (bulk endpoint, efficient)
      const profiles = await this.fetchTokenProfiles();

      // Source 2: Boosted tokens (trending, bulk endpoint)
      const boosted = await this.fetchBoostedTokens();

      // Combine and deduplicate
      const allAddresses = new Set<string>();
      for (const addr of [...profiles, ...boosted]) {
        if (!this.trackedTokens.has(addr)) {
          allAddresses.add(addr);
        }
      }

      logger.info({
        profileCount: profiles.length,
        boostedCount: boosted.length,
        newTokens: allAddresses.size,
      }, 'Token discovery scan complete');

      // Fetch pair data for new tokens and check if MC >= $50k
      for (const address of allAddresses) {
        try {
          const pairs = await this.getTokenPairData(address);
          if (!pairs || pairs.length === 0) continue;

          const pair = pairs[0];
          const mc = pair.fdv || 0;

          if (mc >= CRAWLER_CONFIG.MC_THRESHOLD_50K) {
            await this.startTrackingToken(address, pair);
          }
        } catch (error) {
          logger.debug({ error, address: address.slice(0, 8) }, 'Failed to check token for tracking');
        }
      }
    } catch (error) {
      logger.error({ error }, 'Token discovery failed');
    }
  }

  /**
   * Fetch latest token profiles and boosted tokens from DexScreener
   * Uses the shared DexScreenerClient to coordinate rate limiting with signal-generator
   */
  private async fetchTokenProfiles(): Promise<string[]> {
    try {
      // Reuse the shared DexScreener client's getNewSolanaPairs (already rate-limited)
      const pairs = await dexScreenerClient.getNewSolanaPairs(50);
      return pairs
        .map((p: any) => p.tokenAddress || p.baseToken?.address)
        .filter(Boolean);
    } catch (error) {
      logger.debug({ error }, 'Failed to fetch token profiles');
      return [];
    }
  }

  /**
   * Fetch boosted/trending tokens from DexScreener
   * Uses the shared DexScreenerClient to coordinate rate limiting with signal-generator
   */
  private async fetchBoostedTokens(): Promise<string[]> {
    try {
      // Reuse the shared DexScreener client's getTrendingSolanaTokens (already rate-limited)
      return await dexScreenerClient.getTrendingSolanaTokens(50);
    } catch (error) {
      logger.debug({ error }, 'Failed to fetch boosted tokens');
      return [];
    }
  }

  /**
   * Get pair data for a specific token
   * Uses the shared DexScreenerClient which coordinates rate limiting system-wide
   */
  private async getTokenPairData(tokenAddress: string): Promise<DexScreenerPairData[] | null> {
    // Check cache
    const cached = pairDataCache.get(tokenAddress);
    if (cached) return cached;

    try {
      // Use shared client instead of separate rate limiter
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress) as unknown as DexScreenerPairData[];

      // Cache the result
      if (pairs && pairs.length > 0) {
        pairDataCache.set(tokenAddress, pairs, PAIR_CACHE_TTL_MS);
      }

      return pairs;
    } catch (error) {
      logger.debug({ error, address: tokenAddress.slice(0, 8) }, 'Failed to get token pair data');
      return null;
    }
  }

  /**
   * Start tracking a token that hit $50k MC
   */
  private async startTrackingToken(address: string, pair: DexScreenerPairData): Promise<void> {
    const mc = pair.fdv || 0;
    const ticker = pair.baseToken?.symbol || 'UNKNOWN';

    // Insert into DB
    try {
      await pool.query(
        `INSERT INTO token_tracking (
          contract_address, pair_address, ticker, deployer_wallet,
          launch_timestamp, first_50k_timestamp, mc_at_50k,
          volume_24h_at_50k, liquidity_at_50k, peak_mc, peak_mc_timestamp
        ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $6, NOW())
        ON CONFLICT (contract_address) DO UPDATE SET
          peak_mc = GREATEST(token_tracking.peak_mc, $6),
          peak_mc_timestamp = CASE WHEN $6 > token_tracking.peak_mc THEN NOW() ELSE token_tracking.peak_mc_timestamp END,
          updated_at = NOW()`,
        [
          address,
          pair.pairAddress || null,
          ticker,
          null, // deployer_wallet — populated by dev scorer
          pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null,
          mc,
          pair.volume?.h24 || 0,
          pair.liquidity?.usd || 0,
        ]
      );

      // Add to tracking map
      this.trackedTokens.set(address, {
        contractAddress: address,
        pairAddress: pair.pairAddress || null,
        ticker,
        marketCap: mc,
        firstTrackedAt: Date.now(),
        tier: this.classifyTier(mc),
        lastPolled: Date.now(),
      });

      logger.info({
        address: address.slice(0, 8),
        ticker,
        mc: mc.toLocaleString(),
        liquidity: pair.liquidity?.usd?.toLocaleString(),
      }, 'New token tracked at $50k+ MC');

      // Run RugCheck (fire and forget background task)
      this.runRugCheck(address);

      // Run dev scoring (fire and forget background task)
      this.runDevScoring(address);
    } catch (error) {
      logger.error({ error, address: address.slice(0, 8) }, 'Failed to insert tracked token');
    }
  }

  /**
   * Poll all tracked tokens for updated market data
   */
  private async pollTrackedTokens(): Promise<void> {
    const now = Date.now();
    const tokensToRemove: string[] = [];

    for (const [address, token] of this.trackedTokens) {
      // Check if token has exceeded tracking duration
      if (now - token.firstTrackedAt > CRAWLER_CONFIG.MAX_TRACKING_DURATION_MS) {
        tokensToRemove.push(address);
        continue;
      }

      // Check if it's time to poll this token based on tier
      const interval = this.getTierInterval(token.tier);
      if (now - token.lastPolled < interval) continue;

      try {
        const pairs = await this.getTokenPairData(address);
        if (!pairs || pairs.length === 0) continue;

        const pair = pairs[0];
        const currentMC = pair.fdv || 0;

        // Update market data
        token.marketCap = currentMC;
        token.lastPolled = now;
        token.tier = this.classifyTier(currentMC);

        // Update peak MC and milestone flags in DB
        await this.updateTokenMilestones(address, currentMC, pair);
      } catch (error) {
        logger.debug({ error, address: address.slice(0, 8) }, 'Failed to poll token');
      }
    }

    // Remove expired tokens
    for (const address of tokensToRemove) {
      this.trackedTokens.delete(address);
      logger.debug({ address: address.slice(0, 8) }, 'Token removed from tracking (expired)');
    }
  }

  /**
   * Update token milestones in the database
   */
  private async updateTokenMilestones(
    address: string,
    currentMC: number,
    pair: DexScreenerPairData
  ): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT peak_mc, first_50k_timestamp, hit_100k, hit_250k, hit_500k, hit_1m
         FROM token_tracking WHERE contract_address = $1`,
        [address]
      );

      if (result.rows.length === 0) return;

      const row = result.rows[0];
      const prevPeakMC = Number(row.peak_mc) || 0;
      const first50kTimestamp = row.first_50k_timestamp ? new Date(row.first_50k_timestamp) : null;

      const updates: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      // Update peak MC
      if (currentMC > prevPeakMC) {
        updates.push(`peak_mc = $${paramIdx}, peak_mc_timestamp = NOW()`);
        params.push(currentMC);
        paramIdx++;

        if (first50kTimestamp) {
          const minutesSince50k = Math.round((Date.now() - first50kTimestamp.getTime()) / 60000);
          updates.push(`time_50k_to_peak_minutes = $${paramIdx}`);
          params.push(minutesSince50k);
          paramIdx++;
        }
      }

      // Check milestone flags
      if (!row.hit_100k && currentMC >= CRAWLER_CONFIG.MC_THRESHOLD_100K) {
        updates.push(`hit_100k = TRUE`);
        if (first50kTimestamp) {
          const minutes = Math.round((Date.now() - first50kTimestamp.getTime()) / 60000);
          updates.push(`time_50k_to_100k_minutes = $${paramIdx}`);
          params.push(minutes);
          paramIdx++;
        }
        logger.info({ address: address.slice(0, 8), mc: currentMC }, 'Token hit $100k MC milestone');
      }

      if (!row.hit_250k && currentMC >= CRAWLER_CONFIG.MC_THRESHOLD_250K) {
        updates.push(`hit_250k = TRUE`);
        logger.info({ address: address.slice(0, 8), mc: currentMC }, 'Token hit $250k MC milestone');
      }

      if (!row.hit_500k && currentMC >= CRAWLER_CONFIG.MC_THRESHOLD_500K) {
        updates.push(`hit_500k = TRUE`);
      }

      if (!row.hit_1m && currentMC >= CRAWLER_CONFIG.MC_THRESHOLD_1M) {
        updates.push(`hit_1m = TRUE`);
        logger.info({ address: address.slice(0, 8), mc: currentMC }, 'Token hit $1M MC milestone!');
      }

      // Update holders count if available
      // DexScreener doesn't directly provide holder counts in pair data,
      // but we track it when first added

      if (updates.length > 0) {
        params.push(address);
        await pool.query(
          `UPDATE token_tracking SET ${updates.join(', ')}, updated_at = NOW()
           WHERE contract_address = $${paramIdx}`,
          params
        );
      }
    } catch (error) {
      logger.debug({ error, address: address.slice(0, 8) }, 'Failed to update milestones');
    }
  }

  /**
   * Run RugCheck on a token (background task)
   */
  private async runRugCheck(address: string): Promise<void> {
    try {
      const result = await rugCheckClient.checkToken(address);
      await rugCheckClient.storeResults(address, result);
    } catch (error) {
      logger.debug({ error, address: address.slice(0, 8) }, 'RugCheck background task failed');
    }
  }

  /**
   * Run dev scoring on a token (background task)
   */
  private async runDevScoring(address: string): Promise<void> {
    try {
      // First, try to get the deployer wallet from the token tracking table
      const result = await pool.query(
        `SELECT deployer_wallet FROM token_tracking WHERE contract_address = $1`,
        [address]
      );

      let deployerWallet = result.rows[0]?.deployer_wallet;

      // If no deployer wallet stored, try to discover it
      if (!deployerWallet) {
        deployerWallet = await devWalletScorer.discoverDeployer(address);
        if (deployerWallet) {
          await pool.query(
            `UPDATE token_tracking SET deployer_wallet = $1 WHERE contract_address = $2`,
            [deployerWallet, address]
          );
        }
      }

      if (!deployerWallet) {
        logger.debug({ address: address.slice(0, 8) }, 'Could not determine deployer wallet');
        return;
      }

      // Score the deployer wallet
      const devScore = await devWalletScorer.scoreDevWallet(deployerWallet);

      // Store dev score in token_tracking
      await pool.query(
        `UPDATE token_tracking SET
          dev_total_launches = $1,
          dev_launches_over_100k = $2,
          dev_score = $3
        WHERE contract_address = $4`,
        [devScore.totalLaunches, devScore.launchesOver100k, devScore.score, address]
      );
    } catch (error) {
      logger.debug({ error, address: address.slice(0, 8) }, 'Dev scoring background task failed');
    }
  }

  /**
   * Classify which polling tier a token belongs to
   */
  private classifyTier(marketCap: number): 'ACTIVE' | 'CANDIDATE' | 'BACKGROUND' {
    if (marketCap >= 50000 && marketCap < 90000) return 'ACTIVE';
    if (marketCap >= 30000 && marketCap < 50000) return 'CANDIDATE';
    return 'BACKGROUND';
  }

  /**
   * Get poll interval for a tier
   */
  private getTierInterval(tier: 'ACTIVE' | 'CANDIDATE' | 'BACKGROUND'): number {
    switch (tier) {
      case 'ACTIVE': return CRAWLER_CONFIG.TIER_1_INTERVAL_MS;
      case 'CANDIDATE': return CRAWLER_CONFIG.TIER_2_INTERVAL_MS;
      case 'BACKGROUND': return CRAWLER_CONFIG.TIER_3_INTERVAL_MS;
    }
  }

  /**
   * Get count of tracked tokens per tier
   */
  getTrackedStats(): { active: number; candidate: number; background: number; total: number } {
    let active = 0, candidate = 0, background = 0;
    for (const token of this.trackedTokens.values()) {
      switch (token.tier) {
        case 'ACTIVE': active++; break;
        case 'CANDIDATE': candidate++; break;
        case 'BACKGROUND': background++; break;
      }
    }
    return { active, candidate, background, total: this.trackedTokens.size };
  }
}

// ============ EXPORTS ============

export const tokenCrawler = new TokenCrawler();
