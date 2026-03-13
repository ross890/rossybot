// ===========================================
// MODULE: TWITTER/SOCIAL SENTIMENT SCANNER
// Monitors social signals for memecoin pumps.
// Uses a hybrid approach: free DexScreener/GMGN social
// data + optional Twitter API for KOL tweet detection.
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';

// ============ TYPES ============

export interface SocialMention {
  tokenAddress: string;
  source: 'TWITTER' | 'TELEGRAM' | 'DEXSCREENER' | 'GMGN';
  account: string;         // Username or channel
  timestamp: number;
  isKol: boolean;          // Is this a tracked KOL?
  followerCount?: number;
}

export interface SocialVelocity {
  tokenAddress: string;
  uniqueMentions5m: number;
  uniqueMentions1h: number;
  sources: string[];
  kolMentions: string[];   // KOL handles that mentioned
  velocityTier: 'VIRAL' | 'HIGH' | 'MODERATE' | 'LOW';
  bonusPoints: number;     // Score bonus to apply
  lastUpdated: number;
}

export interface TwitterScannerConfig {
  // Twitter API (optional — set TWITTER_BEARER_TOKEN to enable)
  twitterEnabled: boolean;
  twitterBearerToken: string | null;

  // Velocity thresholds
  viralThreshold: number;     // unique accounts in 5 min for VIRAL
  highThreshold: number;      // for HIGH
  moderateThreshold: number;  // for MODERATE

  // Scan interval
  scanIntervalMs: number;

  // Cache TTL
  cacheTtlMs: number;
}

// ============ CONSTANTS ============

const DEFAULT_CONFIG: TwitterScannerConfig = {
  twitterEnabled: false,
  twitterBearerToken: null,
  viralThreshold: 50,
  highThreshold: 20,
  moderateThreshold: 10,
  scanIntervalMs: 60 * 1000,  // 1 minute
  cacheTtlMs: 60 * 1000,      // Cache social data per token for 60 seconds
};

// Social velocity bonus points (applied to ANY token being evaluated)
const VELOCITY_BONUS = {
  VIRAL: 15,     // 50+ unique mentions in 5 min
  HIGH: 10,      // 20-50 mentions
  MODERATE: 5,   // 10-20 mentions
  LOW: 0,
} as const;

// Solana base58 contract address pattern (32-44 chars, alphanumeric)
const SOLANA_ADDRESS_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// ============ TWITTER SCANNER CLASS ============

export class TwitterScanner {
  private config: TwitterScannerConfig;
  private mentionCache: Map<string, SocialMention[]> = new Map();
  private velocityCache: Map<string, { data: SocialVelocity; expiry: number }> = new Map();
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  // Track KOL handles for immediate evaluation
  private trackedKolHandles: Set<string> = new Set();

  // Callback for when a social discovery signal is detected
  private onSocialDiscovery?: (tokenAddress: string, velocity: SocialVelocity) => Promise<void>;

  constructor(config: Partial<TwitterScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Check for Twitter API token
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    if (bearerToken && bearerToken.length > 10) {
      this.config.twitterEnabled = true;
      this.config.twitterBearerToken = bearerToken;
      logger.info('Twitter API enabled for social scanning');
    }
  }

  /**
   * Initialize the scanner — load tracked KOL handles.
   */
  async initialize(): Promise<void> {
    await this.loadTrackedKols();
    await this.ensureTable();
    logger.info({
      twitterEnabled: this.config.twitterEnabled,
      trackedKols: this.trackedKolHandles.size,
    }, 'Twitter scanner initialized');
  }

  /**
   * Start periodic social scanning.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Don't start periodic scanning unless Twitter API is available
    // DexScreener/GMGN social data is fetched on-demand per token
    if (this.config.twitterEnabled) {
      this.scanInterval = setInterval(
        () => this.scanTwitter(),
        this.config.scanIntervalMs,
      );
      logger.info('Twitter scanner started (periodic scan active)');
    } else {
      logger.info('Twitter scanner started (on-demand mode — no Twitter API)');
    }
  }

  /**
   * Stop scanning.
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    logger.info('Twitter scanner stopped');
  }

  /**
   * Set callback for social discovery signals.
   */
  setDiscoveryCallback(callback: (tokenAddress: string, velocity: SocialVelocity) => Promise<void>): void {
    this.onSocialDiscovery = callback;
  }

  /**
   * Get social velocity bonus points for a token.
   * This is called during token evaluation regardless of discovery source.
   * A DISCOVERY signal that also has Twitter buzz gets a scoring boost.
   */
  async getSocialVelocityBonus(tokenAddress: string): Promise<number> {
    const velocity = await this.getVelocity(tokenAddress);
    return velocity.bonusPoints;
  }

  /**
   * Get full social velocity data for a token.
   */
  async getVelocity(tokenAddress: string): Promise<SocialVelocity> {
    // Check cache
    const cached = this.velocityCache.get(tokenAddress);
    if (cached && cached.expiry > Date.now()) {
      return cached.data;
    }

    // Aggregate from all sources
    const mentions = this.mentionCache.get(tokenAddress) || [];
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;

    const recent5m = mentions.filter(m => m.timestamp > fiveMinAgo);
    const recent1h = mentions.filter(m => m.timestamp > oneHourAgo);

    // Count unique accounts
    const unique5m = new Set(recent5m.map(m => m.account)).size;
    const unique1h = new Set(recent1h.map(m => m.account)).size;
    const sources = [...new Set(mentions.map(m => m.source))];
    const kolMentions = [...new Set(
      mentions.filter(m => m.isKol).map(m => m.account)
    )];

    // Determine tier
    let velocityTier: SocialVelocity['velocityTier'] = 'LOW';
    let bonusPoints: number = VELOCITY_BONUS.LOW;

    if (unique5m >= this.config.viralThreshold) {
      velocityTier = 'VIRAL';
      bonusPoints = VELOCITY_BONUS.VIRAL;
    } else if (unique5m >= this.config.highThreshold) {
      velocityTier = 'HIGH';
      bonusPoints = VELOCITY_BONUS.HIGH;
    } else if (unique5m >= this.config.moderateThreshold) {
      velocityTier = 'MODERATE';
      bonusPoints = VELOCITY_BONUS.MODERATE;
    }

    const velocity: SocialVelocity = {
      tokenAddress,
      uniqueMentions5m: unique5m,
      uniqueMentions1h: unique1h,
      sources,
      kolMentions,
      velocityTier,
      bonusPoints,
      lastUpdated: now,
    };

    // Cache
    this.velocityCache.set(tokenAddress, {
      data: velocity,
      expiry: now + this.config.cacheTtlMs,
    });

    return velocity;
  }

  /**
   * Record a social mention (from any source).
   * Can be called by DexScreener integration, GMGN, etc.
   */
  recordMention(mention: SocialMention): void {
    const existing = this.mentionCache.get(mention.tokenAddress) || [];
    existing.push(mention);

    // Keep only last hour of mentions
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const filtered = existing.filter(m => m.timestamp > oneHourAgo);
    this.mentionCache.set(mention.tokenAddress, filtered);

    // Check if this triggers a social discovery signal
    this.checkVelocityThreshold(mention.tokenAddress);
  }

  /**
   * Ingest social links from DexScreener token info.
   * Called during token evaluation to capture social presence.
   */
  ingestDexScreenerSocials(
    tokenAddress: string,
    socialLinks: { twitter?: string; telegram?: string },
  ): void {
    const now = Date.now();

    if (socialLinks.twitter) {
      this.recordMention({
        tokenAddress,
        source: 'DEXSCREENER',
        account: socialLinks.twitter,
        timestamp: now,
        isKol: false,
      });
    }

    if (socialLinks.telegram) {
      this.recordMention({
        tokenAddress,
        source: 'DEXSCREENER',
        account: socialLinks.telegram,
        timestamp: now,
        isKol: false,
      });
    }
  }

  /**
   * Check if velocity threshold is hit → trigger social discovery.
   */
  private async checkVelocityThreshold(tokenAddress: string): Promise<void> {
    const velocity = await this.getVelocity(tokenAddress);

    // Only trigger SOCIAL_DISCOVERY for MODERATE+ velocity
    if (velocity.velocityTier === 'LOW') return;

    // Trigger callback if set
    if (this.onSocialDiscovery) {
      try {
        await this.onSocialDiscovery(tokenAddress, velocity);
      } catch (error) {
        logger.error({ error, tokenAddress }, 'Social discovery callback failed');
      }
    }
  }

  /**
   * Scan Twitter API for cashtag and address mentions.
   * Only runs if TWITTER_BEARER_TOKEN is configured.
   */
  private async scanTwitter(): Promise<void> {
    if (!this.config.twitterEnabled || !this.config.twitterBearerToken) return;

    try {
      // Twitter API v2 recent search
      // Search for Solana contract addresses in tweets
      const query = 'solana OR $SOL lang:en -is:retweet';
      const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=100&tweet.fields=author_id,created_at,public_metrics`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.config.twitterBearerToken}`,
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        if (response.status === 429) {
          logger.debug('Twitter API rate limited, will retry next cycle');
          return;
        }
        logger.warn({ status: response.status }, 'Twitter API error');
        return;
      }

      const data = await response.json() as any;
      const tweets = data.data || [];

      for (const tweet of tweets) {
        // Extract Solana addresses from tweet text
        const addresses = tweet.text.match(SOLANA_ADDRESS_REGEX) || [];

        for (const address of addresses) {
          // Skip common non-token addresses (SOL, USDC, etc.)
          if (this.isCommonAddress(address)) continue;

          const isKol = this.trackedKolHandles.has(tweet.author_id);

          this.recordMention({
            tokenAddress: address,
            source: 'TWITTER',
            account: tweet.author_id,
            timestamp: new Date(tweet.created_at).getTime(),
            isKol,
            followerCount: tweet.public_metrics?.followers_count,
          });
        }
      }

      logger.debug({ tweetCount: tweets.length }, 'Twitter scan complete');
    } catch (error) {
      logger.error({ error }, 'Twitter scan failed');
    }
  }

  /**
   * Check if address is a common non-token address.
   */
  private isCommonAddress(address: string): boolean {
    const commonAddresses = new Set([
      'So11111111111111111111111111111111111111112',   // Wrapped SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ]);
    return commonAddresses.has(address);
  }

  /**
   * Load tracked KOL handles from database.
   */
  private async loadTrackedKols(): Promise<void> {
    try {
      const result = await pool.query(`SELECT handle FROM kols`);
      for (const row of result.rows) {
        if (row.handle) {
          this.trackedKolHandles.add(row.handle.toLowerCase());
        }
      }
    } catch (error) {
      logger.debug({ error }, 'Failed to load KOL handles for Twitter scanning');
    }
  }

  /**
   * Ensure social_mentions table exists.
   */
  private async ensureTable(): Promise<void> {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS social_mentions (
          id SERIAL PRIMARY KEY,
          token_address TEXT NOT NULL,
          source TEXT NOT NULL,
          account TEXT NOT NULL,
          is_kol BOOLEAN DEFAULT FALSE,
          mention_time TIMESTAMP DEFAULT NOW(),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_social_mentions_token
        ON social_mentions(token_address, mention_time DESC)
      `);
    } catch (error) {
      logger.debug({ error }, 'Failed to create social_mentions table');
    }
  }

  /**
   * Format velocity for logging/display.
   */
  formatVelocity(velocity: SocialVelocity): string {
    const emoji = velocity.velocityTier === 'VIRAL' ? '🔥'
      : velocity.velocityTier === 'HIGH' ? '📈'
      : velocity.velocityTier === 'MODERATE' ? '📊'
      : '📉';

    let msg = `${emoji} Social: ${velocity.uniqueMentions5m} mentions/5m (${velocity.velocityTier})`;
    if (velocity.kolMentions.length > 0) {
      msg += ` | KOLs: ${velocity.kolMentions.join(', ')}`;
    }
    return msg;
  }
}

// ============ SINGLETON EXPORT ============

export const twitterScanner = new TwitterScanner();

export default twitterScanner;
