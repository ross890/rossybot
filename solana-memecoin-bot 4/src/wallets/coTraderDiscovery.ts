// ===========================================
// ALPHA WALLET ENGINE — CO-TRADER DISCOVERY
// Discovers wallets that consistently buy alongside existing alpha wallets
// Triggered each time an ALPHA_WALLET signal fires
// ===========================================

import { logger } from '../utils/logger.js';
import { walletEngine } from './walletEngine.js';
import { WALLET_ENGINE_CONFIG } from '../config/walletEngine.js';
import { heliusClient } from '../modules/onchain.js';
import { Database } from '../utils/database.js';
import { appConfig } from '../config/index.js';

// ============ CO-TRADE TRACKING ============

// In-memory co-trade frequency tracker
// Maps wallet address → count of co-trade occurrences
const coTradeFrequency = new Map<string, {
  count: number;
  tokens: Set<string>;
  lastSeen: number;
}>();

// ============ CO-TRADER DISCOVERY CLASS ============

export class CoTraderDiscovery {
  /**
   * Triggered when an alpha wallet buys a token.
   * Looks at who else is buying the same token around the same time.
   *
   * @param alphaWalletAddress - The alpha wallet that triggered the signal
   * @param tokenAddress - The token being bought
   * @param buyTime - When the alpha wallet bought
   */
  async onAlphaWalletBuy(
    alphaWalletAddress: string,
    tokenAddress: string,
    buyTime: Date
  ): Promise<number> {
    if (appConfig.heliusDisabled) return 0;

    let discoveredCount = 0;

    try {
      logger.debug({
        alphaWallet: alphaWalletAddress.slice(0, 8),
        token: tokenAddress.slice(0, 8),
      }, 'CoTraderDiscovery: Scanning co-traders');

      // Fetch recent buyers of this token
      const signatures = await heliusClient.getRecentTransactions(
        tokenAddress,
        WALLET_ENGINE_CONFIG.CO_TRADE_TRANSACTIONS_TO_SCAN
      );

      if (signatures.length === 0) return 0;

      const buyTimeMs = buyTime.getTime();
      const windowMs = WALLET_ENGINE_CONFIG.CO_TRADE_WINDOW_MINUTES * 60 * 1000;
      const coTraders = new Set<string>();

      // Find wallets that bought within the co-trade window
      for (const sig of signatures) {
        try {
          const txTime = sig.blockTime ? sig.blockTime * 1000 : 0;
          if (txTime === 0) continue;

          // Must be within ±window of alpha wallet's buy
          if (Math.abs(txTime - buyTimeMs) > windowMs) continue;

          const txDetail = await heliusClient.getTransaction(sig.signature);
          if (!txDetail) continue;

          const buyers = this.extractBuyers(txDetail, tokenAddress);
          for (const buyer of buyers) {
            // Skip the alpha wallet itself
            if (buyer === alphaWalletAddress) continue;
            coTraders.add(buyer);
          }
        } catch (error) {
          logger.debug({ error }, 'CoTraderDiscovery: Error parsing transaction');
        }
      }

      // Update co-trade frequency
      for (const address of coTraders) {
        const existing = coTradeFrequency.get(address) || { count: 0, tokens: new Set(), lastSeen: 0 };
        existing.count++;
        existing.tokens.add(tokenAddress);
        existing.lastSeen = Date.now();
        coTradeFrequency.set(address, existing);

        // Check if threshold met
        if (existing.tokens.size >= WALLET_ENGINE_CONFIG.CO_TRADE_MIN_OCCURRENCES) {
          try {
            // Validate the candidate
            const valid = await this.validateCandidate(address);
            if (!valid) continue;

            const result = await walletEngine.addCandidate(address, 'CO_TRADER');

            if (result.isNew) {
              discoveredCount++;

              // Update co-trade count
              await Database.updateEngineWalletStats(result.id, {
                co_trade_count: existing.tokens.size,
              });

              logger.info({
                wallet: address.slice(0, 8),
                coTrades: existing.tokens.size,
              }, 'CoTraderDiscovery: New co-trader candidate added');
            } else if (result.id > 0) {
              // Update co-trade count for existing candidate
              await Database.incrementEngineWalletField(result.id, 'co_trade_count');
            }
          } catch (error) {
            logger.debug({ error, address: address.slice(0, 8) }, 'CoTraderDiscovery: Error adding candidate');
          }
        }
      }

      if (discoveredCount > 0) {
        logger.info({
          alphaWallet: alphaWalletAddress.slice(0, 8),
          token: tokenAddress.slice(0, 8),
          discovered: discoveredCount,
        }, 'CoTraderDiscovery: New candidates from co-trader scan');
      }
    } catch (error) {
      logger.error({ error }, 'CoTraderDiscovery: Scan failed');
    }

    return discoveredCount;
  }

  /**
   * Extract buyer wallet addresses from a transaction
   */
  private extractBuyers(txDetail: any, tokenAddress: string): string[] {
    const buyers: string[] = [];

    try {
      const preBalances = txDetail.meta?.preTokenBalances || [];
      const postBalances = txDetail.meta?.postTokenBalances || [];

      for (const postBal of postBalances) {
        if (postBal.mint !== tokenAddress) continue;
        if (!postBal.owner) continue;

        const preBal = preBalances.find(
          (pb: any) => pb.mint === tokenAddress && pb.owner === postBal.owner
        );

        const preAmount = preBal?.uiTokenAmount?.uiAmount || 0;
        const postAmount = postBal.uiTokenAmount?.uiAmount || 0;

        if (postAmount > preAmount) {
          buyers.push(postBal.owner);
        }
      }
    } catch (error) {
      logger.debug({ error }, 'CoTraderDiscovery: Error extracting buyers');
    }

    return buyers;
  }

  /**
   * Validate a candidate wallet
   */
  private async validateCandidate(address: string): Promise<boolean> {
    try {
      // Skip if already tracked
      const existing = await walletEngine.getWalletByAddress(address);
      if (existing && existing.status !== 'PURGED') return false;

      const alphaWallet = await Database.getAlphaWalletByAddress(address);
      if (alphaWallet) return false;

      // Check minimum activity
      const recentTxs = await heliusClient.getRecentTransactions(address, WALLET_ENGINE_CONFIG.ONCHAIN_MIN_SWAP_TRANSACTIONS);
      if (recentTxs.length < WALLET_ENGINE_CONFIG.ONCHAIN_MIN_SWAP_TRANSACTIONS) return false;

      // Check wallet age
      if (recentTxs.length > 0) {
        const oldestTx = recentTxs[recentTxs.length - 1];
        if (oldestTx.blockTime) {
          const ageDays = (Date.now() - oldestTx.blockTime * 1000) / (1000 * 60 * 60 * 24);
          if (ageDays < WALLET_ENGINE_CONFIG.ONCHAIN_MIN_WALLET_AGE_DAYS) return false;
        }
      }

      return true;
    } catch (error) {
      logger.debug({ error, address: address.slice(0, 8) }, 'CoTraderDiscovery: Validation error');
      return false;
    }
  }

  /**
   * Periodic cleanup of stale co-trade tracking data
   * Call this occasionally to prevent memory bloat
   */
  cleanupStaleEntries(): void {
    const now = Date.now();
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days

    for (const [address, data] of coTradeFrequency) {
      if (now - data.lastSeen > maxAgeMs) {
        coTradeFrequency.delete(address);
      }
    }
  }
}

// Singleton export
export const coTraderDiscovery = new CoTraderDiscovery();

export default coTraderDiscovery;
