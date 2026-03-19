import axios from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getMany } from '../../db/database.js';

const PUMP_FUN_PROGRAM = config.pumpFun.programId;

export interface EarlyBuyer {
  walletAddress: string;
  txSignature: string;
  buyTime: Date;
  estimatedSolSpent: number;
  isKnownAlpha: boolean;
  alphaWalletLabel: string | null;
}

/**
 * For a graduated token, find all wallets that bought during the bonding curve phase.
 *
 * Uses Helius getSignaturesForAddress on the bonding curve PDA, then parses
 * each transaction to extract buyer wallets and SOL amounts.
 */
export async function findEarlyBuyers(tokenMint: string, graduationTimeMs: number): Promise<EarlyBuyer[]> {
  const buyers: Map<string, EarlyBuyer> = new Map();

  try {
    // Step 1: Get transaction signatures for this token from Helius
    // We look at the token mint's transaction history before graduation
    const sigs = await getTokenSignatures(tokenMint, 200);
    if (sigs.length === 0) return [];

    // Step 2: Parse each transaction to find buys
    const parsedBuyers = await parseBuyTransactions(sigs, tokenMint, graduationTimeMs);

    // Step 3: Cross-reference with known alpha wallets
    const knownAlphas = await getKnownAlphaWallets();

    for (const buyer of parsedBuyers) {
      if (buyers.has(buyer.walletAddress)) continue;

      const alpha = knownAlphas.get(buyer.walletAddress);
      buyers.set(buyer.walletAddress, {
        ...buyer,
        isKnownAlpha: !!alpha,
        alphaWalletLabel: alpha?.label || null,
      });
    }
  } catch (err) {
    logger.error({ err, mint: tokenMint.slice(0, 8) }, 'Failed to analyze early buyers');
  }

  return Array.from(buyers.values());
}

/**
 * Get transaction signatures for a token mint using Helius RPC.
 */
async function getTokenSignatures(
  tokenMint: string,
  limit: number,
): Promise<Array<{ signature: string; blockTime: number }>> {
  try {
    const resp = await axios.post(config.helius.rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [tokenMint, { limit }],
    }, { timeout: 15_000 });

    const sigs = resp.data?.result || [];
    return sigs
      .filter((s: { err: unknown }) => !s.err)
      .map((s: { signature: string; blockTime: number }) => ({
        signature: s.signature,
        blockTime: s.blockTime,
      }));
  } catch (err) {
    logger.error({ err, mint: tokenMint.slice(0, 8) }, 'Failed to get token signatures');
    return [];
  }
}

/**
 * Parse buy transactions from signature list.
 * Identifies wallets that interacted with the pump.fun program before graduation.
 */
async function parseBuyTransactions(
  sigs: Array<{ signature: string; blockTime: number }>,
  tokenMint: string,
  graduationTimeMs: number,
): Promise<Array<{ walletAddress: string; txSignature: string; buyTime: Date; estimatedSolSpent: number }>> {
  const buyers: Array<{ walletAddress: string; txSignature: string; buyTime: Date; estimatedSolSpent: number }> = [];

  // Filter to pre-graduation transactions
  const preGradSigs = sigs.filter((s) => {
    const txTimeMs = s.blockTime * 1000;
    return txTimeMs < graduationTimeMs;
  });

  // Process in batches to respect rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < Math.min(preGradSigs.length, 100); i += BATCH_SIZE) {
    const batch = preGradSigs.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map((s) => parseTransaction(s.signature)),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status !== 'fulfilled' || !result.value) continue;

      const tx = result.value;
      const sig = batch[j];

      // Check if this transaction interacts with pump.fun program
      const isPumpFunTx = tx.accountKeys.some((k: string) => k === PUMP_FUN_PROGRAM);
      if (!isPumpFunTx) continue;

      // Find the buyer wallet (first signer that isn't a program)
      const buyerWallet = findBuyerWallet(tx);
      if (!buyerWallet) continue;

      // Estimate SOL spent from balance changes
      const solSpent = estimateSolSpent(tx, buyerWallet);
      if (solSpent <= 0) continue; // Not a buy (could be a sell or other interaction)

      buyers.push({
        walletAddress: buyerWallet,
        txSignature: sig.signature,
        buyTime: new Date(sig.blockTime * 1000),
        estimatedSolSpent: solSpent,
      });
    }

    // Rate limit between batches
    if (i + BATCH_SIZE < preGradSigs.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return buyers;
}

interface ParsedTx {
  accountKeys: string[];
  signers: string[];
  preBalances: number[];
  postBalances: number[];
}

async function parseTransaction(signature: string): Promise<ParsedTx | null> {
  try {
    const resp = await axios.post(config.helius.rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    }, { timeout: 10_000 });

    const tx = resp.data?.result;
    if (!tx) return null;

    const message = tx.transaction?.message;
    const meta = tx.meta;

    const accountKeys = (message?.accountKeys || []).map((k: { pubkey: string } | string) =>
      typeof k === 'string' ? k : k.pubkey,
    );

    const signers = (message?.accountKeys || [])
      .filter((k: { signer?: boolean }) => typeof k === 'object' && k.signer)
      .map((k: { pubkey: string }) => k.pubkey);

    return {
      accountKeys,
      signers,
      preBalances: meta?.preBalances || [],
      postBalances: meta?.postBalances || [],
    };
  } catch {
    return null;
  }
}

const KNOWN_PROGRAMS = new Set([
  PUMP_FUN_PROGRAM,
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '11111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'ComputeBudget111111111111111111111111111111',
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
]);

function findBuyerWallet(tx: ParsedTx): string | null {
  // The buyer is typically the first signer that isn't a known program
  for (const signer of tx.signers) {
    if (!KNOWN_PROGRAMS.has(signer)) return signer;
  }
  return null;
}

function estimateSolSpent(tx: ParsedTx, buyerWallet: string): number {
  const idx = tx.accountKeys.indexOf(buyerWallet);
  if (idx === -1) return 0;

  const pre = tx.preBalances[idx] || 0;
  const post = tx.postBalances[idx] || 0;

  // Buyer's balance decreases when buying (SOL → token)
  const deltaLamports = pre - post;
  const deltaSol = deltaLamports / 1e9;

  // Only count as a buy if the wallet spent more than tx fees (~0.005 SOL)
  return deltaSol > 0.01 ? deltaSol : 0;
}

/**
 * Load known alpha wallets from the database for cross-referencing.
 */
async function getKnownAlphaWallets(): Promise<Map<string, { address: string; label: string }>> {
  try {
    const rows = await getMany<{ address: string; label: string }>(
      `SELECT address, label FROM alpha_wallets WHERE active = TRUE`,
    );
    const map = new Map<string, { address: string; label: string }>();
    for (const row of rows) {
      map.set(row.address, row);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Alternative: Use Helius Enhanced Transactions API for richer parsed data.
 * This gives us structured token transfer data without manual parsing.
 */
export async function findEarlyBuyersEnhanced(tokenMint: string, graduationTimeMs: number): Promise<EarlyBuyer[]> {
  const buyers: Map<string, EarlyBuyer> = new Map();

  try {
    // Helius Enhanced Transaction History for the token mint
    const url = `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${config.helius.apiKey}&type=SWAP&limit=100`;
    const resp = await axios.get(url, { timeout: 15_000 });
    const txns = resp.data || [];

    const knownAlphas = await getKnownAlphaWallets();

    for (const tx of txns) {
      // Only pre-graduation transactions
      const txTimeMs = (tx.timestamp || 0) * 1000;
      if (txTimeMs >= graduationTimeMs || txTimeMs === 0) continue;

      // Extract the buyer (feePayer is typically the buyer)
      const wallet = tx.feePayer;
      if (!wallet || buyers.has(wallet) || KNOWN_PROGRAMS.has(wallet)) continue;

      // Look for SOL transfer out (buyer spending SOL)
      let solSpent = 0;
      for (const transfer of tx.nativeTransfers || []) {
        if (transfer.fromUserAccount === wallet) {
          solSpent += (transfer.amount || 0) / 1e9;
        }
      }

      if (solSpent < 0.01) continue;

      const alpha = knownAlphas.get(wallet);
      buyers.set(wallet, {
        walletAddress: wallet,
        txSignature: tx.signature || '',
        buyTime: new Date(txTimeMs),
        estimatedSolSpent: solSpent,
        isKnownAlpha: !!alpha,
        alphaWalletLabel: alpha?.label || null,
      });
    }
  } catch (err) {
    logger.warn({ err, mint: tokenMint.slice(0, 8) }, 'Enhanced API failed, falling back to standard');
    // Fall back to standard method
    return findEarlyBuyers(tokenMint, graduationTimeMs);
  }

  return Array.from(buyers.values());
}
