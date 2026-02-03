// ===========================================
// SIGNAL GENERATION ENGINE
// Enhanced with new feature modules
// ===========================================

import { appConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { Database } from '../utils/database.js';
import {
  getTokenMetrics,
  calculateVolumeAuthenticity,
  birdeyeClient,
  dexScreenerClient,
  analyzeCTO,
} from './onchain.js';
import { scamFilter, quickScamCheck } from './scam-filter.js';
import { kolWalletMonitor } from './kol-tracker.js';
import { scoringEngine } from './scoring.js';
import { telegramBot } from './telegram.js';

// New feature modules
import { tokenSafetyChecker } from './safety/token-safety-checker.js';
import { insiderDetector } from './safety/insider-detector.js';
import { convictionTracker } from './signals/conviction-tracker.js';
import { kolSellDetector } from './signals/sell-detector.js';
import { kolAnalytics } from './kol/kol-analytics.js';
import { bondingCurveMonitor } from './pumpfun/bonding-monitor.js';
import { dailyDigestGenerator } from './telegram/daily-digest.js';
import { moonshotAssessor } from './moonshot-assessor.js';

// NEW: On-chain first modules (replacing KOL-dependent logic)
import { momentumAnalyzer } from './momentum-analyzer.js';
import { bundleDetector, BundleAnalysisResult } from './bundle-detector.js';
import { onChainScoringEngine, OnChainScore } from './onchain-scoring.js';
import { smallCapitalManager, SignalQuality } from './small-capital-manager.js';

// Performance tracking and prediction
import { signalPerformanceTracker, thresholdOptimizer, winPredictor, WinPrediction, performanceLogger } from './performance/index.js';

// Social/X integration
import { socialAnalyzer } from './social/index.js';

// Auto-trading integration
import { autoTrader } from './trading/index.js';

// Multi-source token discovery
import { discoveryEngine } from './discovery/index.js';

import {
  TokenMetrics,
  SocialMetrics,
  BuySignal,
  SignalType,
  SignalTrack,
  KolWalletActivity,
  TokenSafetyResult,
  DiscoverySignal,
  MoonshotAssessment,
  DexScreenerTokenInfo,
  CTOAnalysis,
  KolReputationTier,
} from '../types/index.js';

// ============ CONFIGURATION ============

// HIT RATE IMPROVEMENT: Reduced from 60s to 20s
// Analysis shows we're getting front-run by ~35-45 seconds
// 20s scan cycle gives 2-3 opportunities before momentum fades
const SCAN_INTERVAL_MS = 20 * 1000; // 20 seconds (was 60s)
const KOL_ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const DISCOVERY_SIGNAL_EXPIRY_MS = 24 * 60 * 60 * 1000; // Track discovery for 24 hours

// ============ SIGNAL GENERATOR CLASS ============

export class SignalGenerator {
  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;

  // Track discovery signals for KOL follow-up alerts
  private discoverySignals: Map<string, DiscoverySignal> = new Map();
  
  /**
   * Initialize the signal generator
   */
  async initialize(): Promise<void> {
    logger.info('Initializing signal generator...');

    // Initialize Birdeye WebSocket for real-time new listings
    try {
      await birdeyeClient.initWebSocket();
      logger.info('Birdeye WebSocket initialized for real-time token listings');

      // Set up callback for immediate processing of new listings
      birdeyeClient.onNewListing((listing) => {
        logger.info({ token: listing.symbol || listing.address }, 'New token listing detected via WebSocket');
        // Could trigger immediate evaluation here if desired
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize Birdeye WebSocket, will use REST API fallback');
    }

    // Initialize KOL wallet monitor
    await kolWalletMonitor.initialize();

    // Initialize Telegram bot
    await telegramBot.initialize();

    // Initialize Social/X analyzer for real-time social metrics
    try {
      const socialReady = await socialAnalyzer.initialize();
      if (socialReady) {
        logger.info('Social analyzer initialized - X/Twitter integration active');
      } else {
        logger.warn('Social analyzer initialization failed - social metrics will be limited');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize social analyzer - social signals will use fallback data');
    }

    // Initialize Pump.fun bonding curve monitor (Feature 4)
    bondingCurveMonitor.onAlert(async (alert) => {
      const message = bondingCurveMonitor.formatAlertMessage(alert);
      try {
        // Send via Telegram - would need to expose a generic message method
        logger.info({ alert: alert.type, token: alert.token.tokenMint }, 'Pump.fun alert triggered');
      } catch (error) {
        logger.error({ error }, 'Failed to send Pump.fun alert');
      }
    });
    bondingCurveMonitor.start();

    // Initialize daily digest (Feature 8)
    dailyDigestGenerator.onSend(async (message) => {
      // Would send via telegram bot
      logger.info('Daily digest generated');
    });
    dailyDigestGenerator.start(9); // 9 AM

    // Initialize Win Predictor (ML-based prediction)
    try {
      await winPredictor.initialize();
      logger.info('Win Predictor initialized - ML predictions active');
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize Win Predictor - predictions will use defaults');
    }

    // AUDIT FIX: Sync optimizer thresholds to on-chain scoring engine
    // This ensures learned thresholds are used for risk assessment
    try {
      await thresholdOptimizer.loadThresholds();
      const thresholds = thresholdOptimizer.getCurrentThresholds();
      onChainScoringEngine.setDynamicThresholds({
        minSafetyScore: thresholds.minSafetyScore,
        maxBundleRiskScore: thresholds.maxBundleRiskScore,
      });
      logger.info({ thresholds }, 'Threshold optimizer synced with on-chain scoring engine');
    } catch (error) {
      logger.warn({ error }, 'Failed to sync optimizer thresholds');
    }

    // Initialize multi-source token discovery engine
    try {
      await discoveryEngine.initialize();
      logger.info('Discovery engine initialized - multi-source token scanning active');
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize discovery engine - using basic discovery');
    }

    // Initialize performance logger for metrics collection
    try {
      await performanceLogger.initialize();
      logger.info('Performance logger initialized - metrics and logs collection active');
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize performance logger');
    }

    // Log learning mode status prominently
    const learningMode = appConfig.trading.learningMode;
    logger.info({
      learningMode,
      filters: {
        onChainScoreCheck: learningMode ? 'RELAXED (only blocks STRONG_AVOID)' : 'STRICT (blocks AVOID + STRONG_AVOID)',
        mlProbabilityThreshold: learningMode ? '15%' : '25%',
      },
      message: learningMode
        ? '🎓 LEARNING MODE ENABLED - Signal filtering relaxed for ML data collection'
        : '🔒 PRODUCTION MODE - Strict signal filtering active',
    }, 'Signal generator mode configured');

    logger.info('Signal generator initialized with all feature modules');
  }
  
  /**
   * Start the main scanning loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Signal generator already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting signal generation loop');

    // Start discovery engine for multi-source token scanning
    try {
      discoveryEngine.start();
      logger.info('Discovery engine started - volume anomalies, holder growth, and narrative scanning active');
    } catch (error) {
      logger.warn({ error }, 'Failed to start discovery engine');
    }

    // Run immediately, then on interval
    this.runScanCycle();
    this.scanTimer = setInterval(() => this.runScanCycle(), SCAN_INTERVAL_MS);
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

    // Stop discovery engine
    try {
      discoveryEngine.stop();
    } catch {
      // Ignore errors on stop
    }

    // Stop performance logger
    try {
      performanceLogger.stop();
    } catch {
      // Ignore errors on stop
    }

    logger.info('Signal generator stopped');
  }
  
  /**
   * Run a single scan cycle
   */
  private async runScanCycle(): Promise<void> {
    const cycleStartTime = Date.now();
    try {
      // Step 1: Get candidate tokens (new listings + active tokens)
      const candidates = await this.getCandidateTokens();

      // Step 2: Quick pre-filter (contract checks)
      const preFiltered: string[] = [];
      let quickFilterFails = 0;
      for (const address of candidates) {
        const quickCheck = await quickScamCheck(address);
        if (quickCheck.pass) {
          preFiltered.push(address);
        } else {
          quickFilterFails++;
        }
      }

      // Diagnostic logging - show pipeline stats every cycle
      logger.info({
        candidates: candidates.length,
        passed: preFiltered.length,
        failed: quickFilterFails,
      }, '=== SCAN CYCLE: Pre-filter complete, starting token evaluation ===');

      // Step 3: Evaluate each token (KOL signals + on-chain signals)
      let safetyBlocked = 0;
      let noMetrics = 0;
      let screeningFailed = 0;
      let scamRejected = 0;
      let scoringFailed = 0;
      let signalsGenerated = 0;
      let discoverySignals = 0;
      let kolValidationSignals = 0;
      let discoveryFailed = 0;
      let onchainSignals = 0;
      let momentumFailed = 0;
      let bundleBlocked = 0;

      for (const tokenAddress of preFiltered) {
        try {
          const result = await this.evaluateTokenWithDiagnostics(tokenAddress);
          switch (result) {
            case 'SAFETY_BLOCKED': safetyBlocked++; break;
            case 'NO_METRICS': noMetrics++; break;
            case 'SCREENING_FAILED': screeningFailed++; break;
            case 'SCAM_REJECTED': scamRejected++; break;
            case 'SCORING_FAILED': scoringFailed++; break;
            case 'SIGNAL_SENT': signalsGenerated++; break;
            case 'DISCOVERY_SENT': discoverySignals++; break;
            case 'KOL_VALIDATION_SENT': kolValidationSignals++; break;
            case 'DISCOVERY_FAILED': discoveryFailed++; break;
            case 'ONCHAIN_SIGNAL_SENT': onchainSignals++; break;
            case 'MOMENTUM_FAILED': momentumFailed++; break;
            case 'BUNDLE_BLOCKED': bundleBlocked++; break;
            case 'SKIPPED': break; // Already have position
          }
        } catch (error) {
          logger.error({ error, tokenAddress }, 'Error evaluating token');
        }
      }

      // Clean up expired discovery signals
      this.cleanupExpiredDiscoveries();

      // Show where tokens are dropping off
      logger.info({
        evaluated: preFiltered.length,
        safetyBlocked,
        noMetrics,
        screeningFailed,
        scamRejected,
        scoringFailed,
        momentumFailed,
        bundleBlocked,
        discoveryFailed,
        buySignals: signalsGenerated,
        onchainSignals,
        discoveries: discoverySignals,
        kolValidations: kolValidationSignals,
      }, '=== SCAN CYCLE COMPLETE: Token evaluation results ===');

      // Log scan cycle metrics for performance tracking
      const cycleTimeMs = Date.now() - cycleStartTime;
      await performanceLogger.logScanCycle({
        totalCandidates: candidates.length,
        preFilterPassed: preFiltered.length,
        safetyBlocked,
        scamRejected,
        scoringFailed,
        momentumFailed,
        bundleBlocked,
        signalsGenerated: signalsGenerated + onchainSignals + kolValidationSignals,
        onchainSignals,
        kolSignals: signalsGenerated,
        discoverySignals,
        cycleTimeMs,
      }).catch(err => logger.debug({ err }, 'Failed to log scan cycle metrics'));
    } catch (error) {
      logger.error({ error }, 'Error in scan cycle');
      await performanceLogger.logError('SYSTEM', 'Scan cycle error', error).catch(() => {});
    }
  }
  
  /**
   * Get candidate tokens to evaluate
   * Now uses multi-source discovery: Birdeye, DexScreener, volume anomalies,
   * holder growth velocity, and narrative-based searches
   */
  private async getCandidateTokens(): Promise<string[]> {
    const candidates: Set<string> = new Set();

    // Check WebSocket connection status
    const wsConnected = birdeyeClient.isWebSocketConnected();
    logger.debug({ wsConnected }, 'Birdeye WebSocket status');

    // ===== SOURCE 1: Birdeye New Listings (real-time new tokens) =====
    try {
      const newListings = await birdeyeClient.getNewListings(50);

      for (const listing of newListings) {
        if (listing.address) {
          candidates.add(listing.address);
        }
      }

      if (candidates.size > 0) {
        logger.debug({
          count: candidates.size,
          source: 'Birdeye'
        }, 'Candidates from Birdeye new listings');
      }
    } catch (error) {
      logger.debug({ error }, 'Birdeye new listings failed');
    }

    // ===== SOURCE 2: DexScreener Trending (active tokens) =====
    try {
      const dexTokens = await dexScreenerClient.getTrendingSolanaTokens(50);

      for (const address of dexTokens) {
        candidates.add(address);
      }

      logger.debug({
        count: dexTokens.length,
        source: 'DexScreener trending'
      }, 'Candidates from DexScreener');
    } catch (error) {
      logger.debug({ error }, 'DexScreener trending failed');
    }

    // ===== SOURCE 3: Discovery Engine (volume anomalies, holder growth, narratives) =====
    try {
      const discoveryTokens = await discoveryEngine.getAllDiscoveredTokens();

      for (const address of discoveryTokens) {
        candidates.add(address);
      }

      if (discoveryTokens.length > 0) {
        logger.debug({
          count: discoveryTokens.length,
          source: 'Discovery Engine'
        }, 'Candidates from discovery engine');
      }
    } catch (error) {
      logger.debug({ error }, 'Discovery engine failed');
    }

    // Log final candidate pool composition
    logger.info({
      totalCandidates: candidates.size,
      sources: 'Birdeye + DexScreener + Discovery Engine (volume/holder/narrative)',
    }, 'Candidate token pool assembled');

    return Array.from(candidates);
  }
  
  /**
   * Evaluation result types for diagnostics
   */
  private static readonly EVAL_RESULTS = {
    SKIPPED: 'SKIPPED',
    SAFETY_BLOCKED: 'SAFETY_BLOCKED',
    NO_METRICS: 'NO_METRICS',
    SCREENING_FAILED: 'SCREENING_FAILED',
    SCAM_REJECTED: 'SCAM_REJECTED',
    SCORING_FAILED: 'SCORING_FAILED',
    SIGNAL_SENT: 'SIGNAL_SENT',
    DISCOVERY_SENT: 'DISCOVERY_SENT',        // New: Discovery signal (no KOL)
    KOL_VALIDATION_SENT: 'KOL_VALIDATION_SENT', // New: KOL bought discovered token
    DISCOVERY_FAILED: 'DISCOVERY_FAILED',    // New: Didn't meet discovery threshold
    ONCHAIN_SIGNAL_SENT: 'ONCHAIN_SIGNAL_SENT', // New: Pure on-chain momentum signal
    MOMENTUM_FAILED: 'MOMENTUM_FAILED',      // New: Didn't pass momentum checks
    BUNDLE_BLOCKED: 'BUNDLE_BLOCKED',        // New: High bundle/insider risk
    TOO_EARLY: 'TOO_EARLY',                  // New: Token too young (< 30 min)
  } as const;

  /**
   * Fully evaluate a single token with diagnostic return value
   * Now supports both KOL-triggered and discovery-triggered signals
   */
  private async evaluateTokenWithDiagnostics(tokenAddress: string): Promise<string> {
    const shortAddr = tokenAddress.slice(0, 8);

    // Check if we already have an open position
    if (await Database.hasOpenPosition(tokenAddress)) {
      logger.debug({ tokenAddress: shortAddr }, 'EVAL: Skipped - already have position');
      return SignalGenerator.EVAL_RESULTS.SKIPPED;
    }

    // FEATURE 1 & 5: Run enhanced safety check FIRST (before other checks)
    const safetyResult = await tokenSafetyChecker.checkTokenSafety(tokenAddress);
    const safetyBlock = tokenSafetyChecker.shouldBlockSignal(safetyResult);

    if (safetyBlock.blocked) {
      logger.info({ tokenAddress: shortAddr, reason: safetyBlock.reason }, 'EVAL: Safety blocked');
      return SignalGenerator.EVAL_RESULTS.SAFETY_BLOCKED;
    }

    // Get comprehensive token data first (needed for both paths)
    const metrics = await getTokenMetrics(tokenAddress);
    if (!metrics) {
      logger.info({ tokenAddress: shortAddr }, 'EVAL: No metrics available');
      return SignalGenerator.EVAL_RESULTS.NO_METRICS;
    }

    logger.info({
      tokenAddress: shortAddr,
      ticker: metrics.ticker,
      mcap: metrics.marketCap,
      vol24h: metrics.volume24h,
      holders: metrics.holderCount,
      liq: metrics.liquidityPool,
      age: metrics.tokenAge,
    }, 'EVAL: Got metrics, checking screening criteria');

    // Check if token meets minimum screening criteria
    if (!this.meetsScreeningCriteria(metrics)) {
      return SignalGenerator.EVAL_RESULTS.SCREENING_FAILED;
    }

    logger.info({ tokenAddress: shortAddr, ticker: metrics.ticker }, 'EVAL: Passed screening, running scam filter');

    // Run full scam filter
    const scamResult = await scamFilter.filterToken(tokenAddress);
    if (scamResult.result === 'REJECT') {
      logger.info({ tokenAddress: shortAddr, ticker: metrics.ticker, flags: scamResult.flags }, 'EVAL: Scam filter rejected');
      return SignalGenerator.EVAL_RESULTS.SCAM_REJECTED;
    }

    logger.info({ tokenAddress: shortAddr, ticker: metrics.ticker }, 'EVAL: Passed scam filter, getting additional data');

    // Get social metrics
    const socialMetrics = await this.getSocialMetrics(tokenAddress, metrics);

    // Get volume authenticity
    const volumeAuthenticity = await calculateVolumeAuthenticity(tokenAddress);

    // NEW: Get DexScreener token info (payment status, boosts, socials)
    const dexScreenerInfo = await dexScreenerClient.getTokenInfo(tokenAddress);

    // NEW: Analyze CTO (Community Takeover) status
    const ctoAnalysis = await analyzeCTO(
      tokenAddress,
      metrics.name,
      metrics.ticker,
      safetyResult.deployerHolding,
      !safetyResult.mintAuthorityEnabled,    // mintAuthorityRevoked
      !safetyResult.freezeAuthorityEnabled,  // freezeAuthorityRevoked
      metrics.tokenAge,
      dexScreenerInfo
    );

    // Log DexScreener/CTO status if notable
    if (dexScreenerInfo.hasPaidDexscreener || ctoAnalysis.isCTO) {
      logger.info({
        address: tokenAddress.slice(0, 8),
        dexPaid: dexScreenerInfo.hasPaidDexscreener,
        boosts: dexScreenerInfo.boostCount,
        isCTO: ctoAnalysis.isCTO,
        ctoConfidence: ctoAnalysis.ctoConfidence,
      }, 'DexScreener/CTO status detected');
    }

    // Get KOL activity for this token
    const kolActivities = await kolWalletMonitor.getKolActivityForToken(
      tokenAddress,
      KOL_ACTIVITY_WINDOW_MS
    );

    // Check if this is a previously discovered token that now has KOL activity
    const previousDiscovery = this.discoverySignals.get(tokenAddress);

    // ============ PATH A: KOL ACTIVITY DETECTED ============
    if (kolActivities.length > 0) {
      logger.info({ tokenAddress, kolCount: kolActivities.length }, 'KOL activity detected');

      // FEATURE 2: Track conviction - record all KOL buys
      for (const activity of kolActivities) {
        const conviction = await convictionTracker.recordBuy(
          tokenAddress,
          activity.kol.id,
          activity.kol.handle,
          activity.wallet.address,
          activity.transaction.solAmount,
          activity.transaction.signature
        );

        // Send conviction alert if high/ultra conviction
        if (conviction.isHighConviction) {
          await telegramBot.sendConvictionAlert(conviction);
        }
      }

      // Check if this was previously discovered - if so, send KOL_VALIDATION signal
      if (previousDiscovery) {
        return await this.handleKolValidation(
          tokenAddress,
          metrics,
          socialMetrics,
          volumeAuthenticity,
          scamResult,
          kolActivities,
          safetyResult,
          previousDiscovery,
          dexScreenerInfo,
          ctoAnalysis
        );
      }

      // Standard KOL-triggered signal path
      return await this.handleKolSignal(
        tokenAddress,
        metrics,
        socialMetrics,
        volumeAuthenticity,
        scamResult,
        kolActivities,
        safetyResult,
        dexScreenerInfo,
        ctoAnalysis
      );
    }

    // ============ PATH B: NO KOL - ON-CHAIN MOMENTUM ANALYSIS ============
    // NEW: Use on-chain momentum analysis instead of social metrics

    logger.info({ tokenAddress: shortAddr, ticker: metrics.ticker }, 'EVAL: Entering PATH B (no KOL) - calculating on-chain score');

    // Step 1: Calculate comprehensive on-chain score (handles momentum + bundle internally)
    const onChainScore = await onChainScoringEngine.calculateScore(tokenAddress, metrics);

    // Step 1.5: Calculate social verification score from DexScreener
    // Social links (Twitter, Telegram, etc.) indicate project legitimacy
    const socialScore = this.calculateSocialScore(dexScreenerInfo);

    // Add social score as a bonus to the total (max +25 points)
    const socialBonus = Math.min(25, socialScore.score);
    const adjustedTotal = Math.min(100, onChainScore.total + socialBonus);

    logger.info({
      tokenAddress: shortAddr,
      ticker: metrics.ticker,
      onChainTotal: onChainScore.total,
      socialBonus,
      adjustedTotal,
      recommendation: onChainScore.recommendation,
      riskLevel: onChainScore.riskLevel,
      momentum: onChainScore.components.momentum,
      safety: onChainScore.components.safety,
      socialBreakdown: socialScore.breakdown.length > 0 ? socialScore.breakdown.join(', ') : 'None',
    }, 'EVAL: On-chain + social scoring complete');

    // Step 2: Check if bundle/safety risk is too high
    // Only block CRITICAL risk - HIGH risk tokens can still generate signals with warnings
    if (onChainScore.riskLevel === 'CRITICAL') {
      logger.info({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        riskLevel: onChainScore.riskLevel,
        warnings: onChainScore.warnings,
      }, 'EVAL: BLOCKED - Critical risk level');
      return SignalGenerator.EVAL_RESULTS.BUNDLE_BLOCKED;
    }

    // Step 2.5: DUAL-TRACK SIGNAL ROUTING
    // =========================================
    // Two parallel strategies with different trust models:
    //
    // TRACK 1: PROVEN RUNNER (time = trust)
    //   - Token age >= 90 min (proven survivors)
    //   - Has survived initial rug/dump phase
    //   - Target: 20-40 signals/day
    //
    // TRACK 2: EARLY QUALITY (KOL = trust)
    //   - Token age < 45 min (fresh tokens)
    //   - REQUIRES S-tier or A-tier KOL validation
    //   - Stricter safety requirements
    //   - Target: 10-20 signals/day
    //
    // DEAD ZONE: 45-90 min
    //   - Too old for early-entry edge
    //   - Too young for survival proof
    //   - SKIP these tokens
    //
    const isLearningMode = appConfig.trading.learningMode;
    const PROVEN_RUNNER_MIN_AGE = 90;  // 1.5 hours
    const EARLY_QUALITY_MAX_AGE = 45;  // 45 minutes

    let signalTrack: SignalTrack | null = null;
    let kolReputationTier: KolReputationTier | undefined;

    if (metrics.tokenAge >= PROVEN_RUNNER_MIN_AGE) {
      // TRACK 1: PROVEN RUNNER - Token has survived, time is trust
      signalTrack = SignalTrack.PROVEN_RUNNER;
      logger.info({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        tokenAgeMinutes: metrics.tokenAge,
        track: 'PROVEN_RUNNER',
      }, 'EVAL: Routing to PROVEN RUNNER track');

    } else if (metrics.tokenAge < EARLY_QUALITY_MAX_AGE) {
      // TRACK 2: EARLY QUALITY - Need trust signal (KOL OR exceptional on-chain metrics)
      //
      // HIT RATE IMPROVEMENT: Added ON-CHAIN FIRST path
      // Previously: ONLY KOL validation could pass early tokens
      // Now: Exceptional on-chain metrics can also provide trust signal
      // This removes 20-30 second latency from waiting for KOL detection

      // Check for exceptional on-chain metrics FIRST (faster than KOL lookup)
      // Use the on-chain score components that are already calculated
      //
      // SIGNAL VOLUME FIX: Lowered thresholds from 70/75/70/50/50 to 55/60/55/30/40
      // Previous thresholds were too strict - almost no early tokens could pass
      // without KOL validation, defeating the purpose of on-chain first detection.
      //
      // LEARNING MODE FIX: In learning mode, use much lower thresholds to collect
      // more training data. The ML model needs diverse samples to learn patterns.
      const earlyMomentumThreshold = isLearningMode ? 30 : 55;
      const earlySafetyThreshold = isLearningMode ? 40 : 60;
      const earlyBundleThreshold = isLearningMode ? 35 : 55;
      const earlyHolderThreshold = isLearningMode ? 15 : 30;
      const earlyMarketThreshold = isLearningMode ? 25 : 40;

      const hasSuperiorOnChain =
        onChainScore.components.momentum >= earlyMomentumThreshold &&      // Good buy pressure
        onChainScore.components.safety >= earlySafetyThreshold &&        // Safe contract
        onChainScore.components.bundleSafety >= earlyBundleThreshold &&  // Reasonably clean launch
        metrics.holderCount >= earlyHolderThreshold &&                   // Some traction
        onChainScore.components.marketStructure >= earlyMarketThreshold; // Decent market dynamics

      if (hasSuperiorOnChain) {
        // ON-CHAIN FIRST: Accept without KOL if metrics are exceptional
        signalTrack = SignalTrack.EARLY_QUALITY;
        kolReputationTier = undefined; // No KOL, on-chain validated
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          tokenAgeMinutes: metrics.tokenAge,
          track: 'EARLY_QUALITY',
          validationMethod: 'ON_CHAIN_FIRST',
          learningMode: isLearningMode,
          momentumScore: onChainScore.components.momentum,
          momentumThreshold: earlyMomentumThreshold,
          safetyScore: onChainScore.components.safety,
          safetyThreshold: earlySafetyThreshold,
          marketStructure: onChainScore.components.marketStructure,
          holderCount: metrics.holderCount,
        }, 'EVAL: Routing to EARLY QUALITY track (ON-CHAIN VALIDATED - no KOL needed)');
      } else {
        // Fallback: Check for KOL validation
        const kolActivity = await kolWalletMonitor.getKolActivityForToken(tokenAddress);

        if (kolActivity.length > 0) {
          // Find highest-tier KOL that mentioned/bought this token
          let bestKolTier: KolReputationTier = KolReputationTier.UNPROVEN;

          for (const activity of kolActivity) {
            // Use consolidated kol-analytics for tier checking (single source of truth)
            const kolCheck = await kolAnalytics.isHighTierKolByHandle(activity.kol.handle);
            if (kolCheck.isTrusted) {
              // Found a trusted KOL
              if (kolCheck.tier === KolReputationTier.S_TIER) {
                bestKolTier = KolReputationTier.S_TIER;
                break; // S-tier is best, no need to check more
              } else if (kolCheck.tier === KolReputationTier.A_TIER) {
                bestKolTier = KolReputationTier.A_TIER;
              }
            }
          }

          if (bestKolTier === KolReputationTier.S_TIER || bestKolTier === KolReputationTier.A_TIER) {
            signalTrack = SignalTrack.EARLY_QUALITY;
            kolReputationTier = bestKolTier;
            logger.info({
              tokenAddress: shortAddr,
              ticker: metrics.ticker,
              tokenAgeMinutes: metrics.tokenAge,
              track: 'EARLY_QUALITY',
              validationMethod: 'KOL_VALIDATED',
              kolTier: bestKolTier,
              kolCount: kolActivity.length,
            }, 'EVAL: Routing to EARLY QUALITY track (KOL validated)');
          } else {
            // KOL activity exists but no S/A tier validation
            logger.info({
              tokenAddress: shortAddr,
              ticker: metrics.ticker,
              tokenAgeMinutes: metrics.tokenAge,
              kolCount: kolActivity.length,
              reason: 'KOL activity found but no S/A tier validation',
            }, 'EVAL: BLOCKED - Early token without trusted KOL');
            return SignalGenerator.EVAL_RESULTS.TOO_EARLY;
          }
        } else {
          // No KOL activity and no exceptional on-chain for early token
          logger.info({
            tokenAddress: shortAddr,
            ticker: metrics.ticker,
            tokenAgeMinutes: metrics.tokenAge,
            momentumScore: onChainScore.components.momentum,
            safetyScore: onChainScore.components.safety,
            reason: 'Early token without KOL or exceptional on-chain metrics',
          }, 'EVAL: BLOCKED - Early token without validation');
          return SignalGenerator.EVAL_RESULTS.TOO_EARLY;
        }
      }

    } else {
      // PREVIOUSLY DEAD ZONE: 45-90 min
      // IMPROVEMENT: Instead of skipping, route to PROVEN_RUNNER with moderate requirements
      // These tokens have shown some survival but haven't hit the 90-min mark yet
      // They can still generate signals if they have strong metrics
      signalTrack = SignalTrack.PROVEN_RUNNER;
      logger.info({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        tokenAgeMinutes: metrics.tokenAge,
        track: 'PROVEN_RUNNER',
        note: 'Transition zone (45-90 min) - applying standard proven runner requirements',
      }, 'EVAL: Routing transition zone token to PROVEN RUNNER track');
    }

    // Step 3: Check minimum thresholds (dynamically loaded from optimizer)
    const thresholds = thresholdOptimizer.getCurrentThresholds();
    const MIN_MOMENTUM_SCORE = thresholds.minMomentumScore;
    const MIN_ONCHAIN_SCORE = thresholds.minOnChainScore;

    // LEARNING MODE v2: Skip momentum hard gate entirely in learning mode
    //
    // PROBLEM: Momentum is already weighted at 30% in the total on-chain score.
    // Using a separate hard gate on momentum was double-penalizing low-momentum tokens
    // and blocking signals that might have excellent safety/structure fundamentals.
    //
    // Example: Token with momentum=15, safety=90, bundle=85, structure=70, timing=80
    // Weighted total = 0.30(15) + 0.25(90) + 0.20(85) + 0.15(70) + 0.10(80) = 66.5 (good score!)
    // But it was blocked before this calculation because momentum < threshold
    //
    // SOLUTION: In learning mode, rely on the weighted total score to evaluate tokens.
    // This lets the ML model learn actual correlations between components and outcomes.
    // In production mode, keep the momentum hard gate for quality filtering.

    if (!isLearningMode && onChainScore.components.momentum < MIN_MOMENTUM_SCORE) {
      logger.info({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        momentumScore: onChainScore.components.momentum,
        minRequired: MIN_MOMENTUM_SCORE,
        learningMode: isLearningMode,
      }, 'EVAL: BLOCKED - Momentum below threshold (production mode)');
      return SignalGenerator.EVAL_RESULTS.MOMENTUM_FAILED;
    }

    // Log momentum status in learning mode
    if (isLearningMode) {
      logger.info({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        momentumScore: onChainScore.components.momentum,
        safetyScore: onChainScore.components.safety,
        totalWeighted: onChainScore.total,
        note: 'Learning mode: momentum hard gate skipped, using weighted total',
      }, 'EVAL: Learning mode - evaluating by weighted total score');
    }

    // Check if on-chain score recommends action
    // LEARNING MODE FIX: When learningMode is enabled (default: true), only block STRONG_AVOID
    // This allows more signals through for ML training data collection
    // The recommendation thresholds were conflicting with numerical thresholds:
    // - minOnChainScore: 30 (tokens with score >= 30 should pass)
    // - But AVOID recommendation was given for scores 25-39
    // - This caused ALL tokens with scores 30-39 to be blocked despite passing numerical check
    // (isLearningMode already defined above in momentum check)

    // In learning mode: only block STRONG_AVOID (score < 25) to maximize data collection
    // In production mode: block both AVOID and STRONG_AVOID for quality filtering
    const shouldBlockByRecommendation = isLearningMode
      ? onChainScore.recommendation === 'STRONG_AVOID'
      : (onChainScore.recommendation === 'STRONG_AVOID' || onChainScore.recommendation === 'AVOID');

    // LEARNING MODE: Use lower total score threshold (20 vs 30) to collect more training data
    // The weighted scoring already balances momentum/safety/structure - let ML learn correlations
    const effectiveMinScore = isLearningMode ? Math.min(MIN_ONCHAIN_SCORE, 20) : MIN_ONCHAIN_SCORE;

    // Use adjustedTotal (which includes social verification bonus) for threshold comparison
    // This rewards tokens with verified social presence (Twitter, Telegram, etc.)
    if (adjustedTotal < effectiveMinScore || shouldBlockByRecommendation) {
      logger.info({
        tokenAddress,
        ticker: metrics.ticker,
        onChainScore: onChainScore.total,
        socialBonus,
        adjustedTotal,
        minRequired: effectiveMinScore,
        recommendation: onChainScore.recommendation,
        learningMode: isLearningMode,
        blockedBy: adjustedTotal < effectiveMinScore ? 'SCORE_TOO_LOW' : 'RECOMMENDATION',
      }, 'Token filtered by on-chain score requirements');
      return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
    }

    logger.info({
      tokenAddress,
      ticker: metrics.ticker,
      onChainScore: onChainScore.total,
      socialBonus,
      adjustedTotal,
      recommendation: onChainScore.recommendation,
      learningMode: isLearningMode,
    }, 'Token PASSED on-chain + social score check - proceeding to evaluation');

    // Step 4: Get additional data for position sizing and display
    const bundleAnalysis = await bundleDetector.analyze(tokenAddress);
    const momentumData = await momentumAnalyzer.analyze(tokenAddress);
    const momentumScore = momentumData ? momentumAnalyzer.calculateScore(momentumData) : null;

    // Step 4.5: TRACK-SPECIFIC REQUIREMENTS
    // Different requirements for PROVEN_RUNNER vs EARLY_QUALITY
    const holderGrowthRate = momentumData?.holderGrowthRate || 0;

    if (signalTrack === SignalTrack.PROVEN_RUNNER) {
      // PROVEN RUNNER: Holder growth requirement
      // SIGNAL VOLUME FIX: Lowered from 0.1 to 0.03 (3 new holders per 100 minutes)
      // Many legitimate tokens have slow but steady growth, especially older ones
      //
      // LEARNING MODE FIX: Skip holder growth requirement entirely in learning mode.
      // This requirement was blocking stable tokens that might still be good trades.
      // The ML model needs to learn from diverse outcomes, not pre-filtered data.
      const MIN_HOLDER_GROWTH_RATE = isLearningMode ? 0 : 0.03;

      if (holderGrowthRate < MIN_HOLDER_GROWTH_RATE && !isLearningMode) {
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          holderGrowthRate,
          minRequired: MIN_HOLDER_GROWTH_RATE,
          track: 'PROVEN_RUNNER',
        }, 'EVAL: BLOCKED - Holder growth too low');
        return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
      }

      if (isLearningMode) {
        logger.debug({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          holderGrowthRate,
          note: 'Learning mode: holder growth requirement skipped',
        }, 'EVAL: PROVEN_RUNNER - holder growth check bypassed');
      }
    } else if (signalTrack === SignalTrack.EARLY_QUALITY) {
      // EARLY QUALITY: Simplified requirements (reduced from 4 to 2)
      //
      // IMPROVEMENT: Previously had 4 separate hard gates which caused over-filtering.
      // Analysis showed that safety and bundle risk are the most predictive factors.
      // Liquidity and holder growth are already weighted in on-chain scoring components.
      //
      // Key insight: Double-gating (component in score + separate hard check) was
      // blocking tokens that had good OVERALL scores but missed one specific threshold.
      //
      // LEARNING MODE FIX: Relax these requirements significantly in learning mode
      // to collect more diverse training data for the ML model.

      // 1. Safety score required (relaxed from 70 to 65, or 45 in learning mode)
      const EARLY_QUALITY_MIN_SAFETY = isLearningMode ? 45 : 65;
      if (safetyResult.safetyScore < EARLY_QUALITY_MIN_SAFETY) {
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          safetyScore: safetyResult.safetyScore,
          minRequired: EARLY_QUALITY_MIN_SAFETY,
          learningMode: isLearningMode,
          track: 'EARLY_QUALITY',
        }, 'EVAL: BLOCKED - Safety too low for early token');
        return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
      }

      // 2. Bundle risk required (relaxed from 35 to 40, or 60 in learning mode)
      const EARLY_QUALITY_MAX_BUNDLE_RISK = isLearningMode ? 60 : 40;
      if (bundleAnalysis.riskScore > EARLY_QUALITY_MAX_BUNDLE_RISK) {
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          bundleRiskScore: bundleAnalysis.riskScore,
          maxAllowed: EARLY_QUALITY_MAX_BUNDLE_RISK,
          learningMode: isLearningMode,
          track: 'EARLY_QUALITY',
        }, 'EVAL: BLOCKED - Bundle risk too high for early token');
        return SignalGenerator.EVAL_RESULTS.BUNDLE_BLOCKED;
      }

      // NOTE: Removed separate liquidity and holder growth checks
      // These factors are already accounted for in:
      // - onChainScore.components.marketStructure (liquidity scoring)
      // - onChainScore.components.momentum (includes holder growth)
      // The weighted total score already penalizes tokens with poor liquidity/growth

      logger.info({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        safetyScore: safetyResult.safetyScore,
        bundleRisk: bundleAnalysis.riskScore,
        liquidity: metrics.liquidityPool,
        holderGrowth: holderGrowthRate,
        kolTier: kolReputationTier,
        learningMode: isLearningMode,
        track: 'EARLY_QUALITY',
      }, 'EVAL: PASSED Early Quality requirements');
    }

    // Step 5: Calculate position size using small capital manager
    // Create a compatible MomentumScore object for the manager
    const mockMomentumScore = {
      total: onChainScore.components.momentum,
      breakdown: {
        buyPressure: onChainScore.components.momentum / 4,
        volumeMomentum: onChainScore.components.momentum / 4,
        tradeQuality: onChainScore.components.momentum / 4,
        holderGrowth: onChainScore.components.momentum / 4,
      },
      signals: onChainScore.bullishSignals,
      flags: onChainScore.warnings,
      confidence: onChainScore.confidence,
    };

    const signalQuality = smallCapitalManager.classifySignal(
      mockMomentumScore as any,
      safetyResult.safetyScore,
      bundleAnalysis,
      false, // kolValidated
      false  // multiKol
    );

    const positionSize = smallCapitalManager.calculatePositionSize(signalQuality);

    // Step 6: Get ML-based win prediction
    const prediction = await winPredictor.predict({
      momentumScore: onChainScore.components.momentum,
      onChainScore: onChainScore.total,
      safetyScore: safetyResult.safetyScore,
      bundleRiskScore: bundleAnalysis.riskScore,
      liquidity: metrics.liquidityPool,
      tokenAge: metrics.tokenAge,
      holderCount: metrics.holderCount,
      top10Concentration: metrics.top10Concentration,
      buySellRatio: momentumData?.buySellRatio || 1,
      uniqueBuyers: momentumData?.uniqueBuyers5m || 0,
      marketCap: metrics.marketCap,
      volumeMarketCapRatio: metrics.volumeMarketCapRatio,
    });

    logger.debug({
      tokenAddress,
      ticker: metrics.ticker,
      winProbability: prediction.winProbability,
      confidence: prediction.confidence,
      action: prediction.recommendedAction,
      patterns: prediction.matchedWinPatterns,
    }, 'Win prediction calculated');

    // Filter signals by ML win probability - TRACK-SPECIFIC THRESHOLDS
    //
    // QUALITY FIX: Raised thresholds to require meaningful edge
    // A 50% win probability is a coin flip - we need better than that.
    // Previous thresholds (30-50%) were letting through too many marginal signals.
    //
    // New approach: Require meaningful statistical edge before signaling.
    // Learning mode still allows lower thresholds for data collection.
    //
    // LEARNING MODE FIX: Skip ML gate entirely in learning mode.
    // The ML model needs training data to learn from - we can't expect it to
    // make good predictions without data. By skipping this gate in learning mode,
    // we collect the signal outcomes that the ML model needs to improve.
    //
    let mlProbabilityThreshold: number;
    let confidenceOk: boolean;

    if (isLearningMode) {
      // LEARNING MODE: Skip ML gate entirely - we need to collect training data
      // The model can't learn if we filter out all signals before generating them
      mlProbabilityThreshold = 0;  // Accept any probability
      confidenceOk = true;         // Accept any confidence
      logger.info({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        winProbability: prediction.winProbability,
        confidence: prediction.confidence,
        note: 'Learning mode: ML gate bypassed for data collection',
      }, 'EVAL: Learning mode - skipping ML probability filter');
    } else if (signalTrack === SignalTrack.PROVEN_RUNNER) {
      // PROVEN RUNNER: Token has survived 45+ minutes, require decent edge
      mlProbabilityThreshold = 55;
      confidenceOk = prediction.confidence === 'HIGH' || prediction.confidence === 'MEDIUM';
    } else {
      // EARLY_QUALITY: Already validated by KOL or superior on-chain metrics
      mlProbabilityThreshold = 50;
      confidenceOk = true;  // Trust the external validation, don't double-gate
    }

    if (prediction.winProbability < mlProbabilityThreshold) {
      logger.info({
        tokenAddress,
        ticker: metrics.ticker,
        winProbability: prediction.winProbability,
        threshold: mlProbabilityThreshold,
        confidence: prediction.confidence,
        learningMode: isLearningMode,
        track: signalTrack,
        reason: 'Win probability below threshold',
      }, 'Signal filtered by ML predictor - probability too low');
      return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
    }

    if (!confidenceOk) {
      logger.info({
        tokenAddress,
        ticker: metrics.ticker,
        winProbability: prediction.winProbability,
        confidence: prediction.confidence,
        learningMode: isLearningMode,
        track: signalTrack,
        reason: 'Confidence too low for track requirements',
      }, 'Signal filtered by ML predictor - confidence too low');
      return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
    }

    logger.info({
      tokenAddress,
      ticker: metrics.ticker,
      winProbability: prediction.winProbability,
      mlAction: prediction.recommendedAction,
      learningMode: isLearningMode,
    }, 'Token PASSED ML prediction filter - generating signal');

    // AUDIT FIX: Cap position size multipliers to prevent extremes
    // Previously: positionSize * mlMultiplier could result in 0.25x (0.5*0.5) or 2.25x (1.5*1.5)
    // Now: Cap the combined multiplier to reasonable range
    const rawMultipliedAmount = positionSize.solAmount * prediction.positionSizeMultiplier;
    const minPosition = positionSize.solAmount * 0.5;  // Never less than 50% of calculated
    const maxPosition = positionSize.solAmount * 1.5;  // Never more than 150% of calculated
    const cappedAmount = Math.min(maxPosition, Math.max(minPosition, rawMultipliedAmount));

    const adjustedPositionSize = {
      ...positionSize,
      solAmount: cappedAmount,
      rationale: [
        ...positionSize.rationale,
        `ML Win Probability: ${prediction.winProbability}% (${prediction.confidence})`,
        `Position multiplier: ${prediction.positionSizeMultiplier}x (capped to 0.5-1.5x range)`,
      ],
    };

    // Step 7: Build and send on-chain momentum signal
    const onChainSignal = this.buildOnChainSignal(
      tokenAddress,
      metrics,
      onChainScore,
      bundleAnalysis,
      safetyResult,
      adjustedPositionSize,
      signalQuality,
      momentumScore,
      socialMetrics,
      dexScreenerInfo,
      ctoAnalysis,
      prediction,
      signalTrack!,      // Track type (PROVEN_RUNNER or EARLY_QUALITY)
      kolReputationTier  // KOL tier (for EARLY_QUALITY track)
    );

    // Track for KOL follow-up (optional validation)
    this.discoverySignals.set(tokenAddress, onChainSignal);

    // Step 8: Warning count quality gate
    // Filter signals with too many red flags (excluding generic ones)
    const seriousWarnings = (onChainSignal.riskWarnings || []).filter((w: string) =>
      !w.includes('ON-CHAIN SIGNAL') && !w.includes('No KOL')
    );
    const MAX_SERIOUS_WARNINGS = 4;

    if (seriousWarnings.length >= MAX_SERIOUS_WARNINGS) {
      logger.info({
        tokenAddress,
        ticker: metrics.ticker,
        warningCount: seriousWarnings.length,
        warnings: seriousWarnings,
        threshold: MAX_SERIOUS_WARNINGS,
      }, 'Signal filtered by warning count - too many red flags');
      return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
    }

    // Send on-chain signal via Telegram
    await telegramBot.sendOnChainSignal(onChainSignal);

    // Record signal for performance tracking with additional metrics
    try {
      await signalPerformanceTracker.recordSignal(
        onChainSignal.id,
        tokenAddress,
        metrics.ticker,
        'ONCHAIN',
        metrics.price,
        metrics.marketCap,
        onChainScore.components.momentum,
        onChainScore.total,
        safetyResult.safetyScore,
        bundleAnalysis.riskScore,
        signalQuality.signalStrength,
        // Additional metrics for deeper analysis
        {
          liquidity: metrics.liquidityPool,
          tokenAge: metrics.tokenAge,
          holderCount: metrics.holderCount,
          top10Concentration: metrics.top10Concentration,
          buySellRatio: momentumData?.buySellRatio || 0,
          uniqueBuyers: momentumData?.uniqueBuyers5m || 0,
          signalTrack: signalTrack,  // DUAL-TRACK: For split performance tracking
          kolReputation: kolReputationTier,  // DUAL-TRACK: KOL tier for EARLY_QUALITY
        }
      );
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to record signal for tracking');
    }

    logger.info({
      tokenAddress,
      ticker: metrics.ticker,
      momentumScore: onChainScore.components.momentum,
      onChainTotal: onChainScore.total,
      recommendation: onChainScore.recommendation,
      positionSize: positionSize.solAmount,
      signalStrength: signalQuality.signalStrength,
    }, 'On-chain signal evaluation complete');

    // Track Pump.fun tokens
    if (await bondingCurveMonitor.isPumpfunToken(tokenAddress)) {
      await bondingCurveMonitor.trackToken(tokenAddress);
    }

    return SignalGenerator.EVAL_RESULTS.ONCHAIN_SIGNAL_SENT;
  }

  /**
   * Build on-chain momentum signal (no KOL dependency)
   */
  private buildOnChainSignal(
    tokenAddress: string,
    metrics: TokenMetrics,
    onChainScore: OnChainScore,
    bundleAnalysis: BundleAnalysisResult,
    safetyResult: TokenSafetyResult,
    positionSize: any,
    signalQuality: SignalQuality,
    momentumScore: any,
    socialMetrics: SocialMetrics,
    dexScreenerInfo?: DexScreenerTokenInfo,
    ctoAnalysis?: CTOAnalysis,
    prediction?: WinPrediction,
    signalTrack: SignalTrack = SignalTrack.PROVEN_RUNNER,
    kolReputation?: KolReputationTier
  ): DiscoverySignal {
    // Build risk warnings
    const riskWarnings: string[] = [];

    if (!signalQuality.kolValidated) {
      riskWarnings.push('ON-CHAIN SIGNAL: No KOL validation - based on momentum metrics');
    }
    if (metrics.tokenAge < 60) {
      riskWarnings.push('Token is less than 1 hour old');
    }
    if (metrics.liquidityPool < 25000) {
      riskWarnings.push(`Low liquidity: $${metrics.liquidityPool.toLocaleString()}`);
    }
    if (bundleAnalysis.riskScore > 30) {
      riskWarnings.push(`Bundle risk: ${bundleAnalysis.riskScore}% (${bundleAnalysis.riskLevel})`);
    }
    riskWarnings.push(...onChainScore.warnings);

    // AUDIT FIX: Calculate social momentum score from collected metrics
    // Previously set to 0, wasting valuable social signals that were already collected
    let socialMomentumScore = 0;
    if (socialMetrics) {
      // Mention velocity contributes up to 30 points
      socialMomentumScore += Math.min(30, (socialMetrics.mentionVelocity1h / 50) * 30);
      // Engagement quality contributes up to 20 points
      socialMomentumScore += socialMetrics.engagementQuality * 20;
      // KOL Twitter mentions are valuable
      if (socialMetrics.kolMentionDetected) {
        socialMomentumScore += 15 + Math.min(15, socialMetrics.kolMentions.length * 5);
      }
      // Positive sentiment contributes up to 10 points
      socialMomentumScore += Math.max(0, socialMetrics.sentimentPolarity * 10);
    }

    // Build score object for compatibility
    const score = {
      compositeScore: onChainScore.total,
      factors: {
        onChainHealth: onChainScore.components.marketStructure,
        socialMomentum: Math.round(socialMomentumScore), // AUDIT FIX: Now integrated
        kolConvictionMain: 0,
        kolConvictionSide: 0,
        scamRiskInverse: onChainScore.components.safety,
        narrativeBonus: socialMetrics?.narrativeFit ? 15 : 0,
        timingBonus: onChainScore.components.timing,
      },
      confidence: signalQuality.signalStrength === 'STRONG' ? 'HIGH' :
                  signalQuality.signalStrength === 'MODERATE' ? 'MEDIUM' : 'LOW',
      confidenceBand: 15,
      flags: [
        'ONCHAIN_SIGNAL',
        `MOMENTUM_${onChainScore.components.momentum}`,
        ...(socialMomentumScore > 30 ? ['SOCIAL_TRACTION'] : []),
        ...onChainScore.bullishSignals.slice(0, 3),
      ],
      riskLevel: onChainScore.riskLevel === 'HIGH' || onChainScore.riskLevel === 'CRITICAL' ? 'HIGH' :
                 onChainScore.riskLevel === 'MEDIUM' ? 'MEDIUM' : 'LOW',
    };

    return {
      id: `onchain_${Date.now()}_${tokenAddress.slice(0, 8)}`,
      tokenAddress,
      tokenTicker: metrics.ticker,
      tokenName: metrics.name,

      score,
      tokenMetrics: metrics,
      volumeAuthenticity: { score: onChainScore.components.momentum },
      scamFilter: { result: 'PASS', flags: [] },
      safetyResult,
      socialMetrics,

      moonshotAssessment: {
        score: onChainScore.total,
        grade: onChainScore.grade,
        estimatedPotential: signalQuality.signalStrength === 'STRONG' ? 'HIGH' : 'MEDIUM',
        factors: [],
      },

      kolActivity: null,

      // DexScreener & CTO Info (NEW)
      dexScreenerInfo,
      ctoAnalysis,

      suggestedPositionSize: positionSize.solAmount,
      riskWarnings,

      generatedAt: new Date(),
      signalType: SignalType.DISCOVERY,

      // Dual-track strategy fields
      signalTrack,
      kolReputation,

      discoveredAt: new Date(),
      kolValidatedAt: null,

      // Extra on-chain data for telegram formatting
      momentumScore: momentumScore || {
        total: onChainScore.components.momentum,
        metrics: { buySellRatio: 1.5, uniqueBuyers5m: 10, netBuyPressure: 1000 },
        components: {
          buyPressure: onChainScore.components.momentum / 4,
          volumeVelocity: onChainScore.components.momentum / 4,
          tradeQuality: onChainScore.components.momentum / 4,
          holderGrowth: onChainScore.components.momentum / 4,
        },
      },
      bundleAnalysis,
      onChainScore,
      positionRationale: positionSize.rationale,

      // ML Prediction data
      prediction: prediction ? {
        winProbability: prediction.winProbability,
        confidence: prediction.confidence,
        predictedReturn: prediction.predictedReturn,
        recommendedAction: prediction.recommendedAction,
        matchedPatterns: prediction.matchedWinPatterns,
        riskFactors: prediction.riskFactors,
        bullishFactors: prediction.bullishFactors,
        optimalHoldTime: prediction.predictedOptimalHoldTime,
        earlyExitRisk: prediction.earlyExitRisk,
      } : null,
    } as any;
  }

  /**
   * Handle standard KOL-triggered buy signal
   */
  private async handleKolSignal(
    tokenAddress: string,
    metrics: TokenMetrics,
    socialMetrics: SocialMetrics,
    volumeAuthenticity: any,
    scamResult: any,
    kolActivities: KolWalletActivity[],
    safetyResult: TokenSafetyResult,
    dexScreenerInfo?: DexScreenerTokenInfo,
    ctoAnalysis?: CTOAnalysis
  ): Promise<string> {
    // Calculate score with KOL activity
    const score = scoringEngine.calculateScore(
      tokenAddress,
      metrics,
      socialMetrics,
      volumeAuthenticity,
      scamResult,
      kolActivities
    );

    // Add safety flags
    if (safetyResult.safetyScore < 60) {
      score.flags.push(`SAFETY_${safetyResult.safetyScore}`);
    }
    if (safetyResult.insiderAnalysis.insiderRiskScore > 50) {
      score.flags.push(`INSIDER_RISK_${safetyResult.insiderAnalysis.insiderRiskScore}`);
    }

    // Check if meets buy requirements
    const buyCheck = scoringEngine.meetsBuyRequirements(score, kolActivities);

    if (!buyCheck.meets) {
      logger.info({
        tokenAddress,
        compositeScore: score.compositeScore,
        reason: buyCheck.reason,
      }, 'Token scored but did not meet buy requirements');
      return SignalGenerator.EVAL_RESULTS.SCORING_FAILED;
    }

    // FEATURE 7: Get KOL performance stats to weight signal
    const primaryKol = kolActivities[0];
    const kolStats = await kolAnalytics.getKolStats(primaryKol.kol.id);
    const signalWeight = kolStats ? kolAnalytics.getSignalWeightMultiplier(kolStats) : 1.0;

    // Generate and send buy signal
    const signal = this.buildBuySignal(
      tokenAddress,
      metrics,
      socialMetrics,
      volumeAuthenticity,
      scamResult,
      score,
      primaryKol,
      safetyResult,
      dexScreenerInfo,
      ctoAnalysis
    );

    // Adjust position size based on KOL performance weight
    signal.positionSizePercent = Math.round(signal.positionSizePercent * signalWeight * 10) / 10;

    await telegramBot.sendBuySignal(signal);

    // AUTO-TRADING: Process signal for potential auto-buy
    try {
      // Get conviction info for this token
      const conviction = await convictionTracker.getConvictionLevel(tokenAddress);

      // Process through auto-trader (handles auto-buy vs confirmation logic)
      const autoTradeResult = await autoTrader.processSignal(signal, conviction);

      logger.info({
        tokenAddress,
        action: autoTradeResult.action,
        success: autoTradeResult.tradeResult?.success,
      }, 'Auto-trade signal processed');
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Auto-trade processing failed');
    }

    // AUDIT FIX: Get momentum data for KOL signals so ML can learn from it
    // Previously recorded as 0, so ML couldn't learn buySellRatio/uniqueBuyers patterns for KOL path
    let kolMomentumData: { buySellRatio: number; uniqueBuyers: number } = { buySellRatio: 0, uniqueBuyers: 0 };
    try {
      const momentumData = await momentumAnalyzer.analyze(tokenAddress);
      if (momentumData) {
        kolMomentumData = {
          buySellRatio: momentumData.buySellRatio,
          uniqueBuyers: momentumData.uniqueBuyers5m,
        };
      }
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Could not fetch momentum for KOL signal tracking');
    }

    // Record signal for performance tracking with additional metrics
    try {
      await signalPerformanceTracker.recordSignal(
        signal.id,
        tokenAddress,
        metrics.ticker,
        'KOL',
        metrics.price,
        metrics.marketCap,
        score.factors.onChainHealth || 50,
        score.compositeScore,
        safetyResult?.safetyScore || 50,
        scamResult.bundleAnalysis?.bundledSupplyPercent || 0, // AUDIT FIX: Include bundle data
        score.compositeScore >= 80 ? 'STRONG' : score.compositeScore >= 65 ? 'MODERATE' : 'WEAK',
        // Additional metrics for deeper analysis
        {
          liquidity: metrics.liquidityPool,
          tokenAge: metrics.tokenAge,
          holderCount: metrics.holderCount,
          top10Concentration: metrics.top10Concentration,
          buySellRatio: kolMomentumData.buySellRatio, // AUDIT FIX: Now tracked for KOL signals
          uniqueBuyers: kolMomentumData.uniqueBuyers,
        }
      );
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to record KOL signal for tracking');
    }

    // FEATURE 4: Track Pump.fun tokens
    if (await bondingCurveMonitor.isPumpfunToken(tokenAddress)) {
      await bondingCurveMonitor.trackToken(tokenAddress);
    }

    return SignalGenerator.EVAL_RESULTS.SIGNAL_SENT;
  }

  /**
   * Handle KOL validation of previously discovered token
   */
  private async handleKolValidation(
    tokenAddress: string,
    metrics: TokenMetrics,
    socialMetrics: SocialMetrics,
    volumeAuthenticity: any,
    scamResult: any,
    kolActivities: KolWalletActivity[],
    safetyResult: TokenSafetyResult,
    previousDiscovery: DiscoverySignal,
    dexScreenerInfo?: DexScreenerTokenInfo,
    ctoAnalysis?: CTOAnalysis
  ): Promise<string> {
    // Apply KOL multiplier to the discovery score
    const boostedScore = scoringEngine.applyKolMultiplier(
      previousDiscovery.score,
      kolActivities
    );

    logger.info({
      tokenAddress,
      ticker: metrics.ticker,
      originalScore: previousDiscovery.score.compositeScore,
      boostedScore: boostedScore.compositeScore,
      kolCount: kolActivities.length,
    }, 'KOL validation for previously discovered token');

    // FEATURE 7: Get KOL performance stats
    const primaryKol = kolActivities[0];
    const kolStats = await kolAnalytics.getKolStats(primaryKol.kol.id);
    const signalWeight = kolStats ? kolAnalytics.getSignalWeightMultiplier(kolStats) : 1.0;

    // Build enhanced buy signal with KOL_VALIDATION type
    const signal = this.buildBuySignal(
      tokenAddress,
      metrics,
      socialMetrics,
      volumeAuthenticity,
      scamResult,
      boostedScore,
      primaryKol,
      safetyResult,
      dexScreenerInfo,
      ctoAnalysis
    );

    // Mark as KOL_VALIDATION signal
    signal.signalType = SignalType.KOL_VALIDATION;
    signal.positionSizePercent = Math.round(signal.positionSizePercent * signalWeight * 10) / 10;

    // Send the validation signal
    await telegramBot.sendKolValidationSignal(signal, previousDiscovery);

    // AUTO-TRADING: Process KOL validation signal for potential auto-buy
    try {
      const conviction = await convictionTracker.getConvictionLevel(tokenAddress);
      const autoTradeResult = await autoTrader.processSignal(signal, conviction);

      logger.info({
        tokenAddress,
        action: autoTradeResult.action,
        success: autoTradeResult.tradeResult?.success,
      }, 'Auto-trade KOL validation processed');
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Auto-trade KOL validation failed');
    }

    // Remove from discovery tracking (it's now validated)
    this.discoverySignals.delete(tokenAddress);

    // FEATURE 4: Track Pump.fun tokens
    if (await bondingCurveMonitor.isPumpfunToken(tokenAddress)) {
      await bondingCurveMonitor.trackToken(tokenAddress);
    }

    return SignalGenerator.EVAL_RESULTS.KOL_VALIDATION_SENT;
  }

  /**
   * Build a discovery signal (no KOL required)
   */
  private buildDiscoverySignal(
    tokenAddress: string,
    metrics: TokenMetrics,
    score: any,
    volumeAuthenticity: any,
    scamResult: any,
    safetyResult: TokenSafetyResult,
    moonshotAssessment: MoonshotAssessment,
    socialMetrics?: SocialMetrics,
    signalTrack: SignalTrack = SignalTrack.PROVEN_RUNNER,
    kolReputation?: KolReputationTier
  ): DiscoverySignal {
    // Calculate suggested position size (50% of normal for discovery)
    let positionSize = appConfig.trading.defaultPositionSizePercent * 0.5;

    // Adjust based on moonshot grade
    if (moonshotAssessment.grade === 'A') positionSize *= 1.25;
    else if (moonshotAssessment.grade === 'B') positionSize *= 1.0;
    else if (moonshotAssessment.grade === 'C') positionSize *= 0.75;

    // Apply score modifiers
    if (score.flags.includes('LOW_LIQUIDITY')) positionSize *= 0.5;
    if (score.flags.includes('NEW_TOKEN')) positionSize *= 0.75;

    positionSize = Math.min(positionSize, 1.5); // Cap at 1.5% for discovery

    // Build risk warnings
    const riskWarnings: string[] = [
      'DISCOVERY_SIGNAL: No KOL validation yet - higher risk',
    ];
    if (metrics.tokenAge < 60) riskWarnings.push('Token is less than 1 hour old');
    if (metrics.liquidityPool < 25000) riskWarnings.push('Low liquidity pool');
    if (safetyResult.insiderAnalysis.insiderRiskScore > 30) {
      riskWarnings.push(`Insider risk detected: ${safetyResult.insiderAnalysis.insiderRiskScore}%`);
    }
    if (moonshotAssessment.estimatedPotential !== 'HIGH') {
      riskWarnings.push(`Moonshot potential: ${moonshotAssessment.estimatedPotential}`);
    }

    // Default social metrics if not provided
    const defaultSocialMetrics: SocialMetrics = socialMetrics || {
      mentionVelocity1h: 0,
      engagementQuality: 0,
      accountAuthenticity: 0,
      sentimentPolarity: 0,
      kolMentionDetected: false,
      kolMentions: [],
      narrativeFit: null,
    };

    return {
      id: `disc_${Date.now()}_${tokenAddress.slice(0, 8)}`,
      tokenAddress,
      tokenTicker: metrics.ticker,
      tokenName: metrics.name,

      score,
      tokenMetrics: metrics,
      volumeAuthenticity,
      scamFilter: scamResult,
      safetyResult,
      socialMetrics: defaultSocialMetrics,

      moonshotAssessment,

      kolActivity: null, // No KOL for discovery

      suggestedPositionSize: Math.round(positionSize * 10) / 10,
      riskWarnings,

      generatedAt: new Date(),
      signalType: SignalType.DISCOVERY,

      // Dual-track strategy
      signalTrack,
      kolReputation,

      discoveredAt: new Date(),
      kolValidatedAt: null,
    };
  }

  /**
   * Clean up expired discovery signals
   */
  private cleanupExpiredDiscoveries(): void {
    const now = Date.now();
    for (const [address, signal] of this.discoverySignals) {
      if (now - signal.discoveredAt.getTime() > DISCOVERY_SIGNAL_EXPIRY_MS) {
        this.discoverySignals.delete(address);
        logger.debug({ address }, 'Expired discovery signal removed');
      }
    }
  }

  /**
   * Calculate social verification score from DexScreener info
   *
   * Social links (Twitter, Telegram, Website) indicate project legitimacy.
   * Scam tokens rarely have established social presence.
   *
   * Returns a bonus score (0-15 points) to add to the on-chain score.
   */
  private calculateSocialScore(dexScreenerInfo: DexScreenerTokenInfo): {
    score: number;
    breakdown: string[];
  } {
    const breakdown: string[] = [];
    let score = 0;

    // Twitter verification is strongest signal (most effort to maintain)
    if (dexScreenerInfo.socialLinks.twitter) {
      score += 7;
      breakdown.push('Twitter: +7');
    }

    // Telegram shows active community
    if (dexScreenerInfo.socialLinks.telegram) {
      score += 4;
      breakdown.push('Telegram: +4');
    }

    // Website shows commitment to project
    if (dexScreenerInfo.socialLinks.website) {
      score += 3;
      breakdown.push('Website: +3');
    }

    // Discord is a bonus (less common for memecoins)
    if (dexScreenerInfo.socialLinks.discord) {
      score += 1;
      breakdown.push('Discord: +1');
    }

    // Paid DexScreener profile is a strong legitimacy signal
    if (dexScreenerInfo.hasPaidDexscreener) {
      score += 5;
      breakdown.push('Paid DexScreener: +5');
    }

    // Active boosts show marketing investment (could be pump, but shows commitment)
    if (dexScreenerInfo.boostCount > 0) {
      const boostPoints = Math.min(3, dexScreenerInfo.boostCount);
      score += boostPoints;
      breakdown.push(`Boosts (${dexScreenerInfo.boostCount}): +${boostPoints}`);
    }

    // Has description shows effort put into project
    if (dexScreenerInfo.description && dexScreenerInfo.description.length > 20) {
      score += 2;
      breakdown.push('Description: +2');
    }

    return { score, breakdown };
  }

  /**
   * Fully evaluate a single token (legacy wrapper)
   */
  private async evaluateToken(tokenAddress: string): Promise<void> {
    await this.evaluateTokenWithDiagnostics(tokenAddress);
  }
  
  /**
   * Check if token meets minimum screening criteria
   * Enhanced with detailed logging to diagnose filtering issues
   */
  private meetsScreeningCriteria(metrics: TokenMetrics): boolean {
    const cfg = appConfig.screening;
    const failedCriteria: string[] = [];

    if (metrics.marketCap < cfg.minMarketCap) {
      failedCriteria.push(`marketCap (${metrics.marketCap}) < min (${cfg.minMarketCap})`);
    }
    if (metrics.marketCap > cfg.maxMarketCap) {
      failedCriteria.push(`marketCap (${metrics.marketCap}) > max (${cfg.maxMarketCap})`);
    }

    if (metrics.volume24h < cfg.min24hVolume) {
      failedCriteria.push(`volume24h (${metrics.volume24h}) < min (${cfg.min24hVolume})`);
    }

    if (metrics.volumeMarketCapRatio < cfg.minVolumeMarketCapRatio) {
      failedCriteria.push(`volumeRatio (${metrics.volumeMarketCapRatio.toFixed(3)}) < min (${cfg.minVolumeMarketCapRatio})`);
    }

    if (metrics.holderCount < cfg.minHolderCount) {
      failedCriteria.push(`holders (${metrics.holderCount}) < min (${cfg.minHolderCount})`);
    }

    if (metrics.top10Concentration > cfg.maxTop10Concentration) {
      failedCriteria.push(`top10Concentration (${metrics.top10Concentration}%) > max (${cfg.maxTop10Concentration}%)`);
    }

    if (metrics.liquidityPool < cfg.minLiquidityPool) {
      failedCriteria.push(`liquidity (${metrics.liquidityPool}) < min (${cfg.minLiquidityPool})`);
    }

    if (metrics.tokenAge < cfg.minTokenAgeMinutes) {
      failedCriteria.push(`tokenAge (${metrics.tokenAge}min) < min (${cfg.minTokenAgeMinutes}min)`);
    }

    if (failedCriteria.length > 0) {
      logger.debug({
        ticker: metrics.ticker,
        address: metrics.address?.slice(0, 8),
        failedCriteria,
        metrics: {
          marketCap: metrics.marketCap,
          volume24h: metrics.volume24h,
          holders: metrics.holderCount,
          liquidity: metrics.liquidityPool,
          tokenAge: metrics.tokenAge,
        },
      }, 'Token failed screening criteria');
      return false;
    }

    return true;
  }
  
  /**
   * Get social metrics (simplified implementation)
   */
  private async getSocialMetrics(
    tokenAddress: string,
    metrics: TokenMetrics
  ): Promise<SocialMetrics> {
    try {
      // Use real X/Twitter social analyzer
      const socialMetrics = await socialAnalyzer.getSocialMetrics(
        tokenAddress,
        metrics.ticker,
        metrics.name
      );

      // If social analyzer returned data, use it
      if (socialMetrics.mentionVelocity1h > 0 || socialMetrics.kolMentionDetected) {
        logger.debug({
          ticker: metrics.ticker,
          velocity: socialMetrics.mentionVelocity1h,
          sentiment: socialMetrics.sentimentPolarity,
          kolMentions: socialMetrics.kolMentions.length,
        }, 'Real social metrics retrieved from X');
        return socialMetrics;
      }

      // Fallback: If no social data found, return with detected narrative
      return {
        ...socialMetrics,
        narrativeFit: socialMetrics.narrativeFit || this.detectNarrative(metrics),
      };
    } catch (error) {
      logger.debug({ error, ticker: metrics.ticker }, 'Social metrics fetch failed, using on-chain proxy');

      // HIT RATE IMPROVEMENT: Use on-chain proxy metrics instead of hardcoded 0.5 placeholders
      // The 0.5 hardcoded values were inflating scores for tokens without real social traction
      // Now: infer social quality from on-chain activity (holder count, volume, distribution)
      const holdersRatio = Math.min(1, metrics.holderCount / 200); // 200 holders = 1.0
      const volumeScore = Math.min(1, (metrics.volume24h / Math.max(1, metrics.marketCap)) / 0.3); // 30% vol/mcap = 1.0
      const distributionScore = Math.max(0, 1 - (metrics.top10Concentration / 75)); // Well distributed = higher

      // Engagement proxy: combine volume activity with holder growth
      const engagementProxy = (holdersRatio * 0.4 + volumeScore * 0.4 + distributionScore * 0.2);

      // Authenticity proxy: good distribution + reasonable holder count suggests organic
      const authenticityProxy = distributionScore * 0.7 + Math.min(0.3, holdersRatio * 0.3);

      return {
        mentionVelocity1h: 0,
        engagementQuality: Math.min(0.6, engagementProxy), // Cap at 0.6 without real social data
        accountAuthenticity: Math.min(0.6, authenticityProxy), // Cap at 0.6 without real data
        sentimentPolarity: 0,
        kolMentionDetected: false,
        kolMentions: [],
        narrativeFit: this.detectNarrative(metrics),
      };
    }
  }
  
  /**
   * Detect narrative theme from token name/ticker
   */
  private detectNarrative(metrics: TokenMetrics): string | null {
    const name = (metrics.name + ' ' + metrics.ticker).toLowerCase();
    
    if (name.includes('ai') || name.includes('agent') || name.includes('gpt')) {
      return 'AI / Agents';
    }
    if (name.includes('trump') || name.includes('maga') || name.includes('biden')) {
      return 'Political';
    }
    if (name.includes('pepe') || name.includes('doge') || name.includes('shib')) {
      return 'Classic Meme';
    }
    if (name.includes('cat') || name.includes('dog') || name.includes('frog')) {
      return 'Animal';
    }
    
    return null;
  }
  
  /**
   * Build the complete buy signal object
   */
  private buildBuySignal(
    tokenAddress: string,
    metrics: TokenMetrics,
    socialMetrics: SocialMetrics,
    volumeAuthenticity: any,
    scamResult: any,
    score: any,
    primaryKolActivity: KolWalletActivity,
    safetyResult?: TokenSafetyResult,
    dexScreenerInfo?: DexScreenerTokenInfo,
    ctoAnalysis?: CTOAnalysis,
    signalTrack: SignalTrack = SignalTrack.PROVEN_RUNNER,
    kolReputation?: KolReputationTier
  ): BuySignal {
    const price = metrics.price;
    
    // Calculate position size based on score and flags
    let positionSize = appConfig.trading.defaultPositionSizePercent;
    if (score.compositeScore >= 90) positionSize *= 1.5;
    else if (score.compositeScore >= 80) positionSize *= 1.25;
    if (score.flags.includes('LOW_LIQUIDITY')) positionSize *= 0.5;
    if (score.flags.includes('NEW_TOKEN')) positionSize *= 0.75;
    if (score.flags.includes('SIDE_ONLY')) positionSize *= 0.75;
    positionSize = Math.min(positionSize, 3); // Cap at 3%
    
    return {
      id: `sig_${Date.now()}_${tokenAddress.slice(0, 8)}`,
      tokenAddress,
      tokenTicker: metrics.ticker,
      tokenName: metrics.name,

      score,
      tokenMetrics: metrics,
      socialMetrics,
      volumeAuthenticity,
      scamFilter: scamResult,

      kolActivity: primaryKolActivity,

      // DexScreener & CTO Info (NEW)
      dexScreenerInfo,
      ctoAnalysis,

      entryZone: {
        low: price * 0.95,
        high: price * 1.05,
      },
      positionSizePercent: Math.round(positionSize * 10) / 10,
      stopLoss: {
        price: price * 0.7,
        percent: 30,
      },
      takeProfit1: {
        price: price * 1.5,
        percent: 50,
      },
      takeProfit2: {
        price: price * 2.5,
        percent: 150,
      },
      timeLimitHours: 72,

      generatedAt: new Date(),
      signalType: SignalType.BUY,

      // Dual-track strategy
      signalTrack,
      kolReputation,
    };
  }
}

// ============ EXPORTS ============

export const signalGenerator = new SignalGenerator();

export default {
  SignalGenerator,
  signalGenerator,
};
