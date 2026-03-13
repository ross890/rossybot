// ===========================================
// MODULE: NARRATIVE META-DETECTION
// Detects which memecoin themes are currently hot/cold
// Phase 4.4 — structural edge by riding hot narratives
// ===========================================

import { logger } from '../utils/logger.js';
import { pool } from '../utils/database.js';

// ============ TYPES ============

export type NarrativeCategory =
  | 'ANIMAL'
  | 'AI'
  | 'POLITICAL'
  | 'CELEBRITY'
  | 'CULTURE'
  | 'DEFI_MEME'
  | 'FOOD'
  | 'GAMING'
  | 'ABSTRACT'
  | 'UNKNOWN';

export type NarrativeStatus = 'HOT' | 'WARM' | 'NEUTRAL' | 'COLD' | 'DEAD';

export interface NarrativeStats {
  category: NarrativeCategory;
  signalCount: number;
  wins: number;
  losses: number;
  winRate: number;
  evPercent: number;
  status: NarrativeStatus;
  scoreAdjustment: number;
}

export interface NarrativeAdjustment {
  category: NarrativeCategory;
  scoreAdjustment: number; // -10 to +5
  status: NarrativeStatus;
  reason: string;
}

// ============ NARRATIVE KEYWORDS ============

const NARRATIVE_KEYWORDS: Record<NarrativeCategory, string[]> = {
  ANIMAL: ['dog', 'cat', 'shib', 'inu', 'doge', 'pepe', 'frog', 'bear', 'bull', 'ape', 'monkey', 'bird', 'eagle', 'fish', 'whale', 'pup', 'kitten', 'moo', 'cow', 'duck', 'goat', 'wolf', 'fox', 'penguin', 'hamster', 'bunny', 'rabbit', 'snake', 'dragon'],
  AI: ['ai', 'gpt', 'bot', 'neural', 'agent', 'llm', 'deep', 'mind', 'cognitive', 'compute', 'tensor', 'algo', 'quantum', 'cyber', 'robo', 'machine'],
  POLITICAL: ['trump', 'biden', 'maga', 'usa', 'america', 'president', 'vote', 'elect', 'patriot', 'freedom', 'liberty', 'democrat', 'republican', 'congress'],
  CELEBRITY: ['elon', 'musk', 'kanye', 'ye', 'drake', 'taylor', 'swift', 'snoop', 'cuban', 'celebrity', 'famous', 'star', 'hollywood', 'influenc'],
  CULTURE: ['meme', 'based', 'chad', 'wojak', 'npc', 'cope', 'soy', 'giga', 'sigma', 'alpha', 'beta', 'rizz', 'brainrot', 'skibidi', 'gyatt', 'ohio', 'aura'],
  DEFI_MEME: ['swap', 'yield', 'farm', 'stake', 'defi', 'dex', 'pool', 'liquid', 'bridge', 'dao', 'protocol', 'vault'],
  FOOD: ['pizza', 'burger', 'taco', 'sushi', 'ramen', 'bread', 'cheese', 'bacon', 'coffee', 'beer', 'wine', 'cake', 'cookie', 'banana', 'apple'],
  GAMING: ['game', 'play', 'quest', 'guild', 'loot', 'pvp', 'rpg', 'pixel', 'arcade', 'battle', 'warrior', 'knight', 'sword', 'magic'],
  ABSTRACT: ['moon', 'sol', 'sun', 'star', 'galaxy', 'cosmos', 'infinity', 'void', 'zero', 'one', 'gold', 'silver', 'diamond', 'crystal', 'shadow', 'dark', 'light', 'fire', 'ice', 'thunder'],
  UNKNOWN: [],
};

// ============ CONFIGURATION ============

const CONFIG = {
  // Rolling window for EV calculation
  ROLLING_WINDOW_DAYS: 7,

  // Thresholds for narrative status
  HOT_EV_THRESHOLD: 20,       // EV > +20% over 10+ signals
  HOT_MIN_SIGNALS: 10,
  COLD_EV_THRESHOLD: -10,     // EV < -10% over 10+ signals
  COLD_MIN_SIGNALS: 10,
  DEAD_EV_THRESHOLD: -20,     // EV < -20% over 20+ signals
  DEAD_MIN_SIGNALS: 20,

  // Score adjustments
  HOT_BONUS: 5,
  COLD_PENALTY: -5,
  DEAD_PENALTY: -10,
} as const;

// ============ NARRATIVE DETECTOR CLASS ============

export class NarrativeDetector {
  // Cached narrative stats (refreshed during daily optimization)
  private narrativeStats: Map<NarrativeCategory, NarrativeStats> = new Map();
  private lastCalculation = 0;

  /**
   * Initialize: calculate initial stats from database.
   */
  async initialize(): Promise<void> {
    await this.calculateNarrativeStats();
    logger.info({
      narratives: this.narrativeStats.size,
      hot: this.getHotNarratives().length,
      cold: this.getColdNarratives().length,
    }, 'Narrative detector initialized');
  }

  /**
   * Classify a token into narrative categories.
   * A token can match multiple categories (e.g., "DOGAI" → [ANIMAL, AI]).
   * Returns the primary (best-matching) category.
   */
  classifyToken(tokenName: string, tokenSymbol: string, description?: string): NarrativeCategory {
    const combined = `${tokenName} ${tokenSymbol} ${description || ''}`.toLowerCase();
    const matchedCategories: { category: NarrativeCategory; matches: number }[] = [];

    for (const [category, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
      if (category === 'UNKNOWN') continue;
      let matches = 0;
      for (const keyword of keywords) {
        if (combined.includes(keyword)) {
          matches++;
        }
      }
      if (matches > 0) {
        matchedCategories.push({ category: category as NarrativeCategory, matches });
      }
    }

    if (matchedCategories.length === 0) return 'UNKNOWN';
    matchedCategories.sort((a, b) => b.matches - a.matches);
    return matchedCategories[0].category;
  }

  /**
   * Get all matching categories for a token (can have multiple).
   */
  classifyTokenMulti(tokenName: string, tokenSymbol: string, description?: string): NarrativeCategory[] {
    const combined = `${tokenName} ${tokenSymbol} ${description || ''}`.toLowerCase();
    const categories: NarrativeCategory[] = [];

    for (const [category, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
      if (category === 'UNKNOWN') continue;
      for (const keyword of keywords) {
        if (combined.includes(keyword)) {
          categories.push(category as NarrativeCategory);
          break;
        }
      }
    }

    return categories.length > 0 ? categories : ['UNKNOWN'];
  }

  /**
   * Get the score adjustment for a token based on its narrative.
   */
  getNarrativeAdjustment(tokenName: string, tokenSymbol: string, description?: string): NarrativeAdjustment {
    const category = this.classifyToken(tokenName, tokenSymbol, description);
    const stats = this.narrativeStats.get(category);

    if (!stats) {
      return {
        category,
        scoreAdjustment: 0,
        status: 'NEUTRAL',
        reason: `No data for ${category} narrative`,
      };
    }

    return {
      category: stats.category,
      scoreAdjustment: stats.scoreAdjustment,
      status: stats.status,
      reason: `${category} is ${stats.status} (${stats.evPercent.toFixed(1)}% EV over ${stats.signalCount} signals)`,
    };
  }

  /**
   * Calculate narrative stats from the performance database.
   * Called during daily optimization cycle.
   */
  async calculateNarrativeStats(): Promise<void> {
    try {
      // Get recent signals with token name data
      const result = await pool.query(`
        SELECT
          token_ticker,
          final_outcome,
          COALESCE(realized_return, final_return) as return_pct
        FROM signal_performance
        WHERE final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')
          AND signal_time > NOW() - INTERVAL '${CONFIG.ROLLING_WINDOW_DAYS} days'
      `);

      // Classify and aggregate
      const statsMap = new Map<NarrativeCategory, {
        signals: number;
        wins: number;
        losses: number;
        returns: number[];
      }>();

      for (const row of result.rows) {
        const ticker = row.token_ticker || '';
        const category = this.classifyToken(ticker, ticker);

        if (!statsMap.has(category)) {
          statsMap.set(category, { signals: 0, wins: 0, losses: 0, returns: [] });
        }

        const stats = statsMap.get(category)!;
        stats.signals++;

        const isWin = row.final_outcome === 'WIN' || row.final_outcome === 'EXPIRED_PROFIT';
        if (isWin) stats.wins++;
        else stats.losses++;

        stats.returns.push(parseFloat(row.return_pct) || 0);
      }

      // Build narrative stats
      this.narrativeStats.clear();

      for (const [category, data] of statsMap) {
        const evPercent = data.returns.length > 0
          ? data.returns.reduce((a, b) => a + b, 0) / data.returns.length
          : 0;

        // Determine status
        let status: NarrativeStatus = 'NEUTRAL';
        let scoreAdjustment = 0;

        if (evPercent > CONFIG.HOT_EV_THRESHOLD && data.signals >= CONFIG.HOT_MIN_SIGNALS) {
          status = 'HOT';
          scoreAdjustment = CONFIG.HOT_BONUS;
        } else if (evPercent > 0 && data.signals >= 5) {
          status = 'WARM';
        } else if (evPercent < CONFIG.DEAD_EV_THRESHOLD && data.signals >= CONFIG.DEAD_MIN_SIGNALS) {
          status = 'DEAD';
          scoreAdjustment = CONFIG.DEAD_PENALTY;
        } else if (evPercent < CONFIG.COLD_EV_THRESHOLD && data.signals >= CONFIG.COLD_MIN_SIGNALS) {
          status = 'COLD';
          scoreAdjustment = CONFIG.COLD_PENALTY;
        }

        this.narrativeStats.set(category, {
          category,
          signalCount: data.signals,
          wins: data.wins,
          losses: data.losses,
          winRate: data.signals > 0 ? (data.wins / data.signals) * 100 : 0,
          evPercent,
          status,
          scoreAdjustment,
        });
      }

      this.lastCalculation = Date.now();

      logger.info({
        narratives: this.narrativeStats.size,
        hot: this.getHotNarratives().map(n => n.category),
        cold: this.getColdNarratives().map(n => n.category),
      }, 'Narrative stats calculated');
    } catch (error) {
      logger.debug({ error }, 'Failed to calculate narrative stats');
    }
  }

  // ============ QUERIES ============

  getHotNarratives(): NarrativeStats[] {
    return Array.from(this.narrativeStats.values())
      .filter(s => s.status === 'HOT');
  }

  getColdNarratives(): NarrativeStats[] {
    return Array.from(this.narrativeStats.values())
      .filter(s => s.status === 'COLD' || s.status === 'DEAD');
  }

  getAllStats(): NarrativeStats[] {
    return Array.from(this.narrativeStats.values())
      .sort((a, b) => b.evPercent - a.evPercent);
  }

  /**
   * Format narrative report for Telegram.
   */
  formatReport(): string {
    const allStats = this.getAllStats().filter(s => s.signalCount >= 5);

    if (allStats.length === 0) {
      return '📖 *NARRATIVES*: Insufficient data';
    }

    const lines = ['📖 *NARRATIVE PERFORMANCE (7d)*'];

    for (const stats of allStats) {
      const statusEmoji = stats.status === 'HOT' ? '🔥' :
                          stats.status === 'WARM' ? '🌤️' :
                          stats.status === 'COLD' ? '❄️' :
                          stats.status === 'DEAD' ? '💀' : '⚪';

      lines.push(
        `${statusEmoji} *${stats.category}*: ${stats.evPercent.toFixed(1)}% EV | ${stats.winRate.toFixed(0)}% WR | ${stats.signalCount} signals`
      );
    }

    return lines.join('\n');
  }
}

// ============ EXPORTS ============

export const narrativeDetector = new NarrativeDetector();

export default {
  NarrativeDetector,
  narrativeDetector,
};
