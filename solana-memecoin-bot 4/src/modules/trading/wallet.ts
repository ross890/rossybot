// ===========================================
// WALLET MODULE - Bot Wallet Management
// ===========================================

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
} from '@solana/web3.js';
import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import bs58 from 'bs58';

// ============ TYPES ============

export interface WalletBalance {
  sol: number;
  lamports: number;
  usdValue: number;
}

export interface TokenBalance {
  mint: string;
  symbol: string;
  balance: number;
  decimals: number;
  usdValue: number;
}

export interface WalletInfo {
  address: string;
  solBalance: WalletBalance;
  tokenBalances: TokenBalance[];
  totalUsdValue: number;
}

// ============ WALLET CLASS ============

export class BotWallet {
  private keypair: Keypair | null = null;
  private connection: Connection;
  private initialized = false;

  constructor() {
    this.connection = new Connection(appConfig.heliusRpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
  }

  /**
   * Initialize the wallet from private key in environment
   */
  async initialize(): Promise<boolean> {
    try {
      const privateKey = process.env.BOT_WALLET_PRIVATE_KEY;

      if (!privateKey) {
        logger.warn('BOT_WALLET_PRIVATE_KEY not set - trading disabled');
        return false;
      }

      // Support both base58 and JSON array formats
      try {
        if (privateKey.startsWith('[')) {
          // JSON array format
          const secretKey = Uint8Array.from(JSON.parse(privateKey));
          this.keypair = Keypair.fromSecretKey(secretKey);
        } else {
          // Base58 format
          const secretKey = bs58.decode(privateKey);
          this.keypair = Keypair.fromSecretKey(secretKey);
        }
      } catch (error) {
        logger.error({ error }, 'Failed to parse private key');
        return false;
      }

      this.initialized = true;

      const balance = await this.getSolBalance();
      logger.info({
        address: this.getAddress(),
        balance: `${balance.sol.toFixed(4)} SOL`,
      }, 'Bot wallet initialized');

      return true;
    } catch (error) {
      logger.error({ error }, 'Failed to initialize bot wallet');
      return false;
    }
  }

  /**
   * Check if wallet is initialized and ready
   */
  isReady(): boolean {
    return this.initialized && this.keypair !== null;
  }

  /**
   * Get wallet public address
   */
  getAddress(): string {
    if (!this.keypair) {
      throw new Error('Wallet not initialized');
    }
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Get wallet public key
   */
  getPublicKey(): PublicKey {
    if (!this.keypair) {
      throw new Error('Wallet not initialized');
    }
    return this.keypair.publicKey;
  }

  /**
   * Get keypair for signing (internal use only)
   */
  getKeypair(): Keypair {
    if (!this.keypair) {
      throw new Error('Wallet not initialized');
    }
    return this.keypair;
  }

  /**
   * Get connection
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get SOL balance
   */
  async getSolBalance(): Promise<WalletBalance> {
    if (!this.keypair) {
      throw new Error('Wallet not initialized');
    }

    try {
      const lamports = await this.connection.getBalance(this.keypair.publicKey);
      const sol = lamports / LAMPORTS_PER_SOL;

      // Get SOL price (simplified - in production use price feed)
      const solPrice = await this.getSolPrice();

      return {
        sol,
        lamports,
        usdValue: sol * solPrice,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get SOL balance');
      throw error;
    }
  }

  /**
   * Get token balances
   */
  async getTokenBalances(): Promise<TokenBalance[]> {
    if (!this.keypair) {
      throw new Error('Wallet not initialized');
    }

    try {
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );

      const balances: TokenBalance[] = [];

      for (const account of tokenAccounts.value) {
        const parsedInfo = account.account.data.parsed.info;
        const tokenAmount = parsedInfo.tokenAmount;

        if (tokenAmount.uiAmount > 0) {
          balances.push({
            mint: parsedInfo.mint,
            symbol: '', // Would need metadata lookup
            balance: tokenAmount.uiAmount,
            decimals: tokenAmount.decimals,
            usdValue: 0, // Would need price lookup
          });
        }
      }

      return balances;
    } catch (error) {
      logger.error({ error }, 'Failed to get token balances');
      return [];
    }
  }

  /**
   * Get complete wallet info
   */
  async getWalletInfo(): Promise<WalletInfo> {
    const solBalance = await this.getSolBalance();
    const tokenBalances = await this.getTokenBalances();

    const totalTokenUsd = tokenBalances.reduce((sum, t) => sum + t.usdValue, 0);

    return {
      address: this.getAddress(),
      solBalance,
      tokenBalances,
      totalUsdValue: solBalance.usdValue + totalTokenUsd,
    };
  }

  /**
   * Get token balance for a specific mint
   */
  async getTokenBalance(mintAddress: string): Promise<number> {
    if (!this.keypair) {
      throw new Error('Wallet not initialized');
    }

    try {
      const mintPubkey = new PublicKey(mintAddress);
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { mint: mintPubkey }
      );

      if (tokenAccounts.value.length === 0) {
        return 0;
      }

      return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
    } catch (error) {
      logger.error({ error, mint: mintAddress }, 'Failed to get token balance');
      return 0;
    }
  }

  /**
   * Withdraw SOL to an address
   */
  async withdrawSol(amount: number, destinationAddress: string): Promise<string> {
    if (!this.keypair) {
      throw new Error('Wallet not initialized');
    }

    try {
      const destination = new PublicKey(destinationAddress);
      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.keypair.publicKey,
          toPubkey: destination,
          lamports,
        })
      );

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.keypair]
      );

      logger.info({
        amount,
        destination: destinationAddress,
        signature,
      }, 'SOL withdrawal successful');

      return signature;
    } catch (error) {
      logger.error({ error, amount, destination: destinationAddress }, 'SOL withdrawal failed');
      throw error;
    }
  }

  /**
   * Get current SOL price in USD
   */
  private async getSolPrice(): Promise<number> {
    try {
      // Use Birdeye or similar API for price
      const response = await fetch(
        'https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112',
        {
          headers: {
            'X-API-KEY': appConfig.birdeyeApiKey,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Birdeye API error: ${response.status}`);
      }

      const data = await response.json() as { data?: { value?: number } };
      return data.data?.value || 150; // Fallback to $150
    } catch (error) {
      logger.warn({ error }, 'Failed to get SOL price, using fallback');
      return 150; // Fallback price
    }
  }

  /**
   * Estimate transaction fee
   */
  async estimateFee(transaction: Transaction): Promise<number> {
    try {
      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = this.getPublicKey();

      const message = transaction.compileMessage();
      const fee = await this.connection.getFeeForMessage(message);

      return fee.value ? fee.value / LAMPORTS_PER_SOL : 0.000005;
    } catch (error) {
      logger.warn({ error }, 'Failed to estimate fee, using default');
      return 0.000005; // Default ~5000 lamports
    }
  }

  /**
   * Check if wallet has sufficient balance for trade
   */
  async hasSufficientBalance(solAmount: number): Promise<boolean> {
    const balance = await this.getSolBalance();
    // Keep 0.01 SOL reserve for fees
    const available = balance.sol - 0.01;
    return available >= solAmount;
  }
}

// ============ SINGLETON EXPORT ============

export const botWallet = new BotWallet();

export default botWallet;
