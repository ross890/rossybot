// ===========================================
// NANSEN WINNER SCANNER — INTEGRATION 5
// On BIG_WIN/MASSIVE_WIN, query Nansen PnL leaderboard to find
// top profiteers and add them as high-priority wallet candidates
// ===========================================

import { logger } from '../utils/logger.js';
import { nansenClient } from './nansenClient.js';
import { walletEngine } from '../wallets/walletEngine.js';
import { Database } from '../utils/database.js';

// ============ TYPES ============

interface NansenPnlTrader {
  trader_address: string;
  trader_label?: string;
  pnl_usd_realised?: number;
  roi_percent_realised?: number;
}

// ============ SCANNER ============

export class NansenWinnerScanner {
  /**
   * Trigger on BIG_WIN (100-300%) or MASSIVE_WIN (300%+) outcome
   * Queries Nansen PnL leaderboard for the winning token
   * and adds top profiteers as wallet candidates
   */
  async onBigWinner(tokenAddress: string, tokenReturn: number): Promise<number> {
    if (!nansenClient.isConfigured()) return 0;

    let discoveredCount = 0;

    try {
      logger.info({
        token: tokenAddress.slice(0, 8),
        return: tokenReturn.toFixed(0),
      }, 'NansenWinnerScanner: Scanning PnL leaderboard for big winner');

      const pnlData = await nansenClient.post<{ data?: NansenPnlTrader[] }>(
        '/tgm/pnl-leaderboard',
        {
          chain: 'solana',
          token_address: tokenAddress,
          date: {
            from: daysAgo(7).toISOString(),
            to: new Date().toISOString(),
          },
          pagination: { page: 1, per_page: 20 },
          filters: {
            pnl_usd_realised: { min: 20 },
          },
          order_by: [{ field: 'roi_percent_realised', direction: 'DESC' }],
        },
        5, // 5 credits
      );

      if (!pnlData?.data) {
        logger.debug({ token: tokenAddress.slice(0, 8) }, 'NansenWinnerScanner: No PnL data returned');
        return 0;
      }

      for (const trader of pnlData.data) {
        if (!trader.trader_address) continue;

        // Skip if already tracked
        const existing = await walletEngine.getWalletByAddress(trader.trader_address);
        if (existing && existing.status !== 'PURGED') continue;

        // Skip likely insiders (>100x ROI = suspicious)
        if ((trader.roi_percent_realised || 0) > 10000) continue;

        const pnl = trader.pnl_usd_realised || 0;
        const roi = trader.roi_percent_realised || 0;

        // Add as candidate
        const result = await walletEngine.addCandidate(
          trader.trader_address,
          'NANSEN_WINNER_SCAN',
          tokenAddress,
        );

        if (result.isNew && result.id > 0) {
          // Store Nansen metadata
          const fastTrackEligible = pnl >= 100 && roi >= 50;

          await Database.updateEngineWalletNansenData(result.id, {
            nansen_label: trader.trader_label || null,
            nansen_pnl_30d: pnl,
            nansen_last_refreshed: new Date(),
            fast_track_eligible: fastTrackEligible,
          });

          discoveredCount++;

          logger.info({
            wallet: trader.trader_address.slice(0, 8),
            label: trader.trader_label,
            pnl,
            roi: roi.toFixed(0),
            fastTrack: fastTrackEligible,
          }, 'NansenWinnerScanner: New candidate from winner scan');
        } else if (result.id > 0) {
          // Already exists — increment winner scan appearances
          await Database.incrementEngineWalletField(result.id, 'winner_scan_appearances');
        }
      }

      if (discoveredCount > 0) {
        logger.info({
          token: tokenAddress.slice(0, 8),
          discovered: discoveredCount,
        }, 'NansenWinnerScanner: New candidates from winner scan');
      }
    } catch (error) {
      logger.error({
        error,
        token: tokenAddress.slice(0, 8),
      }, 'NansenWinnerScanner: Scan failed');
    }

    return discoveredCount;
  }
}

// ============ HELPERS ============

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

// ============ SINGLETON ============

export const nansenWinnerScanner = new NansenWinnerScanner();

export default nansenWinnerScanner;
