// ===========================================
// RAYDIUM SWAP INTEGRATION
// Fallback DEX for when Jupiter doesn't have routes
// ===========================================

import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { logger } from '../../utils/logger.js';
import { botWallet } from './wallet.js';

// ============ CONSTANTS ============

const RAYDIUM_API_URL = 'https://transaction-v1.raydium.io';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ============ TYPES ============

export interface RaydiumSwapResult {
  success: boolean;
  signature?: string;
  inputAmount: number;
  outputAmount: number;
  priceImpact: number;
  error?: string;
}

export interface RaydiumQuote {
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  priceImpact: number;
  fee: number;
}

// ============ RAYDIUM CLIENT CLASS ============

export class RaydiumClient {
  private connection: Connection;

  constructor() {
    this.connection = botWallet.getConnection();
  }

  /**
   * Get swap quote from Raydium
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 1000
  ): Promise<RaydiumQuote | null> {
    try {
      const amountInSmallestUnit = Math.floor(amount * 1e9);

      const response = await fetch(
        `${RAYDIUM_API_URL}/compute/swap-base-in?` +
        `inputMint=${inputMint}&` +
        `outputMint=${outputMint}&` +
        `amount=${amountInSmallestUnit}&` +
        `slippageBps=${slippageBps}&` +
        `txVersion=V0`
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, error: errorText }, 'Raydium quote failed');
        return null;
      }

      const data = await response.json() as {
        success: boolean;
        msg?: string;
        data?: { outputAmount: string; priceImpact?: number; fee?: number };
      };

      if (!data.success) {
        logger.error({ error: data.msg || 'Unknown error' }, 'Raydium quote error');
        return null;
      }

      return {
        inputMint,
        outputMint,
        inAmount: amount,
        outAmount: parseInt(data.data!.outputAmount) / 1e9,
        priceImpact: data.data!.priceImpact || 0,
        fee: data.data!.fee || 0,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get Raydium quote');
      return null;
    }
  }

  /**
   * Execute swap on Raydium
   */
  async executeSwap(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 1000
  ): Promise<RaydiumSwapResult> {
    if (!botWallet.isReady()) {
      return {
        success: false,
        inputAmount: amount,
        outputAmount: 0,
        priceImpact: 0,
        error: 'Wallet not initialized',
      };
    }

    try {
      logger.info({
        inputMint: inputMint.slice(0, 8),
        outputMint: outputMint.slice(0, 8),
        amount,
        slippageBps,
      }, 'Executing Raydium swap');

      // Step 1: Get quote
      const quote = await this.getQuote(inputMint, outputMint, amount, slippageBps);
      if (!quote) {
        return {
          success: false,
          inputAmount: amount,
          outputAmount: 0,
          priceImpact: 0,
          error: 'Failed to get Raydium quote',
        };
      }

      const amountInSmallestUnit = Math.floor(amount * 1e9);

      // Step 2: Get swap transaction
      const swapResponse = await fetch(`${RAYDIUM_API_URL}/transaction/swap-base-in`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          computeUnitPriceMicroLamports: 'auto',
          inputMint,
          outputMint,
          amount: amountInSmallestUnit,
          slippageBps,
          txVersion: 'V0',
          wallet: botWallet.getAddress(),
          wrapSol: true,
          unwrapSol: true,
        }),
      });

      if (!swapResponse.ok) {
        const errorText = await swapResponse.text();
        logger.error({ status: swapResponse.status, error: errorText }, 'Raydium swap request failed');
        return {
          success: false,
          inputAmount: amount,
          outputAmount: 0,
          priceImpact: 0,
          error: `Raydium swap request failed: ${swapResponse.status}`,
        };
      }

      const swapData = await swapResponse.json() as {
        success: boolean;
        msg?: string;
        data?: string[];
      };

      if (!swapData.success) {
        return {
          success: false,
          inputAmount: amount,
          outputAmount: 0,
          priceImpact: 0,
          error: swapData.msg || 'Raydium swap failed',
        };
      }

      // Step 3: Deserialize and sign transaction(s)
      const transactions = swapData.data!.map((txData: string) => {
        const txBuf = Buffer.from(txData, 'base64');
        return VersionedTransaction.deserialize(txBuf);
      });

      // Sign all transactions
      for (const tx of transactions) {
        tx.sign([botWallet.getKeypair()]);
      }

      // Step 4: Send transactions
      const connection = botWallet.getConnection();
      let finalSignature = '';

      for (const tx of transactions) {
        const rawTransaction = tx.serialize();
        const signature = await connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
          maxRetries: 2,
        });

        // Wait for confirmation
        const confirmation = await connection.confirmTransaction(
          {
            signature,
            blockhash: tx.message.recentBlockhash,
            lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight,
          },
          'confirmed'
        );

        if (confirmation.value.err) {
          logger.error({ signature, error: confirmation.value.err }, 'Raydium transaction failed');
          return {
            success: false,
            inputAmount: amount,
            outputAmount: 0,
            priceImpact: quote.priceImpact,
            error: 'Transaction failed to confirm',
          };
        }

        finalSignature = signature;
      }

      logger.info({
        signature: finalSignature,
        inputAmount: amount,
        outputAmount: quote.outAmount,
        priceImpact: quote.priceImpact,
      }, 'Raydium swap successful');

      return {
        success: true,
        signature: finalSignature,
        inputAmount: amount,
        outputAmount: quote.outAmount,
        priceImpact: quote.priceImpact,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error }, 'Raydium swap failed');
      return {
        success: false,
        inputAmount: amount,
        outputAmount: 0,
        priceImpact: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Buy tokens with SOL
   */
  async buyToken(
    tokenMint: string,
    solAmount: number,
    slippageBps?: number
  ): Promise<RaydiumSwapResult> {
    return this.executeSwap(SOL_MINT, tokenMint, solAmount, slippageBps);
  }

  /**
   * Sell tokens for SOL
   */
  async sellToken(
    tokenMint: string,
    tokenAmount: number,
    slippageBps?: number
  ): Promise<RaydiumSwapResult> {
    return this.executeSwap(tokenMint, SOL_MINT, tokenAmount, slippageBps);
  }

  /**
   * Check if Raydium has a pool for this token
   */
  async hasPool(tokenMint: string): Promise<boolean> {
    const quote = await this.getQuote(SOL_MINT, tokenMint, 0.001);
    return quote !== null;
  }
}

// ============ SINGLETON EXPORT ============

export const raydiumClient = new RaydiumClient();

export default raydiumClient;
