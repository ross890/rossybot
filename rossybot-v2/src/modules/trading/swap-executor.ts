import { Connection, Keypair, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

/** Result of a swap execution */
export interface SwapResult {
  success: boolean;
  txSignature: string | null;
  inputAmount: number;   // SOL for buy, tokens for sell
  outputAmount: number;  // tokens for buy, SOL for sell
  feesSol: number;       // priority fee + Solana base fee
  error?: string;
}

/** SOL mint address */
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export class SwapExecutor {
  private connection: Connection;
  private keypair: Keypair;

  constructor() {
    if (!config.wallet.privateKey) {
      throw new Error('WALLET_PRIVATE_KEY required for live trading');
    }
    this.keypair = Keypair.fromSecretKey(bs58.decode(config.wallet.privateKey));
    this.connection = new Connection(config.helius.rpcUrl, 'confirmed');
  }

  get walletPublicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  /** Buy token with SOL */
  async buyToken(tokenMint: string, solAmount: number, liquidityUsd: number, opts?: {
    prefetchedQuote?: unknown;
    mevProtected?: boolean;
  }): Promise<SwapResult> {
    const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);

    let slippageBps: number;
    if (opts?.mevProtected && liquidityUsd > 0) {
      // MEV-resistant slippage: scale by trade size relative to pool depth.
      // Tighter slippage = less room for sandwich attacks.
      // Rough SOL price ~$140 for impact estimation.
      const tradeSizeUsd = solAmount * 140;
      const impactPct = tradeSizeUsd / liquidityUsd;
      if (impactPct < 0.005) slippageBps = 100;       // <0.5% of pool → 1% slippage
      else if (impactPct < 0.01) slippageBps = 150;    // <1% of pool → 1.5%
      else if (impactPct < 0.02) slippageBps = 200;    // <2% of pool → 2%
      else slippageBps = 300;                           // >2% of pool → 3% (needs room)
    } else {
      slippageBps = liquidityUsd < 50_000
        ? config.jupiter.thinLiquiditySlippageBps
        : config.jupiter.defaultSlippageBps;
    }

    return this.executeSwap({
      inputMint: SOL_MINT,
      outputMint: tokenMint,
      amount: lamports,
      slippageBps,
      isBuy: true,
      prefetchedQuote: opts?.prefetchedQuote,
      mevProtected: opts?.mevProtected,
    });
  }

  /** Sell token for SOL — sells all held tokens by default */
  async sellToken(tokenMint: string, liquidityUsd: number, percentToSell = 100, slippageBpsOverride?: number): Promise<SwapResult> {
    // Get token balance
    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
      this.keypair.publicKey,
      { mint: new (await import('@solana/web3.js')).PublicKey(tokenMint) },
    );

    if (tokenAccounts.value.length === 0) {
      return { success: false, txSignature: null, inputAmount: 0, outputAmount: 0, feesSol: 0, error: 'No token balance' };
    }

    const tokenAccount = tokenAccounts.value[0];
    const rawAmount = tokenAccount.account.data.parsed.info.tokenAmount.amount;
    const fullAmount = BigInt(rawAmount);
    const sellAmount = percentToSell >= 100
      ? fullAmount
      : (fullAmount * BigInt(percentToSell)) / 100n;

    if (sellAmount === 0n) {
      return { success: false, txSignature: null, inputAmount: 0, outputAmount: 0, feesSol: 0, error: 'Zero token balance' };
    }

    const slippageBps = slippageBpsOverride
      ?? (liquidityUsd < 50_000
        ? config.jupiter.thinLiquiditySlippageBps
        : config.jupiter.defaultSlippageBps);

    return this.executeSwap({
      inputMint: tokenMint,
      outputMint: SOL_MINT,
      amount: Number(sellAmount),
      slippageBps,
      isBuy: false,
    });
  }

  /**
   * Pre-fetch a Jupiter quote (used to parallelize quote with validation).
   * Returns the raw quote response data, or null on failure.
   */
  async prefetchQuote(tokenMint: string, solAmount: number): Promise<unknown | null> {
    try {
      const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);
      const jupHeaders: Record<string, string> = {};
      if (config.jupiter.apiKey) jupHeaders['x-api-key'] = config.jupiter.apiKey;

      const resp = await axios.get(`${config.jupiter.apiUrl}/quote`, {
        params: {
          inputMint: SOL_MINT,
          outputMint: tokenMint,
          amount: lamports.toString(),
          slippageBps: config.jupiter.thinLiquiditySlippageBps,
          onlyDirectRoutes: false,
        },
        headers: jupHeaders,
        timeout: 10_000,
      });
      return resp.data || null;
    } catch {
      return null;
    }
  }

  private async executeSwap(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
    slippageBps: number;
    isBuy: boolean;
    prefetchedQuote?: unknown;
    mevProtected?: boolean;
  }): Promise<SwapResult> {
    const { inputMint, outputMint, amount, slippageBps, isBuy, prefetchedQuote, mevProtected } = params;

    // Get priority fee + quote in parallel (independent calls)
    const jupHeaders: Record<string, string> = {};
    if (config.jupiter.apiKey) {
      jupHeaders['x-api-key'] = config.jupiter.apiKey;
    }

    // MEV protection: restrict routing to top-liquidity intermediate tokens only.
    // This prevents sandwichers from using obscure pool routes to manipulate price.
    const quoteParams: Record<string, string | boolean | number> = {
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps,
      onlyDirectRoutes: false,
    };
    if (mevProtected) {
      quoteParams.restrictIntermediateTokens = true;
      quoteParams.maxAccounts = 20; // Fewer accounts = simpler route = harder to sandwich
    }

    const [priorityFee, quoteResponse] = await Promise.all([
      this.getPriorityFee(),
      prefetchedQuote
        ? Promise.resolve({ data: prefetchedQuote })
        : axios.get(`${config.jupiter.apiUrl}/quote`, {
            params: quoteParams,
            headers: jupHeaders,
            timeout: 10_000,
          }),
    ]);

    // MEV protection: boost priority fee to outbid sandwichers in block ordering
    const basePriorityFee = mevProtected ? Math.round(priorityFee * 1.5) : priorityFee;

    for (let attempt = 0; attempt <= config.jupiter.maxRetries; attempt++) {
      try {
        const currentPriorityFee = attempt === 0 ? basePriorityFee : basePriorityFee * 2;

        // On retry, re-fetch quote (price may have moved)
        let quote = quoteResponse.data;
        if (attempt > 0) {
          const retryQuote = await axios.get(`${config.jupiter.apiUrl}/quote`, {
            params: quoteParams,
            headers: jupHeaders,
            timeout: 10_000,
          });
          quote = retryQuote.data;
        }
        if (!quote || quote.error) {
          throw new Error(`Quote failed: ${quote?.error || 'no response'}`);
        }

        // 2. Get swap transaction
        const swapResponse = await axios.post(`${config.jupiter.apiUrl}/swap`, {
          quoteResponse: quote,
          userPublicKey: this.keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: currentPriorityFee,
          dynamicComputeUnitLimit: true,
        }, {
          headers: { ...jupHeaders, 'Content-Type': 'application/json' },
          timeout: 15_000,
        });

        const { swapTransaction } = swapResponse.data;
        if (!swapTransaction) {
          throw new Error('No swap transaction returned');
        }

        // 3. Deserialize, sign, send — skip preflight for speed (Jupiter already simulated)
        const txBuf = Buffer.from(swapTransaction, 'base64');
        const tx = VersionedTransaction.deserialize(txBuf);
        tx.sign([this.keypair]);

        // Fire send + blockhash fetch in parallel (blockhash needed for confirm, not for send)
        const [signature, blockhash] = await Promise.all([
          this.connection.sendTransaction(tx, {
            skipPreflight: true,
            maxRetries: 2,
          }),
          this.connection.getLatestBlockhash('confirmed'),
        ]);

        // Estimate fees from priority fee + base fee (skip pre/post balance RPC calls)
        const estimatedFees = (currentPriorityFee * 200_000 / 1e6 + 5000) / LAMPORTS_PER_SOL;

        // 4. BUY = fire-and-forget confirmation (saves 5-30s latency)
        //    SELL = wait for confirmation (need to verify SOL returned)
        if (isBuy) {
          // Confirm async — log result but don't block the caller
          this.connection.confirmTransaction({ signature, ...blockhash }, 'confirmed')
            .then((conf) => {
              if (conf.value.err) {
                logger.error({ signature: signature.slice(0, 16), err: conf.value.err },
                  'BUY confirmation FAILED on-chain — position may not exist');
              } else {
                logger.info({ signature: signature.slice(0, 16) }, 'BUY confirmed on-chain');
              }
            })
            .catch((err) => {
              logger.warn({ signature: signature.slice(0, 16), err: String(err) },
                'BUY confirmation check failed — will verify via balance scan');
            });
        } else {
          // SELL: wait for confirmation
          const confirmation = await this.connection.confirmTransaction(
            { signature, ...blockhash },
            'confirmed',
          );
          if (confirmation.value.err) {
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
          }
        }

        logger.info({
          signature: signature.slice(0, 16),
          type: isBuy ? 'BUY' : 'SELL',
          inputMint: inputMint.slice(0, 8),
          outputMint: outputMint.slice(0, 8),
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          feesSol: estimatedFees.toFixed(6),
          attempt,
          fireAndForget: isBuy,
        }, 'Swap executed');

        return {
          success: true,
          txSignature: signature,
          inputAmount: Number(quote.inAmount),
          outputAmount: Number(quote.outAmount),
          feesSol: estimatedFees,
        };

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err: errMsg, attempt, type: isBuy ? 'BUY' : 'SELL' }, `Swap attempt failed: ${errMsg}`);

        if (attempt >= config.jupiter.maxRetries) {
          return {
            success: false,
            txSignature: null,
            inputAmount: 0,
            outputAmount: 0,
            feesSol: 0,
            error: errMsg,
          };
        }
        // Retry with 2x priority fee
      }
    }

    return { success: false, txSignature: null, inputAmount: 0, outputAmount: 0, feesSol: 0, error: 'Max retries exceeded' };
  }

  /** Get dynamic priority fee from Helius */
  private async getPriorityFee(): Promise<number> {
    try {
      const response = await axios.post(config.helius.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getRecentPrioritizationFees',
        params: [],
      }, { timeout: 5_000 });

      const fees = response.data?.result || [];
      if (fees.length === 0) return 50_000; // Default 50k micro-lamports

      // Use 75th percentile, bias high for speed
      const sorted = fees.map((f: { prioritizationFee: number }) => f.prioritizationFee).sort((a: number, b: number) => a - b);
      const p75 = sorted[Math.floor(sorted.length * 0.75)];
      return Math.max(p75, 10_000); // Minimum 10k micro-lamports
    } catch {
      return 50_000; // Safe default
    }
  }

  /** Check token balance in wallet */
  async getTokenBalance(tokenMint: string): Promise<number> {
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { mint: new PublicKey(tokenMint) },
      );
      if (tokenAccounts.value.length === 0) return 0;
      return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
    } catch {
      return 0;
    }
  }
}
