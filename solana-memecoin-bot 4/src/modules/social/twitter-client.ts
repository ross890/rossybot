// ===========================================
// TWITTER/X API CLIENT
// Real-time social data fetching for token analysis
// Uses Twitter API v2 with rate limiting and caching
// ===========================================

import axios, { AxiosInstance } from 'axios';
import { logger } from '../../utils/logger.js';
import { appConfig } from '../../config/index.js';
import { getTwitterBearerToken } from '../../utils/twitter-auth.js';

// ============ TYPES ============

export interface Tweet {
  id: string;
  text: string;
  authorId: string;
  createdAt: Date;
  metrics: {
    retweets: number;
    replies: number;
    likes: number;
    quotes: number;
    impressions: number;
  };
  author?: TwitterUser;
  entities?: {
    hashtags?: string[];
    cashtags?: string[];
    mentions?: string[];
    urls?: string[];
  };
}

export interface TwitterUser {
  id: string;
  username: string;
  name: string;
  verified: boolean;
  followerCount: number;
  followingCount: number;
  tweetCount: number;
  createdAt: Date;
  description?: string;
  profileImageUrl?: string;
}

export interface SearchResult {
  tweets: Tweet[];
  meta: {
    resultCount: number;
    newestId?: string;
    oldestId?: string;
    nextToken?: string;
  };
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: Date;
}

// Twitter API response shapes
interface TwitterSearchResponse {
  data?: any[];
  includes?: {
    users?: any[];
  };
  meta?: {
    result_count?: number;
    newest_id?: string;
    oldest_id?: string;
    next_token?: string;
  };
}

interface TwitterUserResponse {
  data?: any;
}

interface TwitterUsersResponse {
  data?: any[];
}

// ============ CONSTANTS ============

const TWITTER_API_BASE = 'https://api.twitter.com/2';

// Rate limits per 15-minute window (Twitter API v2 Basic tier)
const RATE_LIMITS = {
  SEARCH_RECENT: 180,      // 180 requests per 15 min
  USER_LOOKUP: 300,        // 300 requests per 15 min
  TWEET_LOOKUP: 300,       // 300 requests per 15 min
} as const;

// Cache TTLs
const CACHE_TTL = {
  SEARCH: 60 * 1000,       // 1 minute for search results
  USER: 5 * 60 * 1000,     // 5 minutes for user data
  TWEET: 2 * 60 * 1000,    // 2 minutes for tweet data
} as const;

// ============ TWITTER CLIENT CLASS ============

export class TwitterClient {
  private client: AxiosInstance | null = null;
  private bearerToken: string | null = null;
  private initialized = false;

  // Rate limiting tracking
  private rateLimits: Map<string, RateLimitInfo> = new Map();
  private requestCounts: Map<string, number> = new Map();
  private windowStart: Map<string, number> = new Map();

  // Caching
  private searchCache: Map<string, { data: SearchResult; timestamp: number }> = new Map();
  private userCache: Map<string, { data: TwitterUser; timestamp: number }> = new Map();

  // Request queue for rate limiting
  private requestQueue: Array<{
    execute: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  private processingQueue = false;

  /**
   * Initialize the Twitter client
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    try {
      // Get bearer token
      this.bearerToken = await getTwitterBearerToken(
        appConfig.twitterBearerToken,
        appConfig.twitterConsumerKey,
        appConfig.twitterConsumerSecret
      );

      if (!this.bearerToken) {
        logger.warn('Twitter client initialization failed - no valid credentials');
        return false;
      }

      // Create axios instance with auth
      this.client = axios.create({
        baseURL: TWITTER_API_BASE,
        headers: {
          'Authorization': `Bearer ${this.bearerToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      // Add response interceptor for rate limit tracking
      this.client.interceptors.response.use(
        (response: any) => {
          this.updateRateLimits(response.headers);
          return response;
        },
        (error: any) => {
          if (error.response?.status === 429) {
            logger.warn('Twitter API rate limit exceeded');
            this.handleRateLimitError(error.response.headers);
          }
          throw error;
        }
      );

      this.initialized = true;
      logger.info('Twitter client initialized successfully');
      return true;
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Twitter client');
      return false;
    }
  }

  /**
   * Check if client is ready
   */
  isReady(): boolean {
    return this.initialized && this.client !== null;
  }

  /**
   * Search recent tweets (last 7 days) for a query
   * Supports token tickers, names, contract addresses
   */
  async searchRecentTweets(
    query: string,
    options: {
      maxResults?: number;
      startTime?: Date;
      endTime?: Date;
      nextToken?: string;
    } = {}
  ): Promise<SearchResult | null> {
    if (!this.isReady()) {
      await this.initialize();
      if (!this.isReady()) return null;
    }

    const cacheKey = `search:${query}:${options.maxResults || 100}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL.SEARCH) {
      return cached.data;
    }

    try {
      const params: Record<string, any> = {
        query: query,
        max_results: Math.min(options.maxResults || 100, 100),
        'tweet.fields': 'created_at,public_metrics,entities,author_id',
        'user.fields': 'created_at,public_metrics,verified,description',
        expansions: 'author_id',
      };

      if (options.startTime) {
        params.start_time = options.startTime.toISOString();
      }
      if (options.endTime) {
        params.end_time = options.endTime.toISOString();
      }
      if (options.nextToken) {
        params.next_token = options.nextToken;
      }

      const response = await this.makeRequest<TwitterSearchResponse>('SEARCH_RECENT', () =>
        this.client!.get('/tweets/search/recent', { params })
      );

      if (!response?.data) {
        return { tweets: [], meta: { resultCount: 0 } };
      }

      // Parse users into a map for quick lookup
      const usersMap = new Map<string, TwitterUser>();
      if (response.includes?.users) {
        for (const user of response.includes.users) {
          usersMap.set(user.id, this.parseUser(user));
        }
      }

      // Parse tweets
      const tweets: Tweet[] = (response.data || []).map((tweet: any) =>
        this.parseTweet(tweet, usersMap.get(tweet.author_id))
      );

      const result: SearchResult = {
        tweets,
        meta: {
          resultCount: response.meta?.result_count || tweets.length,
          newestId: response.meta?.newest_id,
          oldestId: response.meta?.oldest_id,
          nextToken: response.meta?.next_token,
        },
      };

      // Cache the result
      this.searchCache.set(cacheKey, { data: result, timestamp: Date.now() });

      return result;
    } catch (error) {
      logger.error({ error, query }, 'Failed to search tweets');
      return null;
    }
  }

  /**
   * Search for tweets about a specific token
   * Builds an optimized query for memecoin mentions
   */
  async searchTokenMentions(
    ticker: string,
    tokenName?: string,
    contractAddress?: string,
    options: {
      maxResults?: number;
      hoursBack?: number;
    } = {}
  ): Promise<SearchResult | null> {
    // Build comprehensive search query
    const queryParts: string[] = [];

    // Add cashtag search (most reliable for tokens)
    if (ticker && ticker.length >= 2) {
      queryParts.push(`$${ticker.toUpperCase()}`);
    }

    // Add hashtag variation
    if (ticker && ticker.length >= 2) {
      queryParts.push(`#${ticker.toUpperCase()}`);
    }

    // Add token name if different from ticker
    if (tokenName && tokenName.toLowerCase() !== ticker?.toLowerCase()) {
      // Quote multi-word names
      if (tokenName.includes(' ')) {
        queryParts.push(`"${tokenName}"`);
      } else {
        queryParts.push(tokenName);
      }
    }

    // Add contract address (shortened) for very specific searches
    if (contractAddress && queryParts.length < 2) {
      queryParts.push(contractAddress.slice(0, 8));
    }

    if (queryParts.length === 0) {
      return null;
    }

    // Build OR query and filter for crypto context
    const baseQuery = queryParts.join(' OR ');

    // Add filters: English, no retweets, crypto context
    const query = `(${baseQuery}) (solana OR sol OR memecoin OR crypto OR pump OR moon OR dex) -is:retweet lang:en`;

    const startTime = options.hoursBack
      ? new Date(Date.now() - options.hoursBack * 60 * 60 * 1000)
      : new Date(Date.now() - 24 * 60 * 60 * 1000); // Default 24h

    return this.searchRecentTweets(query, {
      maxResults: options.maxResults || 100,
      startTime,
    });
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<TwitterUser | null> {
    if (!this.isReady()) {
      await this.initialize();
      if (!this.isReady()) return null;
    }

    const cacheKey = `user:${username.toLowerCase()}`;
    const cached = this.userCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL.USER) {
      return cached.data;
    }

    try {
      const response = await this.makeRequest<TwitterUserResponse>('USER_LOOKUP', () =>
        this.client!.get(`/users/by/username/${username}`, {
          params: {
            'user.fields': 'created_at,public_metrics,verified,description,profile_image_url',
          },
        })
      );

      if (!response?.data) return null;

      const user = this.parseUser(response.data);
      this.userCache.set(cacheKey, { data: user, timestamp: Date.now() });

      return user;
    } catch (error) {
      logger.debug({ error, username }, 'Failed to get user');
      return null;
    }
  }

  /**
   * Get users by IDs (batch lookup)
   */
  async getUsersByIds(userIds: string[]): Promise<Map<string, TwitterUser>> {
    if (!this.isReady() || userIds.length === 0) {
      return new Map();
    }

    // Check cache first
    const result = new Map<string, TwitterUser>();
    const uncachedIds: string[] = [];

    for (const id of userIds) {
      const cacheKey = `user:id:${id}`;
      const cached = this.userCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL.USER) {
        result.set(id, cached.data);
      } else {
        uncachedIds.push(id);
      }
    }

    if (uncachedIds.length === 0) {
      return result;
    }

    try {
      // Batch lookup (max 100 per request)
      const batches = this.chunkArray(uncachedIds, 100);

      for (const batch of batches) {
        const response = await this.makeRequest<TwitterUsersResponse>('USER_LOOKUP', () =>
          this.client!.get('/users', {
            params: {
              ids: batch.join(','),
              'user.fields': 'created_at,public_metrics,verified,description,profile_image_url',
            },
          })
        );

        if (response?.data) {
          for (const userData of response.data) {
            const user = this.parseUser(userData);
            result.set(user.id, user);
            this.userCache.set(`user:id:${user.id}`, { data: user, timestamp: Date.now() });
          }
        }
      }

      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to batch lookup users');
      return result;
    }
  }

  /**
   * Get trending topics (requires elevated access)
   * Falls back to searching popular crypto hashtags
   */
  async getCryptoTrends(): Promise<string[]> {
    // Twitter API v2 trends require elevated access
    // Instead, we maintain a list of crypto-related terms to monitor
    const baseTrends = [
      'solana', 'memecoin', 'pumpfun', 'raydium',
      'degen', 'airdrop', '100x', 'gem',
    ];

    // Could be extended to track actual trending cashtags
    // by analyzing high-volume recent searches
    return baseTrends;
  }

  // ============ PRIVATE HELPERS ============

  private parseTweet(data: any, author?: TwitterUser): Tweet {
    return {
      id: data.id,
      text: data.text,
      authorId: data.author_id,
      createdAt: new Date(data.created_at),
      metrics: {
        retweets: data.public_metrics?.retweet_count || 0,
        replies: data.public_metrics?.reply_count || 0,
        likes: data.public_metrics?.like_count || 0,
        quotes: data.public_metrics?.quote_count || 0,
        impressions: data.public_metrics?.impression_count || 0,
      },
      author,
      entities: {
        hashtags: data.entities?.hashtags?.map((h: any) => h.tag) || [],
        cashtags: data.entities?.cashtags?.map((c: any) => c.tag) || [],
        mentions: data.entities?.mentions?.map((m: any) => m.username) || [],
        urls: data.entities?.urls?.map((u: any) => u.expanded_url) || [],
      },
    };
  }

  private parseUser(data: any): TwitterUser {
    return {
      id: data.id,
      username: data.username,
      name: data.name,
      verified: data.verified || false,
      followerCount: data.public_metrics?.followers_count || 0,
      followingCount: data.public_metrics?.following_count || 0,
      tweetCount: data.public_metrics?.tweet_count || 0,
      createdAt: new Date(data.created_at),
      description: data.description,
      profileImageUrl: data.profile_image_url,
    };
  }

  private async makeRequest<T>(
    limitKey: string,
    request: () => Promise<{ data: T }>
  ): Promise<T | null> {
    // Check rate limits
    if (!this.canMakeRequest(limitKey)) {
      const resetTime = this.getResetTime(limitKey);
      logger.warn({ limitKey, resetTime }, 'Rate limit would be exceeded, queueing request');

      // Queue the request
      return new Promise((resolve, reject) => {
        this.requestQueue.push({
          execute: async () => {
            const response = await request();
            return response.data;
          },
          resolve,
          reject,
        });
        this.processQueue();
      });
    }

    this.incrementRequestCount(limitKey);

    try {
      const response = await request();
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 429) {
        // Rate limited - queue and retry
        return new Promise((resolve, reject) => {
          this.requestQueue.push({
            execute: async () => {
              const response = await request();
              return response.data;
            },
            resolve,
            reject,
          });
          this.processQueue();
        });
      }
      throw error;
    }
  }

  private canMakeRequest(limitKey: string): boolean {
    const now = Date.now();
    const windowStartTime = this.windowStart.get(limitKey) || now;

    // Reset window if 15 minutes have passed
    if (now - windowStartTime > 15 * 60 * 1000) {
      this.windowStart.set(limitKey, now);
      this.requestCounts.set(limitKey, 0);
      return true;
    }

    const currentCount = this.requestCounts.get(limitKey) || 0;
    const limit = RATE_LIMITS[limitKey as keyof typeof RATE_LIMITS] || 100;

    return currentCount < limit * 0.9; // Leave 10% buffer
  }

  private incrementRequestCount(limitKey: string): void {
    const current = this.requestCounts.get(limitKey) || 0;
    this.requestCounts.set(limitKey, current + 1);

    if (!this.windowStart.has(limitKey)) {
      this.windowStart.set(limitKey, Date.now());
    }
  }

  private getResetTime(limitKey: string): Date {
    const windowStartTime = this.windowStart.get(limitKey) || Date.now();
    return new Date(windowStartTime + 15 * 60 * 1000);
  }

  private updateRateLimits(headers: any): void {
    if (headers['x-rate-limit-remaining']) {
      const remaining = parseInt(headers['x-rate-limit-remaining'], 10);
      const limit = parseInt(headers['x-rate-limit-limit'] || '100', 10);
      const reset = parseInt(headers['x-rate-limit-reset'] || '0', 10);

      this.rateLimits.set('current', {
        limit,
        remaining,
        resetAt: new Date(reset * 1000),
      });

      if (remaining < 10) {
        logger.warn({ remaining, resetAt: new Date(reset * 1000) }, 'Twitter API rate limit running low');
      }
    }
  }

  private handleRateLimitError(headers: any): void {
    const reset = parseInt(headers['x-rate-limit-reset'] || '0', 10);
    const resetAt = new Date(reset * 1000);
    const waitMs = Math.max(0, resetAt.getTime() - Date.now());

    logger.info({ resetAt, waitMs }, 'Rate limited, will retry after reset');

    // Schedule queue processing after reset
    setTimeout(() => this.processQueue(), waitMs + 1000);
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.processingQueue = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift()!;

      // Wait if we're rate limited
      if (!this.canMakeRequest('SEARCH_RECENT')) {
        const waitMs = Math.max(0, this.getResetTime('SEARCH_RECENT').getTime() - Date.now());
        await new Promise((resolve) => setTimeout(resolve, waitMs + 1000));
      }

      try {
        const result = await request.execute();
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      }

      // Small delay between queued requests
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.processingQueue = false;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.searchCache.clear();
    this.userCache.clear();
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(): Map<string, RateLimitInfo> {
    return new Map(this.rateLimits);
  }
}

// ============ EXPORTS ============

export const twitterClient = new TwitterClient();

export default {
  TwitterClient,
  twitterClient,
};
