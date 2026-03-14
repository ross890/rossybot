// ===========================================
// NANSEN API CLIENT — SHARED SINGLETON
// Handles auth, rate limiting, credit tracking
// ===========================================

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger.js';

// ============ TYPES ============

export interface NansenConfig {
  apiKey: string;
  baseUrl: string;
  dailyCreditBudget: number;
  timeoutMs: number;
}

// ============ CLIENT ============

export class NansenClient {
  private client: AxiosInstance;
  private callsToday: number = 0;
  private creditsUsedToday: number = 0;
  private dailyCreditBudget: number;
  private lastResetDate: string = '';

  constructor(config?: Partial<NansenConfig>) {
    const apiKey = config?.apiKey || process.env.NANSEN_API_KEY || '';
    const baseUrl = config?.baseUrl || 'https://api.nansen.ai/api/v1';
    this.dailyCreditBudget = config?.dailyCreditBudget || 400;
    const timeoutMs = config?.timeoutMs || 10000;

    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'apiKey': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    });
  }

  /**
   * Check if client is configured (API key present)
   */
  isConfigured(): boolean {
    const apiKey = this.client.defaults.headers['apiKey'] as string;
    return !!apiKey && apiKey.length > 0;
  }

  /**
   * Make a POST request to the Nansen API
   * Returns null on failure (non-throwing for graceful degradation)
   */
  async post<T = any>(endpoint: string, body: object, creditCost: number = 1): Promise<T | null> {
    if (!this.isConfigured()) {
      return null;
    }

    this.checkDailyReset();

    if (this.creditsUsedToday + creditCost > this.dailyCreditBudget) {
      logger.warn({
        used: this.creditsUsedToday,
        budget: this.dailyCreditBudget,
      }, 'Nansen: Daily credit budget reached, skipping call');
      return null;
    }

    try {
      const response = await this.client.post(endpoint, body);
      this.callsToday++;
      this.creditsUsedToday += creditCost;
      return response.data as T;
    } catch (error: any) {
      if (error.response?.status === 429) {
        // Rate limited — back off and retry once
        logger.warn({ endpoint }, 'Nansen: Rate limited, retrying after 2s');
        await sleep(2000);
        try {
          const retryResponse = await this.client.post(endpoint, body);
          this.callsToday++;
          this.creditsUsedToday += creditCost;
          return retryResponse.data as T;
        } catch (retryError: any) {
          logger.error({ endpoint, error: retryError.message }, 'Nansen: Retry also failed');
          return null;
        }
      }
      logger.error({ endpoint, status: error.response?.status, error: error.message }, 'Nansen: API error');
      return null;
    }
  }

  /**
   * Make a GET request to the Nansen API
   */
  async get<T = any>(endpoint: string, params?: object, creditCost: number = 1): Promise<T | null> {
    if (!this.isConfigured()) {
      return null;
    }

    this.checkDailyReset();

    if (this.creditsUsedToday + creditCost > this.dailyCreditBudget) {
      logger.warn({
        used: this.creditsUsedToday,
        budget: this.dailyCreditBudget,
      }, 'Nansen: Daily credit budget reached, skipping call');
      return null;
    }

    try {
      const response = await this.client.get(endpoint, { params });
      this.callsToday++;
      this.creditsUsedToday += creditCost;
      return response.data as T;
    } catch (error: any) {
      if (error.response?.status === 429) {
        logger.warn({ endpoint }, 'Nansen: Rate limited, retrying after 2s');
        await sleep(2000);
        try {
          const retryResponse = await this.client.get(endpoint, { params });
          this.callsToday++;
          this.creditsUsedToday += creditCost;
          return retryResponse.data as T;
        } catch (retryError: any) {
          logger.error({ endpoint, error: retryError.message }, 'Nansen: Retry also failed');
          return null;
        }
      }
      logger.error({ endpoint, status: error.response?.status, error: error.message }, 'Nansen: API error');
      return null;
    }
  }

  /**
   * Get current credit usage stats
   */
  getCreditStats(): { callsToday: number; creditsUsedToday: number; dailyCreditBudget: number; remaining: number } {
    this.checkDailyReset();
    return {
      callsToday: this.callsToday,
      creditsUsedToday: this.creditsUsedToday,
      dailyCreditBudget: this.dailyCreditBudget,
      remaining: this.dailyCreditBudget - this.creditsUsedToday,
    };
  }

  /**
   * Reset daily counters if date has changed
   */
  private checkDailyReset(): void {
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastResetDate) {
      if (this.lastResetDate) {
        logger.info({
          date: this.lastResetDate,
          calls: this.callsToday,
          credits: this.creditsUsedToday,
        }, 'Nansen: Daily credit counters reset');
      }
      this.callsToday = 0;
      this.creditsUsedToday = 0;
      this.lastResetDate = today;
    }
  }
}

// ============ HELPERS ============

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ SINGLETON ============

export const nansenClient = new NansenClient();

export default nansenClient;
