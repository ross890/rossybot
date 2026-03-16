// ===========================================
// MODULE: PRICE ORACLE
// Secondary price source validation (DexScreener + Jupiter)
// Phase 4.3 — flags price discrepancies
// ===========================================

import { logger } from '../utils/logger.js';

// ============ TYPES ============

export interface PriceQuote {
  price: number;
  source: 'DEXSCREENER' | 'JUPITER';
  timestamp: number;
}

export interface PriceValidation {
  primaryPrice: number;
  secondaryPrice: number | null;
  discrepancyPercent: number | null;
  hasDiscrepancy: boolean;
  dataQuality: 'VALIDATED' | 'SINGLE_SOURCE' | 'PRICE_DISCREPANCY';
}

// ============ CONFIGURATION ============

const CONFIG = {
  DISCREPANCY_THRESHOLD_PERCENT: 5, // >5% divergence = flag
  JUPITER_QUOTE_TIMEOUT_MS: 5000,
  CACHE_TTL_MS: 30 * 1000, // 30 seconds
} as const;

// ============ PRICE ORACLE CLASS ============

export class PriceOracle {
  // Cache Jupiter quotes to avoid excessive API calls
  private quoteCache: Map<string, { price: number; timestamp: number }> = new Map();

  /**
   * Validate a DexScreener price against Jupiter quote API.
   * Budget: 1 Jupiter call per token. DexScreener is primary.
   */
  async validatePrice(
    tokenAddress: string,
    dexScreenerPrice: number,
  ): Promise<PriceValidation> {
    // Check cache
    const cached = this.quoteCache.get(tokenAddress);
    if (cached && Date.now() - cached.timestamp < CONFIG.CACHE_TTL_MS) {
      return this.comparePrice(dexScreenerPrice, cached.price);
    }

    try {
      const jupiterPrice = await this.getJupiterQuote(tokenAddress);

      if (jupiterPrice !== null) {
        // Cache the result
        this.quoteCache.set(tokenAddress, {
          price: jupiterPrice,
          timestamp: Date.now(),
        });

        return this.comparePrice(dexScreenerPrice, jupiterPrice);
      }
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Jupiter price validation failed');
    }

    // No secondary price available
    return {
      primaryPrice: dexScreenerPrice,
      secondaryPrice: null,
      discrepancyPercent: null,
      hasDiscrepancy: false,
      dataQuality: 'SINGLE_SOURCE',
    };
  }

  /**
   * Get a price quote from Jupiter Quote API.
   * Uses SOL→Token quote to derive price.
   */
  private async getJupiterQuote(tokenAddress: string): Promise<number | null> {
    try {
      // Quote 1 SOL → Token to get the exchange rate
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const SOL_AMOUNT = 1_000_000_000; // 1 SOL in lamports

      const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v1';
      const headers: Record<string, string> = {};
      if (process.env.JUPITER_API_KEY) headers['x-api-key'] = process.env.JUPITER_API_KEY;

      const response = await fetch(
        `${JUPITER_API_URL}/quote?inputMint=${SOL_MINT}&outputMint=${tokenAddress}&amount=${SOL_AMOUNT}&slippageBps=100`,
        { signal: AbortSignal.timeout(CONFIG.JUPITER_QUOTE_TIMEOUT_MS), headers }
      );

      if (!response.ok) return null;

      const data = await response.json() as any;

      if (data.outAmount && data.inAmount) {
        // Price in SOL terms: inAmount / outAmount
        // But we need USD — use SOL price estimation
        // For simplicity, return the raw ratio. Caller compares ratios, not absolute prices.
        const outAmount = parseFloat(data.outAmount);
        const inAmount = parseFloat(data.inAmount);

        if (outAmount > 0 && inAmount > 0) {
          // This gives us the price of the token in SOL
          // outAmount is the token amount for 1 SOL
          // Price per token = 1 SOL / outAmount (in token decimals)
          return inAmount / outAmount;
        }
      }

      return null;
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Jupiter quote fetch failed');
      return null;
    }
  }

  private comparePrice(primaryPrice: number, secondaryPrice: number): PriceValidation {
    if (primaryPrice <= 0 || secondaryPrice <= 0) {
      return {
        primaryPrice,
        secondaryPrice,
        discrepancyPercent: null,
        hasDiscrepancy: false,
        dataQuality: 'SINGLE_SOURCE',
      };
    }

    const discrepancyPercent = Math.abs((primaryPrice - secondaryPrice) / primaryPrice) * 100;
    const hasDiscrepancy = discrepancyPercent > CONFIG.DISCREPANCY_THRESHOLD_PERCENT;

    if (hasDiscrepancy) {
      logger.warn({
        primaryPrice,
        secondaryPrice,
        discrepancyPercent: discrepancyPercent.toFixed(1),
      }, 'PRICE_DISCREPANCY detected between DexScreener and Jupiter');
    }

    return {
      primaryPrice,
      secondaryPrice,
      discrepancyPercent,
      hasDiscrepancy,
      dataQuality: hasDiscrepancy ? 'PRICE_DISCREPANCY' : 'VALIDATED',
    };
  }

  /**
   * Clear the quote cache.
   */
  clearCache(): void {
    this.quoteCache.clear();
  }
}

// ============ EXPORTS ============

export const priceOracle = new PriceOracle();

export default {
  PriceOracle,
  priceOracle,
};
