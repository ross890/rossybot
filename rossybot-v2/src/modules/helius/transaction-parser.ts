import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { query } from '../../db/database.js';
import { config } from '../../config/index.js';
import { SignalType, DetectionSource, type ParsedSignal } from '../../types/index.js';
import { detectPumpFunInteraction } from '../pumpfun/detector.js';

// SOL mint constant — used to filter out pure SOL transfers
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_FUN_PROGRAM = config.pumpFun.programId;

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
  // Per-wallet noise tracking: suppress repeated no-signal log spam
  private walletSkipCounts: Map<string, number> = new Map();
  private walletLastSkipLog: Map<string, number> = new Map();
  private walletSignalCounts: Map<string, number> = new Map();
  private static readonly SKIP_LOG_INTERVAL_MS = 60_000; // Log skipped TXs at most once per 60s per wallet

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

  /** Get per-wallet noise stats: how many TXs were skipped vs. produced signals */
  getWalletNoiseStats(): Array<{ wallet: string; skipped: number; signals: number; ratio: number }> {
    const stats: Array<{ wallet: string; skipped: number; signals: number; ratio: number }> = [];
    const allWallets = new Set([...this.walletSkipCounts.keys(), ...this.walletSignalCounts.keys()]);
    for (const wallet of allWallets) {
      const skipped = this.walletSkipCounts.get(wallet) || 0;
      const signals = this.walletSignalCounts.get(wallet) || 0;
      const total = skipped + signals;
      stats.push({
        wallet: wallet.slice(0, 8),
        skipped,
        signals,
        ratio: total > 0 ? signals / total : 0,
      });
    }
    return stats.sort((a, b) => a.ratio - b.ratio); // Noisiest first
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

      if (isPumpFun) {
        logger.info({
          sig: signature.slice(0, 12),
          wallets: involvedWallets.map((w) => w.slice(0, 8)),
          curve: pumpFunCurve?.slice(0, 12),
          preTokenBalances: (tx.meta.preTokenBalances || []).length,
          postTokenBalances: (tx.meta.postTokenBalances || []).length,
          tokenOwners: [...new Set([
            ...(tx.meta.preTokenBalances || []).map((b: TokenBalanceEntry) => `${b.owner?.slice(0, 8)}(idx${b.accountIndex})`),
            ...(tx.meta.postTokenBalances || []).map((b: TokenBalanceEntry) => `${b.owner?.slice(0, 8)}(idx${b.accountIndex})`),
          ])],
        }, 'Pump.fun interaction detected in TX');
      }

      // Step 3: Detect token transfers by comparing pre/post balances
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      const preMap = this.buildBalanceMap(preBalances);
      const postMap = this.buildBalanceMap(postBalances);

      // Build a set of accountKey indices that belong to each subscribed wallet.
      // For Token2022, the `owner` field in token balances may not match the wallet pubkey,
      // so we also resolve ownership via accountIndex → accountKeys mapping.
      const walletAccountIndices = new Map<string, Set<number>>();
      for (const wallet of involvedWallets) {
        const indices = new Set<number>();
        accountKeys.forEach((k, idx) => {
          if (k.pubkey === wallet) indices.add(idx);
        });
        walletAccountIndices.set(wallet, indices);
      }

      // Check token balance deltas for EACH involved wallet
      for (const wallet of involvedWallets) {
        const walletIndices = walletAccountIndices.get(wallet)!;

        // Match by owner (standard SPL tokens) OR by accountIndex (Token2022)
        const matchesWallet = (b: TokenBalanceEntry) =>
          b.owner === wallet || walletIndices.has(b.accountIndex);

        const allMints = new Set([
          ...preBalances.filter(matchesWallet).map((b) => b.mint),
          ...postBalances.filter(matchesWallet).map((b) => b.mint),
        ]);

        // Pump.fun Token2022 fallback: if no token balance matches the wallet by owner,
        // but this IS a pump.fun TX with token balance changes, infer the trade from SOL delta.
        // The signer wallet spent/received SOL, and the token mint is in the balance entries.
        if (allMints.size === 0 && isPumpFun) {
          // Gather ALL token mints from the TX (not just this wallet's)
          const allTxMints = new Set([
            ...preBalances.map((b) => b.mint),
            ...postBalances.map((b) => b.mint),
          ]);
          // Remove SOL mint and find the actual token being traded
          allTxMints.delete(SOL_MINT);

          const walletIdx = accountKeys.findIndex((k) => k.pubkey === wallet);
          const preSol = walletIdx >= 0 ? (tx.meta.preBalances[walletIdx] || 0) / 1e9 : 0;
          const postSol = walletIdx >= 0 ? (tx.meta.postBalances[walletIdx] || 0) / 1e9 : 0;
          const solDelta = postSol - preSol;

          logger.debug({
            sig: signature.slice(0, 12),
            wallet: wallet.slice(0, 8),
            preTokenBalanceCount: preBalances.length,
            postTokenBalanceCount: postBalances.length,
            txMints: allTxMints.size,
            solDelta: solDelta.toFixed(6),
            walletIdx,
          }, 'Pump.fun fallback: checking SOL delta for Token2022 signal');

          if (allTxMints.size > 0 || (Math.abs(solDelta) > 0.1 && preBalances.length === 0 && postBalances.length === 0)) {
            // Token2022 TXs may have completely empty token balances in RPC response.
            // If SOL delta is significant and we know it's pump.fun, still generate a signal.
            // Require >0.1 SOL delta for empty-balance fallback to avoid false positives
            // from DeFi interactions that merely mention the pump.fun program.

            // Only generate signal if there's a meaningful SOL change (not just fees)
            if (Math.abs(solDelta) > 0.005) {
              const type = solDelta < 0 ? SignalType.BUY : SignalType.SELL;

              // Resolve token mint: from token balances if available, otherwise try to extract
              // from the transaction's account keys (writable non-signers that aren't the program or curve)
              let mint = allTxMints.size > 0 ? allTxMints.values().next().value! : null;
              if (!mint) {
                // Token2022 pump.fun TXs: the mint is typically a writable account in the TX
                // that isn't the wallet, program, or bonding curve. Look through innerInstructions
                // or fall back to account keys heuristic.
                const knownAddrs = new Set([wallet, PUMP_FUN_PROGRAM, pumpFunCurve || '', SOL_MINT]);
                for (const key of accountKeys) {
                  if (!knownAddrs.has(key.pubkey) && !key.signer && key.writable) {
                    // Candidate — could be mint, ATA, or other account
                    // Skip known system programs
                    if (!key.pubkey.startsWith('11111') && !key.pubkey.startsWith('Token')) {
                      mint = key.pubkey;
                      break;
                    }
                  }
                }
              }

              if (!mint) {
                logger.warn({
                  sig: signature.slice(0, 12),
                  wallet: wallet.slice(0, 8),
                  solDelta: solDelta.toFixed(4),
                }, 'Pump.fun fallback: could not resolve token mint — skipping');
                continue;
              }

              // Estimate token amount from the balance entries
              let tokenAmount = 0;
              for (const b of postBalances) {
                if (b.mint === mint) {
                  tokenAmount = parseFloat(b.uiTokenAmount.uiAmountString || '0');
                  break;
                }
              }

              logger.info({
                sig: signature.slice(0, 12),
                wallet: wallet.slice(0, 8),
                type,
                mint: mint.slice(0, 8),
                solDelta: solDelta.toFixed(4),
                tokenAmount: tokenAmount.toFixed(2),
              }, 'Pump.fun Token2022 signal recovered via SOL delta fallback');

              const signal: ParsedSignal = {
                walletAddress: wallet,
                txSignature: signature,
                blockTime,
                type,
                tokenMint: mint,
                tokenAmount,
                solDelta,
                detectedAt: now,
                detectionLagMs,
                detectionSource: DetectionSource.PUMPFUN_CURVE,
                isPumpFun: true,
                ...(pumpFunCurve ? {
                  pumpFunData: {
                    bondingCurveAddress: pumpFunCurve,
                    solSpent: Math.abs(solDelta),
                  },
                } : {}),
              };

              signals.push(signal);
              await this.logTransaction(signal);
              continue; // Skip the standard balance-matching path for this wallet
            }
          }
        }

        if (allMints.size === 0) continue; // No token activity for this wallet

        // SOL delta for value estimation
        const walletIdx = accountKeys.findIndex((k) => k.pubkey === wallet);
        const preSol = walletIdx >= 0 ? (tx.meta.preBalances[walletIdx] || 0) / 1e9 : 0;
        const postSol = walletIdx >= 0 ? (tx.meta.postBalances[walletIdx] || 0) / 1e9 : 0;
        const solDelta = postSol - preSol;

        for (const mint of allMints) {
          if (mint === SOL_MINT) continue; // Skip wrapped SOL

          // Look up balance by owner:mint first, then fall back to accountIndex matching
          let preAmount = preMap.get(`${wallet}:${mint}`) || 0;
          let postAmount = postMap.get(`${wallet}:${mint}`) || 0;

          // Token2022 fallback: match by accountIndex when owner doesn't match wallet
          if (preAmount === 0 && postAmount === 0) {
            for (const b of preBalances) {
              if (b.mint === mint && walletIndices.has(b.accountIndex)) {
                preAmount = parseFloat(b.uiTokenAmount.uiAmountString || '0');
                break;
              }
            }
            for (const b of postBalances) {
              if (b.mint === mint && walletIndices.has(b.accountIndex)) {
                postAmount = parseFloat(b.uiTokenAmount.uiAmountString || '0');
                break;
              }
            }
          }

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
        for (const w of involvedWallets) {
          this.walletSignalCounts.set(w, (this.walletSignalCounts.get(w) || 0) + 1);
        }
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
        // Rate-limit no-signal logs: at most once per 60s per wallet to avoid flooding
        const wallet = involvedWallets[0];
        const skipCount = (this.walletSkipCounts.get(wallet) || 0) + 1;
        this.walletSkipCounts.set(wallet, skipCount);
        const now = Date.now();
        const lastLog = this.walletLastSkipLog.get(wallet) || 0;
        if (now - lastLog >= TransactionParser.SKIP_LOG_INTERVAL_MS) {
          this.walletLastSkipLog.set(wallet, now);
          const signals = this.walletSignalCounts.get(wallet) || 0;
          console.log(`⏭️ wallet ${wallet.slice(0, 8)} | ${skipCount} skipped TXs (${signals} signals) | no token transfers`);
        }
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
