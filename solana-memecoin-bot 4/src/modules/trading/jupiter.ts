// ===========================================
// JUPITER SWAP INTEGRATION
// Primary DEX aggregator for token swaps
// ===========================================

import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import { logger } from '../../utils/logger.js';
import { botWallet } from './wallet.js';

// ============ CONSTANTS ============

const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ============ TYPES ============

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
}

export interface SwapResult {
  success: boolean;
  signature?: string;
  inputAmount: number;
  outputAmount: number;
  priceImpact: number;
  error?: string;
}

export interface SwapParams {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
  maxRetries?: number;
}

// ============ JUPITER CLIENT CLASS ============

export class JupiterClient {
  private connection: Connection;

  constructor() {
    this.connection = botWallet.getConnection();
  }

  /**
   * Get a swap quote from Jupiter
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 1000 // 10% default for memecoins
  ): Promise<JupiterQuote | null> {
    try {
      // Convert amount to lamports/smallest unit
      const amountInSmallestUnit = Math.floor(amount * 1e9); // Assuming 9 decimals for SOL

      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amountInSmallestUnit.toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false',
      });

      const response = await fetch(`${JUPITER_API_URL}/quote?${params}`);

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Jupiter quote failed');
        return null;
      }

      const quote = await response.json();

      if (quote.error) {
        logger.error({ error: quote.error }, 'Jupiter quote error');
        return null;
      }

      return quote;
    } catch (error) {
      logger.error({ error, inputMint, outputMint }, 'Failed to get Jupiter quote');
      return null;
    }
  }

  /**
   * Execute a swap on Jupiter
   */
  async executeSwap(params: SwapParams): Promise<SwapResult> {
    const { inputMint, outputMint, amount, slippageBps = 1000, maxRetries = 3 } = params;

    if (!botWallet.isReady()) {
      return { success: false, inputAmount: amount, outputAmount: 0, priceImpact: 0, error: 'Wallet not initialized' };
    }

    let lastError: string = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info({
          inputMint: inputMint.slice(0, 8),
          outputMint: outputMint.slice(0, 8),
          amount,
          slippageBps,
          attempt,
        }, 'Executing Jupiter swap');

        // Step 1: Get quote
        const quote = await this.getQuote(inputMint, outputMint, amount, slippageBps);
        if (!quote) {
          lastError = 'Failed to get quote';
          continue;
        }

        const priceImpact = parseFloat(quote.priceImpactPct);

        // Check price impact warning
        if (priceImpact > 15) {
          logger.warn({ priceImpact }, 'High price impact warning');
        }

        // Step 2: Get swap transaction
        const swapResponse = await fetch(`${JUPITER_API_URL}/swap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: botWallet.getAddress(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
            prioritizationFeeLamports: 'auto',
          }),
        });

        if (!swapResponse.ok) {
          const errorText = await swapResponse.text();
          logger.error({ status: swapResponse.status, error: errorText }, 'Jupiter swap request failed');
          lastError = `Swap request failed: ${swapResponse.status}`;
          continue;
        }

        const swapData = await swapResponse.json();

        if (swapData.error) {
          logger.error({ error: swapData.error }, 'Jupiter swap error');
          lastError = swapData.error;
          continue;
        }

        // Step 3: Deserialize and sign transaction
        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        // Sign the transaction
        transaction.sign([botWallet.getKeypair()]);

        // Step 4: Send transaction with retry logic
        const signature = await this.sendTransactionWithRetry(transaction);

        if (!signature) {
          lastError = 'Transaction failed to confirm';
          continue;
        }

        const outputAmount = parseInt(quote.outAmount) / 1e9; // Adjust decimals as needed

        logger.info({
          signature,
          inputAmount: amount,
          outputAmount,
          priceImpact,
        }, 'Jupiter swap successful');

        return {
          success: true,
          signature,
          inputAmount: amount,
          outputAmount,
          priceImpact,
        };

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error({ error, attempt }, 'Jupiter swap attempt failed');
        lastError = errorMessage;

        // Wait before retry
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    return {
      success: false,
      inputAmount: amount,
      outputAmount: 0,
      priceImpact: 0,
      error: lastError,
    };
  }

  /**
   * Buy tokens with SOL
   */
  async buyToken(
    tokenMint: string,
    solAmount: number,
    slippageBps?: number
  ): Promise<SwapResult> {
    return this.executeSwap({
      inputMint: SOL_MINT,
      outputMint: tokenMint,
      amount: solAmount,
      slippageBps,
    });
  }

  /**
   * Sell tokens for SOL
   */
  async sellToken(
    tokenMint: string,
    tokenAmount: number,
    slippageBps?: number
  ): Promise<SwapResult> {
    return this.executeSwap({
      inputMint: tokenMint,
      outputMint: SOL_MINT,
      amount: tokenAmount,
      slippageBps,
    });
  }

  /**
   * Sell percentage of token holdings
   */
  async sellTokenPercent(
    tokenMint: string,
    percent: number,
    slippageBps?: number
  ): Promise<SwapResult> {
    const balance = await botWallet.getTokenBalance(tokenMint);

    if (balance <= 0) {
      return {
        success: false,
        inputAmount: 0,
        outputAmount: 0,
        priceImpact: 0,
        error: 'No token balance to sell',
      };
    }

    const amountToSell = balance * (percent / 100);

    return this.sellToken(tokenMint, amountToSell, slippageBps);
  }

  /**
   * Send transaction with retry logic
   */
  private async sendTransactionWithRetry(
    transaction: VersionedTransaction,
    maxRetries: number = 3
  ): Promise<string | null> {
    const connection = botWallet.getConnection();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Send transaction
        const rawTransaction = transaction.serialize();
        const signature = await connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
          maxRetries: 2,
        });

        logger.debug({ signature, attempt }, 'Transaction sent, waiting for confirmation');

        // Wait for confirmation
        const confirmation = await connection.confirmTransaction(
          {
            signature,
            blockhash: transaction.message.recentBlockhash,
            lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight,
          },
          'confirmed'
        );

        if (confirmation.value.err) {
          logger.error({ signature, error: confirmation.value.err }, 'Transaction failed');
          continue;
        }

        return signature;

      } catch (error) {
        logger.error({ error, attempt }, 'Transaction send attempt failed');

        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    return null;
  }

  /**
   * Get estimated output amount (for display)
   */
  async getEstimatedOutput(
    inputMint: string,
    outputMint: string,
    amount: number
  ): Promise<{ outputAmount: number; priceImpact: number } | null> {
    const quote = await this.getQuote(inputMint, outputMint, amount);
    if (!quote) return null;

    return {
      outputAmount: parseInt(quote.outAmount) / 1e9,
      priceImpact: parseFloat(quote.priceImpactPct),
    };
  }

  /**
   * Check if a route exists for a token pair
   */
  async hasRoute(inputMint: string, outputMint: string): Promise<boolean> {
    const quote = await this.getQuote(inputMint, outputMint, 0.001);
    return quote !== null;
  }
}

// ============ SINGLETON EXPORT ============

export const jupiterClient = new JupiterClient();

export default jupiterClient;
