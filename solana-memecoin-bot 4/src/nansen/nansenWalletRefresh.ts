// ===========================================
// NANSEN WALLET REFRESH — INTEGRATION 6
// Weekly refresh of Nansen PnL data for active wallets
// Detects strategy changes / declining performance early
// ===========================================

import { logger } from '../utils/logger.js';
import { nansenClient } from './nansenClient.js';
import { walletEngine } from '../wallets/walletEngine.js';
import { Database } from '../utils/database.js';

// ============ TYPES ============

interface NansenPnlSummary {
  traded_token_count?: number;
  win_rate?: number;
  total_pnl_usd_realised?: number;
}

// Callback for sending Telegram notifications
type NotifyCallback = (message: string) => Promise<void>;

// ============ REFRESH CLASS ============

export class NansenWalletRefresh {
  private refreshTimer: NodeJS.Timeout | null = null;
  private notifyCallback: NotifyCallback | null = null;

  /**
   * Set notification callback (Telegram)
   */
  setNotifyCallback(callback: NotifyCallback): void {
    this.notifyCallback = callback;
  }

  /**
   * Start weekly refresh schedule
   * Runs every Monday at 6 AM AEDT (piggyback on optimizer schedule)
   */
  start(): void {
    if (!nansenClient.isConfigured()) {
      logger.info('NansenWalletRefresh: NANSEN_API_KEY not set, skipping');
      return;
    }

    logger.info('NansenWalletRefresh: Starting weekly refresh (Monday 6 AM AEDT)');

    // Check every hour if it's time to run
    this.refreshTimer = setInterval(() => this.checkAndRun(), 60 * 60 * 1000);

    // Also check on startup after 5 minutes
    setTimeout(() => this.checkAndRun(), 5 * 60 * 1000);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    logger.info('NansenWalletRefresh: Stopped');
  }

  /**
   * Check if it's Monday 6 AM AEDT and run if so
   */
  private async checkAndRun(): Promise<void> {
    const now = new Date();
    // AEDT is UTC+11
    const aedtHour = (now.getUTCHours() + 11) % 24;
    const aedtDay = now.getUTCDay();

    // Monday = 1, check at 6 AM AEDT
    // Account for date line: if UTC hour + 11 >= 24, we're in the next day
    const isMonday = (now.getUTCHours() + 11 >= 24)
      ? ((aedtDay + 1) % 7) === 1
      : aedtDay === 1;

    if (isMonday && aedtHour === 6) {
      await this.refresh();
    }
  }

  /**
   * Run the weekly refresh for all active wallets
   */
  async refresh(): Promise<void> {
    if (!nansenClient.isConfigured()) return;

    try {
      const activeWallets = await walletEngine.getActiveWallets();
      logger.info({ count: activeWallets.length }, 'NansenWalletRefresh: Starting weekly refresh');

      let refreshed = 0;
      let warnings = 0;

      for (const wallet of activeWallets) {
        try {
          const pnlSummary = await nansenClient.post<NansenPnlSummary>(
            '/profiler/address/pnl-summary',
            {
              address: wallet.walletAddress,
              chain: 'solana',
              date: {
                from: daysAgo(30).toISOString(),
                to: new Date().toISOString(),
              },
            },
            1, // 1 credit
          );

          if (!pnlSummary) continue;

          const currentWinRate = pnlSummary.win_rate || 0;
          const currentPnl = pnlSummary.total_pnl_usd_realised || 0;
          const shortAddr = `${wallet.walletAddress.slice(0, 6)}...${wallet.walletAddress.slice(-4)}`;

          // Read previous Nansen stats from wallet data
          // (stored as nansen_pnl_30d and nansen_win_rate columns)
          const walletData = await Database.getEngineWallet(wallet.walletAddress);
          const previousPnl = walletData?.nansen_pnl_30d ? parseFloat(walletData.nansen_pnl_30d) : null;
          const previousWinRate = walletData?.nansen_win_rate ? parseFloat(walletData.nansen_win_rate) : null;

          // EARLY WARNING: PnL flipped negative
          if (previousPnl !== null && previousPnl > 0 && currentPnl < 0) {
            const newWeight = Math.max(0.5, wallet.weight - 0.3);
            await Database.updateEngineWalletStatus(wallet.id, wallet.status, { weight: newWeight });

            const msg = `*NANSEN WARNING:* Wallet \`${shortAddr}\` ` +
              `Nansen 30d PnL flipped negative ($${currentPnl.toFixed(0)}). ` +
              `Weight reduced to ${newWeight.toFixed(1)}.`;
            await this.notify(msg);
            warnings++;
          }

          // EARLY WARNING: Significant win rate decline
          if (previousWinRate !== null && previousWinRate >= 0.30 && currentWinRate < 0.20) {
            const newWeight = Math.max(0.5, wallet.weight - 0.2);
            await Database.updateEngineWalletStatus(wallet.id, wallet.status, { weight: newWeight });

            const msg = `*NANSEN WARNING:* Wallet \`${shortAddr}\` ` +
              `win rate dropped from ${(previousWinRate * 100).toFixed(0)}% to ${(currentWinRate * 100).toFixed(0)}%.`;
            await this.notify(msg);
            warnings++;
          }

          // Update stored Nansen stats
          await Database.updateEngineWalletNansenData(wallet.id, {
            nansen_pnl_30d: currentPnl,
            nansen_win_rate: currentWinRate,
            nansen_token_count: pnlSummary.traded_token_count || 0,
            nansen_last_refreshed: new Date(),
          });

          refreshed++;
          await sleep(300); // Rate limit courtesy
        } catch (error) {
          logger.debug({
            error,
            wallet: wallet.walletAddress.slice(0, 8),
          }, 'NansenWalletRefresh: Error refreshing wallet');
        }
      }

      logger.info({
        total: activeWallets.length,
        refreshed,
        warnings,
      }, 'NansenWalletRefresh: Weekly refresh complete');
    } catch (error) {
      logger.error({ error }, 'NansenWalletRefresh: Refresh failed');
    }
  }

  private async notify(message: string): Promise<void> {
    if (this.notifyCallback) {
      try {
        await this.notifyCallback(message);
      } catch (error) {
        logger.warn({ error }, 'NansenWalletRefresh: Failed to send notification');
      }
    }
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

export const nansenWalletRefresh = new NansenWalletRefresh();

export default nansenWalletRefresh;
