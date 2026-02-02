// ===========================================
// MODULE 2: KOL WALLET TRACKING SYSTEM
// ===========================================

import { heliusClient, birdeyeClient } from './onchain.js';
import { Database } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { kolAnalytics } from './kol/kol-analytics.js';
import {
  Kol,
  KolWallet,
  KolPerformance,
  KolWalletActivity,
  KolTier,
  WalletType,
  AttributionConfidence,
  LinkMethod,
  AlphaWallet,
  AlphaWalletStatus,
} from '../types/index.js';

// ============ CONSTANTS ============

const MAIN_WALLET_WEIGHT = 1.0;
const SIDE_WALLET_WEIGHT = 0.7;

const CONFIDENCE_WEIGHTS: Record<AttributionConfidence, number> = {
  [AttributionConfidence.HIGH]: 0.85,
  [AttributionConfidence.MEDIUM_HIGH]: 0.70,
  [AttributionConfidence.MEDIUM]: 0.50,
  [AttributionConfidence.LOW_MEDIUM]: 0.30,
  [AttributionConfidence.LOW]: 0.10,
};

const TIER_WEIGHTS: Record<KolTier, number> = {
  [KolTier.TIER_1]: 1.0,
  [KolTier.TIER_2]: 0.7,
  [KolTier.TIER_3]: 0.4,
};

// Minimum confidence level to generate signals
const MIN_SIGNAL_CONFIDENCE: AttributionConfidence = AttributionConfidence.MEDIUM;

// Time window for detecting KOL activity (in milliseconds)
const ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// ============ KOL WALLET MONITOR ============

export class KolWalletMonitor {
  private trackedWallets: Map<string, KolWallet & { kol: Kol }> = new Map();
  private walletToKol: Map<string, string> = new Map(); // address -> kolId
  
  async initialize(): Promise<void> {
    logger.info('Initializing KOL wallet monitor...');
    await this.loadTrackedWallets();
    logger.info({ walletCount: this.trackedWallets.size }, 'KOL wallet monitor initialized');
  }
  
  async loadTrackedWallets(): Promise<void> {
    const wallets = await Database.getAllTrackedWallets();
    
    this.trackedWallets.clear();
    this.walletToKol.clear();
    
    for (const wallet of wallets) {
      this.trackedWallets.set(wallet.address, wallet);
      this.walletToKol.set(wallet.address, wallet.kolId);
    }
  }
  
  isTrackedWallet(address: string): boolean {
    return this.trackedWallets.has(address);
  }
  
  getWalletInfo(address: string): (KolWallet & { kol: Kol }) | undefined {
    return this.trackedWallets.get(address);
  }
  
  /**
   * Check if a KOL has bought a specific token recently
   */
  async getKolActivityForToken(
    tokenAddress: string,
    windowMs: number = ACTIVITY_WINDOW_MS
  ): Promise<KolWalletActivity[]> {
    const activities: KolWalletActivity[] = [];
    const cutoffTime = Date.now() - windowMs;
    
    for (const [walletAddress, walletInfo] of this.trackedWallets) {
      try {
        // Get recent transactions for this wallet
        const txs = await heliusClient.getRecentTransactions(walletAddress, 20);
        
        for (const tx of txs) {
          // Skip if transaction is too old
          if (tx.blockTime && tx.blockTime * 1000 < cutoffTime) continue;
          
          // Get full transaction details
          const txDetails = await heliusClient.getTransaction(tx.signature);
          if (!txDetails) continue;
          
          // Check if this transaction involves the target token
          const tokenBuy = this.parseTokenBuy(txDetails, tokenAddress, walletAddress);
          if (!tokenBuy) continue;
          
          // Get KOL performance from kol-analytics (single source of truth)
          const stats = await kolAnalytics.getKolStats(walletInfo.kolId);
          const performance: KolPerformance = stats ? {
            kolId: walletInfo.kolId,
            totalTrades: stats.totalTrades,
            wins: Math.round(stats.winRate * stats.totalTrades),
            losses: stats.totalTrades - Math.round(stats.winRate * stats.totalTrades),
            winRate: stats.winRate,
            avgRoi: stats.avgRoi,
            medianRoi: stats.avgRoi, // Use avgRoi as approximation
            lastCalculated: new Date(),
          } : {
            kolId: walletInfo.kolId,
            totalTrades: 0,
            wins: 0,
            losses: 0,
            winRate: 0,
            avgRoi: 0,
            medianRoi: 0,
            lastCalculated: new Date(),
          };
          
          activities.push({
            kol: walletInfo.kol,
            wallet: walletInfo,
            performance,
            transaction: {
              signature: tx.signature,
              solAmount: tokenBuy.solAmount,
              usdValue: tokenBuy.usdValue,
              tokensAcquired: tokenBuy.tokensAcquired,
              supplyPercent: tokenBuy.supplyPercent,
              timestamp: new Date(tx.blockTime * 1000),
            },
          });
        }
      } catch (error) {
        logger.error({ error, walletAddress }, 'Error checking wallet activity');
      }
    }
    
    // Sort by timestamp descending (most recent first)
    activities.sort((a, b) => 
      b.transaction.timestamp.getTime() - a.transaction.timestamp.getTime()
    );
    
    return activities;
  }
  
  /**
   * Parse a transaction to extract token buy details
   */
  private parseTokenBuy(
    txDetails: any,
    targetTokenAddress: string,
    walletAddress: string
  ): { solAmount: number; usdValue: number; tokensAcquired: number; supplyPercent: number } | null {
    try {
      const instructions = txDetails.transaction?.message?.instructions || [];
      const innerInstructions = txDetails.meta?.innerInstructions || [];
      
      // Look for token transfers involving the target token
      let tokensReceived = 0;
      let solSpent = 0;
      
      // Check pre/post token balances
      const preBalances = txDetails.meta?.preTokenBalances || [];
      const postBalances = txDetails.meta?.postTokenBalances || [];
      
      for (const postBalance of postBalances) {
        if (postBalance.mint !== targetTokenAddress) continue;
        if (postBalance.owner !== walletAddress) continue;
        
        const preBalance = preBalances.find(
          (pb: any) => pb.mint === targetTokenAddress && pb.owner === walletAddress
        );
        
        const preBal = preBalance?.uiTokenAmount?.uiAmount || 0;
        const postBal = postBalance.uiTokenAmount?.uiAmount || 0;
        
        if (postBal > preBal) {
          tokensReceived = postBal - preBal;
        }
      }
      
      // Check SOL balance change
      const accountKeys = txDetails.transaction?.message?.accountKeys || [];
      const walletIndex = accountKeys.findIndex((k: any) => 
        (typeof k === 'string' ? k : k.pubkey) === walletAddress
      );
      
      if (walletIndex >= 0) {
        const preSol = txDetails.meta?.preBalances?.[walletIndex] || 0;
        const postSol = txDetails.meta?.postBalances?.[walletIndex] || 0;
        solSpent = (preSol - postSol) / 1e9; // Convert lamports to SOL
      }
      
      if (tokensReceived <= 0 || solSpent <= 0) {
        return null;
      }
      
      // Estimate USD value (would need SOL price, using $100 as placeholder)
      const solPrice = 100; // TODO: Get actual SOL price
      const usdValue = solSpent * solPrice;
      
      // Supply percent would need total supply data
      const supplyPercent = 0; // TODO: Calculate actual supply percent
      
      return {
        solAmount: solSpent,
        usdValue,
        tokensAcquired: tokensReceived,
        supplyPercent,
      };
    } catch (error) {
      logger.debug({ error }, 'Failed to parse token buy from transaction');
      return null;
    }
  }
  
  /**
   * Check if any alpha wallets have bought a specific token recently
   * Returns activity that can be used alongside KOL activity
   */
  async getAlphaWalletActivityForToken(
    tokenAddress: string,
    windowMs: number = ACTIVITY_WINDOW_MS
  ): Promise<Array<{
    wallet: AlphaWallet;
    transaction: {
      signature: string;
      solAmount: number;
      tokensAcquired: number;
      timestamp: Date;
    };
    signalWeight: number;
  }>> {
    const activities: Array<{
      wallet: AlphaWallet;
      transaction: {
        signature: string;
        solAmount: number;
        tokensAcquired: number;
        timestamp: Date;
      };
      signalWeight: number;
    }> = [];

    const cutoffTime = Date.now() - windowMs;

    // Get all active alpha wallets
    const alphaWallets = await Database.getActiveAlphaWallets();

    for (const wallet of alphaWallets) {
      // Skip suspended/removed wallets
      if (wallet.status === AlphaWalletStatus.SUSPENDED ||
          wallet.status === AlphaWalletStatus.REMOVED) {
        continue;
      }

      try {
        // Get recent transactions for this wallet
        const txs = await heliusClient.getRecentTransactions(wallet.address, 20);

        for (const tx of txs) {
          // Skip if transaction is too old
          if (tx.blockTime && tx.blockTime * 1000 < cutoffTime) continue;

          // Get full transaction details
          const txDetails = await heliusClient.getTransaction(tx.signature);
          if (!txDetails) continue;

          // Check if this transaction involves the target token
          const tokenBuy = this.parseTokenBuy(txDetails, tokenAddress, wallet.address);
          if (!tokenBuy) continue;

          activities.push({
            wallet,
            transaction: {
              signature: tx.signature,
              solAmount: tokenBuy.solAmount,
              tokensAcquired: tokenBuy.tokensAcquired,
              timestamp: new Date(tx.blockTime * 1000),
            },
            signalWeight: wallet.signalWeight,
          });
        }
      } catch (error) {
        logger.error({ error, walletAddress: wallet.address }, 'Error checking alpha wallet activity');
      }
    }

    // Sort by timestamp descending (most recent first)
    activities.sort((a, b) =>
      b.transaction.timestamp.getTime() - a.transaction.timestamp.getTime()
    );

    return activities;
  }

  /**
   * Combined check for both KOL and alpha wallet activity on a token
   */
  async getAllWalletActivityForToken(
    tokenAddress: string,
    windowMs: number = ACTIVITY_WINDOW_MS
  ): Promise<{
    kolActivity: KolWalletActivity[];
    alphaActivity: Array<{
      wallet: AlphaWallet;
      transaction: {
        signature: string;
        solAmount: number;
        tokensAcquired: number;
        timestamp: Date;
      };
      signalWeight: number;
    }>;
    totalSignalWeight: number;
  }> {
    const [kolActivity, alphaActivity] = await Promise.all([
      this.getKolActivityForToken(tokenAddress, windowMs),
      this.getAlphaWalletActivityForToken(tokenAddress, windowMs),
    ]);

    // Calculate total signal weight
    let totalSignalWeight = 0;

    for (const activity of kolActivity) {
      totalSignalWeight += this.calculateSignalWeight(activity);
    }

    for (const activity of alphaActivity) {
      totalSignalWeight += activity.signalWeight;
    }

    return {
      kolActivity,
      alphaActivity,
      totalSignalWeight,
    };
  }

  /**
   * Calculate signal weight for a KOL activity
   */
  calculateSignalWeight(activity: KolWalletActivity): number {
    const { kol, wallet, performance } = activity;
    
    // Base weight from wallet type
    const walletWeight = wallet.walletType === WalletType.MAIN 
      ? MAIN_WALLET_WEIGHT 
      : SIDE_WALLET_WEIGHT;
    
    // Confidence weight for side wallets
    const confidenceWeight = wallet.walletType === WalletType.SIDE
      ? CONFIDENCE_WEIGHTS[wallet.attributionConfidence]
      : 1.0;
    
    // Tier weight
    const tierWeight = TIER_WEIGHTS[kol.tier];
    
    // Historical accuracy weight (normalised to 0-1)
    const accuracyWeight = performance.totalTrades >= 10
      ? performance.winRate
      : 0.5; // Default for low sample size
    
    // Combine weights
    return walletWeight * confidenceWeight * tierWeight * accuracyWeight;
  }
  
  /**
   * Check if a KOL activity meets minimum signal requirements
   */
  meetsSignalRequirements(activity: KolWalletActivity): boolean {
    const { wallet } = activity;
    
    // Main wallets always meet requirements
    if (wallet.walletType === WalletType.MAIN) {
      return true;
    }
    
    // Side wallets must meet minimum confidence
    const confidenceLevels: AttributionConfidence[] = [
      AttributionConfidence.HIGH, AttributionConfidence.MEDIUM_HIGH, AttributionConfidence.MEDIUM, AttributionConfidence.LOW_MEDIUM, AttributionConfidence.LOW
    ];
    
    const minIndex = confidenceLevels.indexOf(MIN_SIGNAL_CONFIDENCE);
    const walletIndex = confidenceLevels.indexOf(wallet.attributionConfidence);
    
    return walletIndex <= minIndex;
  }
}

// ============ SIDE WALLET DETECTION ENGINE ============

export class SideWalletDetector {
  /**
   * Detect potential side wallets for a KOL
   * Returns candidate wallets with confidence scores
   */
  async detectSideWallets(
    kolId: string,
    mainWalletAddresses: string[]
  ): Promise<Array<{
    address: string;
    confidence: AttributionConfidence;
    linkMethod: LinkMethod;
    score: number;
    notes: string;
  }>> {
    const candidates: Map<string, {
      fundingScore: number;
      behaviourScore: number;
      correlationCount: number;
      linkMethods: LinkMethod[];
      notes: string[];
    }> = new Map();
    
    // Step 1: Funding trace (1-3 hops from main wallets)
    for (const mainAddress of mainWalletAddresses) {
      const fundingCandidates = await this.traceFunding(mainAddress, 3);
      
      for (const candidate of fundingCandidates) {
        if (mainWalletAddresses.includes(candidate.address)) continue;
        
        const existing = candidates.get(candidate.address) || {
          fundingScore: 0,
          behaviourScore: 0,
          correlationCount: 0,
          linkMethods: [],
          notes: [],
        };
        
        existing.fundingScore = Math.max(existing.fundingScore, candidate.score);
        if (!existing.linkMethods.includes(LinkMethod.FUNDING_CLUSTER)) {
          existing.linkMethods.push(LinkMethod.FUNDING_CLUSTER);
        }
        existing.notes.push(`Funding: ${candidate.hops} hops from ${mainAddress.slice(0, 8)}...`);
        
        candidates.set(candidate.address, existing);
      }
    }
    
    // Step 2: Behavioural matching (trade correlation)
    for (const mainAddress of mainWalletAddresses) {
      const mainTrades = await this.getWalletMemecoinTrades(mainAddress);
      
      for (const [candidateAddress, candidateData] of candidates) {
        const candidateTrades = await this.getWalletMemecoinTrades(candidateAddress);
        
        const correlation = this.calculateTradeCorrelation(mainTrades, candidateTrades);
        
        if (correlation.correlationScore > 0.3) {
          candidateData.behaviourScore = correlation.correlationScore;
          candidateData.correlationCount = correlation.matchCount;
          
          if (correlation.correlationScore > 0.5) {
            candidateData.linkMethods.push(LinkMethod.BEHAVIOURAL_MATCH);
          }
          if (correlation.matchCount >= 3) {
            candidateData.linkMethods.push(LinkMethod.TEMPORAL_CORRELATION);
          }
          
          candidateData.notes.push(
            `Behaviour: ${correlation.matchCount} correlated trades, score ${correlation.correlationScore.toFixed(2)}`
          );
        }
      }
    }
    
    // Step 3: Calculate final scores and filter
    const results: Array<{
      address: string;
      confidence: AttributionConfidence;
      linkMethod: LinkMethod;
      score: number;
      notes: string;
    }> = [];
    
    for (const [address, data] of candidates) {
      // Combined score: (Funding × 0.3) + (Behaviour × 0.4) + (Correlation count × 0.3)
      const correlationCountScore = Math.min(data.correlationCount / 10, 1);
      const finalScore = 
        (data.fundingScore * 0.3) +
        (data.behaviourScore * 0.4) +
        (correlationCountScore * 0.3);
      
      // Determine confidence level
      let confidence: AttributionConfidence;
      if (finalScore > 0.7 && data.correlationCount > 10) {
        confidence = AttributionConfidence.HIGH;
      } else if (finalScore > 0.5 && data.correlationCount > 5) {
        confidence = AttributionConfidence.MEDIUM_HIGH;
      } else if (finalScore > 0.3 && data.correlationCount >= 3) {
        confidence = AttributionConfidence.MEDIUM;
      } else if (data.correlationCount >= 2) {
        confidence = AttributionConfidence.LOW_MEDIUM;
      } else {
        confidence = AttributionConfidence.LOW;
      }
      
      // Skip LOW confidence (not useful for signals)
      if (confidence === AttributionConfidence.LOW) continue;
      
      // Determine primary link method
      const linkMethod = data.linkMethods.includes(LinkMethod.FUNDING_CLUSTER)
        ? LinkMethod.FUNDING_CLUSTER
        : data.linkMethods[0] || LinkMethod.BEHAVIOURAL_MATCH;
      
      results.push({
        address,
        confidence,
        linkMethod,
        score: finalScore,
        notes: data.notes.join('; '),
      });
    }
    
    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    
    return results;
  }
  
  /**
   * Trace funding from a wallet up to N hops
   */
  private async traceFunding(
    startAddress: string,
    maxHops: number
  ): Promise<Array<{ address: string; hops: number; score: number }>> {
    const seen = new Set<string>([startAddress]);
    const results: Array<{ address: string; hops: number; score: number }> = [];
    
    let currentLevel = [startAddress];
    
    for (let hop = 1; hop <= maxHops; hop++) {
      const nextLevel: string[] = [];
      
      for (const address of currentLevel) {
        try {
          const txs = await heliusClient.getRecentTransactions(address, 50);
          
          for (const tx of txs) {
            const txDetails = await heliusClient.getTransaction(tx.signature);
            if (!txDetails) continue;
            
            // Find SOL transfers
            const accountKeys = txDetails.transaction?.message?.accountKeys || [];
            const preBalances = txDetails.meta?.preBalances || [];
            const postBalances = txDetails.meta?.postBalances || [];
            
            for (let i = 0; i < accountKeys.length; i++) {
              const key = typeof accountKeys[i] === 'string' 
                ? accountKeys[i] 
                : accountKeys[i].pubkey;
              
              if (seen.has(key)) continue;
              
              const preBal = preBalances[i] || 0;
              const postBal = postBalances[i] || 0;
              const received = (postBal - preBal) / 1e9;
              
              // Only consider significant transfers (> 0.1 SOL)
              if (received > 0.1) {
                seen.add(key);
                nextLevel.push(key);
                
                // Score decreases with hops
                const score = hop === 1 ? 1.0 : hop === 2 ? 0.7 : 0.4;
                results.push({ address: key, hops: hop, score });
              }
            }
          }
        } catch (error) {
          logger.debug({ error, address }, 'Error tracing funding');
        }
      }
      
      currentLevel = nextLevel;
      if (currentLevel.length === 0) break;
    }
    
    return results;
  }
  
  /**
   * Get memecoin trades for a wallet
   */
  private async getWalletMemecoinTrades(address: string): Promise<Array<{
    tokenAddress: string;
    timestamp: number;
    action: 'buy' | 'sell';
  }>> {
    // Simplified - in production, would parse actual transactions
    const trades: Array<{
      tokenAddress: string;
      timestamp: number;
      action: 'buy' | 'sell';
    }> = [];
    
    try {
      const txs = await heliusClient.getRecentTransactions(address, 100);
      
      // Would need to parse each transaction for swap/trade activity
      // This is a placeholder
      
    } catch (error) {
      logger.debug({ error, address }, 'Error getting wallet trades');
    }
    
    return trades;
  }
  
  /**
   * Calculate correlation between two wallets' trading activity
   */
  private calculateTradeCorrelation(
    trades1: Array<{ tokenAddress: string; timestamp: number; action: 'buy' | 'sell' }>,
    trades2: Array<{ tokenAddress: string; timestamp: number; action: 'buy' | 'sell' }>
  ): { correlationScore: number; matchCount: number } {
    if (trades1.length === 0 || trades2.length === 0) {
      return { correlationScore: 0, matchCount: 0 };
    }
    
    let matchCount = 0;
    const timeWindow = 5 * 60 * 1000; // 5 minutes
    
    for (const t1 of trades1) {
      for (const t2 of trades2) {
        if (t1.tokenAddress !== t2.tokenAddress) continue;
        if (t1.action !== t2.action) continue;
        
        const timeDiff = Math.abs(t1.timestamp - t2.timestamp);
        if (timeDiff <= timeWindow) {
          matchCount++;
        }
      }
    }
    
    // Correlation score based on match count relative to total trades
    const totalTrades = Math.min(trades1.length, trades2.length);
    const correlationScore = totalTrades > 0 ? matchCount / totalTrades : 0;
    
    return { correlationScore, matchCount };
  }
}

// ============ EXPORTS ============

export const kolWalletMonitor = new KolWalletMonitor();
export const sideWalletDetector = new SideWalletDetector();

export default {
  KolWalletMonitor,
  SideWalletDetector,
  kolWalletMonitor,
  sideWalletDetector,
  MAIN_WALLET_WEIGHT,
  SIDE_WALLET_WEIGHT,
  CONFIDENCE_WEIGHTS,
  TIER_WEIGHTS,
};
