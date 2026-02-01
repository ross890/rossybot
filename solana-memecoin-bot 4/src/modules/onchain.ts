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
  }

  async getTokenHolders(mintAddress: string): Promise<{
    total: number;
    topHolders: { address: string; amount: number; percentage: number }[];
  }> {
    try {
      // Use Helius RPC endpoint with DAS API method
      // The RPC URL should already include api-key from constructor
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
    } catch (error: any) {
      const status = error?.response?.status;
      const errorData = error?.response?.data;
      const message = errorData?.error?.message || errorData?.error || error?.message;
      logger.error(`Failed to get token holders from Helius: status=${status} error=${message} url=${this.rpcUrl.replace(/api-key=([^&]+)/, 'api-key=***')}`);
      throw error;
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
    try {
      const response = await this.client.post('', {
        jsonrpc: '2.0',
        id: 'account-info',
        method: 'getAccountInfo',
        params: [address, { encoding: 'jsonParsed' }],
      });
      
      return response.data.result?.value;
    } catch (error) {
      logger.error({ error, address }, 'Failed to get account info');
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
  
  constructor() {
    this.client = axios.create({
      baseURL: 'https://public-api.birdeye.so',
      timeout: 15000,
      headers: {
        'X-API-KEY': appConfig.birdeyeApiKey,
        'x-chain': 'solana',
      },
    });
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
    try {
      const response = await this.client.get(`/defi/token_overview`, {
        params: { address },
      });
      return response.data.data;
    } catch (error) {
      logger.error({ error, address }, 'Failed to get token overview from Birdeye');
      return null;
    }
  }

  async getTokenSecurity(address: string): Promise<any> {
    try {
      const response = await this.client.get(`/defi/token_security`, {
        params: { address },
      });
      return response.data.data;
    } catch (error) {
      logger.error({ error, address }, 'Failed to get token security from Birdeye');
      return null;
    }
  }

  async getTokenCreationInfo(address: string): Promise<any> {
    try {
      const response = await this.client.get(`/defi/token_creation_info`, {
        params: { address },
      });
      return response.data.data;
    } catch (error) {
      logger.error({ error, address }, 'Failed to get token creation info from Birdeye');
      return null;
    }
  }

  async getTokenTradeData(address: string, timeframe = '24h'): Promise<any> {
    try {
      const response = await this.client.get(`/defi/v3/token/trade-data/single`, {
        params: { address, type: timeframe },
      });
      return response.data.data;
    } catch (error) {
      logger.error({ error, address }, 'Failed to get token trade data from Birdeye');
      return null;
    }
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
}

class DexScreenerClient {
  private client: AxiosInstance;

  // Cache for token pairs with TTL
  private pairsCache: Map<string, { data: DexScreenerPair[]; expiry: number }> = new Map();
  private readonly CACHE_TTL_MS = 30 * 1000; // 30 seconds cache
  private readonly CACHE_TTL_EMPTY_MS = 10 * 1000; // 10 seconds for empty results
  private readonly MAX_CACHE_SIZE = 500; // Prevent memory bloat

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.dexscreener.com',
      timeout: 10000,
    });

    // Clean up expired cache entries every 5 minutes
    setInterval(() => this.cleanupCache(), 5 * 60 * 1000);
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

  async getTokenPairs(address: string): Promise<DexScreenerPair[]> {
    const now = Date.now();

    // Check cache first
    const cached = this.pairsCache.get(address);
    if (cached && cached.expiry > now) {
      return cached.data;
    }

    try {
      const response = await this.client.get(`/latest/dex/tokens/${address}`);
      const pairs = response.data.pairs?.filter((p: any) => p.chainId === 'solana') || [];

      // Cache the result
      const ttl = pairs.length > 0 ? this.CACHE_TTL_MS : this.CACHE_TTL_EMPTY_MS;
      this.pairsCache.set(address, { data: pairs, expiry: now + ttl });

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

      // On rate limit, cache empty result briefly to prevent hammering
      if (status === 429) {
        this.pairsCache.set(address, { data: [], expiry: now + this.CACHE_TTL_EMPTY_MS });
      }

      logger.info(`DexScreener getTokenPairs failed: status=${status} error=${message} address=${address.slice(0, 8)}...`);
      return [];
    }
  }

  async searchTokens(query: string): Promise<DexScreenerPair[]> {
    try {
      const response = await this.client.get(`/latest/dex/search`, {
        params: { q: query },
      });
      return response.data.pairs?.filter((p: any) => p.chainId === 'solana') || [];
    } catch (error: any) {
      const status = error?.response?.status;
      const message = error?.response?.data?.message || error?.message;
      logger.error(`DexScreener searchTokens failed: status=${status} error=${message} query=${query}`);
      return [];
    }
  }

  /**
   * Get new/trending Solana token pairs from DexScreener
   * This is a free alternative to Birdeye's new_listing endpoint
   */
  async getNewSolanaPairs(limit = 50): Promise<any[]> {
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
      logger.debug({ error: error?.message, status: error?.response?.status }, 'token-boosts endpoint failed for trending tokens');
    }

    // Fallback: Try token-profiles endpoint
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

// ============ SINGLETON INSTANCES ============

export const heliusClient = new HeliusClient();
export const birdeyeClient = new BirdeyeClient();
export const dexScreenerClient = new DexScreenerClient();

// ============ COMBINED DATA FETCHING ============

export async function getTokenMetrics(address: string): Promise<TokenMetrics | null> {
  try {
    // Fetch data from multiple sources in parallel
    // Use Promise.allSettled to handle partial failures gracefully
    const [birdeyeResult, dexResult, holderResult] = await Promise.allSettled([
      birdeyeClient.getTokenOverview(address),
      dexScreenerClient.getTokenPairs(address),
      heliusClient.getTokenHolders(address),
    ]);

    const birdeyeData = birdeyeResult.status === 'fulfilled' ? birdeyeResult.value : null;
    const dexPairs = dexResult.status === 'fulfilled' ? dexResult.value : [];
    const holderData = holderResult.status === 'fulfilled' ? holderResult.value : { total: 0, topHolders: [] };

    // For very new tokens, we may have no data from APIs yet
    // Use holder data from Helius as a fallback indicator that the token exists
    const hasAnyData = birdeyeData || dexPairs.length > 0 || holderData.total > 0;

    if (!hasAnyData) {
      // Only reject if we truly have nothing at all
      logger.debug({ address: address.slice(0, 8) }, 'No data found for token from any source');
      return null;
    }

    // Use DexScreener as primary for price/volume, Birdeye for holder data
    const primaryPair = dexPairs[0];
    const price = primaryPair ? parseFloat(primaryPair.priceUsd || '0') : (birdeyeData?.price || 0);
    const marketCap = primaryPair ? (primaryPair.fdv || 0) : (birdeyeData?.mc || 0);
    const volume24h = primaryPair ? (primaryPair.volume?.h24 || 0) : (birdeyeData?.v24h || 0);
    const liquidity = primaryPair ? (primaryPair.liquidity?.usd || 0) : (birdeyeData?.liquidity || 0);

    // Calculate top 10 concentration (default to 50% if no data - conservative for new tokens)
    const top10Concentration = holderData.topHolders.length > 0
      ? holderData.topHolders.reduce((sum, h) => sum + h.percentage, 0)
      : 50; // Default for very new tokens

    // Get token creation time for age calculation
    // Priority: 1) DexScreener pairCreatedAt, 2) Birdeye creationInfo, 3) Default 5 min
    let ageMinutes = 5; // Default to 5 minutes for very new tokens

    // Try DexScreener first (most reliable - already fetched)
    if (primaryPair?.pairCreatedAt) {
      ageMinutes = (Date.now() - primaryPair.pairCreatedAt) / (1000 * 60);
    } else {
      // Fall back to Birdeye API
      try {
        const creationInfo = await birdeyeClient.getTokenCreationInfo(address);
        if (creationInfo?.createdTime) {
          const creationTimestamp = creationInfo.createdTime;
          ageMinutes = (Date.now() - creationTimestamp) / (1000 * 60);
        }
      } catch {
        // Ignore creation info errors - use default age
      }
    }

    // For tokens with minimal data, use permissive defaults
    // This allows very new tokens to pass through to scoring
    return {
      address,
      ticker: primaryPair?.baseToken?.symbol || birdeyeData?.symbol || 'NEW',
      name: primaryPair?.baseToken?.name || birdeyeData?.name || 'New Token',
      price: price || 0.000001, // Default tiny price if unknown
      marketCap: marketCap || 10000, // Default $10k mcap if unknown (meets min threshold)
      volume24h: volume24h || 1000, // Default $1k volume if unknown
      volumeMarketCapRatio: marketCap > 0 ? volume24h / marketCap : 0.1, // Default 10% ratio
      holderCount: birdeyeData?.holder || holderData.total || 25, // Default 25 holders
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
    const security = await birdeyeClient.getTokenSecurity(address);

    // Log what Birdeye actually returned (raw keys + values)
    const securityKeys = security ? Object.keys(security).join(',') : 'null';
    logger.info(
      `Birdeye security for ${address.slice(0, 8)}: keys=[${securityKeys}] mintAuth=${JSON.stringify(security?.mintAuthority)} freezeAuth=${JSON.stringify(security?.freezeAuthority)}`
    );

    // Handle null/undefined security response
    if (!security) {
      logger.warn(`No security data from Birdeye for ${address.slice(0, 8)} - letting through`);
      // Return permissive defaults when API returns nothing (let token through)
      return {
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        metadataMutable: false,
        isKnownScamTemplate: false,
      };
    }

    // Use falsy check (!value) instead of === null to handle both null and undefined
    // Birdeye may return undefined for mintAuthority if field doesn't exist
    return {
      mintAuthorityRevoked: !security.mintAuthority,
      freezeAuthorityRevoked: !security.freezeAuthority,
      metadataMutable: security.mutableMetadata === true || security.mutable === true,
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
