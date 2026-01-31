// ===========================================
// MODULE: KOL SELL DETECTOR (Feature 3)
// Detects KOL sells and exit signals
// ===========================================

import { Connection, PublicKey } from '@solana/web3.js';
import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { Database } from '../../utils/database.js';
import {
  TradeType,
} from '../../types/index.js';
import type {
  Kol,
  KolWallet,
  KolActivity,
  AggregatedExitSignal,
} from '../../types/index.js';

// ============ CONSTANTS ============

const FULL_EXIT_THRESHOLD = 0.95; // 95% sold = full exit
const SIGNIFICANT_SELL_THRESHOLD = 0.25; // 25%+ = significant sell

// ============ SELL DETECTOR CLASS ============

export class KolSellDetector {
  private connection: Connection;

  // Track KOL positions: tokenMint -> Map<kolId, balance>
  private kolPositions: Map<string, Map<string, number>> = new Map();

  // Track sell history: tokenMint -> KolActivity[]
  private recentSells: Map<string, KolActivity[]> = new Map();

  constructor() {
    this.connection = new Connection(appConfig.heliusRpcUrl, 'confirmed');
  }

  /**
   * Record a KOL's position in a token
   */
  recordPosition(tokenMint: string, kolId: string, balance: number): void {
    if (!this.kolPositions.has(tokenMint)) {
      this.kolPositions.set(tokenMint, new Map());
    }
    this.kolPositions.get(tokenMint)!.set(kolId, balance);
  }

  /**
   * Get KOL's recorded position in a token
   */
  getPosition(tokenMint: string, kolId: string): number {
    return this.kolPositions.get(tokenMint)?.get(kolId) || 0;
  }

  /**
   * Detect sell activity from transaction details
   */
  async detectSell(
    txDetails: any,
    tokenMint: string,
    walletAddress: string,
    walletInfo: KolWallet & { kol: Kol }
  ): Promise<KolActivity | null> {
    try {
      // Parse token balance changes
      const preBalances = txDetails.meta?.preTokenBalances || [];
      const postBalances = txDetails.meta?.postTokenBalances || [];

      let tokensBefore = 0;
      let tokensAfter = 0;
      let solReceived = 0;

      // Find token balances for this wallet
      for (const preBal of preBalances) {
        if (preBal.mint === tokenMint && preBal.owner === walletAddress) {
          tokensBefore = preBal.uiTokenAmount?.uiAmount || 0;
        }
      }

      for (const postBal of postBalances) {
        if (postBal.mint === tokenMint && postBal.owner === walletAddress) {
          tokensAfter = postBal.uiTokenAmount?.uiAmount || 0;
        }
      }

      // Calculate tokens sold
      const tokensSold = tokensBefore - tokensAfter;
      if (tokensSold <= 0) {
        return null; // Not a sell
      }

      // Calculate SOL received
      const accountKeys = txDetails.transaction?.message?.accountKeys || [];
      const walletIndex = accountKeys.findIndex((k: any) =>
        (typeof k === 'string' ? k : k.pubkey) === walletAddress
      );

      if (walletIndex >= 0) {
        const preSol = txDetails.meta?.preBalances?.[walletIndex] || 0;
        const postSol = txDetails.meta?.postBalances?.[walletIndex] || 0;
        solReceived = (postSol - preSol) / 1e9;
      }

      // Calculate percentage sold
      const previousPosition = this.getPosition(tokenMint, walletInfo.kolId);
      const percentSold = previousPosition > 0
        ? (tokensSold / previousPosition) * 100
        : (tokensBefore > 0 ? (tokensSold / tokensBefore) * 100 : 0);

      const isFullExit = percentSold >= FULL_EXIT_THRESHOLD * 100;

      // Update position tracking
      this.recordPosition(tokenMint, walletInfo.kolId, tokensAfter);

      const activity: KolActivity = {
        type: TradeType.SELL,
        kol: walletInfo.kol,
        wallet: walletInfo,
        tokenAddress: tokenMint,
        solAmount: Math.max(0, solReceived),
        tokenAmount: tokensSold,
        percentSold,
        isFullExit,
        timestamp: new Date(txDetails.blockTime * 1000),
        txSignature: txDetails.transaction?.signatures?.[0] || '',
      };

      // Track recent sells
      this.recordSell(tokenMint, activity);

      logger.info({
        tokenMint,
        kolName: walletInfo.kol.handle,
        percentSold: percentSold.toFixed(1),
        isFullExit,
        tokensSold,
        solReceived,
      }, 'KOL sell detected');

      return activity;
    } catch (error) {
      logger.warn({ error, tokenMint, walletAddress }, 'Failed to detect sell');
      return null;
    }
  }

  /**
   * Check for sell activity in a transaction
   */
  isSellTransaction(
    txDetails: any,
    tokenMint: string,
    walletAddress: string
  ): boolean {
    try {
      const preBalances = txDetails.meta?.preTokenBalances || [];
      const postBalances = txDetails.meta?.postTokenBalances || [];

      let tokensBefore = 0;
      let tokensAfter = 0;

      for (const preBal of preBalances) {
        if (preBal.mint === tokenMint && preBal.owner === walletAddress) {
          tokensBefore = preBal.uiTokenAmount?.uiAmount || 0;
        }
      }

      for (const postBal of postBalances) {
        if (postBal.mint === tokenMint && postBal.owner === walletAddress) {
          tokensAfter = postBal.uiTokenAmount?.uiAmount || 0;
        }
      }

      return tokensBefore > tokensAfter;
    } catch {
      return false;
    }
  }

  /**
   * Record a sell for aggregation
   */
  private recordSell(tokenMint: string, activity: KolActivity): void {
    if (!this.recentSells.has(tokenMint)) {
      this.recentSells.set(tokenMint, []);
    }

    const sells = this.recentSells.get(tokenMint)!;
    sells.push(activity);

    // Keep only last 24 hours of sells
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.recentSells.set(
      tokenMint,
      sells.filter(s => s.timestamp.getTime() > cutoff)
    );
  }

  /**
   * Get aggregated exit signal for a token
   */
  async getAggregatedExitSignal(
    tokenMint: string,
    trackedWallets: Map<string, KolWallet & { kol: Kol }>
  ): Promise<AggregatedExitSignal | null> {
    const sells = this.recentSells.get(tokenMint) || [];
    const exitedKols = new Set<string>();
    const holdingKols = new Set<string>();

    // Track which KOLs have exited (full or significant)
    for (const sell of sells) {
      if (sell.isFullExit || (sell.percentSold && sell.percentSold >= 50)) {
        exitedKols.add(sell.kol.handle);
      }
    }

    // Check current positions to find who's still holding
    for (const [walletAddress, walletInfo] of trackedWallets) {
      try {
        const balance = await this.getTokenBalance(walletAddress, tokenMint);
        if (balance > 0) {
          holdingKols.add(walletInfo.kol.handle);
        }
      } catch {
        // Skip on error
      }
    }

    // Remove holding KOLs from exited set if they rebought
    for (const holding of holdingKols) {
      exitedKols.delete(holding);
    }

    if (exitedKols.size === 0) {
      return null;
    }

    return {
      tokenAddress: tokenMint,
      tokenTicker: '', // Would need to look this up
      totalKolsExited: exitedKols.size,
      totalKolsHolding: holdingKols.size,
      exitedKols: Array.from(exitedKols),
      holdingKols: Array.from(holdingKols),
    };
  }

  /**
   * Get token balance for a wallet
   */
  private async getTokenBalance(
    walletAddress: string,
    tokenMint: string
  ): Promise<number> {
    try {
      const walletPubkey = new PublicKey(walletAddress);
      const mintPubkey = new PublicKey(tokenMint);

      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        walletPubkey,
        { mint: mintPubkey }
      );

      if (tokenAccounts.value.length === 0) {
        return 0;
      }

      return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Check if multiple KOLs have exited a token
   */
  async checkMassExit(
    tokenMint: string,
    trackedWallets: Map<string, KolWallet & { kol: Kol }>,
    minExiters: number = 3
  ): Promise<boolean> {
    const exitSignal = await this.getAggregatedExitSignal(tokenMint, trackedWallets);
    return exitSignal !== null && exitSignal.totalKolsExited >= minExiters;
  }

  /**
   * Format sell alert message
   */
  formatSellAlert(activity: KolActivity): string {
    const ticker = activity.tokenTicker ? `$${activity.tokenTicker}` : activity.tokenAddress.slice(0, 8);

    if (activity.isFullExit) {
      return `KOL ${activity.kol.handle} FULL EXIT from ${ticker}`;
    }

    return `KOL ${activity.kol.handle} just SOLD ${activity.percentSold?.toFixed(0)}% of ${ticker}`;
  }

  /**
   * Format aggregated exit alert
   */
  formatAggregatedExitAlert(signal: AggregatedExitSignal): string {
    const ticker = signal.tokenTicker || signal.tokenAddress.slice(0, 8);
    const total = signal.totalKolsExited + signal.totalKolsHolding;

    return `${signal.totalKolsExited}/${total} tracked KOLs have now exited ${ticker}`;
  }

  /**
   * Determine if sell is significant enough to alert
   */
  isSignificantSell(activity: KolActivity): boolean {
    // Full exits are always significant
    if (activity.isFullExit) {
      return true;
    }

    // Sells of 25%+ are significant
    if (activity.percentSold && activity.percentSold >= SIGNIFICANT_SELL_THRESHOLD * 100) {
      return true;
    }

    return false;
  }

  /**
   * Clear old data
   */
  cleanup(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    for (const [tokenMint, sells] of this.recentSells) {
      const filtered = sells.filter(s => s.timestamp.getTime() > cutoff);
      if (filtered.length === 0) {
        this.recentSells.delete(tokenMint);
      } else {
        this.recentSells.set(tokenMint, filtered);
      }
    }
  }
}

// ============ EXPORTS ============

export const kolSellDetector = new KolSellDetector();

export default {
  KolSellDetector,
  kolSellDetector,
  FULL_EXIT_THRESHOLD,
  SIGNIFICANT_SELL_THRESHOLD,
};
