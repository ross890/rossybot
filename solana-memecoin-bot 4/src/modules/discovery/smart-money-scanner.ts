// ===========================================
// MODULE: SMART MONEY SCANNER
// Auto-discovers profitable traders from on-chain data
// Replicates KOLScan functionality using Helius
// ===========================================

import { Database } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { heliusClient, dexScreenerClient } from '../onchain.js';
import { alphaWalletManager } from '../alpha/alpha-wallet-manager.js';
import { appConfig } from '../../config/index.js';

// ============ TYPES ============

export enum DiscoverySource {
  PUMPFUN_TRADER = 'PUMPFUN_TRADER',
  RAYDIUM_TRADER = 'RAYDIUM_TRADER',
  EARLY_BUYER = 'EARLY_BUYER',
  HIGH_WIN_RATE = 'HIGH_WIN_RATE',
  WHALE_TRACKER = 'WHALE_TRACKER',
  REFERRAL = 'REFERRAL',
}

export enum SmartMoneyStatus {
  MONITORING = 'MONITORING',
  EVALUATING = 'EVALUATING',
  PROMOTED = 'PROMOTED',
  REJECTED = 'REJECTED',
  INACTIVE = 'INACTIVE',
}

interface SmartMoneyCandidate {
  id: string;
  address: string;
  discoverySource: DiscoverySource;
  status: SmartMoneyStatus;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgRoi: number;
  totalProfitSol: number;
  uniqueTokensTraded: number;
  avgEntryTimingPercentile: number;
  evaluationScore: number;
  promotionEligible: boolean;
}

interface TradeObservation {
  walletAddress: string;
  tokenAddress: string;
  tokenTicker?: string;
  tradeType: 'BUY' | 'SELL';
  solAmount: number;
  tokenAmount: number;
  priceAtTrade: number;
  tokenAgeAtTrade?: number;
  txSignature: string;
  blockTime: Date;
}

// ============ CONFIGURATION ============

export const SMART_MONEY_THRESHOLDS = {
  // Minimum criteria to be tracked as a candidate
  MIN_TRADE_SIZE_SOL: 0.5,         // Only track trades >= 0.5 SOL
  MAX_CANDIDATES: 500,             // Max candidates to monitor (oldest dropped)

  // Evaluation thresholds - loosened for faster signal
  MIN_TRADES_FOR_EVALUATION: 3,    // 3 trades (was 10)
  MIN_UNIQUE_TOKENS: 2,            // 2 different tokens (was 5)

  // Promotion thresholds - loosened for memecoins
  PROMOTE_WIN_RATE: 0.35,          // 35%+ win rate is great in memecoins (was 50%)
  PROMOTE_MIN_PROFIT_SOL: 1,       // 1+ SOL profit (was 5)
  PROMOTE_CONSISTENCY_MAX: 150,    // Max ROI std dev (lower = more consistent)

  // Rejection thresholds - loosened
  REJECT_WIN_RATE: 0.15,           // Below 15% = reject (was 30%)
  REJECT_MAX_LOSS_SOL: -25,        // Lost more than 25 SOL = reject (was -10)

  // Win/Loss definition (same as KOL system)
  WIN_THRESHOLD_ROI: 100,          // 100% ROI = 2x = win

  // Timing
  EVALUATION_INTERVAL_MS: 30 * 60 * 1000,  // Evaluate every 30 minutes
  TRADE_SCAN_INTERVAL_MS: 5 * 60 * 1000,   // Scan for trades every 5 minutes
  INACTIVITY_DAYS: 14,             // Mark inactive if no trades in 14 days

  // Discovery settings
  HIGH_VOLUME_THRESHOLD_SOL: 10,   // Wallet trading 10+ SOL considered high volume
  EARLY_BUYER_PERCENTILE: 10,      // Top 10% of buyers = early
};

// ============ SMART MONEY SCANNER CLASS ============

export class SmartMoneyScanner {
  private isRunning = false;
  private evaluationTimer: NodeJS.Timeout | null = null;
  private tradeScanTimer: NodeJS.Timeout | null = null;

  // In-memory cache of recent trades to avoid duplicates
  private recentTradeSignatures: Set<string> = new Set();
  private maxRecentTrades = 10000;

  // Notification callback
  private notifyCallback: ((message: string) => Promise<void>) | null = null;

  /**
   * Initialize the smart money scanner
   */
  async initialize(): Promise<void> {
    logger.info('Initializing Smart Money Scanner...');

    // Load existing candidates into memory
    const stats = await Database.getSmartMoneyStats();
    logger.info({
      totalCandidates: stats.totalCandidates,
      monitoring: stats.monitoring,
      promoted: stats.promoted,
      avgWinRate: (stats.avgWinRate * 100).toFixed(1) + '%',
    }, 'Smart Money Scanner initialized');
  }

  /**
   * Start the scanner
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Smart Money Scanner already running');
      return;
    }

    this.isRunning = true;

    // Start evaluation loop
    this.evaluationTimer = setInterval(
      () => this.runEvaluationCycle(),
      SMART_MONEY_THRESHOLDS.EVALUATION_INTERVAL_MS
    );

    // Start trade scanning loop
    this.tradeScanTimer = setInterval(
      () => this.scanRecentTrades(),
      SMART_MONEY_THRESHOLDS.TRADE_SCAN_INTERVAL_MS
    );

    // Run initial scan
    this.scanRecentTrades();

    logger.info('Smart Money Scanner started');
  }

  /**
   * Stop the scanner
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }

    if (this.tradeScanTimer) {
      clearInterval(this.tradeScanTimer);
      this.tradeScanTimer = null;
    }

    logger.info('Smart Money Scanner stopped');
  }

  /**
   * Set notification callback for Telegram alerts
   */
  setNotifyCallback(callback: (message: string) => Promise<void>): void {
    this.notifyCallback = callback;
  }

  // ============ TRADE OBSERVATION ============

  /**
   * Observe a trade from any source
   * This is called when we see a profitable trade anywhere in the system
   */
  async observeTrade(trade: TradeObservation): Promise<void> {
    // Skip small trades
    if (trade.solAmount < SMART_MONEY_THRESHOLDS.MIN_TRADE_SIZE_SOL) {
      return;
    }

    // Skip if we've seen this trade
    if (this.recentTradeSignatures.has(trade.txSignature)) {
      return;
    }

    // Add to recent trades cache
    this.recentTradeSignatures.add(trade.txSignature);
    if (this.recentTradeSignatures.size > this.maxRecentTrades) {
      // Remove oldest entries (convert to array, slice, convert back)
      const arr = Array.from(this.recentTradeSignatures);
      this.recentTradeSignatures = new Set(arr.slice(-this.maxRecentTrades / 2));
    }

    // Check if wallet is already being tracked as KOL or alpha
    const isKol = await Database.getWalletByAddress(trade.walletAddress);
    const isAlpha = await Database.isAlphaWalletTracked(trade.walletAddress);

    if (isKol || isAlpha) {
      return; // Already tracked elsewhere
    }

    // Get or create candidate
    let candidate = await Database.getSmartMoneyCandidateByAddress(trade.walletAddress);

    if (!candidate) {
      // Determine discovery source based on trade characteristics
      let source = DiscoverySource.RAYDIUM_TRADER;
      let reason = `First observed trade: ${trade.solAmount.toFixed(2)} SOL`;

      if (trade.solAmount >= SMART_MONEY_THRESHOLDS.HIGH_VOLUME_THRESHOLD_SOL) {
        source = DiscoverySource.WHALE_TRACKER;
        reason = `High volume trade: ${trade.solAmount.toFixed(2)} SOL`;
      } else if (trade.tokenAgeAtTrade && trade.tokenAgeAtTrade < 10) {
        source = DiscoverySource.EARLY_BUYER;
        reason = `Early buyer: token age ${trade.tokenAgeAtTrade} mins`;
      }

      // Create candidate
      const result = await Database.createSmartMoneyCandidate(
        trade.walletAddress,
        source,
        reason
      );

      if (result.isNew) {
        logger.info({
          address: trade.walletAddress.slice(0, 8),
          source,
          reason,
        }, 'New smart money candidate discovered');
      }

      candidate = await Database.getSmartMoneyCandidateByAddress(trade.walletAddress);
    }

    if (!candidate || candidate.status === SmartMoneyStatus.PROMOTED) {
      return; // Already promoted, tracked via alpha wallet
    }

    // Record the trade
    await this.recordCandidateTrade(candidate.id, trade);
  }

  /**
   * Record a trade for a candidate and calculate ROI for sells
   */
  private async recordCandidateTrade(
    candidateId: string,
    trade: TradeObservation
  ): Promise<void> {
    let entryTradeId: string | undefined;
    let roi: number | undefined;
    let isWin: boolean | undefined;
    let holdTimeHours: number | undefined;

    // For sells, link to entry trade and calculate ROI
    if (trade.tradeType === 'SELL') {
      const openBuys = await Database.getSmartMoneyOpenBuys(candidateId, trade.tokenAddress);

      if (openBuys.length > 0) {
        // FIFO - match with oldest buy
        const entryTrade = openBuys[0];
        entryTradeId = entryTrade.id;

        // Calculate ROI
        const entryValue = entryTrade.solAmount;
        const exitValue = trade.solAmount;
        roi = ((exitValue - entryValue) / entryValue) * 100;
        isWin = roi >= SMART_MONEY_THRESHOLDS.WIN_THRESHOLD_ROI;

        // Calculate hold time
        const entryTime = new Date(entryTrade.blockTime).getTime();
        const exitTime = trade.blockTime.getTime();
        holdTimeHours = (exitTime - entryTime) / (1000 * 60 * 60);
      }
    }

    await Database.recordSmartMoneyTrade({
      candidateId,
      walletAddress: trade.walletAddress,
      tokenAddress: trade.tokenAddress,
      tokenTicker: trade.tokenTicker,
      tradeType: trade.tradeType,
      solAmount: trade.solAmount,
      tokenAmount: trade.tokenAmount,
      priceAtTrade: trade.priceAtTrade,
      tokenAgeAtTrade: trade.tokenAgeAtTrade,
      txSignature: trade.txSignature,
      blockTime: trade.blockTime,
      entryTradeId,
      roi,
      isWin,
      holdTimeHours,
    });

    logger.debug({
      candidate: trade.walletAddress.slice(0, 8),
      type: trade.tradeType,
      token: trade.tokenAddress.slice(0, 8),
      sol: trade.solAmount.toFixed(2),
      roi: roi?.toFixed(1),
    }, 'Smart money trade recorded');
  }

  // ============ TRADE SCANNING ============

  /**
   * Scan recent high-value trades to discover smart money
   */
  private async scanRecentTrades(): Promise<void> {
    try {
      // Get trending tokens from DexScreener
      const trendingTokens = await dexScreenerClient.getTrendingSolanaTokens(20);

      for (const tokenAddress of trendingTokens) {
        try {
          await this.scanTokenTrades(tokenAddress);
        } catch (error) {
          logger.debug({ error, tokenAddress }, 'Error scanning token trades');
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error in trade scanning cycle');
    }
  }

  /**
   * Scan trades for a specific token
   */
  private async scanTokenTrades(tokenAddress: string): Promise<void> {
    // Skip when Helius is disabled
    if (appConfig.heliusDisabled) {
      return;
    }

    // Get recent transactions for this token using the token address
    const txs = await heliusClient.getRecentTransactions(tokenAddress, 50);

    for (const tx of txs) {
      try {
        const trade = await this.parseTradeFromTransaction(tx, tokenAddress);
        if (trade) {
          await this.observeTrade(trade);
        }
      } catch (error) {
        // Silently skip parsing errors
      }
    }
  }

  /**
   * Parse a trade from a Helius transaction
   */
  private async parseTradeFromTransaction(
    tx: any,
    tokenAddress: string
  ): Promise<TradeObservation | null> {
    try {
      // Get full transaction details
      const txDetails = await heliusClient.getTransaction(tx.signature);
      if (!txDetails) return null;

      const preBalances = txDetails.meta?.preTokenBalances || [];
      const postBalances = txDetails.meta?.postTokenBalances || [];
      const accountKeys = txDetails.transaction?.message?.accountKeys || [];

      // Find wallets with token balance changes
      for (const postBalance of postBalances) {
        if (postBalance.mint !== tokenAddress) continue;

        const owner = postBalance.owner;
        if (!owner) continue;

        const preBalance = preBalances.find(
          (pb: any) => pb.mint === tokenAddress && pb.owner === owner
        );

        const preBal = preBalance?.uiTokenAmount?.uiAmount || 0;
        const postBal = postBalance.uiTokenAmount?.uiAmount || 0;
        const tokenChange = postBal - preBal;

        if (Math.abs(tokenChange) < 0.0001) continue;

        // Calculate SOL change
        const walletIndex = accountKeys.findIndex((k: any) =>
          (typeof k === 'string' ? k : k.pubkey) === owner
        );

        if (walletIndex < 0) continue;

        const preSol = (txDetails.meta?.preBalances?.[walletIndex] || 0) / 1e9;
        const postSol = (txDetails.meta?.postBalances?.[walletIndex] || 0) / 1e9;
        const solChange = postSol - preSol;

        // Determine trade type
        const isBuy = tokenChange > 0 && solChange < 0;
        const isSell = tokenChange < 0 && solChange > 0;

        if (!isBuy && !isSell) continue;

        const solAmount = Math.abs(solChange);
        const tokenAmount = Math.abs(tokenChange);

        // Skip very small trades
        if (solAmount < SMART_MONEY_THRESHOLDS.MIN_TRADE_SIZE_SOL) continue;

        // Calculate price
        const priceAtTrade = solAmount / tokenAmount;

        return {
          walletAddress: owner,
          tokenAddress,
          tradeType: isBuy ? 'BUY' : 'SELL',
          solAmount,
          tokenAmount,
          priceAtTrade,
          txSignature: tx.signature,
          blockTime: new Date(txDetails.blockTime * 1000),
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  // ============ EVALUATION & PROMOTION ============

  /**
   * Run evaluation cycle for all candidates
   */
  private async runEvaluationCycle(): Promise<void> {
    try {
      // Get candidates ready for evaluation
      const candidates = await Database.getSmartMoneyCandidatesForEvaluation(
        SMART_MONEY_THRESHOLDS.MIN_TRADES_FOR_EVALUATION
      );

      logger.info({ count: candidates.length }, 'Running smart money evaluation cycle');

      for (const candidate of candidates) {
        try {
          await this.evaluateCandidate(candidate);
        } catch (error) {
          logger.error({ error, address: candidate.address }, 'Error evaluating candidate');
        }
      }

      // Check for inactive candidates
      await this.markInactiveCandidates();

      // Auto-promote eligible candidates
      await this.autoPromoteCandidates();

    } catch (error) {
      logger.error({ error }, 'Error in evaluation cycle');
    }
  }

  /**
   * Evaluate a single candidate
   */
  private async evaluateCandidate(candidate: SmartMoneyCandidate): Promise<void> {
    // Get trades in evaluation window (30 days)
    const trades = await Database.getSmartMoneyTradesInWindow(candidate.id, 30);

    // Calculate performance metrics
    const completedTrades = trades.filter((t: any) => t.roi !== null);
    const totalTrades = completedTrades.length;
    const wins = completedTrades.filter((t: any) => t.isWin).length;
    const losses = totalTrades - wins;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;

    const allRois = completedTrades.map((t: any) => t.roi || 0);
    const avgRoi = totalTrades > 0
      ? allRois.reduce((sum: number, roi: number) => sum + roi, 0) / totalTrades
      : 0;

    const totalProfitSol = trades.reduce((sum: number, t: any) => {
      if (t.tradeType === 'SELL' && t.roi !== null) {
        // Profit = exit - entry, proportional to entry size
        const entryTrades = trades.filter((et: any) => et.id === t.entryTradeId);
        if (entryTrades.length > 0) {
          const entrySol = entryTrades[0].solAmount;
          return sum + (t.solAmount - entrySol);
        }
      }
      return sum;
    }, 0);

    // Unique tokens traded
    const uniqueTokens = new Set(trades.map((t: any) => t.tokenAddress)).size;

    // ROI consistency (standard deviation)
    const roiMean = avgRoi;
    const roiVariance = totalTrades > 1
      ? allRois.reduce((sum: number, roi: number) => sum + Math.pow(roi - roiMean, 2), 0) / totalTrades
      : 0;
    const consistencyScore = Math.sqrt(roiVariance);

    // Calculate trade size metrics
    const tradeSizes = trades.filter((t: any) => t.tradeType === 'BUY').map((t: any) => t.solAmount);
    const avgTradeSizeSol = tradeSizes.length > 0
      ? tradeSizes.reduce((a: number, b: number) => a + b, 0) / tradeSizes.length
      : 0;
    const minTradeSizeSol = tradeSizes.length > 0 ? Math.min(...tradeSizes) : 0;
    const maxTradeSizeSol = tradeSizes.length > 0 ? Math.max(...tradeSizes) : 0;

    // Largest win/loss
    const largestWinRoi = allRois.length > 0 ? Math.max(...allRois) : 0;
    const largestLossRoi = allRois.length > 0 ? Math.min(...allRois) : 0;

    // Average hold time
    const holdTimes = completedTrades.map((t: any) => t.holdTimeHours || 0).filter((h: number) => h > 0);
    const avgHoldTimeHours = holdTimes.length > 0
      ? holdTimes.reduce((a: number, b: number) => a + b, 0) / holdTimes.length
      : 0;

    // Update performance metrics
    await Database.updateSmartMoneyCandidatePerformance(candidate.id, {
      totalTrades,
      wins,
      losses,
      winRate,
      avgRoi,
      totalProfitSol,
      uniqueTokensTraded: uniqueTokens,
      avgEntryTimingPercentile: candidate.avgEntryTimingPercentile,
      avgHoldTimeHours,
      largestWinRoi,
      largestLossRoi,
      consistencyScore,
      avgTradeSizeSol,
      minTradeSizeSol,
      maxTradeSizeSol,
    });

    // Check thresholds
    const passedWinRate = winRate >= SMART_MONEY_THRESHOLDS.PROMOTE_WIN_RATE;
    const passedMinTrades = totalTrades >= SMART_MONEY_THRESHOLDS.MIN_TRADES_FOR_EVALUATION;
    const passedProfit = totalProfitSol >= SMART_MONEY_THRESHOLDS.PROMOTE_MIN_PROFIT_SOL;
    const passedConsistency = consistencyScore <= SMART_MONEY_THRESHOLDS.PROMOTE_CONSISTENCY_MAX;
    const passedUniqueTokens = uniqueTokens >= SMART_MONEY_THRESHOLDS.MIN_UNIQUE_TOKENS;

    // Calculate evaluation score (0-100)
    let evaluationScore = 0;
    evaluationScore += winRate * 40;  // Win rate contributes up to 40 points
    evaluationScore += Math.min(20, (totalProfitSol / 10) * 20);  // Profit up to 20 points
    evaluationScore += Math.min(20, uniqueTokens * 4);  // Diversity up to 20 points
    evaluationScore += Math.max(0, 20 - consistencyScore / 10);  // Consistency up to 20 points
    evaluationScore = Math.round(evaluationScore);

    // Determine result
    let result: 'PROMOTE' | 'REJECT' | 'CONTINUE_MONITORING' = 'CONTINUE_MONITORING';
    let reason: string;
    let promotionEligible = false;

    if (passedWinRate && passedMinTrades && passedProfit && passedUniqueTokens) {
      result = 'PROMOTE';
      reason = `Excellent performance: ${(winRate * 100).toFixed(0)}% win rate, ${totalProfitSol.toFixed(1)} SOL profit`;
      promotionEligible = true;
    } else if (winRate < SMART_MONEY_THRESHOLDS.REJECT_WIN_RATE && totalTrades >= 15) {
      result = 'REJECT';
      reason = `Poor win rate: ${(winRate * 100).toFixed(0)}% over ${totalTrades} trades`;
    } else if (totalProfitSol < SMART_MONEY_THRESHOLDS.REJECT_MAX_LOSS_SOL) {
      result = 'REJECT';
      reason = `Significant losses: ${totalProfitSol.toFixed(1)} SOL`;
    } else {
      reason = `Monitoring: ${totalTrades} trades, ${(winRate * 100).toFixed(0)}% win rate`;
    }

    // Update status
    const newStatus = result === 'REJECT' ? SmartMoneyStatus.REJECTED : SmartMoneyStatus.MONITORING;

    await Database.updateSmartMoneyCandidateStatus(
      candidate.id,
      newStatus,
      evaluationScore,
      promotionEligible,
      result === 'REJECT' ? reason : undefined
    );

    // Log evaluation
    await Database.logSmartMoneyEvaluation({
      candidateId: candidate.id,
      walletAddress: candidate.address,
      totalTrades,
      winRate,
      avgRoi,
      totalProfitSol,
      uniqueTokens,
      consistencyScore,
      evaluationScore,
      passedWinRate,
      passedMinTrades,
      passedProfit,
      passedConsistency,
      result,
      reason,
    });

    if (result !== 'CONTINUE_MONITORING') {
      logger.info({
        address: candidate.address.slice(0, 8),
        result,
        winRate: (winRate * 100).toFixed(1) + '%',
        profit: totalProfitSol.toFixed(1) + ' SOL',
        trades: totalTrades,
        score: evaluationScore,
      }, 'Smart money candidate evaluated');
    }
  }

  /**
   * Mark candidates with no recent activity as inactive
   */
  private async markInactiveCandidates(): Promise<void> {
    const candidates = await Database.getSmartMoneyCandidatesByStatus(SmartMoneyStatus.MONITORING);

    const now = Date.now();
    const inactivityThreshold = SMART_MONEY_THRESHOLDS.INACTIVITY_DAYS * 24 * 60 * 60 * 1000;

    for (const candidate of candidates) {
      if (candidate.lastTradeSeen) {
        const lastTradeTime = new Date(candidate.lastTradeSeen).getTime();
        if (now - lastTradeTime > inactivityThreshold) {
          await Database.updateSmartMoneyCandidateStatus(
            candidate.id,
            SmartMoneyStatus.INACTIVE,
            undefined,
            false,
            `No activity in ${SMART_MONEY_THRESHOLDS.INACTIVITY_DAYS} days`
          );

          logger.info({
            address: candidate.address.slice(0, 8),
            lastTrade: candidate.lastTradeSeen,
          }, 'Smart money candidate marked inactive');
        }
      }
    }
  }

  /**
   * Auto-promote eligible candidates to alpha wallet tracking
   */
  private async autoPromoteCandidates(): Promise<void> {
    const eligible = await Database.getPromotionEligibleCandidates();

    for (const candidate of eligible) {
      try {
        // Add to alpha wallet system
        const result = await alphaWalletManager.addWallet(
          candidate.address,
          'smart_money_scanner',
          `Auto-discovered: ${candidate.discoverySource}`
        );

        if (result.success && result.walletId) {
          // Mark as promoted
          await Database.promoteSmartMoneyCandidate(candidate.id, result.walletId);

          logger.info({
            address: candidate.address.slice(0, 8),
            winRate: (candidate.winRate * 100).toFixed(1) + '%',
            profit: candidate.totalProfitSol.toFixed(1) + ' SOL',
            trades: candidate.totalTrades,
            source: candidate.discoverySource,
          }, 'Smart money candidate promoted to alpha wallet');

          // Send notification
          await this.notify(
            `*Smart Money Discovered*\n\n` +
            `A high-performing trader has been auto-promoted to tracking!\n\n` +
            `Address: \`${candidate.address.slice(0, 8)}...${candidate.address.slice(-6)}\`\n` +
            `Source: ${candidate.discoverySource}\n` +
            `Win Rate: ${(candidate.winRate * 100).toFixed(1)}%\n` +
            `Profit: ${candidate.totalProfitSol.toFixed(1)} SOL\n` +
            `Trades: ${candidate.totalTrades}\n` +
            `Unique Tokens: ${candidate.uniqueTokensTraded}\n\n` +
            `_Now tracking this wallet for buy signals_`
          );
        }
      } catch (error) {
        logger.error({ error, address: candidate.address }, 'Error promoting candidate');
      }
    }
  }

  // ============ HELPERS ============

  /**
   * Send notification via callback
   */
  private async notify(message: string): Promise<void> {
    if (this.notifyCallback) {
      try {
        await this.notifyCallback(message);
      } catch (error) {
        logger.warn({ error }, 'Failed to send smart money notification');
      }
    }
  }

  /**
   * Get scanner statistics
   */
  async getStats(): Promise<{
    totalCandidates: number;
    monitoring: number;
    promoted: number;
    rejected: number;
    avgWinRate: number;
  }> {
    return Database.getSmartMoneyStats();
  }

  /**
   * Format stats for Telegram display
   */
  async formatStatsMessage(): Promise<string> {
    const stats = await this.getStats();

    let message = '*Smart Money Scanner Stats*\n\n';
    message += `Total Candidates: ${stats.totalCandidates}\n`;
    message += `Monitoring: ${stats.monitoring}\n`;
    message += `Promoted: ${stats.promoted}\n`;
    message += `Rejected: ${stats.rejected}\n`;
    message += `Avg Win Rate: ${(stats.avgWinRate * 100).toFixed(1)}%\n`;

    return message;
  }

  /**
   * Get top performing candidates (for potential manual review)
   */
  async getTopCandidates(limit: number = 10): Promise<SmartMoneyCandidate[]> {
    const candidates = await Database.getSmartMoneyCandidatesByStatus(SmartMoneyStatus.MONITORING);

    // Sort by evaluation score
    return candidates
      .filter((c: SmartMoneyCandidate) => c.totalTrades >= 5)
      .sort((a: SmartMoneyCandidate, b: SmartMoneyCandidate) => b.evaluationScore - a.evaluationScore)
      .slice(0, limit);
  }
}

// ============ EXPORTS ============

export const smartMoneyScanner = new SmartMoneyScanner();

export default {
  SmartMoneyScanner,
  smartMoneyScanner,
  SMART_MONEY_THRESHOLDS,
  DiscoverySource,
  SmartMoneyStatus,
};
