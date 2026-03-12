// ===========================================
// MODULE: DYNAMIC WALLET DISCOVERY
// Auto-discovers smart money wallets from two sources:
// 1. Winner backtracking — scrape early buyers from winning signals
// 2. GeckoTerminal trending pool trades — free smart money wallet feed
//
// Creates a self-improving flywheel:
// Good signals → discover early buyers → track them → better signals
// ===========================================

import { Database } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { heliusClient } from '../onchain.js';
import { smartMoneyScanner, DiscoverySource } from './smart-money-scanner.js';
import { appConfig } from '../../config/index.js';

// ============ CONFIGURATION ============

const DISCOVERY_CONFIG = {
  // Winner backtracking
  BACKTRACK_INTERVAL_MS: 60 * 60 * 1000,   // Run every hour
  MIN_RETURN_FOR_BACKTRACK: 100,            // Only backtrack 2x+ winners
  MAX_EARLY_BUYERS_PER_TOKEN: 20,           // Cap wallets scraped per winner
  EARLY_BUYER_WINDOW_BLOCKS: 50,            // First ~50 blocks of trading
  MIN_BUY_SIZE_SOL: 0.5,                    // Skip dust buys
  MAX_BACKTRACK_WINNERS: 10,                // Process up to 10 winners per cycle

  // GeckoTerminal trending trader discovery
  GECKO_INTERVAL_MS: 2 * 60 * 60 * 1000,   // Every 2 hours
  GECKO_MAX_POOLS: 10,                      // Scan top 10 trending pools per cycle
  GECKO_MIN_APPEARANCES: 2,                 // Wallet must appear in 2+ pools to be interesting

  // Dedup
  PROCESSED_WINNERS_TTL_MS: 7 * 24 * 60 * 60 * 1000, // Remember processed winners for 7 days
};

// ============ GECKO TERMINAL WALLET DISCOVERY ============

const GECKO_API_BASE = 'https://api.geckoterminal.com/api/v2';

interface GeckoTrade {
  tx_from_address: string;
  tx_hash: string;
  kind: 'buy' | 'sell';
  volume_in_usd: string;
  from_token_amount: string;
  to_token_amount: string;
  block_timestamp: string;
}

interface GeckoPoolData {
  id: string;
  attributes: {
    address: string;
    name: string;
    base_token_price_usd: string;
    volume_usd: { h24: string };
  };
}

/**
 * Fetch trending Solana pool addresses from GeckoTerminal
 */
async function fetchGeckoTrendingPools(limit: number = 10): Promise<string[]> {
  try {
    const response = await fetch(
      `${GECKO_API_BASE}/networks/solana/trending_pools?page=1`,
      {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!response.ok) {
      logger.debug({ status: response.status }, 'GeckoTerminal trending pools API non-OK');
      return [];
    }

    const json = await response.json() as { data?: GeckoPoolData[] };
    if (!json.data || !Array.isArray(json.data)) return [];

    return json.data
      .slice(0, limit)
      .map(pool => pool.attributes.address)
      .filter(addr => addr && addr.length > 20);
  } catch (error) {
    logger.debug({ error }, 'GeckoTerminal trending pools fetch failed');
    return [];
  }
}

/**
 * Fetch recent trades for a specific pool from GeckoTerminal
 * Returns wallet addresses with trade details
 */
async function fetchGeckoPoolTrades(poolAddress: string): Promise<Array<{
  walletAddress: string;
  kind: 'buy' | 'sell';
  volumeUsd: number;
  txHash: string;
}>> {
  try {
    const response = await fetch(
      `${GECKO_API_BASE}/networks/solana/pools/${poolAddress}/trades`,
      {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!response.ok) {
      logger.debug({ status: response.status, pool: poolAddress.slice(0, 8) }, 'GeckoTerminal pool trades API non-OK');
      return [];
    }

    const json = await response.json() as { data?: Array<{ attributes: any }> };
    if (!json.data || !Array.isArray(json.data)) return [];

    return json.data
      .filter(trade => trade.attributes?.tx_from_address)
      .map(trade => ({
        walletAddress: trade.attributes.tx_from_address,
        kind: trade.attributes.kind || 'buy',
        volumeUsd: parseFloat(trade.attributes.volume_in_usd || '0'),
        txHash: trade.attributes.tx_hash || '',
      }));
  } catch (error) {
    logger.debug({ error, pool: poolAddress.slice(0, 8) }, 'GeckoTerminal pool trades fetch failed');
    return [];
  }
}

/**
 * Discover active traders across trending pools.
 * Wallets that appear in multiple trending pools are likely smart money.
 * Returns deduplicated wallet addresses with trade counts.
 */
async function discoverActiveTraders(maxPools: number = 10): Promise<Array<{
  address: string;
  poolCount: number;
  totalTrades: number;
  totalVolumeUsd: number;
  buyCount: number;
}>> {
  const poolAddresses = await fetchGeckoTrendingPools(maxPools);
  if (poolAddresses.length === 0) return [];

  // Aggregate trades per wallet across pools
  const walletStats: Map<string, {
    pools: Set<string>;
    totalTrades: number;
    totalVolumeUsd: number;
    buyCount: number;
  }> = new Map();

  for (const poolAddr of poolAddresses) {
    try {
      const trades = await fetchGeckoPoolTrades(poolAddr);

      for (const trade of trades) {
        if (!trade.walletAddress || trade.walletAddress.length < 32) continue;

        const existing = walletStats.get(trade.walletAddress);
        if (existing) {
          existing.pools.add(poolAddr);
          existing.totalTrades++;
          existing.totalVolumeUsd += trade.volumeUsd;
          if (trade.kind === 'buy') existing.buyCount++;
        } else {
          walletStats.set(trade.walletAddress, {
            pools: new Set([poolAddr]),
            totalTrades: 1,
            totalVolumeUsd: trade.volumeUsd,
            buyCount: trade.kind === 'buy' ? 1 : 0,
          });
        }
      }

      // Rate limit: GeckoTerminal allows 30 req/min, so ~2s between calls
      await new Promise(resolve => setTimeout(resolve, 2500));
    } catch (error) {
      logger.debug({ error, pool: poolAddr.slice(0, 8) }, 'Error fetching pool trades');
    }
  }

  // Filter to wallets active in multiple pools (likely smart money, not random traders)
  const results: Array<{
    address: string;
    poolCount: number;
    totalTrades: number;
    totalVolumeUsd: number;
    buyCount: number;
  }> = [];

  for (const [address, stats] of walletStats) {
    if (stats.pools.size >= DISCOVERY_CONFIG.GECKO_MIN_APPEARANCES) {
      results.push({
        address,
        poolCount: stats.pools.size,
        totalTrades: stats.totalTrades,
        totalVolumeUsd: stats.totalVolumeUsd,
        buyCount: stats.buyCount,
      });
    }
  }

  // Sort by pool count (most active across pools first), then by volume
  return results.sort((a, b) =>
    b.poolCount - a.poolCount || b.totalVolumeUsd - a.totalVolumeUsd
  );
}

// ============ WALLET DISCOVERY ENGINE ============

export class WalletDiscoveryEngine {
  private isRunning = false;
  private backtrackTimer: NodeJS.Timeout | null = null;
  private geckoTimer: NodeJS.Timeout | null = null;

  // Track which winning signals we've already backtracked
  private processedWinners: Map<string, number> = new Map(); // signalId -> timestamp

  /**
   * Start the wallet discovery engine
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Winner backtracking — run hourly
    this.backtrackTimer = setInterval(
      () => this.runWinnerBacktracking(),
      DISCOVERY_CONFIG.BACKTRACK_INTERVAL_MS
    );

    // GeckoTerminal trending trader discovery — run every 2 hours
    this.geckoTimer = setInterval(
      () => this.runGeckoDiscovery(),
      DISCOVERY_CONFIG.GECKO_INTERVAL_MS
    );

    // Run initial GeckoTerminal scan after 2 minutes (let other systems boot first)
    setTimeout(() => this.runGeckoDiscovery(), 2 * 60 * 1000);

    // Run initial backtrack after 5 minutes
    setTimeout(() => this.runWinnerBacktracking(), 5 * 60 * 1000);

    logger.info('Wallet Discovery Engine started (backtrack: 1h, GeckoTerminal: 2h)');
  }

  /**
   * Stop the engine
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.backtrackTimer) {
      clearInterval(this.backtrackTimer);
      this.backtrackTimer = null;
    }
    if (this.geckoTimer) {
      clearInterval(this.geckoTimer);
      this.geckoTimer = null;
    }

    logger.info('Wallet Discovery Engine stopped');
  }

  // ============ WINNER BACKTRACKING ============

  /**
   * Find winning signals, scrape early buyers, feed into smart money pipeline
   * This creates the flywheel: good signals → discover smart wallets → better signals
   */
  private async runWinnerBacktracking(): Promise<void> {
    try {
      // Skip when Helius is disabled
      if (appConfig.heliusDisabled) {
        return;
      }

      // Get recent winning signals (2x+) from performance tracker
      const winners = await this.getRecentWinners();

      if (winners.length === 0) {
        logger.debug('Winner backtrack: no new winners to process');
        return;
      }

      let totalWalletsDiscovered = 0;

      for (const winner of winners.slice(0, DISCOVERY_CONFIG.MAX_BACKTRACK_WINNERS)) {
        // Skip if already processed
        if (this.processedWinners.has(winner.signalId)) continue;

        try {
          const discovered = await this.backtrackWinner(winner);
          totalWalletsDiscovered += discovered;
          this.processedWinners.set(winner.signalId, Date.now());
        } catch (error) {
          logger.debug({ error, token: winner.tokenAddress.slice(0, 8) }, 'Error backtracking winner');
        }
      }

      // Cleanup old processed entries
      this.cleanupProcessedWinners();

      if (totalWalletsDiscovered > 0) {
        logger.info({
          winnersProcessed: Math.min(winners.length, DISCOVERY_CONFIG.MAX_BACKTRACK_WINNERS),
          walletsDiscovered: totalWalletsDiscovered,
        }, 'Winner backtrack cycle complete — new wallets fed into pipeline');
      }
    } catch (error) {
      logger.error({ error }, 'Error in winner backtracking cycle');
    }
  }

  /**
   * Get recent winning signals that haven't been backtracked yet
   */
  private async getRecentWinners(): Promise<Array<{
    signalId: string;
    tokenAddress: string;
    tokenTicker: string;
    finalReturn: number;
    signalTime: Date;
  }>> {
    try {
      const { pool } = await import('../../utils/database.js');
      const result = await pool.query(`
        SELECT signal_id, token_address, token_ticker, final_return, signal_time
        FROM signal_performance
        WHERE final_outcome = 'WIN'
          AND final_return >= $1
          AND signal_time > NOW() - INTERVAL '7 days'
        ORDER BY final_return DESC
        LIMIT $2
      `, [
        DISCOVERY_CONFIG.MIN_RETURN_FOR_BACKTRACK,
        DISCOVERY_CONFIG.MAX_BACKTRACK_WINNERS * 2, // Fetch extras in case some already processed
      ]);

      return result.rows.map((row: any) => ({
        signalId: row.signal_id,
        tokenAddress: row.token_address,
        tokenTicker: row.token_ticker,
        finalReturn: row.final_return,
        signalTime: new Date(row.signal_time),
      }));
    } catch (error) {
      logger.debug({ error }, 'Failed to fetch recent winners');
      return [];
    }
  }

  /**
   * Backtrack a winning signal — find early buyers and add as smart money candidates
   */
  private async backtrackWinner(winner: {
    signalId: string;
    tokenAddress: string;
    tokenTicker: string;
    finalReturn: number;
    signalTime: Date;
  }): Promise<number> {
    // Get the earliest transactions for this token
    const txs = await heliusClient.getRecentTransactions(winner.tokenAddress, 100);

    if (txs.length === 0) return 0;

    // Sort by blockTime ascending to find earliest buyers
    const sortedTxs = txs
      .filter((tx: any) => tx.blockTime)
      .sort((a: any, b: any) => a.blockTime - b.blockTime);

    // Take only early transactions
    const earlyTxs = sortedTxs.slice(0, DISCOVERY_CONFIG.EARLY_BUYER_WINDOW_BLOCKS);

    const discoveredWallets: Set<string> = new Set();
    let walletsAdded = 0;

    for (const tx of earlyTxs) {
      if (discoveredWallets.size >= DISCOVERY_CONFIG.MAX_EARLY_BUYERS_PER_TOKEN) break;

      try {
        const txDetails = await heliusClient.getTransaction(tx.signature);
        if (!txDetails) continue;

        // Find buyers in this transaction
        const buyers = this.extractBuyers(txDetails, winner.tokenAddress);

        for (const buyer of buyers) {
          if (discoveredWallets.has(buyer.address)) continue;
          if (buyer.solAmount < DISCOVERY_CONFIG.MIN_BUY_SIZE_SOL) continue;

          discoveredWallets.add(buyer.address);

          // Feed into smart money scanner as a trade observation
          await smartMoneyScanner.observeTrade({
            walletAddress: buyer.address,
            tokenAddress: winner.tokenAddress,
            tokenTicker: winner.tokenTicker,
            tradeType: 'BUY',
            solAmount: buyer.solAmount,
            tokenAmount: buyer.tokenAmount,
            priceAtTrade: buyer.solAmount / buyer.tokenAmount,
            txSignature: tx.signature,
            blockTime: new Date(tx.blockTime * 1000),
          });

          walletsAdded++;
        }
      } catch (error) {
        // Skip individual tx parsing errors
      }
    }

    if (walletsAdded > 0) {
      logger.info({
        token: winner.tokenTicker,
        tokenReturn: `${winner.finalReturn.toFixed(0)}%`,
        earlyBuyers: walletsAdded,
      }, 'Winner backtracked — early buyers fed into smart money pipeline');
    }

    return walletsAdded;
  }

  /**
   * Extract buyer wallet addresses from a transaction
   */
  private extractBuyers(txDetails: any, tokenAddress: string): Array<{
    address: string;
    solAmount: number;
    tokenAmount: number;
  }> {
    const buyers: Array<{
      address: string;
      solAmount: number;
      tokenAmount: number;
    }> = [];

    try {
      const preBalances = txDetails.meta?.preTokenBalances || [];
      const postBalances = txDetails.meta?.postTokenBalances || [];
      const accountKeys = txDetails.transaction?.message?.accountKeys || [];

      for (const postBalance of postBalances) {
        if (postBalance.mint !== tokenAddress) continue;

        const owner = postBalance.owner;
        if (!owner) continue;

        const preBalance = preBalances.find(
          (pb: any) => pb.mint === tokenAddress && pb.owner === owner
        );

        const preBal = preBalance?.uiTokenAmount?.uiAmount || 0;
        const postBal = postBalance.uiTokenAmount?.uiAmount || 0;
        const tokenChange = postBal - preBal;

        if (tokenChange <= 0) continue; // Not a buy

        // Check SOL spent
        const walletIndex = accountKeys.findIndex((k: any) =>
          (typeof k === 'string' ? k : k.pubkey) === owner
        );

        if (walletIndex < 0) continue;

        const preSol = (txDetails.meta?.preBalances?.[walletIndex] || 0) / 1e9;
        const postSol = (txDetails.meta?.postBalances?.[walletIndex] || 0) / 1e9;
        const solSpent = preSol - postSol;

        if (solSpent <= 0) continue;

        buyers.push({
          address: owner,
          solAmount: solSpent,
          tokenAmount: tokenChange,
        });
      }
    } catch (error) {
      // Skip parse errors
    }

    return buyers;
  }

  /**
   * Clean up old processed winner entries
   */
  private cleanupProcessedWinners(): void {
    const now = Date.now();
    for (const [signalId, timestamp] of this.processedWinners) {
      if (now - timestamp > DISCOVERY_CONFIG.PROCESSED_WINNERS_TTL_MS) {
        this.processedWinners.delete(signalId);
      }
    }
  }

  // ============ GECKO TERMINAL TRENDING TRADER DISCOVERY ============

  /**
   * Discover active traders from GeckoTerminal trending pools.
   * Wallets trading across multiple trending pools are likely smart money.
   * Free API, no key required, 30 req/min rate limit.
   */
  private async runGeckoDiscovery(): Promise<void> {
    try {
      const activeTraders = await discoverActiveTraders(DISCOVERY_CONFIG.GECKO_MAX_POOLS);

      if (activeTraders.length === 0) {
        logger.debug('GeckoTerminal discovery: no multi-pool traders found');
        return;
      }

      let newCandidates = 0;
      let alreadyTracked = 0;

      for (const trader of activeTraders) {
        try {
          // Skip if already tracked as KOL or alpha wallet
          const isKol = await Database.getWalletByAddress(trader.address);
          const isAlpha = await Database.isAlphaWalletTracked(trader.address);
          const isCandidate = await Database.isSmartMoneyCandidate(trader.address);

          if (isKol || isAlpha || isCandidate) {
            alreadyTracked++;
            continue;
          }

          const reason = `GeckoTerminal: active in ${trader.poolCount} trending pools, ${trader.totalTrades} trades, $${trader.totalVolumeUsd.toFixed(0)} volume`;

          await Database.createSmartMoneyCandidate(
            trader.address,
            DiscoverySource.HIGH_WIN_RATE,
            reason
          );

          newCandidates++;
        } catch (error) {
          // Skip individual wallet errors
        }
      }

      if (newCandidates > 0) {
        logger.info({
          tradersFound: activeTraders.length,
          newCandidates,
          alreadyTracked,
        }, 'GeckoTerminal trader discovery complete — new candidates added');
      } else {
        logger.debug({
          tradersFound: activeTraders.length,
          alreadyTracked,
        }, 'GeckoTerminal discovery: all traders already tracked');
      }
    } catch (error) {
      logger.error({ error }, 'Error in GeckoTerminal trader discovery');
    }
  }
}

// ============ EXPORTS ============

export const walletDiscoveryEngine = new WalletDiscoveryEngine();
