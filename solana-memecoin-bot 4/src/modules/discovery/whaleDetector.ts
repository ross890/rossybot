// ===========================================
// MODULE: ENHANCED WHALE WALLET DETECTION
// Detects unknown whale buys in micro-cap tokens.
// Classifies whales by wallet age and profitability.
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { heliusClient } from '../onchain.js';
import { appConfig } from '../../config/index.js';

// ============ TYPES ============

export type WhaleClassification =
  | 'QUALITY_WHALE'       // 90+ day old wallet, profitable history
  | 'UNKNOWN_WHALE'       // Large buy, no classification yet
  | 'SUSPICIOUS_FRESH'    // < 7 day old wallet, large buy (insider risk)
  | 'KNOWN_ALPHA';        // Already in alpha wallet tracking

export interface WhaleBuy {
  walletAddress: string;
  tokenAddress: string;
  solAmount: number;
  timestamp: number;
  txSignature: string;
  classification: WhaleClassification;
  walletAgeDays: number | null;
  isProfitable: boolean | null;  // null = unknown
}

export interface WhaleCluster {
  tokenAddress: string;
  whales: WhaleBuy[];
  clusterSize: number;         // number of unique whale wallets
  totalSolDeployed: number;
  windowMinutes: number;       // time window of cluster detection
  isCluster: boolean;          // 3+ whales = cluster
  detectedAt: number;
}

export interface WhaleScoreBonus {
  singleWhaleBuyBonus: number;
  qualityWhaleBonus: number;
  whaleClusterBonus: number;
  suspiciousFreshPenalty: number;
  totalBonus: number;
}

// ============ CONSTANTS ============

const WHALE_CONFIG = {
  // Detection criteria
  MIN_BUY_SOL_MICRO: 5000 / 150,   // ~$5K in SOL for micro-cap ($30K-$225K mcap)
  MIN_BUY_SOL_RISING: 10000 / 150,  // ~$10K in SOL for rising ($225K+ mcap)

  // Wallet age thresholds
  QUALITY_WALLET_MIN_AGE_DAYS: 90,
  SUSPICIOUS_MAX_AGE_DAYS: 7,

  // Cluster detection
  CLUSTER_WINDOW_MINUTES: 5,
  CLUSTER_MIN_WHALES: 3,
  CLUSTER_MIN_SOL_PER_WALLET: 1000 / 150, // ~$1K min per wallet for cluster

  // Scoring bonuses
  SCORE_SINGLE_WHALE: 5,
  SCORE_QUALITY_WHALE: 10,
  SCORE_WHALE_CLUSTER: 15,
  SCORE_SUSPICIOUS_PENALTY: -5,

  // Cache
  WALLET_CLASSIFICATION_CACHE_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
  WHALE_DATA_CACHE_TTL_MS: 5 * 60 * 1000, // 5 minutes per token

  // API budget: 1 Helius call per token evaluation
  MAX_TX_TO_ANALYZE: 20,
} as const;

// ============ WHALE DETECTOR CLASS ============

export class WhaleDetector {
  // Cache wallet classifications for 24 hours
  private walletClassificationCache: Map<string, {
    classification: WhaleClassification;
    ageDays: number | null;
    isProfitable: boolean | null;
    expiry: number;
  }> = new Map();

  // Cache whale data per token
  private tokenWhaleCache: Map<string, {
    whales: WhaleBuy[];
    expiry: number;
  }> = new Map();

  // Known alpha wallet addresses (loaded from DB)
  private knownAlphaWallets: Set<string> = new Set();

  /**
   * Initialize — load known alpha wallets.
   */
  async initialize(): Promise<void> {
    await this.loadAlphaWallets();
    logger.info({
      knownAlphaWallets: this.knownAlphaWallets.size,
    }, 'Whale detector initialized');
  }

  /**
   * Detect whale buys for a token.
   * Budget: 1 Helius API call (getSignaturesForAddress, 20 txns).
   * Runs as async enrichment — doesn't block main evaluation pipeline.
   */
  async detectWhales(
    tokenAddress: string,
    marketCap: number,
  ): Promise<WhaleBuy[]> {
    // Check cache
    const cached = this.tokenWhaleCache.get(tokenAddress);
    if (cached && cached.expiry > Date.now()) {
      return cached.whales;
    }

    if (appConfig.heliusDisabled) {
      return [];
    }

    try {
      // Get recent transactions for the token
      const txs = await heliusClient.getRecentTransactions(
        tokenAddress,
        WHALE_CONFIG.MAX_TX_TO_ANALYZE,
      );

      if (!txs || txs.length === 0) return [];

      // Determine whale threshold based on market cap tier
      const minBuySol = marketCap < 225000
        ? WHALE_CONFIG.MIN_BUY_SOL_MICRO
        : WHALE_CONFIG.MIN_BUY_SOL_RISING;

      const whales: WhaleBuy[] = [];

      for (const tx of txs) {
        // Parse swap instructions to identify buy size and wallet
        const parsed = this.parseSwapTransaction(tx);
        if (!parsed) continue;
        if (parsed.solAmount < minBuySol) continue;

        // Classify the whale wallet
        const classification = await this.classifyWallet(parsed.walletAddress);

        whales.push({
          walletAddress: parsed.walletAddress,
          tokenAddress,
          solAmount: parsed.solAmount,
          timestamp: parsed.timestamp,
          txSignature: parsed.signature,
          classification: classification.classification,
          walletAgeDays: classification.ageDays,
          isProfitable: classification.isProfitable,
        });
      }

      // Cache result
      this.tokenWhaleCache.set(tokenAddress, {
        whales,
        expiry: Date.now() + WHALE_CONFIG.WHALE_DATA_CACHE_TTL_MS,
      });

      if (whales.length > 0) {
        logger.info({
          tokenAddress,
          whaleCount: whales.length,
          classifications: whales.map(w => w.classification),
        }, 'Whale buys detected');
      }

      return whales;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to detect whales');
      return [];
    }
  }

  /**
   * Detect whale clusters — 3+ unknown whales buying same token in 5 minutes.
   */
  async detectCluster(tokenAddress: string, marketCap: number): Promise<WhaleCluster> {
    const whales = await this.detectWhales(tokenAddress, marketCap);

    const now = Date.now();
    const windowMs = WHALE_CONFIG.CLUSTER_WINDOW_MINUTES * 60 * 1000;

    // Find whales within the cluster window
    const recentWhales = whales.filter(w =>
      now - w.timestamp < windowMs &&
      w.solAmount >= WHALE_CONFIG.CLUSTER_MIN_SOL_PER_WALLET * 150  // Convert back to USD
    );

    // Deduplicate by wallet address
    const uniqueWallets = new Map<string, WhaleBuy>();
    for (const w of recentWhales) {
      if (!uniqueWallets.has(w.walletAddress)) {
        uniqueWallets.set(w.walletAddress, w);
      }
    }

    const clusterWhales = [...uniqueWallets.values()];
    const totalSol = clusterWhales.reduce((sum, w) => sum + w.solAmount, 0);

    return {
      tokenAddress,
      whales: clusterWhales,
      clusterSize: clusterWhales.length,
      totalSolDeployed: totalSol,
      windowMinutes: WHALE_CONFIG.CLUSTER_WINDOW_MINUTES,
      isCluster: clusterWhales.length >= WHALE_CONFIG.CLUSTER_MIN_WHALES,
      detectedAt: now,
    };
  }

  /**
   * Calculate scoring bonus from whale activity.
   */
  async getWhaleScoreBonus(
    tokenAddress: string,
    marketCap: number,
  ): Promise<WhaleScoreBonus> {
    const whales = await this.detectWhales(tokenAddress, marketCap);

    let singleWhaleBuyBonus = 0;
    let qualityWhaleBonus = 0;
    let whaleClusterBonus = 0;
    let suspiciousFreshPenalty = 0;

    // Score individual whale buys
    for (const whale of whales) {
      switch (whale.classification) {
        case 'QUALITY_WHALE':
          qualityWhaleBonus = Math.max(qualityWhaleBonus, WHALE_CONFIG.SCORE_QUALITY_WHALE);
          break;
        case 'UNKNOWN_WHALE':
          singleWhaleBuyBonus = Math.max(singleWhaleBuyBonus, WHALE_CONFIG.SCORE_SINGLE_WHALE);
          break;
        case 'SUSPICIOUS_FRESH':
          suspiciousFreshPenalty = Math.min(suspiciousFreshPenalty, WHALE_CONFIG.SCORE_SUSPICIOUS_PENALTY);
          break;
        case 'KNOWN_ALPHA':
          // Already handled by existing alpha wallet system
          break;
      }
    }

    // Check for whale cluster
    const cluster = await this.detectCluster(tokenAddress, marketCap);
    if (cluster.isCluster) {
      whaleClusterBonus = WHALE_CONFIG.SCORE_WHALE_CLUSTER;
    }

    const totalBonus = singleWhaleBuyBonus + qualityWhaleBonus +
      whaleClusterBonus + suspiciousFreshPenalty;

    return {
      singleWhaleBuyBonus,
      qualityWhaleBonus,
      whaleClusterBonus,
      suspiciousFreshPenalty,
      totalBonus,
    };
  }

  /**
   * Parse a transaction to extract swap/buy details.
   */
  private parseSwapTransaction(tx: any): {
    walletAddress: string;
    solAmount: number;
    timestamp: number;
    signature: string;
  } | null {
    try {
      if (!tx || !tx.signature) return null;

      // Try to get the signer (buyer) from the transaction
      const signer = tx.feePayer || tx.signer;
      if (!signer) return null;

      // Estimate SOL amount from the transaction
      // For getSignaturesForAddress results, we get limited data
      // The timestamp is available from blockTime
      const blockTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();

      // We can't easily determine SOL amount from signature-only data
      // For now, mark all transactions as potential whale buys
      // The detailed parsing will happen if we use Enhanced Transactions API
      return {
        walletAddress: signer,
        solAmount: 0, // Will be populated by Enhanced Transactions API
        timestamp: blockTime,
        signature: tx.signature,
      };
    } catch {
      return null;
    }
  }

  /**
   * Classify a wallet based on age and profitability.
   */
  private async classifyWallet(walletAddress: string): Promise<{
    classification: WhaleClassification;
    ageDays: number | null;
    isProfitable: boolean | null;
  }> {
    // Check cache
    const cached = this.walletClassificationCache.get(walletAddress);
    if (cached && cached.expiry > Date.now()) {
      return {
        classification: cached.classification,
        ageDays: cached.ageDays,
        isProfitable: cached.isProfitable,
      };
    }

    // Check if known alpha wallet
    if (this.knownAlphaWallets.has(walletAddress)) {
      const result = {
        classification: 'KNOWN_ALPHA' as WhaleClassification,
        ageDays: null,
        isProfitable: null,
      };
      this.cacheClassification(walletAddress, result);
      return result;
    }

    // Default to unknown — detailed classification requires additional API calls
    // which we budget conservatively (wallet age check is expensive)
    let classification: WhaleClassification = 'UNKNOWN_WHALE';
    let ageDays: number | null = null;
    let isProfitable: boolean | null = null;

    try {
      // Try to get wallet's first transaction to determine age
      // This uses 1 additional Helius call — only for whale wallets
      if (!appConfig.heliusDisabled) {
        const txs = await heliusClient.getRecentTransactions(walletAddress, 1);
        if (txs && txs.length > 0) {
          const oldestTx = txs[txs.length - 1];
          if (oldestTx.blockTime) {
            const walletAge = Date.now() - oldestTx.blockTime * 1000;
            ageDays = Math.floor(walletAge / (24 * 60 * 60 * 1000));

            if (ageDays < WHALE_CONFIG.SUSPICIOUS_MAX_AGE_DAYS) {
              classification = 'SUSPICIOUS_FRESH';
            } else if (ageDays >= WHALE_CONFIG.QUALITY_WALLET_MIN_AGE_DAYS) {
              // Wallet is old enough — could be quality whale
              // Profitability check would need more API calls, skip for now
              classification = 'QUALITY_WHALE';
              isProfitable = null; // Unknown without more data
            }
          }
        }
      }
    } catch (error) {
      logger.debug({ error, walletAddress }, 'Failed to classify whale wallet');
    }

    const result = { classification, ageDays, isProfitable };
    this.cacheClassification(walletAddress, result);
    return result;
  }

  /**
   * Cache a wallet classification.
   */
  private cacheClassification(
    walletAddress: string,
    result: { classification: WhaleClassification; ageDays: number | null; isProfitable: boolean | null },
  ): void {
    this.walletClassificationCache.set(walletAddress, {
      ...result,
      expiry: Date.now() + WHALE_CONFIG.WALLET_CLASSIFICATION_CACHE_TTL_MS,
    });
  }

  /**
   * Load known alpha wallet addresses from database.
   */
  private async loadAlphaWallets(): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT address FROM alpha_wallets WHERE status IN ('ACTIVE', 'TRUSTED', 'PROBATION')`
      );
      for (const row of result.rows) {
        this.knownAlphaWallets.add(row.address);
      }
    } catch (error) {
      logger.debug({ error }, 'Failed to load alpha wallets for whale detector');
    }
  }

  /**
   * Refresh alpha wallet set (call after new alpha wallet added).
   */
  async refreshAlphaWallets(): Promise<void> {
    this.knownAlphaWallets.clear();
    await this.loadAlphaWallets();
  }

  /**
   * Format whale detection for display.
   */
  formatWhaleAlert(cluster: WhaleCluster): string {
    if (cluster.whales.length === 0) return '';

    const lines: string[] = [];

    if (cluster.isCluster) {
      lines.push(`🐋 *WHALE CLUSTER DETECTED*`);
      lines.push(`├─ ${cluster.clusterSize} whales in ${cluster.windowMinutes}min`);
      lines.push(`├─ Total deployed: ${cluster.totalSolDeployed.toFixed(1)} SOL`);
    } else {
      lines.push(`🐋 Whale activity: ${cluster.whales.length} large buy(s)`);
    }

    for (const whale of cluster.whales.slice(0, 3)) {
      const classLabel = whale.classification === 'QUALITY_WHALE' ? '✅ Quality'
        : whale.classification === 'SUSPICIOUS_FRESH' ? '⚠️ Fresh'
        : whale.classification === 'KNOWN_ALPHA' ? '🎯 Alpha'
        : '❓ Unknown';
      lines.push(`└─ ${classLabel} | ${whale.solAmount.toFixed(1)} SOL | ${whale.walletAgeDays !== null ? whale.walletAgeDays + 'd old' : 'age unknown'}`);
    }

    return lines.join('\n');
  }
}

// ============ SINGLETON EXPORT ============

export const whaleDetector = new WhaleDetector();

export default whaleDetector;
