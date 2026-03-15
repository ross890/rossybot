import { logger } from './logger.js';
import { query } from '../db/database.js';

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  endpoint: string;
}

interface RateLimiterOptions {
  /** Minimum ms between consecutive calls (prevents bursting) */
  minIntervalMs?: number;
  /** Max retries on 403/429 responses */
  maxRetries?: number;
  /** Base delay for exponential backoff on 403/429 (ms) */
  retryBaseMs?: number;
}

export class RateLimiter {
  private queue: QueueItem[] = [];
  private callTimestamps: number[] = [];
  private maxCallsPerMin: number;
  private provider: string;
  private processing = false;
  private lastCallTime = 0;
  private minIntervalMs: number;
  private maxRetries: number;
  private retryBaseMs: number;

  constructor(provider: string, maxCallsPerMin: number, options?: RateLimiterOptions) {
    this.provider = provider;
    this.maxCallsPerMin = maxCallsPerMin;
    this.minIntervalMs = options?.minIntervalMs ?? 1500;
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryBaseMs = options?.retryBaseMs ?? 5000;
  }

  async execute<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        endpoint,
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      // Clean old timestamps (older than 60s)
      const now = Date.now();
      this.callTimestamps = this.callTimestamps.filter((t) => now - t < 60_000);

      // Per-minute rate limit
      if (this.callTimestamps.length >= this.maxCallsPerMin) {
        const waitMs = 60_000 - (now - this.callTimestamps[0]) + 100;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // Minimum spacing between calls (prevents bursting)
      const sinceLast = Date.now() - this.lastCallTime;
      if (sinceLast < this.minIntervalMs) {
        await new Promise((r) => setTimeout(r, this.minIntervalMs - sinceLast));
      }

      const item = this.queue.shift()!;
      await this.executeWithRetry(item);
    }

    this.processing = false;
  }

  private async executeWithRetry(item: QueueItem): Promise<void> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.callTimestamps.push(Date.now());
      this.lastCallTime = Date.now();

      const start = Date.now();
      try {
        const result = await item.fn();
        const duration = Date.now() - start;
        await this.logApiCall(item.endpoint, 200, duration);
        item.resolve(result);
        return;
      } catch (err: unknown) {
        const duration = Date.now() - start;
        const status = (err as { response?: { status?: number } })?.response?.status || 0;
        const message = err instanceof Error ? err.message : 'Unknown error';

        // Only retry on 429 (too many requests) — transient rate limit
        // 403 = hard access denial or billing-period limit, retrying won't help
        if (status === 429 && attempt < this.maxRetries) {
          const backoffMs = this.retryBaseMs * Math.pow(2, attempt);
          logger.info(
            { endpoint: item.endpoint, attempt: attempt + 1, maxRetries: this.maxRetries, backoffMs },
            `Rate limited (429) — retrying after ${backoffMs}ms`,
          );
          await this.logApiCall(item.endpoint, status, duration, `${message} (retry ${attempt + 1})`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        await this.logApiCall(item.endpoint, status, duration, message);
        item.reject(err);
        return;
      }
    }
  }

  private async logApiCall(endpoint: string, statusCode: number, durationMs: number, error?: string): Promise<void> {
    try {
      await query(
        `INSERT INTO api_call_log (provider, endpoint, status_code, duration_ms, error) VALUES ($1, $2, $3, $4, $5)`,
        [this.provider, endpoint, statusCode, durationMs, error || null],
      );
    } catch (err) {
      logger.error({ err }, 'Failed to log API call');
    }
  }

  getUsage(): { callsLastMinute: number; maxPerMinute: number; queueLength: number } {
    const now = Date.now();
    const recent = this.callTimestamps.filter((t) => now - t < 60_000);
    return {
      callsLastMinute: recent.length,
      maxPerMinute: this.maxCallsPerMin,
      queueLength: this.queue.length,
    };
  }
}
