// ===========================================
// MODULE: MEV BOT DETECTOR
// Detects MEV bot activity as an early pump signal
// When bots start targeting a token, it often precedes pumps
// ===========================================

import { logger } from '../utils/logger.js';
import { heliusClient } from './onchain.js';
import { appConfig } from '../config/index.js';

// ============ TYPES ============

export interface MEVActivity {
  detected: boolean;
  type: 'SANDWICH' | 'ARBITRAGE' | 'LIQUIDATION' | 'FRONTRUN' | 'BACKRUN' | 'NONE';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  botWallets: string[];           // Detected bot wallets involved
  estimatedProfit: number;        // Estimated MEV profit in USD
  victimCount: number;            // Number of sandwiched transactions
  timestamp: Date;
  details: {
    txSignatures: string[];       // Transaction signatures involved
    priceImpact: number;          // % price impact from MEV
    volumeImpact: number;         // Volume attributed to MEV activity
  };
}

export interface MEVSignal {
  tokenAddress: string;
  activityLevel: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  recentMEVCount: number;         // MEV transactions in last 10 min
  botWalletsActive: number;       // Unique bot wallets active
  avgSandwichProfit: number;      // Average profit per sandwich
  isEarlyPumpSignal: boolean;     // True if MEV activity suggests incoming pump
  recommendation: 'ENTER' | 'AVOID' | 'MONITOR';
  reasoning: string;
}

interface TransactionAnalysis {
  signature: string;
  timestamp: number;
  isMEVBot: boolean;
  mevType: MEVActivity['type'];
  profit: number;
  involvedWallets: string[];
}

// ============ KNOWN MEV BOT PATTERNS ============

// Known MEV bot program IDs on Solana
const MEV_PROGRAM_IDS = [
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter V6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  // Jupiter V4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium V4
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
];

// Known MEV bot wallet patterns (frequently observed)
// These are heuristically identified wallets that exhibit bot behavior
const KNOWN_BOT_WALLET_PREFIXES = [
  'MEV',   // Some bots use MEV prefix
  'ARB',   // Arbitrage bots
  'BOT',   // Generic bot wallets
  'SAND',  // Sandwich bots
];

// Characteristics of MEV bot transactions
const BOT_CHARACTERISTICS = {
  // Timing patterns
  MAX_BLOCK_DISTANCE: 2,          // Sandwich: buy and sell within 2 blocks
  MIN_PROFIT_THRESHOLD: 0.001,    // Minimum profit for bot activity (in SOL)

  // Volume patterns
  UNUSUAL_SIZE_MULTIPLIER: 5,     // Trade 5x+ average = suspicious
  RAPID_TRADE_WINDOW_MS: 5000,    // Multiple trades within 5 seconds

  // Wallet patterns
  FRESH_WALLET_AGE_HOURS: 24,     // Wallet created < 24h ago
  HIGH_TX_FREQUENCY: 100,         // 100+ transactions/day = likely bot
};

// ============ MEV DETECTOR CLASS ============

export class MEVDetector {
  private botWalletCache: Map<string, { isBot: boolean; confidence: number; lastChecked: number }> = new Map();
  private mevActivityCache: Map<string, { activity: MEVActivity[]; timestamp: number }> = new Map();

  private readonly BOT_CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour
  private readonly ACTIVITY_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

  /**
   * Analyze a token for MEV bot activity
   * High MEV activity can be an early pump signal
   */
  async analyzeToken(tokenAddress: string): Promise<MEVSignal> {
    try {
      // Check cache first
      const cached = this.mevActivityCache.get(tokenAddress);
      if (cached && Date.now() - cached.timestamp < this.ACTIVITY_CACHE_TTL_MS) {
        return this.buildSignalFromActivity(tokenAddress, cached.activity);
      }

      // Get recent transactions for the token
      const transactions = await this.getRecentTokenTransactions(tokenAddress);

      if (!transactions || transactions.length === 0) {
        return this.noActivitySignal(tokenAddress);
      }

      // Analyze each transaction for MEV patterns
      const mevActivities: MEVActivity[] = [];

      // Look for sandwich patterns
      const sandwiches = await this.detectSandwichPatterns(transactions, tokenAddress);
      mevActivities.push(...sandwiches);

      // Look for arbitrage patterns
      const arbitrage = await this.detectArbitragePatterns(transactions, tokenAddress);
      mevActivities.push(...arbitrage);

      // Look for frontrunning patterns
      const frontRuns = await this.detectFrontrunPatterns(transactions, tokenAddress);
      mevActivities.push(...frontRuns);

      // Cache the results
      this.mevActivityCache.set(tokenAddress, {
        activity: mevActivities,
        timestamp: Date.now(),
      });

      return this.buildSignalFromActivity(tokenAddress, mevActivities);
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to analyze MEV activity');
      return this.noActivitySignal(tokenAddress);
    }
  }

  /**
   * Quick check if a wallet exhibits bot behavior
   */
  async isLikelyBot(walletAddress: string): Promise<{ isBot: boolean; confidence: number; reasons: string[] }> {
    // Check cache
    const cached = this.botWalletCache.get(walletAddress);
    if (cached && Date.now() - cached.lastChecked < this.BOT_CACHE_TTL_MS) {
      return {
        isBot: cached.isBot,
        confidence: cached.confidence,
        reasons: cached.isBot ? ['Cached bot detection'] : [],
      };
    }

    const reasons: string[] = [];
    let botScore = 0;

    // Skip Helius calls when disabled - use prefix-only detection
    if (appConfig.heliusDisabled) {
      const prefix = walletAddress.slice(0, 3).toUpperCase();
      if (KNOWN_BOT_WALLET_PREFIXES.includes(prefix)) {
        return { isBot: true, confidence: 0.3, reasons: [`Suspicious wallet prefix: ${prefix}`] };
      }
      return { isBot: false, confidence: 0, reasons: [] };
    }

    try {
      // Check wallet prefix patterns
      const prefix = walletAddress.slice(0, 3).toUpperCase();
      if (KNOWN_BOT_WALLET_PREFIXES.includes(prefix)) {
        botScore += 30;
        reasons.push(`Suspicious wallet prefix: ${prefix}`);
      }

      // Get transaction history to analyze patterns
      const txHistory = await heliusClient.getRecentTransactions(walletAddress, 50);

      if (txHistory && txHistory.length > 0) {
        // Check transaction frequency
        const oldestTx = txHistory[txHistory.length - 1];
        const newestTx = txHistory[0];
        const timeSpanHours = (newestTx.timestamp - oldestTx.timestamp) / (1000 * 60 * 60);

        if (timeSpanHours > 0) {
          const txPerHour = txHistory.length / timeSpanHours;
          if (txPerHour > 10) {
            botScore += 40;
            reasons.push(`High tx frequency: ${txPerHour.toFixed(1)}/hour`);
          } else if (txPerHour > 5) {
            botScore += 20;
            reasons.push(`Elevated tx frequency: ${txPerHour.toFixed(1)}/hour`);
          }
        }

        // Check for rapid consecutive trades (same token within seconds)
        const rapidTrades = this.detectRapidTrades(txHistory);
        if (rapidTrades > 5) {
          botScore += 30;
          reasons.push(`Rapid consecutive trades: ${rapidTrades}`);
        }

        // Check for round-trip trades (buy then sell quickly)
        const roundTrips = this.detectRoundTrips(txHistory);
        if (roundTrips > 3) {
          botScore += 25;
          reasons.push(`Round-trip trades detected: ${roundTrips}`);
        }
      }

      // Normalize score to confidence
      const confidence = Math.min(100, botScore);
      const isBot = confidence >= 50;

      // Cache result
      this.botWalletCache.set(walletAddress, {
        isBot,
        confidence,
        lastChecked: Date.now(),
      });

      return { isBot, confidence, reasons };
    } catch (error) {
      logger.debug({ error, walletAddress }, 'Error checking bot status');
      return { isBot: false, confidence: 0, reasons: [] };
    }
  }

  /**
   * Detect sandwich attack patterns in transactions
   * Pattern: Bot buys -> Victim buys (price up) -> Bot sells (profit)
   */
  private async detectSandwichPatterns(
    transactions: any[],
    tokenAddress: string
  ): Promise<MEVActivity[]> {
    const sandwiches: MEVActivity[] = [];

    // Sort by timestamp
    const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);

    // Look for buy-buy-sell or buy-victim-sell patterns within short time windows
    for (let i = 0; i < sorted.length - 2; i++) {
      const tx1 = sorted[i];
      const tx2 = sorted[i + 1];
      const tx3 = sorted[i + 2];

      // Check if all three are within a short time window (< 30 seconds)
      const timeWindow = (tx3.timestamp - tx1.timestamp) / 1000;
      if (timeWindow > 30) continue;

      // Check for sandwich pattern:
      // tx1: Bot BUY (same wallet as tx3)
      // tx2: Victim BUY (different wallet)
      // tx3: Bot SELL (same wallet as tx1)
      const tx1Wallet = this.extractWallet(tx1);
      const tx2Wallet = this.extractWallet(tx2);
      const tx3Wallet = this.extractWallet(tx3);

      if (tx1Wallet === tx3Wallet && tx1Wallet !== tx2Wallet) {
        const tx1Type = this.getTradeType(tx1, tokenAddress);
        const tx2Type = this.getTradeType(tx2, tokenAddress);
        const tx3Type = this.getTradeType(tx3, tokenAddress);

        if (tx1Type === 'BUY' && tx2Type === 'BUY' && tx3Type === 'SELL') {
          // Potential sandwich detected
          const botCheck = await this.isLikelyBot(tx1Wallet);

          sandwiches.push({
            detected: true,
            type: 'SANDWICH',
            confidence: botCheck.confidence >= 70 ? 'HIGH' : botCheck.confidence >= 40 ? 'MEDIUM' : 'LOW',
            botWallets: [tx1Wallet],
            estimatedProfit: this.estimateSandwichProfit(tx1, tx2, tx3),
            victimCount: 1,
            timestamp: new Date(tx2.timestamp),
            details: {
              txSignatures: [tx1.signature, tx2.signature, tx3.signature],
              priceImpact: this.estimatePriceImpact(tx1, tx2, tx3),
              volumeImpact: this.sumVolume([tx1, tx3]),
            },
          });

          logger.info({
            tokenAddress: tokenAddress.slice(0, 8),
            botWallet: tx1Wallet.slice(0, 8),
            timeWindow: `${timeWindow.toFixed(1)}s`,
            confidence: botCheck.confidence,
          }, '🥪 SANDWICH DETECTED - MEV activity');
        }
      }
    }

    return sandwiches;
  }

  /**
   * Detect arbitrage patterns
   * Pattern: Same wallet trades same token across multiple DEXes quickly
   */
  private async detectArbitragePatterns(
    transactions: any[],
    tokenAddress: string
  ): Promise<MEVActivity[]> {
    const arbitrage: MEVActivity[] = [];

    // Group transactions by wallet
    const byWallet = new Map<string, any[]>();
    for (const tx of transactions) {
      const wallet = this.extractWallet(tx);
      if (!byWallet.has(wallet)) {
        byWallet.set(wallet, []);
      }
      byWallet.get(wallet)!.push(tx);
    }

    // Look for wallets with multiple rapid trades
    for (const [wallet, walletTxs] of byWallet) {
      if (walletTxs.length < 2) continue;

      // Check for rapid trades (< 5 seconds apart)
      const sorted = walletTxs.sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i < sorted.length - 1; i++) {
        const timeDiff = (sorted[i + 1].timestamp - sorted[i].timestamp) / 1000;
        if (timeDiff < 5) {
          // Check if trades are on different DEXes (arbitrage indicator)
          const dex1 = this.extractDex(sorted[i]);
          const dex2 = this.extractDex(sorted[i + 1]);

          if (dex1 && dex2 && dex1 !== dex2) {
            const botCheck = await this.isLikelyBot(wallet);

            arbitrage.push({
              detected: true,
              type: 'ARBITRAGE',
              confidence: botCheck.confidence >= 60 ? 'HIGH' : 'MEDIUM',
              botWallets: [wallet],
              estimatedProfit: 0, // Hard to estimate without price data
              victimCount: 0,
              timestamp: new Date(sorted[i].timestamp),
              details: {
                txSignatures: [sorted[i].signature, sorted[i + 1].signature],
                priceImpact: 0,
                volumeImpact: this.sumVolume([sorted[i], sorted[i + 1]]),
              },
            });

            logger.debug({
              tokenAddress: tokenAddress.slice(0, 8),
              wallet: wallet.slice(0, 8),
              dexes: [dex1, dex2],
            }, '⚡ ARBITRAGE DETECTED');
          }
        }
      }
    }

    return arbitrage;
  }

  /**
   * Detect frontrunning patterns
   * Pattern: Bot executes trade just before a large pending trade
   */
  private async detectFrontrunPatterns(
    transactions: any[],
    tokenAddress: string
  ): Promise<MEVActivity[]> {
    const frontRuns: MEVActivity[] = [];

    // Sort by timestamp
    const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);

    // Look for small trade followed immediately by large trade
    for (let i = 0; i < sorted.length - 1; i++) {
      const tx1 = sorted[i];
      const tx2 = sorted[i + 1];

      const timeDiff = (tx2.timestamp - tx1.timestamp) / 1000;
      if (timeDiff > 2) continue; // Must be within 2 seconds

      const volume1 = this.extractVolume(tx1);
      const volume2 = this.extractVolume(tx2);

      // Frontrun pattern: small trade before large trade (5x+ size difference)
      if (volume2 > volume1 * 5 && volume1 > 0) {
        const wallet1 = this.extractWallet(tx1);
        const wallet2 = this.extractWallet(tx2);

        if (wallet1 !== wallet2) {
          const botCheck = await this.isLikelyBot(wallet1);

          if (botCheck.confidence >= 40) {
            frontRuns.push({
              detected: true,
              type: 'FRONTRUN',
              confidence: botCheck.confidence >= 70 ? 'HIGH' : 'MEDIUM',
              botWallets: [wallet1],
              estimatedProfit: 0,
              victimCount: 1,
              timestamp: new Date(tx1.timestamp),
              details: {
                txSignatures: [tx1.signature, tx2.signature],
                priceImpact: 0,
                volumeImpact: volume1 + volume2,
              },
            });
          }
        }
      }
    }

    return frontRuns;
  }

  /**
   * Build a trading signal from MEV activity analysis
   */
  private buildSignalFromActivity(tokenAddress: string, activities: MEVActivity[]): MEVSignal {
    if (activities.length === 0) {
      return this.noActivitySignal(tokenAddress);
    }

    const recentActivities = activities.filter(
      a => Date.now() - a.timestamp.getTime() < 10 * 60 * 1000 // Last 10 minutes
    );

    const uniqueBots = new Set(activities.flatMap(a => a.botWallets));
    const avgProfit = activities.reduce((sum, a) => sum + a.estimatedProfit, 0) / activities.length;
    const highConfidenceCount = activities.filter(a => a.confidence === 'HIGH').length;

    // Determine activity level
    let activityLevel: MEVSignal['activityLevel'] = 'NONE';
    if (recentActivities.length >= 5 || highConfidenceCount >= 3) {
      activityLevel = 'HIGH';
    } else if (recentActivities.length >= 2 || highConfidenceCount >= 1) {
      activityLevel = 'MEDIUM';
    } else if (recentActivities.length >= 1) {
      activityLevel = 'LOW';
    }

    // Determine if this is an early pump signal
    // High MEV activity often precedes pumps because bots detect opportunity
    const isEarlyPumpSignal = activityLevel === 'HIGH' ||
      (activityLevel === 'MEDIUM' && uniqueBots.size >= 2);

    // Generate recommendation
    let recommendation: MEVSignal['recommendation'] = 'MONITOR';
    let reasoning = '';

    if (isEarlyPumpSignal) {
      // MEV bots are active = potential pump incoming
      recommendation = 'ENTER';
      reasoning = `High MEV activity (${recentActivities.length} events, ${uniqueBots.size} bots) suggests increased interest - potential early pump signal`;
    } else if (activityLevel === 'HIGH' && avgProfit > 100) {
      // Heavy extraction happening = be cautious
      recommendation = 'AVOID';
      reasoning = `Heavy MEV extraction ($${avgProfit.toFixed(0)} avg profit) - high slippage risk`;
    } else if (activityLevel === 'MEDIUM') {
      recommendation = 'MONITOR';
      reasoning = `Moderate MEV activity detected - monitor for increased bot presence`;
    }

    const signal: MEVSignal = {
      tokenAddress,
      activityLevel,
      recentMEVCount: recentActivities.length,
      botWalletsActive: uniqueBots.size,
      avgSandwichProfit: avgProfit,
      isEarlyPumpSignal,
      recommendation,
      reasoning,
    };

    if (isEarlyPumpSignal) {
      logger.info({
        tokenAddress: tokenAddress.slice(0, 8),
        activityLevel,
        mevCount: recentActivities.length,
        botsActive: uniqueBots.size,
        recommendation,
      }, '🤖 MEV EARLY PUMP SIGNAL - Bot activity detected');
    }

    return signal;
  }

  private noActivitySignal(tokenAddress: string): MEVSignal {
    return {
      tokenAddress,
      activityLevel: 'NONE',
      recentMEVCount: 0,
      botWalletsActive: 0,
      avgSandwichProfit: 0,
      isEarlyPumpSignal: false,
      recommendation: 'MONITOR',
      reasoning: 'No significant MEV activity detected',
    };
  }

  // ============ HELPER METHODS ============

  private async getRecentTokenTransactions(tokenAddress: string): Promise<any[]> {
    // Skip when Helius is disabled
    if (appConfig.heliusDisabled) {
      return [];
    }

    try {
      // Use Helius to get recent transactions for the token
      const transactions = await heliusClient.getRecentTransactions(tokenAddress, 100);
      return transactions || [];
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to get token transactions');
      return [];
    }
  }

  private extractWallet(tx: any): string {
    // Extract the signing wallet from transaction
    return tx.feePayer || tx.signer || tx.source || '';
  }

  private extractDex(tx: any): string | null {
    // Try to identify which DEX the transaction used
    const programIds = tx.programIds || [];
    for (const programId of programIds) {
      if (programId.includes('JUP')) return 'Jupiter';
      if (programId.includes('675kPX')) return 'Raydium';
      if (programId.includes('whirL')) return 'Orca';
      if (programId.includes('6EF8')) return 'Pump.fun';
    }
    return tx.source || null;
  }

  private extractVolume(tx: any): number {
    // Extract trade volume from transaction
    return tx.amount || tx.volume || tx.nativeTransfers?.[0]?.amount || 0;
  }

  private getTradeType(tx: any, tokenAddress: string): 'BUY' | 'SELL' | 'UNKNOWN' {
    // Determine if this is a buy or sell of the token
    if (tx.type === 'SWAP') {
      if (tx.tokenOutputs?.some((t: any) => t.mint === tokenAddress)) return 'BUY';
      if (tx.tokenInputs?.some((t: any) => t.mint === tokenAddress)) return 'SELL';
    }
    return 'UNKNOWN';
  }

  private estimateSandwichProfit(tx1: any, tx2: any, tx3: any): number {
    // Estimate profit from sandwich (simplified)
    const buyAmount = this.extractVolume(tx1);
    const sellAmount = this.extractVolume(tx3);
    return Math.max(0, sellAmount - buyAmount);
  }

  private estimatePriceImpact(tx1: any, tx2: any, tx3: any): number {
    // Estimate price impact percentage (simplified)
    return 0; // Would need price data to calculate properly
  }

  private sumVolume(txs: any[]): number {
    return txs.reduce((sum, tx) => sum + this.extractVolume(tx), 0);
  }

  private detectRapidTrades(txHistory: any[]): number {
    let rapidCount = 0;
    for (let i = 0; i < txHistory.length - 1; i++) {
      const timeDiff = Math.abs(txHistory[i].timestamp - txHistory[i + 1].timestamp);
      if (timeDiff < BOT_CHARACTERISTICS.RAPID_TRADE_WINDOW_MS) {
        rapidCount++;
      }
    }
    return rapidCount;
  }

  private detectRoundTrips(txHistory: any[]): number {
    // Simplified: count buy-then-sell patterns within short time
    let roundTrips = 0;
    const tokenTrades = new Map<string, { type: string; timestamp: number }[]>();

    for (const tx of txHistory) {
      if (tx.type === 'SWAP' && tx.tokenOutputs?.length > 0) {
        const token = tx.tokenOutputs[0].mint;
        if (!tokenTrades.has(token)) {
          tokenTrades.set(token, []);
        }
        tokenTrades.get(token)!.push({
          type: 'BUY',
          timestamp: tx.timestamp,
        });
      }
      if (tx.type === 'SWAP' && tx.tokenInputs?.length > 0) {
        const token = tx.tokenInputs[0].mint;
        if (!tokenTrades.has(token)) {
          tokenTrades.set(token, []);
        }
        tokenTrades.get(token)!.push({
          type: 'SELL',
          timestamp: tx.timestamp,
        });
      }
    }

    // Count round trips (buy followed by sell within 5 minutes)
    for (const trades of tokenTrades.values()) {
      const sorted = trades.sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i < sorted.length - 1; i++) {
        if (sorted[i].type === 'BUY' && sorted[i + 1].type === 'SELL') {
          const timeDiff = (sorted[i + 1].timestamp - sorted[i].timestamp) / 1000 / 60;
          if (timeDiff < 5) {
            roundTrips++;
          }
        }
      }
    }

    return roundTrips;
  }

  /**
   * Clear caches
   */
  clearCaches(): void {
    this.botWalletCache.clear();
    this.mevActivityCache.clear();
  }
}

// ============ EXPORTS ============

export const mevDetector = new MEVDetector();

export default {
  MEVDetector,
  mevDetector,
};
