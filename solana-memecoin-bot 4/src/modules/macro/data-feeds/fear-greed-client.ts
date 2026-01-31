// ===========================================
// FEAR & GREED INDEX CLIENT
// ===========================================
// Free API from alternative.me - no API key required
// Updates daily, provides crypto market sentiment

import { logger } from '../../../utils/logger.js';
import { FearGreedData, FearGreedHistory } from '../types.js';

/**
 * Fear & Greed Index Client
 *
 * Uses Alternative.me's free API (no key required)
 * The index is calculated from:
 * - Volatility (25%)
 * - Market momentum/volume (25%)
 * - Social media (15%)
 * - Surveys (15%)
 * - Bitcoin dominance (10%)
 * - Google Trends (10%)
 *
 * Scale: 0-100
 * - 0-20: Extreme Fear
 * - 21-40: Fear
 * - 41-60: Neutral
 * - 61-80: Greed
 * - 81-100: Extreme Greed
 */
export class FearGreedClient {
  private cache: { value: number; classification: string; timestamp: Date } | null = null;
  private cacheDurationMs = 60 * 60 * 1000;  // 1 hour cache (index updates daily)
  private baseUrl = 'https://api.alternative.me/fng/';

  /**
   * Classify the fear & greed value
   */
  private classify(value: number): string {
    if (value <= 20) return 'Extreme Fear';
    if (value <= 40) return 'Fear';
    if (value <= 60) return 'Neutral';
    if (value <= 80) return 'Greed';
    return 'Extreme Greed';
  }

  /**
   * Get current Fear & Greed Index
   */
  async getIndex(): Promise<FearGreedData> {
    // Check cache first
    if (this.cache && Date.now() - this.cache.timestamp.getTime() < this.cacheDurationMs) {
      return {
        value: this.cache.value,
        classification: this.cache.classification,
        timestamp: this.cache.timestamp,
        cached: true,
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}?limit=1`);

      if (!response.ok) {
        throw new Error(`Fear & Greed API error: ${response.status}`);
      }

      const data = await response.json() as { data?: Array<{ value: string; timestamp: string; value_classification?: string }> };

      if (!data.data || data.data.length === 0) {
        throw new Error('No Fear & Greed data returned');
      }

      const item = data.data[0];
      const value = parseInt(item.value, 10);
      const classification = this.classify(value);
      const timestamp = new Date(parseInt(item.timestamp, 10) * 1000);

      // Update cache
      this.cache = { value, classification, timestamp };

      return {
        value,
        classification,
        timestamp,
        cached: false,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to fetch Fear & Greed Index');

      // Return cached data if available, even if stale
      if (this.cache) {
        return {
          value: this.cache.value,
          classification: this.cache.classification,
          timestamp: this.cache.timestamp,
          cached: true,
        };
      }

      // Return neutral as fallback
      return {
        value: 50,
        classification: 'Neutral',
        timestamp: new Date(),
        cached: false,
      };
    }
  }

  /**
   * Get historical Fear & Greed data
   */
  async getHistory(days: number = 30): Promise<FearGreedHistory[]> {
    try {
      const response = await fetch(`${this.baseUrl}?limit=${days}`);

      if (!response.ok) {
        throw new Error(`Fear & Greed API error: ${response.status}`);
      }

      const data = await response.json() as { data?: Array<{ value: string; timestamp: string; value_classification?: string }> };

      if (!data.data || data.data.length === 0) {
        return [];
      }

      return data.data.map((item) => ({
        value: parseInt(item.value, 10),
        classification: item.value_classification || this.classify(parseInt(item.value, 10)),
        timestamp: new Date(parseInt(item.timestamp, 10) * 1000),
      }));
    } catch (err) {
      logger.error({ err }, 'Failed to fetch Fear & Greed history');
      return [];
    }
  }

  /**
   * Calculate trend direction over recent days
   */
  async getTrend(days: number = 7): Promise<{
    direction: 'IMPROVING' | 'WORSENING' | 'STABLE';
    change: number;
    averageValue: number;
  }> {
    const history = await this.getHistory(days);

    if (history.length < 2) {
      return { direction: 'STABLE', change: 0, averageValue: 50 };
    }

    // Calculate average
    const sum = history.reduce((acc, item) => acc + item.value, 0);
    const averageValue = sum / history.length;

    // Compare oldest to newest
    const oldest = history[history.length - 1].value;  // API returns newest first
    const newest = history[0].value;
    const change = newest - oldest;

    let direction: 'IMPROVING' | 'WORSENING' | 'STABLE' = 'STABLE';
    if (change > 5) {
      direction = 'IMPROVING';
    } else if (change < -5) {
      direction = 'WORSENING';
    }

    return { direction, change, averageValue };
  }

  /**
   * Check if market is at extreme sentiment
   */
  async isExtreme(): Promise<{
    isExtreme: boolean;
    type: 'FEAR' | 'GREED' | null;
    value: number;
  }> {
    const current = await this.getIndex();

    if (current.value <= 20) {
      return { isExtreme: true, type: 'FEAR', value: current.value };
    }

    if (current.value >= 80) {
      return { isExtreme: true, type: 'GREED', value: current.value };
    }

    return { isExtreme: false, type: null, value: current.value };
  }

  /**
   * Get sentiment emoji for display
   */
  getSentimentEmoji(value: number): string {
    if (value <= 20) return '😱';  // Extreme Fear
    if (value <= 40) return '😰';  // Fear
    if (value <= 60) return '😐';  // Neutral
    if (value <= 80) return '😊';  // Greed
    return '🤑';  // Extreme Greed
  }

  /**
   * Format for display
   */
  formatForDisplay(data: FearGreedData): string {
    const emoji = this.getSentimentEmoji(data.value);
    return `${emoji} ${data.value} (${data.classification})`;
  }

  /**
   * Clear cache (force refresh on next call)
   */
  clearCache(): void {
    this.cache = null;
  }
}

// Export singleton instance
export const fearGreedClient = new FearGreedClient();
