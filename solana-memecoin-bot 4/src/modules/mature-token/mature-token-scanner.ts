// ===========================================
// MATURE TOKEN SCANNER
// Main orchestrator for mature token signal generation
// Targets tokens 24hrs - 14 days old
// ===========================================

import { logger } from '../../utils/logger.js';
import { Database, pool } from '../../utils/database.js';
import { getTokenMetrics, dexScreenerClient, birdeyeClient } from '../onchain.js';
import { tokenSafetyChecker } from '../safety/token-safety-checker.js';
import { matureTokenScorer } from './mature-token-scorer.js';
import { matureTokenTelegram } from './telegram-formatter.js';
import {
  MatureTokenSignal,
  MatureTokenExitSignal,
  MatureTokenWatchlist,
  MatureSignalType,
  ExitRecommendation,
  DEFAULT_MATURE_TOKEN_CONFIG,
  DEFAULT_ELIGIBILITY,
  TokenTier,
  TIER_CONFIG,
  TAKE_PROFIT_CONFIG,
  POSITION_CONFIG,
  getTokenTier,
  getStopLossForTier,
  getPositionSize,
} from './types.js';
import { TokenMetrics } from '../../types/index.js';

// ============ CONSTANTS ============

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SIGNAL_EXPIRY_HOURS = 24;

// ============ CLASS ============

export class MatureTokenScanner {
  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private config = DEFAULT_MATURE_TOKEN_CONFIG;
  private eligibility = DEFAULT_ELIGIBILITY;

  // Track signals and watchlist
  private activeSignals: Map<string, MatureTokenSignal> = new Map();
  private watchlist: Map<string, MatureTokenWatchlist> = new Map();
  private signalCooldowns: Map<string, number> = new Map();

  // Rate limiting
  private signalsThisHour = 0;
  private signalsToday = 0;
  private lastHourReset = Date.now();
  private lastDayReset = Date.now();

  // Funnel stats for /funnel command
  private funnelStats = {
    fetched: 0,
    passedAge: 0,
    eligible: 0,
    evaluated: 0,
    signalsSent: 0,
    rejections: {
      tooYoung: 0,
      tooOld: 0,
      marketCap: 0,
      noTier: 0,
      volume: 0,
      holders: 0,
      liquidity: 0,
      concentration: 0,
      cooldown: 0,
      score: 0,
      safety: 0,
    },
    tiers: { RISING: 0, EMERGING: 0, GRADUATED: 0, ESTABLISHED: 0 },
    lastScanTime: '',
  };

  /**
   * Initialize the scanner
   */
  async initialize(): Promise<void> {
    logger.info('Initializing mature token scanner...');

    // Load config from database if available
    await this.loadConfig();

    // Load active signals and watchlist from database
    await this.loadActiveSignals();
    await this.loadWatchlist();

    logger.info({
      scanInterval: this.config.scanIntervalMinutes,
      tokenAgeRange: this.config.tokenAgeRange,
      activeSignals: this.activeSignals.size,
      watchlistSize: this.watchlist.size,
    }, 'Mature token scanner initialized');
  }

  /**
   * Start the scanning loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Mature token scanner already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting mature token scanning loop');

    // Run immediately, then on interval
    this.runScanCycle();
    this.scanTimer = setInterval(
      () => this.runScanCycle(),
      this.config.scanIntervalMinutes * 60 * 1000
    );
  }

  /**
   * Stop the scanning loop
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    logger.info('Mature token scanner stopped');
  }

  /**
   * Get funnel stats for /funnel command
   */
  getFunnelStats() {
    return { ...this.funnelStats };
  }

  /**
   * Run a single scan cycle
   */
  private async runScanCycle(): Promise<void> {
    try {
      // Reset rate limits if needed
      this.resetRateLimitsIfNeeded();

      // Reset funnel stats for this cycle
      this.funnelStats.rejections = {
        tooYoung: 0, tooOld: 0, marketCap: 0, noTier: 0, volume: 0,
        holders: 0, liquidity: 0, concentration: 0, cooldown: 0, score: 0, safety: 0,
      };
      this.funnelStats.tiers = { RISING: 0, EMERGING: 0, GRADUATED: 0, ESTABLISHED: 0 };

      // Step 1: Get candidate tokens (mature tokens)
      const candidates = await this.getCandidateTokens();
      this.funnelStats.passedAge = candidates.length;
      logger.info({ count: candidates.length }, 'Mature token candidates found');

      // Step 2: Filter by eligibility
      const eligible = await this.filterEligibleTokens(candidates);
      this.funnelStats.eligible = eligible.length;
      logger.info({ count: eligible.length }, 'Eligible mature tokens');

      // Step 3: Score and evaluate each token
      let signalsSent = 0;
      let watchlistAdded = 0;
      let blocked = 0;
      const evaluated = Math.min(eligible.length, this.config.maxTokensPerScan);
      this.funnelStats.evaluated = evaluated;

      for (const token of eligible.slice(0, this.config.maxTokensPerScan)) {
        try {
          const result = await this.evaluateToken(token);
          if (result === 'SIGNAL_SENT') signalsSent++;
          else if (result === 'WATCHLIST_ADDED') watchlistAdded++;
          else if (result === 'BLOCKED') {
            blocked++;
            this.funnelStats.rejections.safety++;
          } else if (result === 'SKIPPED') {
            this.funnelStats.rejections.score++;
          }
        } catch (error) {
          logger.error({ error, tokenAddress: token.address }, 'Error evaluating mature token');
        }
      }

      this.funnelStats.signalsSent = signalsSent;
      this.funnelStats.lastScanTime = new Date().toLocaleTimeString();

      // Step 4: Check for exit signals on active positions
      await this.checkExitSignals();

      // Step 5: Check watchlist for promotion
      await this.checkWatchlistPromotions();

      logger.info({
        candidates: candidates.length,
        eligible: eligible.length,
        evaluated,
        signalsSent,
        watchlistAdded,
        blocked,
        skipped: evaluated - signalsSent - watchlistAdded - blocked,
        activeSignals: this.activeSignals.size,
        watchlistSize: this.watchlist.size,
      }, '✅ Mature token scan cycle complete');

    } catch (error) {
      logger.error({ error }, 'Error in mature token scan cycle');
    }
  }

  /**
   * Get candidate tokens (24hrs - 14 days old)
   */
  private async getCandidateTokens(): Promise<TokenMetrics[]> {
    const candidates: TokenMetrics[] = [];
    let fetchedCount = 0;
    let metricsFailedCount = 0;
    let tooYoungCount = 0;
    let tooOldCount = 0;

    try {
      // Get trending tokens from DexScreener
      const trendingAddresses = await dexScreenerClient.getTrendingSolanaTokens(200);
      fetchedCount = trendingAddresses.length;

      // Get metrics for each and filter by age
      const minAgeMinutes = this.eligibility.minTokenAgeHours * 60;
      const maxAgeMinutes = this.eligibility.maxTokenAgeDays * 24 * 60;

      for (const address of trendingAddresses) {
        try {
          const metrics = await getTokenMetrics(address);
          if (!metrics) {
            metricsFailedCount++;
            continue;
          }

          // Check age range
          if (metrics.tokenAge < minAgeMinutes) {
            tooYoungCount++;
            continue;
          }
          if (metrics.tokenAge > maxAgeMinutes) {
            tooOldCount++;
            continue;
          }

          candidates.push(metrics);
        } catch {
          metricsFailedCount++;
        }
      }

      // Update funnel stats
      this.funnelStats.fetched = fetchedCount;
      this.funnelStats.rejections.tooYoung = tooYoungCount;
      this.funnelStats.rejections.tooOld = tooOldCount;

      logger.info({
        fetched: fetchedCount,
        metricsRetrieved: fetchedCount - metricsFailedCount,
        tooYoung: tooYoungCount,
        tooOld: tooOldCount,
        passedAgeFilter: candidates.length,
        minAgeHours: this.eligibility.minTokenAgeHours,
        maxAgeDays: this.eligibility.maxTokenAgeDays,
      }, '📊 FUNNEL: Age filter results');

    } catch (error) {
      logger.error({ error }, 'Failed to get mature token candidates');
    }

    return candidates;
  }

  /**
   * Filter tokens by eligibility criteria
   * Updated for Established Token Strategy v2 with tier-based filtering
   */
  private async filterEligibleTokens(tokens: TokenMetrics[]): Promise<TokenMetrics[]> {
    const eligible: TokenMetrics[] = [];

    // Track rejection reasons
    const rejections = {
      marketCapOutOfRange: 0,
      noTierMatch: 0,
      volumeTooLow: 0,
      holdersTooLow: 0,
      ageTooYoung: 0,
      liquidityTooLow: 0,
      liquidityRatioTooLow: 0,
      concentrationTooHigh: 0,
      onCooldown: 0,
    };

    // Track tier distribution
    const tierCounts: Record<string, number> = { RISING: 0, EMERGING: 0, GRADUATED: 0, ESTABLISHED: 0 };

    for (const token of tokens) {
      // Market cap check (must be in one of our tiers)
      if (token.marketCap < this.eligibility.minMarketCap ||
          token.marketCap > this.eligibility.maxMarketCap) {
        rejections.marketCapOutOfRange++;
        continue;
      }

      // Determine tier and check tier-specific volume requirement
      const tier = getTokenTier(token.marketCap);
      if (!tier) {
        rejections.noTierMatch++;
        continue;  // Outside all tiers (gap between $5M-$8M)
      }

      tierCounts[tier]++;
      const tierConfig = TIER_CONFIG[tier];

      // Tier-specific volume check
      if (token.volume24h < tierConfig.minVolume24h) {
        rejections.volumeTooLow++;
        continue;
      }

      // Tier-specific holder count check
      if (token.holderCount < tierConfig.minHolderCount) {
        rejections.holdersTooLow++;
        continue;
      }

      // Tier-specific token age check
      if (token.tokenAge && token.tokenAge < tierConfig.minTokenAgeHours) {
        rejections.ageTooYoung++;
        continue;
      }

      // Liquidity check
      if (token.liquidityPool < this.eligibility.minLiquidity) {
        rejections.liquidityTooLow++;
        continue;
      }

      const liquidityRatio = token.liquidityPool / token.marketCap;
      if (liquidityRatio < this.eligibility.minLiquidityRatio) {
        rejections.liquidityRatioTooLow++;
        continue;
      }

      // Concentration check
      if (token.top10Concentration > this.eligibility.maxTop10Concentration) {
        rejections.concentrationTooHigh++;
        continue;
      }

      // Check cooldown
      const cooldown = this.signalCooldowns.get(token.address);
      if (cooldown && Date.now() - cooldown < this.config.rateLimits.tokenCooldownHours * 60 * 60 * 1000) {
        rejections.onCooldown++;
        continue;
      }

      eligible.push(token);
    }

    // Update funnel stats
    this.funnelStats.rejections.marketCap = rejections.marketCapOutOfRange;
    this.funnelStats.rejections.noTier = rejections.noTierMatch;
    this.funnelStats.rejections.volume = rejections.volumeTooLow;
    this.funnelStats.rejections.holders = rejections.holdersTooLow;
    this.funnelStats.rejections.liquidity = rejections.liquidityTooLow + rejections.liquidityRatioTooLow;
    this.funnelStats.rejections.concentration = rejections.concentrationTooHigh;
    this.funnelStats.rejections.cooldown = rejections.onCooldown;
    this.funnelStats.tiers = tierCounts as { RISING: number; EMERGING: number; GRADUATED: number; ESTABLISHED: number };

    logger.info({
      input: tokens.length,
      eligible: eligible.length,
      rejections,
      tierDistribution: tierCounts,
    }, '📊 FUNNEL: Eligibility filter results');

    return eligible;
  }

  /**
   * Evaluate a single token
   */
  private async evaluateToken(
    metrics: TokenMetrics
  ): Promise<'SIGNAL_SENT' | 'WATCHLIST_ADDED' | 'BLOCKED' | 'SKIPPED'> {
    // Check if already tracking
    if (this.activeSignals.has(metrics.address)) {
      return 'SKIPPED';
    }

    // Safety check first
    const safetyResult = await tokenSafetyChecker.checkTokenSafety(metrics.address);
    const safetyBlock = tokenSafetyChecker.shouldBlockSignal(safetyResult);

    if (safetyBlock.blocked) {
      logger.debug({ tokenAddress: metrics.address, reason: safetyBlock.reason }, 'Mature token blocked by safety');
      return 'BLOCKED';
    }

    // Calculate comprehensive score
    const {
      score,
      accumulationMetrics,
      breakoutMetrics,
      holderDynamics,
      volumeProfile,
      smartMoneyMetrics,
      kolReentryMetrics,
    } = await matureTokenScorer.calculateScore(
      metrics.address,
      metrics,
      metrics.price
    );

    // Log score for visibility
    logger.info({
      ticker: metrics.ticker,
      address: metrics.address.slice(0, 8),
      compositeScore: score.compositeScore,
      recommendation: score.recommendation,
      confidence: score.confidence,
      accumulationScore: score.accumulationScore,
      breakoutScore: score.breakoutScore,
      safetyScore: score.contractSafetyScore,
      marketCap: `$${(metrics.marketCap / 1_000_000).toFixed(2)}M`,
      holders: metrics.holderCount,
    }, '📊 FUNNEL: Token scored');

    // Determine action
    if (!matureTokenScorer.meetsSignalThreshold(score)) {
      logger.info({
        ticker: metrics.ticker,
        compositeScore: score.compositeScore,
        requiredScore: 50,
        reason: score.compositeScore < 50 ? 'score_too_low' : 'sub_threshold_not_met',
      }, '📊 FUNNEL: Token rejected - below signal threshold');
      return 'SKIPPED';
    }

    // Check rate limits
    if (!this.canSendSignal()) {
      // Add to watchlist instead
      await this.addToWatchlist(metrics, score);
      return 'WATCHLIST_ADDED';
    }

    // Determine signal type
    const signalType = this.determineSignalType(
      accumulationMetrics,
      breakoutMetrics,
      smartMoneyMetrics,
      kolReentryMetrics
    );

    // Build and send signal
    const signal = this.buildSignal(
      metrics,
      score,
      signalType,
      accumulationMetrics,
      breakoutMetrics,
      holderDynamics,
      volumeProfile,
      smartMoneyMetrics,
      kolReentryMetrics
    );

    // Send via Telegram
    await matureTokenTelegram.sendMatureTokenSignal(signal);

    // Track signal
    this.activeSignals.set(metrics.address, signal);
    this.signalCooldowns.set(metrics.address, Date.now());
    this.signalsThisHour++;
    this.signalsToday++;

    // Log to database
    await this.logSignal(signal);

    logger.info({
      tokenAddress: metrics.address,
      ticker: metrics.ticker,
      signalType,
      compositeScore: score.compositeScore,
      recommendation: score.recommendation,
    }, 'Mature token signal sent');

    return 'SIGNAL_SENT';
  }

  /**
   * Determine signal type from metrics
   */
  private determineSignalType(
    accumulation: any,
    breakout: any,
    smartMoney: any,
    kolMetrics: any
  ): MatureSignalType {
    // Priority order for signal types

    // Multi-KOL conviction
    if (kolMetrics.kolBuys24h >= 2) {
      return MatureSignalType.MULTI_KOL_CONVICTION;
    }

    // Active breakout
    if (breakout.volumeExpansion >= 2.5 && breakout.priceVelocity5m > 0.5) {
      return MatureSignalType.VOLUME_BREAKOUT;
    }

    // KOL reentry
    if (kolMetrics.tier1KolCount >= 1 || kolMetrics.kolBuys24h >= 1) {
      return MatureSignalType.KOL_REENTRY;
    }

    // Smart money accumulation
    if (smartMoney.whaleAccumulation >= 3 || smartMoney.smartMoneyInflow24h >= 25000) {
      return MatureSignalType.SMART_MONEY_ACCUMULATION;
    }

    // Accumulation breakout
    if (accumulation.accumulationScore >= 60 && breakout.breakoutScore >= 40) {
      return MatureSignalType.ACCUMULATION_BREAKOUT;
    }

    // Default to accumulation breakout
    return MatureSignalType.ACCUMULATION_BREAKOUT;
  }

  /**
   * Build the signal object
   * Updated for Established Token Strategy v2 with tier-based TP/SL
   */
  private buildSignal(
    metrics: TokenMetrics,
    score: any,
    signalType: MatureSignalType,
    accumulation: any,
    breakout: any,
    holderDynamics: any,
    volumeProfile: any,
    smartMoney: any,
    kolMetrics: any
  ): MatureTokenSignal {
    const price = metrics.price;

    // Determine token tier
    const tier = getTokenTier(metrics.marketCap) || TokenTier.EMERGING;

    // Get tier-specific stop loss
    const stopLossPercent = getStopLossForTier(tier, 0);  // Initial stop loss

    // Get position size based on signal strength
    const positionConfig = getPositionSize(score.compositeScore);
    const positionSize = positionConfig.sizePercent;

    // Risk level (1-5) based on tier
    let riskLevel = 3;
    if (tier === TokenTier.ESTABLISHED) riskLevel = 2;
    else if (tier === TokenTier.GRADUATED) riskLevel = 3;
    else if (tier === TokenTier.EMERGING) riskLevel = 4;
    else if (tier === TokenTier.RISING) riskLevel = 5;  // Highest risk due to smaller mcap

    // Adjust risk level by score
    if (score.compositeScore >= 80) riskLevel = Math.max(1, riskLevel - 1);

    return {
      id: `mature_${Date.now()}_${metrics.address.slice(0, 8)}`,
      tokenAddress: metrics.address,
      tokenTicker: metrics.ticker,
      tokenName: metrics.name,

      signalType,
      score,
      confidence: score.confidence,
      riskLevel,

      // Token tier for this signal
      tier,

      tokenAgeHours: Math.round(metrics.tokenAge / 60),
      tokenAgeDays: Math.round(metrics.tokenAge / 60 / 24),

      accumulationMetrics: accumulation,
      breakoutMetrics: breakout,
      holderDynamics,
      volumeProfile,
      smartMoneyMetrics: smartMoney,
      kolReentryMetrics: kolMetrics,

      currentPrice: price,
      marketCap: metrics.marketCap,
      volume24h: metrics.volume24h,
      liquidity: metrics.liquidityPool,
      holderCount: metrics.holderCount,
      top10Concentration: metrics.top10Concentration,

      entryZone: {
        low: price * 0.97,
        high: price * 1.03,
      },
      positionSizePercent: positionSize,

      // Tier-based stop loss
      stopLoss: {
        price: price * (1 - stopLossPercent / 100),
        percent: stopLossPercent,
      },

      // Updated take profit targets (same for all tiers)
      takeProfit1: {
        price: price * (1 + TAKE_PROFIT_CONFIG.tp1.percent / 100),
        percent: TAKE_PROFIT_CONFIG.tp1.percent,
      },
      takeProfit2: {
        price: price * (1 + TAKE_PROFIT_CONFIG.tp2.percent / 100),
        percent: TAKE_PROFIT_CONFIG.tp2.percent,
      },
      takeProfit3: {
        price: price * (1 + TAKE_PROFIT_CONFIG.tp3.percent / 100),
        percent: TAKE_PROFIT_CONFIG.tp3.percent,
      },

      // Shorter hold time for established token strategy
      maxHoldDays: 2,  // 48 hours max (was 7 days)

      generatedAt: new Date(),
      expiresAt: new Date(Date.now() + SIGNAL_EXPIRY_HOURS * 60 * 60 * 1000),
    };
  }

  /**
   * Check for exit signals on active positions
   */
  private async checkExitSignals(): Promise<void> {
    for (const [address, signal] of this.activeSignals) {
      try {
        const currentMetrics = await getTokenMetrics(address);
        if (!currentMetrics) continue;

        const exitSignal = await this.evaluateExitConditions(signal, currentMetrics);
        if (exitSignal) {
          await matureTokenTelegram.sendExitSignal(exitSignal);
          this.activeSignals.delete(address);
        }
      } catch (error) {
        logger.error({ error, tokenAddress: address }, 'Error checking exit signal');
      }
    }
  }

  /**
   * Evaluate exit conditions
   */
  private async evaluateExitConditions(
    signal: MatureTokenSignal,
    currentMetrics: TokenMetrics
  ): Promise<MatureTokenExitSignal | null> {
    const currentPrice = currentMetrics.price;
    const entryPrice = signal.currentPrice;
    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    const holdTimeHours = (Date.now() - signal.generatedAt.getTime()) / (1000 * 60 * 60);

    const triggers: string[] = [];
    let recommendation: ExitRecommendation = ExitRecommendation.HOLD;
    let urgency: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';

    // Stop loss hit
    if (currentPrice <= signal.stopLoss.price) {
      triggers.push('STOP_LOSS_HIT');
      recommendation = ExitRecommendation.FULL_EXIT;
      urgency = 'HIGH';
    }

    // Take profit hits
    if (currentPrice >= signal.takeProfit3.price) {
      triggers.push('TP3_HIT');
      recommendation = ExitRecommendation.FULL_EXIT;
      urgency = 'MEDIUM';
    } else if (currentPrice >= signal.takeProfit2.price) {
      triggers.push('TP2_HIT');
      recommendation = ExitRecommendation.PARTIAL_EXIT_50;
      urgency = 'MEDIUM';
    } else if (currentPrice >= signal.takeProfit1.price) {
      triggers.push('TP1_HIT');
      recommendation = ExitRecommendation.PARTIAL_EXIT_25;
      urgency = 'LOW';
    }

    // Time limit
    if (holdTimeHours >= signal.maxHoldDays * 24) {
      triggers.push('MAX_HOLD_TIME_REACHED');
      if (recommendation === ExitRecommendation.HOLD) {
        recommendation = pnlPercent > 0 ? ExitRecommendation.PARTIAL_EXIT_50 : ExitRecommendation.FULL_EXIT;
        urgency = 'MEDIUM';
      }
    }

    // Volume collapse
    if (currentMetrics.volume24h < signal.volume24h * 0.3) {
      triggers.push('VOLUME_COLLAPSED');
      if (recommendation === ExitRecommendation.HOLD) {
        recommendation = ExitRecommendation.MOVE_STOP;
        urgency = 'MEDIUM';
      }
    }

    if (triggers.length === 0) {
      return null;
    }

    return {
      id: `exit_${Date.now()}_${signal.tokenAddress.slice(0, 8)}`,
      tokenAddress: signal.tokenAddress,
      tokenTicker: signal.tokenTicker,
      recommendation,
      urgency,
      reason: triggers.join(', '),
      triggers,
      entryPrice: signal.currentPrice,
      currentPrice,
      pnlPercent,
      pnlUsd: 0, // Would calculate based on position size
      holdTimeHours,
      originalSignalId: signal.id,
      originalSignalType: signal.signalType,
      generatedAt: new Date(),
    };
  }

  /**
   * Check watchlist for promotion to signals
   */
  private async checkWatchlistPromotions(): Promise<void> {
    for (const [address, item] of this.watchlist) {
      try {
        const metrics = await getTokenMetrics(address);
        if (!metrics) continue;

        // Re-evaluate score
        const { score } = await matureTokenScorer.calculateScore(
          address,
          metrics,
          metrics.price
        );

        // Check if now meets signal threshold
        if (score.compositeScore >= item.targetScore && this.canSendSignal()) {
          // Remove from watchlist
          this.watchlist.delete(address);

          // Trigger full evaluation
          await this.evaluateToken(metrics);
        }
      } catch (error) {
        logger.debug({ error, tokenAddress: address }, 'Error checking watchlist item');
      }
    }
  }

  /**
   * Add token to watchlist
   */
  private async addToWatchlist(metrics: TokenMetrics, score: any): Promise<void> {
    const item: MatureTokenWatchlist = {
      id: `watch_${Date.now()}_${metrics.address.slice(0, 8)}`,
      tokenAddress: metrics.address,
      tokenTicker: metrics.ticker,
      addedReason: `Score ${score.compositeScore} - approaching threshold`,
      currentScore: score.compositeScore,
      targetScore: 60, // BUY threshold
      targetConditions: ['Score >= 60', 'Strong accumulation', 'Volume breakout'],
      resistanceLevel: metrics.price * 1.2,
      supportLevel: metrics.price * 0.85,
      breakoutTarget: metrics.price * 1.5,
      volumeTrigger: metrics.volume24h * 2,
      addedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      lastCheckedAt: new Date(),
    };

    this.watchlist.set(metrics.address, item);

    // Send watchlist alert
    await matureTokenTelegram.sendWatchlistAlert(item);
  }

  /**
   * Check if can send signal (rate limits)
   */
  private canSendSignal(): boolean {
    return (
      this.signalsThisHour < this.config.rateLimits.maxSignalsPerHour &&
      this.signalsToday < this.config.rateLimits.maxSignalsPerDay
    );
  }

  /**
   * Reset rate limits if needed
   */
  private resetRateLimitsIfNeeded(): void {
    const now = Date.now();

    // Reset hourly
    if (now - this.lastHourReset >= 60 * 60 * 1000) {
      this.signalsThisHour = 0;
      this.lastHourReset = now;
    }

    // Reset daily
    if (now - this.lastDayReset >= 24 * 60 * 60 * 1000) {
      this.signalsToday = 0;
      this.lastDayReset = now;
    }
  }

  /**
   * Load config from database
   */
  private async loadConfig(): Promise<void> {
    // Would load from database in production
  }

  /**
   * Load active signals from database
   */
  private async loadActiveSignals(): Promise<void> {
    try {
      const result = await pool.query(`
        SELECT * FROM mature_token_signals
        WHERE expires_at > NOW()
        ORDER BY sent_at DESC
      `);

      for (const row of result.rows) {
        // Reconstruct signal from database
        // Simplified - would parse full signal in production
      }
    } catch (error) {
      // Table might not exist yet
      logger.debug({ error }, 'Could not load active signals (table may not exist)');
    }
  }

  /**
   * Load watchlist from database
   */
  private async loadWatchlist(): Promise<void> {
    try {
      const result = await pool.query(`
        SELECT * FROM mature_token_watchlist
        WHERE expires_at > NOW()
        ORDER BY added_at DESC
      `);

      for (const row of result.rows) {
        // Reconstruct watchlist item
        // Simplified - would parse full item in production
      }
    } catch (error) {
      // Table might not exist yet
      logger.debug({ error }, 'Could not load watchlist (table may not exist)');
    }
  }

  /**
   * Log signal to database
   */
  private async logSignal(signal: MatureTokenSignal): Promise<void> {
    try {
      await Database.saveMatureTokenSignal({
        tokenAddress: signal.tokenAddress,
        tokenTicker: signal.tokenTicker,
        tokenName: signal.tokenName,
        signalType: signal.signalType,
        compositeScore: signal.score.compositeScore,
        accumulationScore: signal.score.accumulationScore,
        breakoutScore: signal.score.breakoutScore,
        holderDynamicsScore: signal.score.holderDynamicsScore,
        volumeAuthenticityScore: signal.score.volumeAuthenticityScore,
        smartMoneyScore: signal.score.smartMoneyScore,
        kolActivityScore: signal.score.kolActivityScore,
        contractSafetyScore: signal.score.contractSafetyScore,
        confidence: signal.score.confidence,
        recommendation: signal.score.recommendation,
        riskLevel: signal.riskLevel,
        tokenAgeHours: signal.tokenAgeHours,
        currentPrice: signal.currentPrice,
        marketCap: signal.marketCap,
        volume24h: signal.volume24h,
        liquidity: signal.liquidity,
        holderCount: signal.holderCount,
        top10Concentration: signal.top10Concentration,
        entryZoneLow: signal.entryZone.low,
        entryZoneHigh: signal.entryZone.high,
        positionSizePercent: signal.positionSizePercent,
        stopLossPrice: signal.stopLoss.price,
        stopLossPercent: signal.stopLoss.percent,
        takeProfit1Price: signal.takeProfit1.price,
        takeProfit1Percent: signal.takeProfit1.percent,
        takeProfit2Price: signal.takeProfit2.price,
        takeProfit2Percent: signal.takeProfit2.percent,
        takeProfit3Price: signal.takeProfit3.price,
        takeProfit3Percent: signal.takeProfit3.percent,
        maxHoldDays: signal.maxHoldDays,
        bullishSignals: signal.score.bullishSignals,
        bearishSignals: signal.score.bearishSignals,
        warnings: signal.score.warnings,
        expiresAt: signal.expiresAt,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to log mature token signal');
    }
  }

  /**
   * Get scanner stats
   */
  getStats(): {
    isRunning: boolean;
    activeSignals: number;
    watchlistSize: number;
    signalsThisHour: number;
    signalsToday: number;
  } {
    return {
      isRunning: this.isRunning,
      activeSignals: this.activeSignals.size,
      watchlistSize: this.watchlist.size,
      signalsThisHour: this.signalsThisHour,
      signalsToday: this.signalsToday,
    };
  }
}

// ============ EXPORTS ============

export const matureTokenScanner = new MatureTokenScanner();

export default {
  MatureTokenScanner,
  matureTokenScanner,
};
