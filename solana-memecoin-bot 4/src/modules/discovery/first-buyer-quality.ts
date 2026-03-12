// ===========================================
// MODULE: FIRST BUYER QUALITY INDEX
// Scores the first N buyers of a token by their historical
// win rate and PnL to distinguish organic launches from pump-and-dumps.
// ===========================================

import { logger } from '../../utils/logger.js';
import { heliusClient } from '../onchain.js';
import { pool } from '../../utils/database.js';

// ============ TYPES ============

export interface FirstBuyerQuality {
  tokenAddress: string;
  buyersAnalyzed: number;
  buyersWithHistory: number;         // How many had prior trade history
  freshWalletPercent: number;        // % of buyers that are brand new wallets
  collectiveWinRate: number;         // Weighted avg win rate of buyers with history
  avgPnl: number;                    // Average PnL across buyers with history
  highPnlBuyers: number;            // Buyers with >$10K historical PnL
  knownDumperCount: number;          // Buyers flagged as serial dumpers
  score: number;                     // 0-100 composite quality score
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  flags: string[];
}

interface BuyerProfile {
  address: string;
  totalTrades: number;
  wins: number;
  winRate: number;
  avgRoi: number;
  isFreshWallet: boolean;           // < 5 total trades ever
  isKnownDumper: boolean;           // High sell frequency, low hold time
}

// ============ CONSTANTS ============

// How many early buyers to analyze
const BUYERS_TO_ANALYZE = 50;

// Cache buyer profiles to reduce API calls
const BUYER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const BUYER_CACHE_MAX_SIZE = 2000;

// Thresholds
const FRESH_WALLET_MAX_TRADES = 5;
const DUMPER_MIN_TRADES = 10;
const DUMPER_MAX_AVG_HOLD_HOURS = 1;    // Holds less than 1 hour on average
const HIGH_PNL_THRESHOLD = 10_000;       // $10K+ total PnL

// ============ FIRST BUYER QUALITY CLASS ============

class FirstBuyerQualityAnalyzer {
  // Cache buyer wallet profiles
  private buyerCache: Map<string, { profile: BuyerProfile; expiry: number }> = new Map();

  /**
   * Analyze the first buyers of a token and return a quality score.
   */
  async analyze(tokenAddress: string): Promise<FirstBuyerQuality> {
    const flags: string[] = [];

    try {
      // Get early transactions for this token
      const earlyBuyers = await this.getEarlyBuyers(tokenAddress);

      if (earlyBuyers.length === 0) {
        return this.emptyResult(tokenAddress);
      }

      // Profile each buyer (cached)
      const profiles: BuyerProfile[] = [];
      for (const buyer of earlyBuyers.slice(0, BUYERS_TO_ANALYZE)) {
        const profile = await this.profileBuyer(buyer);
        profiles.push(profile);
      }

      // Calculate metrics
      const freshWallets = profiles.filter(p => p.isFreshWallet);
      const freshWalletPercent = (freshWallets.length / profiles.length) * 100;
      const withHistory = profiles.filter(p => !p.isFreshWallet && p.totalTrades >= FRESH_WALLET_MAX_TRADES);
      const dumpers = profiles.filter(p => p.isKnownDumper);
      const highPnl = withHistory.filter(p => p.avgRoi > HIGH_PNL_THRESHOLD / 100);

      // Collective win rate (weighted by trade count for experienced wallets)
      let collectiveWinRate = 0;
      if (withHistory.length > 0) {
        const totalWeight = withHistory.reduce((s, p) => s + p.totalTrades, 0);
        collectiveWinRate = totalWeight > 0
          ? withHistory.reduce((s, p) => s + p.winRate * p.totalTrades, 0) / totalWeight
          : 0;
      }

      const avgPnl = withHistory.length > 0
        ? withHistory.reduce((s, p) => s + p.avgRoi, 0) / withHistory.length
        : 0;

      // Build flags
      if (freshWalletPercent > 60) flags.push(`${freshWalletPercent.toFixed(0)}% fresh wallets`);
      if (dumpers.length >= 3) flags.push(`${dumpers.length} known dumpers`);
      if (collectiveWinRate > 0.5) flags.push(`Strong buyers (${(collectiveWinRate * 100).toFixed(0)}% WR)`);
      if (highPnl.length >= 3) flags.push(`${highPnl.length} high-PnL wallets`);

      // Score calculation
      const score = this.calculateScore(
        freshWalletPercent,
        collectiveWinRate,
        dumpers.length,
        highPnl.length,
        withHistory.length,
        profiles.length
      );

      const grade = score >= 75 ? 'A' as const :
                    score >= 55 ? 'B' as const :
                    score >= 40 ? 'C' as const :
                    score >= 25 ? 'D' as const : 'F' as const;

      return {
        tokenAddress,
        buyersAnalyzed: profiles.length,
        buyersWithHistory: withHistory.length,
        freshWalletPercent,
        collectiveWinRate,
        avgPnl,
        highPnlBuyers: highPnl.length,
        knownDumperCount: dumpers.length,
        score,
        grade,
        flags,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'First buyer quality analysis failed');
      return this.emptyResult(tokenAddress);
    }
  }

  /**
   * Get the earliest buyers of a token from on-chain transactions.
   */
  private async getEarlyBuyers(tokenAddress: string): Promise<string[]> {
    try {
      const txs = await heliusClient.getRecentTransactions(tokenAddress, 100);
      if (!txs || txs.length === 0) return [];

      // Sort oldest first, extract unique buyer addresses
      const sorted = txs
        .filter((tx: any) => tx.type === 'SWAP' || tx.type === 'TRANSFER')
        .sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));

      const buyers = new Set<string>();
      for (const tx of sorted) {
        // Look for the fee payer (the buyer) in swap transactions
        const feePayer = tx.feePayer;
        if (feePayer && buyers.size < BUYERS_TO_ANALYZE) {
          buyers.add(feePayer);
        }
      }

      return Array.from(buyers);
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get early buyers');
      return [];
    }
  }

  /**
   * Profile a buyer wallet by checking their trade history.
   */
  private async profileBuyer(walletAddress: string): Promise<BuyerProfile> {
    // Check cache
    const cached = this.buyerCache.get(walletAddress);
    if (cached && cached.expiry > Date.now()) {
      return cached.profile;
    }

    try {
      // Check if this wallet exists in our alpha_wallet_trades (fastest path)
      const alphaResult = await pool.query(`
        SELECT
          COUNT(*) as total_trades,
          COUNT(*) FILTER (WHERE is_win = true) as wins,
          AVG(roi) FILTER (WHERE roi IS NOT NULL) as avg_roi,
          AVG(hold_time_hours) FILTER (WHERE hold_time_hours IS NOT NULL) as avg_hold
        FROM alpha_wallet_trades
        WHERE wallet_address = $1
      `, [walletAddress]);

      const row = alphaResult.rows[0];
      const totalTrades = parseInt(row.total_trades) || 0;
      const wins = parseInt(row.wins) || 0;

      // If we have no data, check on-chain transaction count
      if (totalTrades === 0) {
        const txs = await heliusClient.getRecentTransactions(walletAddress, 10);
        const txCount = txs?.length || 0;
        const profile: BuyerProfile = {
          address: walletAddress,
          totalTrades: txCount,
          wins: 0,
          winRate: 0,
          avgRoi: 0,
          isFreshWallet: txCount < FRESH_WALLET_MAX_TRADES,
          isKnownDumper: false,
        };
        this.cacheProfile(walletAddress, profile);
        return profile;
      }

      const winRate = totalTrades > 0 ? wins / totalTrades : 0;
      const avgRoi = parseFloat(row.avg_roi) || 0;
      const avgHold = parseFloat(row.avg_hold) || 0;

      const profile: BuyerProfile = {
        address: walletAddress,
        totalTrades,
        wins,
        winRate,
        avgRoi,
        isFreshWallet: totalTrades < FRESH_WALLET_MAX_TRADES,
        isKnownDumper: totalTrades >= DUMPER_MIN_TRADES && avgHold < DUMPER_MAX_AVG_HOLD_HOURS,
      };

      this.cacheProfile(walletAddress, profile);
      return profile;
    } catch (error) {
      return {
        address: walletAddress,
        totalTrades: 0,
        wins: 0,
        winRate: 0,
        avgRoi: 0,
        isFreshWallet: true,
        isKnownDumper: false,
      };
    }
  }

  private cacheProfile(address: string, profile: BuyerProfile): void {
    // Evict oldest if cache is full
    if (this.buyerCache.size >= BUYER_CACHE_MAX_SIZE) {
      const oldest = this.buyerCache.keys().next().value;
      if (oldest) this.buyerCache.delete(oldest);
    }
    this.buyerCache.set(address, { profile, expiry: Date.now() + BUYER_CACHE_TTL_MS });
  }

  private calculateScore(
    freshWalletPercent: number,
    collectiveWinRate: number,
    dumperCount: number,
    highPnlCount: number,
    withHistoryCount: number,
    totalAnalyzed: number
  ): number {
    let score = 50; // Start neutral

    // Fresh wallet penalty (high % = pump and dump setup)
    if (freshWalletPercent > 70) score -= 30;
    else if (freshWalletPercent > 50) score -= 15;
    else if (freshWalletPercent < 30) score += 10;

    // Collective win rate bonus
    if (collectiveWinRate > 0.6) score += 25;
    else if (collectiveWinRate > 0.4) score += 15;
    else if (collectiveWinRate > 0.3) score += 5;
    else if (collectiveWinRate < 0.2 && withHistoryCount > 5) score -= 15;

    // Dumper penalty
    score -= dumperCount * 8;

    // High PnL buyers bonus
    score += Math.min(20, highPnlCount * 7);

    // Data quality: more wallets with history = more confident
    if (withHistoryCount >= 10) score += 5;
    else if (withHistoryCount < 3) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  private emptyResult(tokenAddress: string): FirstBuyerQuality {
    return {
      tokenAddress,
      buyersAnalyzed: 0,
      buyersWithHistory: 0,
      freshWalletPercent: 0,
      collectiveWinRate: 0,
      avgPnl: 0,
      highPnlBuyers: 0,
      knownDumperCount: 0,
      score: 50, // Neutral when no data
      grade: 'C',
      flags: ['No buyer data available'],
    };
  }
}

export const firstBuyerQuality = new FirstBuyerQualityAnalyzer();
