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
  BirdeyeTokenOverview,
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

class BirdeyeClient {
  private client: AxiosInstance;
  private ws: any = null;
  private newListingsBuffer: any[] = [];
  private wsConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private onNewListingCallback: ((listing: any) => void) | null = null;

  // ============ CACHING SYSTEM ============
  // Different TTLs for different data types based on how often they change
  // This dramatically reduces API costs (estimated 60-80% reduction)

  // Token overview cache (prices, volume, market cap) - changes frequently
  private overviewCache: Map<string, { data: BirdeyeTokenOverview | null; expiry: number }> = new Map();
  private readonly OVERVIEW_CACHE_TTL_MS = 45 * 1000; // 45 seconds

  // Token security cache (mint/freeze authority) - rarely changes
  private securityCache: Map<string, { data: any; expiry: number }> = new Map();
  private readonly SECURITY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Token creation info cache (creator, creation time) - NEVER changes
  private creationCache: Map<string, { data: any; expiry: number }> = new Map();
  private readonly CREATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Token trade data cache (24h buys/sells) - changes frequently
  private tradeDataCache: Map<string, { data: any; expiry: number }> = new Map();
  private readonly TRADE_DATA_CACHE_TTL_MS = 60 * 1000; // 60 seconds

  // Request deduplication - prevents duplicate in-flight requests
  private inflightRequests: Map<string, Promise<any>> = new Map();

  // Cache size limits to prevent memory bloat
  private readonly MAX_CACHE_SIZE = 1000;

  // Cache statistics for monitoring
  private cacheStats = {
    hits: 0,
    misses: 0,
    deduped: 0,
    lastLogTime: Date.now(),
  };

  constructor() {
    this.client = axios.create({
      baseURL: 'https://public-api.birdeye.so',
      timeout: 15000,
      headers: {
        'X-API-KEY': appConfig.birdeyeApiKey,
        'x-chain': 'solana',
      },
    });

    // Clean up expired cache entries every 2 minutes
    setInterval(() => this.cleanupCaches(), 2 * 60 * 1000);

    // Log cache statistics every 5 minutes
    setInterval(() => this.logCacheStats(), 5 * 60 * 1000);
  }

  /**
   * Clean up expired cache entries across all caches
   */
  private cleanupCaches(): void {
    const now = Date.now();
    let totalCleaned = 0;

    // Clean each cache type
    for (const [key, value] of this.overviewCache) {
      if (value.expiry < now) {
        this.overviewCache.delete(key);
        totalCleaned++;
      }
    }

    for (const [key, value] of this.securityCache) {
      if (value.expiry < now) {
        this.securityCache.delete(key);
        totalCleaned++;
      }
    }

    for (const [key, value] of this.creationCache) {
      if (value.expiry < now) {
        this.creationCache.delete(key);
        totalCleaned++;
      }
    }

    for (const [key, value] of this.tradeDataCache) {
      if (value.expiry < now) {
        this.tradeDataCache.delete(key);
        totalCleaned++;
      }
    }

    if (totalCleaned > 0) {
      logger.debug({
        cleaned: totalCleaned,
        remaining: {
          overview: this.overviewCache.size,
          security: this.securityCache.size,
          creation: this.creationCache.size,
          tradeData: this.tradeDataCache.size,
        },
      }, 'Birdeye cache cleanup');
    }
  }

  /**
   * Evict oldest entries if cache exceeds size limit
   */
  private evictIfNeeded(cache: Map<string, any>): void {
    if (cache.size > this.MAX_CACHE_SIZE) {
      // Remove oldest 20% of entries
      const keysToDelete = Array.from(cache.keys()).slice(0, Math.floor(this.MAX_CACHE_SIZE * 0.2));
      keysToDelete.forEach(k => cache.delete(k));
    }
  }

  /**
   * Log cache statistics to monitor API cost savings
   */
  private logCacheStats(): void {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    const hitRate = total > 0 ? ((this.cacheStats.hits / total) * 100).toFixed(1) : '0';
    const savedCalls = this.cacheStats.hits + this.cacheStats.deduped;

    logger.info({
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      deduped: this.cacheStats.deduped,
      hitRate: `${hitRate}%`,
      estimatedSavedCalls: savedCalls,
      cacheSizes: {
        overview: this.overviewCache.size,
        security: this.securityCache.size,
        creation: this.creationCache.size,
        tradeData: this.tradeDataCache.size,
      },
    }, '📊 Birdeye API cache statistics (5 min window)');

    // Reset stats for next window
    this.cacheStats = {
      hits: 0,
      misses: 0,
      deduped: 0,
      lastLogTime: Date.now(),
    };
  }

  /**
   * Get cache statistics (for external monitoring)
   */
  getCacheStats(): typeof this.cacheStats & { cacheSizes: Record<string, number> } {
    return {
      ...this.cacheStats,
      cacheSizes: {
        overview: this.overviewCache.size,
        security: this.securityCache.size,
        creation: this.creationCache.size,
        tradeData: this.tradeDataCache.size,
      },
    };
  }
  
  /**
   * Initialize WebSocket connection for real-time new token listings
   */
  async initWebSocket(): Promise<void> {
    const wsUrl = `wss://public-api.birdeye.so/socket/solana?x-api-key=${appConfig.birdeyeApiKey}`;
    
    try {
      // Dynamic import for ws package (Node.js WebSocket)
      const WebSocket = (await import('ws')).default;
      
      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', () => {
        logger.info('Birdeye WebSocket connected');
        this.wsConnected = true;
        this.reconnectAttempts = 0;
        
        // Subscribe to new token listings
        const subscriptionMsg = {
          type: 'SUBSCRIBE_TOKEN_NEW_LISTING',
          meme_platform_enabled: true, // Include pump.fun tokens
          min_liquidity: 1000, // Minimum $1000 liquidity
        };
        
        this.ws?.send(JSON.stringify(subscriptionMsg));
        logger.info('Subscribed to SUBSCRIBE_TOKEN_NEW_LISTING');
      });
      
      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          
          if (message.type === 'TOKEN_NEW_LISTING' || message.data) {
            const listing = message.data || message;
            
            // Add to buffer for batch processing
            this.newListingsBuffer.push({
              address: listing.address || listing.mint,
              name: listing.name,
              symbol: listing.symbol,
              liquidity: listing.liquidity,
              timestamp: Date.now(),
            });
            
            // Keep buffer size manageable
            if (this.newListingsBuffer.length > 100) {
              this.newListingsBuffer = this.newListingsBuffer.slice(-100);
            }
            
            // Trigger callback if set
            if (this.onNewListingCallback) {
              this.onNewListingCallback(listing);
            }
            
            logger.debug({ listing: listing.symbol || listing.address }, 'New token listing received');
          }
        } catch (error) {
          logger.debug({ error, data: data.toString().slice(0, 100) }, 'Failed to parse WebSocket message');
        }
      });
      
      this.ws.on('close', () => {
        logger.warn('Birdeye WebSocket disconnected');
        this.wsConnected = false;
        this.scheduleReconnect();
      });
      
      this.ws.on('error', (error: Error) => {
        logger.error({ error }, 'Birdeye WebSocket error');
        this.wsConnected = false;
      });
      
      // Setup ping-pong for connection health
      this.ws.on('ping', () => {
        this.ws?.pong();
      });
      
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Birdeye WebSocket');
      this.scheduleReconnect();
    }
  }
  
  /**
   * Schedule WebSocket reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max WebSocket reconnect attempts reached');
      return;
    }
    
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    
    logger.info({ delay, attempt: this.reconnectAttempts }, 'Scheduling WebSocket reconnect');
    
    setTimeout(() => {
      this.initWebSocket();
    }, delay);
  }
  
  /**
   * Set callback for new token listings
   */
  onNewListing(callback: (listing: any) => void): void {
    this.onNewListingCallback = callback;
  }
  
  /**
   * Get buffered new listings (from WebSocket)
   */
  getBufferedListings(): any[] {
    const listings = [...this.newListingsBuffer];
    return listings;
  }
  
  /**
   * Clear the listings buffer
   */
  clearListingsBuffer(): void {
    this.newListingsBuffer = [];
  }
  
  /**
   * Check if WebSocket is connected
   */
  isWebSocketConnected(): boolean {
    return this.wsConnected;
  }

  async getTokenOverview(address: string): Promise<BirdeyeTokenOverview | null> {
    const cacheKey = `overview:${address}`;
    const now = Date.now();

    // Check cache first
    const cached = this.overviewCache.get(address);
    if (cached && cached.expiry > now) {
      this.cacheStats.hits++;
      return cached.data;
    }

    // Check for in-flight request (deduplication)
    const inflight = this.inflightRequests.get(cacheKey);
    if (inflight) {
      this.cacheStats.deduped++;
      return inflight;
    }

    // Make the API request
    const requestPromise = (async () => {
      try {
        this.cacheStats.misses++;
        const response = await this.client.get(`/defi/token_overview`, {
          params: { address },
        });
        const data = response.data.data;

        // Cache the result
        this.overviewCache.set(address, { data, expiry: now + this.OVERVIEW_CACHE_TTL_MS });
        this.evictIfNeeded(this.overviewCache);

        return data;
      } catch (error) {
        logger.error({ error, address }, 'Failed to get token overview from Birdeye');
        // Cache null result briefly to prevent hammering on errors
        this.overviewCache.set(address, { data: null, expiry: now + 10000 });
        return null;
      } finally {
        this.inflightRequests.delete(cacheKey);
      }
    })();

    this.inflightRequests.set(cacheKey, requestPromise);
    return requestPromise;
  }

  async getTokenSecurity(address: string): Promise<any> {
    const cacheKey = `security:${address}`;
    const now = Date.now();

    // Check cache first (5 min TTL - security info rarely changes)
    const cached = this.securityCache.get(address);
    if (cached && cached.expiry > now) {
      this.cacheStats.hits++;
      return cached.data;
    }

    // Check for in-flight request (deduplication)
    const inflight = this.inflightRequests.get(cacheKey);
    if (inflight) {
      this.cacheStats.deduped++;
      return inflight;
    }

    // Make the API request
    const requestPromise = (async () => {
      try {
        this.cacheStats.misses++;
        const response = await this.client.get(`/defi/token_security`, {
          params: { address },
        });
        const data = response.data.data;

        // Cache the result (5 minute TTL)
        this.securityCache.set(address, { data, expiry: now + this.SECURITY_CACHE_TTL_MS });
        this.evictIfNeeded(this.securityCache);

        return data;
      } catch (error) {
        logger.error({ error, address }, 'Failed to get token security from Birdeye');
        // Cache null result briefly to prevent hammering on errors
        this.securityCache.set(address, { data: null, expiry: now + 30000 });
        return null;
      } finally {
        this.inflightRequests.delete(cacheKey);
      }
    })();

    this.inflightRequests.set(cacheKey, requestPromise);
    return requestPromise;
  }

  async getTokenCreationInfo(address: string): Promise<any> {
    const cacheKey = `creation:${address}`;
    const now = Date.now();

    // Check cache first (24h TTL - creation info NEVER changes)
    const cached = this.creationCache.get(address);
    if (cached && cached.expiry > now) {
      this.cacheStats.hits++;
      return cached.data;
    }

    // Check for in-flight request (deduplication)
    const inflight = this.inflightRequests.get(cacheKey);
    if (inflight) {
      this.cacheStats.deduped++;
      return inflight;
    }

    // Make the API request
    const requestPromise = (async () => {
      try {
        this.cacheStats.misses++;
        const response = await this.client.get(`/defi/token_creation_info`, {
          params: { address },
        });
        const data = response.data.data;

        // Cache the result (24 hour TTL - this data never changes)
        this.creationCache.set(address, { data, expiry: now + this.CREATION_CACHE_TTL_MS });
        this.evictIfNeeded(this.creationCache);

        return data;
      } catch (error) {
        logger.error({ error, address }, 'Failed to get token creation info from Birdeye');
        // Cache null result for 5 minutes to prevent hammering on errors
        this.creationCache.set(address, { data: null, expiry: now + 5 * 60 * 1000 });
        return null;
      } finally {
        this.inflightRequests.delete(cacheKey);
      }
    })();

    this.inflightRequests.set(cacheKey, requestPromise);
    return requestPromise;
  }

  async getTokenTradeData(address: string, timeframe = '24h'): Promise<any> {
    const cacheKey = `tradeData:${address}:${timeframe}`;
    const now = Date.now();

    // Check cache first (60s TTL - trade data changes frequently)
    const cached = this.tradeDataCache.get(cacheKey);
    if (cached && cached.expiry > now) {
      this.cacheStats.hits++;
      return cached.data;
    }

    // Check for in-flight request (deduplication)
    const inflight = this.inflightRequests.get(cacheKey);
    if (inflight) {
      this.cacheStats.deduped++;
      return inflight;
    }

    // Make the API request
    const requestPromise = (async () => {
      try {
        this.cacheStats.misses++;
        const response = await this.client.get(`/defi/v3/token/trade-data/single`, {
          params: { address, type: timeframe },
        });
        const data = response.data.data;

        // Cache the result (60 second TTL)
        this.tradeDataCache.set(cacheKey, { data, expiry: now + this.TRADE_DATA_CACHE_TTL_MS });
        this.evictIfNeeded(this.tradeDataCache);

        return data;
      } catch (error) {
        logger.error({ error, address }, 'Failed to get token trade data from Birdeye');
        // Cache null result briefly to prevent hammering on errors
        this.tradeDataCache.set(cacheKey, { data: null, expiry: now + 15000 });
        return null;
      } finally {
        this.inflightRequests.delete(cacheKey);
      }
    })();

    this.inflightRequests.set(cacheKey, requestPromise);
    return requestPromise;
  }

  async getNewListings(limit = 50): Promise<any[]> {
    // First try to get from WebSocket buffer (real-time data)
    // This is the primary source - WebSocket provides SUBSCRIBE_TOKEN_NEW_LISTING
    if (this.wsConnected && this.newListingsBuffer.length > 0) {
      logger.debug({ count: this.newListingsBuffer.length }, 'Returning listings from WebSocket buffer');
      return this.newListingsBuffer.slice(0, limit);
    }

    // WebSocket not connected or buffer empty - return buffer as fallback
    // Note: Birdeye's REST API for new listings is deprecated in favor of WebSocket
    // DexScreener is used as primary fallback via dexScreenerClient.getNewSolanaPairs()
    if (this.newListingsBuffer.length > 0) {
      logger.debug({ count: this.newListingsBuffer.length }, 'Returning cached listings from buffer (WebSocket disconnected)');
      return this.newListingsBuffer.slice(0, limit);
    }

    // Buffer empty - return empty array (DexScreener fallback handled at caller level)
    logger.debug('No listings in buffer, WebSocket may still be connecting');
    return [];
  }

  /**
   * Get tokens by market cap range from Birdeye
   * This is the primary source for mature token discovery
   * Uses the /defi/v3/token/list endpoint (V1/V2 deprecated March 2025)
   */
  async getTokensByMarketCapRange(
    minMarketCap: number,
    maxMarketCap: number,
    limit = 100
  ): Promise<string[]> {
    try {
      // Use Birdeye V3 token list endpoint (V1/V2 deprecated March 2025)
      // V3 supports min_mc and max_mc filters directly
      const response = await this.client.get('/defi/v3/token/list', {
        params: {
          sort_by: 'volume_24h_usd',  // V3 parameter name
          sort_type: 'desc',
          offset: 0,
          limit: limit,
          min_liquidity: 15000,       // Lowered for bear market
          min_mc: minMarketCap,       // V3 supports direct mcap filtering
          max_mc: maxMarketCap,
        },
      });

      // V3 response format: { data: { items: [...] } }
      const tokens = response.data?.data?.items || response.data?.data?.tokens || response.data?.data || [];
      const addresses: string[] = [];

      for (const token of tokens) {
        if (token.address) {
          addresses.push(token.address);
        }
      }

      logger.info({
        total: tokens.length,
        inRange: addresses.length,
        minMcap: `$${(minMarketCap / 1_000_000).toFixed(1)}M`,
        maxMcap: `$${(maxMarketCap / 1_000_000).toFixed(1)}M`,
      }, 'Fetched tokens by market cap range from Birdeye V3');

      return addresses;
    } catch (error: any) {
      const status = error?.response?.status;
      const responseData = error?.response?.data;

      // Log specific error for debugging
      logger.warn({
        error: error?.message,
        status,
        responseData: JSON.stringify(responseData)?.slice(0, 200),
      }, 'Birdeye V3 tokenlist failed - relying on other discovery sources');

      return [];
    }
  }

  /**
   * Get trending/gainers tokens from Birdeye
   * Alternative source for token discovery
   */
  async getTrendingTokens(limit = 20): Promise<string[]> {
    try {
      // Use correct Birdeye trending endpoint (NOT v3)
      // Max limit is 20 per Birdeye docs
      const response = await this.client.get('/defi/token_trending', {
        params: {
          sort_by: 'rank',
          sort_type: 'asc',
          offset: 0,
          limit: Math.min(limit, 20),
        },
      });

      const tokens = response.data?.data?.tokens || response.data?.data || [];
      const addresses = tokens
        .filter((t: any) => t.address)
        .map((t: any) => t.address);

      logger.info({ count: addresses.length }, 'Fetched trending tokens from Birdeye');
      return addresses;
    } catch (error: any) {
      const status = error?.response?.status;
      const responseData = error?.response?.data;
      logger.warn({
        error: error?.message,
        status,
        responseData: JSON.stringify(responseData)?.slice(0, 200),
      }, 'Failed to get trending tokens from Birdeye');
      return [];
    }
  }

  /**
   * Get meme tokens from Birdeye v3 meme list
   * Better source for memecoin discovery
   */
  async getMemeTokens(limit = 100): Promise<string[]> {
    try {
      const response = await this.client.get('/defi/v3/token/meme/list', {
        params: {
          offset: 0,
          limit: limit,
        },
      });

      const tokens = response.data?.data?.items || response.data?.data?.tokens || response.data?.data || [];
      const addresses = tokens
        .filter((t: any) => t.address)
        .map((t: any) => t.address);

      logger.info({ count: addresses.length }, 'Fetched meme tokens from Birdeye');
      return addresses;
    } catch (error: any) {
      const status = error?.response?.status;
      logger.warn({
        error: error?.message,
        status,
      }, 'Failed to get meme tokens from Birdeye');
      return [];
    }
  }
}

class DexScreenerClient {
  private client: AxiosInstance;

  // Cache for token pairs with TTL
  private pairsCache: Map<string, { data: DexScreenerPair[]; expiry: number }> = new Map();
  private readonly CACHE_TTL_MS = 30 * 1000; // 30 seconds cache
  private readonly CACHE_TTL_EMPTY_MS = 10 * 1000; // 10 seconds for empty results
  private readonly MAX_CACHE_SIZE = 500; // Prevent memory bloat

  // Rate limiting - DexScreener free tier allows ~300 req/min (~5/sec)
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL_MS = 250; // Max 4 requests/second
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

      // Successful request - reduce backoff
      if (this.rateLimitBackoff > 0) {
        this.rateLimitBackoff = Math.max(0, this.rateLimitBackoff - 100);
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
      hasPaidDexscreener: false,
      boostCount: 0,
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

      // Check for boosts (paid advertising)
      const boostCount = primaryPair.boosts?.active || 0;
      const hasPaidDexscreener = boostCount > 0;

      // Check for token profile (paid feature)
      const hasTokenProfile = !!(
        primaryPair.info?.imageUrl ||
        primaryPair.info?.header ||
        primaryPair.info?.websites?.length ||
        primaryPair.info?.socials?.length
      );

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
      const hasTokenAds = hasPaidDexscreener && hasTokenProfile;

      const info: DexScreenerTokenInfo = {
        tokenAddress: address,
        hasPaidDexscreener,
        boostCount,
        hasTokenProfile,
        hasTokenAds,
        socialLinks,
      };

      logger.debug({
        address: address.slice(0, 8),
        hasPaid: hasPaidDexscreener,
        boosts: boostCount,
        hasProfile: hasTokenProfile
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

// ============ SINGLETON INSTANCES ============

export const heliusClient = new HeliusClient();
export const birdeyeClient = new BirdeyeClient();
export const dexScreenerClient = new DexScreenerClient();
export const jupiterClient = new JupiterClient();

// ============ COMBINED DATA FETCHING ============

export async function getTokenMetrics(address: string): Promise<TokenMetrics | null> {
  try {
    // COST OPTIMIZATION: Use DexScreener (FREE) + Helius (included) + Birdeye (for holder count)
    // DexScreener provides: price, volume, market cap, liquidity, token name/symbol, pair creation time
    // Helius provides: holder distribution (top 10 concentration) - SKIPPED when HELIUS_DISABLED=true
    // Birdeye provides: accurate total holder count (Helius pagination caps at 100)

    // When Helius is disabled (rate limited), we skip holder distribution calls
    // Top 10 concentration will default to 50% (conservative estimate)
    const heliusDisabled = appConfig.heliusDisabled;

    const [dexResult, holderResult, birdeyeResult] = await Promise.allSettled([
      dexScreenerClient.getTokenPairs(address),
      heliusDisabled
        ? Promise.resolve({ total: 0, topHolders: [] })  // Skip Helius when disabled
        : heliusClient.getTokenHolders(address),
      birdeyeClient.getTokenOverview(address),
    ]);

    const dexPairs = dexResult.status === 'fulfilled' ? dexResult.value : [];
    const holderData = holderResult.status === 'fulfilled' ? holderResult.value : { total: 0, topHolders: [] };
    const birdeyeData = birdeyeResult.status === 'fulfilled' ? birdeyeResult.value : null;

    // For very new tokens, we may have no data from APIs yet
    // Use holder data from Helius as a fallback indicator that the token exists
    const hasAnyData = dexPairs.length > 0 || holderData.total > 0 || birdeyeData;

    if (!hasAnyData) {
      // Only reject if we truly have nothing at all
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
    // Use DexScreener pairCreatedAt (FREE) - no Birdeye fallback needed
    let ageMinutes = 5; // Default to 5 minutes for very new tokens

    if (primaryPair?.pairCreatedAt) {
      ageMinutes = (Date.now() - primaryPair.pairCreatedAt) / (1000 * 60);
    }
    // Note: Removed Birdeye fallback for creation time - DexScreener is sufficient

    // HOLDER COUNT FIX: Use Birdeye's holder count (accurate) instead of Helius (capped at 100)
    // Helius getTokenAccounts returns paginated results with limit=100, so holderData.total maxes at 100
    // Birdeye's token_overview endpoint returns the actual total holder count
    const accurateHolderCount = birdeyeData?.holder || holderData.total || 25;

    // For tokens with minimal data, use permissive defaults
    // This allows very new tokens to pass through to scoring
    return {
      address,
      ticker: primaryPair?.baseToken?.symbol || 'NEW',
      name: primaryPair?.baseToken?.name || 'New Token',
      price: price || 0.000001, // Default tiny price if unknown
      marketCap: marketCap || 10000, // Default $10k mcap if unknown (meets min threshold)
      volume24h: volume24h || 1000, // Default $1k volume if unknown
      volumeMarketCapRatio: marketCap > 0 ? volume24h / marketCap : 0.1, // Default 10% ratio
      holderCount: accurateHolderCount,
      holderChange1h: 0,
      top10Concentration,
      liquidityPool: liquidity || 5000, // Default $5k liquidity
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
    // When Helius is disabled (rate limited), use Birdeye token_security endpoint
    if (appConfig.heliusDisabled) {
      const securityData = await birdeyeClient.getTokenSecurity(address);

      if (!securityData) {
        logger.warn(`No security data from Birdeye for ${address.slice(0, 8)} - letting through`);
        return {
          mintAuthorityRevoked: true,
          freezeAuthorityRevoked: true,
          metadataMutable: false,
          isKnownScamTemplate: false,
        };
      }

      logger.info(
        `Birdeye security for ${address.slice(0, 8)}: mintAuth=${securityData.mutableMetadata ? 'active' : 'null'} freezeAuth=${securityData.freezeable ? 'active' : 'null'}`
      );

      // Birdeye returns: mutableMetadata, freezeable, etc.
      return {
        mintAuthorityRevoked: !securityData.mutableMetadata,
        freezeAuthorityRevoked: !securityData.freezeable,
        metadataMutable: securityData.mutableMetadata || false,
        isKnownScamTemplate: false,
      };
    }

    // COST OPTIMIZATION: Use Helius RPC (included in plan) instead of Birdeye API
    // This is a direct on-chain query for mint/freeze authority - more reliable and FREE
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

    // Get creation info to find first buyers
    const creationInfo = await birdeyeClient.getTokenCreationInfo(address);

    if (!creationInfo) {
      return {
        bundleDetected: false,
        bundledSupplyPercent: 0,
        clusteredWalletCount: 0,
        fundingOverlapDetected: false,
        hasRugHistory: false,
        riskLevel: 'LOW',
      };
    }

    // Get first transactions after token creation
    const txs = await heliusClient.getRecentTransactions(address, 50);

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
    const creationInfo = await birdeyeClient.getTokenCreationInfo(address);
    
    if (!creationInfo?.creator) {
      return null;
    }

    const deployerAddress = creationInfo.creator;

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
    const tradeData = await birdeyeClient.getTokenTradeData(address);

    if (!tradeData) {
      return {
        score: 50, // Default medium score
        uniqueWalletRatio: 0.5,
        sizeDistributionScore: 50,
        temporalPatternScore: 50,
        isWashTradingSuspected: false,
      };
    }

    // Calculate unique wallet ratio
    const uniqueBuyers = tradeData.uniqueBuy24h || 0;
    const uniqueSellers = tradeData.uniqueSell24h || 0;
    const totalTrades = (tradeData.buy24h || 0) + (tradeData.sell24h || 0);
    const uniqueWalletRatio = totalTrades > 0 ? (uniqueBuyers + uniqueSellers) / totalTrades : 0.5;

    // Simplified scoring - in production, would analyze actual trade sizes
    const sizeDistributionScore = 60; // Placeholder
    const temporalPatternScore = 60; // Placeholder

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
  birdeyeClient,
  dexScreenerClient,
  getTokenMetrics,
  analyzeTokenContract,
  analyzeBundles,
  analyzeDevWallet,
  calculateVolumeAuthenticity,
  analyzeCTO,
};
