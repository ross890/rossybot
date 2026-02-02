// ===========================================
// NARRATIVE-BASED TOKEN SCANNER
// Uses DexScreener searchTokens() to find tokens matching trending narratives
// Phase 1 Quick Win: Token Discovery Enhancement
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

  /**
   * Initialize the scanner
   */
  async initialize(): Promise<void> {
    logger.info({
      narratives: this.config.narratives.length,
      examples: this.config.narratives.slice(0, 5),
    }, 'Initializing narrative scanner');
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

      // Get next batch of narratives to search
      const narrativesToSearch = this.getNextNarratives();

      logger.info({
        narratives: narrativesToSearch,
      }, 'Narrative scan cycle starting');

      for (const narrative of narrativesToSearch) {
        try {
          const tokens = await this.searchNarrative(narrative);
          results.push(...tokens);

          // Small delay between searches to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          logger.debug({ error, narrative }, 'Error searching narrative');
        }
      }

      // Deduplicate and sort by match score
      const uniqueResults = this.deduplicateResults(results);
      this.lastResults = uniqueResults;

      logger.info({
        searched: narrativesToSearch.length,
        found: uniqueResults.length,
        topFinds: uniqueResults.slice(0, 5).map(t => ({
          ticker: t.ticker,
          narrative: t.matchedNarrative,
          mcap: '$' + (t.marketCap / 1000).toFixed(0) + 'K',
        })),
      }, 'Narrative scan cycle complete');

      // Clean up old discoveries
      this.cleanupDiscoveries();

    } catch (error) {
      logger.error({ error }, 'Error in narrative scan cycle');
    }
  }

  /**
   * Get next batch of narratives to search
   */
  private getNextNarratives(): string[] {
    const narratives: string[] = [];

    for (let i = 0; i < this.narrativesPerCycle; i++) {
      narratives.push(this.config.narratives[this.narrativeIndex]);
      this.narrativeIndex = (this.narrativeIndex + 1) % this.config.narratives.length;
    }

    return narratives;
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
    currentNarrativeIndex: number;
    discoveredTokensCount: number;
    lastResultsCount: number;
  } {
    return {
      isRunning: this.isRunning,
      narrativeCount: this.config.narratives.length,
      currentNarrativeIndex: this.narrativeIndex,
      discoveredTokensCount: this.discoveredTokens.size,
      lastResultsCount: this.lastResults.length,
    };
  }
}

// ============ EXPORTS ============

export const narrativeScanner = new NarrativeScanner();

export default {
  NarrativeScanner,
  narrativeScanner,
};
