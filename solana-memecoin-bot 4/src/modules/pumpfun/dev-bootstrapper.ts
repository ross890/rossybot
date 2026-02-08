// ===========================================
// MODULE: PUMP.FUN DEV DATABASE BOOTSTRAPPER
// Populates the dev database by analyzing
// historical pump.fun launches to find devs
// with proven track records
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
    logger.warn('Solscan API key not configured — bootstrapper requires SOLSCAN_API_KEY');
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
      timeout: 15000,
    });

    return response.data;
  } catch (error: any) {
    if (error?.response?.status === 429) {
      logger.warn('Solscan rate limited during bootstrapping');
      // Wait and retry once
      await sleep(3000);
      try {
        const url = new URL(`${SOLSCAN_BASE}${path}`);
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
          }
        }
        const retryResponse = await axios.get(url.toString(), {
          headers: { 'token': apiKey },
          timeout: 15000,
        });
        return retryResponse.data;
      } catch {
        return null;
      }
    }
    logger.debug({ error: error?.message, path }, 'Solscan bootstrapper request failed');
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ DEXSCREENER HELPER ============

async function getDexScreenerTokenInfo(tokenMint: string): Promise<{
  marketCap: number;
  name: string;
  symbol: string;
} | null> {
  try {
    const response = await axios.get(
      `https://api.dexscreener.com/token-pairs/v1/solana/${tokenMint}`,
      { timeout: 8000 }
    );

    // New endpoint returns array directly instead of { pairs: [...] }
    const pairs = Array.isArray(response.data) ? response.data : (response.data?.pairs || []);
    if (!pairs || pairs.length === 0) return null;

    return {
      marketCap: pairs[0]?.fdv || 0,
      name: pairs[0]?.baseToken?.name || 'Unknown',
      symbol: pairs[0]?.baseToken?.symbol || 'UNKNOWN',
    };
  } catch {
    return null;
  }
}

// ============ BOOTSTRAPPER CLASS ============

export class DevBootstrapper {

  /**
   * Run the full bootstrapping process
   * Scans recent pump.fun tokens, identifies deployers, evaluates their history,
   * and seeds the database with qualified devs
   */
  async bootstrap(pages: number = 5): Promise<{
    tokensScanned: number;
    deployersFound: number;
    devsAdded: number;
  }> {
    logger.info({ pages }, 'Starting dev bootstrapper...');

    const stats = {
      tokensScanned: 0,
      deployersFound: 0,
      devsAdded: 0,
    };

    // Track deployers and their tokens
    const deployerTokens: Map<string, Array<{
      mint: string;
      name: string;
      symbol: string;
    }>> = new Map();

    // Step 1: Collect recent pump.fun tokens from Solscan
    for (let page = 1; page <= pages; page++) {
      logger.info({ page, totalPages: pages }, 'Fetching token page...');

      const tokensData = await solscanGet('/token/list', {
        sort_by: 'created_time',
        sort_order: 'desc',
        page_size: '100',
        page: String(page),
      });

      if (!tokensData?.data || tokensData.data.length === 0) {
        logger.info({ page }, 'No more tokens found');
        break;
      }

      for (const token of tokensData.data) {
        stats.tokensScanned++;
        const creator = token.creator || token.deployer;
        if (!creator) continue;

        const existing = deployerTokens.get(creator) || [];
        existing.push({
          mint: token.token_address || token.address,
          name: token.name || 'Unknown',
          symbol: token.symbol || 'UNKNOWN',
        });
        deployerTokens.set(creator, existing);
      }

      // Rate limit between pages
      await sleep(1000);
    }

    stats.deployersFound = deployerTokens.size;
    logger.info({
      tokensScanned: stats.tokensScanned,
      uniqueDeployers: stats.deployersFound,
    }, 'Token scan complete, evaluating deployers...');

    // Step 2: Evaluate each deployer with multiple tokens
    const config = appConfig.devTracker;

    for (const [deployer, tokens] of deployerTokens) {
      // Skip deployers with too few tokens
      if (tokens.length < config.minLaunches) continue;

      // Skip already tracked
      const existing = await pool.query(
        'SELECT id FROM pumpfun_devs WHERE wallet_address = $1',
        [deployer]
      );
      if (existing.rows.length > 0) continue;

      // Evaluate token performance via DexScreener
      let successCount = 0;
      let bestPeakMc = 0;
      let totalMc = 0;
      let checkedCount = 0;

      for (const token of tokens.slice(0, 15)) { // Limit API calls
        const info = await getDexScreenerTokenInfo(token.mint);
        if (info) {
          checkedCount++;
          if (info.marketCap >= 200_000) successCount++;
          if (info.marketCap > bestPeakMc) bestPeakMc = info.marketCap;
          totalMc += info.marketCap;
        }
        await sleep(300); // DexScreener rate limit
      }

      if (checkedCount === 0) continue;

      const successRate = successCount / checkedCount;
      const avgPeakMc = totalMc / checkedCount;

      // Apply qualification criteria
      if (successRate < config.minSuccessRate) continue;
      if (bestPeakMc < config.minBestPeakMc) continue;

      // Add qualified dev
      try {
        await pool.query(
          `INSERT INTO pumpfun_devs (
             wallet_address, total_launches, successful_launches,
             best_peak_mc, avg_peak_mc, success_rate, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, 'Bootstrapped from historical scan')
           ON CONFLICT (wallet_address) DO UPDATE SET
             total_launches = GREATEST(pumpfun_devs.total_launches, $2),
             successful_launches = GREATEST(pumpfun_devs.successful_launches, $3),
             best_peak_mc = GREATEST(pumpfun_devs.best_peak_mc, $4),
             avg_peak_mc = $5,
             success_rate = $6,
             updated_at = NOW()`,
          [deployer, checkedCount, successCount, bestPeakMc, avgPeakMc, successRate]
        );

        stats.devsAdded++;

        // Also record the tokens we found
        for (const token of tokens) {
          const devResult = await pool.query(
            'SELECT id FROM pumpfun_devs WHERE wallet_address = $1',
            [deployer]
          );
          if (devResult.rows.length > 0) {
            await pool.query(
              `INSERT INTO pumpfun_dev_tokens (dev_id, token_mint, token_name, token_symbol, platform)
               VALUES ($1, $2, $3, $4, 'pumpfun')
               ON CONFLICT DO NOTHING`,
              [devResult.rows[0].id, token.mint, token.name, token.symbol]
            );
          }
        }

        logger.info({
          deployer: deployer.slice(0, 8) + '...',
          tokens: checkedCount,
          successRate: (successRate * 100).toFixed(1) + '%',
          bestPeakMc,
        }, 'Qualified dev added to database');
      } catch (error) {
        logger.error({ error, deployer }, 'Failed to insert bootstrapped dev');
      }
    }

    logger.info(stats, 'Dev bootstrapper complete');
    return stats;
  }

  /**
   * Manually add a dev wallet (used by /adddev Telegram command)
   * Optionally scan their history to populate token records
   */
  async addDevManually(
    walletAddress: string,
    alias?: string,
    scanHistory: boolean = true,
  ): Promise<{ success: boolean; dev?: any; message: string }> {
    try {
      // Insert or update dev record
      const result = await pool.query(
        `INSERT INTO pumpfun_devs (wallet_address, alias, notes)
         VALUES ($1, $2, 'Manually added')
         ON CONFLICT (wallet_address) DO UPDATE SET
           alias = COALESCE($2, pumpfun_devs.alias),
           is_active = true,
           updated_at = NOW()
         RETURNING *`,
        [walletAddress, alias || null]
      );

      const dev = result.rows[0];

      if (scanHistory) {
        // Scan deployer's token history in background
        this.scanDevHistory(dev.id, walletAddress).catch(error => {
          logger.error({ error, walletAddress }, 'Failed to scan dev history');
        });
      }

      return {
        success: true,
        dev,
        message: `Dev wallet ${walletAddress.slice(0, 8)}... added to tracking${scanHistory ? ' (scanning history...)' : ''}`,
      };
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to manually add dev');
      return {
        success: false,
        message: `Failed to add dev wallet: ${error}`,
      };
    }
  }

  /**
   * Scan a dev's historical token launches and populate the database
   */
  private async scanDevHistory(devId: number, walletAddress: string): Promise<void> {
    logger.info({ walletAddress }, 'Scanning dev history...');

    try {
      // Use Solscan to get the deployer's token creation history
      const activities = await solscanGet('/account/defi/activities', {
        address: walletAddress,
        page_size: '50',
        page: '1',
      });

      if (!activities?.data) {
        logger.debug({ walletAddress }, 'No activities found for dev');
        return;
      }

      let tokensFound = 0;

      for (const activity of activities.data) {
        // Look for token creation/minting activities
        const tokenMint = activity.token_address || activity.token1;
        if (!tokenMint) continue;

        // Get token info from DexScreener
        const tokenInfo = await getDexScreenerTokenInfo(tokenMint);
        const mc = tokenInfo?.marketCap || 0;

        try {
          await pool.query(
            `INSERT INTO pumpfun_dev_tokens (
               dev_id, token_mint, token_name, token_symbol,
               peak_mc, current_mc, hit_200k, hit_1m, platform
             ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'pumpfun')
             ON CONFLICT DO NOTHING`,
            [
              devId,
              tokenMint,
              tokenInfo?.name || 'Unknown',
              tokenInfo?.symbol || 'UNKNOWN',
              mc,
              mc >= 200_000,
              mc >= 1_000_000,
            ]
          );
          tokensFound++;
        } catch {
          // Skip duplicate tokens
        }

        await sleep(300);
      }

      // Recalculate dev stats
      const { devStatsUpdater } = await import('./dev-stats-updater.js');
      await devStatsUpdater.recalculateDevStats(devId);

      logger.info({ walletAddress, tokensFound }, 'Dev history scan complete');
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to scan dev history');
    }
  }
}

// ============ EXPORTS ============

export const devBootstrapper = new DevBootstrapper();
