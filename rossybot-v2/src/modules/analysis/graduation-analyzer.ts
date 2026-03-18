import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { query, getMany, getOne } from '../../db/database.js';
import { config } from '../../config/index.js';
import { WalletSource, WalletTier } from '../../types/index.js';

/**
 * Graduation Analyzer — retroanalyzes pump.fun tokens that graduated to find
 * wallets that consistently buy early on winners.
 *
 * Pipeline:
 * 1. Fetch recently graduated tokens from pump.fun API
 * 2. For each graduated token, find early buyers via Helius RPC
 * 3. Score wallets by how many graduated tokens they bought early
 * 4. Promote wallets with 3+ graduated token hits to alpha_wallets
 *
 * Runs as a periodic batch job (daily or on-demand).
 */

interface GraduatedToken {
  mint: string;
  name: string;
  symbol: string;
  marketCapSol: number;
  createdAt: number; // unix ms
  graduatedAt?: number;
}

interface EarlyBuyer {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  buyTimestamp: number;
  txSignature: string;
}

interface WalletScore {
  address: string;
  graduatedTokensBought: number;
  tokens: string[]; // token symbols for logging
  earliestBuyAvgPct: number; // avg % into curve when they bought
}

// Pump.fun program IDs for identifying buy transactions
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_FUN_PROGRAM_V2 = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export class GraduationAnalyzer {
  private isRunning = false;

  // Rate limiting for Helius RPC
  private static readonly RPC_DELAY_MS = 200; // 200ms between RPC calls
  private static readonly MAX_TOKENS_PER_RUN = 200; // Process up to 200 tokens per run
  private static readonly MIN_GRADUATIONS_FOR_PROMOTION = 3; // Need 3+ graduated token hits
  private static readonly MIN_WIN_RATE_FOR_PROMOTION = 0.40; // 40% of observed tokens must have graduated
  private static readonly EARLY_BUYER_LIMIT = 50; // Top 50 earliest transactions per token

  /**
   * Run a full graduation analysis cycle.
   * Fetches graduated tokens, finds early buyers, scores and promotes wallets.
   */
  async runAnalysis(): Promise<{ tokensAnalyzed: number; walletsFound: number; walletsPromoted: number }> {
    if (this.isRunning) {
      logger.warn('Graduation analysis already running — skipping');
      return { tokensAnalyzed: 0, walletsFound: 0, walletsPromoted: 0 };
    }

    this.isRunning = true;
    const start = Date.now();

    try {
      // Step 1: Fetch graduated tokens from pump.fun
      logger.info('Graduation analysis: fetching graduated tokens...');
      const graduatedTokens = await this.fetchGraduatedTokens();
      logger.info({ count: graduatedTokens.length }, 'Graduation analysis: tokens fetched');

      if (graduatedTokens.length === 0) {
        return { tokensAnalyzed: 0, walletsFound: 0, walletsPromoted: 0 };
      }

      // Step 2: Find early buyers for each token
      const allBuyers: EarlyBuyer[] = [];
      let tokensAnalyzed = 0;

      for (const token of graduatedTokens.slice(0, GraduationAnalyzer.MAX_TOKENS_PER_RUN)) {
        try {
          // Check if we already analyzed this token
          const existing = await getOne<{ mint: string }>(
            `SELECT mint FROM graduated_tokens WHERE mint = $1`,
            [token.mint],
          );
          if (existing) continue;

          const buyers = await this.findEarlyBuyers(token);
          allBuyers.push(...buyers);
          tokensAnalyzed++;

          // Record token as analyzed
          await query(
            `INSERT INTO graduated_tokens (mint, symbol, name, market_cap_sol, created_at, analyzed_at, early_buyers_found)
             VALUES ($1, $2, $3, $4, $5, NOW(), $6)
             ON CONFLICT (mint) DO NOTHING`,
            [token.mint, token.symbol, token.name, token.marketCapSol, new Date(token.createdAt), buyers.length],
          );

          // Rate limit
          await new Promise((r) => setTimeout(r, GraduationAnalyzer.RPC_DELAY_MS));

          // Progress log every 25 tokens
          if (tokensAnalyzed % 25 === 0) {
            logger.info({ analyzed: tokensAnalyzed, total: graduatedTokens.length, buyers: allBuyers.length },
              'Graduation analysis progress');
          }
        } catch (err) {
          logger.debug({ err, token: token.symbol }, 'Failed to analyze graduated token');
        }
      }

      // Step 3: Score wallets by graduation count
      const walletMap = new Map<string, WalletScore>();
      for (const buyer of allBuyers) {
        const existing = walletMap.get(buyer.walletAddress) || {
          address: buyer.walletAddress,
          graduatedTokensBought: 0,
          tokens: [],
          earliestBuyAvgPct: 0,
        };
        existing.graduatedTokensBought++;
        existing.tokens.push(buyer.tokenMint.slice(0, 6));
        walletMap.set(buyer.walletAddress, existing);
      }

      // Step 4: Promote wallets with enough graduated token hits
      let walletsPromoted = 0;
      const sortedWallets = Array.from(walletMap.values())
        .filter((w) => w.graduatedTokensBought >= GraduationAnalyzer.MIN_GRADUATIONS_FOR_PROMOTION)
        .sort((a, b) => b.graduatedTokensBought - a.graduatedTokensBought);

      for (const wallet of sortedWallets.slice(0, 50)) { // Promote top 50
        const promoted = await this.promoteWallet(wallet);
        if (promoted) walletsPromoted++;
      }

      const duration = Date.now() - start;
      logger.info({
        tokensAnalyzed,
        totalBuyers: allBuyers.length,
        uniqueWallets: walletMap.size,
        qualified: sortedWallets.length,
        promoted: walletsPromoted,
        durationMs: duration,
      }, 'Graduation analysis complete');

      // Log to discovery table
      await query(
        `INSERT INTO wallet_discovery_log (tokens_screened, wallets_evaluated, wallets_added, wallets_removed, details)
         VALUES ($1, $2, $3, 0, $4)`,
        [tokensAnalyzed, walletMap.size, walletsPromoted,
         JSON.stringify({ type: 'graduation_analysis', qualified: sortedWallets.length, durationMs: duration })],
      ).catch(() => {});

      return { tokensAnalyzed, walletsFound: walletMap.size, walletsPromoted };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Fetch graduated tokens from pump.fun API.
   * Uses the public frontend API to get tokens that completed bonding curve.
   */
  private async fetchGraduatedTokens(): Promise<GraduatedToken[]> {
    const tokens: GraduatedToken[] = [];
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    // Pump.fun API: fetch completed (graduated) tokens, sorted by market cap
    // Paginate to get a meaningful sample
    for (let offset = 0; offset < 1000; offset += 50) {
      try {
        const resp = await axios.get('https://frontend-api-v2.pump.fun/coins', {
          params: {
            offset,
            limit: 50,
            sort: 'market_cap',
            order: 'DESC',
            completed: true,
            includeNsfw: false,
          },
          timeout: 10_000,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json',
          },
        });

        const coins = resp.data;
        if (!Array.isArray(coins) || coins.length === 0) break;

        for (const coin of coins) {
          const createdAt = new Date(coin.created_timestamp || coin.created_at).getTime();
          if (createdAt < thirtyDaysAgo) continue; // Skip tokens older than 30 days

          tokens.push({
            mint: coin.mint,
            name: coin.name || '',
            symbol: coin.symbol || '',
            marketCapSol: coin.market_cap_sol || coin.market_cap || 0,
            createdAt,
          });
        }

        // Rate limit API calls
        await new Promise((r) => setTimeout(r, 500));

        // If all tokens on this page are older than 30 days, stop
        const oldestOnPage = coins[coins.length - 1];
        const oldestCreatedAt = new Date(oldestOnPage?.created_timestamp || oldestOnPage?.created_at || 0).getTime();
        if (oldestCreatedAt < thirtyDaysAgo) break;
      } catch (err: unknown) {
        const axErr = err as { response?: { status?: number }; message?: string };
        logger.warn({ status: axErr.response?.status, err: axErr.message, offset },
          'Failed to fetch graduated tokens page');
        break;
      }
    }

    logger.info({ count: tokens.length }, 'Graduated tokens fetched from pump.fun API');
    return tokens;
  }

  /**
   * Find early buyers of a graduated token by scanning its bonding curve transactions.
   * Uses Helius RPC to get transaction history.
   */
  private async findEarlyBuyers(token: GraduatedToken): Promise<EarlyBuyer[]> {
    const buyers: EarlyBuyer[] = [];

    try {
      // Get the earliest transactions for this token's mint
      // We look at the token's transaction history to find early buyers
      const resp = await axios.post(config.helius.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [token.mint, {
          limit: GraduationAnalyzer.EARLY_BUYER_LIMIT,
        }],
      }, { timeout: 10_000 });

      const signatures = resp.data?.result;
      if (!Array.isArray(signatures) || signatures.length === 0) return buyers;

      // Sort by blockTime ascending to get earliest transactions
      signatures.sort((a: { blockTime: number }, b: { blockTime: number }) =>
        (a.blockTime || 0) - (b.blockTime || 0));

      // Parse each transaction to find buyers
      // Process in batches of 5 to avoid rate limits
      for (let i = 0; i < signatures.length; i += 5) {
        const batch = signatures.slice(i, i + 5);

        for (const sig of batch) {
          if (sig.err) continue; // Skip failed transactions

          try {
            const txResp = await axios.post(config.helius.rpcUrl, {
              jsonrpc: '2.0',
              id: 1,
              method: 'getTransaction',
              params: [sig.signature, {
                encoding: 'jsonParsed',
                maxSupportedTransactionVersion: 0,
              }],
            }, { timeout: 10_000 });

            const tx = txResp.data?.result;
            if (!tx) continue;

            // Check if this is a pump.fun buy transaction
            const buyer = this.extractBuyerFromTx(tx, token.mint);
            if (buyer) {
              buyers.push({
                walletAddress: buyer,
                tokenMint: token.mint,
                tokenSymbol: token.symbol,
                buyTimestamp: sig.blockTime * 1000,
                txSignature: sig.signature,
              });
            }
          } catch {
            // Skip individual tx parsing errors
          }
        }

        // Rate limit between batches
        if (i + 5 < signatures.length) {
          await new Promise((r) => setTimeout(r, GraduationAnalyzer.RPC_DELAY_MS));
        }
      }
    } catch (err) {
      logger.debug({ err, token: token.symbol }, 'Failed to find early buyers');
    }

    return buyers;
  }

  /**
   * Extract the buyer wallet from a parsed pump.fun transaction.
   * Returns the buyer address if this is a buy, null otherwise.
   */
  private extractBuyerFromTx(tx: Record<string, unknown>, tokenMint: string): string | null {
    try {
      const meta = tx.meta as Record<string, unknown>;
      const transaction = tx.transaction as Record<string, unknown>;
      if (!meta || !transaction) return null;

      const message = transaction.message as Record<string, unknown>;
      if (!message) return null;

      const accountKeys = message.accountKeys as Array<{ pubkey: string }>;
      if (!accountKeys?.length) return null;

      // Check if pump.fun program is involved
      const hasPumpFun = accountKeys.some(
        (k) => k.pubkey === PUMP_FUN_PROGRAM || k.pubkey === PUMP_FUN_PROGRAM_V2,
      );
      if (!hasPumpFun) return null;

      // Check token balance changes to identify buyers
      const postTokenBalances = meta.postTokenBalances as Array<{
        mint: string;
        owner: string;
        uiTokenAmount: { uiAmount: number };
      }>;
      const preTokenBalances = meta.preTokenBalances as Array<{
        mint: string;
        owner: string;
        uiTokenAmount: { uiAmount: number };
      }>;

      if (!postTokenBalances) return null;

      // Find accounts that received this token (buyers)
      for (const post of postTokenBalances) {
        if (post.mint !== tokenMint) continue;
        const postAmount = post.uiTokenAmount?.uiAmount || 0;
        if (postAmount <= 0) continue;

        // Check if this is a new balance (buy) vs existing (not a buy)
        const preBalance = preTokenBalances?.find(
          (pre) => pre.mint === tokenMint && pre.owner === post.owner,
        );
        const preAmount = preBalance?.uiTokenAmount?.uiAmount || 0;

        if (postAmount > preAmount) {
          // This account received tokens — it's a buyer
          // Exclude program accounts and known non-wallets
          const owner = post.owner;
          if (owner === PUMP_FUN_PROGRAM || owner === PUMP_FUN_PROGRAM_V2) continue;
          if (owner === tokenMint) continue; // Skip token mint itself

          return owner;
        }
      }
    } catch {
      // Malformed transaction — skip
    }
    return null;
  }

  /**
   * Promote a wallet to alpha_wallets if it has enough graduated token hits.
   */
  private async promoteWallet(wallet: WalletScore): Promise<boolean> {
    try {
      // Check if already in alpha_wallets
      const existing = await getOne<{ address: string; active: boolean; source: string }>(
        `SELECT address, active, source FROM alpha_wallets WHERE address = $1`,
        [wallet.address],
      );

      if (existing) {
        // Already tracked — update graduation count if not already a seed
        if (existing.source !== 'GRADUATION_SEED') {
          await query(
            `UPDATE alpha_wallets SET
               last_validated_at = NOW()
             WHERE address = $1`,
            [wallet.address],
          );
        }
        return false;
      }

      // New wallet — insert
      const label = `grad_disc_${wallet.address.slice(0, 6)}_${wallet.graduatedTokensBought}hits`;
      await query(
        `INSERT INTO alpha_wallets (address, label, source, tier, active, helius_subscribed, pumpfun_only)
         VALUES ($1, $2, $3, $4, TRUE, FALSE, TRUE)
         ON CONFLICT (address) DO NOTHING`,
        [wallet.address, label, WalletSource.GRADUATION_DISCOVERY, WalletTier.B],
      );

      logger.info({
        address: wallet.address.slice(0, 8),
        graduatedTokens: wallet.graduatedTokensBought,
        tokens: wallet.tokens.slice(0, 5).join(', '),
      }, 'Graduation analysis: NEW alpha wallet discovered');

      return true;
    } catch (err) {
      logger.error({ err, address: wallet.address.slice(0, 8) }, 'Failed to promote graduation wallet');
      return false;
    }
  }

  /**
   * Analyze confluence between a set of known wallets.
   * Finds tokens that multiple wallets bought, and identifies which wallets
   * have the highest overlap (buy the same tokens).
   */
  async analyzeWalletConfluence(walletAddresses: string[]): Promise<{
    sharedTokens: Array<{ mint: string; wallets: string[]; count: number }>;
    walletPairs: Array<{ wallet1: string; wallet2: string; sharedCount: number }>;
  }> {
    logger.info({ wallets: walletAddresses.length }, 'Analyzing wallet confluence...');

    // For each wallet, get their recent token trades via Helius
    const walletTokens = new Map<string, Set<string>>();

    for (const wallet of walletAddresses) {
      try {
        const resp = await axios.post(config.helius.rpcUrl, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [wallet, { limit: 100 }],
        }, { timeout: 10_000 });

        const signatures = resp.data?.result;
        if (!Array.isArray(signatures)) continue;

        const tokens = new Set<string>();

        // Parse a sample of recent transactions to find tokens traded
        for (const sig of signatures.slice(0, 20)) {
          if (sig.err) continue;
          try {
            const txResp = await axios.post(config.helius.rpcUrl, {
              jsonrpc: '2.0',
              id: 1,
              method: 'getTransaction',
              params: [sig.signature, {
                encoding: 'jsonParsed',
                maxSupportedTransactionVersion: 0,
              }],
            }, { timeout: 10_000 });

            const tx = txResp.data?.result;
            if (!tx?.meta?.postTokenBalances) continue;

            const postBalances = tx.meta.postTokenBalances as Array<{ mint: string; owner: string }>;
            for (const balance of postBalances) {
              if (balance.owner === wallet) {
                tokens.add(balance.mint);
              }
            }
          } catch {
            // Skip individual tx errors
          }
        }

        walletTokens.set(wallet, tokens);
        await new Promise((r) => setTimeout(r, GraduationAnalyzer.RPC_DELAY_MS));
      } catch (err) {
        logger.debug({ err, wallet: wallet.slice(0, 8) }, 'Failed to get wallet tokens');
      }
    }

    // Find shared tokens (tokens bought by 2+ wallets)
    const tokenWalletMap = new Map<string, string[]>();
    for (const [wallet, tokens] of walletTokens) {
      for (const token of tokens) {
        const existing = tokenWalletMap.get(token) || [];
        existing.push(wallet);
        tokenWalletMap.set(token, existing);
      }
    }

    const sharedTokens = Array.from(tokenWalletMap.entries())
      .filter(([, wallets]) => wallets.length >= 2)
      .map(([mint, wallets]) => ({ mint, wallets, count: wallets.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    // Find wallet pairs with highest overlap
    const pairMap = new Map<string, number>();
    for (const [, wallets] of tokenWalletMap) {
      if (wallets.length < 2) continue;
      for (let i = 0; i < wallets.length; i++) {
        for (let j = i + 1; j < wallets.length; j++) {
          const key = [wallets[i], wallets[j]].sort().join('|');
          pairMap.set(key, (pairMap.get(key) || 0) + 1);
        }
      }
    }

    const walletPairs = Array.from(pairMap.entries())
      .map(([key, count]) => {
        const [wallet1, wallet2] = key.split('|');
        return { wallet1, wallet2, sharedCount: count };
      })
      .sort((a, b) => b.sharedCount - a.sharedCount)
      .slice(0, 25);

    logger.info({
      sharedTokens: sharedTokens.length,
      walletPairs: walletPairs.length,
      topPairOverlap: walletPairs[0]?.sharedCount || 0,
    }, 'Wallet confluence analysis complete');

    return { sharedTokens, walletPairs };
  }
}
