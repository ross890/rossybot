// ===========================================
// MODULE 1A: ON-CHAIN DATA FETCHING
// ===========================================

import axios, { AxiosInstance } from 'axios';
import { appConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import type {
  TokenMetrics,
  TokenContractAnalysis,
  BundleAnalysis,
  DevWalletBehaviour,
  VolumeAuthenticityScore,
  BirdeyeTokenOverview,
  DexScreenerPair,
} from '../types/index.js';
import { Database } from '../utils/database.js';

// ============ API CLIENTS ============

class HeliusClient {
  private client: AxiosInstance;
  
  constructor() {
    this.client = axios.create({
      baseURL: appConfig.heliusRpcUrl,
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
      // Use Helius DAS API for token holders
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
    } catch (error) {
      logger.error({ error, mintAddress }, 'Failed to get token holders from Helius');
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
    try {
      const response = await this.client.get(`/defi/v2/tokens/new_listing`, {
        params: { limit },
      });
      
      return response.data.data?.items || [];
    } catch (error) {
      logger.error({ error }, 'Failed to get new listings from Birdeye');
      return [];
    }
  }
}

class DexScreenerClient {
  private client: AxiosInstance;
  
  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.dexscreener.com/latest',
      timeout: 10000,
    });
  }
  
  async getTokenPairs(address: string): Promise<DexScreenerPair[]> {
    try {
      const response = await this.client.get(`/dex/tokens/${address}`);
      return response.data.pairs?.filter((p: any) => p.chainId === 'solana') || [];
    } catch (error) {
      logger.error({ error, address }, 'Failed to get pairs from DexScreener');
      return [];
    }
  }
  
  async searchTokens(query: string): Promise<DexScreenerPair[]> {
    try {
      const response = await this.client.get(`/dex/search`, {
        params: { q: query },
      });
      return response.data.pairs?.filter((p: any) => p.chainId === 'solana') || [];
    } catch (error) {
      logger.error({ error, query }, 'Failed to search tokens on DexScreener');
      return [];
    }
  }
}

// ============ SINGLETON INSTANCES ============

export const heliusClient = new HeliusClient();
export const birdeyeClient = new BirdeyeClient();
export const dexScreenerClient = new DexScreenerClient();

// ============ COMBINED DATA FETCHING ============

export async function getTokenMetrics(address: string): Promise<TokenMetrics | null> {
  try {
    // Fetch data from multiple sources in parallel
    const [birdeyeData, dexPairs, holderData] = await Promise.all([
      birdeyeClient.getTokenOverview(address),
      dexScreenerClient.getTokenPairs(address),
      heliusClient.getTokenHolders(address),
    ]);
    
    if (!birdeyeData && dexPairs.length === 0) {
      logger.warn({ address }, 'No data found for token');
      return null;
    }
    
    // Use DexScreener as primary for price/volume, Birdeye for holder data
    const primaryPair = dexPairs[0];
    
    const price = primaryPair
      ? parseFloat(primaryPair.priceUsd)
      : (birdeyeData?.price || 0);
    
    const marketCap = primaryPair
      ? primaryPair.fdv
      : (birdeyeData?.mc || 0);
    
    const volume24h = primaryPair
      ? primaryPair.volume.h24
      : (birdeyeData?.v24h || 0);
    
    const liquidity = primaryPair
      ? primaryPair.liquidity.usd
      : (birdeyeData?.liquidity || 0);
    
    // Calculate top 10 concentration
    const top10Concentration = holderData.topHolders.reduce(
      (sum, h) => sum + h.percentage, 0
    );
    
    // Get token creation time for age calculation
    const creationInfo = await birdeyeClient.getTokenCreationInfo(address);
    const creationTimestamp = creationInfo?.createdTime || Date.now();
    const ageMinutes = (Date.now() - creationTimestamp) / (1000 * 60);
    
    return {
      address,
      ticker: primaryPair?.baseToken.symbol || birdeyeData?.symbol || 'UNKNOWN',
      name: primaryPair?.baseToken.name || birdeyeData?.name || 'Unknown Token',
      price,
      marketCap,
      volume24h,
      volumeMarketCapRatio: marketCap > 0 ? volume24h / marketCap : 0,
      holderCount: birdeyeData?.holder || holderData.total,
      holderChange1h: 0, // Would need historical data to calculate
      top10Concentration,
      liquidityPool: liquidity,
      tokenAge: ageMinutes,
      lpLocked: false, // Requires separate LP lock check
      lpLockDuration: null,
    };
  } catch (error) {
    logger.error({ error, address }, 'Failed to get token metrics');
    return null;
  }
}

export async function analyzeTokenContract(address: string): Promise<TokenContractAnalysis> {
  try {
    const security = await birdeyeClient.getTokenSecurity(address);
    
    return {
      mintAuthorityRevoked: security?.mintAuthority === null,
      freezeAuthorityRevoked: security?.freezeAuthority === null,
      metadataMutable: security?.mutable !== false,
      isKnownScamTemplate: false, // Would require contract bytecode comparison
    };
  } catch (error) {
    logger.error({ error, address }, 'Failed to analyze token contract');
    // Return conservative defaults
    return {
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      metadataMutable: true,
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
    const riskLevel = 
      hasRugHistory || bundledSupplyPercent > 25 ? 'HIGH' :
      bundledSupplyPercent > 10 || clusteredCount > 5 ? 'MEDIUM' : 'LOW';
    
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
    const uniqueWalletRatio = totalTrades > 0 
      ? (uniqueBuyers + uniqueSellers) / totalTrades 
      : 0.5;
    
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
};
