import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { query } from '../../db/database.js';
import { config } from '../../config/index.js';
import { SignalType, DetectionSource, type ParsedSignal } from '../../types/index.js';
import { detectPumpFunInteraction } from '../pumpfun/detector.js';

// SOL mint constant — used to filter out pure SOL transfers
const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}

interface TransactionResult {
  signature: string;
  slot: number;
  transaction: {
    meta: {
      err: unknown;
      fee: number;
      preBalances: number[];
      postBalances: number[];
      preTokenBalances: TokenBalanceEntry[];
      postTokenBalances: TokenBalanceEntry[];
    };
    transaction: {
      signatures: string[];
      message: {
        accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean }>;
      };
    };
    blockTime: number;
  };
}

export class TransactionParser {
  private subscribedWallets: Set<string>;

  constructor(walletAddresses: string[]) {
    this.subscribedWallets = new Set(walletAddresses);
  }

  updateWallets(addresses: string[]): void {
    this.subscribedWallets = new Set(addresses);
  }

  addWallet(address: string): void {
    this.subscribedWallets.add(address);
  }

  removeWallet(address: string): void {
    this.subscribedWallets.delete(address);
  }

  async parse(
    result: TransactionResult,
    source: DetectionSource = DetectionSource.HELIUS_WS,
  ): Promise<ParsedSignal[]> {
    const now = new Date();
    const signals: ParsedSignal[] = [];

    try {
      const tx = result.transaction;
      if (!tx || tx.meta?.err) {
        logger.debug('TX dropped: failed or missing transaction data');
        return signals;
      }

      const signature = result.signature || tx.transaction?.signatures?.[0];
      if (!signature) return signals;

      // Helius transactionNotification doesn't include blockTime — fetch via getBlockTime(slot)
      let blockTime: number;
      if (typeof tx.blockTime === 'number') {
        blockTime = tx.blockTime;
      } else {
        blockTime = await this.fetchBlockTime(result.slot) ?? Math.floor(now.getTime() / 1000);
      }
      const detectionLagMs = Math.max(0, now.getTime() - blockTime * 1000);

      // Step 1: Identify which subscribed wallet(s) are involved in this tx
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const allPubkeys = accountKeys.map((k) => k.pubkey);
      const involvedWallets = allPubkeys.filter((pk) => this.subscribedWallets.has(pk));

      if (involvedWallets.length === 0) {
        console.log(`⏭️ TX ${signature.slice(0, 12)}... | no subscribed wallet in accountKeys (indirect interaction)`);
        return signals;
      }

      // Step 2: Detect pump.fun bonding curve interaction
      const pumpFunCurve = detectPumpFunInteraction(accountKeys);
      const isPumpFun = pumpFunCurve !== null;

      // Step 3: Detect token transfers by comparing pre/post balances
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      const preMap = this.buildBalanceMap(preBalances);
      const postMap = this.buildBalanceMap(postBalances);

      // Check token balance deltas for EACH involved wallet
      for (const wallet of involvedWallets) {
        const allMints = new Set([
          ...preBalances.filter((b) => b.owner === wallet).map((b) => b.mint),
          ...postBalances.filter((b) => b.owner === wallet).map((b) => b.mint),
        ]);

        if (allMints.size === 0) continue; // No token activity for this wallet

        // SOL delta for value estimation
        const walletIdx = accountKeys.findIndex((k) => k.pubkey === wallet);
        const preSol = walletIdx >= 0 ? (tx.meta.preBalances[walletIdx] || 0) / 1e9 : 0;
        const postSol = walletIdx >= 0 ? (tx.meta.postBalances[walletIdx] || 0) / 1e9 : 0;
        const solDelta = postSol - preSol;

        for (const mint of allMints) {
          if (mint === SOL_MINT) continue; // Skip wrapped SOL

          const key = `${wallet}:${mint}`;
          const preAmount = preMap.get(key) || 0;
          const postAmount = postMap.get(key) || 0;
          const delta = postAmount - preAmount;

          if (Math.abs(delta) < 0.000001) continue; // Ignore dust

          const type = delta > 0 ? SignalType.BUY : SignalType.SELL;

          const signal: ParsedSignal = {
            walletAddress: wallet,
            txSignature: signature,
            blockTime,
            type,
            tokenMint: mint,
            tokenAmount: Math.abs(delta),
            solDelta,
            detectedAt: now,
            detectionLagMs,
            detectionSource: isPumpFun ? DetectionSource.PUMPFUN_CURVE : source,
            isPumpFun,
            ...(isPumpFun && pumpFunCurve ? {
              pumpFunData: {
                bondingCurveAddress: pumpFunCurve,
                solSpent: Math.abs(solDelta),
              },
            } : {}),
          };

          signals.push(signal);
          await this.logTransaction(signal);
        }
      }

      if (signals.length > 0) {
        logger.info({
          wallets: involvedWallets.map((w) => w.slice(0, 8)),
          signals: signals.map((s) => ({
            type: s.type,
            mint: s.tokenMint.slice(0, 8),
            amount: s.tokenAmount.toFixed(2),
            lagMs: s.detectionLagMs,
          })),
        }, 'Parsed transaction signals');
      } else if (involvedWallets.length > 0) {
        console.log(`⏭️ TX ${signature.slice(0, 12)}... | wallet ${involvedWallets[0].slice(0, 8)} | no token transfers (SOL-only or program interaction)`);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to parse transaction');
    }

    return signals;
  }

  /**
   * Parse sell percentage: how much of holdings the wallet sold
   */
  parseSellPercentage(result: TransactionResult, walletAddress: string, tokenMint: string): number {
    try {
      const tx = result.transaction;
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];

      const preEntry = preBalances.find((b) => b.owner === walletAddress && b.mint === tokenMint);
      const postEntry = postBalances.find((b) => b.owner === walletAddress && b.mint === tokenMint);

      const preAmount = preEntry ? parseFloat(preEntry.uiTokenAmount.uiAmountString) : 0;
      const postAmount = postEntry ? parseFloat(postEntry.uiTokenAmount.uiAmountString) : 0;

      if (preAmount <= 0) return 0;
      const sold = preAmount - postAmount;
      return Math.min(sold / preAmount, 1);
    } catch {
      return 0;
    }
  }

  /** Fetch block time for a slot via Helius RPC (cached per slot) */
  private blockTimeCache = new Map<number, number>();

  private async fetchBlockTime(slot: number): Promise<number | null> {
    const cached = this.blockTimeCache.get(slot);
    if (cached) return cached;

    try {
      const resp = await axios.post(config.helius.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getBlockTime',
        params: [slot],
      }, { timeout: 3000 });

      const result = resp.data?.result;
      if (typeof result === 'number') {
        this.blockTimeCache.set(slot, result);
        // Keep cache small — evict old entries
        if (this.blockTimeCache.size > 100) {
          const firstKey = this.blockTimeCache.keys().next().value;
          if (firstKey !== undefined) this.blockTimeCache.delete(firstKey);
        }
        return result;
      }
    } catch {
      // Silent — fall back to Date.now()
    }
    return null;
  }

  private buildBalanceMap(balances: TokenBalanceEntry[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const b of balances) {
      const key = `${b.owner}:${b.mint}`;
      const amount = parseFloat(b.uiTokenAmount.uiAmountString || '0');
      map.set(key, amount);
    }
    return map;
  }

  private async logTransaction(signal: ParsedSignal): Promise<void> {
    try {
      await query(
        `INSERT INTO wallet_transactions (wallet_address, tx_signature, block_time, detected_at, detection_lag_ms, type, token_mint, amount, estimated_sol_value, raw_tx)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tx_signature) DO NOTHING`,
        [
          signal.walletAddress,
          signal.txSignature,
          new Date(signal.blockTime * 1000),
          signal.detectedAt,
          signal.detectionLagMs,
          signal.type,
          signal.tokenMint,
          signal.tokenAmount,
          Math.abs(signal.solDelta),
          JSON.stringify({}), // Store raw_tx as empty for now, full tx is large
        ],
      );
    } catch (err) {
      logger.error({ err, sig: signal.txSignature }, 'Failed to log transaction');
    }
  }
}
