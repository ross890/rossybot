// ===========================================
// NANSEN WALLET DISCOVERY — INTEGRATION 1
// Discovers candidate wallets from Nansen Smart Money data
// Runs every 6 hours, pulls PnL leaderboard for micro-cap tokens
// ===========================================

import { logger } from '../utils/logger.js';
import { nansenClient } from './nansenClient.js';
import { walletEngine } from '../wallets/walletEngine.js';
import { Database } from '../utils/database.js';

// ============ TYPES ============

interface WalletCandidate {
  walletAddress: string;
  nansenLabel: string | null;
  source: 'NANSEN_PNL_LEADERBOARD';
  discoveredFromToken: string;
  discoveredFromTokenName: string;
  pnlOnDiscoveryToken: number;
  roiOnDiscoveryToken: number;
}

interface NansenNetflowToken {
  token_address: string;
  token_symbol?: string;
  market_cap_usd?: number;
  net_flow_24h_usd?: number;
}

interface NansenPnlTrader {
  trader_address: string;
  trader_label?: string;
  pnl_usd_realised?: number;
  roi_percent_realised?: number;
}

interface NansenPnlSummary {
  traded_token_count?: number;
  win_rate?: number;
  total_pnl_usd_realised?: number;
  top5_tokens?: any;
}

interface NansenTokenPnl {
  bought_usd?: number;
  sold_usd?: number;
  pnl_usd_realised?: number;
}

// ============ CONSTANTS ============

const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MCAP_MIN = 30_000;
const MCAP_MAX = 1_000_000;
const MAX_TOKENS_PER_SCAN = 5;
const MAX_TRADERS_PER_TOKEN = 20;
const AVG_BUY_SIZE_MAX = 10_000; // Skip wallets with avg buy >$10K (not micro-cap traders)

// ============ DISCOVERY CLASS ============

export class NansenWalletDiscovery {
  private scanTimer: NodeJS.Timeout | null = null;
  private isScanning = false;

  /**
   * Start periodic Nansen wallet discovery scanning
   */
  start(): void {
    if (!nansenClient.isConfigured()) {
      logger.info('NansenWalletDiscovery: NANSEN_API_KEY not set, skipping');
      return;
    }

    logger.info('NansenWalletDiscovery: Starting scanner (6h interval)');

    // Initial scan after 2 minutes (let other modules initialize)
    setTimeout(() => this.scan(), 120_000);

    // Periodic scan every 6 hours
    this.scanTimer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    logger.info('NansenWalletDiscovery: Stopped');
  }

  /**
   * Run a single discovery scan
   */
  async scan(): Promise<number> {
    if (this.isScanning) return 0;
    this.isScanning = true;

    let addedCount = 0;

    try {
      logger.info('NansenWalletDiscovery: Starting scan');

      // Step 1: Pull smart money netflow for Solana
      const candidates = await this.discoverWalletCandidates();

      if (candidates.length === 0) {
        logger.info('NansenWalletDiscovery: No candidates found this scan');
        return 0;
      }

      logger.info({ count: candidates.length }, 'NansenWalletDiscovery: Candidates discovered');

      // Step 2: Validate and add candidates
      addedCount = await this.validateAndAddCandidates(candidates);

      logger.info({
        discovered: candidates.length,
        added: addedCount,
        credits: nansenClient.getCreditStats(),
      }, 'NansenWalletDiscovery: Scan complete');
    } catch (error) {
      logger.error({ error }, 'NansenWalletDiscovery: Scan failed');
    } finally {
      this.isScanning = false;
    }

    return addedCount;
  }

  /**
   * Step 1-3: Pull smart money wallets active on Solana micro-caps
   */
  private async discoverWalletCandidates(): Promise<WalletCandidate[]> {
    // Step 1: Pull smart money netflow
    const netflowData = await nansenClient.post<{ data?: NansenNetflowToken[] }>(
      '/smart-money/netflow',
      {
        chains: ['solana'],
        filters: {
          include_smart_money_labels: ['Smart Trader', '30D Smart Trader'],
          include_stablecoins: false,
          include_native_tokens: false,
          trader_count: { min: 3 },
        },
        pagination: { page: 1, per_page: 50 },
        order_by: [{ field: 'net_flow_24h_usd', direction: 'DESC' }],
      },
      1, // 1 credit
    );

    if (!netflowData?.data) {
      logger.debug('NansenWalletDiscovery: No netflow data returned');
      return [];
    }

    // Step 2: Filter for micro-cap tokens
    const microCapTokens = netflowData.data.filter(token => {
      const mcap = token.market_cap_usd || 0;
      return mcap >= MCAP_MIN && mcap <= MCAP_MAX;
    });

    logger.debug({
      totalTokens: netflowData.data.length,
      microCap: microCapTokens.length,
    }, 'NansenWalletDiscovery: Filtered for micro-cap tokens');

    // Step 3: For each micro-cap token, get PnL leaderboard
    const walletCandidates: WalletCandidate[] = [];
    const tokensToAnalyze = microCapTokens.slice(0, MAX_TOKENS_PER_SCAN);

    for (const token of tokensToAnalyze) {
      const pnlData = await nansenClient.post<{ data?: NansenPnlTrader[] }>(
        '/tgm/pnl-leaderboard',
        {
          chain: 'solana',
          token_address: token.token_address,
          date: {
            from: daysAgo(30).toISOString(),
            to: new Date().toISOString(),
          },
          pagination: { page: 1, per_page: MAX_TRADERS_PER_TOKEN },
          filters: {
            pnl_usd_realised: { min: 100 },
          },
          order_by: [{ field: 'pnl_usd_realised', direction: 'DESC' }],
        },
        5, // 5 credits per PnL leaderboard call
      );

      if (!pnlData?.data) continue;

      for (const trader of pnlData.data) {
        if (!trader.trader_address) continue;

        walletCandidates.push({
          walletAddress: trader.trader_address,
          nansenLabel: trader.trader_label || null,
          source: 'NANSEN_PNL_LEADERBOARD',
          discoveredFromToken: token.token_address,
          discoveredFromTokenName: token.token_symbol || 'UNKNOWN',
          pnlOnDiscoveryToken: trader.pnl_usd_realised || 0,
          roiOnDiscoveryToken: trader.roi_percent_realised || 0,
        });
      }

      await sleep(500); // Rate limit courtesy
    }

    return walletCandidates;
  }

  /**
   * Steps 4-8: Validate candidates via Nansen Profiler and add to wallet engine
   */
  private async validateAndAddCandidates(candidates: WalletCandidate[]): Promise<number> {
    // Deduplicate by wallet address
    const seen = new Set<string>();
    const unique = candidates.filter(c => {
      if (seen.has(c.walletAddress)) return false;
      seen.add(c.walletAddress);
      return true;
    });

    let addedCount = 0;

    for (const candidate of unique) {
      try {
        // Skip if already in any wallet engine state
        const existing = await walletEngine.getWalletByAddress(candidate.walletAddress);
        if (existing && existing.status !== 'PURGED') continue;

        // Step 5: Pull wallet's full PnL summary
        const pnlSummary = await nansenClient.post<NansenPnlSummary>(
          '/profiler/address/pnl-summary',
          {
            address: candidate.walletAddress,
            chain: 'solana',
            date: {
              from: daysAgo(30).toISOString(),
              to: new Date().toISOString(),
            },
          },
          1, // 1 credit
        );

        if (!pnlSummary) continue;

        // Step 6: Apply wallet quality filters
        const tokenCount = pnlSummary.traded_token_count || 0;
        const winRate = pnlSummary.win_rate || 0;
        const totalPnl = pnlSummary.total_pnl_usd_realised || 0;

        if (tokenCount < 10 || winRate < 0.25 || totalPnl < 10_000) {
          logger.debug({
            wallet: candidate.walletAddress.slice(0, 8),
            tokenCount,
            winRate,
            totalPnl,
          }, 'NansenWalletDiscovery: Candidate failed quality filters');
          continue;
        }

        // Step 7: Pull per-token PnL to check avg buy size
        const tokenPnl = await nansenClient.post<{ data?: NansenTokenPnl[] }>(
          '/profiler/address/pnl',
          {
            address: candidate.walletAddress,
            chain: 'solana',
            date: {
              from: daysAgo(30).toISOString(),
              to: new Date().toISOString(),
            },
            pagination: { page: 1, per_page: 20 },
            order_by: [{ field: 'pnl_usd_realised', direction: 'DESC' }],
          },
          1, // 1 credit
        );

        let avgBuySize = 0;
        if (tokenPnl?.data && tokenPnl.data.length > 0) {
          avgBuySize = tokenPnl.data.reduce((sum, t) => sum + (t.bought_usd || 0), 0)
                       / tokenPnl.data.length;

          // Skip if avg buy is too large for micro-cap trading
          if (avgBuySize > AVG_BUY_SIZE_MAX) {
            logger.debug({
              wallet: candidate.walletAddress.slice(0, 8),
              avgBuySize,
            }, 'NansenWalletDiscovery: Avg buy size too high, skipping');
            continue;
          }
        }

        // Step 8: Add to wallet engine with Nansen metadata
        const fastTrackEligible = totalPnl > 10_000
                                   && tokenCount >= 20
                                   && winRate >= 0.30;

        const result = await walletEngine.addCandidate(
          candidate.walletAddress,
          'NANSEN_PNL_LEADERBOARD',
          candidate.discoveredFromToken,
        );

        if (result.isNew && result.id > 0) {
          // Store Nansen-specific metadata
          await Database.updateEngineWalletNansenData(result.id, {
            nansen_label: candidate.nansenLabel,
            nansen_pnl_30d: totalPnl,
            nansen_win_rate: winRate,
            nansen_token_count: tokenCount,
            nansen_top5_tokens: pnlSummary.top5_tokens ? JSON.stringify(pnlSummary.top5_tokens) : null,
            nansen_avg_buy_size: avgBuySize,
            nansen_last_refreshed: new Date(),
            fast_track_eligible: fastTrackEligible,
          });

          addedCount++;
          logger.info({
            wallet: candidate.walletAddress.slice(0, 8),
            label: candidate.nansenLabel,
            pnl: totalPnl,
            winRate: (winRate * 100).toFixed(1),
            fastTrack: fastTrackEligible,
          }, 'NansenWalletDiscovery: New candidate added');
        }

        await sleep(300); // Rate limit courtesy
      } catch (error) {
        logger.debug({
          error,
          wallet: candidate.walletAddress.slice(0, 8),
        }, 'NansenWalletDiscovery: Error processing candidate');
      }
    }

    return addedCount;
  }
}

// ============ HELPERS ============

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ SINGLETON ============

export const nansenWalletDiscovery = new NansenWalletDiscovery();

export default nansenWalletDiscovery;
