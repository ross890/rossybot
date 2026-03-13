// ===========================================
// ALPHA WALLET ENGINE — ON-CHAIN WINNER SCANNER
// Discovers wallets by analyzing who bought tokens early that subsequently pumped
// Triggered on BIG_WIN / MASSIVE_WIN outcomes from performance tracker
// ===========================================

import { logger } from '../utils/logger.js';
import { walletEngine } from './walletEngine.js';
import { WALLET_ENGINE_CONFIG } from '../config/walletEngine.js';
import { heliusClient } from '../modules/onchain.js';
import { Database } from '../utils/database.js';
import { appConfig } from '../config/index.js';

// ============ CONSTANTS ============

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ============ ON-CHAIN DISCOVERY CLASS ============

export class OnchainDiscovery {
  /**
   * Trigger discovery scan when a token hits +100% or more after signal.
   * Called by the performance tracker when it records a BIG_WIN or MASSIVE_WIN.
   *
   * @param tokenAddress - The token that pumped
   * @param signalEntryTime - When the bot's signal fired
   * @param tokenReturn - The realized return percentage
   */
  async onBigWinner(tokenAddress: string, signalEntryTime: Date, tokenReturn: number): Promise<number> {
    if (appConfig.heliusDisabled) return 0;

    let discoveredCount = 0;

    try {
      logger.info({
        token: tokenAddress.slice(0, 8),
        return: tokenReturn.toFixed(0),
      }, 'OnchainDiscovery: Scanning early buyers of big winner');

      // Fetch early transactions for this token
      const signatures = await heliusClient.getRecentTransactions(tokenAddress, WALLET_ENGINE_CONFIG.ONCHAIN_EARLY_TRANSACTIONS_TO_SCAN);

      if (signatures.length === 0) {
        logger.debug({ token: tokenAddress.slice(0, 8) }, 'OnchainDiscovery: No transactions found');
        return 0;
      }

      const signalTime = signalEntryTime.getTime();
      const earlyWindowMs = WALLET_ENGINE_CONFIG.ONCHAIN_EARLY_BUYER_WINDOW_MINUTES * 60 * 1000;
      const candidateAddresses = new Set<string>();

      // Parse transactions for early buyers
      for (const sig of signatures) {
        try {
          const txTime = sig.blockTime ? sig.blockTime * 1000 : 0;
          if (txTime === 0) continue;

          // Must be before or within 5 minutes of our signal
          if (txTime > signalTime + earlyWindowMs) continue;

          // Get transaction details
          const txDetail = await heliusClient.getTransaction(sig.signature);
          if (!txDetail) continue;

          // Extract buyer wallets from token balance changes
          const buyers = this.extractBuyerWallets(txDetail, tokenAddress);
          for (const buyer of buyers) {
            candidateAddresses.add(buyer);
          }
        } catch (error) {
          logger.debug({ error }, 'OnchainDiscovery: Error parsing transaction');
        }
      }

      logger.debug({
        token: tokenAddress.slice(0, 8),
        earlyBuyers: candidateAddresses.size,
      }, 'OnchainDiscovery: Found early buyer candidates');

      // Filter and add candidates
      for (const address of candidateAddresses) {
        try {
          const passed = await this.validateCandidate(address);
          if (!passed) continue;

          const result = await walletEngine.addCandidate(address, 'ONCHAIN_WINNER_SCAN', tokenAddress);

          if (result.isNew) {
            discoveredCount++;
          } else if (result.id > 0) {
            // Already exists — increment winner scan appearances
            await Database.incrementEngineWalletField(result.id, 'winner_scan_appearances');

            // Check for fast-track
            const wallet = await walletEngine.getWalletById(result.id);
            if (wallet && wallet.status === 'CANDIDATE' &&
                wallet.winnerScanAppearances + 1 >= WALLET_ENGINE_CONFIG.FAST_TRACK_WINNER_SCANS) {
              await walletEngine.graduateWallet(result.id, 'MULTI_WINNER_DETECTED: appeared in multiple winner scans');
              logger.info({
                wallet: address.slice(0, 8),
                appearances: wallet.winnerScanAppearances + 1,
              }, 'OnchainDiscovery: Fast-tracked wallet to active');
            }
          }
        } catch (error) {
          logger.debug({ error, address: address.slice(0, 8) }, 'OnchainDiscovery: Error processing candidate');
        }
      }

      if (discoveredCount > 0) {
        logger.info({
          token: tokenAddress.slice(0, 8),
          discovered: discoveredCount,
        }, 'OnchainDiscovery: New candidates from winner scan');
      }
    } catch (error) {
      logger.error({ error, token: tokenAddress.slice(0, 8) }, 'OnchainDiscovery: Scan failed');
    }

    return discoveredCount;
  }

  /**
   * Extract buyer wallet addresses from a transaction's token balance changes
   */
  private extractBuyerWallets(txDetail: any, tokenAddress: string): string[] {
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

        // Token amount increased = buy
        if (postAmount > preAmount && postAmount > 0) {
          buyers.push(postBal.owner);
        }
      }
    } catch (error) {
      logger.debug({ error }, 'OnchainDiscovery: Error extracting buyers');
    }

    return buyers;
  }

  /**
   * Validate a candidate wallet meets basic requirements
   */
  private async validateCandidate(address: string): Promise<boolean> {
    try {
      // Skip if already tracked in any system
      const existing = await walletEngine.getWalletByAddress(address);
      if (existing && existing.status !== 'PURGED') return false;

      // Check if it's already an alpha wallet in the old system
      const alphaWallet = await Database.getAlphaWalletByAddress(address);
      if (alphaWallet) return false;

      // Check wallet activity — need minimum swap transactions
      const recentTxs = await heliusClient.getRecentTransactions(address, WALLET_ENGINE_CONFIG.ONCHAIN_MIN_SWAP_TRANSACTIONS);
      if (recentTxs.length < WALLET_ENGINE_CONFIG.ONCHAIN_MIN_SWAP_TRANSACTIONS) return false;

      // Check wallet age — skip fresh wallets
      if (recentTxs.length > 0) {
        const oldestTx = recentTxs[recentTxs.length - 1];
        if (oldestTx.blockTime) {
          const walletAgeDays = (Date.now() - oldestTx.blockTime * 1000) / (1000 * 60 * 60 * 24);
          if (walletAgeDays < WALLET_ENGINE_CONFIG.ONCHAIN_MIN_WALLET_AGE_DAYS) return false;
        }
      }

      return true;
    } catch (error) {
      logger.debug({ error, address: address.slice(0, 8) }, 'OnchainDiscovery: Validation error');
      return false;
    }
  }
}

// Singleton export
export const onchainDiscovery = new OnchainDiscovery();

export default onchainDiscovery;
