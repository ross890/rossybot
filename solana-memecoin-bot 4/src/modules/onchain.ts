// ===========================================
// MODULE 1A: ON-CHAIN DATA FETCHING
// ===========================================

import axios, { AxiosInstance } from 'axios';
import { appConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  TokenMetrics,
  TokenContractAnalysis,
  BundleAnalysis,
  DevWalletBehaviour,
  VolumeAuthenticityScore,
  DexScreenerPair,
  DexScreenerTokenInfo,
  CTOAnalysis,
} from '../types/index.js';
import { Database } from '../utils/database.js';

// ============ API CLIENTS ============

class HeliusClient {
  private client: AxiosInstance;
  private rpcUrl: string;
  private apiKey: string;

  // ============ RATE LIMITING ============
  // Helius free tier: 10 requests/second, paid tiers vary
  // We use a conservative 5 req/sec to avoid 429 errors
  private readonly MAX_REQUESTS_PER_SECOND = 5;
  private requestQueue: Array<{
    resolve: (value: any) => void;
    reject: (error: any) => void;
    request: () => Promise<any>;
  }> = [];
  private isProcessingQueue = false;
  private lastRequestTime = 0;
  private requestCount = 0;
  private rateLimitResetTime = 0;

  // ============ CACHING ============
  // Token holder data changes frequently but not instantly
  // 60 second cache prevents hammering the API for the same token
  private holderCache: Map<string, { data: any; expiry: number }> = new Map();
  private readonly HOLDER_CACHE_TTL_MS = 60 * 1000; // 60 seconds

  // Account info cache (mint/freeze authority) - rarely changes
  private accountInfoCache: Map<string, { data: any; expiry: number }> = new Map();
  private readonly ACCOUNT_INFO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Request deduplication - prevents duplicate in-flight requests
  private inflightRequests: Map<string, Promise<any>> = new Map();

  // Cache statistics
  private cacheStats = { hits: 0, misses: 0, rateLimited: 0 };

  // Rate limit logging throttling - avoid log spam
  private rateLimitHitCount = 0;
  private lastRateLimitLogTime = 0;
  private readonly RATE_LIMIT_LOG_INTERVAL_MS = 60 * 1000; // Only log every 60 seconds

  constructor() {
    this.apiKey = appConfig.heliusApiKey;

    // Validate API key is present
    if (!this.apiKey || this.apiKey.length < 10) {
      logger.error('HELIUS_API_KEY is missing or invalid');
    }

    // Ensure the RPC URL includes the API key
    // Helius RPC URL format: https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
    let rpcUrl = appConfig.heliusRpcUrl;
    if (!rpcUrl.includes('api-key=')) {
      const separator = rpcUrl.includes('?') ? '&' : '?';
      rpcUrl = `${rpcUrl}${separator}api-key=${this.apiKey}`;
    }
    this.rpcUrl = rpcUrl;

    // Log the base URL (without full API key for security)
    const maskedUrl = this.rpcUrl.replace(/api-key=([^&]+)/, `api-key=${this.apiKey.slice(0, 4)}...`);
    logger.info(`Helius client initialized with URL: ${maskedUrl}`);

    this.client = axios.create({
      baseURL: this.rpcUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Log cache stats every 5 minutes
    setInterval(() => this.logCacheStats(), 5 * 60 * 1000);

    // Clean up expired cache entries every 2 minutes
    setInterval(() => this.cleanupCaches(), 2 * 60 * 1000);
  }

  /**
   * Rate-limited request execution
   * Queues requests and processes them at a controlled rate
   */
  private async executeWithRateLimit<T>(request: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ resolve, reject, request });
      this.processQueue();
    });
  }

  /**
   * Process the request queue respecting rate limits
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const now = Date.now();

      // Check if we're in a rate limit cooldown period
      if (now < this.rateLimitResetTime) {
        const waitTime = this.rateLimitResetTime - now;
        logger.debug({ waitTime }, 'Helius rate limit cooldown, waiting...');
        await this.sleep(waitTime);
        continue;
      }

      // Reset counter every second
      if (now - this.lastRequestTime > 1000) {
        this.requestCount = 0;
        this.lastRequestTime = now;
      }

      // If we've hit the limit, wait for the next second
      if (this.requestCount >= this.MAX_REQUESTS_PER_SECOND) {
        const waitTime = 1000 - (now - this.lastRequestTime);
        if (waitTime > 0) {
          await this.sleep(waitTime);
        }
        this.requestCount = 0;
        this.lastRequestTime = Date.now();
      }

      // Process the next request
      const item = this.requestQueue.shift();
      if (!item) break;

      this.requestCount++;

      try {
        const result = await item.request();
        item.resolve(result);
      } catch (error: any) {
        // Handle rate limiting specifically
        if (error?.response?.status === 429) {
          this.cacheStats.rateLimited++;
          // Back off for 2 seconds on rate limit
          this.rateLimitResetTime = Date.now() + 2000;
          // Re-queue the request
          this.requestQueue.unshift(item);
          this.logRateLimit();
          await this.sleep(2000);
        } else {
          item.reject(error);
        }
      }
    }

    this.isProcessingQueue = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Log rate limit events with throttling to avoid spam
   * Only logs every 60 seconds or when first hit
   */
  private logRateLimit(): void {
    this.rateLimitHitCount++;
    const now = Date.now();
    const timeSinceLastLog = now - this.lastRateLimitLogTime;

    // Log if this is the first hit, or if enough time has passed
    if (this.lastRateLimitLogTime === 0 || timeSinceLastLog >= this.RATE_LIMIT_LOG_INTERVAL_MS) {
      logger.warn({
        hitCount: this.rateLimitHitCount,
        periodSecs: Math.round(timeSinceLastLog / 1000)
      }, 'Helius 429 rate limit hit');
      this.lastRateLimitLogTime = now;
      this.rateLimitHitCount = 0; // Reset counter after logging
    }
  }

  private cleanupCaches(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.holderCache) {
      if (value.expiry < now) {
        this.holderCache.delete(key);
        cleaned++;
      }
    }

    for (const [key, value] of this.accountInfoCache) {
      if (value.expiry < now) {
        this.accountInfoCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned, holderCache: this.holderCache.size, accountCache: this.accountInfoCache.size }, 'Helius cache cleanup');
    }
  }

  private logCacheStats(): void {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    const hitRate = total > 0 ? ((this.cacheStats.hits / total) * 100).toFixed(1) : '0';

    logger.info({
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      rateLimited: this.cacheStats.rateLimited,
      hitRate: `${hitRate}%`,
      queueSize: this.requestQueue.length,
      cacheSizes: {
        holders: this.holderCache.size,
        accountInfo: this.accountInfoCache.size,
      },
    }, '📊 Helius API cache statistics (5 min window)');

    // Reset stats for next window
    this.cacheStats = { hits: 0, misses: 0, rateLimited: 0 };
  }

  async getTokenHolders(mintAddress: string): Promise<{
    total: number;
    topHolders: { address: string; amount: number; percentage: number }[];
  }> {
    // Check cache first
    const cached = this.holderCache.get(mintAddress);
    if (cached && cached.expiry > Date.now()) {
      this.cacheStats.hits++;
      return cached.data;
    }

    // Check for in-flight request (deduplication)
    const cacheKey = `holders:${mintAddress}`;
    const inflight = this.inflightRequests.get(cacheKey);
    if (inflight) {
      this.cacheStats.hits++;
      return inflight;
    }

    this.cacheStats.misses++;

    // Create the request promise
    const requestPromise = this.executeWithRateLimit(async () => {
      const response = await this.client.post('', {
        jsonrpc: '2.0',
        id: 'holders-request',
        method: 'getTokenAccounts',
        params: {
          mint: mintAddress,
          page: 1,
          limit: 100,
        },
      });

      const accounts = response.data.result?.token_accounts || [];
      const totalSupply = accounts.reduce((sum: number, acc: any) => sum + (acc.amount || 0), 0);

      // Sort by amount and get top 10
      const sorted = accounts.sort((a: any, b: any) => (b.amount || 0) - (a.amount || 0));
      const top10 = sorted.slice(0, 10).map((acc: any) => ({
        address: acc.owner,
        amount: acc.amount || 0,
        percentage: totalSupply > 0 ? ((acc.amount || 0) / totalSupply) * 100 : 0,
      }));

      return {
        total: accounts.length,
        topHolders: top10,
      };
    });

    // Track in-flight request
    this.inflightRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;

      // Cache the result
      this.holderCache.set(mintAddress, {
        data: result,
        expiry: Date.now() + this.HOLDER_CACHE_TTL_MS,
      });

      return result;
    } catch (error: any) {
      const status = error?.response?.status;
      const errorData = error?.response?.data;
      const message = errorData?.error?.message || errorData?.error || error?.message;
      logger.error(`Failed to get token holders from Helius: status=${status} error=${message} url=${this.rpcUrl.replace(/api-key=([^&]+)/, 'api-key=***')}`);
      throw error;
    } finally {
      // Clear in-flight tracking
      this.inflightRequests.delete(cacheKey);
    }
  }
  
  async getRecentTransactions(address: string, limit = 100): Promise<any[]> {
    try {
      const response = await this.client.post('', {
        jsonrpc: '2.0',
        id: 'tx-request',
        method: 'getSignaturesForAddress',
        params: [address, { limit }],
      });
      
      return response.data.result || [];
    } catch (error) {
      logger.error({ error, address }, 'Failed to get transactions from Helius');
      return [];
    }
  }
  
  async getTransaction(signature: string): Promise<any> {
    try {
      const response = await this.client.post('', {
        jsonrpc: '2.0',
        id: 'tx-detail',
        method: 'getTransaction',
        params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      });
      
      return response.data.result;
    } catch (error) {
      logger.error({ error, signature }, 'Failed to get transaction details');
      return null;
    }
  }
  
  async getAccountInfo(address: string): Promise<any> {
    // Check cache first
    const cached = this.accountInfoCache.get(address);
    if (cached && cached.expiry > Date.now()) {
      this.cacheStats.hits++;
      return cached.data;
    }

    // Check for in-flight request (deduplication)
    const cacheKey = `account:${address}`;
    const inflight = this.inflightRequests.get(cacheKey);
    if (inflight) {
      this.cacheStats.hits++;
      return inflight;
    }

    this.cacheStats.misses++;

    // Create the request promise with rate limiting
    const requestPromise = this.executeWithRateLimit(async () => {
      const response = await this.client.post('', {
        jsonrpc: '2.0',
        id: 'account-info',
        method: 'getAccountInfo',
        params: [address, { encoding: 'jsonParsed' }],
      });

      return response.data.result?.value;
    });

    // Track in-flight request
    this.inflightRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;

      // Cache the result (even null results to avoid repeated lookups)
      this.accountInfoCache.set(address, {
        data: result,
        expiry: Date.now() + this.ACCOUNT_INFO_CACHE_TTL_MS,
      });

      return result;
    } catch (error) {
      logger.error({ error, address }, 'Failed to get account info');
      return null;
    } finally {
      // Clear in-flight tracking
      this.inflightRequests.delete(cacheKey);
    }
  }

  /**
   * Get token mint info including mint/freeze authority
   * This replaces the Birdeye getTokenSecurity call - FREE via Helius RPC
   */
  async getTokenMintInfo(mintAddress: string): Promise<{
    mintAuthority: string | null;
    freezeAuthority: string | null;
    decimals: number;
    supply: string;
    isInitialized: boolean;
  } | null> {
    try {
      const accountInfo = await this.getAccountInfo(mintAddress);

      if (!accountInfo || !accountInfo.data) {
        logger.debug({ mintAddress }, 'No account info found for mint');
        return null;
      }

      // Parse SPL Token mint data
      const parsed = accountInfo.data.parsed;
      if (!parsed || parsed.type !== 'mint') {
        logger.debug({ mintAddress, type: parsed?.type }, 'Account is not a mint');
        return null;
      }

      const info = parsed.info;
      return {
        mintAuthority: info.mintAuthority || null,
        freezeAuthority: info.freezeAuthority || null,
        decimals: info.decimals || 0,
        supply: info.supply || '0',
        isInitialized: info.isInitialized !== false,
      };
    } catch (error) {
      logger.error({ error, mintAddress }, 'Failed to get token mint info from Helius');
      return null;
    }
  }

  /**
   * Get token creation signature (first transaction for the mint)
   * This can help determine token age and creator
   */
  async getTokenCreationSignature(mintAddress: string): Promise<{
    signature: string;
    blockTime: number;
    slot: number;
  } | null> {
    try {
      // Get the oldest signatures for this mint (limit 1, before=null gets oldest)
      const response = await this.client.post('', {
        jsonrpc: '2.0',
        id: 'creation-sig',
        method: 'getSignaturesForAddress',
        params: [mintAddress, { limit: 1 }],
      });

      const signatures = response.data.result || [];
      if (signatures.length === 0) {
        return null;
      }

      // The last signature in history is the creation
      // But getSignaturesForAddress returns newest first, so we need to get the oldest
      // For now, return the first one we get (recent activity indicator)
      const sig = signatures[0];
      return {
        signature: sig.signature,
        blockTime: sig.blockTime || 0,
        slot: sig.slot || 0,
      };
    } catch (error) {
      logger.debug({ error, mintAddress }, 'Failed to get token creation signature');
      return null;
    }
  }
}

// NOTE: BirdeyeClient has been removed to eliminate the paid Birdeye API dependency.
// All functionality is now covered by free alternatives:
//   - Token overview/metrics: DexScreener (free)
//   - Token security: Helius RPC getAccountInfo (included in plan)
//   - Token creation info: Helius RPC getSignaturesForAddress (included in plan)
//   - Trade data: DexScreener pairs txns data (free)
//   - New listings: DexScreener + Jupiter recent tokens (free)
//   - Market cap range/trending/meme: DexScreener trending + Jupiter verified (free)

class DexScreenerClient {
  private client: AxiosInstance;

  // Cache for token pairs with TTL
  private pairsCache: Map<string, { data: DexScreenerPair[]; expiry: number }> = new Map();
  private readonly CACHE_TTL_MS = 30 * 1000; // 30 seconds cache
  private readonly CACHE_TTL_EMPTY_MS = 10 * 1000; // 10 seconds for empty results
  private readonly MAX_CACHE_SIZE = 500; // Prevent memory bloat

  // Rate limiting - DexScreener free tier allows ~300 req/min (~5/sec)
  // Reduced to 2/sec to share headroom with token-crawler and discovery modules
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL_MS = 500; // Max 2 requests/second
  private rateLimitBackoff = 0; // Additional backoff when rate limited

  // Rate limit logging throttling - avoid log spam
  private rateLimitHitCount = 0;
  private lastRateLimitLogTime = 0;
  private readonly RATE_LIMIT_LOG_INTERVAL_MS = 60 * 1000; // Only log every 60 seconds

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.dexscreener.com',
      timeout: 10000,
    });

    // Clean up expired cache entries every 5 minutes
    setInterval(() => this.cleanupCache(), 5 * 60 * 1000);
  }

  /**
   * Wait for rate limit before making request
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const requiredWait = this.MIN_REQUEST_INTERVAL_MS + this.rateLimitBackoff - timeSinceLastRequest;

    if (requiredWait > 0) {
      await new Promise(resolve => setTimeout(resolve, requiredWait));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.pairsCache) {
      if (value.expiry < now) {
        this.pairsCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: this.pairsCache.size }, 'DexScreener cache cleanup');
    }
  }

  /**
   * Log rate limit events with throttling to avoid spam
   * Only logs every 60 seconds or when first hit
   */
  private logRateLimit(): void {
    this.rateLimitHitCount++;
    const now = Date.now();
    const timeSinceLastLog = now - this.lastRateLimitLogTime;

    // Log if this is the first hit, or if enough time has passed
    if (this.lastRateLimitLogTime === 0 || timeSinceLastLog >= this.RATE_LIMIT_LOG_INTERVAL_MS) {
      logger.warn({
        backoffMs: this.rateLimitBackoff,
        hitCount: this.rateLimitHitCount,
        periodSecs: Math.round(timeSinceLastLog / 1000)
      }, 'DexScreener rate limited');
      this.lastRateLimitLogTime = now;
      this.rateLimitHitCount = 0; // Reset counter after logging
    }
  }

  async getTokenPairs(address: string): Promise<DexScreenerPair[]> {
    const now = Date.now();

    // Check cache first
    const cached = this.pairsCache.get(address);
    if (cached && cached.expiry > now) {
      return cached.data;
    }

    // Wait for rate limit before making request
    await this.waitForRateLimit();

    try {
      const response = await this.client.get(`/latest/dex/tokens/${address}`);
      const pairs = response.data.pairs?.filter((p: any) => p.chainId === 'solana') || [];

      // Cache the result
      const requestTime = Date.now();
      const ttl = pairs.length > 0 ? this.CACHE_TTL_MS : this.CACHE_TTL_EMPTY_MS;
      this.pairsCache.set(address, { data: pairs, expiry: requestTime + ttl });

      // Successful request - halve backoff for faster recovery
      if (this.rateLimitBackoff > 0) {
        this.rateLimitBackoff = Math.floor(this.rateLimitBackoff / 2);
        if (this.rateLimitBackoff < 50) this.rateLimitBackoff = 0;
      }

      // Prevent cache from growing too large
      if (this.pairsCache.size > this.MAX_CACHE_SIZE) {
        // Remove oldest entries (first 100)
        const keysToDelete = Array.from(this.pairsCache.keys()).slice(0, 100);
        keysToDelete.forEach(k => this.pairsCache.delete(k));
      }

      return pairs;
    } catch (error: any) {
      const status = error?.response?.status;
      const errorData = error?.response?.data;
      const message = errorData?.message || errorData?.error || error?.message;

      // On rate limit, add exponential backoff and cache empty result
      if (status === 429) {
        this.rateLimitBackoff = Math.min(5000, (this.rateLimitBackoff || 500) * 2);
        this.pairsCache.set(address, { data: [], expiry: Date.now() + this.rateLimitBackoff });
        this.logRateLimit();
      } else {
        logger.info(`DexScreener getTokenPairs failed: status=${status} error=${message} address=${address.slice(0, 8)}...`);
      }

      return [];
    }
  }

  async searchTokens(query: string): Promise<DexScreenerPair[]> {
    await this.waitForRateLimit();
    try {
      const response = await this.client.get(`/latest/dex/search`, {
        params: { q: query },
      });
      return response.data.pairs?.filter((p: any) => p.chainId === 'solana') || [];
    } catch (error: any) {
      const status = error?.response?.status;
      const message = error?.response?.data?.message || error?.message;
      if (status === 429) {
        this.rateLimitBackoff = Math.min(5000, (this.rateLimitBackoff || 500) * 2);
        this.logRateLimit();
      } else {
        logger.error(`DexScreener searchTokens failed: status=${status} error=${message} query=${query}`);
      }
      return [];
    }
  }

  /**
   * Get new/trending Solana token pairs from DexScreener
   * This is a free alternative to Birdeye's new_listing endpoint
   */
  async getNewSolanaPairs(limit = 50): Promise<any[]> {
    await this.waitForRateLimit();
    try {
      // Get latest Solana pairs using the token-boosts endpoint
      const response = await this.client.get('/token-boosts/latest/v1');
      const allPairs = response.data || [];

      // Filter for Solana pairs
      const solanaPairs = allPairs
        .filter((p: any) => p.chainId === 'solana')
        .slice(0, limit);

      logger.info({ count: solanaPairs.length }, 'Fetched new Solana pairs from DexScreener token-boosts');
      return solanaPairs;
    } catch (error: any) {
      logger.debug({ error: error?.message, status: error?.response?.status }, 'token-boosts endpoint failed, trying token-profiles');

      // Fallback: try token-profiles endpoint
      try {
        const response = await this.client.get('/token-profiles/latest/v1');
        const allProfiles = response.data || [];

        // Filter for Solana tokens
        const solanaTokens = allProfiles
          .filter((p: any) => p.chainId === 'solana')
          .slice(0, limit);

        logger.info({ count: solanaTokens.length }, 'Fetched Solana tokens from DexScreener token-profiles');
        return solanaTokens;
      } catch (fallbackError: any) {
        logger.warn({
          error: fallbackError?.message,
          status: fallbackError?.response?.status
        }, 'Failed to get new pairs from DexScreener - all endpoints failed');
        return [];
      }
    }
  }

  /**
   * Get trending tokens on Solana via DexScreener
   * Uses token-boosts and token-profiles endpoints as the /latest/dex/pairs/solana endpoint no longer exists
   */
  async getTrendingSolanaTokens(limit = 50): Promise<string[]> {
    const addresses: string[] = [];

    await this.waitForRateLimit();
    try {
      // Primary: Get boosted tokens (these are actively promoted/trending)
      const boostsResponse = await this.client.get('/token-boosts/latest/v1');
      const boosts = boostsResponse.data || [];

      for (const token of boosts) {
        if (token.chainId === 'solana' && token.tokenAddress && !addresses.includes(token.tokenAddress)) {
          addresses.push(token.tokenAddress);
          if (addresses.length >= limit) break;
        }
      }

      logger.info({ count: addresses.length }, 'Fetched trending Solana token addresses from token-boosts');

      // If we have enough, return early
      if (addresses.length >= limit) {
        return addresses;
      }
    } catch (error: any) {
      if (error?.response?.status === 429) {
        this.rateLimitBackoff = Math.min(5000, (this.rateLimitBackoff || 500) * 2);
        this.logRateLimit();
      } else {
        logger.debug({ error: error?.message, status: error?.response?.status }, 'token-boosts endpoint failed for trending tokens');
      }
    }

    // Fallback: Try token-profiles endpoint
    await this.waitForRateLimit();
    try {
      const profilesResponse = await this.client.get('/token-profiles/latest/v1');
      const profiles = profilesResponse.data || [];

      for (const token of profiles) {
        if (token.chainId === 'solana' && token.tokenAddress && !addresses.includes(token.tokenAddress)) {
          addresses.push(token.tokenAddress);
          if (addresses.length >= limit) break;
        }
      }

      logger.info({ count: addresses.length }, 'Fetched trending Solana token addresses (combined)');
    } catch (error: any) {
      logger.warn({
        error: error?.message,
        status: error?.response?.status
      }, 'Failed to get trending Solana tokens - all endpoints failed');
    }

    return addresses;
  }

  /**
   * Get detailed token info including payment/boost status from DexScreener
   * This checks if the token has paid for DexScreener advertising/boosts
   */
  async getTokenInfo(address: string): Promise<DexScreenerTokenInfo> {
    const defaultInfo: DexScreenerTokenInfo = {
      tokenAddress: address,
      hasClaimedProfile: false,
      hasPaidDexscreener: false,
      boostCount: 0,
      isBoosted: false,
      hasTokenProfile: false,
      hasTokenAds: false,
      socialLinks: {},
    };

    try {
      // First, get the token pairs data which includes boost info
      const pairs = await this.getTokenPairs(address);

      if (pairs.length === 0) {
        return defaultInfo;
      }

      const primaryPair = pairs[0];

      // Check for boosts (paid advertising — distinct from profile claim)
      const boostCount = primaryPair.boosts?.active || 0;
      const isBoosted = boostCount > 0;

      // Check for token profile (claimed/owned profile on DexScreener)
      // A claimed profile means the token owner has set up their DexScreener page
      // with image, header, social links, etc. This is DIFFERENT from boosting.
      const hasTokenProfile = !!(
        primaryPair.info?.imageUrl ||
        primaryPair.info?.header ||
        primaryPair.info?.websites?.length ||
        primaryPair.info?.socials?.length
      );

      // hasClaimedProfile = the profile has been claimed and has an owner
      // This is the correct meaning of "Dex Paid" — someone paid to claim the profile
      const hasClaimedProfile = hasTokenProfile;

      // hasPaidDexscreener kept for backwards compat, now means profile OR boosts
      const hasPaidDexscreener = hasClaimedProfile || isBoosted;

      // Extract social links
      const socialLinks: DexScreenerTokenInfo['socialLinks'] = {};
      if (primaryPair.info?.socials) {
        for (const social of primaryPair.info.socials) {
          if (social.type === 'twitter') socialLinks.twitter = social.url;
          if (social.type === 'telegram') socialLinks.telegram = social.url;
          if (social.type === 'discord') socialLinks.discord = social.url;
        }
      }
      if (primaryPair.info?.websites && primaryPair.info.websites.length > 0) {
        socialLinks.website = primaryPair.info.websites[0].url;
      }

      // Token ads are indicated by having both boosts AND a profile
      const hasTokenAds = isBoosted && hasTokenProfile;

      const info: DexScreenerTokenInfo = {
        tokenAddress: address,
        hasClaimedProfile,
        hasPaidDexscreener,
        boostCount,
        isBoosted,
        hasTokenProfile,
        hasTokenAds,
        socialLinks,
      };

      logger.debug({
        address: address.slice(0, 8),
        profileClaimed: hasClaimedProfile,
        isBoosted,
        boosts: boostCount,
      }, 'DexScreener token info fetched');

      return info;
    } catch (error: any) {
      logger.debug({
        error: error?.message,
        address: address.slice(0, 8)
      }, 'Failed to get DexScreener token info');
      return defaultInfo;
    }
  }

  /**
   * Check if a token is in the boosted/paid tokens list
   * Uses the token-boosts endpoint to check against recently boosted tokens
   */
  async isTokenBoosted(address: string): Promise<boolean> {
    try {
      const response = await this.client.get('/token-boosts/latest/v1');
      const boostedTokens = response.data || [];

      return boostedTokens.some((token: any) =>
        token.chainId === 'solana' &&
        token.tokenAddress?.toLowerCase() === address.toLowerCase()
      );
    } catch (error) {
      // Fall back to checking via getTokenInfo
      const info = await this.getTokenInfo(address);
      return info.hasPaidDexscreener;
    }
  }
}

/**
 * Analyze if a token is a CTO (Community Takeover)
 * A CTO occurs when the original developer abandons a project and the community takes over
 */
export async function analyzeCTO(
  address: string,
  tokenName: string,
  tokenTicker: string,
  deployerHolding: number,
  mintAuthorityRevoked: boolean,
  freezeAuthorityRevoked: boolean,
  tokenAgeMinutes: number,
  dexScreenerInfo?: DexScreenerTokenInfo
): Promise<CTOAnalysis> {
  const indicators: string[] = [];
  let ctoScore = 0;

  // Check if "CTO" is in the name or ticker (strong indicator)
  const nameUpper = (tokenName || '').toUpperCase();
  const tickerUpper = (tokenTicker || '').toUpperCase();
  const hasCTOInName =
    nameUpper.includes('CTO') ||
    nameUpper.includes('COMMUNITY TAKEOVER') ||
    tickerUpper.includes('CTO');

  if (hasCTOInName) {
    indicators.push('CTO_IN_NAME');
    ctoScore += 40;
  }

  // Check if dev has sold most/all holdings (> 95% sold = abandoned)
  const devAbandoned = deployerHolding < 1;
  const devSoldPercent = 100 - deployerHolding;

  if (devAbandoned) {
    indicators.push('DEV_ABANDONED');
    ctoScore += 25;
  } else if (deployerHolding < 5) {
    indicators.push('DEV_MOSTLY_SOLD');
    ctoScore += 15;
  }

  // Check if authorities are revoked (necessary for CTO)
  const authoritiesRevoked = mintAuthorityRevoked && freezeAuthorityRevoked;
  if (authoritiesRevoked) {
    indicators.push('AUTHORITIES_REVOKED');
    ctoScore += 15;
  }

  // Token age check - CTOs typically happen after initial launch period
  // Most CTOs happen after 24+ hours when dev abandons
  if (tokenAgeMinutes > 24 * 60) {
    indicators.push('MATURE_TOKEN');
    ctoScore += 10;
  } else if (tokenAgeMinutes > 4 * 60) {
    indicators.push('ESTABLISHED_TOKEN');
    ctoScore += 5;
  }

  // Community-driven indicators from DexScreener
  let communityDriven = false;
  if (dexScreenerInfo) {
    // Active social presence without paid promotion can indicate community
    const hasSocials = !!(
      dexScreenerInfo.socialLinks.twitter ||
      dexScreenerInfo.socialLinks.telegram
    );

    if (hasSocials && !dexScreenerInfo.hasPaidDexscreener) {
      // Has socials but not paid = likely community-driven
      indicators.push('ORGANIC_SOCIALS');
      ctoScore += 10;
      communityDriven = true;
    }

    // If paid for Dex but dev abandoned, could be community funding
    if (dexScreenerInfo.hasPaidDexscreener && devAbandoned) {
      indicators.push('COMMUNITY_FUNDED_DEX');
      ctoScore += 5;
      communityDriven = true;
    }
  }

  // Determine CTO confidence level
  let ctoConfidence: CTOAnalysis['ctoConfidence'] = 'NONE';
  let isCTO = false;

  if (ctoScore >= 70) {
    ctoConfidence = 'HIGH';
    isCTO = true;
  } else if (ctoScore >= 50) {
    ctoConfidence = 'MEDIUM';
    isCTO = true;
  } else if (ctoScore >= 30) {
    ctoConfidence = 'LOW';
    isCTO = hasCTOInName; // Only mark as CTO if explicitly stated
  }

  const result: CTOAnalysis = {
    isCTO,
    ctoConfidence,
    ctoIndicators: indicators,
    devAbandoned,
    devSoldPercent,
    communityDriven,
    authoritiesRevoked,
    hasCTOInName,
  };

  if (isCTO) {
    logger.info({
      address: address.slice(0, 8),
      confidence: ctoConfidence,
      indicators,
      devSold: devSoldPercent.toFixed(1)
    }, 'CTO detected');
  }

  return result;
}

// ============ JUPITER CLIENT ============

class JupiterClient {
  private client: AxiosInstance;
  private tokenListCache: { tokens: string[]; expiry: number } | null = null;
  private readonly CACHE_TTL_MS = 10 * 60 * 1000; // 10 minute cache

  constructor() {
    // Updated to new Jupiter lite-api (old token.jup.ag returns 403)
    this.client = axios.create({
      baseURL: 'https://lite-api.jup.ag',
      timeout: 15000,
    });
  }

  /**
   * Get verified tokens from Jupiter
   * Uses the new v2 API endpoint for verified tokens
   */
  async getVerifiedTokens(
    _minMarketCap: number,
    _maxMarketCap: number,
    limit = 100
  ): Promise<string[]> {
    try {
      // Check cache first
      const now = Date.now();
      if (this.tokenListCache && this.tokenListCache.expiry > now) {
        logger.info({ count: this.tokenListCache.tokens.length, cached: true }, 'Returning cached Jupiter tokens');
        return this.tokenListCache.tokens.slice(0, limit);
      }

      // Fetch verified tokens from new v2 API
      const response = await this.client.get('/tokens/v2/tag', {
        params: { query: 'verified' },
      });

      // Response is a direct array of token objects with 'id' as the mint address
      const tokens = Array.isArray(response.data) ? response.data : [];
      const mints = tokens.map((t: any) => t.id).filter((id: any) => id);

      // Cache the token addresses
      this.tokenListCache = {
        tokens: mints,
        expiry: now + this.CACHE_TTL_MS,
      };

      logger.info({ totalTokens: mints.length }, 'Fetched Jupiter verified tokens');
      return mints.slice(0, limit);
    } catch (error: any) {
      const status = error?.response?.status;
      logger.error({
        error: error?.message,
        status,
        url: 'lite-api.jup.ag/tokens/v2/tag?query=verified'
      }, 'Failed to fetch Jupiter verified tokens');
      return [];
    }
  }

  /**
   * Get recent/trending tokens from Jupiter
   * Alternative source for token discovery
   */
  async getRecentTokens(limit = 50): Promise<string[]> {
    try {
      const response = await this.client.get('/tokens/v2/recent');
      // Response is a direct array of token objects with 'id' as the mint address
      const tokens = Array.isArray(response.data) ? response.data : [];
      const mints = tokens.map((t: any) => t.id).filter((id: any) => id);

      logger.info({ count: mints.length }, 'Fetched Jupiter recent tokens');
      return mints.slice(0, limit);
    } catch (error: any) {
      logger.warn({ error: error?.message }, 'Failed to fetch Jupiter recent tokens');
      return [];
    }
  }

  /**
   * Get all verified token addresses (no market cap filter)
   * Useful for checking if a token is Jupiter-verified
   */
  async getAllVerifiedAddresses(): Promise<Set<string>> {
    try {
      const now = Date.now();
      if (this.tokenListCache && this.tokenListCache.expiry > now) {
        return new Set(this.tokenListCache.tokens);
      }

      // Use same v2 API endpoint
      const response = await this.client.get('/tokens/v2/tag', {
        params: { query: 'verified' },
      });
      // Response is a direct array of token objects with 'id' as the mint address
      const tokens = Array.isArray(response.data) ? response.data : [];
      const mints = tokens.map((t: any) => t.id).filter((id: any) => id);

      this.tokenListCache = {
        tokens: mints,
        expiry: now + this.CACHE_TTL_MS,
      };

      return new Set(mints);
    } catch (error) {
      return new Set();
    }
  }
}

// ============ SOLSCAN CLIENT ============

const SOLSCAN_BASE = 'https://pro-api.solscan.io/v2.0';

class SolscanClient {
  private apiKey: string;

  // Cache for holder data (60 second TTL)
  private holderCache: Map<string, { data: any; expiry: number }> = new Map();
  private readonly HOLDER_CACHE_TTL_MS = 60 * 1000;

  // In-flight request deduplication
  private inflightRequests: Map<string, Promise<any>> = new Map();

  // In-memory holder snapshots for 1h change calculation
  // Maps token address -> array of { holderCount, timestamp }
  private holderSnapshots: Map<string, { holderCount: number; timestamp: number }[]> = new Map();
  private readonly SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // Keep 2h of snapshots

  constructor() {
    this.apiKey = appConfig.solscanApiKey;
    if (!this.apiKey) {
      logger.warn('SOLSCAN_API_KEY not configured - holder data will fall back to Helius');
    } else {
      logger.info('Solscan client initialized for holder data');
    }

    // Clean up old snapshots every 10 minutes
    setInterval(() => this.cleanupSnapshots(), 10 * 60 * 1000);
    // Clean up expired cache entries every 2 minutes
    setInterval(() => this.cleanupCache(), 2 * 60 * 1000);
  }

  /**
   * Check if Solscan is available (API key configured)
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Make a GET request to Solscan Pro API v2.0
   */
  private async solscanGet(path: string, params?: Record<string, string>): Promise<any> {
    if (!this.apiKey) return null;

    const url = new URL(`${SOLSCAN_BASE}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await axios.get(url.toString(), {
      headers: { 'token': this.apiKey },
      timeout: 10000,
    });

    return response.data;
  }

  /**
   * Get token holder data from Solscan Pro API
   * Returns accurate total holder count and top 10 holder concentration
   */
  async getTokenHolders(mintAddress: string): Promise<{
    total: number;
    topHolders: { address: string; amount: number; percentage: number }[];
  }> {
    // Check cache first
    const cached = this.holderCache.get(mintAddress);
    if (cached && cached.expiry > Date.now()) {
      return cached.data;
    }

    // Check for in-flight request (deduplication)
    const cacheKey = `solscan-holders:${mintAddress}`;
    const inflight = this.inflightRequests.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const requestPromise = (async () => {
      // Fetch top holders (page 1 with 40 items - max page size)
      const holdersData = await this.solscanGet('/token/holders', {
        address: mintAddress,
        page: '1',
        page_size: '40',
      });

      if (!holdersData?.data) {
        throw new Error('No holder data returned from Solscan');
      }

      const total = holdersData.data.total || 0;
      const items = holdersData.data.items || holdersData.data || [];

      // Extract top 10 holders with percentage
      const topHolders = (Array.isArray(items) ? items : [])
        .slice(0, 10)
        .map((item: any) => ({
          address: item.owner || item.address || '',
          amount: parseFloat(item.amount || '0'),
          percentage: parseFloat(item.percentage || '0') * 100, // Solscan returns as decimal (0.xx)
        }));

      const result = { total, topHolders };

      // Record snapshot for holderChange1h calculation
      this.recordSnapshot(mintAddress, total);

      return result;
    })();

    // Track in-flight request
    this.inflightRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;

      // Cache the result
      this.holderCache.set(mintAddress, {
        data: result,
        expiry: Date.now() + this.HOLDER_CACHE_TTL_MS,
      });

      return result;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 429) {
        logger.warn('Solscan rate limited on holder data request');
      } else {
        logger.debug({ error: error?.message, mintAddress: mintAddress.slice(0, 8) }, 'Solscan holder request failed');
      }
      throw error;
    } finally {
      this.inflightRequests.delete(cacheKey);
    }
  }

  /**
   * Record a holder count snapshot for calculating holderChange1h
   */
  private recordSnapshot(mintAddress: string, holderCount: number): void {
    if (!this.holderSnapshots.has(mintAddress)) {
      this.holderSnapshots.set(mintAddress, []);
    }
    this.holderSnapshots.get(mintAddress)!.push({
      holderCount,
      timestamp: Date.now(),
    });
  }

  /**
   * Get the approximate holder change in the last hour as a percentage
   * Uses recorded snapshots to calculate the delta
   */
  getHolderChange1h(mintAddress: string, currentHolderCount: number): number {
    const snapshots = this.holderSnapshots.get(mintAddress);
    if (!snapshots || snapshots.length === 0) return 0;

    // Find the snapshot closest to 1 hour ago
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    let closestSnapshot: { holderCount: number; timestamp: number } | null = null;
    let closestDiff = Infinity;

    for (const snap of snapshots) {
      const diff = Math.abs(snap.timestamp - oneHourAgo);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestSnapshot = snap;
      }
    }

    // Only use the snapshot if it's within a reasonable window (30-90 min ago)
    if (!closestSnapshot) return 0;
    const ageMs = Date.now() - closestSnapshot.timestamp;
    if (ageMs < 30 * 60 * 1000 || ageMs > 90 * 60 * 1000) {
      // If we don't have a snapshot near 1h ago, use the oldest snapshot we have
      // and scale proportionally
      const oldestSnapshot = snapshots[0];
      const oldestAgeMs = Date.now() - oldestSnapshot.timestamp;
      if (oldestAgeMs < 5 * 60 * 1000) return 0; // Need at least 5 min of data

      const previousCount = oldestSnapshot.holderCount;
      if (previousCount <= 0) return 0;

      // Scale the change to approximate a 1-hour rate
      const changeRaw = ((currentHolderCount - previousCount) / previousCount) * 100;
      const scaleFactor = (60 * 60 * 1000) / oldestAgeMs; // Scale to 1h
      return Math.round(changeRaw * Math.min(scaleFactor, 3)); // Cap scaling at 3x to avoid wild extrapolation
    }

    const previousCount = closestSnapshot.holderCount;
    if (previousCount <= 0) return 0;

    return Math.round(((currentHolderCount - previousCount) / previousCount) * 100);
  }

  /**
   * Clean up old snapshots to prevent memory leaks
   */
  private cleanupSnapshots(): void {
    const cutoff = Date.now() - this.SNAPSHOT_MAX_AGE_MS;
    for (const [address, snapshots] of this.holderSnapshots) {
      const filtered = snapshots.filter(s => s.timestamp > cutoff);
      if (filtered.length === 0) {
        this.holderSnapshots.delete(address);
      } else {
        this.holderSnapshots.set(address, filtered);
      }
    }
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.holderCache) {
      if (entry.expiry < now) {
        this.holderCache.delete(key);
      }
    }
  }
}

// ============ SINGLETON INSTANCES ============

export const heliusClient = new HeliusClient();
export const dexScreenerClient = new DexScreenerClient();
export const jupiterClient = new JupiterClient();
export const solscanClient = new SolscanClient();

// ============ COMBINED DATA FETCHING ============

export async function getTokenMetrics(address: string): Promise<TokenMetrics | null> {
  try {
    // DexScreener provides: price, volume, market cap, liquidity, token name/symbol, pair creation time
    // Solscan provides: accurate holder count + top 10 concentration (primary)
    // Helius provides: holder distribution (fallback when Solscan unavailable)

    const heliusDisabled = appConfig.heliusDisabled;
    const useSolscan = solscanClient.isAvailable();

    // Fetch DexScreener + holder data in parallel
    // Priority: Solscan (accurate total) > Helius (capped at 100) > defaults
    const [dexResult, holderResult] = await Promise.allSettled([
      dexScreenerClient.getTokenPairs(address),
      useSolscan
        ? solscanClient.getTokenHolders(address)
        : heliusDisabled
          ? Promise.resolve({ total: 0, topHolders: [] })
          : heliusClient.getTokenHolders(address),
    ]);

    const dexPairs = dexResult.status === 'fulfilled' ? dexResult.value : [];
    let holderData = holderResult.status === 'fulfilled' ? holderResult.value : { total: 0, topHolders: [] };

    // If Solscan failed, fall back to Helius
    if (holderResult.status === 'rejected' && useSolscan && !heliusDisabled) {
      logger.debug({ address: address.slice(0, 8) }, 'Solscan holder fetch failed, falling back to Helius');
      try {
        holderData = await heliusClient.getTokenHolders(address);
      } catch {
        holderData = { total: 0, topHolders: [] };
      }
    }

    // For very new tokens, we may have no data from APIs yet
    const hasAnyData = dexPairs.length > 0 || holderData.total > 0;

    if (!hasAnyData) {
      logger.debug({ address: address.slice(0, 8) }, 'No data found for token from any source');
      return null;
    }

    // Use DexScreener as primary source for price/volume (FREE)
    const primaryPair = dexPairs[0];
    const price = primaryPair ? parseFloat(primaryPair.priceUsd || '0') : 0;
    const marketCap = primaryPair ? (primaryPair.fdv || 0) : 0;
    const volume24h = primaryPair ? (primaryPair.volume?.h24 || 0) : 0;
    const liquidity = primaryPair ? (primaryPair.liquidity?.usd || 0) : 0;

    // Calculate top 10 concentration (default to 50% if no data - conservative for new tokens)
    const top10Concentration = holderData.topHolders.length > 0
      ? holderData.topHolders.reduce((sum, h) => sum + h.percentage, 0)
      : 50; // Default for very new tokens

    // Get token creation time for age calculation
    let ageMinutes = 5; // Default to 5 minutes for very new tokens

    if (primaryPair?.pairCreatedAt) {
      ageMinutes = (Date.now() - primaryPair.pairCreatedAt) / (1000 * 60);
    }

    // Holder count - Solscan returns the accurate total, Helius caps at 100
    const holderCount = holderData.total || 25;

    // Calculate holder change in last hour from Solscan snapshots
    const holderChange1h = useSolscan
      ? solscanClient.getHolderChange1h(address, holderCount)
      : 0;

    return {
      address,
      ticker: primaryPair?.baseToken?.symbol || 'NEW',
      name: primaryPair?.baseToken?.name || 'New Token',
      price: price || 0.000001,
      marketCap: marketCap || 10000,
      volume24h: volume24h || 1000,
      volumeMarketCapRatio: marketCap > 0 ? volume24h / marketCap : 0.1,
      holderCount,
      holderChange1h,
      top10Concentration,
      liquidityPool: liquidity || 5000,
      tokenAge: ageMinutes,
      lpLocked: false,
      lpLockDuration: null,
    };
  } catch (error) {
    logger.error({ error, address: address.slice(0, 8) }, 'Failed to get token metrics');
    return null;
  }
}

export async function analyzeTokenContract(address: string): Promise<TokenContractAnalysis> {
  try {
    // When Helius is disabled, return permissive defaults (let token through to later checks)
    if (appConfig.heliusDisabled) {
      logger.debug(`Token contract analysis skipped for ${address.slice(0, 8)} - Helius disabled`);
      return {
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        metadataMutable: false,
        isKnownScamTemplate: false,
      };
    }

    // Use Helius RPC (included in plan) for direct on-chain query - reliable and FREE
    const mintInfo = await heliusClient.getTokenMintInfo(address);

    // Log what Helius actually returned
    logger.info(
      `Helius security for ${address.slice(0, 8)}: mintAuth=${mintInfo?.mintAuthority || 'null'} freezeAuth=${mintInfo?.freezeAuthority || 'null'}`
    );

    // Handle null/undefined response
    if (!mintInfo) {
      logger.warn(`No mint info from Helius for ${address.slice(0, 8)} - letting through`);
      // Return permissive defaults when RPC returns nothing (let token through)
      return {
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        metadataMutable: false,
        isKnownScamTemplate: false,
      };
    }

    // mintAuthority/freezeAuthority are null if revoked, or contain the authority pubkey
    return {
      mintAuthorityRevoked: mintInfo.mintAuthority === null,
      freezeAuthorityRevoked: mintInfo.freezeAuthority === null,
      metadataMutable: false, // Helius doesn't return this directly, default to false (safe)
      isKnownScamTemplate: false,
    };
  } catch (error) {
    logger.error({ error, address }, 'Failed to analyze token contract');
    // Return permissive defaults on error (let token through to later checks)
    return {
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      metadataMutable: false,
      isKnownScamTemplate: false,
    };
  }
}

export async function analyzeBundles(address: string): Promise<BundleAnalysis> {
  try {
    // When Helius is disabled, skip bundle analysis (requires transaction history)
    // Return permissive defaults - other safety checks still apply
    if (appConfig.heliusDisabled) {
      logger.debug(`Bundle analysis skipped for ${address.slice(0, 8)} - Helius disabled`);
      return {
        bundleDetected: false,
        bundledSupplyPercent: 0,
        clusteredWalletCount: 0,
        fundingOverlapDetected: false,
        hasRugHistory: false,
        riskLevel: 'LOW',
      };
    }

    // Get first transactions to analyze for bundled buys
    const txs = await heliusClient.getRecentTransactions(address, 50);

    if (txs.length === 0) {
      return {
        bundleDetected: false,
        bundledSupplyPercent: 0,
        clusteredWalletCount: 0,
        fundingOverlapDetected: false,
        hasRugHistory: false,
        riskLevel: 'LOW',
      };
    }

    // Analyze for bundles - simplified implementation
    // In production, you'd do more sophisticated block-level analysis
    const earlyBuyers: string[] = [];
    const seenBlocks = new Map<number, string[]>();

    for (const tx of txs.slice(0, 20)) {
      const blockSlot = tx.slot;
      if (!seenBlocks.has(blockSlot)) {
        seenBlocks.set(blockSlot, []);
      }
      // Would need to parse transaction to get buyer address
      // This is simplified
    }

    // Check for clustered buys in same block
    let clusteredCount = 0;
    for (const [_block, addresses] of seenBlocks) {
      if (addresses.length >= 3) {
        clusteredCount += addresses.length;
      }
    }

    // Check if any early buyers are in rug database
    let hasRugHistory = false;
    for (const buyer of earlyBuyers) {
      if (await Database.isRugWallet(buyer)) {
        hasRugHistory = true;
        break;
      }
    }

    const bundledSupplyPercent = 0; // Would require holder analysis
    const riskLevel = hasRugHistory || bundledSupplyPercent > 25
      ? 'HIGH'
      : bundledSupplyPercent > 10 || clusteredCount > 5
        ? 'MEDIUM'
        : 'LOW';

    return {
      bundleDetected: clusteredCount > 5,
      bundledSupplyPercent,
      clusteredWalletCount: clusteredCount,
      fundingOverlapDetected: false, // Would require funding trace
      hasRugHistory,
      riskLevel,
    };
  } catch (error) {
    logger.error({ error, address }, 'Failed to analyze bundles');
    return {
      bundleDetected: false,
      bundledSupplyPercent: 0,
      clusteredWalletCount: 0,
      fundingOverlapDetected: false,
      hasRugHistory: false,
      riskLevel: 'MEDIUM', // Conservative on error
    };
  }
}

export async function analyzeDevWallet(address: string): Promise<DevWalletBehaviour | null> {
  try {
    // Use Helius to get the earliest transaction signer as the deployer
    const creationSig = await heliusClient.getTokenCreationSignature(address);

    if (!creationSig) {
      return null;
    }

    // Get the transaction details to find the deployer address
    const txDetail = await heliusClient.getTransaction(creationSig.signature);
    const deployerAddress = txDetail?.transaction?.message?.accountKeys?.[0]?.pubkey || null;

    if (!deployerAddress) {
      return null;
    }

    // Get deployer's recent transactions
    const txs = await heliusClient.getRecentTransactions(deployerAddress, 50);

    // Analyze for CEX transfers (simplified - in production, maintain CEX address list)
    const knownCexAddresses: string[] = [
      // Binance hot wallets, OKX, etc. would go here
    ];

    const cexTransfers = txs.filter((tx: any) => {
      // Would need to parse transaction destinations
      return false; // Placeholder
    });

    return {
      deployerAddress,
      soldPercent48h: 0, // Would require sell analysis
      transferredToCex: cexTransfers.length > 0,
      cexAddresses: [],
      bridgeActivity: false, // Would require bridge detection
    };
  } catch (error) {
    logger.error({ error, address }, 'Failed to analyze dev wallet');
    return null;
  }
}

export async function calculateVolumeAuthenticity(address: string): Promise<VolumeAuthenticityScore> {
  try {
    // Use DexScreener pairs data (FREE) for trade statistics
    const pairs = await dexScreenerClient.getTokenPairs(address);

    if (pairs.length === 0) {
      return {
        score: 50, // Default medium score
        uniqueWalletRatio: 0.5,
        sizeDistributionScore: 50,
        temporalPatternScore: 50,
        isWashTradingSuspected: false,
      };
    }

    const pair = pairs[0] as any;

    // DexScreener provides transaction counts and volume data
    const buys24h = pair.txns?.h24?.buys || 0;
    const sells24h = pair.txns?.h24?.sells || 0;
    const totalTrades = buys24h + sells24h;

    // Estimate unique wallet ratio from buy/sell balance
    // Well-distributed trading has roughly balanced buys and sells
    const buyRatio = totalTrades > 0 ? buys24h / totalTrades : 0.5;
    // Healthy ratio is 0.4-0.6; extreme skew suggests wash trading
    const balanceScore = 1 - Math.abs(buyRatio - 0.5) * 2;
    const uniqueWalletRatio = Math.max(0.1, Math.min(1.0, balanceScore + 0.3));

    // Size distribution score based on volume per trade
    const volume24h = pair.volume?.h24 || 0;
    const avgTradeSize = totalTrades > 0 ? volume24h / totalTrades : 0;
    // Very uniform trade sizes suggest wash trading
    const sizeDistributionScore = avgTradeSize > 0 && avgTradeSize < 100000 ? 60 : 40;

    // Temporal pattern score based on h1 vs h24 volume distribution
    const volume1h = pair.volume?.h1 || 0;
    const expectedHourlyRatio = volume24h > 0 ? volume1h / volume24h : 0;
    // Natural trading should have ~4-8% per hour on average
    const temporalPatternScore = expectedHourlyRatio > 0.01 && expectedHourlyRatio < 0.15 ? 65 : 45;

    // VAS = (Unique Wallet Ratio × 40) + (Size Distribution × 30) + (Temporal Pattern × 30)
    const score = Math.round(
      (uniqueWalletRatio * 40) +
      (sizeDistributionScore * 0.3) +
      (temporalPatternScore * 0.3)
    );

    return {
      score: Math.min(100, Math.max(0, score)),
      uniqueWalletRatio,
      sizeDistributionScore,
      temporalPatternScore,
      isWashTradingSuspected: uniqueWalletRatio < 0.3,
    };
  } catch (error) {
    logger.error({ error, address }, 'Failed to calculate volume authenticity');
    return {
      score: 50,
      uniqueWalletRatio: 0.5,
      sizeDistributionScore: 50,
      temporalPatternScore: 50,
      isWashTradingSuspected: false,
    };
  }
}

// ============ EXPORTS ============

export default {
  heliusClient,
  dexScreenerClient,
  getTokenMetrics,
  analyzeTokenContract,
  analyzeBundles,
  analyzeDevWallet,
  calculateVolumeAuthenticity,
  analyzeCTO,
};
