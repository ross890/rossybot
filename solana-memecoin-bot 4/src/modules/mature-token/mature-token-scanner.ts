// ===========================================
// MATURE TOKEN SCANNER
// Main orchestrator for mature token signal generation
// Targets tokens 24hrs - 14 days old
// ===========================================

import { logger } from '../../utils/logger.js';
import { Database, pool } from '../../utils/database.js';
import { getTokenMetrics, dexScreenerClient, jupiterClient } from '../onchain.js';
import { tokenSafetyChecker } from '../safety/token-safety-checker.js';
import { onChainScoringEngine } from '../onchain-scoring.js';
import { matureTokenTelegram } from './telegram-formatter.js';
import { signalPerformanceTracker } from '../performance/index.js';
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

// ============ PROTOCOL/STABLECOIN FILTER ============
// Exclude tokens that are:
// 1. Stablecoins (USD-pegged tokens)
// 2. LP tokens (liquidity pool tokens)
// 3. Protocol tokens (Orca, Jupiter, Raydium, Meteora)
// 4. Wrapped tokens (wSOL, etc.)

const EXCLUDED_NAME_PATTERNS = [
  // Stablecoins - exact matches only
  /^usdc$/i, /^usdt$/i, /^busd$/i, /^dai$/i, /^frax$/i, /^tusd$/i, /^usdp$/i,
  /^ust$/i, /^gusd$/i, /^husd$/i, /^susd$/i, /^lusd$/i, /^eusd$/i, /^eurc$/i,
  /^usdg$/i, /^pyusd$/i, /^hyusd$/i, /^jupusd$/i,
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
  '2u1tszSenaM98QLVa92PBUpMeZB9nWQQDG9uJEBDcpuU', // USDG
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', // EURC
  '5YMkXAYcyumQrBEFaeFb96xbC1VF8nBv2p5NbEq7bRAi', // hyUSD
  'JuprjznThw3evH3jDMCB1pJXVzMvMjfLdRG7m6PK7hy',  // JupUSD (address from logs)
  '5Y8NV33V7jqnqkLJ5RCZU4hWJrP1bGwKZ8b5oj9Lptay', // ONe
]);

/**
 * Check if a token is a protocol token, stablecoin, LP token, or wrapped token
 */
function isExcludedToken(
  address: string,
  name: string,
  ticker: string,
  price?: number
): { excluded: boolean; reason?: string } {
  // Check address blacklist first
  if (EXCLUDED_ADDRESSES.has(address)) {
    return { excluded: true, reason: 'Known protocol/stable address' };
  }

  // Check name and ticker against patterns
  for (const pattern of EXCLUDED_NAME_PATTERNS) {
    if (pattern.test(name) || pattern.test(ticker)) {
      return { excluded: true, reason: `Name/ticker matches excluded pattern: ${pattern}` };
    }
  }

  // Check for stablecoin price pattern (price ~$1)
  if (price !== undefined && price >= 0.95 && price <= 1.05) {
    const fullName = `${name} ${ticker}`.toLowerCase();
    if (/usd|stable|peg|dollar/i.test(fullName)) {
      return { excluded: true, reason: `Stablecoin detected (price: $${price.toFixed(4)})` };
    }
  }

  return { excluded: false };
}

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
    sourceStats: {
      dexscreenerTrending: 0,
      jupiter: 0,
      dexscreener: 0,
    },
    lastScanTime: '',
  };

  // Track recently rejected tokens for /funnel_debug command
  private recentRejections: Array<{
    ticker: string;
    address: string;
    marketCap: number;
    tier: string | null;
    checks: {
      excluded: { passed: boolean; reason?: string };
      marketCap: { passed: boolean; value: number; min: number; max: number };
      tier: { passed: boolean; tier: string | null };
      volume: { passed: boolean; value: number; required: number };
      holders: { passed: boolean; value: number; required: number };
      age: { passed: boolean; value: number; required: number };
      liquidity: { passed: boolean; value: number; required: number };
      liquidityRatio: { passed: boolean; value: number; required: number };
      concentration: { passed: boolean; value: number; max: number };
      cooldown: { passed: boolean };
    };
    failedCount: number;
    passedCount: number;
    timestamp: Date;
  }> = [];

  // Track micro-cap tokens ($200K-$500K) that are rejected - for opportunity analysis
  private microCapTracker: {
    total: number;
    passedSafety: number;
    passedConcentration: number;
    passedHolders: number;
    passedLiquidity: number;
    avgConcentration: number;
    avgHolderCount: number;
    avgLiquidity: number;
    samples: Array<{
      ticker: string;
      mcap: number;
      concentration: number;
      holders: number;
      liquidity: number;
      volume24h: number;
      age: number; // hours
      timestamp: Date;
    }>;
  } = {
    total: 0,
    passedSafety: 0,
    passedConcentration: 0,
    passedHolders: 0,
    passedLiquidity: 0,
    avgConcentration: 0,
    avgHolderCount: 0,
    avgLiquidity: 0,
    samples: [],
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
   * Get recent rejected tokens with per-criteria details for /funnel_debug
   */
  getRecentRejections(limit: number = 10) {
    return this.recentRejections.slice(-limit).reverse();
  }

  /**
   * Get the top blocker criteria from recent rejections
   */
  getTopBlocker(): { criteria: string; count: number; total: number } | null {
    if (this.recentRejections.length === 0) return null;

    const criteriaFailCounts: Record<string, number> = {};
    for (const rej of this.recentRejections) {
      for (const [name, check] of Object.entries(rej.checks)) {
        if (!check.passed) {
          criteriaFailCounts[name] = (criteriaFailCounts[name] || 0) + 1;
        }
      }
    }

    const sorted = Object.entries(criteriaFailCounts).sort(([, a], [, b]) => b - a);
    if (sorted.length === 0) return null;

    return {
      criteria: sorted[0][0],
      count: sorted[0][1],
      total: this.recentRejections.length,
    };
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
   * Get candidate tokens from multiple free sources
   * Primary: DexScreener trending + Jupiter verified tokens
   */
  private async getCandidateTokens(): Promise<TokenMetrics[]> {
    const candidates: TokenMetrics[] = [];
    const seenAddresses = new Set<string>();
    let fetchedCount = 0;
    let metricsFailedCount = 0;
    let tooYoungCount = 0;
    let tooOldCount = 0;

    try {
      // Source 1: DexScreener trending tokens (free, includes boosts)
      const dexTrending = await dexScreenerClient.getTrendingSolanaTokens(100);
      for (const addr of dexTrending) {
        seenAddresses.add(addr);
      }

      // Source 2: Jupiter verified tokens (high quality, vetted tokens)
      const jupiterVerified = await jupiterClient.getVerifiedTokens(
        this.eligibility.minMarketCap,
        this.eligibility.maxMarketCap,
        100
      );
      for (const addr of jupiterVerified) {
        seenAddresses.add(addr);
      }

      // Source 3: DexScreener new Solana pairs (recently listed)
      const dexNewPairs = await dexScreenerClient.getNewSolanaPairs(50);
      for (const pair of dexNewPairs) {
        const addr = pair.tokenAddress || pair.baseToken?.address;
        if (addr) {
          seenAddresses.add(addr);
        }
      }

      const allAddresses = Array.from(seenAddresses);
      fetchedCount = allAddresses.length;

      // Track source stats for /sources command
      this.funnelStats.sourceStats = {
        dexscreenerTrending: dexTrending.length,
        jupiter: jupiterVerified.length,
        dexscreener: dexNewPairs.length,
      };

      logger.info(`📊 FUNNEL: Discovery sources - DexScreener trending: ${dexTrending.length}, Jupiter: ${jupiterVerified.length}, DexScreener new: ${dexNewPairs.length}, Total: ${fetchedCount}`);

      // Get metrics for each and filter by age
      const minAgeMinutes = this.eligibility.minTokenAgeHours * 60;
      const maxAgeMinutes = this.eligibility.maxTokenAgeDays * 24 * 60;

      for (const address of allAddresses) {
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

      logger.info(`📊 FUNNEL: Age filter - Fetched: ${fetchedCount}, Too young: ${tooYoungCount}, Too old: ${tooOldCount}, Passed: ${candidates.length}`);

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
      excludedToken: 0,  // Protocol/stablecoin/LP tokens
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

    // Track rejected market caps for logging
    const rejectedMcaps: string[] = [];
    // Track rejected concentrations for logging
    const rejectedConcentrations: string[] = [];

    // Track micro-cap tokens ($200K-$500K) for opportunity analysis
    const MICRO_CAP_MIN = 200_000;
    const MICRO_CAP_MAX = 500_000;

    for (const token of tokens) {
      // FIRST: Check if token is excluded (protocol/stablecoin/LP token)
      const exclusionCheck = isExcludedToken(
        token.address,
        token.name,
        token.ticker,
        token.price
      );
      if (exclusionCheck.excluded) {
        rejections.excludedToken++;
        continue;
      }

      // Check if token is in micro-cap range ($200K-$500K) - track for opportunity analysis
      if (token.marketCap >= MICRO_CAP_MIN && token.marketCap < MICRO_CAP_MAX) {
        this.trackMicroCapToken(token);
      }

      // === Per-token check tracking for /funnel_debug ===
      const tier = getTokenTier(token.marketCap);
      const tierConfig = tier ? TIER_CONFIG[tier] : null;
      const cooldown = this.signalCooldowns.get(token.address);
      const liquidityRatio = token.marketCap > 0 ? token.liquidityPool / token.marketCap : 0;

      // Apply tier-specific threshold multiplier for soft gates
      // multiplier < 1 = more lenient (EMERGING at 0.8 = 20% easier)
      // multiplier > 1 = stricter (GRADUATED at 1.2 = 20% harder)
      const multiplier = tierConfig?.thresholdMultiplier ?? 1.0;
      const tierEnabled = tierConfig?.enabled ?? true;

      // Apply multiplier: for min thresholds, multiply required value
      // For max thresholds (concentration), divide the max by multiplier
      const adjustedMinVolume = tierConfig ? tierConfig.minVolume24h * multiplier : 0;
      const adjustedMinHolders = tierConfig ? Math.round(tierConfig.minHolderCount * multiplier) : 0;
      const adjustedMinLiquidity = this.eligibility.minLiquidity * multiplier;
      const adjustedMaxConcentration = this.eligibility.maxTop10Concentration / multiplier;

      const checks = {
        excluded: { passed: true } as { passed: boolean; reason?: string },
        marketCap: {
          passed: token.marketCap >= this.eligibility.minMarketCap && token.marketCap <= this.eligibility.maxMarketCap,
          value: token.marketCap,
          min: this.eligibility.minMarketCap,
          max: this.eligibility.maxMarketCap,
        },
        tier: {
          passed: tier !== null && tierEnabled,
          tier: tier,
        },
        volume: {
          passed: tierConfig ? token.volume24h >= adjustedMinVolume : false,
          value: token.volume24h,
          required: adjustedMinVolume,
        },
        holders: {
          passed: tierConfig ? token.holderCount >= adjustedMinHolders : false,
          value: token.holderCount,
          required: adjustedMinHolders,
        },
        age: {
          passed: tierConfig ? (!token.tokenAge || token.tokenAge >= tierConfig.minTokenAgeHours) : false,
          value: token.tokenAge || 0,
          required: tierConfig?.minTokenAgeHours ?? 0,
        },
        liquidity: {
          passed: token.liquidityPool >= adjustedMinLiquidity,
          value: token.liquidityPool,
          required: adjustedMinLiquidity,
        },
        liquidityRatio: {
          passed: liquidityRatio >= this.eligibility.minLiquidityRatio,
          value: liquidityRatio,
          required: this.eligibility.minLiquidityRatio,
        },
        concentration: {
          passed: token.top10Concentration <= adjustedMaxConcentration,
          value: token.top10Concentration,
          max: adjustedMaxConcentration,
        },
        cooldown: {
          passed: !cooldown || Date.now() - cooldown >= this.config.rateLimits.tokenCooldownHours * 60 * 60 * 1000,
        },
      };

      const failedChecks = Object.values(checks).filter(c => !c.passed);
      const passedChecks = Object.values(checks).filter(c => c.passed);

      // Track rejection stats (count all failures, not just first)
      if (!checks.marketCap.passed) {
        rejections.marketCapOutOfRange++;
        rejectedMcaps.push(`${token.ticker}=$${(token.marketCap / 1_000_000).toFixed(1)}M`);
      }
      if (checks.marketCap.passed && !checks.tier.passed) {
        rejections.noTierMatch++;
      }
      if (tier) tierCounts[tier] = (tierCounts[tier] || 0) + 1;
      if (!checks.volume.passed && checks.tier.passed) rejections.volumeTooLow++;
      if (!checks.holders.passed && checks.tier.passed) rejections.holdersTooLow++;
      if (!checks.age.passed && checks.tier.passed) rejections.ageTooYoung++;
      if (!checks.liquidity.passed) rejections.liquidityTooLow++;
      if (!checks.liquidityRatio.passed) rejections.liquidityRatioTooLow++;
      if (!checks.concentration.passed) {
        rejections.concentrationTooHigh++;
        rejectedConcentrations.push(`${token.ticker}=${token.top10Concentration.toFixed(0)}%`);
      }
      if (!checks.cooldown.passed) rejections.onCooldown++;

      // === GRADUATED THRESHOLD RELAXATION ===
      // Hard gates: marketCap, tier, and cooldown MUST pass (non-negotiable)
      const hardGatesFailed = !checks.marketCap.passed || !checks.tier.passed || !checks.cooldown.passed;

      // Soft gates: volume, holders, age, liquidity, liquidityRatio, concentration
      // A token can fail up to 2 soft gates and still pass if it scores well overall
      const softChecks = [
        { name: 'volume', passed: checks.volume.passed, weight: 1.0 },
        { name: 'holders', passed: checks.holders.passed, weight: 1.0 },
        { name: 'age', passed: checks.age.passed, weight: 0.5 },        // Minor - less important
        { name: 'liquidity', passed: checks.liquidity.passed, weight: 1.5 },   // Important for tradability
        { name: 'liquidityRatio', passed: checks.liquidityRatio.passed, weight: 0.5 }, // Minor
        { name: 'concentration', passed: checks.concentration.passed, weight: 1.0 },
      ];

      const softFailCount = softChecks.filter(c => !c.passed).length;
      const softFailWeight = softChecks.filter(c => !c.passed).reduce((sum, c) => sum + c.weight, 0);
      const MAX_SOFT_FAILS = 2;          // Max number of soft criteria that can fail
      const MAX_SOFT_FAIL_WEIGHT = 2.0;  // Max total weight of failed soft criteria

      let isEligible: boolean;
      if (hardGatesFailed) {
        isEligible = false;
      } else if (softFailCount === 0) {
        isEligible = true;  // All checks pass
      } else if (softFailCount <= MAX_SOFT_FAILS && softFailWeight <= MAX_SOFT_FAIL_WEIGHT) {
        isEligible = true;  // Minor failures tolerated
        logger.info(`📊 FUNNEL: ${token.ticker} passed with ${softFailCount} soft gate failures (weight: ${softFailWeight.toFixed(1)}): ${softChecks.filter(c => !c.passed).map(c => c.name).join(', ')}`);
      } else {
        isEligible = false;
      }

      // Store per-token rejection details for /funnel_debug
      if (!isEligible) {
        this.recentRejections.push({
          ticker: token.ticker,
          address: token.address,
          marketCap: token.marketCap,
          tier: tier,
          checks,
          failedCount: failedChecks.length,
          passedCount: passedChecks.length,
          timestamp: new Date(),
        });

        // Log per-token details for debugging
        const failedNames = Object.entries(checks)
          .filter(([, c]) => !c.passed)
          .map(([name]) => name);
        logger.debug(`📊 FUNNEL REJECT: ${token.ticker} (MC: $${(token.marketCap / 1_000_000).toFixed(2)}M, ${tier || 'NO_TIER'}) - Failed ${failedChecks.length}/${Object.keys(checks).length}: ${failedNames.join(', ')}`);
      }

      if (isEligible) {
        eligible.push(token);
      }
    }

    // Keep only the last 50 rejections for the /funnel_debug command
    if (this.recentRejections.length > 50) {
      this.recentRejections = this.recentRejections.slice(-50);
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

    logger.info(`📊 FUNNEL: Eligibility - Input: ${tokens.length}, Eligible: ${eligible.length} | Rejections: excluded=${rejections.excludedToken}, mcap=${rejections.marketCapOutOfRange}, vol=${rejections.volumeTooLow}, holders=${rejections.holdersTooLow}, liq=${rejections.liquidityTooLow}, conc=${rejections.concentrationTooHigh}, cooldown=${rejections.onCooldown} | Tiers: R=${tierCounts.RISING} E=${tierCounts.EMERGING} G=${tierCounts.GRADUATED} EST=${tierCounts.ESTABLISHED}`);

    // Log rejected market caps if any (to debug why tokens aren't matching tiers)
    if (rejectedMcaps.length > 0) {
      logger.info(`📊 FUNNEL: Rejected mcaps (range $${(this.eligibility.minMarketCap / 1_000_000).toFixed(1)}M-$${(this.eligibility.maxMarketCap / 1_000_000).toFixed(0)}M): ${rejectedMcaps.join(', ')}`);
    }

    // Log rejected concentrations if any (to debug top 10 holder filter)
    if (rejectedConcentrations.length > 0) {
      logger.info(`📊 FUNNEL: Rejected concentrations (max ${this.eligibility.maxTop10Concentration}%): ${rejectedConcentrations.join(', ')}`);
    }

    // Near-miss analysis: log tokens that are within 20% of passing each threshold
    // This helps identify if thresholds are too tight for current market conditions
    const totalRejections = Object.values(rejections).reduce((a, b) => a + b, 0);
    if (eligible.length === 0 && totalRejections > 0) {
      const topBlocker = Object.entries(rejections)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
        .map(([k, v]) => `${k}=${v}`)
        .slice(0, 3);
      logger.warn({
        eligible: 0,
        totalRejected: totalRejections,
        topBlockers: topBlocker,
      }, '⚠️ FUNNEL BLOCKED: 0 tokens passed eligibility — top rejection reasons listed');
    }

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

    // Calculate comprehensive score using on-chain scoring engine
    const onChainScore = await onChainScoringEngine.calculateScore(
      metrics.address,
      metrics
    );

    // Map on-chain score to the mature token score interface
    const score = {
      compositeScore: onChainScore.total,
      accumulationScore: onChainScore.components.marketStructure,
      breakoutScore: onChainScore.components.momentum,
      holderDynamicsScore: onChainScore.components.marketStructure,
      volumeAuthenticityScore: onChainScore.components.momentum,
      smartMoneyScore: 0,
      kolActivityScore: 0,
      contractSafetyScore: onChainScore.components.safety,
      confidence: onChainScore.confidence,
      recommendation: onChainScore.recommendation,
      bullishSignals: onChainScore.bullishSignals,
      bearishSignals: onChainScore.bearishSignals,
      warnings: onChainScore.warnings,
    };

    // Default empty metrics for removed analyzers
    const accumulationMetrics = { accumulationScore: score.accumulationScore };
    const breakoutMetrics = { breakoutScore: score.breakoutScore, volumeExpansion: 0, priceVelocity5m: 0 };
    const holderDynamics = {};
    const volumeProfile = {};
    const smartMoneyMetrics = { whaleAccumulation: 0, smartMoneyInflow24h: 0 };
    const kolReentryMetrics = { kolBuys24h: 0, tier1KolCount: 0 };

    // Log score for visibility
    logger.info(`📊 FUNNEL: Scored ${metrics.ticker} (${metrics.address.slice(0, 8)}) - Score: ${score.compositeScore.toFixed(0)} [${score.recommendation}/${score.confidence}] | Acc: ${score.accumulationScore.toFixed(0)}, Brk: ${score.breakoutScore.toFixed(0)}, Safe: ${score.contractSafetyScore.toFixed(0)} | $${(metrics.marketCap / 1_000_000).toFixed(2)}M, ${metrics.holderCount} holders`);

    // Determine action - simple threshold check (score >= 45)
    if (score.compositeScore < 45) {
      logger.info(`📊 FUNNEL: Rejected ${metrics.ticker} - Score ${score.compositeScore.toFixed(0)} < 45 required (score_too_low)`);
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

    // Record in performance tracker for outcome tracking (use ONCHAIN type for mature tokens)
    try {
      await signalPerformanceTracker.recordSignal(
        signal.id,
        signal.tokenAddress,
        signal.tokenTicker,
        'ONCHAIN', // Mature tokens are discovered via on-chain analysis
        signal.currentPrice,
        signal.marketCap,
        signal.score.accumulationScore || 0,
        signal.score.compositeScore || 0,
        signal.score.contractSafetyScore || 0,
        0, // bundleRiskScore not applicable for mature tokens
        signal.confidence === 'HIGH' ? 'STRONG' : signal.confidence === 'MEDIUM' ? 'MODERATE' : 'WEAK',
        {
          liquidity: signal.liquidity || 0,
          tokenAge: (signal.tokenAgeHours || 0) * 60,
          holderCount: signal.holderCount || 0,
          top10Concentration: signal.top10Concentration || 0,
          signalTrack: 'PROVEN_RUNNER',
        }
      );
    } catch (perfError) {
      logger.error({ error: perfError }, 'Failed to record signal in performance tracker');
    }

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
    const tierCfg = TIER_CONFIG[tier];

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
      tierAlertTag: tierCfg.alertTag,
      tierAutoTrade: tierCfg.autoTrade,

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

        // Re-evaluate score using on-chain scoring engine
        const onChainResult = await onChainScoringEngine.calculateScore(
          address,
          metrics
        );

        // Check if now meets signal threshold
        if (onChainResult.total >= item.targetScore && this.canSendSignal()) {
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

  /**
   * Track a micro-cap token ($200K-$500K) for opportunity analysis
   * Evaluates if it would pass our safety filters
   */
  private trackMicroCapToken(token: TokenMetrics): void {
    this.microCapTracker.total++;

    // Check if it would pass our filters
    const passesConcentration = token.top10Concentration <= this.eligibility.maxTop10Concentration;
    const passesHolders = token.holderCount >= 250; // Stricter for micro-caps
    const passesLiquidity = token.liquidityPool >= 10_000; // Lower threshold for smaller caps

    if (passesConcentration) this.microCapTracker.passedConcentration++;
    if (passesHolders) this.microCapTracker.passedHolders++;
    if (passesLiquidity) this.microCapTracker.passedLiquidity++;

    // Track if passes all safety checks (could be opportunity)
    if (passesConcentration && passesHolders && passesLiquidity) {
      this.microCapTracker.passedSafety++;
    }

    // Update rolling averages
    const n = this.microCapTracker.total;
    this.microCapTracker.avgConcentration =
      ((this.microCapTracker.avgConcentration * (n - 1)) + token.top10Concentration) / n;
    this.microCapTracker.avgHolderCount =
      ((this.microCapTracker.avgHolderCount * (n - 1)) + token.holderCount) / n;
    this.microCapTracker.avgLiquidity =
      ((this.microCapTracker.avgLiquidity * (n - 1)) + token.liquidityPool) / n;

    // Store sample (keep last 20)
    this.microCapTracker.samples.push({
      ticker: token.ticker,
      mcap: token.marketCap,
      concentration: token.top10Concentration,
      holders: token.holderCount,
      liquidity: token.liquidityPool,
      volume24h: token.volume24h,
      age: token.tokenAge / 60, // Convert to hours
      timestamp: new Date(),
    });

    // Keep only last 20 samples
    if (this.microCapTracker.samples.length > 20) {
      this.microCapTracker.samples.shift();
    }

    logger.debug({
      ticker: token.ticker,
      mcap: token.marketCap,
      concentration: token.top10Concentration,
      holders: token.holderCount,
      passedSafety: passesConcentration && passesHolders && passesLiquidity,
    }, 'Tracked micro-cap token for opportunity analysis');
  }

  /**
   * Get micro-cap opportunity analysis
   * Returns stats on tokens in the $200K-$500K range that are currently being skipped
   */
  getMicroCapAnalysis(): {
    total: number;
    passedSafety: number;
    passedSafetyPct: number;
    passedConcentration: number;
    passedConcentrationPct: number;
    passedHolders: number;
    passedHoldersPct: number;
    passedLiquidity: number;
    passedLiquidityPct: number;
    avgConcentration: number;
    avgHolderCount: number;
    avgLiquidity: number;
    recentSamples: Array<{
      ticker: string;
      mcap: number;
      concentration: number;
      holders: number;
      liquidity: number;
      volume24h: number;
      age: number;
      timestamp: Date;
    }>;
    recommendation: string;
  } {
    const total = this.microCapTracker.total;

    // Calculate percentages
    const passedSafetyPct = total > 0 ? (this.microCapTracker.passedSafety / total) * 100 : 0;
    const passedConcentrationPct = total > 0 ? (this.microCapTracker.passedConcentration / total) * 100 : 0;
    const passedHoldersPct = total > 0 ? (this.microCapTracker.passedHolders / total) * 100 : 0;
    const passedLiquidityPct = total > 0 ? (this.microCapTracker.passedLiquidity / total) * 100 : 0;

    // Generate recommendation based on data
    let recommendation: string;
    if (total < 10) {
      recommendation = 'Insufficient data - need more scan cycles to analyze';
    } else if (passedSafetyPct >= 30) {
      recommendation = `✅ OPPORTUNITY: ${passedSafetyPct.toFixed(0)}% pass all safety checks. Consider adding MICRO tier ($200K-$500K) with 250+ holders, 75% max concentration`;
    } else if (passedSafetyPct >= 15) {
      recommendation = `⚠️ MODERATE OPPORTUNITY: ${passedSafetyPct.toFixed(0)}% pass safety. Could work with stricter filters (300+ holders, 60% max concentration)`;
    } else if (this.microCapTracker.avgConcentration > 80) {
      recommendation = `❌ HIGH RISK: Avg concentration ${this.microCapTracker.avgConcentration.toFixed(0)}% - most tokens heavily controlled by whales/snipers`;
    } else {
      recommendation = `❌ LIMITED OPPORTUNITY: Only ${passedSafetyPct.toFixed(0)}% pass safety. Likely dominated by bundles/snipers`;
    }

    return {
      total,
      passedSafety: this.microCapTracker.passedSafety,
      passedSafetyPct,
      passedConcentration: this.microCapTracker.passedConcentration,
      passedConcentrationPct,
      passedHolders: this.microCapTracker.passedHolders,
      passedHoldersPct,
      passedLiquidity: this.microCapTracker.passedLiquidity,
      passedLiquidityPct,
      avgConcentration: this.microCapTracker.avgConcentration,
      avgHolderCount: this.microCapTracker.avgHolderCount,
      avgLiquidity: this.microCapTracker.avgLiquidity,
      recentSamples: [...this.microCapTracker.samples].reverse(), // Most recent first
      recommendation,
    };
  }

  /**
   * Reset micro-cap tracker (call at start of day or when needed)
   */
  resetMicroCapTracker(): void {
    this.microCapTracker = {
      total: 0,
      passedSafety: 0,
      passedConcentration: 0,
      passedHolders: 0,
      passedLiquidity: 0,
      avgConcentration: 0,
      avgHolderCount: 0,
      avgLiquidity: 0,
      samples: [],
    };
    logger.info('Micro-cap tracker reset');
  }
}

// ============ EXPORTS ============

export const matureTokenScanner = new MatureTokenScanner();

export default {
  MatureTokenScanner,
  matureTokenScanner,
};
