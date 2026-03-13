// ===========================================
// MODULE: LIQUIDITY ADDITION DETECTION
// Detects LP additions to tracked tokens — a confidence
// signal that someone believes enough to risk their LP.
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { heliusClient } from '../onchain.js';
import { appConfig } from '../../config/index.js';

// ============ TYPES ============

export interface LiquidityEvent {
  tokenAddress: string;
  providerAddress: string;
  solAmount: number;        // Estimated SOL value of LP addition
  timestamp: number;
  txSignature: string;
  isDeployer: boolean;      // LP added by token deployer
  isBurned: boolean;        // LP tokens were burned (permanent commitment)
  eventType: 'LP_ADD' | 'LP_BURN';
}

export interface LiquidityScoreBonus {
  recentLpAddition: boolean;   // LP added in last 30 min
  deployerDoubledDown: boolean; // Deployer added more LP
  lpBurned: boolean;            // LP tokens burned
  bonusPoints: number;          // Total bonus to apply
  events: LiquidityEvent[];
}

// ============ CONSTANTS ============

const LP_CONFIG = {
  // Detection thresholds
  MIN_LP_ADD_USD: 2000,     // LP addition > $2K to micro-cap = significant

  // Time window
  RECENT_WINDOW_MS: 30 * 60 * 1000,  // 30 minutes

  // Scoring bonuses
  SCORE_RECENT_LP_ADD: 5,
  SCORE_DEPLOYER_LP_ADD: 8,
  SCORE_LP_BURN: 10,

  // Cache
  CACHE_TTL_MS: 5 * 60 * 1000,  // 5 minutes

  // Known LP program IDs (Raydium AMM, Orca, Meteora)
  LP_PROGRAM_IDS: new Set([
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
  ]),

  // Known LP mint/burn instruction discriminators
  // These are used to identify LP add/remove operations in transaction logs
  LP_ADD_KEYWORDS: ['addLiquidity', 'increaseLiquidity', 'deposit', 'openPosition'],
  LP_BURN_KEYWORDS: ['burn', 'burnChecked'],
} as const;

// ============ LIQUIDITY MONITOR CLASS ============

export class LiquidityMonitor {
  // Cache LP events per token
  private lpEventCache: Map<string, {
    events: LiquidityEvent[];
    expiry: number;
  }> = new Map();

  // Cache deployer addresses per token
  private deployerCache: Map<string, {
    address: string;
    expiry: number;
  }> = new Map();

  /**
   * Check for recent LP additions for a token.
   * Called during token evaluation as async enrichment.
   */
  async checkLiquidityEvents(tokenAddress: string): Promise<LiquidityEvent[]> {
    // Check cache
    const cached = this.lpEventCache.get(tokenAddress);
    if (cached && cached.expiry > Date.now()) {
      return cached.events;
    }

    if (appConfig.heliusDisabled) {
      return [];
    }

    try {
      // Use Enhanced Transactions API to get parsed transaction data
      // This gives us pre-parsed swap/LP data
      const txs = await heliusClient.getEnhancedTransactions(tokenAddress, 20);

      const events: LiquidityEvent[] = [];
      const deployerAddress = await this.getDeployerAddress(tokenAddress);

      for (const tx of txs) {
        const event = this.parseLiquidityEvent(tx, tokenAddress, deployerAddress);
        if (event) {
          events.push(event);
        }
      }

      // Also check for LP burns in recent transactions
      const recentTxs = await heliusClient.getRecentTransactions(tokenAddress, 10);
      for (const tx of recentTxs) {
        const burnEvent = this.parseBurnEvent(tx, tokenAddress);
        if (burnEvent) {
          events.push(burnEvent);
        }
      }

      // Cache
      this.lpEventCache.set(tokenAddress, {
        events,
        expiry: Date.now() + LP_CONFIG.CACHE_TTL_MS,
      });

      if (events.length > 0) {
        logger.info({
          tokenAddress,
          lpEvents: events.length,
          types: events.map(e => e.eventType),
        }, 'Liquidity events detected');
      }

      return events;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to check liquidity events');
      return [];
    }
  }

  /**
   * Calculate scoring bonus from liquidity events.
   */
  async getLiquidityScoreBonus(tokenAddress: string): Promise<LiquidityScoreBonus> {
    const events = await this.checkLiquidityEvents(tokenAddress);
    const now = Date.now();

    let recentLpAddition = false;
    let deployerDoubledDown = false;
    let lpBurned = false;
    let bonusPoints = 0;

    for (const event of events) {
      const isRecent = (now - event.timestamp) < LP_CONFIG.RECENT_WINDOW_MS;

      if (event.eventType === 'LP_ADD' && isRecent) {
        recentLpAddition = true;
        bonusPoints = Math.max(bonusPoints, LP_CONFIG.SCORE_RECENT_LP_ADD);

        if (event.isDeployer) {
          deployerDoubledDown = true;
          bonusPoints = Math.max(bonusPoints, LP_CONFIG.SCORE_DEPLOYER_LP_ADD);
        }
      }

      if (event.eventType === 'LP_BURN') {
        lpBurned = true;
        bonusPoints = Math.max(bonusPoints, LP_CONFIG.SCORE_LP_BURN);
      }
    }

    // Bonuses stack: LP add + burn = both bonuses
    if (recentLpAddition && lpBurned) {
      bonusPoints = LP_CONFIG.SCORE_RECENT_LP_ADD + LP_CONFIG.SCORE_LP_BURN;
      if (deployerDoubledDown) {
        bonusPoints = LP_CONFIG.SCORE_DEPLOYER_LP_ADD + LP_CONFIG.SCORE_LP_BURN;
      }
    }

    return {
      recentLpAddition,
      deployerDoubledDown,
      lpBurned,
      bonusPoints,
      events,
    };
  }

  /**
   * Parse a transaction for LP addition events.
   */
  private parseLiquidityEvent(
    tx: any,
    tokenAddress: string,
    deployerAddress: string | null,
  ): LiquidityEvent | null {
    try {
      if (!tx) return null;

      // Enhanced Transactions API provides parsed data
      const type = tx.type || '';
      const description = tx.description || '';

      // Check if this is a liquidity-related transaction
      const isLpAdd = LP_CONFIG.LP_ADD_KEYWORDS.some(kw =>
        type.toLowerCase().includes(kw.toLowerCase()) ||
        description.toLowerCase().includes(kw.toLowerCase())
      );

      if (!isLpAdd) return null;

      // Extract details
      const signer = tx.feePayer || tx.source;
      const timestamp = tx.timestamp ? tx.timestamp * 1000 : Date.now();
      const signature = tx.signature || '';

      // Estimate SOL amount from token transfers
      let solAmount = 0;
      if (tx.nativeTransfers) {
        for (const transfer of tx.nativeTransfers) {
          if (transfer.fromUserAccount === signer) {
            solAmount += (transfer.amount || 0) / 1e9; // lamports to SOL
          }
        }
      }

      // Skip small LP additions
      const estimatedUSD = solAmount * 150; // Rough estimate
      if (estimatedUSD < LP_CONFIG.MIN_LP_ADD_USD) return null;

      const isDeployer = deployerAddress !== null && signer === deployerAddress;

      return {
        tokenAddress,
        providerAddress: signer,
        solAmount,
        timestamp,
        txSignature: signature,
        isDeployer,
        isBurned: false,
        eventType: 'LP_ADD',
      };
    } catch {
      return null;
    }
  }

  /**
   * Parse a transaction for LP burn events.
   */
  private parseBurnEvent(tx: any, tokenAddress: string): LiquidityEvent | null {
    try {
      if (!tx || !tx.memo) return null;

      // Check if transaction logs contain burn instructions
      const memo = typeof tx.memo === 'string' ? tx.memo : '';
      const isBurn = LP_CONFIG.LP_BURN_KEYWORDS.some(kw =>
        memo.toLowerCase().includes(kw.toLowerCase())
      );

      if (!isBurn) return null;

      const timestamp = tx.blockTime ? tx.blockTime * 1000 : Date.now();

      return {
        tokenAddress,
        providerAddress: tx.feePayer || '',
        solAmount: 0,
        timestamp,
        txSignature: tx.signature || '',
        isDeployer: false,
        isBurned: true,
        eventType: 'LP_BURN',
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the deployer address for a token.
   */
  private async getDeployerAddress(tokenAddress: string): Promise<string | null> {
    // Check cache
    const cached = this.deployerCache.get(tokenAddress);
    if (cached && cached.expiry > Date.now()) {
      return cached.address;
    }

    try {
      // Get the first transaction for this token to find deployer
      const result = await pool.query(
        `SELECT deployer_address FROM token_safety_cache WHERE token_address = $1`,
        [tokenAddress]
      );

      const address = result.rows[0]?.deployer_address || null;

      this.deployerCache.set(tokenAddress, {
        address: address || '',
        expiry: Date.now() + 30 * 60 * 1000, // 30 min cache
      });

      return address;
    } catch {
      return null;
    }
  }

  /**
   * Add lp_recently_added boolean to token evaluation metadata.
   * Returns enrichment data for the scoring system.
   */
  async enrichTokenMetadata(tokenAddress: string): Promise<{
    lpRecentlyAdded: boolean;
    lpDeployerDoubledDown: boolean;
    lpBurned: boolean;
    lpBonusPoints: number;
  }> {
    const bonus = await this.getLiquidityScoreBonus(tokenAddress);
    return {
      lpRecentlyAdded: bonus.recentLpAddition,
      lpDeployerDoubledDown: bonus.deployerDoubledDown,
      lpBurned: bonus.lpBurned,
      lpBonusPoints: bonus.bonusPoints,
    };
  }

  /**
   * Format liquidity events for display.
   */
  formatLiquidityAlert(bonus: LiquidityScoreBonus): string {
    if (bonus.bonusPoints === 0) return '';

    const parts: string[] = [];

    if (bonus.lpBurned) {
      parts.push('🔥 LP burned (permanent)');
    }
    if (bonus.deployerDoubledDown) {
      parts.push('💰 Deployer added LP');
    } else if (bonus.recentLpAddition) {
      parts.push('💧 Recent LP addition');
    }

    return parts.length > 0
      ? `${parts.join(' | ')} (+${bonus.bonusPoints}pts)`
      : '';
  }
}

// ============ SINGLETON EXPORT ============

export const liquidityMonitor = new LiquidityMonitor();

export default liquidityMonitor;
