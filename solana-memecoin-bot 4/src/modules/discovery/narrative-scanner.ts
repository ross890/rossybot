// ===========================================
// NARRATIVE-BASED TOKEN SCANNER
// Uses DexScreener searchTokens() to find tokens matching trending narratives
// Phase 1 Quick Win: Token Discovery Enhancement
//
// SMART FEATURES:
// - Dynamic narrative discovery from trending tokens
// - Performance tracking per narrative
// - Auto-priority adjustment based on success rates
// ===========================================

import { logger } from '../../utils/logger.js';
import { dexScreenerClient, getTokenMetrics } from '../onchain.js';
import { TokenMetrics, DexScreenerPair } from '../../types/index.js';

// ============ CONFIGURATION ============

interface NarrativeConfig {
  // Narratives to search for (rotated through scans)
  narratives: string[];

  // Minimum metrics thresholds
  minLiquidity: number;
  minVolume24h: number;
  minHolders: number;

  // Token age range (hours)
  minTokenAgeHours: number;
  maxTokenAgeHours: number;

  // Scan interval
  scanIntervalMinutes: number;

  // Maximum tokens per narrative
  maxTokensPerNarrative: number;

  // Dynamic narrative learning
  enableDynamicLearning: boolean;
  minTokensToLearnNarrative: number;  // Need X tokens with same keyword to add narrative
  narrativeDecayDays: number;          // Remove stale narratives after X days of no results
}

const DEFAULT_NARRATIVES = [
  // AI/Agent narrative (hot right now)
  'AI agent',
  'GPT',
  'neural',
  'intelligence',
  'agent AI',

  // Political (always popular)
  'trump',
  'maga',
  'election',
  'president',

  // Meme culture
  'pepe',
  'wojak',
  'chad',
  'based',

  // Animal memes
  'cat',
  'dog',
  'frog',
  'bear',
  'bull',

  // DeFi/Finance themes
  'yield',
  'stake',
  'pump',
  'moon',

  // Gaming/NFT
  'game',
  'nft',
  'play',

  // Community themes
  'CTO',
  'community',
  'degen',
];

const DEFAULT_CONFIG: NarrativeConfig = {
  narratives: DEFAULT_NARRATIVES,
  minLiquidity: 10000,       // $10K minimum
  minVolume24h: 5000,        // $5K volume
  minHolders: 50,            // 50 holders minimum
  minTokenAgeHours: 0.5,     // At least 30 minutes
  maxTokenAgeHours: 2160,    // Up to 90 days
  scanIntervalMinutes: 15,   // Every 15 minutes
  maxTokensPerNarrative: 10, // Top 10 per narrative
  enableDynamicLearning: true,
  minTokensToLearnNarrative: 3,  // 3 tokens with same keyword = new narrative
  narrativeDecayDays: 7,         // Remove after 7 days of no results
};

// ============ TYPES ============

export interface NarrativeToken {
  address: string;
  ticker: string;
  name: string;
  matchedNarrative: string;
  matchScore: number;  // How well it matches the narrative
  marketCap: number;
  liquidity: number;
  volume24h: number;
  holderCount: number;
  tokenAgeHours: number;
  priceChange24h: number;
  discoveredAt: Date;
}

// Track narrative performance
interface NarrativePerformance {
  narrative: string;
  tokensFound: number;
  avgPriceChange24h: number;
  avgMatchScore: number;
  lastFoundAt: number;
  isLearned: boolean;    // true = dynamically learned, false = seed narrative
  priority: number;      // Higher = searched more often
}

// ============ SCANNER CLASS ============

class NarrativeScanner {
  private config: NarrativeConfig = DEFAULT_CONFIG;
  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;

  // Track which narratives we've recently searched
  private narrativeIndex = 0;
  private narrativesPerCycle = 5; // Search 5 narratives per cycle to avoid rate limits

  // Cache of discovered tokens (to avoid duplicates)
  private discoveredTokens: Map<string, { narrative: string; timestamp: number }> = new Map();
  private readonly DISCOVERY_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hour cooldown

  // Last scan results
  private lastResults: NarrativeToken[] = [];

  // ===== SMART FEATURES =====

  // Track narrative performance for dynamic priority
  private narrativePerformance: Map<string, NarrativePerformance> = new Map();

  // Candidate narratives being evaluated (need minTokensToLearnNarrative to promote)
  private candidateNarratives: Map<string, { count: number; firstSeen: number; tokens: string[] }> = new Map();

  // Words to ignore when learning narratives
  private readonly IGNORE_WORDS = new Set([
    'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'is', 'it',
    'coin', 'token', 'sol', 'solana', 'crypto', 'inu', 'elon',
    'moon', 'safe', 'baby', 'mini', 'super', 'mega', 'ultra',
  ]);

  /**
   * Initialize the scanner
   */
  async initialize(): Promise<void> {
    // Initialize performance tracking for seed narratives
    for (const narrative of this.config.narratives) {
      this.narrativePerformance.set(narrative.toLowerCase(), {
        narrative,
        tokensFound: 0,
        avgPriceChange24h: 0,
        avgMatchScore: 0,
        lastFoundAt: Date.now(),
        isLearned: false,
        priority: 50,  // Default priority
      });
    }

    logger.info({
      narratives: this.config.narratives.length,
      examples: this.config.narratives.slice(0, 5),
      dynamicLearning: this.config.enableDynamicLearning,
    }, 'Initializing narrative scanner with smart features');
  }

  /**
   * Start the scanning loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Narrative scanner already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting narrative scanning loop');

    // Run immediately, then on interval
    this.runScanCycle();
    this.scanTimer = setInterval(
      () => this.runScanCycle(),
      this.config.scanIntervalMinutes * 60 * 1000
    );
  }

  /**
   * Stop the scanning loop
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    logger.info('Narrative scanner stopped');
  }

  /**
   * Run a single scan cycle
   */
  private async runScanCycle(): Promise<void> {
    try {
      const results: NarrativeToken[] = [];

      // Get next batch of narratives to search (weighted by priority)
      const narrativesToSearch = this.getNextNarratives();

      logger.info({
        narratives: narrativesToSearch,
      }, 'Narrative scan cycle starting');

      for (const narrative of narrativesToSearch) {
        try {
          const tokens = await this.searchNarrative(narrative);
          results.push(...tokens);

          // Update narrative performance
          this.updateNarrativePerformance(narrative, tokens);

          // Learn new narratives from found tokens
          if (this.config.enableDynamicLearning) {
            this.learnFromTokens(tokens);
          }

          // Small delay between searches to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          logger.debug({ error, narrative }, 'Error searching narrative');
        }
      }

      // Deduplicate and sort by match score
      const uniqueResults = this.deduplicateResults(results);
      this.lastResults = uniqueResults;

      // Periodic maintenance
      this.cleanupDiscoveries();
      this.promoteAndDecayNarratives();

      logger.info({
        searched: narrativesToSearch.length,
        found: uniqueResults.length,
        totalNarratives: this.config.narratives.length,
        learnedNarratives: this.getLearnedNarrativeCount(),
        topFinds: uniqueResults.slice(0, 5).map(t => ({
          ticker: t.ticker,
          narrative: t.matchedNarrative,
          mcap: '$' + (t.marketCap / 1000).toFixed(0) + 'K',
        })),
      }, 'Narrative scan cycle complete');

    } catch (error) {
      logger.error({ error }, 'Error in narrative scan cycle');
    }
  }

  /**
   * Get next batch of narratives to search (weighted by priority)
   */
  private getNextNarratives(): string[] {
    // Build priority-weighted list
    const weighted: { narrative: string; weight: number }[] = [];

    for (const narrative of this.config.narratives) {
      const perf = this.narrativePerformance.get(narrative.toLowerCase());
      const weight = perf?.priority || 50;
      weighted.push({ narrative, weight });
    }

    // Sort by weight (higher priority first), then rotate through
    weighted.sort((a, b) => b.weight - a.weight);

    const narratives: string[] = [];
    for (let i = 0; i < this.narrativesPerCycle && i < weighted.length; i++) {
      const idx = (this.narrativeIndex + i) % weighted.length;
      narratives.push(weighted[idx].narrative);
    }

    this.narrativeIndex = (this.narrativeIndex + this.narrativesPerCycle) % Math.max(1, weighted.length);

    return narratives;
  }

  /**
   * Update performance metrics for a narrative
   */
  private updateNarrativePerformance(narrative: string, tokens: NarrativeToken[]): void {
    const key = narrative.toLowerCase();
    const existing = this.narrativePerformance.get(key) || {
      narrative,
      tokensFound: 0,
      avgPriceChange24h: 0,
      avgMatchScore: 0,
      lastFoundAt: Date.now(),
      isLearned: true,
      priority: 50,
    };

    if (tokens.length > 0) {
      const avgPrice = tokens.reduce((sum, t) => sum + t.priceChange24h, 0) / tokens.length;
      const avgScore = tokens.reduce((sum, t) => sum + t.matchScore, 0) / tokens.length;

      // Exponential moving average for smoother updates
      existing.avgPriceChange24h = existing.tokensFound > 0
        ? existing.avgPriceChange24h * 0.7 + avgPrice * 0.3
        : avgPrice;
      existing.avgMatchScore = existing.tokensFound > 0
        ? existing.avgMatchScore * 0.7 + avgScore * 0.3
        : avgScore;
      existing.tokensFound += tokens.length;
      existing.lastFoundAt = Date.now();

      // Adjust priority based on performance
      // Higher priority for narratives finding tokens with positive price action
      if (avgPrice > 20) {
        existing.priority = Math.min(100, existing.priority + 5);
      } else if (avgPrice < -20) {
        existing.priority = Math.max(10, existing.priority - 3);
      }
    }

    this.narrativePerformance.set(key, existing);
  }

  /**
   * Learn new narratives from discovered tokens
   */
  private learnFromTokens(tokens: NarrativeToken[]): void {
    for (const token of tokens) {
      // Extract potential keywords from token name
      const keywords = this.extractKeywords(token.name, token.ticker);

      for (const keyword of keywords) {
        // Skip if already a narrative
        if (this.config.narratives.some(n => n.toLowerCase() === keyword.toLowerCase())) {
          continue;
        }

        // Track candidate
        const existing = this.candidateNarratives.get(keyword) || {
          count: 0,
          firstSeen: Date.now(),
          tokens: [],
        };

        if (!existing.tokens.includes(token.address)) {
          existing.count++;
          existing.tokens.push(token.address);
        }

        this.candidateNarratives.set(keyword, existing);
      }
    }
  }

  /**
   * Extract potential narrative keywords from token name/ticker
   */
  private extractKeywords(name: string, ticker: string): string[] {
    const keywords: string[] = [];
    const combined = `${name} ${ticker}`.toLowerCase();

    // Split into words
    const words = combined.split(/[\s\-_]+/).filter(w => w.length >= 3);

    for (const word of words) {
      // Skip ignored words
      if (this.IGNORE_WORDS.has(word)) continue;

      // Skip pure numbers
      if (/^\d+$/.test(word)) continue;

      // Skip very common crypto terms that aren't narratives
      if (word.length < 3) continue;

      keywords.push(word);
    }

    return keywords;
  }

  /**
   * Promote successful candidates to narratives, decay stale ones
   */
  private promoteAndDecayNarratives(): void {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Promote candidates that have enough tokens
    for (const [keyword, data] of this.candidateNarratives) {
      if (data.count >= this.config.minTokensToLearnNarrative) {
        // Promote to full narrative
        this.config.narratives.push(keyword);
        this.narrativePerformance.set(keyword.toLowerCase(), {
          narrative: keyword,
          tokensFound: data.count,
          avgPriceChange24h: 0,
          avgMatchScore: 50,
          lastFoundAt: now,
          isLearned: true,
          priority: 60,  // Start with slightly higher priority for learned narratives
        });

        logger.info({
          keyword,
          tokensFound: data.count,
          sampleTokens: data.tokens.slice(0, 3),
        }, 'LEARNED NEW NARRATIVE from trending tokens');

        this.candidateNarratives.delete(keyword);
      } else if (now - data.firstSeen > 3 * dayMs) {
        // Remove stale candidates
        this.candidateNarratives.delete(keyword);
      }
    }

    // Decay stale learned narratives (but not seed narratives)
    for (const [key, perf] of this.narrativePerformance) {
      if (perf.isLearned && now - perf.lastFoundAt > this.config.narrativeDecayDays * dayMs) {
        // Remove from active narratives
        const idx = this.config.narratives.findIndex(n => n.toLowerCase() === key);
        if (idx > -1) {
          this.config.narratives.splice(idx, 1);
          this.narrativePerformance.delete(key);

          logger.info({
            narrative: perf.narrative,
            daysSinceLastHit: ((now - perf.lastFoundAt) / dayMs).toFixed(1),
          }, 'Removed stale learned narrative');
        }
      }
    }
  }

  /**
   * Get count of dynamically learned narratives
   */
  private getLearnedNarrativeCount(): number {
    let count = 0;
    for (const perf of this.narrativePerformance.values()) {
      if (perf.isLearned) count++;
    }
    return count;
  }

  /**
   * Search for tokens matching a narrative
   */
  private async searchNarrative(narrative: string): Promise<NarrativeToken[]> {
    const results: NarrativeToken[] = [];

    // Use DexScreener's search API
    const pairs = await dexScreenerClient.searchTokens(narrative);

    // Filter to Solana pairs only (already done in searchTokens but double-check)
    const solanaPairs = pairs.filter(p => p.chainId === 'solana');

    logger.debug({
      narrative,
      found: solanaPairs.length,
    }, 'DexScreener search results');

    for (const pair of solanaPairs.slice(0, this.config.maxTokensPerNarrative)) {
      try {
        // Check if already discovered recently
        const existing = this.discoveredTokens.get(pair.baseToken?.address || '');
        if (existing && Date.now() - existing.timestamp < this.DISCOVERY_COOLDOWN_MS) {
          continue;
        }

        // Get full metrics
        const address = pair.baseToken?.address;
        if (!address) continue;

        const metrics = await getTokenMetrics(address);
        if (!metrics) continue;

        // Apply filters
        if (metrics.liquidityPool < this.config.minLiquidity) continue;
        if (metrics.volume24h < this.config.minVolume24h) continue;
        if (metrics.holderCount < this.config.minHolders) continue;

        const tokenAgeHours = metrics.tokenAge;
        if (tokenAgeHours < this.config.minTokenAgeHours) continue;
        if (tokenAgeHours > this.config.maxTokenAgeHours) continue;

        // Calculate match score based on how well the token matches
        const matchScore = this.calculateMatchScore(metrics, pair, narrative);

        // Track discovery
        this.discoveredTokens.set(address, {
          narrative,
          timestamp: Date.now(),
        });

        results.push({
          address,
          ticker: metrics.ticker,
          name: metrics.name,
          matchedNarrative: narrative,
          matchScore,
          marketCap: metrics.marketCap,
          liquidity: metrics.liquidityPool,
          volume24h: metrics.volume24h,
          holderCount: metrics.holderCount,
          tokenAgeHours,
          priceChange24h: pair.priceChange?.h24 || 0,
          discoveredAt: new Date(),
        });

      } catch {
        // Skip tokens we can't get data for
      }
    }

    return results;
  }

  /**
   * Calculate how well a token matches the narrative
   */
  private calculateMatchScore(
    metrics: TokenMetrics,
    pair: DexScreenerPair,
    narrative: string
  ): number {
    let score = 50; // Base score

    const name = (metrics.name + ' ' + metrics.ticker).toLowerCase();
    const narrativeLower = narrative.toLowerCase();

    // Name/ticker match is strong
    if (name.includes(narrativeLower)) {
      score += 25;
    }

    // Positive price action
    const priceChange24h = pair.priceChange?.h24 || 0;
    if (priceChange24h > 50) score += 15;
    else if (priceChange24h > 20) score += 10;
    else if (priceChange24h > 0) score += 5;

    // Good volume/mcap ratio
    const volumeRatio = metrics.volume24h / Math.max(metrics.marketCap, 1);
    if (volumeRatio > 0.5) score += 10;
    else if (volumeRatio > 0.2) score += 5;

    // Reasonable holder count
    if (metrics.holderCount > 1000) score += 10;
    else if (metrics.holderCount > 500) score += 5;

    // Good liquidity relative to mcap
    const liqRatio = metrics.liquidityPool / Math.max(metrics.marketCap, 1);
    if (liqRatio > 0.1) score += 5;

    return Math.min(100, score);
  }

  /**
   * Deduplicate results keeping highest match score
   */
  private deduplicateResults(results: NarrativeToken[]): NarrativeToken[] {
    const seen = new Map<string, NarrativeToken>();

    for (const token of results) {
      const existing = seen.get(token.address);
      if (!existing || token.matchScore > existing.matchScore) {
        seen.set(token.address, token);
      }
    }

    return Array.from(seen.values())
      .sort((a, b) => b.matchScore - a.matchScore);
  }

  /**
   * Clean up old discoveries
   */
  private cleanupDiscoveries(): void {
    const now = Date.now();
    for (const [address, data] of this.discoveredTokens) {
      if (now - data.timestamp > 24 * 60 * 60 * 1000) {
        this.discoveredTokens.delete(address);
      }
    }
  }

  /**
   * Get latest narrative-discovered tokens
   */
  getLatestResults(): NarrativeToken[] {
    return [...this.lastResults];
  }

  /**
   * Get token addresses from narrative search
   */
  getTokenAddresses(): string[] {
    return this.lastResults.map(t => t.address);
  }

  /**
   * Search a specific narrative on-demand
   */
  async searchSpecificNarrative(narrative: string): Promise<NarrativeToken[]> {
    return this.searchNarrative(narrative);
  }

  /**
   * Add a new narrative to track
   */
  addNarrative(narrative: string): void {
    if (!this.config.narratives.includes(narrative)) {
      this.config.narratives.push(narrative);
      logger.info({ narrative }, 'Added new narrative to scanner');
    }
  }

  /**
   * Remove a narrative
   */
  removeNarrative(narrative: string): void {
    const index = this.config.narratives.indexOf(narrative);
    if (index > -1) {
      this.config.narratives.splice(index, 1);
      logger.info({ narrative }, 'Removed narrative from scanner');
    }
  }

  /**
   * Get current narratives
   */
  getNarratives(): string[] {
    return [...this.config.narratives];
  }

  /**
   * Get narrative performance stats
   */
  getNarrativePerformance(): NarrativePerformance[] {
    return Array.from(this.narrativePerformance.values())
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get top performing narratives
   */
  getTopNarratives(limit: number = 10): NarrativePerformance[] {
    return this.getNarrativePerformance()
      .filter(p => p.tokensFound > 0)
      .sort((a, b) => b.avgPriceChange24h - a.avgPriceChange24h)
      .slice(0, limit);
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<NarrativeConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ narrativeCount: this.config.narratives.length }, 'Narrative scanner config updated');
  }

  /**
   * Get scanner statistics
   */
  getStats(): {
    isRunning: boolean;
    narrativeCount: number;
    learnedNarrativeCount: number;
    candidateNarrativeCount: number;
    currentNarrativeIndex: number;
    discoveredTokensCount: number;
    lastResultsCount: number;
    topNarratives: { narrative: string; avgPriceChange: number; tokensFound: number }[];
  } {
    const top = this.getTopNarratives(5);

    return {
      isRunning: this.isRunning,
      narrativeCount: this.config.narratives.length,
      learnedNarrativeCount: this.getLearnedNarrativeCount(),
      candidateNarrativeCount: this.candidateNarratives.size,
      currentNarrativeIndex: this.narrativeIndex,
      discoveredTokensCount: this.discoveredTokens.size,
      lastResultsCount: this.lastResults.length,
      topNarratives: top.map(p => ({
        narrative: p.narrative,
        avgPriceChange: Math.round(p.avgPriceChange24h * 10) / 10,
        tokensFound: p.tokensFound,
      })),
    };
  }
}

// ============ EXPORTS ============

export const narrativeScanner = new NarrativeScanner();
