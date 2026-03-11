// ===========================================
// MODULE: DYNAMIC WALLET DISCOVERY
// Auto-discovers smart money wallets from two sources:
// 1. Winner backtracking — scrape early buyers from winning signals
// 2. GMGN top traders — external smart money wallet feed
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

  // GMGN top traders
  GMGN_INTERVAL_MS: 4 * 60 * 60 * 1000,    // Every 4 hours (aggressive = rate limited)
  GMGN_TOP_TRADERS_LIMIT: 50,              // Top 50 wallets per fetch

  // Dedup
  PROCESSED_WINNERS_TTL_MS: 7 * 24 * 60 * 60 * 1000, // Remember processed winners for 7 days
};

// ============ GMGN WALLET DISCOVERY ============

const GMGN_BASE_URL = 'https://gmgn.ai';

interface GmgnWalletData {
  address?: string;
  wallet_address?: string;
  realized_profit?: number;
  unrealized_profit?: number;
  total_profit?: number;
  win_rate?: number;
  buy_count?: number;
  sell_count?: number;
  token_count?: number;
  pnl_7d?: number;
  pnl_30d?: number;
  last_active_timestamp?: number;
}

interface GmgnWalletResponse {
  code: number;
  msg: string;
  data?: {
    rank?: GmgnWalletData[];
  };
}

/**
 * Fetch top trading wallets from GMGN's smart money ranking
 */
async function fetchGmgnTopTraders(limit: number = 50): Promise<Array<{
  address: string;
  winRate: number;
  profitSol: number;
  tradeCount: number;
}>> {
  const results: Array<{
    address: string;
    winRate: number;
    profitSol: number;
    tradeCount: number;
  }> = [];

  // Try multiple GMGN wallet ranking endpoints
  const endpoints = [
    `/defi/quotation/v1/rank/sol/walletActivities/7d?orderby=pnl_7d&direction=desc&limit=${limit}`,
    `/defi/quotation/v1/rank/sol/walletActivities/30d?orderby=realized_profit&direction=desc&limit=${limit}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const url = `${GMGN_BASE_URL}${endpoint}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://gmgn.ai/',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        logger.debug({ status: response.status, endpoint }, 'GMGN wallet ranking API non-OK');
        continue;
      }

      const data = (await response.json()) as GmgnWalletResponse;

      if (data.code !== 0 || !data.data?.rank) {
        logger.debug({ code: data.code, msg: data.msg }, 'GMGN wallet ranking error');
        continue;
      }

      for (const wallet of data.data.rank) {
        const addr = wallet.address || wallet.wallet_address;
        if (!addr || addr.length < 32) continue;

        // Skip if already in results
        if (results.some(r => r.address === addr)) continue;

        const totalTrades = (wallet.buy_count || 0) + (wallet.sell_count || 0);
        const profit = wallet.realized_profit || wallet.total_profit || wallet.pnl_7d || 0;

        results.push({
          address: addr,
          winRate: wallet.win_rate || 0,
          profitSol: profit,
          tradeCount: totalTrades,
        });
      }

      logger.info({
        count: data.data.rank.length,
        endpoint: endpoint.split('?')[0],
      }, 'GMGN top traders fetched');
    } catch (error) {
      logger.debug({ error }, 'GMGN wallet fetch failed');
    }
  }

  return results;
}

// ============ WALLET DISCOVERY ENGINE ============

export class WalletDiscoveryEngine {
  private isRunning = false;
  private backtrackTimer: NodeJS.Timeout | null = null;
  private gmgnTimer: NodeJS.Timeout | null = null;

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

    // GMGN top traders — run every 4 hours
    this.gmgnTimer = setInterval(
      () => this.runGmgnDiscovery(),
      DISCOVERY_CONFIG.GMGN_INTERVAL_MS
    );

    // Run initial GMGN scan after 2 minutes (let other systems boot first)
    setTimeout(() => this.runGmgnDiscovery(), 2 * 60 * 1000);

    // Run initial backtrack after 5 minutes
    setTimeout(() => this.runWinnerBacktracking(), 5 * 60 * 1000);

    logger.info('Wallet Discovery Engine started (backtrack: 1h, GMGN: 4h)');
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
    if (this.gmgnTimer) {
      clearInterval(this.gmgnTimer);
      this.gmgnTimer = null;
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

  // ============ GMGN TOP TRADER DISCOVERY ============

  /**
   * Fetch top traders from GMGN and feed into smart money pipeline
   */
  private async runGmgnDiscovery(): Promise<void> {
    try {
      const topTraders = await fetchGmgnTopTraders(DISCOVERY_CONFIG.GMGN_TOP_TRADERS_LIMIT);

      if (topTraders.length === 0) {
        logger.debug('GMGN discovery: no top traders returned');
        return;
      }

      let newCandidates = 0;
      let alreadyTracked = 0;

      for (const trader of topTraders) {
        try {
          // Skip if already tracked as KOL or alpha wallet
          const isKol = await Database.getWalletByAddress(trader.address);
          const isAlpha = await Database.isAlphaWalletTracked(trader.address);
          const isCandidate = await Database.isSmartMoneyCandidate(trader.address);

          if (isKol || isAlpha || isCandidate) {
            alreadyTracked++;
            continue;
          }

          // Create as smart money candidate with GMGN source
          const reason = `GMGN top trader: ${trader.winRate > 0 ? (trader.winRate * 100).toFixed(0) + '% WR, ' : ''}${trader.profitSol.toFixed(1)} SOL profit`;

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
          fetched: topTraders.length,
          newCandidates,
          alreadyTracked,
        }, 'GMGN top trader discovery complete — new candidates added');
      } else {
        logger.debug({
          fetched: topTraders.length,
          alreadyTracked,
        }, 'GMGN discovery: all traders already tracked');
      }
    } catch (error) {
      logger.error({ error }, 'Error in GMGN trader discovery');
    }
  }
}

// ============ EXPORTS ============

export const walletDiscoveryEngine = new WalletDiscoveryEngine();
