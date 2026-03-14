import { logger } from './logger.js';
import { query } from '../db/database.js';

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  endpoint: string;
}

export class RateLimiter {
  private queue: QueueItem[] = [];
  private callTimestamps: number[] = [];
  private maxCallsPerMin: number;
  private provider: string;
  private processing = false;

  constructor(provider: string, maxCallsPerMin: number) {
    this.provider = provider;
    this.maxCallsPerMin = maxCallsPerMin;
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

      if (this.callTimestamps.length >= this.maxCallsPerMin) {
        // Wait until oldest call expires
        const waitMs = 60_000 - (now - this.callTimestamps[0]) + 100;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const item = this.queue.shift()!;
      this.callTimestamps.push(Date.now());

      const start = Date.now();
      try {
        const result = await item.fn();
        const duration = Date.now() - start;
        await this.logApiCall(item.endpoint, 200, duration);
        item.resolve(result);
      } catch (err: unknown) {
        const duration = Date.now() - start;
        const status = (err as { response?: { status?: number } })?.response?.status || 0;
        const message = err instanceof Error ? err.message : 'Unknown error';
        await this.logApiCall(item.endpoint, status, duration, message);
        item.reject(err);
      }
    }

    this.processing = false;
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
