import { logger } from '../../utils/logger.js';
import { query } from '../../db/database.js';
import { SignalType, DetectionSource, type ParsedSignal } from '../../types/index.js';

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
      if (!tx || tx.meta?.err) return signals; // Skip failed txs

      const signature = result.signature || tx.transaction?.signatures?.[0];
      if (!signature) return signals;

      const blockTime = typeof tx.blockTime === 'number' ? tx.blockTime : Math.floor(now.getTime() / 1000);
      const blockDate = new Date(blockTime * 1000);
      const detectionLagMs = tx.blockTime ? Math.max(0, now.getTime() - blockDate.getTime()) : 0;

      // Step 1: Identify the wallet (first signer)
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const firstSigner = accountKeys.find((k) => k.signer)?.pubkey;
      if (!firstSigner || !this.subscribedWallets.has(firstSigner)) return signals;

      // Step 2: Detect token transfers by comparing pre/post balances
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];

      // Build balance maps per owner+mint
      const preMap = this.buildBalanceMap(preBalances);
      const postMap = this.buildBalanceMap(postBalances);

      // Compute deltas for the wallet
      const allMints = new Set([
        ...preBalances.filter((b) => b.owner === firstSigner).map((b) => b.mint),
        ...postBalances.filter((b) => b.owner === firstSigner).map((b) => b.mint),
      ]);

      // SOL delta for value estimation
      const signerIdx = accountKeys.findIndex((k) => k.pubkey === firstSigner);
      const preSol = (tx.meta.preBalances[signerIdx] || 0) / 1e9;
      const postSol = (tx.meta.postBalances[signerIdx] || 0) / 1e9;
      const solDelta = postSol - preSol;

      for (const mint of allMints) {
        if (mint === SOL_MINT) continue; // Skip wrapped SOL

        const key = `${firstSigner}:${mint}`;
        const preAmount = preMap.get(key) || 0;
        const postAmount = postMap.get(key) || 0;
        const delta = postAmount - preAmount;

        if (Math.abs(delta) < 0.000001) continue; // Ignore dust

        const type = delta > 0 ? SignalType.BUY : SignalType.SELL;

        const signal: ParsedSignal = {
          walletAddress: firstSigner,
          txSignature: signature,
          blockTime,
          type,
          tokenMint: mint,
          tokenAmount: Math.abs(delta),
          solDelta,
          detectedAt: now,
          detectionLagMs,
          detectionSource: source,
        };

        signals.push(signal);

        // Log to database
        await this.logTransaction(signal);
      }

      if (signals.length > 0) {
        logger.info({
          wallet: firstSigner.slice(0, 8),
          signals: signals.map((s) => ({
            type: s.type,
            mint: s.tokenMint.slice(0, 8),
            amount: s.tokenAmount.toFixed(2),
            lagMs: s.detectionLagMs,
          })),
        }, 'Parsed transaction signals');
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
