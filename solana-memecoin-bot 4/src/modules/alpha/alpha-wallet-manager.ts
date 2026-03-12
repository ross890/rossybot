// ===========================================
// MODULE: ALPHA WALLET MANAGER
// User-submitted wallet seeding, tracking, and auto-pruning
// ===========================================

import { Database } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { heliusClient } from '../onchain.js';
import { appConfig } from '../../config/index.js';
import {
  AlphaWalletStatus,
  AlphaWallet,
  AlphaWalletTrade,
  AlphaWalletEvaluation,
} from '../../types/index.js';

// ============ CONSTANTS ============

// Performance thresholds
export const THRESHOLDS = {
  // Probation: < 10 trades, learning mode
  PROBATION_TRADES: 10,

  // Win rate thresholds
  TRUSTED_WIN_RATE: 0.50,     // 50%+ to become TRUSTED
  ACTIVE_WIN_RATE: 0.40,      // 40%+ to stay ACTIVE
  SUSPEND_WIN_RATE: 0.35,     // Below 35% = suspend

  // ROI override: wallets with high avg ROI stay active despite low win rate
  // A wallet hitting big winners (e.g. 3500% avg ROI) shouldn't be demoted
  ROI_OVERRIDE_ACTIVE: 500,      // 500%+ avg ROI = keep ACTIVE minimum
  ROI_OVERRIDE_TRUSTED: 1500,    // 1500%+ avg ROI = TRUSTED regardless of win rate
  ROI_OVERRIDE_MIN_TRADES: 5,    // Need at least 5 trades for ROI override to apply

  // Signal weights by status
  PROBATION_WEIGHT: 0.30,
  ACTIVE_WEIGHT: 0.60,
  TRUSTED_WEIGHT: 1.00,
  SUSPENDED_WEIGHT: 0,

  // Suspension/removal
  SUSPENSION_RECOVERY_DAYS: 14,  // 2 weeks to recover
  MAX_SUSPENSIONS: 2,            // 2 suspensions = permanent removal

  // Evaluation window
  EVALUATION_WINDOW_DAYS: 30,    // Rolling 30-day window

  // Win threshold (same as KOL system)
  WIN_THRESHOLD_ROI: 100,        // 100% ROI = 2x = win
};

// Solana address regex pattern
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ============ TYPES ============

interface AddWalletResult {
  success: boolean;
  walletId?: string;
  message: string;
  isNew: boolean;
}

interface ValidationResult {
  isValid: boolean;
  error?: string;
}

// ============ ALPHA WALLET MANAGER CLASS ============

export class AlphaWalletManager {
  private evaluationTimer: NodeJS.Timeout | null = null;
  private tradeMonitorTimer: NodeJS.Timeout | null = null;

  // Callback for sending Telegram notifications
  private notifyCallback: ((message: string) => Promise<void>) | null = null;

  // Tokens discovered via alpha wallet buys — picked up by signal generator
  private alphaDiscoveredTokens: Map<string, {
    walletAddress: string;
    walletLabel: string | null;
    solAmount: number;
    txSignature: string;
    discoveredAt: number;
  }> = new Map();

  /**
   * Initialize the alpha wallet manager
   */
  async initialize(): Promise<void> {
    logger.info('Initializing Alpha Wallet Manager...');

    // Start periodic evaluation (every hour)
    this.startPeriodicEvaluation();

    // Start trade monitoring (every 5 minutes)
    this.startTradeMonitoring();

    const activeWallets = await Database.getActiveAlphaWallets();
    logger.info({ walletCount: activeWallets.length }, 'Alpha Wallet Manager initialized');
  }

  /**
   * Set notification callback for Telegram alerts
   */
  setNotifyCallback(callback: (message: string) => Promise<void>): void {
    this.notifyCallback = callback;
  }

  /**
   * Get tokens discovered by alpha wallet buys and clear the buffer.
   * Called by signal generator's getCandidateTokens() each scan cycle.
   */
  drainDiscoveredTokens(): string[] {
    const now = Date.now();
    const EXPIRY_MS = 30 * 60 * 1000;

    // Expire entries older than 30 minutes
    for (const [token, info] of this.alphaDiscoveredTokens) {
      if (now - info.discoveredAt > EXPIRY_MS) {
        this.alphaDiscoveredTokens.delete(token);
      }
    }

    // Drain: return tokens and clear map to prevent re-sending the same candidates
    const tokens = Array.from(this.alphaDiscoveredTokens.keys());
    this.alphaDiscoveredTokens.clear();
    return tokens;
  }

  /**
   * Check if a token was recently discovered by an alpha wallet
   */
  isAlphaDiscovered(tokenAddress: string): boolean {
    return this.alphaDiscoveredTokens.has(tokenAddress);
  }

  /**
   * Add a new alpha wallet
   */
  async addWallet(
    address: string,
    addedBy: string,
    label?: string
  ): Promise<AddWalletResult> {
    // Validate address format
    const validation = this.validateAddress(address);
    if (!validation.isValid) {
      return {
        success: false,
        message: validation.error || 'Invalid address',
        isNew: false,
      };
    }

    // Check if already tracked as KOL wallet
    const kolWallet = await Database.getWalletByAddress(address);
    if (kolWallet) {
      return {
        success: false,
        message: `This wallet is already tracked as a verified KOL wallet (${kolWallet.kol.handle})`,
        isNew: false,
      };
    }

    // Check if already an alpha wallet
    const existingAlpha = await Database.getAlphaWalletByAddress(address);
    if (existingAlpha) {
      if (existingAlpha.status === AlphaWalletStatus.REMOVED) {
        // Allow re-adding removed wallets
        await Database.updateAlphaWalletStatus(
          existingAlpha.id,
          AlphaWalletStatus.PROBATION,
          THRESHOLDS.PROBATION_WEIGHT
        );
        return {
          success: true,
          walletId: existingAlpha.id,
          message: 'Wallet re-activated and placed in probation',
          isNew: false,
        };
      }
      return {
        success: false,
        message: `Wallet already tracked (Status: ${existingAlpha.status})`,
        isNew: false,
      };
    }

    // Validate wallet exists on-chain
    const walletExists = await this.validateWalletOnChain(address);
    if (!walletExists) {
      return {
        success: false,
        message: 'Wallet address not found on Solana blockchain',
        isNew: false,
      };
    }

    // Create the alpha wallet
    const result = await Database.createAlphaWallet(address, addedBy, label);

    logger.info({ address, addedBy, walletId: result.id }, 'Alpha wallet added');

    // Send notification
    await this.notify(
      `*Alpha Wallet Added*\n\n` +
      `Address: \`${address.slice(0, 8)}...${address.slice(-6)}\`\n` +
      `${label ? `Label: ${label}\n` : ''}` +
      `Status: PROBATION\n` +
      `Signal Weight: ${(THRESHOLDS.PROBATION_WEIGHT * 100).toFixed(0)}%\n\n` +
      `_Wallet will be evaluated after ${THRESHOLDS.PROBATION_TRADES} trades_`
    );

    return {
      success: true,
      walletId: result.id,
      message: 'Wallet added successfully and placed in probation',
      isNew: result.isNew,
    };
  }

  /**
   * Remove an alpha wallet
   */
  async removeWallet(address: string, removedBy: string): Promise<{ success: boolean; message: string }> {
    const wallet = await Database.getAlphaWalletByAddress(address);

    if (!wallet) {
      return { success: false, message: 'Wallet not found' };
    }

    if (wallet.status === AlphaWalletStatus.REMOVED) {
      return { success: false, message: 'Wallet already removed' };
    }

    await Database.removeAlphaWallet(wallet.id);

    // Log evaluation
    await Database.logAlphaWalletEvaluation({
      walletId: wallet.id,
      walletAddress: address,
      previousStatus: wallet.status,
      newStatus: AlphaWalletStatus.REMOVED,
      winRate: wallet.winRate,
      totalTrades: wallet.totalTrades,
      avgRoi: wallet.avgRoi,
      recommendation: 'REMOVE',
      reason: `Manual removal by user ${removedBy}`,
    });

    logger.info({ address, removedBy }, 'Alpha wallet manually removed');

    await this.notify(
      `*Alpha Wallet Removed*\n\n` +
      `Address: \`${address.slice(0, 8)}...${address.slice(-6)}\`\n` +
      `${wallet.label ? `Label: ${wallet.label}\n` : ''}` +
      `Previous Status: ${wallet.status}\n` +
      `Trades: ${wallet.totalTrades} | Win Rate: ${(wallet.winRate * 100).toFixed(1)}%`
    );

    return { success: true, message: 'Wallet removed successfully' };
  }

  /**
   * Get all tracked alpha wallets
   */
  async getWallets(includeRemoved: boolean = false): Promise<AlphaWallet[]> {
    return Database.getAllAlphaWallets(includeRemoved);
  }

  /**
   * Get wallet details by address
   */
  async getWalletByAddress(address: string): Promise<AlphaWallet | null> {
    return Database.getAlphaWalletByAddress(address);
  }

  /**
   * Get active alpha wallets for signal generation
   */
  async getActiveWallets(): Promise<AlphaWallet[]> {
    return Database.getActiveAlphaWallets();
  }

  /**
   * Check if an address is tracked as an alpha wallet
   */
  async isTracked(address: string): Promise<boolean> {
    return Database.isAlphaWalletTracked(address);
  }

  /**
   * Get signal weight for a wallet address
   */
  async getSignalWeight(address: string): Promise<number> {
    const wallet = await Database.getAlphaWalletByAddress(address);
    if (!wallet) return 0;

    // Suspended/removed wallets have 0 weight
    if (wallet.status === AlphaWalletStatus.SUSPENDED ||
        wallet.status === AlphaWalletStatus.REMOVED) {
      return 0;
    }

    return wallet.signalWeight;
  }

  /**
   * Format wallets list for Telegram display
   */
  formatWalletsList(wallets: AlphaWallet[]): string {
    if (wallets.length === 0) {
      return 'No alpha wallets tracked yet.\n\nUse /addwallet <address> to add a wallet.';
    }

    const statusEmoji: Record<string, string> = {
      PROBATION: '',
      ACTIVE: '',
      TRUSTED: '',
      SUSPENDED: '',
      REMOVED: '',
    };

    let message = '*Alpha Wallets*\n\n';

    for (const wallet of wallets) {
      const emoji = statusEmoji[wallet.status] || '';
      const shortAddr = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`;
      const completedRoundTrips = wallet.wins + wallet.losses;
      const winRateStr = completedRoundTrips > 0
        ? `${(wallet.winRate * 100).toFixed(0)}%`
        : 'N/A';

      message += `${emoji} \`${shortAddr}\``;
      if (wallet.label) message += ` (${wallet.label})`;
      message += `\n`;
      message += `   Status: ${wallet.status} | Weight: ${(wallet.signalWeight * 100).toFixed(0)}%\n`;
      message += `   Trades: ${wallet.totalTrades} detected`;
      if (completedRoundTrips > 0) {
        message += ` | ${completedRoundTrips} round-trips | Win: ${winRateStr}`;
      }
      message += `\n\n`;
    }

    const probation = wallets.filter(w => w.status === 'PROBATION').length;
    const active = wallets.filter(w => w.status === 'ACTIVE').length;
    const trusted = wallets.filter(w => w.status === 'TRUSTED').length;
    const suspended = wallets.filter(w => w.status === 'SUSPENDED').length;

    message += `_Summary: ${trusted} trusted, ${active} active, ${probation} probation, ${suspended} suspended_\n`;
    message += `_Promotion requires ${THRESHOLDS.PROBATION_TRADES}+ completed round-trips_`;

    return message;
  }

  /**
   * Format single wallet details for Telegram
   */
  formatWalletDetails(wallet: AlphaWallet): string {
    const statusEmoji: Record<string, string> = {
      PROBATION: '',
      ACTIVE: '',
      TRUSTED: '',
      SUSPENDED: '',
      REMOVED: '',
    };

    const emoji = statusEmoji[wallet.status] || '';

    let message = `${emoji} *Alpha Wallet Details*\n\n`;
    message += `Address: \`${wallet.address}\`\n`;
    if (wallet.label) message += `Label: ${wallet.label}\n`;
    message += `\n`;
    message += `*Status:* ${wallet.status}\n`;
    message += `*Signal Weight:* ${(wallet.signalWeight * 100).toFixed(0)}%\n`;
    message += `\n`;
    message += `*Performance (30d):*\n`;
    message += `  Trades: ${wallet.totalTrades}\n`;
    message += `  Wins: ${wallet.wins} | Losses: ${wallet.losses}\n`;
    message += `  Win Rate: ${(wallet.winRate * 100).toFixed(1)}%\n`;
    message += `  Avg ROI: ${wallet.avgRoi.toFixed(1)}%\n`;
    message += `\n`;
    message += `Added: ${wallet.addedAt.toLocaleDateString()}\n`;

    if (wallet.lastTradeAt) {
      message += `Last Trade: ${wallet.lastTradeAt.toLocaleDateString()}\n`;
    }

    if (wallet.status === AlphaWalletStatus.SUSPENDED) {
      message += `\n_Suspended at: ${wallet.suspendedAt?.toLocaleDateString()}_\n`;
      message += `_Suspension count: ${wallet.suspensionCount}_`;
    }

    return message;
  }

  // ============ TRADE MONITORING ============

  /**
   * Start periodic trade monitoring
   */
  private startTradeMonitoring(): void {
    // Monitor every 5 minutes
    const INTERVAL_MS = 5 * 60 * 1000;

    this.tradeMonitorTimer = setInterval(async () => {
      try {
        await this.monitorTrades();
      } catch (error) {
        logger.error({ error }, 'Error in trade monitoring');
      }
    }, INTERVAL_MS);

    logger.info('Alpha wallet trade monitoring started (5 min interval)');
  }

  /**
   * Monitor trades for all active alpha wallets
   */
  private async monitorTrades(): Promise<void> {
    const wallets = await Database.getActiveAlphaWallets();

    for (const wallet of wallets) {
      try {
        await this.monitorWalletTrades(wallet);
      } catch (error) {
        logger.warn({ error, address: wallet.address }, 'Error monitoring wallet trades');
      }
    }
  }

  /**
   * Monitor trades for a single wallet
   * Uses Helius Enhanced Transactions API for reliable swap detection.
   * Falls back to raw RPC parsing with WSOL support if enhanced API fails.
   */
  private async monitorWalletTrades(wallet: AlphaWallet): Promise<void> {
    if (appConfig.heliusDisabled) return;

    // Try Helius Enhanced Transactions API first (pre-parsed swaps)
    const enhancedTxs = await heliusClient.getEnhancedTransactions(wallet.address, 20);

    if (enhancedTxs.length > 0) {
      for (const tx of enhancedTxs) {
        try {
          const trade = this.parseEnhancedTransaction(tx, wallet);
          if (!trade) continue;
          await this.recordTrade(wallet, trade);
        } catch (error) {
          logger.debug({ error, signature: tx.signature }, 'Error parsing enhanced transaction');
        }
      }
      return;
    }

    // Fallback: raw RPC with WSOL-aware parsing
    const txs = await heliusClient.getRecentTransactions(wallet.address, 20);
    for (const tx of txs) {
      try {
        const txDetails = await heliusClient.getTransaction(tx.signature);
        if (!txDetails) continue;
        const trade = this.parseSwapTransaction(txDetails, wallet);
        if (!trade) continue;
        await this.recordTrade(wallet, trade);
      } catch (error) {
        logger.debug({ error, signature: tx.signature }, 'Error parsing transaction');
      }
    }
  }

  // Wrapped SOL mint address
  private static readonly WSOL_MINT = 'So11111111111111111111111111111111111111112';

  /**
   * Parse a Helius Enhanced Transaction (pre-parsed swap data).
   * The enhanced API returns tokenTransfers and nativeTransfers directly.
   */
  private parseEnhancedTransaction(
    tx: any,
    wallet: AlphaWallet
  ): {
    tokenAddress: string;
    tokenTicker: string | null;
    tradeType: 'BUY' | 'SELL';
    solAmount: number;
    tokenAmount: number;
    priceAtTrade: number;
    txSignature: string;
    timestamp: Date;
  } | null {
    try {
      const tokenTransfers = tx.tokenTransfers || [];
      const nativeTransfers = tx.nativeTransfers || [];
      const signature = tx.signature;
      const timestamp = new Date(tx.timestamp * 1000);

      // Find token transfers involving this wallet (excluding WSOL/SOL)
      const walletTokenIn = tokenTransfers.filter(
        (t: any) => t.toUserAccount === wallet.address && t.mint !== AlphaWalletManager.WSOL_MINT
      );
      const walletTokenOut = tokenTransfers.filter(
        (t: any) => t.fromUserAccount === wallet.address && t.mint !== AlphaWalletManager.WSOL_MINT
      );

      // Calculate SOL flow (native + WSOL combined)
      let solIn = 0;
      let solOut = 0;

      // Native SOL transfers
      for (const nt of nativeTransfers) {
        if (nt.toUserAccount === wallet.address) solIn += (nt.amount || 0) / 1e9;
        if (nt.fromUserAccount === wallet.address) solOut += (nt.amount || 0) / 1e9;
      }

      // WSOL token transfers
      const wsolIn = tokenTransfers.filter(
        (t: any) => t.toUserAccount === wallet.address && t.mint === AlphaWalletManager.WSOL_MINT
      );
      const wsolOut = tokenTransfers.filter(
        (t: any) => t.fromUserAccount === wallet.address && t.mint === AlphaWalletManager.WSOL_MINT
      );
      for (const w of wsolIn) solIn += (w.tokenAmount || 0);
      for (const w of wsolOut) solOut += (w.tokenAmount || 0);

      // BUY: token coming in, SOL going out
      if (walletTokenIn.length > 0 && solOut > 0.01) {
        const tokenTx = walletTokenIn[0];
        const tokenAmount = tokenTx.tokenAmount || 0;
        const solAmount = solOut - solIn; // net SOL spent
        if (solAmount < 0.01) return null;

        return {
          tokenAddress: tokenTx.mint,
          tokenTicker: null,
          tradeType: 'BUY',
          solAmount: Math.abs(solAmount),
          tokenAmount,
          priceAtTrade: Math.abs(solAmount) / tokenAmount,
          txSignature: signature,
          timestamp,
        };
      }

      // SELL: token going out, SOL coming in
      if (walletTokenOut.length > 0 && solIn > 0.01) {
        const tokenTx = walletTokenOut[0];
        const tokenAmount = tokenTx.tokenAmount || 0;
        const solAmount = solIn - solOut; // net SOL received
        if (solAmount < 0.01) return null;

        return {
          tokenAddress: tokenTx.mint,
          tokenTicker: null,
          tradeType: 'SELL',
          solAmount: Math.abs(solAmount),
          tokenAmount,
          priceAtTrade: Math.abs(solAmount) / tokenAmount,
          txSignature: signature,
          timestamp,
        };
      }

      return null;
    } catch (error) {
      logger.debug({ error }, 'Error parsing enhanced transaction');
      return null;
    }
  }

  /**
   * Fallback: Parse swap transaction from raw RPC data.
   * Handles both native SOL and WSOL token balance changes.
   */
  private parseSwapTransaction(
    txDetails: any,
    wallet: AlphaWallet
  ): {
    tokenAddress: string;
    tokenTicker: string | null;
    tradeType: 'BUY' | 'SELL';
    solAmount: number;
    tokenAmount: number;
    priceAtTrade: number;
    txSignature: string;
    timestamp: Date;
  } | null {
    try {
      const preBalances = txDetails.meta?.preTokenBalances || [];
      const postBalances = txDetails.meta?.postTokenBalances || [];
      const accountKeys = txDetails.transaction?.message?.accountKeys || [];

      // Calculate SOL change: native balance + WSOL token balance combined
      const walletIndex = accountKeys.findIndex((k: any) =>
        (typeof k === 'string' ? k : k.pubkey) === wallet.address
      );

      let solChange = 0;

      // Native SOL change
      if (walletIndex >= 0) {
        const preSol = (txDetails.meta?.preBalances?.[walletIndex] || 0) / 1e9;
        const postSol = (txDetails.meta?.postBalances?.[walletIndex] || 0) / 1e9;
        solChange += postSol - preSol;
      }

      // WSOL token balance change (this is where most DEX SOL flow happens)
      for (const postBal of postBalances) {
        if (postBal.owner !== wallet.address) continue;
        if (postBal.mint !== AlphaWalletManager.WSOL_MINT) continue;

        const preBal = preBalances.find(
          (pb: any) => pb.mint === AlphaWalletManager.WSOL_MINT && pb.owner === wallet.address
        );
        const preAmount = preBal?.uiTokenAmount?.uiAmount || 0;
        const postAmount = postBal.uiTokenAmount?.uiAmount || 0;
        solChange += postAmount - preAmount;
      }

      // Also check if WSOL account was created (not in preBalances) or closed (not in postBalances)
      for (const preBal of preBalances) {
        if (preBal.owner !== wallet.address) continue;
        if (preBal.mint !== AlphaWalletManager.WSOL_MINT) continue;
        const stillExists = postBalances.some(
          (pb: any) => pb.mint === AlphaWalletManager.WSOL_MINT && pb.owner === wallet.address
        );
        if (!stillExists) {
          // WSOL account was closed — SOL was reclaimed (already reflected in native balance)
        }
      }

      // Find non-SOL token changes for this wallet
      for (const postBalance of postBalances) {
        if (postBalance.owner !== wallet.address) continue;
        if (postBalance.mint === AlphaWalletManager.WSOL_MINT) continue;

        const preBalance = preBalances.find(
          (pb: any) => pb.mint === postBalance.mint && pb.owner === wallet.address
        );

        const preBal = preBalance?.uiTokenAmount?.uiAmount || 0;
        const postBal = postBalance.uiTokenAmount?.uiAmount || 0;
        const tokenChange = postBal - preBal;

        if (Math.abs(tokenChange) < 0.0001) continue;

        // Determine trade type using combined SOL change
        const isBuy = tokenChange > 0 && solChange < -0.005;
        const isSell = tokenChange < 0 && solChange > 0.005;

        if (!isBuy && !isSell) continue;

        const tokenAddress = postBalance.mint;
        const solAmount = Math.abs(solChange);
        const tokenAmount = Math.abs(tokenChange);

        if (solAmount < 0.01) continue;

        return {
          tokenAddress,
          tokenTicker: null,
          tradeType: isBuy ? 'BUY' : 'SELL',
          solAmount,
          tokenAmount,
          priceAtTrade: solAmount / tokenAmount,
          txSignature: txDetails.transaction.signatures[0],
          timestamp: new Date(txDetails.blockTime * 1000),
        };
      }

      return null;
    } catch (error) {
      logger.debug({ error }, 'Error parsing swap transaction');
      return null;
    }
  }

  /**
   * Record a trade and calculate ROI for sells
   */
  private async recordTrade(
    wallet: AlphaWallet,
    trade: {
      tokenAddress: string;
      tokenTicker: string | null;
      tradeType: 'BUY' | 'SELL';
      solAmount: number;
      tokenAmount: number;
      priceAtTrade: number;
      txSignature: string;
      timestamp: Date;
    }
  ): Promise<void> {
    let entryTradeId: string | undefined;
    let roi: number | undefined;
    let isWin: boolean | undefined;
    let holdTimeHours: number | undefined;

    // For sells, link to entry trade and calculate ROI
    if (trade.tradeType === 'SELL') {
      const openBuys = await Database.getOpenBuyTrades(wallet.id, trade.tokenAddress);

      if (openBuys.length > 0) {
        // Use FIFO - match with oldest buy
        const entryTrade = openBuys[0];
        entryTradeId = entryTrade.id;

        // Calculate ROI
        const entryValue = entryTrade.solAmount;
        const exitValue = trade.solAmount;
        roi = ((exitValue - entryValue) / entryValue) * 100;
        isWin = roi >= THRESHOLDS.WIN_THRESHOLD_ROI;

        // Calculate hold time
        const entryTime = new Date(entryTrade.timestamp).getTime();
        const exitTime = trade.timestamp.getTime();
        holdTimeHours = (exitTime - entryTime) / (1000 * 60 * 60);
      }
    }

    await Database.recordAlphaWalletTrade({
      walletId: wallet.id,
      walletAddress: wallet.address,
      tokenAddress: trade.tokenAddress,
      tokenTicker: trade.tokenTicker || undefined,
      tradeType: trade.tradeType,
      solAmount: trade.solAmount,
      tokenAmount: trade.tokenAmount,
      priceAtTrade: trade.priceAtTrade,
      txSignature: trade.txSignature,
      timestamp: trade.timestamp,
      entryTradeId,
      roi,
      isWin,
      holdTimeHours,
    });

    logger.debug({
      wallet: wallet.address.slice(0, 8),
      type: trade.tradeType,
      token: trade.tokenAddress.slice(0, 8),
      sol: trade.solAmount.toFixed(2),
      roi: roi?.toFixed(1),
    }, 'Alpha wallet trade recorded');

    // Feed BUY tokens into discovery pipeline for signal generation
    if (trade.tradeType === 'BUY' && trade.solAmount >= 0.1) {
      this.alphaDiscoveredTokens.set(trade.tokenAddress, {
        walletAddress: wallet.address,
        walletLabel: wallet.label,
        solAmount: trade.solAmount,
        txSignature: trade.txSignature,
        discoveredAt: Date.now(),
      });

      logger.info({
        wallet: wallet.address.slice(0, 8),
        label: wallet.label,
        token: trade.tokenAddress.slice(0, 8),
        sol: trade.solAmount.toFixed(2),
        status: wallet.status,
      }, 'Alpha wallet BUY detected — token added to signal pipeline');
    }
  }

  // ============ PERFORMANCE EVALUATION ============

  /**
   * Start periodic performance evaluation
   */
  private startPeriodicEvaluation(): void {
    // Evaluate every hour
    const INTERVAL_MS = 60 * 60 * 1000;

    this.evaluationTimer = setInterval(async () => {
      try {
        await this.evaluateAllWallets();
      } catch (error) {
        logger.error({ error }, 'Error in periodic evaluation');
      }
    }, INTERVAL_MS);

    logger.info('Alpha wallet evaluation started (1 hour interval)');
  }

  /**
   * Evaluate all active alpha wallets
   */
  async evaluateAllWallets(): Promise<AlphaWalletEvaluation[]> {
    const wallets = await Database.getAllAlphaWallets(false);
    const evaluations: AlphaWalletEvaluation[] = [];

    for (const wallet of wallets) {
      if (wallet.status === AlphaWalletStatus.REMOVED) continue;

      try {
        const evaluation = await this.evaluateWallet(wallet);
        if (evaluation) {
          evaluations.push(evaluation);
        }
      } catch (error) {
        logger.warn({ error, address: wallet.address }, 'Error evaluating wallet');
      }
    }

    return evaluations;
  }

  /**
   * Evaluate a single wallet and update its status
   */
  async evaluateWallet(wallet: AlphaWallet): Promise<AlphaWalletEvaluation | null> {
    // Get trades in evaluation window
    const trades = await Database.getAlphaWalletTradesInWindow(
      wallet.id,
      THRESHOLDS.EVALUATION_WINDOW_DAYS
    );

    // Calculate performance metrics
    // totalRawTrades = all detected trades (buys + sells)
    // completedTrades = round-trips with ROI (buy matched with sell)
    const totalRawTrades = trades.length;
    const completedTrades = trades.filter(t => t.roi !== null);
    const totalTrades = completedTrades.length;
    const wins = completedTrades.filter(t => t.isWin).length;
    const losses = totalTrades - wins;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const avgRoi = totalTrades > 0
      ? completedTrades.reduce((sum, t) => sum + (t.roi || 0), 0) / totalTrades
      : 0;

    // Update performance metrics in DB
    // Store totalRawTrades so the display shows actual activity even before round-trips complete
    await Database.updateAlphaWalletPerformance(
      wallet.id,
      totalRawTrades,
      wins,
      losses,
      winRate,
      avgRoi
    );

    // Determine new status
    const previousStatus = wallet.status as AlphaWalletStatus;
    let newStatus: AlphaWalletStatus;
    let newWeight: number;
    let recommendation: 'KEEP' | 'WARN' | 'SUSPEND' | 'REMOVE';
    let reason: string;

    // Status transition logic (win rate based)
    if (totalTrades < THRESHOLDS.PROBATION_TRADES) {
      // Still in probation - not enough trades
      newStatus = AlphaWalletStatus.PROBATION;
      newWeight = THRESHOLDS.PROBATION_WEIGHT;
      recommendation = 'KEEP';
      reason = `Probation: ${totalTrades}/${THRESHOLDS.PROBATION_TRADES} trades completed`;
    } else if (winRate >= THRESHOLDS.TRUSTED_WIN_RATE) {
      // Excellent performance - TRUSTED
      newStatus = AlphaWalletStatus.TRUSTED;
      newWeight = THRESHOLDS.TRUSTED_WEIGHT;
      recommendation = 'KEEP';
      reason = `Win rate ${(winRate * 100).toFixed(1)}% exceeds trusted threshold`;
    } else if (winRate >= THRESHOLDS.ACTIVE_WIN_RATE) {
      // Good performance - ACTIVE
      newStatus = AlphaWalletStatus.ACTIVE;
      newWeight = THRESHOLDS.ACTIVE_WEIGHT;
      recommendation = 'KEEP';
      reason = `Win rate ${(winRate * 100).toFixed(1)}% meets active threshold`;
    } else if (winRate >= THRESHOLDS.SUSPEND_WIN_RATE) {
      // Marginal performance - warn but keep active
      newStatus = AlphaWalletStatus.ACTIVE;
      newWeight = THRESHOLDS.ACTIVE_WEIGHT * 0.75; // Reduced weight
      recommendation = 'WARN';
      reason = `Win rate ${(winRate * 100).toFixed(1)}% approaching suspension threshold`;
    } else {
      // Poor performance - suspend or remove
      if (wallet.suspensionCount >= THRESHOLDS.MAX_SUSPENSIONS) {
        newStatus = AlphaWalletStatus.REMOVED;
        newWeight = 0;
        recommendation = 'REMOVE';
        reason = `Win rate ${(winRate * 100).toFixed(1)}% below threshold after ${wallet.suspensionCount} suspensions`;
      } else {
        newStatus = AlphaWalletStatus.SUSPENDED;
        newWeight = THRESHOLDS.SUSPENDED_WEIGHT;
        recommendation = 'SUSPEND';
        reason = `Win rate ${(winRate * 100).toFixed(1)}% below ${(THRESHOLDS.SUSPEND_WIN_RATE * 100).toFixed(0)}% threshold`;
      }
    }

    // ROI profitability override: high avg ROI wallets stay active despite low win rate
    // A "big game hunter" pattern (few wins but each win is massive) is still very profitable
    if (totalTrades >= THRESHOLDS.ROI_OVERRIDE_MIN_TRADES && avgRoi > 0) {
      if (avgRoi >= THRESHOLDS.ROI_OVERRIDE_TRUSTED &&
          (newStatus === AlphaWalletStatus.SUSPENDED || newStatus === AlphaWalletStatus.ACTIVE || recommendation === 'WARN')) {
        newStatus = AlphaWalletStatus.TRUSTED;
        newWeight = THRESHOLDS.TRUSTED_WEIGHT;
        recommendation = 'KEEP';
        reason = `ROI override: ${avgRoi.toFixed(0)}% avg ROI (win rate ${(winRate * 100).toFixed(1)}% below threshold but highly profitable)`;
      } else if (avgRoi >= THRESHOLDS.ROI_OVERRIDE_ACTIVE &&
                 (newStatus === AlphaWalletStatus.SUSPENDED || newStatus === AlphaWalletStatus.REMOVED)) {
        newStatus = AlphaWalletStatus.ACTIVE;
        newWeight = THRESHOLDS.ACTIVE_WEIGHT;
        recommendation = 'KEEP';
        reason = `ROI override: ${avgRoi.toFixed(0)}% avg ROI (win rate ${(winRate * 100).toFixed(1)}% below threshold but profitable)`;
      }
    }

    // Check if suspended wallet can recover
    if (previousStatus === AlphaWalletStatus.SUSPENDED && wallet.suspendedAt) {
      const daysSinceSuspension = (Date.now() - wallet.suspendedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceSuspension >= THRESHOLDS.SUSPENSION_RECOVERY_DAYS) {
        if (winRate >= THRESHOLDS.ACTIVE_WIN_RATE ||
            (totalTrades >= THRESHOLDS.ROI_OVERRIDE_MIN_TRADES && avgRoi >= THRESHOLDS.ROI_OVERRIDE_ACTIVE)) {
          newStatus = AlphaWalletStatus.ACTIVE;
          newWeight = THRESHOLDS.ACTIVE_WEIGHT;
          recommendation = 'KEEP';
          reason = winRate >= THRESHOLDS.ACTIVE_WIN_RATE
            ? `Recovered from suspension with ${(winRate * 100).toFixed(1)}% win rate`
            : `Recovered from suspension with ${avgRoi.toFixed(0)}% avg ROI (profitable despite low win rate)`;
        } else {
          // Failed to recover
          newStatus = AlphaWalletStatus.REMOVED;
          newWeight = 0;
          recommendation = 'REMOVE';
          reason = `Failed to recover during ${THRESHOLDS.SUSPENSION_RECOVERY_DAYS} day suspension period`;
        }
      }
    }

    // Only update if status changed
    if (newStatus !== previousStatus || Math.abs(newWeight - wallet.signalWeight) > 0.01) {
      await Database.updateAlphaWalletStatus(wallet.id, newStatus, newWeight);

      // Log evaluation
      await Database.logAlphaWalletEvaluation({
        walletId: wallet.id,
        walletAddress: wallet.address,
        previousStatus,
        newStatus,
        winRate,
        totalTrades,
        avgRoi,
        recommendation,
        reason,
      });

      // Send notification for significant status changes
      if (newStatus !== previousStatus) {
        await this.notifyStatusChange(wallet, previousStatus, newStatus, reason);
      }

      logger.info({
        address: wallet.address.slice(0, 8),
        previousStatus,
        newStatus,
        winRate: (winRate * 100).toFixed(1),
        totalTrades,
      }, 'Alpha wallet status updated');

      return {
        walletId: wallet.id,
        address: wallet.address,
        previousStatus,
        newStatus,
        winRate,
        totalTrades,
        avgRoi,
        recommendation,
        reason,
      };
    }

    return null;
  }

  // ============ NOTIFICATIONS ============

  /**
   * Send notification via callback
   */
  private async notify(message: string): Promise<void> {
    if (this.notifyCallback) {
      try {
        await this.notifyCallback(message);
      } catch (error) {
        logger.warn({ error }, 'Failed to send notification');
      }
    }
  }

  /**
   * Send status change notification
   */
  private async notifyStatusChange(
    wallet: AlphaWallet,
    previousStatus: AlphaWalletStatus,
    newStatus: AlphaWalletStatus,
    reason: string
  ): Promise<void> {
    const emoji: Record<string, string> = {
      PROBATION: '',
      ACTIVE: '',
      TRUSTED: '',
      SUSPENDED: '',
      REMOVED: '',
    };

    const shortAddr = `${wallet.address.slice(0, 8)}...${wallet.address.slice(-6)}`;

    let message = `${emoji[newStatus]} *Alpha Wallet Status Change*\n\n`;
    message += `Address: \`${shortAddr}\`\n`;
    if (wallet.label) message += `Label: ${wallet.label}\n`;
    message += `\n`;
    message += `${previousStatus} \u2192 ${newStatus}\n`;
    message += `\n`;
    message += `Trades: ${wallet.totalTrades}\n`;
    message += `Win Rate: ${(wallet.winRate * 100).toFixed(1)}%\n`;
    message += `Avg ROI: ${wallet.avgRoi.toFixed(1)}%\n`;
    message += `\n`;
    message += `_${reason}_`;

    await this.notify(message);
  }

  // ============ VALIDATION ============

  /**
   * Validate Solana address format
   */
  private validateAddress(address: string): ValidationResult {
    if (!address || typeof address !== 'string') {
      return { isValid: false, error: 'Address is required' };
    }

    const trimmed = address.trim();

    if (!SOLANA_ADDRESS_REGEX.test(trimmed)) {
      return { isValid: false, error: 'Invalid Solana address format' };
    }

    return { isValid: true };
  }

  /**
   * Validate wallet exists on-chain
   */
  private async validateWalletOnChain(address: string): Promise<boolean> {
    // Skip when Helius is disabled - allow wallets without verification
    if (appConfig.heliusDisabled) {
      return true;
    }

    try {
      const accountInfo = await heliusClient.getAccountInfo(address);
      return accountInfo !== null;
    } catch {
      // If we can't verify, allow it anyway (network issues shouldn't block)
      return true;
    }
  }

  // ============ CLEANUP ============

  /**
   * Stop the manager
   */
  stop(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    if (this.tradeMonitorTimer) {
      clearInterval(this.tradeMonitorTimer);
      this.tradeMonitorTimer = null;
    }
    logger.info('Alpha Wallet Manager stopped');
  }
}

// ============ EXPORTS ============

export const alphaWalletManager = new AlphaWalletManager();

export default {
  AlphaWalletManager,
  alphaWalletManager,
  THRESHOLDS,
};
