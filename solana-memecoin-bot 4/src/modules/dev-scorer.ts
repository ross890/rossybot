// ===========================================
// DEV WALLET SCORER (Layer 2 — Task C)
// Serial launcher detection & deployer analysis
// ===========================================

import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { pool } from '../utils/database.js';
import { solanaFmRateLimiter, solanaRpcRateLimiter, dexScreenerRateLimiter, TTLCache } from '../utils/rate-limiter.js';

// ============ TYPES ============

export interface DevScore {
  wallet: string;
  totalLaunches: number;
  launchesOver100k: number;
  successRatio: number;
  score: 'CLEAN' | 'CAUTION' | 'RED_FLAG' | 'NEW_DEV';
  knownTokens: Array<{
    contract: string;
    ticker: string;
    peakMc: number;
    launchedAt: string;
  }>;
  cachedAt: string;
}

// ============ CONSTANTS ============

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory cache for dev scores (backed by DB cache table)
const devScoreCache = new TTLCache<DevScore>(200);

// ============ DEV SCORER CLASS ============

class DevWalletScorer {

  /**
   * Score a deployer wallet based on their token launch history.
   * Uses SolanaFM (primary) or Solana public RPC (fallback).
   */
  async scoreDevWallet(deployerAddress: string): Promise<DevScore> {
    // 1. Check in-memory cache
    const memoryCached = devScoreCache.get(deployerAddress);
    if (memoryCached) {
      logger.debug({ wallet: deployerAddress.slice(0, 8) }, 'Dev score cache hit (memory)');
      return memoryCached;
    }

    // 2. Check database cache
    const dbCached = await this.getFromDbCache(deployerAddress);
    if (dbCached) {
      devScoreCache.set(deployerAddress, dbCached, DEV_CACHE_TTL_MS);
      return dbCached;
    }

    // 3. Fetch transaction history and score
    logger.info({ wallet: deployerAddress.slice(0, 8) }, 'Scoring dev wallet (fresh lookup)');

    let tokenCreations: Array<{ signature: string; mint: string; blockTime: number }> = [];

    // Try SolanaFM first
    try {
      tokenCreations = await this.getTokenCreationsViaSolanaFM(deployerAddress);
    } catch (error) {
      logger.debug({ error, wallet: deployerAddress.slice(0, 8) }, 'SolanaFM lookup failed, trying RPC fallback');
    }

    // Fallback to Solana public RPC
    if (tokenCreations.length === 0) {
      try {
        tokenCreations = await this.getTokenCreationsViaRPC(deployerAddress);
      } catch (error) {
        logger.debug({ error, wallet: deployerAddress.slice(0, 8) }, 'RPC fallback also failed');
      }
    }

    // 4. For each token, check if it hit $100k MC
    const knownTokens: DevScore['knownTokens'] = [];
    let launchesOver100k = 0;

    for (const creation of tokenCreations) {
      let peakMc = 0;
      let ticker = 'UNKNOWN';

      // Check our local DB first (free, fast)
      try {
        const localResult = await pool.query(
          `SELECT ticker, peak_mc FROM token_tracking WHERE contract_address = $1`,
          [creation.mint]
        );

        if (localResult.rows.length > 0) {
          peakMc = Number(localResult.rows[0].peak_mc) || 0;
          ticker = localResult.rows[0].ticker || 'UNKNOWN';
        } else {
          // Fetch from DexScreener as background task (queued at Tier 3 priority)
          const dexData = await this.getDexScreenerPeakMC(creation.mint);
          peakMc = dexData.peakMc;
          ticker = dexData.ticker;
        }
      } catch (error) {
        logger.debug({ error, mint: creation.mint.slice(0, 8) }, 'Failed to lookup token peak MC');
      }

      if (peakMc >= 100000) {
        launchesOver100k++;
      }

      knownTokens.push({
        contract: creation.mint,
        ticker,
        peakMc,
        launchedAt: new Date(creation.blockTime * 1000).toISOString(),
      });
    }

    // 5. Calculate score
    const totalLaunches = tokenCreations.length;
    const successRatio = totalLaunches > 0 ? launchesOver100k / totalLaunches : 0;

    let score: DevScore['score'];
    if (totalLaunches === 0 || totalLaunches === 1) {
      score = 'NEW_DEV';
    } else if (totalLaunches >= 5 && successRatio === 0) {
      score = 'RED_FLAG';
    } else if (totalLaunches >= 3 && successRatio < 0.25) {
      score = 'CAUTION';
    } else if (totalLaunches < 3 || successRatio > 0.5) {
      score = 'CLEAN';
    } else {
      score = 'CAUTION'; // Default to caution for ambiguous cases
    }

    const devScore: DevScore = {
      wallet: deployerAddress,
      totalLaunches,
      launchesOver100k,
      successRatio,
      score,
      knownTokens: knownTokens.slice(0, 20), // Limit stored tokens
      cachedAt: new Date().toISOString(),
    };

    // 6. Cache in memory and DB
    devScoreCache.set(deployerAddress, devScore, DEV_CACHE_TTL_MS);
    await this.saveToDbCache(devScore);

    logger.info({
      wallet: deployerAddress.slice(0, 8),
      totalLaunches,
      launchesOver100k,
      successRatio: (successRatio * 100).toFixed(1) + '%',
      score,
    }, 'Dev wallet scored');

    return devScore;
  }

  /**
   * Try to discover the deployer wallet for a given token.
   * Uses Solana public RPC getSignaturesForAddress to find the earliest
   * transaction on the mint account.
   */
  async discoverDeployer(tokenAddress: string): Promise<string | null> {
    try {
      const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
      const mintPubkey = new PublicKey(tokenAddress);

      // Get the oldest signatures for this mint
      const signatures = await solanaRpcRateLimiter.execute(
        () => connection.getSignaturesForAddress(mintPubkey, { limit: 1 }, 'confirmed'),
        `getSignaturesForAddress/${tokenAddress.slice(0, 8)}`
      );

      if (!signatures || signatures.length === 0) return null;

      // Get the oldest transaction details
      const sig = signatures[signatures.length - 1];
      const tx = await solanaRpcRateLimiter.execute(
        () => connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        }),
        `getParsedTransaction/${sig.signature.slice(0, 8)}`
      );

      if (!tx || !tx.transaction) return null;

      // The first signer is typically the deployer
      const signers = tx.transaction.message.accountKeys
        .filter((key: any) => key.signer)
        .map((key: any) => key.pubkey?.toBase58?.() || key.pubkey);

      if (signers.length > 0) {
        return signers[0];
      }

      return null;
    } catch (error) {
      logger.debug({ error, token: tokenAddress.slice(0, 8) }, 'Failed to discover deployer wallet');
      return null;
    }
  }

  /**
   * Get token creation transactions via SolanaFM API (preferred)
   */
  private async getTokenCreationsViaSolanaFM(
    deployerAddress: string
  ): Promise<Array<{ signature: string; mint: string; blockTime: number }>> {
    const creations: Array<{ signature: string; mint: string; blockTime: number }> = [];

    try {
      const response = await solanaFmRateLimiter.execute(
        () => axios.get(
          `https://api.solana.fm/v0/accounts/${deployerAddress}/transactions`,
          {
            timeout: 15000,
            params: { limit: 100 },
          }
        ),
        `/v0/accounts/${deployerAddress.slice(0, 8)}/transactions`
      );

      const transactions = response.data?.result || response.data || [];

      for (const tx of transactions) {
        // Look for token creation patterns
        const instructions = tx.instructions || tx.parsedInstructions || [];
        for (const ix of instructions) {
          const programId = ix.programId || ix.program;
          const type = ix.type || ix.parsed?.type;

          if (programId === TOKEN_PROGRAM_ID && type === 'initializeMint') {
            const mint = ix.parsed?.info?.mint || ix.accounts?.[0];
            if (mint) {
              creations.push({
                signature: tx.signature || tx.txHash,
                mint,
                blockTime: tx.blockTime || tx.timestamp || 0,
              });
            }
          }
        }
      }
    } catch (error: any) {
      const status = error?.response?.status;
      // Only throw for non-404 errors (404 = wallet not found, which is fine)
      if (status !== 404) {
        throw error;
      }
    }

    return creations;
  }

  /**
   * Get token creation transactions via Solana public RPC (fallback)
   */
  private async getTokenCreationsViaRPC(
    deployerAddress: string
  ): Promise<Array<{ signature: string; mint: string; blockTime: number }>> {
    const creations: Array<{ signature: string; mint: string; blockTime: number }> = [];

    try {
      const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
      const pubkey = new PublicKey(deployerAddress);

      // Get recent signatures
      const signatures = await solanaRpcRateLimiter.execute(
        () => connection.getSignaturesForAddress(pubkey, { limit: 50 }, 'confirmed'),
        `getSignaturesForAddress/${deployerAddress.slice(0, 8)}`
      );

      // Check each transaction for token creation
      for (const sig of signatures) {
        try {
          const tx = await solanaRpcRateLimiter.execute(
            () => connection.getParsedTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
            }),
            `getParsedTransaction/${sig.signature.slice(0, 8)}`
          );

          if (!tx || !tx.transaction) continue;

          // Look for Token Program initializeMint instructions
          for (const ix of tx.transaction.message.instructions) {
            const parsed = (ix as any).parsed;
            if (parsed && parsed.type === 'initializeMint') {
              const mint = parsed.info?.mint;
              if (mint) {
                creations.push({
                  signature: sig.signature,
                  mint,
                  blockTime: tx.blockTime || 0,
                });
              }
            }
          }
        } catch (error) {
          // Skip individual transaction errors
          logger.debug({ sig: sig.signature.slice(0, 8) }, 'Failed to parse transaction');
        }
      }
    } catch (error) {
      throw error;
    }

    return creations;
  }

  /**
   * Get peak MC for a token via DexScreener
   */
  private async getDexScreenerPeakMC(
    tokenAddress: string
  ): Promise<{ peakMc: number; ticker: string }> {
    try {
      const response = await dexScreenerRateLimiter.execute(
        () => axios.get(
          `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
          { timeout: 10000 }
        ),
        `/latest/dex/tokens/${tokenAddress.slice(0, 8)}`
      );

      const pairs = (response.data?.pairs || []).filter(
        (p: any) => p.chainId === 'solana'
      );

      if (pairs.length === 0) return { peakMc: 0, ticker: 'UNKNOWN' };

      const pair = pairs[0];
      return {
        peakMc: pair.fdv || 0,
        ticker: pair.baseToken?.symbol || 'UNKNOWN',
      };
    } catch (error) {
      return { peakMc: 0, ticker: 'UNKNOWN' };
    }
  }

  /**
   * Get cached dev score from database
   */
  private async getFromDbCache(deployerAddress: string): Promise<DevScore | null> {
    try {
      const result = await pool.query(
        `SELECT * FROM dev_wallet_cache
         WHERE deployer_wallet = $1
         AND last_updated > NOW() - INTERVAL '24 hours'`,
        [deployerAddress]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        wallet: row.deployer_wallet,
        totalLaunches: row.total_launches,
        launchesOver100k: row.launches_over_100k,
        successRatio: row.total_launches > 0 ? row.launches_over_100k / row.total_launches : 0,
        score: row.dev_score,
        knownTokens: row.known_tokens || [],
        cachedAt: row.last_updated.toISOString(),
      };
    } catch (error) {
      logger.debug({ error, wallet: deployerAddress.slice(0, 8) }, 'Failed to read dev cache from DB');
      return null;
    }
  }

  /**
   * Save dev score to database cache
   */
  private async saveToDbCache(devScore: DevScore): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO dev_wallet_cache (deployer_wallet, total_launches, launches_over_100k, known_tokens, dev_score, last_updated)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (deployer_wallet) DO UPDATE SET
           total_launches = $2,
           launches_over_100k = $3,
           known_tokens = $4,
           dev_score = $5,
           last_updated = NOW()`,
        [
          devScore.wallet,
          devScore.totalLaunches,
          devScore.launchesOver100k,
          JSON.stringify(devScore.knownTokens),
          devScore.score,
        ]
      );
    } catch (error) {
      logger.debug({ error, wallet: devScore.wallet.slice(0, 8) }, 'Failed to save dev score to DB cache');
    }
  }
}

// ============ EXPORTS ============

export const devWalletScorer = new DevWalletScorer();
