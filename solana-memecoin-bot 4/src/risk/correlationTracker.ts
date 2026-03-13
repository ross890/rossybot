// ===========================================
// MODULE: CORRELATION TRACKER
// Tracks position correlation to prevent correlated blowups
// Phase 3.2 — blocks over-concentrated positions
// ===========================================

import { logger } from '../utils/logger.js';

// ============ TYPES ============

export interface CorrelationResult {
  score: number; // 0+ (higher = more correlated)
  action: 'PROCEED' | 'REDUCE_SIZE' | 'BLOCK';
  sizeMultiplier: number; // 1.0 = full, 0.5 = half, 0 = blocked
  reasons: string[];
}

export interface OpenPositionInfo {
  tokenAddress: string;
  tokenTicker: string;
  tokenName: string;
  entryTimestamp: Date;
  discoverySource: string;
  narrativeCluster: string | null;
}

// Memecoin narrative categories for simple keyword matching
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

// ============ NARRATIVE KEYWORDS ============

const NARRATIVE_KEYWORDS: Record<NarrativeCategory, string[]> = {
  ANIMAL: ['dog', 'cat', 'shib', 'inu', 'doge', 'pepe', 'frog', 'bear', 'bull', 'ape', 'monkey', 'bird', 'eagle', 'fish', 'whale', 'pup', 'kitten', 'moo', 'cow', 'duck', 'goat', 'wolf', 'fox', 'penguin', 'hamster', 'bunny', 'rabbit', 'snake', 'dragon'],
  AI: ['ai', 'gpt', 'bot', 'neural', 'agent', 'llm', 'deep', 'mind', 'cognitive', 'compute', 'tensor', 'algo', 'quantum', 'cyber', 'robo', 'machine'],
  POLITICAL: ['trump', 'biden', 'maga', 'usa', 'america', 'president', 'vote', 'elect', 'patriot', 'freedom', 'liberty', 'democrat', 'republican', 'congress', 'senate', 'politic'],
  CELEBRITY: ['elon', 'musk', 'kanye', 'ye', 'drake', 'taylor', 'swift', 'snoop', 'cuban', 'celebrity', 'famous', 'star', 'hollywood', 'influenc'],
  CULTURE: ['meme', 'based', 'chad', 'wojak', 'npc', 'cope', 'soy', 'giga', 'sigma', 'alpha', 'beta', 'gamma', 'rizz', 'brainrot', 'skibidi', 'gyatt', 'ohio', 'aura'],
  DEFI_MEME: ['swap', 'yield', 'farm', 'stake', 'defi', 'dex', 'pool', 'liquid', 'bridge', 'dao', 'protocol', 'vault'],
  FOOD: ['pizza', 'burger', 'taco', 'sushi', 'ramen', 'bread', 'cheese', 'bacon', 'coffee', 'beer', 'wine', 'cake', 'cookie', 'banana', 'apple'],
  GAMING: ['game', 'play', 'quest', 'guild', 'loot', 'pvp', 'rpg', 'pixel', 'arcade', 'battle', 'warrior', 'knight', 'sword', 'magic'],
  ABSTRACT: ['moon', 'sol', 'sun', 'star', 'galaxy', 'cosmos', 'infinity', 'void', 'zero', 'one', 'gold', 'silver', 'diamond', 'crystal', 'shadow', 'dark', 'light', 'fire', 'ice', 'thunder'],
  UNKNOWN: [],
};

// ============ CORRELATION TRACKER CLASS ============

export class CorrelationTracker {
  // Open positions for correlation checking
  private openPositions: Map<string, OpenPositionInfo> = new Map();

  /**
   * Register an open position for correlation tracking.
   */
  addPosition(info: OpenPositionInfo): void {
    this.openPositions.set(info.tokenAddress, {
      ...info,
      narrativeCluster: info.narrativeCluster || this.classifyNarrative(info.tokenName, info.tokenTicker),
    });
  }

  /**
   * Remove a closed position.
   */
  removePosition(tokenAddress: string): void {
    this.openPositions.delete(tokenAddress);
  }

  /**
   * Calculate correlation score for a new signal against open positions.
   *
   * Scoring:
   *   +1 per open position entered within 1 hour
   *   +1 per open position from same discovery source
   *   +2 per open position in same narrative cluster
   *
   * Actions:
   *   correlationScore >= 4: BLOCK
   *   correlationScore 2-3: reduce Kelly size 50%
   *   correlationScore 0-1: proceed normally
   */
  calculateCorrelation(
    tokenName: string,
    tokenTicker: string,
    discoverySource: string,
    entryTimestamp: Date = new Date(),
  ): CorrelationResult {
    let score = 0;
    const reasons: string[] = [];

    const narrative = this.classifyNarrative(tokenName, tokenTicker);

    for (const [, position] of this.openPositions) {
      // +1 per position entered within 1 hour
      const timeDiffMs = Math.abs(entryTimestamp.getTime() - position.entryTimestamp.getTime());
      if (timeDiffMs < 60 * 60 * 1000) {
        score += 1;
        reasons.push(`Time correlation with $${position.tokenTicker} (entered ${Math.round(timeDiffMs / 60000)}m apart)`);
      }

      // +1 per position from same discovery source
      if (discoverySource === position.discoverySource) {
        score += 1;
        reasons.push(`Same source as $${position.tokenTicker} (${discoverySource})`);
      }

      // +2 per position in same narrative cluster
      if (narrative !== 'UNKNOWN' && narrative === position.narrativeCluster) {
        score += 2;
        reasons.push(`Same narrative as $${position.tokenTicker} (${narrative})`);
      }
    }

    // Determine action
    let action: CorrelationResult['action'];
    let sizeMultiplier: number;

    if (score >= 4) {
      action = 'BLOCK';
      sizeMultiplier = 0;
    } else if (score >= 2) {
      action = 'REDUCE_SIZE';
      sizeMultiplier = 0.5;
    } else {
      action = 'PROCEED';
      sizeMultiplier = 1.0;
    }

    if (score > 0) {
      logger.info({
        token: tokenTicker,
        correlationScore: score,
        action,
        sizeMultiplier,
        reasons,
      }, 'Correlation check result');
    }

    return { score, action, sizeMultiplier, reasons };
  }

  /**
   * Classify a token into a narrative category based on name/symbol.
   * Simple keyword matching — not ML.
   */
  classifyNarrative(tokenName: string, tokenTicker: string): NarrativeCategory {
    const combined = `${tokenName} ${tokenTicker}`.toLowerCase();
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

    // Return category with most keyword matches
    matchedCategories.sort((a, b) => b.matches - a.matches);
    return matchedCategories[0].category;
  }

  /**
   * Get all current open positions for correlation checking.
   */
  getOpenPositions(): OpenPositionInfo[] {
    return Array.from(this.openPositions.values());
  }

  /**
   * Get current position count.
   */
  getPositionCount(): number {
    return this.openPositions.size;
  }
}

// ============ EXPORTS ============

export const correlationTracker = new CorrelationTracker();

export default {
  CorrelationTracker,
  correlationTracker,
};
