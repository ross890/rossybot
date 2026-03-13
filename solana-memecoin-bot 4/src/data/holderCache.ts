// ===========================================
// MODULE: ADAPTIVE HOLDER CACHE
// Token-age-based cache TTL for holder data
// Phase 4.3 — faster data for new launches
// ===========================================

import { logger } from '../utils/logger.js';

// ============ TYPES ============

interface CachedHolderData {
  data: any;
  cachedAt: number;
  tokenAgeMinutes: number;
}

// ============ CONFIGURATION ============

const CONFIG = {
  // Adaptive TTL based on token age
  FAST_LAUNCH_AGE_MIN: 15,        // Token < 15 min old
  FAST_LAUNCH_TTL_MS: 15 * 1000,  // 15 second cache

  MEDIUM_AGE_MIN: 60,             // Token 15-60 min old
  MEDIUM_TTL_MS: 30 * 1000,       // 30 second cache

  DEFAULT_TTL_MS: 60 * 1000,      // 60 second cache (token > 60 min)

  // Cache size limit
  MAX_ENTRIES: 500,
} as const;

// ============ HOLDER CACHE CLASS ============

export class HolderCache {
  private cache: Map<string, CachedHolderData> = new Map();

  /**
   * Get cached holder data if still valid based on token age.
   */
  get(tokenAddress: string, tokenAgeMinutes: number): any | null {
    const cached = this.cache.get(tokenAddress);
    if (!cached) return null;

    const ttl = this.getTTL(tokenAgeMinutes);
    const age = Date.now() - cached.cachedAt;

    if (age > ttl) {
      this.cache.delete(tokenAddress);
      return null;
    }

    return cached.data;
  }

  /**
   * Store holder data with the appropriate TTL based on token age.
   */
  set(tokenAddress: string, data: any, tokenAgeMinutes: number): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= CONFIG.MAX_ENTRIES) {
      const oldest = Array.from(this.cache.entries())
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt);
      const toRemove = oldest.slice(0, Math.floor(CONFIG.MAX_ENTRIES * 0.2));
      for (const [key] of toRemove) {
        this.cache.delete(key);
      }
    }

    this.cache.set(tokenAddress, {
      data,
      cachedAt: Date.now(),
      tokenAgeMinutes,
    });
  }

  /**
   * Get the TTL for a given token age.
   */
  getTTL(tokenAgeMinutes: number): number {
    if (tokenAgeMinutes < CONFIG.FAST_LAUNCH_AGE_MIN) {
      return CONFIG.FAST_LAUNCH_TTL_MS;
    }
    if (tokenAgeMinutes < CONFIG.MEDIUM_AGE_MIN) {
      return CONFIG.MEDIUM_TTL_MS;
    }
    return CONFIG.DEFAULT_TTL_MS;
  }

  /**
   * Get cache statistics.
   */
  getStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: CONFIG.MAX_ENTRIES,
    };
  }

  /**
   * Clear all cached data.
   */
  clear(): void {
    this.cache.clear();
  }
}

// ============ EXPORTS ============

export const holderCache = new HolderCache();

export default {
  HolderCache,
  holderCache,
};
