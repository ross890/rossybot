// ===========================================
// MODULE: CONVICTION TRACKER (Feature 2)
// Tracks when multiple KOLs buy the same token
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import type { KolBuyInfo, ConvictionLevel } from '../../types/index.js';

// ============ CONSTANTS ============

const HIGH_CONVICTION_THRESHOLD = 2;
const ULTRA_CONVICTION_THRESHOLD = 3;
const CONVICTION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============ CONVICTION TRACKER CLASS ============

export class ConvictionTracker {
  // In-memory cache: tokenMint -> Map<kolId, KolBuyInfo>
  private tokenBuyers: Map<string, Map<string, KolBuyInfo>> = new Map();

  /**
   * Record a KOL buy for a token
   */
  async recordBuy(
    tokenMint: string,
    kolId: string,
    kolName: string,
    walletAddress: string,
    solAmount?: number,
    txSignature?: string
  ): Promise<ConvictionLevel> {
    const timestamp = Date.now();

    // Update in-memory cache
    if (!this.tokenBuyers.has(tokenMint)) {
      this.tokenBuyers.set(tokenMint, new Map());
    }

    const tokenMap = this.tokenBuyers.get(tokenMint)!;
    const buyInfo: KolBuyInfo = {
      kolId,
      kolName,
      walletAddress,
      timestamp,
      solAmount,
      txSignature,
    };

    tokenMap.set(kolId, buyInfo);

    // Persist to database
    await this.saveBuyToDb(tokenMint, buyInfo);

    // Get conviction level
    const level = await this.getConvictionLevel(tokenMint);

    logger.info({
      tokenMint,
      kolName,
      convictionLevel: level.level,
      isHighConviction: level.isHighConviction,
      isUltraConviction: level.isUltraConviction,
    }, 'Recorded KOL buy for conviction tracking');

    return level;
  }

  /**
   * Get the conviction level for a token
   */
  async getConvictionLevel(tokenMint: string): Promise<ConvictionLevel> {
    // Clean expired entries first
    this.cleanExpiredEntries(tokenMint);

    // Check in-memory cache
    const tokenMap = this.tokenBuyers.get(tokenMint);
    let buyers: KolBuyInfo[] = [];

    if (tokenMap && tokenMap.size > 0) {
      buyers = Array.from(tokenMap.values());
    } else {
      // Fallback to database
      buyers = await this.getBuyersFromDb(tokenMint);
    }

    const level = buyers.length;
    const isHighConviction = level >= HIGH_CONVICTION_THRESHOLD;
    const isUltraConviction = level >= ULTRA_CONVICTION_THRESHOLD;

    return {
      tokenAddress: tokenMint,
      level,
      buyers,
      isHighConviction,
      isUltraConviction,
    };
  }

  /**
   * Get buyers for a specific token
   */
  async getBuyers(tokenMint: string): Promise<KolBuyInfo[]> {
    this.cleanExpiredEntries(tokenMint);

    const tokenMap = this.tokenBuyers.get(tokenMint);
    if (tokenMap && tokenMap.size > 0) {
      return Array.from(tokenMap.values());
    }

    return this.getBuyersFromDb(tokenMint);
  }

  /**
   * Get all tokens with high conviction (>= minKols KOLs)
   */
  async getHighConvictionTokens(minKols: number = HIGH_CONVICTION_THRESHOLD): Promise<string[]> {
    const highConvictionTokens: string[] = [];

    // Check in-memory cache
    for (const [tokenMint, buyerMap] of this.tokenBuyers.entries()) {
      this.cleanExpiredEntries(tokenMint);
      if (buyerMap.size >= minKols) {
        highConvictionTokens.push(tokenMint);
      }
    }

    // Also check database for tokens not in memory
    try {
      const result = await pool.query(
        `SELECT token_address, COUNT(DISTINCT kol_id) as kol_count
         FROM conviction_signals
         WHERE buy_timestamp > NOW() - INTERVAL '24 hours'
         GROUP BY token_address
         HAVING COUNT(DISTINCT kol_id) >= $1
         ORDER BY kol_count DESC`,
        [minKols]
      );

      for (const row of result.rows) {
        if (!highConvictionTokens.includes(row.token_address)) {
          highConvictionTokens.push(row.token_address);
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to get high conviction tokens from DB');
    }

    return highConvictionTokens;
  }

  /**
   * Get all high conviction tokens with full details
   */
  async getHighConvictionTokensWithDetails(minKols: number = HIGH_CONVICTION_THRESHOLD): Promise<ConvictionLevel[]> {
    const tokens = await this.getHighConvictionTokens(minKols);
    const results: ConvictionLevel[] = [];

    for (const tokenMint of tokens) {
      const level = await this.getConvictionLevel(tokenMint);
      if (level.level >= minKols) {
        results.push(level);
      }
    }

    // Sort by conviction level descending
    return results.sort((a, b) => b.level - a.level);
  }

  /**
   * Clean expired entries from cache
   */
  private cleanExpiredEntries(tokenMint: string): void {
    const tokenMap = this.tokenBuyers.get(tokenMint);
    if (!tokenMap) return;

    const now = Date.now();
    const cutoff = now - CONVICTION_WINDOW_MS;

    for (const [kolId, buyInfo] of tokenMap.entries()) {
      if (buyInfo.timestamp < cutoff) {
        tokenMap.delete(kolId);
      }
    }

    // Remove empty maps
    if (tokenMap.size === 0) {
      this.tokenBuyers.delete(tokenMint);
    }
  }

  /**
   * Save buy to database
   */
  private async saveBuyToDb(tokenMint: string, buyInfo: KolBuyInfo): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO conviction_signals (
          token_address, kol_id, wallet_address, kol_name,
          buy_timestamp, sol_amount, tx_signature
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING`,
        [
          tokenMint,
          buyInfo.kolId,
          buyInfo.walletAddress,
          buyInfo.kolName,
          new Date(buyInfo.timestamp),
          buyInfo.solAmount || null,
          buyInfo.txSignature || null,
        ]
      );
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to save conviction buy to DB');
    }
  }

  /**
   * Get buyers from database
   */
  private async getBuyersFromDb(tokenMint: string): Promise<KolBuyInfo[]> {
    try {
      const result = await pool.query(
        `SELECT kol_id, kol_name, wallet_address, buy_timestamp, sol_amount, tx_signature
         FROM conviction_signals
         WHERE token_address = $1 AND buy_timestamp > NOW() - INTERVAL '24 hours'
         ORDER BY buy_timestamp DESC`,
        [tokenMint]
      );

      return result.rows.map(row => ({
        kolId: row.kol_id,
        kolName: row.kol_name,
        walletAddress: row.wallet_address,
        timestamp: new Date(row.buy_timestamp).getTime(),
        solAmount: row.sol_amount ? parseFloat(row.sol_amount) : undefined,
        txSignature: row.tx_signature || undefined,
      }));
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to get conviction buyers from DB');
      return [];
    }
  }

  /**
   * Clean old entries from database
   */
  async cleanOldEntries(): Promise<void> {
    try {
      await pool.query(
        `DELETE FROM conviction_signals WHERE buy_timestamp < NOW() - INTERVAL '7 days'`
      );
    } catch (error) {
      logger.warn({ error }, 'Failed to clean old conviction entries');
    }
  }

  /**
   * Format conviction alert message
   */
  formatConvictionAlert(conviction: ConvictionLevel, tokenTicker?: string): string {
    const ticker = tokenTicker ? `$${tokenTicker}` : conviction.tokenAddress.slice(0, 8);
    const kolNames = conviction.buyers.map(b => b.kolName).join(', ');

    if (conviction.isUltraConviction) {
      return `ULTRA CONVICTION: ${conviction.level} KOLs bought ${ticker} (${kolNames})`;
    } else if (conviction.isHighConviction) {
      return `HIGH CONVICTION: ${conviction.level} KOLs bought ${ticker} (${kolNames})`;
    }

    return `${conviction.level} KOL(s) bought ${ticker}`;
  }
}

// ============ EXPORTS ============

export const convictionTracker = new ConvictionTracker();

export default {
  ConvictionTracker,
  convictionTracker,
  HIGH_CONVICTION_THRESHOLD,
  ULTRA_CONVICTION_THRESHOLD,
};
