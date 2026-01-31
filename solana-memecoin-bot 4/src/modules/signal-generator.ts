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

import {
  TokenMetrics,
  SocialMetrics,
  BuySignal,
  SignalType,
  KolWalletActivity,
  TokenSafetyResult,
  DiscoverySignal,
  MoonshotAssessment,
} from '../types/index.js';

// ============ CONFIGURATION ============

const SCAN_INTERVAL_MS = 60 * 1000; // 1 minute
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
    
    logger.info('Signal generator stopped');
  }
  
  /**
   * Run a single scan cycle
   */
  private async runScanCycle(): Promise<void> {
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
      logger.info(
        `Scan cycle: pre-filter complete | candidates=${candidates.length} passed=${preFiltered.length} failed=${quickFilterFails}`
      );

      // Step 3: Evaluate each token (KOL signals + discovery signals)
      let safetyBlocked = 0;
      let noMetrics = 0;
      let screeningFailed = 0;
      let scamRejected = 0;
      let scoringFailed = 0;
      let signalsGenerated = 0;
      let discoverySignals = 0;
      let kolValidationSignals = 0;
      let discoveryFailed = 0;

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
            case 'SKIPPED': break; // Already have position
          }
        } catch (error) {
          logger.error({ error, tokenAddress }, 'Error evaluating token');
        }
      }

      // Clean up expired discovery signals
      this.cleanupExpiredDiscoveries();

      // Show where tokens are dropping off
      logger.info(
        `Scan cycle: evaluation complete | evaluated=${preFiltered.length} safetyBlocked=${safetyBlocked} noMetrics=${noMetrics} screeningFailed=${screeningFailed} scamRejected=${scamRejected} scoringFailed=${scoringFailed} buySignals=${signalsGenerated} discoveries=${discoverySignals} kolValidations=${kolValidationSignals} discoveryFailed=${discoveryFailed}`
      );
    } catch (error) {
      logger.error({ error }, 'Error in scan cycle');
    }
  }
  
  /**
   * Get candidate tokens to evaluate
   */
  private async getCandidateTokens(): Promise<string[]> {
    const candidates: Set<string> = new Set();
    
    // Check WebSocket connection status
    const wsConnected = birdeyeClient.isWebSocketConnected();
    logger.debug({ wsConnected }, 'Birdeye WebSocket status');
    
    // Try Birdeye first (will use WebSocket buffer if connected, REST API otherwise)
    try {
      const newListings = await birdeyeClient.getNewListings(50);
      
      for (const listing of newListings) {
        if (listing.address) {
          candidates.add(listing.address);
        }
      }
      
      if (candidates.size > 0) {
        logger.info({
          count: candidates.size,
          source: 'Birdeye WebSocket'
        }, 'Got candidates from Birdeye');
      }
    } catch (error) {
      logger.warn({ error }, 'Birdeye new listings failed, using DexScreener fallback');
    }
    
    // Use DexScreener as fallback/supplement
    if (candidates.size < 20) {
      try {
        const dexTokens = await dexScreenerClient.getTrendingSolanaTokens(50);
        
        for (const address of dexTokens) {
          candidates.add(address);
        }
        
        logger.info({ count: candidates.size }, 'Supplemented with DexScreener candidates');
      } catch (error) {
        logger.error({ error }, 'DexScreener fallback also failed');
      }
    }
    
    // Also check tokens that KOLs have recently interacted with
    // This would require additional tracking infrastructure
    
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
  } as const;

  /**
   * Fully evaluate a single token with diagnostic return value
   * Now supports both KOL-triggered and discovery-triggered signals
   */
  private async evaluateTokenWithDiagnostics(tokenAddress: string): Promise<string> {
    // Check if we already have an open position
    if (await Database.hasOpenPosition(tokenAddress)) {
      return SignalGenerator.EVAL_RESULTS.SKIPPED;
    }

    // FEATURE 1 & 5: Run enhanced safety check FIRST (before other checks)
    const safetyResult = await tokenSafetyChecker.checkTokenSafety(tokenAddress);
    const safetyBlock = tokenSafetyChecker.shouldBlockSignal(safetyResult);

    if (safetyBlock.blocked) {
      return SignalGenerator.EVAL_RESULTS.SAFETY_BLOCKED;
    }

    // Get comprehensive token data first (needed for both paths)
    const metrics = await getTokenMetrics(tokenAddress);
    if (!metrics) {
      return SignalGenerator.EVAL_RESULTS.NO_METRICS;
    }

    // Check if token meets minimum screening criteria
    if (!this.meetsScreeningCriteria(metrics)) {
      return SignalGenerator.EVAL_RESULTS.SCREENING_FAILED;
    }

    // Run full scam filter
    const scamResult = await scamFilter.filterToken(tokenAddress);
    if (scamResult.result === 'REJECT') {
      logger.info({ tokenAddress, flags: scamResult.flags }, 'Token rejected by scam filter');
      return SignalGenerator.EVAL_RESULTS.SCAM_REJECTED;
    }

    // Get social metrics
    const socialMetrics = await this.getSocialMetrics(tokenAddress, metrics);

    // Get volume authenticity
    const volumeAuthenticity = await calculateVolumeAuthenticity(tokenAddress);

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
          previousDiscovery
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
        safetyResult
      );
    }

    // ============ PATH B: NO KOL - EVALUATE FOR DISCOVERY ============
    // Calculate discovery score (no KOL component)
    const discoveryScore = scoringEngine.calculateDiscoveryScore(
      tokenAddress,
      metrics,
      socialMetrics,
      volumeAuthenticity,
      scamResult
    );

    // Calculate moonshot assessment
    const moonshotAssessment = moonshotAssessor.assess(
      metrics,
      safetyResult,
      volumeAuthenticity,
      socialMetrics
    );

    // Add safety and moonshot info to flags
    if (safetyResult.safetyScore < 60) {
      discoveryScore.flags.push(`SAFETY_${safetyResult.safetyScore}`);
    }
    if (safetyResult.insiderAnalysis.insiderRiskScore > 50) {
      discoveryScore.flags.push(`INSIDER_RISK_${safetyResult.insiderAnalysis.insiderRiskScore}`);
    }

    // Check if meets discovery requirements
    const discoveryCheck = scoringEngine.meetsDiscoveryRequirements(discoveryScore, scamResult);
    const moonshotCheck = moonshotAssessor.meetsDiscoveryThreshold(moonshotAssessment);

    if (!discoveryCheck.meets || !moonshotCheck) {
      logger.debug({
        tokenAddress,
        score: discoveryScore.compositeScore,
        moonshotScore: moonshotAssessment.score,
        moonshotGrade: moonshotAssessment.grade,
        reason: discoveryCheck.reason || 'Moonshot threshold not met',
      }, 'Token did not meet discovery requirements');
      return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
    }

    // Generate and send discovery signal
    const discoverySignal = this.buildDiscoverySignal(
      tokenAddress,
      metrics,
      discoveryScore,
      volumeAuthenticity,
      scamResult,
      safetyResult,
      moonshotAssessment
    );

    // Track for KOL follow-up
    this.discoverySignals.set(tokenAddress, discoverySignal);

    // Send discovery alert
    await telegramBot.sendDiscoverySignal(discoverySignal);

    logger.info({
      tokenAddress,
      ticker: metrics.ticker,
      score: discoveryScore.compositeScore,
      moonshotGrade: moonshotAssessment.grade,
    }, 'Discovery signal sent');

    // FEATURE 4: Track Pump.fun tokens
    if (await bondingCurveMonitor.isPumpfunToken(tokenAddress)) {
      await bondingCurveMonitor.trackToken(tokenAddress);
    }

    return SignalGenerator.EVAL_RESULTS.DISCOVERY_SENT;
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
    safetyResult: TokenSafetyResult
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
      safetyResult
    );

    // Adjust position size based on KOL performance weight
    signal.positionSizePercent = Math.round(signal.positionSizePercent * signalWeight * 10) / 10;

    await telegramBot.sendBuySignal(signal);

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
    previousDiscovery: DiscoverySignal
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
      safetyResult
    );

    // Mark as KOL_VALIDATION signal
    signal.signalType = SignalType.KOL_VALIDATION;
    signal.positionSizePercent = Math.round(signal.positionSizePercent * signalWeight * 10) / 10;

    // Send the validation signal
    await telegramBot.sendKolValidationSignal(signal, previousDiscovery);

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
    moonshotAssessment: MoonshotAssessment
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

      moonshotAssessment,

      kolActivity: null, // No KOL for discovery

      suggestedPositionSize: Math.round(positionSize * 10) / 10,
      riskWarnings,

      generatedAt: new Date(),
      signalType: SignalType.DISCOVERY,

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
   * Fully evaluate a single token (legacy wrapper)
   */
  private async evaluateToken(tokenAddress: string): Promise<void> {
    await this.evaluateTokenWithDiagnostics(tokenAddress);
  }
  
  /**
   * Check if token meets minimum screening criteria
   */
  private meetsScreeningCriteria(metrics: TokenMetrics): boolean {
    const cfg = appConfig.screening;
    
    if (metrics.marketCap < cfg.minMarketCap || metrics.marketCap > cfg.maxMarketCap) {
      return false;
    }
    
    if (metrics.volume24h < cfg.min24hVolume) {
      return false;
    }
    
    if (metrics.volumeMarketCapRatio < cfg.minVolumeMarketCapRatio) {
      return false;
    }
    
    if (metrics.holderCount < cfg.minHolderCount) {
      return false;
    }
    
    if (metrics.top10Concentration > cfg.maxTop10Concentration) {
      return false;
    }
    
    if (metrics.liquidityPool < cfg.minLiquidityPool) {
      return false;
    }
    
    if (metrics.tokenAge < cfg.minTokenAgeMinutes) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Get social metrics (simplified implementation)
   */
  private async getSocialMetrics(
    _tokenAddress: string,
    metrics: TokenMetrics
  ): Promise<SocialMetrics> {
    // This would integrate with Twitter API in production
    // For now, return placeholder data
    return {
      mentionVelocity1h: 0,
      engagementQuality: 0.5,
      accountAuthenticity: 0.7,
      sentimentPolarity: 0.2,
      kolMentionDetected: false,
      kolMentions: [],
      narrativeFit: this.detectNarrative(metrics),
    };
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
    safetyResult?: TokenSafetyResult
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
    };
  }
}

// ============ EXPORTS ============

export const signalGenerator = new SignalGenerator();

export default {
  SignalGenerator,
  signalGenerator,
};
