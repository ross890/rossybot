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
  dexScreenerClient,
  jupiterClient,
  analyzeCTO,
} from './onchain.js';
import { scamFilter, quickScamCheck } from './scam-filter.js';
import { kolWalletMonitor } from './kol-tracker.js';
import { alphaWalletManager } from './alpha/alpha-wallet-manager.js';
import { scoringEngine } from './scoring.js';
import { telegramBot } from './telegram.js';

// Safety & scoring modules
import { tokenSafetyChecker } from './safety/token-safety-checker.js';
import { convictionTracker } from './signals/conviction-tracker.js';
import { kolSellDetector } from './signals/sell-detector.js';
import { kolAnalytics } from './kol/kol-analytics.js';
import { bondingCurveMonitor } from './pumpfun/bonding-monitor.js';

// On-chain first modules
import { momentumAnalyzer } from './momentum-analyzer.js';
import { bundleDetector, BundleAnalysisResult } from './bundle-detector.js';
import { onChainScoringEngine, OnChainScore } from './onchain-scoring.js';
import { candlestickAnalyzer } from './candlestick-analyzer.js';

// Performance tracking
import { signalPerformanceTracker, thresholdOptimizer, performanceLogger } from './performance/index.js';

// Auto-trading integration
import { autoTrader } from './trading/index.js';

// Canonical exit strategy (v3 alignment)
import { CANONICAL_EXIT_PARAMS, scoreToGrade, getInitialStopLoss } from './trading/exitStrategy.js';

// v3: Pullback entry system — GMGN/discovery tokens wait for dips
import { pullbackDetector } from './entry/pullbackDetector.js';

// v3: Source-level EV tracking (used by daily optimizer, initialized here)
import { sourceTracker } from './performance/sourceTracker.js';

// Multi-source token discovery
import { discoveryEngine, firstBuyerQuality, walletClustering, rotationDetector, bondingVelocityTracker, twitterScanner, whaleDetector, liquidityMonitor } from './discovery/index.js';
import { gmgnClient } from './gmgn-client.js';

// RugCheck integration — hard-gate for DANGER tokens
import { rugCheckClient } from './rugcheck.js';

// Pump.fun Dev Tracker — third signal pathway
import { pumpfunDevMonitor } from './pumpfun/dev-monitor.js';
import { formatDevKolValidation } from './pumpfun/dev-signal.js';

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
  AlphaWallet,
  SignalEnrichment,
} from '../types/index.js';

// ============ CONFIGURATION ============

// HIT RATE IMPROVEMENT: Reduced from 60s to 10s
// Analysis shows we're getting front-run by ~35-45 seconds
// 10s scan cycle maximizes early entry opportunities
// NOTE: Ensure API rate limits can handle this frequency
const SCAN_INTERVAL_MS = 20 * 1000; // 20 seconds - balanced for DexScreener rate limits
const KOL_ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const DISCOVERY_SIGNAL_EXPIRY_MS = 24 * 60 * 60 * 1000; // Track discovery for 24 hours

// ============ TIER-AWARE FILTERING ============
// RECALIBRATED: Micro-cap focus for quick-flip edge.
// The formula targets MCAP ≤ $225K as the sweet spot for 80% win rate.
// We keep MICRO as primary, allow RISING up to $1M, and disable everything above.
// Larger caps = more bots, less edge, worse risk/reward.
//
// TIER BOUNDARIES (based on entry market cap):
// - MICRO:   $30K - $225K   (PRIMARY: sweet spot for quick flips)
// - RISING:  $225K - $1M    (SECONDARY: still viable, reduced size)
// - ABOVE:   $1M+           (DISABLED: no edge vs institutional bots)

type MarketCapTier = 'MICRO' | 'RISING' | 'EMERGING' | 'GRADUATED' | 'ESTABLISHED' | 'UNKNOWN';

interface TierConfig {
  minMcap: number;
  maxMcap: number;
  enabled: boolean;  // Whether to generate signals for this tier
  minLiquidity: number;  // Tier-specific liquidity requirement
  minSafetyScore: number;  // Tier-specific safety requirement
  positionSizeMultiplier: number;  // Scale position size for tier
}

// Tier configuration - MICRO-CAP FOCUSED
const TIER_CONFIGS: Record<MarketCapTier, TierConfig> = {
  MICRO: {
    minMcap: 30_000,              // Lowered floor - catch earlier
    maxMcap: 225_000,             // Sweet spot ceiling per formula
    enabled: true,
    minLiquidity: 500,            // Early gems start tiny
    minSafetyScore: 20,           // Memecoins are inherently risky
    positionSizeMultiplier: 1.0,  // Full size - this is our edge
  },
  RISING: {
    minMcap: 225_000,
    maxMcap: 1_000_000,           // Hard cap at $1M
    enabled: true,
    minLiquidity: 2000,
    minSafetyScore: 25,
    positionSizeMultiplier: 0.5,  // Half size - diminishing edge
  },
  EMERGING: {
    minMcap: 1_000_000,
    maxMcap: 5_000_000,
    enabled: false,               // DISABLED: no edge above $1M
    minLiquidity: 5000,
    minSafetyScore: 30,
    positionSizeMultiplier: 0,
  },
  GRADUATED: {
    minMcap: 5_000_000,
    maxMcap: 25_000_000,
    enabled: false,               // DISABLED
    minLiquidity: 15000,
    minSafetyScore: 35,
    positionSizeMultiplier: 0,
  },
  ESTABLISHED: {
    minMcap: 25_000_000,
    maxMcap: 150_000_000,
    enabled: false,               // DISABLED
    minLiquidity: 30000,
    minSafetyScore: 35,
    positionSizeMultiplier: 0,
  },
  UNKNOWN: {
    minMcap: 0,
    maxMcap: Infinity,
    enabled: false,
    minLiquidity: 50000,
    minSafetyScore: 70,
    positionSizeMultiplier: 0,
  },
};

function getMarketCapTier(marketCap: number): MarketCapTier {
  if (marketCap < 225_000) return 'MICRO';
  if (marketCap < 1_000_000) return 'RISING';
  if (marketCap < 5_000_000) return 'EMERGING';
  if (marketCap < 25_000_000) return 'GRADUATED';
  if (marketCap < 150_000_000) return 'ESTABLISHED';
  return 'UNKNOWN';
}

// ============ PROTOCOL/STABLECOIN FILTER ============
// Exclude tokens that are:
// 1. Stablecoins (USD-pegged tokens)
// 2. LP tokens (liquidity pool tokens)
// 3. Protocol tokens (Orca, Jupiter, Raydium, Meteora)
// 4. Wrapped tokens (wSOL, etc.)

// Known stablecoin/protocol patterns to exclude
const EXCLUDED_NAME_PATTERNS = [
  // Stablecoins - exact matches only
  /^usdc$/i, /^usdt$/i, /^busd$/i, /^dai$/i, /^frax$/i, /^tusd$/i, /^usdp$/i,
  /^ust$/i, /^gusd$/i, /^husd$/i, /^susd$/i, /^lusd$/i, /^eusd$/i,
  /^usdg$/i, /^pyusd$/i, /^hyusd$/i, /^jupusd$/i, /^eurc$/i,
  /usd$/i,      // Ends with USD (hyUSD, JupUSD, etc.)

  // LP/Pool tokens
  /\s*\/\s*/,   // Contains "/" (ONe/JitoSOL pattern)
  /^lp$/i, /^lp\s/i, /\slp$/i, /\slp\s/i,
  /-lp$/i, /-lp-/i, /^lp-/i,
  /pool$/i, /^pool/i,

  // Known LP/synthetic token names and leet-speak variants
  /^0ne$/i, /^one$/i,           // ONe LP token and "0Ne" leet-speak variant
  /^0n[3e]$/i,                   // Additional leet variants: 0N3, 0Ne
  /^infinity$/i,                 // Infinity LP token

  // Protocol tokens (DeFi infrastructure, not memecoins)
  /^orca$/i, /^jupiter$/i, /^raydium$/i,
  /^meteora$/i, /^marinade$/i,

  // Wrapped/Bridge tokens - exact patterns
  /^wsol$/i, /^weth$/i, /^wbtc$/i,
  /^wrapped\s/i, /\swrapped$/i,
  /^bridged\s/i, /\sbridged$/i,

  // Yield/Staking tokens - specific known tokens
  /^jitosol$/i, /^msol$/i, /^bsol$/i, /^stsol$/i,

  // Synthetic stock tokens - specific known patterns
  /^tslax$/i, /^nvdax$/i, /^googlx$/i, /^qqqqx$/i, /^gldx$/i,
  /^mstrx$/i, /^aaplx$/i, /^amzx$/i, /^xaut/i,
];

// Specific token addresses to always exclude (known protocol tokens)
const EXCLUDED_ADDRESSES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  // ORCA
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  // JUP
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
]);

/**
 * Check if a token is a protocol token, stablecoin, LP token, or wrapped token
 * that should be excluded from signal generation
 */
function isExcludedToken(
  address: string,
  name: string,
  ticker: string,
  price?: number
): { excluded: boolean; reason?: string } {
  // Check address blacklist first (fastest check)
  if (EXCLUDED_ADDRESSES.has(address)) {
    return { excluded: true, reason: 'Known protocol/stable address' };
  }

  // Check name and ticker against patterns
  const fullName = `${name} ${ticker}`.toLowerCase();

  for (const pattern of EXCLUDED_NAME_PATTERNS) {
    if (pattern.test(name) || pattern.test(ticker)) {
      return { excluded: true, reason: `Name/ticker matches excluded pattern: ${pattern}` };
    }
  }

  // Check for stablecoin price pattern (price ~$1 with low deviation)
  // Most stablecoins trade between $0.98 and $1.02
  if (price !== undefined && price >= 0.95 && price <= 1.05) {
    // Additional check: name suggests it's a stablecoin
    if (/usd|stable|peg|dollar/i.test(fullName)) {
      return { excluded: true, reason: `Stablecoin detected (price: $${price.toFixed(4)})` };
    }
  }

  return { excluded: false };
}

// ============ SIGNAL GENERATOR CLASS ============

// PIPELINE FIX: Raised from 3 to 5 per cycle.
// At 20s cycles, old cap of 3 = max 9/min. With relaxed thresholds,
// more tokens will pass scoring. 5 per cycle = max 15/min, still well
// within the 30/hour rate limit.
// Maximum on-chain signals per scan cycle to prevent flooding
// With 20s scan interval, 5 per cycle allows more throughput while rate limits still cap output
const MAX_ONCHAIN_SIGNALS_PER_CYCLE = 5;

// PIPELINE FIX: Reduced cooldown from 30 min to 15 min.
// 30 min was too long — tokens can change dramatically in that window.
// 15 min prevents spam while allowing re-evaluation of evolving tokens.
const SIGNAL_COOLDOWN_MS = 15 * 60 * 1000; // Reduced from 30 min to 15 min

// Diagnostic snapshot from last scan cycle
export interface ScanDiagnostics {
  timestamp: Date;
  isRunning: boolean;
  cycleTimeMs: number;
  candidates: number;
  preFilterPassed: number;
  quickFilterFails: number;
  surging: number;
  // Per-filter breakdown
  safetyBlocked: number;
  noMetrics: number;
  screeningFailed: number;
  scamRejected: number;
  rugcheckBlocked: number;
  compoundRugBlocked: number;
  scoringFailed: number;
  momentumFailed: number;
  bundleBlocked: number;
  tierBlocked: number;
  discoveryFailed: number;
  // Outputs
  signalsGenerated: number;
  onchainSignals: number;
  discoverySignals: number;
  kolValidationSignals: number;
  // Error tracking
  lastError: string | null;
  lastErrorTime: Date | null;
  consecutiveEmptyCycles: number;
}

// Rolling cumulative stats for pipeline health diagnosis
export interface RollingPipelineStats {
  windowMs: number;        // Window size (e.g. 1h, 24h)
  totalCycles: number;
  candidates: number;
  preFilterPassed: number;
  quickFilterFails: number;
  safetyBlocked: number;
  noMetrics: number;
  screeningFailed: number;
  scamRejected: number;
  rugcheckBlocked: number;
  compoundRugBlocked: number;
  scoringFailed: number;
  momentumFailed: number;
  bundleBlocked: number;
  tierBlocked: number;
  discoveryFailed: number;
  signalsGenerated: number;
  onchainSignals: number;
  discoverySignals: number;
  kolValidationSignals: number;
  errorCount: number;
}

interface CycleSnapshot {
  timestamp: number;
  candidates: number;
  preFilterPassed: number;
  quickFilterFails: number;
  safetyBlocked: number;
  noMetrics: number;
  screeningFailed: number;
  scamRejected: number;
  rugcheckBlocked: number;
  compoundRugBlocked: number;
  scoringFailed: number;
  momentumFailed: number;
  bundleBlocked: number;
  tierBlocked: number;
  discoveryFailed: number;
  signalsGenerated: number;
  onchainSignals: number;
  discoverySignals: number;
  kolValidationSignals: number;
  hadError: boolean;
}

export class SignalGenerator {
  private isRunning = false;
  // Track recently-signaled tokens to skip re-evaluation
  private recentlySignaledTokens: Map<string, number> = new Map();
  private scanTimer: NodeJS.Timeout | null = null;
  private scanCycleCount = 0;

  // Track discovery signals for KOL follow-up alerts
  private discoverySignals: Map<string, DiscoverySignal> = new Map();

  // v3: Track source of each candidate for pullback routing & source EV tracking
  private candidateSources: Map<string, string> = new Map();

  // Rolling pipeline stats: keep last 24h of cycle snapshots
  private _cycleHistory: CycleSnapshot[] = [];
  private readonly CYCLE_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

  // Diagnostics: last cycle state for /diagnostics command
  private _diagnostics: ScanDiagnostics = {
    timestamp: new Date(0),
    isRunning: false,
    cycleTimeMs: 0,
    candidates: 0,
    preFilterPassed: 0,
    quickFilterFails: 0,
    surging: 0,
    safetyBlocked: 0,
    noMetrics: 0,
    screeningFailed: 0,
    scamRejected: 0,
    rugcheckBlocked: 0,
    compoundRugBlocked: 0,
    scoringFailed: 0,
    momentumFailed: 0,
    bundleBlocked: 0,
    tierBlocked: 0,
    discoveryFailed: 0,
    signalsGenerated: 0,
    onchainSignals: 0,
    discoverySignals: 0,
    kolValidationSignals: 0,
    lastError: null,
    lastErrorTime: null,
    consecutiveEmptyCycles: 0,
  };

  getDiagnostics(): ScanDiagnostics {
    return { ...this._diagnostics, isRunning: this.isRunning };
  }

  /**
   * Get rolling pipeline stats for a given time window.
   * Aggregates all cycle snapshots within the window.
   */
  getRollingStats(windowMs: number): RollingPipelineStats {
    const cutoff = Date.now() - windowMs;
    const relevant = this._cycleHistory.filter(s => s.timestamp >= cutoff);

    const stats: RollingPipelineStats = {
      windowMs,
      totalCycles: relevant.length,
      candidates: 0,
      preFilterPassed: 0,
      quickFilterFails: 0,
      safetyBlocked: 0,
      noMetrics: 0,
      screeningFailed: 0,
      scamRejected: 0,
      rugcheckBlocked: 0,
      compoundRugBlocked: 0,
      scoringFailed: 0,
      momentumFailed: 0,
      bundleBlocked: 0,
      tierBlocked: 0,
      discoveryFailed: 0,
      signalsGenerated: 0,
      onchainSignals: 0,
      discoverySignals: 0,
      kolValidationSignals: 0,
      errorCount: 0,
    };

    for (const s of relevant) {
      stats.candidates += s.candidates;
      stats.preFilterPassed += s.preFilterPassed;
      stats.quickFilterFails += s.quickFilterFails;
      stats.safetyBlocked += s.safetyBlocked;
      stats.noMetrics += s.noMetrics;
      stats.screeningFailed += s.screeningFailed;
      stats.scamRejected += s.scamRejected;
      stats.rugcheckBlocked += s.rugcheckBlocked;
      stats.compoundRugBlocked += s.compoundRugBlocked;
      stats.scoringFailed += s.scoringFailed;
      stats.momentumFailed += s.momentumFailed;
      stats.bundleBlocked += s.bundleBlocked;
      stats.tierBlocked += s.tierBlocked;
      stats.discoveryFailed += s.discoveryFailed;
      stats.signalsGenerated += s.signalsGenerated;
      stats.onchainSignals += s.onchainSignals;
      stats.discoverySignals += s.discoverySignals;
      stats.kolValidationSignals += s.kolValidationSignals;
      if (s.hadError) stats.errorCount++;
    }

    return stats;
  }

  /**
   * Record a cycle snapshot for rolling stats
   */
  private recordCycleSnapshot(diag: ScanDiagnostics, hadError: boolean): void {
    this._cycleHistory.push({
      timestamp: Date.now(),
      candidates: diag.candidates,
      preFilterPassed: diag.preFilterPassed,
      quickFilterFails: diag.quickFilterFails,
      safetyBlocked: diag.safetyBlocked,
      noMetrics: diag.noMetrics,
      screeningFailed: diag.screeningFailed,
      scamRejected: diag.scamRejected,
      rugcheckBlocked: diag.rugcheckBlocked,
      compoundRugBlocked: diag.compoundRugBlocked,
      scoringFailed: diag.scoringFailed,
      momentumFailed: diag.momentumFailed,
      bundleBlocked: diag.bundleBlocked,
      tierBlocked: diag.tierBlocked,
      discoveryFailed: diag.discoveryFailed,
      signalsGenerated: diag.signalsGenerated,
      onchainSignals: diag.onchainSignals,
      discoverySignals: diag.discoverySignals,
      kolValidationSignals: diag.kolValidationSignals,
      hadError,
    });

    // Prune old snapshots
    const cutoff = Date.now() - this.CYCLE_HISTORY_MAX_AGE_MS;
    while (this._cycleHistory.length > 0 && this._cycleHistory[0].timestamp < cutoff) {
      this._cycleHistory.shift();
    }
  }
  
  /**
   * Initialize the signal generator
   */
  async initialize(): Promise<void> {
    logger.info('Initializing signal generator...');

    // Initialize KOL wallet monitor
    await kolWalletMonitor.initialize();

    // Initialize Telegram bot
    await telegramBot.initialize();

    // Start bonding curve monitor for pump.fun token tracking
    bondingCurveMonitor.start();

    // Sync optimizer thresholds to on-chain scoring engine
    // This ensures learned thresholds are used for risk assessment
    try {
      await thresholdOptimizer.loadThresholds();
      const thresholds = thresholdOptimizer.getCurrentThresholds();
      onChainScoringEngine.setDynamicThresholds({
        minSafetyScore: thresholds.minSafetyScore,
        maxBundleRiskScore: thresholds.maxBundleRiskScore,
      });
      logger.info({ thresholds }, 'Threshold optimizer synced with on-chain scoring engine');
      // Phase 1A: Optimizer is DISABLED — thresholds are frozen at current values.
      // Scoring model is inverted, so auto-optimization was in a doom loop.
      // Thresholds loaded above are kept as-is; no future auto-changes will be applied.
      logger.warn(
        { enabled: thresholdOptimizer.enabled },
        'Threshold optimizer auto-apply is DISABLED. Thresholds frozen at loaded values. Use /approve_thresholds to apply changes manually.'
      );
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

    // v3: Set up pullback detector callback — when pullback fires, emit the deferred signal
    pullbackDetector.setSignalCallback(async (entry, currentPrice) => {
      try {
        const meta = entry.signalMetadata;
        if (!meta?.onChainSignal) return;

        // Update the signal with the pullback entry price
        const signal = meta.onChainSignal;
        signal.suggestedEntryPrice = currentPrice;
        signal.suggestedEntryReason = `Pullback entry: ${entry.pullbackPercent * 100}% dip from peak`;

        // Send via Telegram
        await telegramBot.sendOnChainSignal(signal);

        // Record for performance tracking
        await signalPerformanceTracker.recordSignal(
          signal.id,
          entry.tokenAddress,
          entry.tokenTicker,
          'ONCHAIN',
          currentPrice, // Use pullback price as entry
          meta.metrics?.marketCap || 0,
          meta.onChainScore?.components?.momentum || 0,
          entry.qualifiedScore,
          meta.safetyResult?.safetyScore || 0,
          meta.bundleAnalysis?.riskScore || 0,
          meta.signalQuality?.signalStrength || 'MODERATE',
          {
            liquidity: meta.metrics?.liquidityPool || 0,
            tokenAge: meta.metrics?.tokenAge || 0,
            holderCount: meta.metrics?.holderCount || 0,
            top10Concentration: meta.metrics?.top10Concentration || 0,
            buySellRatio: meta.momentumData?.buySellRatio || 0,
            uniqueBuyers: meta.momentumData?.uniqueBuyers5m || 0,
            signalTrack: meta.signalTrack,
            kolReputation: meta.kolReputationTier,
            hourOfDayUtc: new Date().getUTCHours(),
            holderGrowthRate: meta.momentumData?.holderGrowthRate,
          }
        );

        // Mark as recently signaled
        this.recentlySignaledTokens.set(entry.tokenAddress, Date.now());

        logger.info({
          tokenAddress: entry.tokenAddress.slice(0, 8),
          ticker: entry.tokenTicker,
          qualifiedPrice: entry.qualifiedPrice.toFixed(6),
          entryPrice: currentPrice.toFixed(6),
          improvement: ((entry.qualifiedPrice - currentPrice) / entry.qualifiedPrice * 100).toFixed(1) + '%',
        }, 'PULLBACK SIGNAL: Better entry price achieved');
      } catch (error) {
        logger.error({ error, tokenAddress: entry.tokenAddress }, 'Failed to emit pullback signal');
      }
    });

    // v3: Initialize source tracker
    try {
      await sourceTracker.initialize();
      logger.info('Source-level EV tracker initialized');
    } catch (error) {
      logger.warn({ error }, 'Failed to initialize source tracker');
    }

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
    this.scanCycleCount++;

    // Log alpha pipeline status every 30 cycles (~10 minutes at 20s interval)
    if (this.scanCycleCount % 30 === 1) {
      try {
        const alphaBufferSize = alphaWalletManager.drainDiscoveredTokens().length;
        logger.info({
          cycle: this.scanCycleCount,
          alphaDiscoveryBufferSize: alphaBufferSize,
          heliusDisabled: appConfig.heliusDisabled,
        }, 'ALPHA PIPELINE STATUS — periodic check');
      } catch {
        // Non-critical
      }
    }

    try {
      // v3: Clear candidate source tracking for this cycle
      this.candidateSources.clear();

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

      // Step 2b: Surge detection — prioritize tokens with active micro-surges
      // Surging tokens get evaluated FIRST (before the per-cycle cap is hit)
      const surgeTokens: string[] = [];
      const normalTokens: string[] = [];

      // Only run surge detection on a sample to avoid rate limit pressure
      // Check up to 15 candidates for surges (newest/alpha sources prioritized)
      const surgeCheckLimit = Math.min(preFiltered.length, 15);
      for (let i = 0; i < surgeCheckLimit; i++) {
        try {
          const surge = await momentumAnalyzer.detectSurge(preFiltered[i]);
          if (surge.detected) {
            surgeTokens.push(preFiltered[i]);
            logger.info({
              tokenAddress: preFiltered[i].slice(0, 8),
              surgeType: surge.type,
              confidence: surge.confidence,
              multiplier: surge.multiplier.toFixed(1),
            }, 'SURGE: Token prioritized for immediate evaluation');
          } else {
            normalTokens.push(preFiltered[i]);
          }
        } catch {
          normalTokens.push(preFiltered[i]);
        }
      }
      // Add unchecked tokens to normal queue
      for (let i = surgeCheckLimit; i < preFiltered.length; i++) {
        normalTokens.push(preFiltered[i]);
      }

      // Surging tokens first, then normal candidates
      const prioritizedCandidates = [...surgeTokens, ...normalTokens];

      // Diagnostic logging - show pipeline stats every cycle
      logger.info({
        candidates: candidates.length,
        passed: preFiltered.length,
        failed: quickFilterFails,
        surging: surgeTokens.length,
      }, 'Scan cycle: pre-filter complete');

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
      let tierBlocked = 0;
      let rugcheckBlocked = 0;
      let compoundRugBlocked = 0;

      let onchainSignalsThisCycle = 0;
      for (const tokenAddress of prioritizedCandidates) {
        // Stop evaluating once we hit the per-cycle signal cap
        if (onchainSignalsThisCycle >= MAX_ONCHAIN_SIGNALS_PER_CYCLE) {
          logger.debug({ cap: MAX_ONCHAIN_SIGNALS_PER_CYCLE }, 'Per-cycle on-chain signal cap reached, skipping remaining');
          break;
        }
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
            case 'ONCHAIN_SIGNAL_SENT': onchainSignals++; onchainSignalsThisCycle++; break;
            case 'MOMENTUM_FAILED': momentumFailed++; break;
            case 'BUNDLE_BLOCKED': bundleBlocked++; break;
            case 'TIER_BLOCKED': tierBlocked++; break;
            case 'RUGCHECK_BLOCKED': rugcheckBlocked++; break;
            case 'COMPOUND_RUG_BLOCKED': compoundRugBlocked++; break;
            case 'PULLBACK_WATCHLISTED': break; // v3: Added to pullback watchlist
            case 'SKIPPED': break; // Already have position
          }
        } catch (error) {
          logger.error({ error, tokenAddress }, 'Error evaluating token');
        }
      }

      // v3: Check pullback watchlist for tokens waiting for dips
      try {
        const pullbackResults = await pullbackDetector.checkWatchlist();
        const entries = pullbackResults.filter(r => r.action === 'ENTER' || r.action === 'STRONG_RUNNER');
        if (entries.length > 0) {
          logger.info({ count: entries.length }, 'Pullback entries triggered this cycle');
        }
      } catch (error) {
        logger.debug({ error }, 'Pullback watchlist check failed');
      }

      // Clean up expired discovery signals
      this.cleanupExpiredDiscoveries();

      // Show where tokens are dropping off
      const totalSignals = signalsGenerated + onchainSignals + discoverySignals + kolValidationSignals;
      if (totalSignals > 0) {
        logger.info({
          evaluated: preFiltered.length,
          buySignals: signalsGenerated,
          onchainSignals,
          discoveries: discoverySignals,
          kolValidations: kolValidationSignals,
        }, 'Scan cycle: signals generated');
      } else if (preFiltered.length > 0) {
        // Log at info level when we have candidates but no signals — helps diagnose filtering
        logger.info({
          candidates: candidates.length,
          evaluated: preFiltered.length,
          safetyBlocked,
          noMetrics,
          screeningFailed,
          scamRejected,
          rugcheckBlocked,
          compoundRugBlocked,
          scoringFailed,
          momentumFailed,
          bundleBlocked,
          tierBlocked,
          discoveryFailed,
        }, 'Scan cycle: candidates found but all filtered out');
      }

      // Log scan cycle metrics for performance tracking
      const cycleTimeMs = Date.now() - cycleStartTime;
      const totalSignalsSent = signalsGenerated + onchainSignals + discoverySignals + kolValidationSignals;

      // Update diagnostics snapshot
      this._diagnostics = {
        timestamp: new Date(),
        isRunning: this.isRunning,
        cycleTimeMs,
        candidates: candidates.length,
        preFilterPassed: preFiltered.length,
        quickFilterFails,
        surging: surgeTokens.length,
        safetyBlocked,
        noMetrics,
        screeningFailed,
        scamRejected,
        rugcheckBlocked,
        compoundRugBlocked,
        scoringFailed,
        momentumFailed,
        bundleBlocked,
        tierBlocked,
        discoveryFailed,
        signalsGenerated,
        onchainSignals,
        discoverySignals,
        kolValidationSignals,
        lastError: this._diagnostics.lastError,
        lastErrorTime: this._diagnostics.lastErrorTime,
        consecutiveEmptyCycles: totalSignalsSent === 0
          ? this._diagnostics.consecutiveEmptyCycles + 1
          : 0,
      };

      // Record cycle snapshot for rolling stats
      this.recordCycleSnapshot(this._diagnostics, false);

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
      // Capture error in diagnostics — ALWAYS set timestamp so /diagnostics shows data
      const errorMsg = error instanceof Error ? error.message : String(error);
      this._diagnostics.timestamp = new Date();
      this._diagnostics.isRunning = this.isRunning;
      this._diagnostics.lastError = errorMsg;
      this._diagnostics.lastErrorTime = new Date();
      this._diagnostics.consecutiveEmptyCycles++;
      this.recordCycleSnapshot(this._diagnostics, true);
      logger.error({ error: errorMsg, stack: error instanceof Error ? error.stack : undefined }, 'Error in scan cycle');
      await performanceLogger.logError('SYSTEM', 'Scan cycle error', error).catch(() => {});
    }
  }
  
  /**
   * Get candidate tokens to evaluate
   * Now uses multi-source discovery: DexScreener, Jupiter, volume anomalies,
   * holder growth velocity, and narrative-based searches
   */
  private async getCandidateTokens(): Promise<string[]> {
    const candidates: Set<string> = new Set();

    // ===== SOURCE 1: DexScreener New Pairs (recently listed tokens) =====
    try {
      const newPairs = await dexScreenerClient.getNewSolanaPairs(50);

      for (const pair of newPairs) {
        const addr = pair.tokenAddress || pair.baseToken?.address;
        if (addr) {
          candidates.add(addr);
        }
      }

      if (candidates.size > 0) {
        logger.debug({
          count: candidates.size,
          source: 'DexScreener new pairs'
        }, 'Candidates from DexScreener new pairs');
      }
    } catch (error) {
      logger.debug({ error }, 'DexScreener new pairs failed');
    }

    // ===== SOURCE 2: Jupiter Recent Tokens (new tokens) =====
    try {
      const recentTokens = await jupiterClient.getRecentTokens(50);

      for (const address of recentTokens) {
        candidates.add(address);
      }

      if (recentTokens.length > 0) {
        logger.debug({
          count: recentTokens.length,
          source: 'Jupiter recent'
        }, 'Candidates from Jupiter recent tokens');
      }
    } catch (error) {
      logger.debug({ error }, 'Jupiter recent tokens failed');
    }

    // ===== SOURCE 3: DexScreener Trending (active tokens) =====
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

    // ===== SOURCE 4: Discovery Engine (smart money scanner) =====
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

    // ===== SOURCE 5: GMGN Trending (smart money + swap activity) =====
    // v3: GMGN tokens are tagged for pullback entry routing
    try {
      const gmgnTokens = await gmgnClient.getTrendingSolanaTokens(50);

      for (const address of gmgnTokens) {
        candidates.add(address);
        // Only tag as GMGN if not already tagged with a higher-priority source
        if (!this.candidateSources.has(address)) {
          this.candidateSources.set(address, 'GMGN');
        }
      }

      if (gmgnTokens.length > 0) {
        logger.debug({
          count: gmgnTokens.length,
          source: 'GMGN trending'
        }, 'Candidates from GMGN');
      }
    } catch (error) {
      logger.debug({ error }, 'GMGN trending failed');
    }

    // ===== SOURCE 6: Alpha Wallet Buys (direct feed from trade monitor) =====
    try {
      const alphaTokens = alphaWalletManager.drainDiscoveredTokens();

      for (const address of alphaTokens) {
        candidates.add(address);
        // Alpha wallet = IMMEDIATE entry (overrides GMGN tag)
        this.candidateSources.set(address, 'ALPHA_WALLET');
      }

      if (alphaTokens.length > 0) {
        logger.info({
          count: alphaTokens.length,
          source: 'Alpha wallet buys'
        }, 'Candidates from alpha wallet activity');
      }
    } catch (error) {
      logger.debug({ error }, 'Alpha wallet discovery drain failed');
    }

    // Log final candidate pool composition
    logger.debug({
      totalCandidates: candidates.size,
      sources: 'DexScreener + Jupiter + Discovery Engine + GMGN + Alpha Wallets',
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
    TIER_BLOCKED: 'TIER_BLOCKED',            // New: Token in disabled tier (e.g., EMERGING)
    RUGCHECK_BLOCKED: 'RUGCHECK_BLOCKED',    // RugCheck DANGER hard block
    COMPOUND_RUG_BLOCKED: 'COMPOUND_RUG_BLOCKED', // Multiple rug indicators combined
    PULLBACK_WATCHLISTED: 'PULLBACK_WATCHLISTED', // v3: Added to pullback watchlist
  } as const;

  /**
   * Fully evaluate a single token with diagnostic return value
   * Now supports both KOL-triggered and discovery-triggered signals
   */
  private async evaluateTokenWithDiagnostics(tokenAddress: string): Promise<string> {
    const shortAddr = tokenAddress.slice(0, 8);

    // Skip tokens that were recently signaled (30 min cooldown)
    const lastSignaled = this.recentlySignaledTokens.get(tokenAddress);
    if (lastSignaled && Date.now() - lastSignaled < SIGNAL_COOLDOWN_MS) {
      return SignalGenerator.EVAL_RESULTS.SKIPPED;
    }

    // Clean up expired cooldowns periodically (every ~100 checks)
    if (Math.random() < 0.01) {
      const now = Date.now();
      for (const [addr, ts] of this.recentlySignaledTokens) {
        if (now - ts >= SIGNAL_COOLDOWN_MS) this.recentlySignaledTokens.delete(addr);
      }
    }

    // Check if we already have an open position
    if (await Database.hasOpenPosition(tokenAddress)) {
      logger.debug({ tokenAddress: shortAddr }, 'EVAL: Skipped - already have position');
      return SignalGenerator.EVAL_RESULTS.SKIPPED;
    }

    // ============ ALPHA WALLET FAST-TRACK ============
    // Alpha wallet-discovered tokens bypass tier/screening/scam gates.
    // Smart money buying IS the signal — these wallets buy early when tokens
    // have low holders, low volume, and tiny mcap (exactly what screening rejects).
    // We still check safety (rug/honeypot) and protocol exclusion but skip
    // tier filtering, screening criteria, and scam filter.
    const isAlphaSource = this.candidateSources.get(tokenAddress) === 'ALPHA_WALLET';

    // FEATURE 1 & 5: Run enhanced safety check FIRST (before other checks)
    const safetyResult = await tokenSafetyChecker.checkTokenSafety(tokenAddress);
    const safetyBlock = tokenSafetyChecker.shouldBlockSignal(safetyResult);

    if (safetyBlock.blocked) {
      logger.info({ tokenAddress: shortAddr, reason: safetyBlock.reason, isAlpha: isAlphaSource }, 'EVAL: Safety blocked');
      return SignalGenerator.EVAL_RESULTS.SAFETY_BLOCKED;
    }

    // Get comprehensive token data first (needed for both paths)
    const metrics = await getTokenMetrics(tokenAddress);
    if (!metrics) {
      logger.debug({ tokenAddress: shortAddr }, 'EVAL: No metrics available');
      return SignalGenerator.EVAL_RESULTS.NO_METRICS;
    }

    // PROTOCOL/STABLECOIN FILTER: Exclude non-memecoin tokens
    // Must be after metrics fetch since we need name, ticker, price
    const exclusionCheck = isExcludedToken(
      tokenAddress,
      metrics.name,
      metrics.ticker,
      metrics.price
    );
    if (exclusionCheck.excluded) {
      logger.debug({
        tokenAddress: shortAddr,
        name: metrics.name,
        ticker: metrics.ticker,
        reason: exclusionCheck.reason,
      }, 'EVAL: Excluded - protocol/stable/LP token');
      return SignalGenerator.EVAL_RESULTS.SCREENING_FAILED;
    }

    // ALPHA FAST-TRACK: Skip tier/screening/scam gates — go directly to alpha signal path
    // PIPELINE FIX: Added minimum token sanity checks.
    // Previously had ZERO quality gates — even ghost pump.fun launches with
    // 1 holder and $10K mcap would generate signals if any tracked wallet bought them.
    // Smart money buying IS a signal, but the TOKEN must show minimum viability.
    if (isAlphaSource) {
      // MINIMUM VIABILITY CHECKS — these are very lenient but prevent pure garbage
      const ALPHA_MIN_HOLDERS = 5;       // At least some real buyers exist
      const ALPHA_MIN_MCAP = 15_000;     // $15K — below this is a ghost token
      const ALPHA_MIN_VOLUME = 500;      // Some actual trading activity

      if (metrics.holderCount < ALPHA_MIN_HOLDERS ||
          metrics.marketCap < ALPHA_MIN_MCAP ||
          metrics.volume24h < ALPHA_MIN_VOLUME) {
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          mcap: metrics.marketCap,
          holders: metrics.holderCount,
          volume: metrics.volume24h,
          reason: `Alpha fast-track blocked: holders=${metrics.holderCount}/<${ALPHA_MIN_HOLDERS}, mcap=${metrics.marketCap}/<${ALPHA_MIN_MCAP}, vol=${metrics.volume24h}/<${ALPHA_MIN_VOLUME}`,
        }, 'EVAL: ALPHA BLOCKED — token below minimum viability');
        return SignalGenerator.EVAL_RESULTS.SCREENING_FAILED;
      }

      // Check wallet performance — don't signal from wallets with proven negative edge
      const alphaInfo = alphaWalletManager.getDiscoveredTokenInfo(tokenAddress);
      if (alphaInfo) {
        // Try alpha wallet DB first, then engine wallet DB
        const alphaWallet = await alphaWalletManager.getWalletByAddress(alphaInfo.walletAddress);
        let engineWallet: any = null;
        if (!alphaWallet) {
          try {
            const { walletEngine: engine } = await import('../wallets/walletEngine.js');
            engineWallet = await engine.getWalletByAddress(alphaInfo.walletAddress);
          } catch { /* non-critical */ }
        }

        if (alphaWallet) {
          // Block signals from alpha wallets with 0% win rate on 10+ total trades
          const totalTrades = alphaWallet.totalTrades ?? 0;
          const winRate = alphaWallet.winRate ?? 0;
          const status = alphaWallet.status;
          if (totalTrades >= 10 && winRate === 0) {
            logger.info({
              tokenAddress: shortAddr,
              ticker: metrics.ticker,
              walletAddress: alphaInfo.walletAddress.slice(0, 8),
              totalTrades,
              winRate,
              status,
            }, 'EVAL: ALPHA BLOCKED — wallet has 0% win rate on 10+ trades, no demonstrated edge');
            return SignalGenerator.EVAL_RESULTS.SAFETY_BLOCKED;
          }

          // Block SUSPENDED and REMOVED wallets from generating signals
          if (status === 'SUSPENDED' || status === 'REMOVED') {
            logger.info({
              tokenAddress: shortAddr,
              walletAddress: alphaInfo.walletAddress.slice(0, 8),
              status,
            }, 'EVAL: ALPHA BLOCKED — wallet suspended/removed');
            return SignalGenerator.EVAL_RESULTS.SAFETY_BLOCKED;
          }
        } else if (engineWallet) {
          // Block signals from engine wallets with bad status
          if (engineWallet.status === 'SUSPENDED' || engineWallet.status === 'PURGED') {
            logger.info({
              tokenAddress: shortAddr,
              walletAddress: alphaInfo.walletAddress.slice(0, 8),
              status: engineWallet.status,
            }, 'EVAL: ALPHA BLOCKED — engine wallet suspended/purged');
            return SignalGenerator.EVAL_RESULTS.SAFETY_BLOCKED;
          }
        }
      }

      logger.info({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        mcap: metrics.marketCap,
        holders: metrics.holderCount,
        liq: metrics.liquidityPool,
      }, 'EVAL: ALPHA FAST-TRACK — passed minimum viability, bypassing screening gates');

      // Get alpha wallet activity info from the discovery buffer
      if (alphaInfo) {
        // Build minimal alpha activity for signal generation
        // Try alpha wallet DB first, then engine wallet DB (engine wallets aren't in alpha_wallets table)
        let wallet = await alphaWalletManager.getWalletByAddress(alphaInfo.walletAddress);
        let resolvedSignalWeight = wallet?.signalWeight ?? 0.6;

        if (!wallet) {
          // Engine wallet — build a compatible AlphaWallet-like object from engine wallet data
          try {
            const { walletEngine: engine } = await import('../wallets/walletEngine.js');
            const ew = await engine.getWalletByAddress(alphaInfo.walletAddress);
            if (ew) {
              resolvedSignalWeight = ew.weight;
              // Create a compatible wallet object for the alpha signal handler
              wallet = {
                id: ew.id,
                address: ew.walletAddress,
                label: alphaInfo.walletLabel || `Engine:${ew.source}`,
                status: ew.status as any,
                signalWeight: ew.weight,
                totalTrades: ew.totalSignals || ew.observedTrades,
                wins: 0,
                losses: 0,
                winRate: ew.signalWinRate || ew.observedWinRate,
                avgRoi: ew.signalEv || ew.observedEv,
                addedAt: ew.addedAt,
                addedBy: 'engine',
                lastTradeAt: ew.updatedAt,
                suspendedAt: ew.suspendedAt,
                suspensionCount: 0,
                updatedAt: ew.updatedAt,
              } as any;
              logger.info({
                tokenAddress: shortAddr,
                walletAddress: alphaInfo.walletAddress.slice(0, 8),
                source: ew.source,
                weight: ew.weight,
              }, 'EVAL: ALPHA resolved via engine wallet DB');
            }
          } catch (err) {
            logger.debug({ err }, 'EVAL: Failed to look up engine wallet');
          }
        }

        if (wallet) {
          const socialMetrics = await this.getSocialMetrics(tokenAddress, metrics);
          const volumeAuthenticity = await calculateVolumeAuthenticity(tokenAddress);
          const scamResult = await scamFilter.filterToken(tokenAddress);
          const dexScreenerInfo = await dexScreenerClient.getTokenInfo(tokenAddress);
          const ctoAnalysis = await analyzeCTO(
            tokenAddress, metrics.name, metrics.ticker,
            safetyResult.deployerHolding,
            !safetyResult.mintAuthorityEnabled,
            !safetyResult.freezeAuthorityEnabled,
            metrics.tokenAge, dexScreenerInfo
          );
          const enrichment = await this.getSignalEnrichment(tokenAddress, metrics.marketCap);

          const alphaActivities = [{
            wallet,
            transaction: {
              signature: alphaInfo.txSignature,
              solAmount: alphaInfo.solAmount,
              tokensAcquired: 0,
              timestamp: new Date(alphaInfo.discoveredAt),
            },
            signalWeight: resolvedSignalWeight,
          }];

          return await this.handleAlphaSignal(
            tokenAddress, metrics, socialMetrics, volumeAuthenticity,
            scamResult, alphaActivities, safetyResult,
            dexScreenerInfo, ctoAnalysis, enrichment
          );
        }
      }
      // If we can't resolve the alpha wallet info, fall through to normal path
      logger.warn({ tokenAddress: shortAddr }, 'EVAL: Alpha fast-track failed to resolve wallet info, falling through');
    }

    // TIER-AWARE FILTERING: Check market cap tier before proceeding
    const tier = getMarketCapTier(metrics.marketCap);
    const tierConfig = TIER_CONFIGS[tier];

    logger.debug({
      tokenAddress: shortAddr,
      ticker: metrics.ticker,
      mcap: metrics.marketCap,
      tier,
      tierEnabled: tierConfig.enabled,
      vol24h: metrics.volume24h,
      holders: metrics.holderCount,
      liq: metrics.liquidityPool,
      age: metrics.tokenAge,
    }, 'EVAL: Got metrics, checking tier and screening criteria');

    // Block signals from disabled tiers (e.g., EMERGING with 11% win rate)
    if (!tierConfig.enabled) {
      logger.debug({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        tier,
        marketCap: metrics.marketCap,
        reason: `${tier} tier disabled due to poor historical performance`,
      }, 'EVAL: BLOCKED - Tier disabled');
      return SignalGenerator.EVAL_RESULTS.TIER_BLOCKED;
    }

    // Apply tier-specific liquidity requirements
    if (metrics.liquidityPool < tierConfig.minLiquidity) {
      logger.debug({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        tier,
        liquidity: metrics.liquidityPool,
        required: tierConfig.minLiquidity,
      }, 'EVAL: BLOCKED - Below tier liquidity requirement');
      return SignalGenerator.EVAL_RESULTS.TIER_BLOCKED;
    }

    // Check if token meets minimum screening criteria
    if (!this.meetsScreeningCriteria(metrics)) {
      return SignalGenerator.EVAL_RESULTS.SCREENING_FAILED;
    }

    logger.debug({ tokenAddress: shortAddr, ticker: metrics.ticker }, 'EVAL: Passed screening, running scam filter');

    // Run full scam filter
    const scamResult = await scamFilter.filterToken(tokenAddress);
    if (scamResult.result === 'REJECT') {
      logger.info({ tokenAddress: shortAddr, ticker: metrics.ticker, flags: scamResult.flags }, 'EVAL: Scam filter rejected');
      return SignalGenerator.EVAL_RESULTS.SCAM_REJECTED;
    }

    logger.debug({ tokenAddress: shortAddr, ticker: metrics.ticker }, 'EVAL: Passed scam filter, running RugCheck hard gate');

    // ============ RUGCHECK HARD GATE ============
    // RugCheck DANGER is an absolute deal-breaker — even in learning mode.
    // This catches tokens that the scam filter missed because the scam filter
    // only checks contract basics, while RugCheck does deeper analysis.
    try {
      const rugCheckResult = await rugCheckClient.checkToken(tokenAddress);
      const rugDecision = rugCheckClient.getDecision(rugCheckResult);

      if (rugDecision.action === 'AUTO_SKIP') {
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          rugCheckScore: rugCheckResult.score,
          reason: rugDecision.reason,
        }, 'EVAL: RugCheck BLOCKED');
        return SignalGenerator.EVAL_RESULTS.RUGCHECK_BLOCKED;
      }

      if (rugDecision.action === 'NEGATIVE_MODIFIER') {
        logger.debug({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          rugCheckScore: rugCheckResult.score,
          reason: rugDecision.reason,
        }, 'EVAL: RugCheck WARNING - applying negative modifier');
        // Warning is applied via the safety score; continue evaluation
      }
    } catch (error) {
      logger.debug({ error, tokenAddress: shortAddr }, 'RugCheck hard gate check failed (non-blocking)');
      // Fail open - don't block if RugCheck API is down
    }

    // ============ COMPOUND RUG SIGNAL DETECTION ============
    // Individual flags are weak, but multiple flags together strongly indicate a rug.
    // This catches tokens where each individual check passes but the combination is toxic.
    {
      let rugIndicatorCount = 0;
      const rugIndicators: string[] = [];

      // Scam filter flags (each flag is a weak signal)
      if (scamResult.flags.length >= 2) {
        rugIndicatorCount++;
        rugIndicators.push(`${scamResult.flags.length} scam flags`);
      }
      if (scamResult.flags.length >= 4) {
        rugIndicatorCount++; // Extra weight for many flags
        rugIndicators.push('excessive scam flags');
      }

      // Bundle risk + rug history
      if (scamResult.bundleAnalysis.hasRugHistory) {
        rugIndicatorCount += 2; // Strong indicator
        rugIndicators.push('bundle rug history');
      }
      if (scamResult.bundleAnalysis.bundledSupplyPercent > 25) {
        rugIndicatorCount++;
        rugIndicators.push(`${scamResult.bundleAnalysis.bundledSupplyPercent.toFixed(0)}% bundled supply`);
      }

      // Dev wallet red flags
      if (scamResult.devBehaviour?.transferredToCex) {
        rugIndicatorCount += 2; // Strong indicator
        rugIndicators.push('dev CEX transfer');
      }
      if (scamResult.devBehaviour && scamResult.devBehaviour.soldPercent48h > 10) {
        rugIndicatorCount++;
        rugIndicators.push(`dev sold ${scamResult.devBehaviour.soldPercent48h.toFixed(0)}%`);
      }

      // Contract issues
      if (!scamResult.contractAnalysis.mintAuthorityRevoked &&
          !scamResult.contractAnalysis.freezeAuthorityRevoked) {
        rugIndicatorCount++;
        rugIndicators.push('both authorities enabled');
      }

      // Safety score integration
      if (safetyResult.safetyScore < 40) {
        rugIndicatorCount++;
        rugIndicators.push(`low safety score (${safetyResult.safetyScore})`);
      }

      // THRESHOLD: 3+ compound indicators = likely rug
      // This fires even in learning mode — compound rugs are too risky
      const COMPOUND_RUG_THRESHOLD = 3;
      if (rugIndicatorCount >= COMPOUND_RUG_THRESHOLD) {
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          rugIndicatorCount,
          rugIndicators,
        }, 'EVAL: Compound rug BLOCKED');
        return SignalGenerator.EVAL_RESULTS.COMPOUND_RUG_BLOCKED;
      }

      if (rugIndicatorCount >= 2) {
        logger.debug({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          rugIndicatorCount,
          rugIndicators,
        }, 'EVAL: Elevated rug risk (below block threshold, proceeding with caution)');
      }
    }

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
      logger.debug({
        address: tokenAddress.slice(0, 8),
        dexPaid: dexScreenerInfo.hasPaidDexscreener,
        boosts: dexScreenerInfo.boostCount,
        isCTO: ctoAnalysis.isCTO,
        ctoConfidence: ctoAnalysis.ctoConfidence,
      }, 'DexScreener/CTO status detected');
    }

    // Enrichment: run predictive analysis modules in parallel
    const enrichment = await this.getSignalEnrichment(tokenAddress, metrics.marketCap);

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

      // Check if this token was launched by a tracked dev — send KOL validation if so
      try {
        const devTokenResult = await import('../utils/database.js').then(db =>
          db.pool.query(
            `SELECT dt.token_mint, dt.token_symbol, d.wallet_address
             FROM pumpfun_dev_tokens dt
             JOIN pumpfun_devs d ON d.id = dt.dev_id
             WHERE dt.token_mint = $1 AND d.is_active = true
             LIMIT 1`,
            [tokenAddress]
          )
        );
        if (devTokenResult.rows.length > 0) {
          const devToken = devTokenResult.rows[0];
          const kolHandle = kolActivities[0]?.kol?.handle || 'Unknown';
          const validationMsg = formatDevKolValidation(
            tokenAddress,
            devToken.token_symbol || metrics.ticker,
            kolHandle,
          );
          await telegramBot.sendDevSignal(validationMsg, tokenAddress);
          logger.info({
            tokenAddress,
            kolHandle,
            devWallet: devToken.wallet_address,
          }, 'Dev token KOL validation sent');
        }
      } catch (devCheckErr) {
        logger.debug({ devCheckErr }, 'Dev KOL cross-reference check failed (non-blocking)');
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

    // ============ PATH A2: ALPHA WALLET ACTIVITY DETECTED ============
    // Check if any tracked alpha wallets have bought this token
    const alphaActivity = await kolWalletMonitor.getAlphaWalletActivityForToken(
      tokenAddress,
      KOL_ACTIVITY_WINDOW_MS
    );

    if (alphaActivity.length > 0) {
      logger.info({ tokenAddress, alphaCount: alphaActivity.length }, 'Alpha wallet activity detected');

      return await this.handleAlphaSignal(
        tokenAddress,
        metrics,
        socialMetrics,
        volumeAuthenticity,
        scamResult,
        alphaActivity,
        safetyResult,
        dexScreenerInfo,
        ctoAnalysis,
        enrichment
      );
    }

    // ============ PATH B: NO KOL - ON-CHAIN MOMENTUM ANALYSIS ============
    // NEW: Use on-chain momentum analysis instead of social metrics

    logger.debug({ tokenAddress: shortAddr, ticker: metrics.ticker }, 'EVAL: Entering PATH B (no KOL) - calculating on-chain score');

    // Step 1: Calculate comprehensive on-chain score (handles momentum + bundle internally)
    const onChainScore = await onChainScoringEngine.calculateScore(tokenAddress, metrics);

    // Step 1.5: Calculate social verification score from DexScreener
    // Social links (Twitter, Telegram, etc.) indicate project legitimacy
    const socialScore = this.calculateSocialScore(dexScreenerInfo);

    // v3: Social score is now ±15 (was 0-25). Can be negative for fake socials.
    const socialBonus = Math.max(-7, Math.min(15, socialScore.score));

    // Surge detection bonus — tokens with active micro-surges get a score boost
    // This helps surging tokens clear thresholds faster (catching the ignition, not the peak)
    let surgeBonus = 0;
    try {
      const surge = await momentumAnalyzer.detectSurge(tokenAddress);
      if (surge.detected) {
        surgeBonus = surge.confidence === 'HIGH' ? 15 :
                     surge.confidence === 'MEDIUM' ? 10 : 5;
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          surgeType: surge.type,
          surgeConfidence: surge.confidence,
          surgeBonus,
        }, 'SURGE BONUS applied to on-chain score');
      }
    } catch {
      // Surge detection is best-effort — don't block evaluation
    }

    // Candlestick structure analysis — reads price patterns to improve entry timing
    // Score range: -50 (bearish) to +50 (bullish), applied as bonus/penalty (capped at ±10)
    let candlestickBonus = 0;
    let candlestickInfo = '';
    let candleAnalysis: import('./candlestick-analyzer.js').CandlestickAnalysis | null = null;
    try {
      candleAnalysis = await candlestickAnalyzer.analyze(tokenAddress, '5m');
      if (candleAnalysis) {
        // Scale the -50..+50 score to a -10..+10 bonus for the adjusted total
        candlestickBonus = Math.max(-10, Math.min(10, Math.round(candleAnalysis.score / 5)));
        const patternNames = candleAnalysis.patterns.map(p => p.name);
        candlestickInfo = `${candleAnalysis.dominantSignal} (${candleAnalysis.trendDirection}, patterns: ${patternNames.join(',') || 'none'})`;

        if (candlestickBonus !== 0) {
          logger.info({
            tokenAddress: shortAddr,
            ticker: metrics.ticker,
            candleScore: candleAnalysis.score,
            candlestickBonus,
            patterns: patternNames,
            trend: candleAnalysis.trendDirection,
            trendStrength: candleAnalysis.trendStrength,
            dominantSignal: candleAnalysis.dominantSignal,
          }, 'CANDLESTICK analysis applied to score');
        }
      }
    } catch {
      // Candlestick analysis is best-effort — don't block evaluation
    }

    // Phase 2: Apply enrichment bonuses from social velocity, whale detection, LP additions
    let enrichmentBonus = 0;
    if (enrichment.socialVelocity) {
      enrichmentBonus += enrichment.socialVelocity.bonusPoints;
    }
    if (enrichment.whaleActivity) {
      enrichmentBonus += enrichment.whaleActivity.bonusPoints;
    }
    if (enrichment.liquidity) {
      enrichmentBonus += enrichment.liquidity.bonusPoints;
    }

    // PIPELINE FIX: Raised bonus cap from 15 to 20 points.
    // With rebalanced weights, base scores cluster 30-50 instead of 50-70.
    // A 15-point cap was too restrictive — legitimate early tokens with strong
    // social presence + surge couldn't clear the threshold.
    // 20 points allows social/surge to be meaningful without dominating.
    const totalBonus = socialBonus + surgeBonus + candlestickBonus + enrichmentBonus;
    const cappedBonus = Math.min(totalBonus, 20); // Raised from 15 to 20
    const adjustedTotal = Math.min(100, Math.max(0, onChainScore.total + cappedBonus));

    logger.debug({
      tokenAddress: shortAddr,
      ticker: metrics.ticker,
      onChainTotal: onChainScore.total,
      socialBonus,
      surgeBonus,
      candlestickBonus,
      enrichmentBonus,
      adjustedTotal,
      candlestickInfo: candlestickInfo || 'N/A',
      recommendation: onChainScore.recommendation,
      riskLevel: onChainScore.riskLevel,
      momentum: onChainScore.components.momentum,
      safety: onChainScore.components.safety,
      socialBreakdown: socialScore.breakdown.length > 0 ? socialScore.breakdown.join(', ') : 'None',
      phase2Enrichment: enrichmentBonus > 0 ? {
        social: enrichment.socialVelocity?.bonusPoints || 0,
        whale: enrichment.whaleActivity?.bonusPoints || 0,
        lp: enrichment.liquidity?.bonusPoints || 0,
      } : undefined,
    }, 'EVAL: On-chain + social + candlestick + enrichment scoring complete');

    // Step 2: Check if bundle/safety risk is too high
    // CRITICAL risk is ALWAYS blocked (non-negotiable)
    // HIGH risk: blocked in production, allowed in learning mode for data collection
    // RugCheck hard gate and compound rug detection above already catch actual rugs
    const isLearning = appConfig.trading.learningMode;
    if (onChainScore.riskLevel === 'CRITICAL') {
      logger.debug({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        riskLevel: onChainScore.riskLevel,
        warnings: onChainScore.warnings,
      }, 'EVAL: BLOCKED - CRITICAL risk level');
      return SignalGenerator.EVAL_RESULTS.BUNDLE_BLOCKED;
    }
    if (onChainScore.riskLevel === 'HIGH' && !isLearning) {
      logger.debug({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        riskLevel: onChainScore.riskLevel,
        warnings: onChainScore.warnings,
      }, 'EVAL: BLOCKED - HIGH risk level (production mode)');
      return SignalGenerator.EVAL_RESULTS.BUNDLE_BLOCKED;
    }
    if (onChainScore.riskLevel === 'HIGH' && isLearning) {
      logger.debug({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        riskLevel: onChainScore.riskLevel,
      }, 'EVAL: HIGH risk allowed in learning mode — RugCheck/compound gates provide safety');
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
    // PIPELINE FIX: Expand EARLY_QUALITY window further to capture more winners.
    // Data: EARLY_QUALITY 33% WR vs PROVEN_RUNNER 20% WR.
    // 97% of signals were going through the losing track.
    // Expand early window to 90 min, push proven runner to 120 min,
    // so most "trending" tokens hit the better-performing track.
    const PROVEN_RUNNER_MIN_AGE = 120;  // 2 hours (was 90 min)
    const EARLY_QUALITY_MAX_AGE = 90;   // Expanded from 60 to 90 minutes
    const TRANSITION_ZONE_MIN_AGE = 90; // Transition zone 90-120 min

    let signalTrack: SignalTrack | null = null;
    let kolReputationTier: KolReputationTier | undefined;

    if (metrics.tokenAge >= PROVEN_RUNNER_MIN_AGE) {
      // TRACK 1: PROVEN RUNNER - Token has survived, time is trust
      signalTrack = SignalTrack.PROVEN_RUNNER;
      logger.debug({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        tokenAgeMinutes: metrics.tokenAge,
        track: 'PROVEN_RUNNER',
      }, 'EVAL: Routing to PROVEN RUNNER track');

    } else if (metrics.tokenAge < 2) {
      // BLOCKED: Tokens under 2 minutes are too risky (instant dumps)
      logger.debug({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        tokenAgeMinutes: metrics.tokenAge,
        reason: 'Token under 2 minutes old - too risky, instant dump potential',
      }, 'EVAL: BLOCKED - Token too new (< 2 min)');
      return SignalGenerator.EVAL_RESULTS.TOO_EARLY;

    } else if (metrics.tokenAge < EARLY_QUALITY_MAX_AGE) {
      // TRACK 2: EARLY QUALITY (2-60 min) — expanded from 45 min (EMERGENCY FIX 2)
      // Route to EARLY_QUALITY track without requiring KOL validation.
      // KOL activity adds bonus points but is not a gate.
      signalTrack = SignalTrack.EARLY_QUALITY;

      // Check for KOL activity as optional bonus (not required)
      const kolActivity = await kolWalletMonitor.getKolActivityForToken(tokenAddress);
      if (kolActivity.length > 0) {
        let bestKolTier: KolReputationTier = KolReputationTier.UNPROVEN;

        for (const activity of kolActivity) {
          const kolCheck = await kolAnalytics.isHighTierKolByHandle(activity.kol.handle);
          if (kolCheck.isTrusted) {
            if (kolCheck.tier === KolReputationTier.S_TIER) {
              bestKolTier = KolReputationTier.S_TIER;
              break;
            } else if (kolCheck.tier === KolReputationTier.A_TIER) {
              bestKolTier = KolReputationTier.A_TIER;
            } else if (kolCheck.tier === KolReputationTier.B_TIER && bestKolTier === KolReputationTier.UNPROVEN) {
              bestKolTier = KolReputationTier.B_TIER;
            }
          }
        }

        const isAcceptableKol = bestKolTier === KolReputationTier.S_TIER ||
                                 bestKolTier === KolReputationTier.A_TIER ||
                                 bestKolTier === KolReputationTier.B_TIER;

        if (isAcceptableKol) {
          kolReputationTier = bestKolTier;
        }

        logger.debug({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          tokenAgeMinutes: metrics.tokenAge,
          track: 'EARLY_QUALITY',
          kolActivity: kolActivity.length,
          kolTier: kolReputationTier || 'NONE',
        }, 'EVAL: Routing to EARLY QUALITY track (KOL bonus applied if found)');
      } else {
        logger.debug({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          tokenAgeMinutes: metrics.tokenAge,
          track: 'EARLY_QUALITY',
        }, 'EVAL: Routing to EARLY QUALITY track (no KOL - on-chain only)');
      }

    } else {
      // EMERGENCY FIX 2: TRANSITION ZONE (60-90 min)
      // Creates a gradient: EARLY(2-60) → TRANSITION(60-90) → PROVEN(90+)
      // Transition zone gets its own intermediate requirements
      signalTrack = SignalTrack.PROVEN_RUNNER; // Still tracked as PROVEN_RUNNER
      logger.debug({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        tokenAgeMinutes: metrics.tokenAge,
        track: 'PROVEN_RUNNER',
        note: 'Transition zone (60-90 min) - intermediate requirements (score≥60, holders≥100, growth≥0.03)',
      }, 'EVAL: Routing transition zone token to PROVEN RUNNER track');
    }

    // Step 3: Score-based gates (PHASE 1B: DISABLED)
    // Thresholds still loaded for reference/logging but NOT used as pass/fail gates.
    // Scoring model is inverted — low scores predict winners (+237% EV in Q1 vs -27% in Q4).
    const thresholds = thresholdOptimizer.getCurrentThresholds();
    // MIN_MOMENTUM_SCORE and MIN_ONCHAIN_SCORE no longer used as gates (Phase 1B)

    // PHASE 1B FIX: Momentum hard gate REMOVED.
    // Scoring model is inverted — low scores predict winners (+237% EV in Q1 vs -27% in Q4).
    // Score-based filtering was actively filtering OUT the best trades.
    // Scores are still calculated for data collection and position sizing.
    logger.debug({
      tokenAddress: shortAddr,
      ticker: metrics.ticker,
      momentumScore: onChainScore.components.momentum,
      safetyScore: onChainScore.components.safety,
      totalWeighted: onChainScore.total,
      note: 'Score-based filtering DISABLED — scores used for sizing only',
    }, 'EVAL: Phase 1B — momentum hard gate removed, score recorded for data collection');

    // Check if on-chain score recommends action
    // LEARNING MODE FIX: When learningMode is enabled (default: true), only block STRONG_AVOID
    // This allows more signals through for ML training data collection
    // The recommendation thresholds were conflicting with numerical thresholds:
    // - minOnChainScore: 30 (tokens with score >= 30 should pass)
    // - But AVOID recommendation was given for scores 25-39
    // - This caused ALL tokens with scores 30-39 to be blocked despite passing numerical check
    // (isLearningMode already defined above in momentum check)

    // THRESHOLD RECALIBRATION (March 2026):
    // After scoring audit demoted momentum to 5% and removed double-penalization,
    // the remaining weights (safety 30%, bundle 25%, market 35%, timing 5%) produce
    // lower raw scores. With the old thresholds (40 learning, 50 production), ZERO
    // signals were being generated because:
    //   - Most early memecoins score 30-45 on safety (authorities often enabled)
    //   - Bundle safety averages 50-70 (some bundling is normal)
    //   - Market structure needs time to build holders
    //   - Total weighted scores cluster around 35-55
    //
    // Fix: Only block STRONG_AVOID (which requires score < 20 or CRITICAL risk).
    // AVOID tokens (score 20-30) can still pass if the numerical threshold is met,
    // since the numerical check is the primary quality gate.
    const shouldBlockByRecommendation = onChainScore.recommendation === 'STRONG_AVOID';

    // PHASE 1B FIX: Score threshold check REMOVED.
    // Scoring model is inverted — effectiveMinScore was filtering OUT the best trades.
    // Only STRONG_AVOID (CRITICAL risk tokens) is still blocked — that's a structural safety filter.
    if (shouldBlockByRecommendation) {
      logger.info({
        tokenAddress: tokenAddress.slice(0, 8),
        ticker: metrics.ticker,
        score: adjustedTotal,
        recommendation: onChainScore.recommendation,
        blockedBy: 'STRONG_AVOID_RECOMMENDATION',
      }, 'EVAL: Blocked by STRONG_AVOID (CRITICAL risk) — structural filter, not score gate');
      return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
    }

    logger.debug({
      tokenAddress,
      ticker: metrics.ticker,
      onChainScore: onChainScore.total,
      socialBonus,
      adjustedTotal,
      recommendation: onChainScore.recommendation,
      learningMode: isLearningMode,
      note: 'Score-based filtering DISABLED (Phase 1B) — scores used for sizing only',
    }, 'Token PASSED structural filters — score gates bypassed (Phase 1B)');

    // Step 4: Get additional data for position sizing and display
    // Run bundle, momentum, and MEV analysis in parallel for speed
    const [bundleAnalysis, momentumData] = await Promise.all([
      bundleDetector.analyze(tokenAddress),
      momentumAnalyzer.analyze(tokenAddress),
    ]);
    const momentumScore = momentumData ? momentumAnalyzer.calculateScore(momentumData) : null;

    // v3 HARD GATE: CRITICAL bundle risk = hard rejection
    // 25% of composite score comes from bundle safety, but CRITICAL-level coordinated
    // buying is so toxic it should block outright, not just reduce score.
    if (bundleAnalysis.riskLevel === 'CRITICAL' && bundleAnalysis.bundleConfidence === 'HIGH') {
      logger.info({
        tokenAddress: shortAddr,
        ticker: metrics.ticker,
        bundleRiskScore: bundleAnalysis.riskScore,
        flags: bundleAnalysis.flags,
      }, 'EVAL: BLOCKED by CRITICAL bundle risk (hard gate)');
      return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
    }

    // v3 ATH CHECK: Penalize but don't hard-block near-ATH entries.
    // The previous hard gate was too aggressive — h6Change > 50% catches every
    // successful memecoin. Changed to score penalty instead of hard block.
    // Alpha wallet tokens skip this entirely — smart money buying at ATH IS the signal.
    if (metrics.tokenAge > 60 && !isAlphaSource) {
      try {
        const athPairs = await dexScreenerClient.getTokenPairs(tokenAddress);
        if (athPairs && athPairs.length > 0) {
          const pair = athPairs[0];
          const h1Change = pair.priceChange?.h1 || 0;
          const h6Change = pair.priceChange?.h6 || 0;
          const h24Change = pair.priceChange?.h24 || 0;
          // Only block extreme ATH entries: ALL timeframes strongly positive
          // (was blocking on any single strong timeframe which is too aggressive)
          const isExtremeATH = h1Change > 40 && h6Change > 80 && h24Change > 100;

          if (isExtremeATH) {
            logger.info({
              tokenAddress: shortAddr,
              ticker: metrics.ticker,
              tokenAge: metrics.tokenAge,
              h1Change,
              h6Change,
              h24Change,
            }, 'EVAL: BLOCKED — mature token at extreme ATH (hard gate)');
            return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
          }
        }
      } catch {
        // Non-critical — skip ATH check if DexScreener fails
      }
    }

    // Step 4.5: TRACK-SPECIFIC REQUIREMENTS
    // Different requirements for PROVEN_RUNNER vs EARLY_QUALITY
    const holderGrowthRate = momentumData?.holderGrowthRate || 0;

    if (signalTrack === SignalTrack.PROVEN_RUNNER) {
      // PIPELINE FIX: Relaxed PROVEN_RUNNER requirements
      // Previous: score >= 70, holders >= 200, growth >= 0.05
      // Problem: These requirements only let through tokens that already pumped,
      // resulting in "buying the top" — 20% WR, -22% avg return on 97% of signals.
      //
      // New approach: Use the same quality thresholds as the overall score check
      // but require positive holder growth (sign of life, not a specific rate).
      // The on-chain score + safety gates already filter quality.
      const MIN_HOLDER_GROWTH_RATE = 0.01; // Positive growth = still alive
      // PHASE 1B: MIN_PROVEN_SCORE removed — score gates disabled
      const MIN_PROVEN_HOLDERS = metrics.tokenAge >= PROVEN_RUNNER_MIN_AGE ? 100 : 75; // Relaxed from 200/100
      const holderDataAvailable = momentumData?.holderCount != null && momentumData.holderCount > 0;

      // Holder growth gate — just needs positive momentum
      if (holderDataAvailable && holderGrowthRate < MIN_HOLDER_GROWTH_RATE) {
        logger.debug({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          holderGrowthRate,
          minRequired: MIN_HOLDER_GROWTH_RATE,
          track: 'PROVEN_RUNNER',
        }, 'EVAL: BLOCKED - Holder growth too low for proven runner');
        return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
      }

      // PHASE 1B FIX: PROVEN_RUNNER score gate REMOVED.
      // Score-based filtering was actively filtering OUT the best trades (inverted model).
      // Structural filters (holders, growth, safety) remain.
      // Score is still calculated and logged for data collection.

      // Holder count gate — structural filter (kept)
      if (metrics.holderCount < MIN_PROVEN_HOLDERS) {
        logger.debug({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          holders: metrics.holderCount,
          minRequired: MIN_PROVEN_HOLDERS,
          track: 'PROVEN_RUNNER',
        }, 'EVAL: BLOCKED - Not enough holders for proven runner');
        return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
      }

      if (!holderDataAvailable) {
        logger.debug({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          track: 'PROVEN_RUNNER',
        }, 'EVAL: Holder data unavailable - skipping growth gate');
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

      // PIPELINE FIX: Further loosened EARLY_QUALITY requirements
      // Data: 12 signals, 33% win rate, +2.0% avg return — this is the winning track
      // RugCheck hard gate + compound rug detection handle actual safety concerns.
      // This threshold is just a quality floor, not a safety gate.
      const EARLY_QUALITY_MIN_SAFETY = isLearningMode ? 15 : 30;
      if (safetyResult.safetyScore < EARLY_QUALITY_MIN_SAFETY) {
        logger.debug({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          safetyScore: safetyResult.safetyScore,
          minRequired: EARLY_QUALITY_MIN_SAFETY,
          learningMode: isLearningMode,
          track: 'EARLY_QUALITY',
        }, 'EVAL: BLOCKED - Safety too low for early token');
        return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
      }

      // 2. Bundle risk — aligned with overall system threshold (50, was 45)
      const EARLY_QUALITY_MAX_BUNDLE_RISK = 50;
      if (bundleAnalysis.riskScore > EARLY_QUALITY_MAX_BUNDLE_RISK) {
        logger.debug({
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

      logger.debug({
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

    // PHASE 1B: Log all score components for every token that passes structural filters.
    // This data will be used to rebuild the scoring model with correct polarity.
    logger.info({
      data_epoch: 'phase1_fix_v2',
      tokenAddress: shortAddr,
      ticker: metrics.ticker,
      signalTrack,
      tokenAge: metrics.tokenAge,
      scores: {
        total: onChainScore.total,
        adjustedTotal,
        momentum: onChainScore.components.momentum,
        safety: onChainScore.components.safety,
        bundleSafety: onChainScore.components.bundleSafety,
        marketStructure: onChainScore.components.marketStructure,
        timing: onChainScore.components.timing,
        socialBonus,
      },
      recommendation: onChainScore.recommendation,
      confidence: onChainScore.confidence,
      bullishSignals: onChainScore.bullishSignals,
      warnings: onChainScore.warnings,
      metrics: {
        holderCount: metrics.holderCount,
        liquidityPool: metrics.liquidityPool,
        holderGrowthRate,
        bundleRiskScore: bundleAnalysis.riskScore,
        bundleRiskLevel: bundleAnalysis.riskLevel,
        safetyScore: safetyResult.safetyScore,
      },
      learningMode: isLearningMode,
    }, 'PHASE1B_DATA: Token passed all structural filters — score data recorded for model rebuild');

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

    // PIPELINE FIX: Complete rework of signal strength determination.
    // Problem: Previous formula's "STRONG" signals had 20% WR vs "MODERATE" 24% WR.
    // The strength label was anti-predictive because it rewarded safety/establishment
    // characteristics that correlate with "already pumped" tokens.
    //
    // New approach: Strength is primarily based on bundle safety (rug prevention)
    // and early entry timing. Low bundle risk + early = high conviction.
    // Safety score is a baseline, not a strength differentiator.
    let strengthScore = 0;

    // Bundle safety is the strongest actual predictor of not getting rugged
    strengthScore += onChainScore.components.bundleSafety * 0.40;

    // Safety baseline — prevents catastrophic losses
    strengthScore += onChainScore.components.safety * 0.25;

    // Market structure — some weight, but reduced from previous
    strengthScore += onChainScore.components.marketStructure * 0.20;

    // On-chain score total — overall quality
    strengthScore += onChainScore.total * 0.15;

    // PENALIZE surge-driven entries harder — buying the top is the #1 loss cause
    if (surgeBonus >= 15) {
      strengthScore -= 15; // High surge = very likely buying the top
    } else if (surgeBonus >= 10) {
      strengthScore -= 8;
    } else if (surgeBonus >= 5) {
      strengthScore -= 3;
    }

    // REWARD early entry — data shows early = better
    if (metrics.tokenAge <= 15) {
      strengthScore += 10; // Very early entry
    } else if (metrics.tokenAge <= 45) {
      strengthScore += 7;  // Early entry
    } else if (metrics.tokenAge <= 90) {
      strengthScore += 3;  // Moderate timing
    }

    // EARLY_QUALITY track boost
    if (signalTrack === SignalTrack.EARLY_QUALITY) {
      strengthScore += 5;
    }

    // Holder distribution quality (organic growth indicator)
    if (metrics.holderCount >= 100 && metrics.top10Concentration <= 50) {
      strengthScore += 5;
    }

    const signalStrength = strengthScore >= 70 ? 'STRONG' as const :
                           strengthScore >= 50 ? 'MODERATE' as const : 'WEAK' as const;
    const signalQuality = {
      signalStrength,
      kolValidated: false,
    };
    // PHASE 2B: Score-as-sizing — scores no longer filter, they SIZE positions
    // Lower scores (counter-intuitively) have shown higher EV, but we size conservatively
    // until the scoring model is rebuilt
    const BASE_POSITION_SIZE = appConfig.trading.defaultPositionSizePercent;
    let positionMultiplier = 1.0;

    // Use onchain score for sizing (inverted model — lower = historically better)
    // Conservative approach: all signals get base size, no premium for any score level
    // This avoids amplifying the inverted model's errors
    if (onChainScore) {
      if (onChainScore.total >= 70) {
        positionMultiplier = 0.5;  // High score = historically worse = smaller position
      } else if (onChainScore.total >= 50) {
        positionMultiplier = 0.75; // Medium score = standard position
      } else {
        positionMultiplier = 1.0;  // Low score = historically better = full position
      }
    }

    const scoreSizedAmount = BASE_POSITION_SIZE * positionMultiplier * tierConfig.positionSizeMultiplier;
    const positionSize = {
      solAmount: scoreSizedAmount,
      rationale: `${tier} tier, ${signalStrength} signal, score ${onChainScore?.total ?? '?'} → ${positionMultiplier}x sizing, ${tierConfig.positionSizeMultiplier}x tier`,
    };

    // Step 7: Build and send on-chain momentum signal
    const onChainSignal = await this.buildOnChainSignal(
      tokenAddress,
      metrics,
      onChainScore,
      bundleAnalysis,
      safetyResult,
      positionSize,
      signalQuality,
      momentumScore,
      socialMetrics,
      dexScreenerInfo,
      ctoAnalysis,
      signalTrack!,      // Track type (PROVEN_RUNNER or EARLY_QUALITY)
      kolReputationTier, // KOL tier (for EARLY_QUALITY track)
      enrichment,        // Predictive enrichment data
    );

    // Attach candlestick analysis to signal for Telegram display
    if (candleAnalysis) {
      (onChainSignal as any).candlestickAnalysis = candleAnalysis;
    }

    // Step 7.5: Candlestick structure gate
    // Block signals with strongly bearish chart structure — these are likely
    // dumping or distributing and would be bad entries even with good on-chain metrics.
    //
    // FIX: Severe bearish patterns (score <= -30, or THREE BLACK CROWS + DOWN trend)
    // are now hard-blocked even in learning mode. These are distribution patterns
    // that consistently lose money — no amount of training data justifies the losses.
    // Moderate bearish (score -20 to -30) still allowed through in learning mode.
    if (candleAnalysis && candleAnalysis.score <= -20) {
      const hasSevereBearishPatterns = candleAnalysis.patterns.some(
        (p: any) => p.name === 'THREE_BLACK_CROWS' || p.name === 'STRONG_BEARISH'
      );
      const isSevereBearish = candleAnalysis.score <= -30 ||
        (hasSevereBearishPatterns && candleAnalysis.trendDirection === 'DOWN');

      if (isSevereBearish || !isLearningMode) {
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          candleScore: candleAnalysis.score,
          patterns: candleAnalysis.patterns.map(p => p.name),
          trend: candleAnalysis.trendDirection,
          trendStrength: candleAnalysis.trendStrength,
          hardBlock: isSevereBearish,
        }, 'EVAL: BLOCKED - Strongly bearish candlestick structure');
        return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
      } else {
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          candleScore: candleAnalysis.score,
          patterns: candleAnalysis.patterns.map(p => p.name),
          note: 'Learning mode — moderate bearish candle allowed for data collection',
        }, 'EVAL: Bearish candle structure (allowed in learning mode)');
        // Add warning so it shows in the Telegram message
        onChainSignal.riskWarnings.push(`BEARISHCHART: Candle score ${candleAnalysis.score}`);
      }
    }

    // Step 7.6: Compound risk gate — block signals with multiple simultaneous red flags
    // Tokens with low liq + dev holding + bearish chart are near-certain losses.
    // This catches signals that pass individual gates but fail when risks compound.
    {
      const warnings = onChainSignal.riskWarnings || [];
      const hasLowLiq = metrics.liquidityPool < 20000;
      const hasDevHolding = warnings.some((w: string) => w.toLowerCase().includes('dev hold'));
      const hasBearishChart = candleAnalysis && candleAnalysis.trendDirection === 'DOWN' && candleAnalysis.trendStrength > 15;
      const hasHighConcentration = metrics.top10Concentration > 40;
      const hasLpNotLocked = warnings.some((w: string) => w.includes('LPNOTLOCKED'));

      // Count compound risk factors
      let compoundRiskCount = 0;
      if (hasLowLiq) compoundRiskCount++;
      if (hasDevHolding) compoundRiskCount++;
      if (hasBearishChart) compoundRiskCount++;
      if (hasHighConcentration) compoundRiskCount++;
      if (hasLpNotLocked) compoundRiskCount++;

      if (compoundRiskCount >= 3) {
        logger.info({
          tokenAddress: shortAddr,
          ticker: metrics.ticker,
          compoundRiskCount,
          risks: {
            lowLiq: hasLowLiq,
            devHolding: hasDevHolding,
            bearishChart: hasBearishChart,
            highConcentration: hasHighConcentration,
            lpNotLocked: hasLpNotLocked,
          },
        }, 'EVAL: BLOCKED - Compound risk gate (3+ simultaneous red flags)');
        return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
      }
    }

    // Step 7.7: Downgrade recommendation for bearish chart patterns
    // The on-chain score recommendation is computed without candlestick data.
    // If chart shows bearish structure, downgrade the recommendation so the
    // Telegram message doesn't show STRONG_BUY on a dumping token.
    if (candleAnalysis && onChainScore) {
      const isBearishChart = candleAnalysis.dominantSignal === 'BEARISH' ||
        candleAnalysis.trendDirection === 'DOWN';

      if (isBearishChart) {
        const origRec = onChainScore.recommendation;
        if (onChainScore.recommendation === 'STRONG_BUY') {
          onChainScore.recommendation = 'WATCH';
        } else if (onChainScore.recommendation === 'BUY') {
          onChainScore.recommendation = 'WATCH';
        }
        if (origRec !== onChainScore.recommendation) {
          logger.info({
            tokenAddress: shortAddr,
            ticker: metrics.ticker,
            originalRec: origRec,
            downgradedTo: onChainScore.recommendation,
            candleScore: candleAnalysis.score,
            trend: candleAnalysis.trendDirection,
            dominant: candleAnalysis.dominantSignal,
          }, 'EVAL: Recommendation downgraded due to bearish chart structure');
        }
      }
    }

    // Track for KOL follow-up (optional validation)
    this.discoverySignals.set(tokenAddress, onChainSignal);

    // Step 8: Warning count quality gate
    // Filter signals with too many red flags (excluding generic ones)
    // In learning mode, skip this filter to collect ML training data
    const seriousWarnings = (onChainSignal.riskWarnings || []).filter((w: string) =>
      !w.includes('ON-CHAIN SIGNAL') && !w.includes('No KOL')
    );
    const MAX_SERIOUS_WARNINGS = isLearningMode ? 4 : 3;

    if (seriousWarnings.length >= MAX_SERIOUS_WARNINGS) {
      logger.debug({
        tokenAddress,
        ticker: metrics.ticker,
        warningCount: seriousWarnings.length,
        warnings: seriousWarnings,
        threshold: MAX_SERIOUS_WARNINGS,
        learningMode: isLearningMode,
      }, 'Signal filtered by warning count - too many red flags');
      return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
    }

    if (isLearningMode && seriousWarnings.length >= 4) {
      logger.debug({
        tokenAddress,
        ticker: metrics.ticker,
        warningCount: seriousWarnings.length,
        warnings: seriousWarnings,
      }, 'EVAL: Learning mode - bypassing warning count filter (would be blocked in production)');
    }

    // v3: Pullback entry routing — GMGN/discovery tokens wait for dips
    const discoverySource = this.candidateSources.get(tokenAddress) || 'DISCOVERY';
    const entryMode = pullbackDetector.getEntryMode(discoverySource, metrics.tokenAge);

    if (entryMode === 'PULLBACK' && !pullbackDetector.isWatching(tokenAddress)) {
      // Add to pullback watchlist instead of emitting immediately
      await pullbackDetector.addToWatchlist(
        tokenAddress,
        metrics.ticker,
        onChainScore.total,
        metrics.price,
        discoverySource,
        {
          onChainSignal,
          metrics,
          onChainScore,
          safetyResult,
          bundleAnalysis,
          signalQuality,
          positionSize,
          signalTrack,
          kolReputationTier,
          momentumData,
        }
      );

      logger.info({
        tokenAddress: tokenAddress.slice(0, 8),
        ticker: metrics.ticker,
        source: discoverySource,
        entryMode: 'PULLBACK',
      }, 'Token routed to pullback watchlist (waiting for dip)');

      return SignalGenerator.EVAL_RESULTS.PULLBACK_WATCHLISTED;
    }

    // Send on-chain signal via Telegram
    const signalDelivered = await telegramBot.sendOnChainSignal(onChainSignal);
    if (!signalDelivered) {
      logger.warn({
        tokenAddress,
        ticker: metrics.ticker,
      }, 'Signal generated but Telegram delivery BLOCKED (check signal delivery logs above)');
    }

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
          hourOfDayUtc: new Date().getUTCHours(),
          holderGrowthRate: momentumData?.holderGrowthRate,
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

    // Mark as recently signaled to prevent re-evaluation for 30 min
    this.recentlySignaledTokens.set(tokenAddress, Date.now());

    return SignalGenerator.EVAL_RESULTS.ONCHAIN_SIGNAL_SENT;
  }

  /**
   * Build on-chain momentum signal (no KOL dependency)
   */
  private async buildOnChainSignal(
    tokenAddress: string,
    metrics: TokenMetrics,
    onChainScore: OnChainScore,
    bundleAnalysis: BundleAnalysisResult,
    safetyResult: TokenSafetyResult,
    positionSize: any,
    signalQuality: { signalStrength: 'STRONG' | 'MODERATE' | 'WEAK'; kolValidated: boolean },
    momentumScore: any,
    socialMetrics: SocialMetrics,
    dexScreenerInfo?: DexScreenerTokenInfo,
    ctoAnalysis?: CTOAnalysis,
    signalTrack: SignalTrack = SignalTrack.PROVEN_RUNNER,
    kolReputation?: KolReputationTier,
    enrichment?: SignalEnrichment,
  ): Promise<DiscoverySignal> {
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

    // ATH Detection & Suggested Entry Price
    // Fetch DexScreener pair data to get price change percentages
    let priceChangeData: { m5?: number; h1?: number; h6?: number; h24?: number } = {};
    let nearATH = false;
    let suggestedEntryPrice: number | null = null;
    let suggestedEntryReason = '';

    try {
      const pairs = await dexScreenerClient.getTokenPairs(tokenAddress);
      if (pairs && pairs.length > 0) {
        const pair = pairs[0];
        priceChangeData = {
          m5: pair.priceChange?.m5 || 0,
          h1: pair.priceChange?.h1 || 0,
          h6: pair.priceChange?.h6 || 0,
          h24: pair.priceChange?.h24 || 0,
        };

        // Detect if token is at/near ATH
        // For new tokens (< 6h), strong positive price action = at ATH
        // For older tokens, sustained multi-timeframe gains = at/near ATH
        const isNewToken = metrics.tokenAge < 360; // < 6 hours
        const h1Change = priceChangeData.h1 || 0;
        const h6Change = priceChangeData.h6 || 0;
        const h24Change = priceChangeData.h24 || 0;

        if (isNewToken) {
          // New token: if h1 > +25%, it's likely at ATH
          nearATH = h1Change > 25;
        } else {
          // Established token: if h6 > +30% or h24 > +50% with h1 still positive
          nearATH = (h6Change > 30 && h1Change > 0) || (h24Change > 50 && h1Change > 5);
        }

        if (nearATH && metrics.price > 0) {
          // Suggest entry at 10-20% below current price based on pump intensity
          const pullbackPercent = h1Change > 50 ? 0.20 : h1Change > 25 ? 0.15 : 0.10;
          suggestedEntryPrice = metrics.price * (1 - pullbackPercent);
          // Build reason with only timeframes the token has actually existed for
          const reasonParts: string[] = [];
          if (isNewToken) {
            reasonParts.push(`since launch: +${h1Change.toFixed(0)}%`);
          } else {
            if (metrics.tokenAge >= 60) reasonParts.push(`1h: +${h1Change.toFixed(0)}%`);
            if (metrics.tokenAge >= 360 && h6Change > 10) reasonParts.push(`6h: +${h6Change.toFixed(0)}%`);
            if (metrics.tokenAge >= 1440 && h24Change > 10) reasonParts.push(`24h: +${h24Change.toFixed(0)}%`);
          }
          suggestedEntryReason = `Price near ATH (${reasonParts.join(', ')}). Wait for ${(pullbackPercent * 100).toFixed(0)}% pullback.`;
          riskWarnings.push(`AT/NEAR ATH: ${suggestedEntryReason}`);
        }
      }
    } catch (error) {
      // Non-critical - just skip ATH detection if DexScreener fails
      logger.debug({ error, tokenAddress }, 'Failed to fetch pair data for ATH detection');
    }

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

      // DexScreener & CTO Info
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

      // Price change and entry suggestion
      priceChangeData,
      nearATH,
      suggestedEntryPrice,
      suggestedEntryReason,

      // ML Prediction removed
      prediction: null,

      // Predictive enrichment
      enrichment,
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
      logger.debug({
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
          hourOfDayUtc: new Date().getUTCHours(),
        }
      );
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to record KOL signal for tracking');
    }

    // FEATURE 4: Track Pump.fun tokens
    if (await bondingCurveMonitor.isPumpfunToken(tokenAddress)) {
      await bondingCurveMonitor.trackToken(tokenAddress);
    }

    this.recentlySignaledTokens.set(tokenAddress, Date.now());
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
   * Handle alpha wallet buy signal
   */
  private async handleAlphaSignal(
    tokenAddress: string,
    metrics: TokenMetrics,
    socialMetrics: SocialMetrics,
    volumeAuthenticity: any,
    scamResult: any,
    alphaActivities: Array<{
      wallet: AlphaWallet;
      transaction: {
        signature: string;
        solAmount: number;
        tokensAcquired: number;
        timestamp: Date;
      };
      signalWeight: number;
    }>,
    safetyResult: TokenSafetyResult,
    dexScreenerInfo?: DexScreenerTokenInfo,
    ctoAnalysis?: CTOAnalysis,
    enrichment?: SignalEnrichment,
  ): Promise<string> {
    // Use the highest-weight alpha wallet as primary
    const primaryAlpha = alphaActivities.reduce((best, curr) =>
      curr.signalWeight > best.signalWeight ? curr : best
    );

    // Calculate score without KOL activity
    const score = scoringEngine.calculateScore(
      tokenAddress,
      metrics,
      socialMetrics,
      volumeAuthenticity,
      scamResult,
      [] // No KOL activities
    );

    // Add safety flags
    if (safetyResult.safetyScore < 60) {
      score.flags.push(`SAFETY_${safetyResult.safetyScore}`);
    }
    if (safetyResult.insiderAnalysis.insiderRiskScore > 50) {
      score.flags.push(`INSIDER_RISK_${safetyResult.insiderAnalysis.insiderRiskScore}`);
    }

    // Apply alpha wallet weight as a score boost
    // Multiple alpha wallets buying = higher confidence
    const alphaBoost = Math.min(15, alphaActivities.length * 5); // Up to +15 for 3+ wallets
    score.compositeScore = Math.min(100, score.compositeScore + alphaBoost);

    // No score gate for alpha signals — smart money buying IS the signal.
    // Score is still calculated for display/tracking but doesn't filter.

    // Position size scaled by alpha wallet signal weight (lower than KOL)
    let positionSize = appConfig.trading.defaultPositionSizePercent * 0.75; // 75% of normal
    positionSize *= primaryAlpha.signalWeight; // Scale by wallet performance weight
    if (alphaActivities.length >= 2) positionSize *= 1.25; // Multiple alpha wallets = more confidence
    if (score.flags.includes('LOW_LIQUIDITY')) positionSize *= 0.5;
    if (score.flags.includes('NEW_TOKEN')) positionSize *= 0.75;
    positionSize = Math.min(positionSize, 2.5); // Cap at 2.5% for alpha

    const price = metrics.price;

    const signal: BuySignal = {
      id: `sig_alpha_${Date.now()}_${tokenAddress.slice(0, 8)}`,
      tokenAddress,
      tokenTicker: metrics.ticker,
      tokenName: metrics.name,

      score,
      tokenMetrics: metrics,
      socialMetrics,
      volumeAuthenticity,
      scamFilter: scamResult,

      kolActivity: null, // No KOL for alpha signals
      alphaWalletActivity: primaryAlpha,

      dexScreenerInfo,
      ctoAnalysis,

      entryZone: {
        low: price * 0.95,
        high: price * 1.05,
      },
      positionSizePercent: Math.round(positionSize * 10) / 10,
      stopLoss: {
        price: getInitialStopLoss(price, scoreToGrade(score.compositeScore)),
        percent: Math.abs(CANONICAL_EXIT_PARAMS.STOP_LOSS_BY_GRADE[scoreToGrade(score.compositeScore)] * 100),
      },
      takeProfit1: {
        price: price * (1 + CANONICAL_EXIT_PARAMS.TP1_PERCENT),
        percent: CANONICAL_EXIT_PARAMS.TP1_PERCENT * 100,
      },
      takeProfit2: {
        price: price * (1 + CANONICAL_EXIT_PARAMS.TP2_PERCENT),
        percent: CANONICAL_EXIT_PARAMS.TP2_PERCENT * 100,
      },
      timeLimitHours: CANONICAL_EXIT_PARAMS.MAX_HOLD_HOURS,

      generatedAt: new Date(),
      signalType: SignalType.ALPHA_WALLET,
      signalTrack: SignalTrack.EARLY_QUALITY,
      enrichment,
    };

    // Send via telegram
    await telegramBot.sendAlphaWalletSignal(signal, alphaActivities);

    // AUTO-TRADING: Process alpha signal for potential auto-buy
    try {
      const conviction = await convictionTracker.getConvictionLevel(tokenAddress);
      const autoTradeResult = await autoTrader.processSignal(signal, conviction);

      logger.info({
        tokenAddress,
        action: autoTradeResult.action,
        success: autoTradeResult.tradeResult?.success,
      }, 'Auto-trade alpha signal processed');
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Auto-trade alpha signal failed');
    }

    // Record signal for performance tracking
    try {
      await signalPerformanceTracker.recordSignal(
        signal.id,
        tokenAddress,
        metrics.ticker,
        'ALPHA_WALLET',
        metrics.price,
        metrics.marketCap,
        score.factors.onChainHealth || 50,
        score.compositeScore,
        safetyResult?.safetyScore || 50,
        scamResult.bundleAnalysis?.bundledSupplyPercent || 0,
        score.compositeScore >= 80 ? 'STRONG' : score.compositeScore >= 65 ? 'MODERATE' : 'WEAK',
        {
          liquidity: metrics.liquidityPool,
          tokenAge: metrics.tokenAge,
          holderCount: metrics.holderCount,
          top10Concentration: metrics.top10Concentration,
          buySellRatio: 0,
          uniqueBuyers: 0,
          hourOfDayUtc: new Date().getUTCHours(),
        }
      );
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to record alpha signal for tracking');
    }

    // FEATURE 4: Track Pump.fun tokens
    if (await bondingCurveMonitor.isPumpfunToken(tokenAddress)) {
      await bondingCurveMonitor.trackToken(tokenAddress);
    }

    // Clear from alpha discovery buffer to prevent duplicate signals
    alphaWalletManager.markProcessed(tokenAddress);

    this.recentlySignaledTokens.set(tokenAddress, Date.now());
    return SignalGenerator.EVAL_RESULTS.SIGNAL_SENT;
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
    // PHASE 2B: Score-as-sizing for discovery signals
    // Lower scores (counter-intuitively) have shown higher EV, but we size conservatively
    const BASE_POSITION_SIZE = appConfig.trading.defaultPositionSizePercent * 0.5; // 50% of normal for discovery
    let discoveryMultiplier = 1.0;

    // Use composite score for sizing (inverted model — lower = historically better)
    if (score.compositeScore >= 70) {
      discoveryMultiplier = 0.5;  // High score = historically worse = smaller position
    } else if (score.compositeScore >= 50) {
      discoveryMultiplier = 0.75; // Medium score = standard position
    } else {
      discoveryMultiplier = 1.0;  // Low score = historically better = full position
    }

    // Adjust based on moonshot grade
    if (moonshotAssessment.grade === 'A') discoveryMultiplier *= 1.25;
    else if (moonshotAssessment.grade === 'B') discoveryMultiplier *= 1.0;
    else if (moonshotAssessment.grade === 'C') discoveryMultiplier *= 0.75;

    let positionSize = BASE_POSITION_SIZE * discoveryMultiplier;

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

  // 2x probability module REMOVED (was over-engineered, decoupled from main pipeline)

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
   * v3 RECALIBRATED: Converted from 0-25 bonus to ±15 factor with negative signals.
   * Bought followers and template websites are $5 — fake socials now penalize instead of boost.
   *
   * NET RANGE: -7 to +15 (was 0 to +25)
   */
  private calculateSocialScore(dexScreenerInfo: DexScreenerTokenInfo): {
    score: number;
    breakdown: string[];
  } {
    const breakdown: string[] = [];
    let score = 0;

    // Twitter: +5 (reduced from +7)
    if (dexScreenerInfo.socialLinks.twitter) {
      score += 5;
      breakdown.push('Twitter: +5');
    }

    // DexScreener profile claimed: +4 (reduced from +5)
    if (dexScreenerInfo.hasClaimedProfile) {
      score += 4;
      breakdown.push('Profile Claimed: +4');
    }

    // Telegram: +3 (reduced from +4)
    if (dexScreenerInfo.socialLinks.telegram) {
      score += 3;
      breakdown.push('Telegram: +3');
    }

    // Website: +2 (reduced from +3)
    if (dexScreenerInfo.socialLinks.website) {
      score += 2;
      breakdown.push('Website: +2');

      // NEGATIVE: Template website detection (common memecoin template sites)
      if (dexScreenerInfo.description) {
        const desc = dexScreenerInfo.description.toLowerCase();
        const templatePatterns = [
          'the next 100x', 'moon guaranteed', 'buy now before',
          'stealth launch', 'community driven token', 'fair launch token',
          'next big thing', 'to the moon',
        ];
        const isTemplate = templatePatterns.some(p => desc.includes(p));
        if (isTemplate) {
          score -= 2;
          breakdown.push('Template website: -2');
        }
      }
    }

    // Description: +1 (reduced from +2)
    if (dexScreenerInfo.description && dexScreenerInfo.description.length > 20) {
      score += 1;
      breakdown.push('Description: +1');
    }

    // Boosts: +0 (was +1-2) — paid visibility, not quality signal
    // Rugs frequently boost to attract victims — no longer rewarded
    if (dexScreenerInfo.isBoosted) {
      breakdown.push(`Boosted (${dexScreenerInfo.boostCount}x): +0 (not scored)`);
    }

    // Discord: +0 (was +1) — empty servers are free, no signal
    if (dexScreenerInfo.socialLinks.discord) {
      breakdown.push('Discord: +0 (not scored)');
    }

    // Cap to range: -7 to +15
    score = Math.max(-7, Math.min(15, score));

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

    // Pre-bond pump.fun tokens have no volume data from DexScreener.
    // Detect them: mcap < $69K (pump.fun migration target) and zero volume.
    const isPreBond = metrics.marketCap > 0 && metrics.marketCap < 69_000
      && metrics.volume24h === 0 && metrics.volumeMarketCapRatio === 0;

    // Early tokens (< 30 min) haven't had time to accumulate holders/volume.
    // Use relaxed thresholds so they aren't killed before they can prove themselves.
    const isEarly = metrics.tokenAge < 30;
    const earlyHolderMin = 15;       // Early tokens: 15 holders (vs 50 default)
    const earlyVolumeMin = 500;      // Early tokens: $500 volume (vs $2K default)
    const earlyVolRatioMin = 0.005;  // Early tokens: 0.5% vol/mcap (vs 1% default)

    if (metrics.marketCap < cfg.minMarketCap) {
      failedCriteria.push(`marketCap (${metrics.marketCap}) < min (${cfg.minMarketCap})`);
    }
    if (metrics.marketCap > cfg.maxMarketCap) {
      failedCriteria.push(`marketCap (${metrics.marketCap}) > max (${cfg.maxMarketCap})`);
    }

    // Skip volume checks for pre-bond tokens — pump.fun API doesn't provide volume
    if (!isPreBond) {
      const volMin = isEarly ? earlyVolumeMin : cfg.min24hVolume;
      if (metrics.volume24h < volMin) {
        failedCriteria.push(`volume24h (${metrics.volume24h}) < min (${volMin})${isEarly ? ' [early]' : ''}`);
      }

      const volRatioMin = isEarly ? earlyVolRatioMin : cfg.minVolumeMarketCapRatio;
      if (metrics.volumeMarketCapRatio < volRatioMin) {
        failedCriteria.push(`volumeRatio (${metrics.volumeMarketCapRatio.toFixed(3)}) < min (${volRatioMin})${isEarly ? ' [early]' : ''}`);
      }
    }

    const holderMin = isEarly ? earlyHolderMin : cfg.minHolderCount;
    if (metrics.holderCount < holderMin) {
      failedCriteria.push(`holders (${metrics.holderCount}) < min (${holderMin})${isEarly ? ' [early]' : ''}`);
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
        isPreBond,
        isEarly,
      }, 'EVAL: Screening failed');
      return false;
    }

    if (isPreBond) {
      logger.info({
        ticker: metrics.ticker,
        address: metrics.address?.slice(0, 8),
        mcap: metrics.marketCap,
      }, 'EVAL: Pre-bond pump.fun token passed screening (volume checks skipped)');
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
    // No Twitter/social API connected — derive engagement proxies from on-chain data
    const holdersRatio = Math.min(1, metrics.holderCount / 200);
    const volumeScore = Math.min(1, (metrics.volume24h / Math.max(1, metrics.marketCap)) / 0.3);
    const distributionScore = Math.max(0, 1 - (metrics.top10Concentration / 75));

    const engagementProxy = (holdersRatio * 0.4 + volumeScore * 0.4 + distributionScore * 0.2);
    const authenticityProxy = distributionScore * 0.7 + Math.min(0.3, holdersRatio * 0.3);

    return {
      mentionVelocity1h: 0,
      engagementQuality: Math.min(0.6, engagementProxy),
      accountAuthenticity: Math.min(0.6, authenticityProxy),
      sentimentPolarity: 0,
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
        price: getInitialStopLoss(price, scoreToGrade(score.compositeScore)),
        percent: Math.abs(CANONICAL_EXIT_PARAMS.STOP_LOSS_BY_GRADE[scoreToGrade(score.compositeScore)] * 100),
      },
      takeProfit1: {
        price: price * (1 + CANONICAL_EXIT_PARAMS.TP1_PERCENT),
        percent: CANONICAL_EXIT_PARAMS.TP1_PERCENT * 100,
      },
      takeProfit2: {
        price: price * (1 + CANONICAL_EXIT_PARAMS.TP2_PERCENT),
        percent: CANONICAL_EXIT_PARAMS.TP2_PERCENT * 100,
      },
      timeLimitHours: CANONICAL_EXIT_PARAMS.MAX_HOLD_HOURS,

      generatedAt: new Date(),
      signalType: SignalType.BUY,

      // Dual-track strategy
      signalTrack,
      kolReputation,
    };
  }

  /**
   * Collect predictive enrichment data from discovery modules.
   * All four analyses run in parallel to minimize latency.
   */
  private async getSignalEnrichment(tokenAddress: string, marketCap?: number): Promise<SignalEnrichment> {
    const enrichment: SignalEnrichment = {};

    try {
      // Phase 1 enrichments + Phase 2 new sources — all in parallel
      const [
        buyerResult, clusterResult, rotationResult, velocityResult,
        socialResult, whaleResult, lpResult,
      ] = await Promise.allSettled([
        // Phase 1
        firstBuyerQuality.analyze(tokenAddress),
        walletClustering.analyze(tokenAddress),
        rotationDetector.getRotationContext(tokenAddress),
        bondingVelocityTracker.getVelocity(tokenAddress),
        // Phase 2: Social velocity, whale detection, liquidity monitoring
        twitterScanner.getVelocity(tokenAddress),
        marketCap ? whaleDetector.getWhaleScoreBonus(tokenAddress, marketCap) : Promise.resolve(null),
        liquidityMonitor.getLiquidityScoreBonus(tokenAddress),
      ]);

      if (buyerResult.status === 'fulfilled' && buyerResult.value.buyersAnalyzed > 0) {
        const b = buyerResult.value;
        enrichment.buyerQuality = {
          score: b.score,
          grade: b.grade,
          freshWalletPercent: b.freshWalletPercent,
          collectiveWinRate: b.collectiveWinRate,
          highPnlBuyers: b.highPnlBuyers,
          knownDumperCount: b.knownDumperCount,
          flags: b.flags,
        };
      }

      if (clusterResult.status === 'fulfilled' && clusterResult.value.buyersAnalyzed > 0) {
        const c = clusterResult.value;
        enrichment.clustering = {
          score: c.score,
          independentPercent: c.independentPercent,
          largestClusterPercent: c.largestClusterPercent,
          clustersFound: c.clustersFound,
          flags: c.flags,
        };
      }

      if (rotationResult.status === 'fulfilled' && rotationResult.value) {
        const r = rotationResult.value;
        enrichment.rotation = {
          score: r.score,
          walletCount: r.walletCount,
          totalSolDeployed: r.totalSolDeployed,
          sourceTokens: r.sourceTokens,
          confidence: r.confidence,
        };
      }

      if (velocityResult.status === 'fulfilled' && velocityResult.value.tier !== 'UNKNOWN') {
        const v = velocityResult.value;
        enrichment.bondingVelocity = {
          score: v.score,
          currentProgress: v.currentProgress,
          velocityPerMinute: v.velocityPerMinute,
          accelerating: v.accelerating,
          timeToMigrationMinutes: v.timeToMigrationMinutes,
          tier: v.tier,
        };
      }

      // Phase 2: Social velocity enrichment
      if (socialResult.status === 'fulfilled' && socialResult.value.velocityTier !== 'LOW') {
        const s = socialResult.value;
        enrichment.socialVelocity = {
          uniqueMentions5m: s.uniqueMentions5m,
          uniqueMentions1h: s.uniqueMentions1h,
          velocityTier: s.velocityTier,
          kolMentions: s.kolMentions,
          bonusPoints: s.bonusPoints,
        };
      }

      // Phase 2: Whale activity enrichment
      if (whaleResult.status === 'fulfilled' && whaleResult.value && whaleResult.value.totalBonus !== 0) {
        const w = whaleResult.value;
        enrichment.whaleActivity = {
          whaleCount: w.singleWhaleBuyBonus > 0 ? 1 : 0,
          qualityWhales: w.qualityWhaleBonus > 0 ? 1 : 0,
          suspiciousFresh: w.suspiciousFreshPenalty < 0 ? 1 : 0,
          isCluster: w.whaleClusterBonus > 0,
          totalSolDeployed: 0, // Populated from cluster data if available
          bonusPoints: w.totalBonus,
        };
      }

      // Phase 2: Liquidity enrichment
      if (lpResult.status === 'fulfilled' && lpResult.value.bonusPoints > 0) {
        const l = lpResult.value;
        enrichment.liquidity = {
          recentLpAdded: l.recentLpAddition,
          deployerDoubledDown: l.deployerDoubledDown,
          lpBurned: l.lpBurned,
          bonusPoints: l.bonusPoints,
        };
      }
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Signal enrichment partially failed');
    }

    return enrichment;
  }
}

// ============ EXPORTS ============

export const signalGenerator = new SignalGenerator();

export default {
  SignalGenerator,
  signalGenerator,
};
