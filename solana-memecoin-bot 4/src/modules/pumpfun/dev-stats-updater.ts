// ===========================================
// MODULE: PUMP.FUN DEV STATS UPDATER
// Periodic job that updates dev statistics
// and discovers new high-performing devs
// ===========================================

import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import axios from 'axios';

// ============ SOLSCAN CLIENT ============

const SOLSCAN_BASE = 'https://pro-api.solscan.io/v2.0';

async function solscanGet(path: string, params?: Record<string, string>): Promise<any> {
  const apiKey = appConfig.solscanApiKey;
  if (!apiKey) {
    logger.debug('Solscan API key not configured — skipping request');
    return null;
  }

  try {
    const url = new URL(`${SOLSCAN_BASE}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await axios.get(url.toString(), {
      headers: { 'token': apiKey },
      timeout: 10000,
    });

    return response.data;
  } catch (error: any) {
    if (error?.response?.status === 429) {
      logger.warn('Solscan rate limited');
    } else {
      logger.debug({ error: error?.message, path }, 'Solscan request failed');
    }
    return null;
  }
}

// ============ DEXSCREENER HELPER ============

async function getDexScreenerMC(tokenMint: string): Promise<number | null> {
  try {
    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
      { timeout: 8000 }
    );

    const pairs = response.data?.pairs;
    if (!pairs || pairs.length === 0) return null;

    // Return the FDV (fully diluted valuation) as market cap
    return pairs[0]?.fdv || null;
  } catch (error) {
    logger.debug({ error, tokenMint }, 'DexScreener MC lookup failed');
    return null;
  }
}

// ============ DEV STATS UPDATER CLASS ============

export class DevStatsUpdater {
  private statsTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Start periodic stat updates and dev discovery
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const statsInterval = appConfig.devTracker.statsUpdateIntervalMs;
    const discoveryInterval = appConfig.devTracker.discoveryIntervalMs;

    // Stats update every 30 minutes
    this.statsTimer = setInterval(() => this.updateStats(), statsInterval);

    // Dev discovery every 24 hours
    this.discoveryTimer = setInterval(() => this.discoverNewDevs(), discoveryInterval);

    // Run initial stats update after a brief delay
    setTimeout(() => this.updateStats(), 60 * 1000);

    logger.info({
      statsIntervalMinutes: statsInterval / 60000,
      discoveryIntervalHours: discoveryInterval / 3600000,
    }, 'Dev Stats Updater started');
  }

  /**
   * Stop periodic jobs
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    logger.info('Dev Stats Updater stopped');
  }

  // ============ STATS UPDATE ============

  /**
   * Update peak MC for all tokens launched by tracked devs in last 7 days
   * Recalculate dev success rates
   */
  async updateStats(): Promise<void> {
    logger.info('Running dev stats update...');

    try {
      // 1. Get all dev tokens launched in last 7 days
      const recentTokens = await pool.query(
        `SELECT dt.id, dt.token_mint, dt.dev_id, dt.peak_mc, dt.hit_200k, dt.hit_1m
         FROM pumpfun_dev_tokens dt
         JOIN pumpfun_devs d ON d.id = dt.dev_id
         WHERE dt.launched_at > NOW() - INTERVAL '7 days'
         AND d.is_active = true`
      );

      let updatedCount = 0;

      // 2. For each token, fetch current/peak MC
      for (const token of recentTokens.rows) {
        try {
          const currentMc = await this.getTokenMarketCap(token.token_mint);
          if (currentMc === null) continue;

          const currentPeakMc = parseFloat(token.peak_mc || '0');
          const newPeakMc = Math.max(currentPeakMc, currentMc);
          const hit200k = newPeakMc >= 200_000;
          const hit1m = newPeakMc >= 1_000_000;

          // Update token record
          await pool.query(
            `UPDATE pumpfun_dev_tokens SET
               current_mc = $2,
               peak_mc = $3,
               hit_200k = $4,
               hit_1m = $5,
               updated_at = NOW()
             WHERE id = $1`,
            [token.id, currentMc, newPeakMc, hit200k, hit1m]
          );

          updatedCount++;

          // Brief pause to avoid rate limiting
          await this.sleep(200);
        } catch (error) {
          logger.debug({ error, tokenMint: token.token_mint }, 'Failed to update token MC');
        }
      }

      // 3. Recalculate dev stats for all active devs
      await this.recalculateAllDevStats();

      logger.info({ updatedTokens: updatedCount }, 'Dev stats update complete');
    } catch (error) {
      logger.error({ error }, 'Dev stats update failed');
    }
  }

  /**
   * Get current market cap for a token using DexScreener + Solscan fallback
   */
  private async getTokenMarketCap(tokenMint: string): Promise<number | null> {
    // Try DexScreener first (free, no key needed)
    const dexMc = await getDexScreenerMC(tokenMint);
    if (dexMc !== null && dexMc > 0) return dexMc;

    // Fallback: Solscan token meta
    const solscanData = await solscanGet('/token/meta', { address: tokenMint });
    if (solscanData?.data?.market_cap) {
      return solscanData.data.market_cap;
    }

    return null;
  }

  /**
   * Recalculate statistics for all active devs
   */
  private async recalculateAllDevStats(): Promise<void> {
    try {
      const devs = await pool.query(
        'SELECT id, wallet_address FROM pumpfun_devs WHERE is_active = true'
      );

      for (const dev of devs.rows) {
        await this.recalculateDevStats(dev.id);
      }

      logger.info({ devCount: devs.rows.length }, 'Recalculated stats for all active devs');
    } catch (error) {
      logger.error({ error }, 'Failed to recalculate dev stats');
    }
  }

  /**
   * Recalculate statistics for a single dev
   */
  async recalculateDevStats(devId: number): Promise<void> {
    try {
      // Get aggregate stats from tokens table
      const stats = await pool.query(
        `SELECT
           COUNT(*) as total_launches,
           COUNT(*) FILTER (WHERE hit_200k = true) as successful_launches,
           MAX(peak_mc) as best_peak_mc,
           AVG(NULLIF(peak_mc, 0)) as avg_peak_mc,
           COUNT(*) FILTER (WHERE is_rugged = true) as rug_count
         FROM pumpfun_dev_tokens
         WHERE dev_id = $1`,
        [devId]
      );

      const row = stats.rows[0];
      const totalLaunches = parseInt(row.total_launches || '0');
      const successfulLaunches = parseInt(row.successful_launches || '0');
      const successRate = totalLaunches > 0 ? successfulLaunches / totalLaunches : 0;

      await pool.query(
        `UPDATE pumpfun_devs SET
           total_launches = $2,
           successful_launches = $3,
           best_peak_mc = $4,
           avg_peak_mc = $5,
           rug_count = $6,
           success_rate = $7,
           updated_at = NOW()
         WHERE id = $1`,
        [
          devId,
          totalLaunches,
          successfulLaunches,
          parseFloat(row.best_peak_mc || '0'),
          parseFloat(row.avg_peak_mc || '0'),
          parseInt(row.rug_count || '0'),
          successRate,
        ]
      );
    } catch (error) {
      logger.error({ error, devId }, 'Failed to recalculate dev stats');
    }
  }

  // ============ DEV DISCOVERY ============

  /**
   * Scan for NEW high-performing devs to add to tracking
   * Uses Solscan to find recent pump.fun launches and group by deployer
   */
  async discoverNewDevs(): Promise<string[]> {
    logger.info('Running dev discovery scan...');
    const discovered: string[] = [];

    try {
      // 1. Get recent pump.fun launches from Solscan
      const tokensData = await solscanGet('/token/list', {
        sort_by: 'created_time',
        sort_order: 'desc',
        page_size: '100',
        page: '1',
      });

      if (!tokensData?.data) {
        logger.debug('No token data from Solscan for dev discovery');
        return [];
      }

      // 2. Group tokens by deployer (creator) wallet
      const deployerTokens: Map<string, string[]> = new Map();

      for (const token of tokensData.data) {
        const creator = token.creator || token.deployer;
        if (!creator) continue;

        const existing = deployerTokens.get(creator) || [];
        existing.push(token.token_address || token.address);
        deployerTokens.set(creator, existing);
      }

      // 3. For deployers with multiple tokens that aren't already tracked, evaluate them
      for (const [deployer, tokens] of deployerTokens) {
        // Skip already tracked
        const existingDev = await pool.query(
          'SELECT id FROM pumpfun_devs WHERE wallet_address = $1',
          [deployer]
        );
        if (existingDev.rows.length > 0) continue;

        // Need at least a few tokens to evaluate
        if (tokens.length < 3) continue;

        // Check if deployer qualifies based on historical token performance
        const qualified = await this.evaluateDeployerQualification(deployer, tokens);
        if (qualified) {
          discovered.push(deployer);
          logger.info({ deployer, tokenCount: tokens.length }, 'New qualified dev discovered');
        }

        // Rate limit
        await this.sleep(500);
      }

      logger.info({ discoveredCount: discovered.length }, 'Dev discovery scan complete');
    } catch (error) {
      logger.error({ error }, 'Dev discovery scan failed');
    }

    return discovered;
  }

  /**
   * Evaluate whether a deployer meets qualification criteria
   */
  private async evaluateDeployerQualification(
    deployer: string,
    tokenMints: string[],
  ): Promise<boolean> {
    const config = appConfig.devTracker;
    let successCount = 0;
    let bestPeakMc = 0;

    // Check market caps for known tokens
    for (const mint of tokenMints.slice(0, 10)) { // Limit to 10 to save API calls
      const mc = await getDexScreenerMC(mint);
      if (mc !== null) {
        if (mc >= 200_000) successCount++;
        if (mc > bestPeakMc) bestPeakMc = mc;
      }
      await this.sleep(300);
    }

    const totalChecked = Math.min(tokenMints.length, 10);
    const successRate = totalChecked > 0 ? successCount / totalChecked : 0;

    // Apply qualification thresholds
    if (totalChecked < config.minLaunches) return false;
    if (successRate < config.minSuccessRate) return false;
    if (bestPeakMc < config.minBestPeakMc) return false;

    // Auto-add qualified dev
    try {
      await pool.query(
        `INSERT INTO pumpfun_devs (wallet_address, total_launches, successful_launches, best_peak_mc, success_rate, notes)
         VALUES ($1, $2, $3, $4, $5, 'Auto-discovered by dev scanner')
         ON CONFLICT (wallet_address) DO NOTHING`,
        [deployer, totalChecked, successCount, bestPeakMc, successRate]
      );
    } catch (error) {
      logger.error({ error, deployer }, 'Failed to insert discovered dev');
    }

    return true;
  }

  // ============ HELPERS ============

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============ EXPORTS ============

export const devStatsUpdater = new DevStatsUpdater();
