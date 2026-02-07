// ===========================================
// SHARED RATE LIMITER UTILITY
// Used by DexScreener, RugCheck, SolanaFM, Solana RPC
// ===========================================

import { logger } from './logger.js';
import { pool } from './database.js';

// ============ TYPES ============

export interface RateLimiterConfig {
  serviceName: string;
  maxRequestsPerMinute: number;
  minDelayBetweenRequests: number; // ms
  backoffMultiplier: number;
  maxBackoff: number; // ms
  maxRetries: number;
}

interface QueueItem<T> {
  resolve: (value: T) => void;
  reject: (error: any) => void;
  request: () => Promise<T>;
  endpoint: string;
  retryCount: number;
}

// ============ RATE LIMITER CLASS ============

export class RateLimiter {
  private config: RateLimiterConfig;
  private requestCount = 0;
  private windowStartTime = Date.now();
  private lastRequestTime = 0;
  private queue: QueueItem<any>[] = [];
  private isProcessing = false;
  private currentBackoff = 0;

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  /**
   * Execute a request with rate limiting, retry logic, and API logging
   */
  async execute<T>(
    request: () => Promise<T>,
    endpoint: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, request, endpoint, retryCount: 0 });
      this.processQueue();
    });
  }

  /**
   * Process the request queue respecting rate limits
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      // Reset window counter every 60 seconds
      const now = Date.now();
      if (now - this.windowStartTime >= 60000) {
        this.requestCount = 0;
        this.windowStartTime = now;
      }

      // If we've hit the per-minute limit, wait until next window
      if (this.requestCount >= this.config.maxRequestsPerMinute) {
        const waitTime = 60000 - (now - this.windowStartTime);
        if (waitTime > 0) {
          logger.debug({
            service: this.config.serviceName,
            waitMs: waitTime,
            queueSize: this.queue.length,
          }, 'Rate limit reached, waiting for next window');
          await this.sleep(waitTime);
        }
        this.requestCount = 0;
        this.windowStartTime = Date.now();
      }

      // Enforce minimum delay between requests
      const timeSinceLastRequest = Date.now() - this.lastRequestTime;
      const minDelay = this.config.minDelayBetweenRequests + this.currentBackoff;
      if (timeSinceLastRequest < minDelay) {
        await this.sleep(minDelay - timeSinceLastRequest);
      }

      // Process next request
      const item = this.queue.shift();
      if (!item) break;

      this.requestCount++;
      this.lastRequestTime = Date.now();

      const startTime = Date.now();
      try {
        const result = await item.request();
        const responseTime = Date.now() - startTime;

        // Reset backoff on success
        this.currentBackoff = 0;

        // Log API call
        this.logApiCall(item.endpoint, 200, responseTime);

        item.resolve(result);
      } catch (error: any) {
        const responseTime = Date.now() - startTime;
        const status = error?.response?.status || 0;

        // Log the failed call
        this.logApiCall(item.endpoint, status, responseTime);

        if (status === 429 && item.retryCount < this.config.maxRetries) {
          // Rate limited — exponential backoff and re-queue
          item.retryCount++;
          const backoff = Math.min(
            this.config.minDelayBetweenRequests * Math.pow(this.config.backoffMultiplier, item.retryCount),
            this.config.maxBackoff
          );
          this.currentBackoff = backoff;

          logger.warn({
            service: this.config.serviceName,
            endpoint: item.endpoint,
            retry: item.retryCount,
            backoffMs: backoff,
          }, 'Rate limited (429), backing off');

          // Put back at front of queue
          this.queue.unshift(item);
          await this.sleep(backoff);
        } else if (item.retryCount < this.config.maxRetries && status >= 500) {
          // Server error — retry with backoff
          item.retryCount++;
          const backoff = Math.min(
            2000 * Math.pow(2, item.retryCount - 1),
            this.config.maxBackoff
          );

          logger.warn({
            service: this.config.serviceName,
            endpoint: item.endpoint,
            status,
            retry: item.retryCount,
          }, 'Server error, retrying');

          this.queue.unshift(item);
          await this.sleep(backoff);
        } else {
          item.reject(error);
        }
      }
    }

    this.isProcessing = false;
  }

  /**
   * Log API call to the api_log table (fire and forget)
   */
  private logApiCall(endpoint: string, statusCode: number, responseTimeMs: number): void {
    pool.query(
      `INSERT INTO api_log (service, endpoint, status_code, response_time_ms)
       VALUES ($1, $2, $3, $4)`,
      [this.config.serviceName, endpoint.slice(0, 256), statusCode, responseTimeMs]
    ).catch(err => {
      logger.debug({ err, service: this.config.serviceName }, 'Failed to log API call');
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current queue depth (for monitoring)
   */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /**
   * Get requests remaining in current window
   */
  getRemainingRequests(): number {
    const now = Date.now();
    if (now - this.windowStartTime >= 60000) {
      return this.config.maxRequestsPerMinute;
    }
    return Math.max(0, this.config.maxRequestsPerMinute - this.requestCount);
  }
}

// ============ TTL CACHE ============

export class TTLCache<T> {
  private cache: Map<string, { data: T; expiry: number }> = new Map();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;

    // Clean up expired entries every 2 minutes
    setInterval(() => this.cleanup(), 2 * 60 * 1000);
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiry < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: T, ttlMs: number): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      data,
      expiry: Date.now() + ttlMs,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  size(): number {
    return this.cache.size;
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.cache) {
      if (value.expiry < now) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: this.cache.size }, 'TTLCache cleanup');
    }
  }
}

// ============ PRE-CONFIGURED RATE LIMITERS ============

export const dexScreenerRateLimiter = new RateLimiter({
  serviceName: 'dexscreener',
  maxRequestsPerMinute: 30,
  minDelayBetweenRequests: 2000,
  backoffMultiplier: 2,
  maxBackoff: 60000,
  maxRetries: 5,
});

export const rugCheckRateLimiter = new RateLimiter({
  serviceName: 'rugcheck',
  maxRequestsPerMinute: 30,
  minDelayBetweenRequests: 2000,
  backoffMultiplier: 2,
  maxBackoff: 60000,
  maxRetries: 3,
});

export const solanaFmRateLimiter = new RateLimiter({
  serviceName: 'solanafm',
  maxRequestsPerMinute: 20,
  minDelayBetweenRequests: 3000,
  backoffMultiplier: 2,
  maxBackoff: 60000,
  maxRetries: 3,
});

export const solanaRpcRateLimiter = new RateLimiter({
  serviceName: 'solana_rpc',
  maxRequestsPerMinute: 10,
  minDelayBetweenRequests: 6000,
  backoffMultiplier: 2,
  maxBackoff: 60000,
  maxRetries: 3,
});
