// ===========================================
// ALPHA WALLET ENGINE — GMGN LEADERBOARD SCANNER
// Discovers candidate wallets from GMGN smart money rankings
// Scans every 6 hours, filters for wallets matching edge profile
// ===========================================

import { logger } from '../utils/logger.js';
import { walletEngine } from './walletEngine.js';
import { WALLET_ENGINE_CONFIG } from '../config/walletEngine.js';

// ============ CONSTANTS ============

const GMGN_BASE_URL = 'https://gmgn.ai';
const GMGN_SMART_MONEY_PATH = '/defi/quotation/v1/rank/sol/wallets';
const SCAN_INTERVAL_MS = WALLET_ENGINE_CONFIG.GMGN_SCAN_INTERVAL_HOURS * 60 * 60 * 1000;

// ============ TYPES ============

interface GmgnWalletData {
  address?: string;
  wallet_address?: string;
  pnl_30d?: number;
  total_trades_30d?: number;
  win_rate?: number;
  avg_entry_mcap?: number;
  avg_hold_time_minutes?: number;
  avg_hold_time?: number;
  distinct_tokens_traded?: number;
  unique_tokens?: number;
  max_single_token_pnl_percent?: number;
  realized_profit?: number;
  realized_profit_30d?: number;
  buy_30d?: number;
  sell_30d?: number;
  last_active_timestamp?: number;
  winrate?: number;
  token_avg_cost?: number;
  tags?: string[];
}

interface GmgnRankResponse {
  code: number;
  msg: string;
  data?: {
    rank?: GmgnWalletData[];
  };
}

// ============ GMGN DISCOVERY CLASS ============

export class GmgnDiscovery {
  private scanTimer: NodeJS.Timeout | null = null;
  private isScanning = false;

  /**
   * Start periodic GMGN leaderboard scanning
   */
  start(): void {
    logger.info({ intervalHours: WALLET_ENGINE_CONFIG.GMGN_SCAN_INTERVAL_HOURS }, 'GMGN Discovery: Starting scanner');

    // Initial scan after 30 seconds (let other modules initialize)
    setTimeout(() => this.scan(), 30_000);

    // Periodic scan
    this.scanTimer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    logger.info('GMGN Discovery: Stopped');
  }

  /**
   * Run a single scan of the GMGN leaderboard
   */
  async scan(): Promise<number> {
    if (this.isScanning) return 0;
    this.isScanning = true;

    let addedCount = 0;

    try {
      logger.info('GMGN Discovery: Starting leaderboard scan');

      const wallets = await this.fetchLeaderboard();

      if (wallets.length === 0) {
        logger.warn('GMGN Discovery: No wallets returned from leaderboard');
        return 0;
      }

      logger.info({ totalFetched: wallets.length }, 'GMGN Discovery: Fetched leaderboard wallets');

      const filtered = this.filterWallets(wallets);
      logger.info({ filtered: filtered.length, total: wallets.length }, 'GMGN Discovery: Wallets passed filters');

      for (const wallet of filtered) {
        try {
          const address = wallet.address || wallet.wallet_address;
          if (!address) continue;

          const result = await walletEngine.addCandidate(address, 'GMGN_LEADERBOARD');
          if (result.isNew) {
            addedCount++;
            logger.debug({ address: address.slice(0, 8) }, 'GMGN Discovery: New candidate added');
          }
        } catch (error) {
          logger.debug({ error }, 'GMGN Discovery: Error adding candidate');
        }
      }

      if (addedCount > 0) {
        logger.info({ addedCount }, 'GMGN Discovery: New candidates added from leaderboard');
      }
    } catch (error) {
      logger.error({ error }, 'GMGN Discovery: Scan failed');
    } finally {
      this.isScanning = false;
    }

    return addedCount;
  }

  /**
   * Fetch GMGN smart money leaderboard
   * Uses 30-day window for best signal quality
   */
  private async fetchLeaderboard(): Promise<GmgnWalletData[]> {
    const allWallets: GmgnWalletData[] = [];

    // Try multiple timeframes/sort orders for breadth
    const endpoints = [
      `${GMGN_BASE_URL}${GMGN_SMART_MONEY_PATH}/30d?orderby=pnl_30d&direction=desc&limit=100`,
      `${GMGN_BASE_URL}${GMGN_SMART_MONEY_PATH}/7d?orderby=winrate&direction=desc&limit=100`,
    ];

    for (const url of endpoints) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Referer': 'https://gmgn.ai/',
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          logger.debug({ status: response.status, url }, 'GMGN Discovery: API returned non-OK');
          continue;
        }

        const data = (await response.json()) as GmgnRankResponse;

        if (data.code !== 0 || !data.data?.rank) {
          logger.debug({ code: data.code, msg: data.msg }, 'GMGN Discovery: API returned error');
          continue;
        }

        for (const wallet of data.data.rank) {
          const addr = wallet.address || wallet.wallet_address;
          if (addr && !allWallets.some(w => (w.address || w.wallet_address) === addr)) {
            allWallets.push(wallet);
          }
        }
      } catch (error) {
        logger.debug({ error }, 'GMGN Discovery: Failed to fetch endpoint');
      }
    }

    return allWallets;
  }

  /**
   * Apply filter criteria to GMGN wallet data
   */
  private filterWallets(wallets: GmgnWalletData[]): GmgnWalletData[] {
    const filters = WALLET_ENGINE_CONFIG.GMGN_FILTERS;

    return wallets.filter(w => {
      const pnl = w.pnl_30d ?? w.realized_profit_30d ?? w.realized_profit ?? 0;
      const totalTrades = w.total_trades_30d ?? (w.buy_30d || 0) + (w.sell_30d || 0);
      const winRate = w.win_rate ?? w.winrate ?? 0;
      const avgEntryMcap = w.avg_entry_mcap ?? w.token_avg_cost ?? 0;
      const avgHoldTime = w.avg_hold_time_minutes ?? w.avg_hold_time ?? 0;
      const distinctTokens = w.distinct_tokens_traded ?? w.unique_tokens ?? 0;

      // Apply all filters (all must pass)
      if (pnl <= filters.minPnl30d) return false;
      if (totalTrades < filters.minTotalTrades) return false;
      if (totalTrades > filters.maxTotalTrades) return false;
      if (winRate < filters.minWinRate) return false;
      if (winRate > filters.maxWinRate) return false;
      if (avgEntryMcap > filters.maxAvgEntryMcap && avgEntryMcap > 0) return false;
      if (avgHoldTime < filters.minAvgHoldTimeMinutes && avgHoldTime > 0) return false;
      if (avgHoldTime > filters.maxAvgHoldTimeMinutes && avgHoldTime > 0) return false;
      if (distinctTokens < filters.minDistinctTokens && distinctTokens > 0) return false;

      // Max single token PnL check (skip if data not available)
      if (w.max_single_token_pnl_percent !== undefined &&
          w.max_single_token_pnl_percent > filters.maxSingleTokenPnlPercent) {
        return false;
      }

      return true;
    });
  }
}

// Singleton export
export const gmgnDiscovery = new GmgnDiscovery();

export default gmgnDiscovery;
