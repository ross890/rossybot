import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import { fetchDexPair, getBuyRatio } from '../validation/dexscreener.js';
import type { DexScreenerPair } from '../../types/index.js';

/**
 * Freshly graduated token from PumpPortal migration event.
 * These are tokens that just moved from pump.fun bonding curve → PumpSwap AMM.
 */
export interface GraduatedToken {
  mint: string;
  /** DexScreener pair data at time of graduation detection */
  dexData: DexScreenerPair | null;
  /** Timestamp we detected the graduation */
  detectedAt: number;
  /** Price at graduation detection (from DexScreener) */
  graduationPriceUsd: number;
  /** Market cap at graduation (~$69K typically) */
  graduationMcap: number;
  /** Liquidity at graduation (~$12K typically) */
  graduationLiquidity: number;
}

/**
 * A graduated token being monitored for the post-graduation dip/recovery pattern.
 *
 * The thesis: pump.fun tokens dump 30-60% after graduation as bonding curve holders
 * take profit. Then they often bounce 50-200% as:
 * - New buyers see a "dip" on DexScreener
 * - Social/community momentum continues
 * - Token gets broader DEX visibility
 *
 * We monitor the dump phase and enter when reversal signals appear.
 */
export interface MonitoredGrad {
  mint: string;
  symbol: string | null;
  detectedAt: number;
  graduationPriceUsd: number;
  graduationMcap: number;
  graduationLiquidity: number;
  pairAddress: string | null;
  /** Lowest price observed since graduation (the dip bottom) */
  lowestPriceUsd: number;
  /** Highest price observed since graduation */
  highestPriceUsd: number;
  /** Current price */
  currentPriceUsd: number;
  /** Current drawdown from graduation price (negative = dipped) */
  drawdownPct: number;
  /** Current recovery from lowest point (positive = bouncing) */
  recoveryPct: number;
  /** Number of price checks completed */
  checkCount: number;
  /** Last check timestamp */
  lastCheckAt: number;
  /** Phase: 'DUMPING' | 'BOTTOMING' | 'RECOVERING' | 'SIGNAL' | 'EXPIRED' */
  phase: GradPhase;
  /** Number of consecutive checks where price was stable or rising */
  stabilityStreak: number;
  /** Buy ratio from DexScreener (fraction of txns that are buys) */
  buyRatio: number;
  /** Whether we've already fired a signal for this token */
  signalFired: boolean;
}

export type GradPhase = 'DUMPING' | 'BOTTOMING' | 'RECOVERING' | 'SIGNAL' | 'EXPIRED';

export interface GradSignal {
  mint: string;
  symbol: string | null;
  pairAddress: string | null;
  dexData: DexScreenerPair;
  graduationPriceUsd: number;
  entryPriceUsd: number;
  dipPct: number; // How far it dipped from graduation (e.g. -45%)
  recoveryPct: number; // How far it bounced from the bottom (e.g. +30%)
  timeSinceGradMins: number;
  buyRatio: number;
  mcap: number;
  liquidity: number;
}

/**
 * GraduationDiscovery — real-time detection and monitoring of freshly graduated
 * pump.fun tokens for the post-graduation dip/bounce trading pattern.
 *
 * Flow:
 * 1. PumpPortal fires migration events → we detect graduation in real-time
 * 2. Token enters monitoring: we poll DexScreener every N seconds for price data
 * 3. We track the dump phase (graduation → bottom)
 * 4. When reversal signals appear (stability + buy pressure + recovery %), fire signal
 * 5. Signal feeds into the standard DEX trade pipeline
 */
export class GraduationDiscovery {
  private monitored = new Map<string, MonitoredGrad>();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private onSignal: ((signal: GradSignal) => void) | null = null;

  // Track recently processed graduations to avoid duplicates
  private recentGraduations = new Set<string>();

  // --- Configuration (accessed from config.graduationDiscovery) ---
  private get cfg() {
    return config.graduationDiscovery;
  }

  setSignalCallback(cb: (signal: GradSignal) => void): void {
    this.onSignal = cb;
  }

  start(): void {
    // Poll monitored tokens for price updates
    this.checkInterval = setInterval(() => this.checkAll(), this.cfg.priceCheckIntervalMs);
    // Cleanup expired tokens
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    logger.info({
      checkIntervalMs: this.cfg.priceCheckIntervalMs,
      maxMonitored: this.cfg.maxMonitored,
      monitorWindowMins: this.cfg.monitorWindowMins,
    }, 'Graduation discovery started');
  }

  stop(): void {
    if (this.checkInterval) { clearInterval(this.checkInterval); this.checkInterval = null; }
    if (this.cleanupInterval) { clearInterval(this.cleanupInterval); this.cleanupInterval = null; }
  }

  /**
   * Called when PumpPortal fires a migration event or we detect graduation via DexScreener.
   * Starts monitoring the token for the dip/recovery pattern.
   */
  async onGraduation(mint: string): Promise<void> {
    // Dedup
    if (this.monitored.has(mint) || this.recentGraduations.has(mint)) return;
    this.recentGraduations.add(mint);

    // Cap monitored tokens
    if (this.monitored.size >= this.cfg.maxMonitored) {
      logger.debug({ size: this.monitored.size }, 'Graduation discovery at max capacity — skipping');
      return;
    }

    // Fetch initial DexScreener data
    const dexData = await fetchDexPair(mint);
    if (!dexData) {
      logger.debug({ mint: mint.slice(0, 8) }, 'Graduation detected but no DexScreener data yet — will retry');
      // Schedule a retry in 15 seconds (DexScreener may not have the pair yet)
      setTimeout(() => this.retryGraduation(mint), 15_000);
      return;
    }

    // Only monitor PumpSwap/Raydium pairs (not bonding curve pairs)
    if (dexData.dexId === 'pumpfun') {
      logger.debug({ mint: mint.slice(0, 8), dexId: dexData.dexId }, 'Graduation — still bonding curve pair, retrying');
      setTimeout(() => this.retryGraduation(mint), 15_000);
      return;
    }

    const priceUsd = parseFloat(dexData.priceUsd || '0');
    const mcap = dexData.marketCap || dexData.fdv || 0;
    const liquidity = dexData.liquidity?.usd || 0;

    // Filter: only monitor tokens with reasonable graduation metrics
    if (mcap < this.cfg.minGraduationMcap || liquidity < this.cfg.minGraduationLiquidity) {
      logger.debug({ mint: mint.slice(0, 8), mcap, liquidity }, 'Graduation filtered — below thresholds');
      return;
    }

    const entry: MonitoredGrad = {
      mint,
      symbol: dexData.baseToken?.symbol || null,
      detectedAt: Date.now(),
      graduationPriceUsd: priceUsd,
      graduationMcap: mcap,
      graduationLiquidity: liquidity,
      pairAddress: dexData.pairAddress || null,
      lowestPriceUsd: priceUsd,
      highestPriceUsd: priceUsd,
      currentPriceUsd: priceUsd,
      drawdownPct: 0,
      recoveryPct: 0,
      checkCount: 0,
      lastCheckAt: Date.now(),
      phase: 'DUMPING',
      stabilityStreak: 0,
      buyRatio: 0.5,
      signalFired: false,
    };

    this.monitored.set(mint, entry);

    logger.info({
      mint: mint.slice(0, 8),
      symbol: entry.symbol,
      price: `$${priceUsd.toFixed(6)}`,
      mcap: `$${mcap.toLocaleString()}`,
      liquidity: `$${liquidity.toLocaleString()}`,
    }, 'GRADUATION DETECTED — monitoring for dip/recovery');
  }

  private async retryGraduation(mint: string): Promise<void> {
    if (this.monitored.has(mint)) return;
    this.recentGraduations.delete(mint); // Allow retry
    await this.onGraduation(mint);
  }

  /**
   * Check all monitored tokens — update prices and detect reversal signals.
   */
  private async checkAll(): Promise<void> {
    const entries = Array.from(this.monitored.values());
    if (entries.length === 0) return;

    // Process in batches to avoid DexScreener rate limits
    const batchSize = 5;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      await Promise.all(batch.map((entry) => this.checkToken(entry)));
    }
  }

  private async checkToken(entry: MonitoredGrad): Promise<void> {
    if (entry.signalFired || entry.phase === 'EXPIRED') return;

    const ageMins = (Date.now() - entry.detectedAt) / 60_000;

    // Expire if past monitoring window
    if (ageMins > this.cfg.monitorWindowMins) {
      entry.phase = 'EXPIRED';
      logger.debug({ mint: entry.mint.slice(0, 8), ageMins: ageMins.toFixed(0) },
        'Graduation monitor expired — no signal');
      return;
    }

    try {
      const dexData = await fetchDexPair(entry.mint);
      if (!dexData) return;

      const priceUsd = parseFloat(dexData.priceUsd || '0');
      if (priceUsd <= 0) return;

      const prevPrice = entry.currentPriceUsd;
      entry.currentPriceUsd = priceUsd;
      entry.checkCount++;
      entry.lastCheckAt = Date.now();

      // Update low/high watermarks
      if (priceUsd < entry.lowestPriceUsd) {
        entry.lowestPriceUsd = priceUsd;
        entry.stabilityStreak = 0; // Reset streak on new low
      }
      if (priceUsd > entry.highestPriceUsd) {
        entry.highestPriceUsd = priceUsd;
      }

      // Calculate drawdown from graduation price
      entry.drawdownPct = entry.graduationPriceUsd > 0
        ? (priceUsd - entry.graduationPriceUsd) / entry.graduationPriceUsd
        : 0;

      // Calculate recovery from lowest point
      entry.recoveryPct = entry.lowestPriceUsd > 0 && entry.lowestPriceUsd < priceUsd
        ? (priceUsd - entry.lowestPriceUsd) / entry.lowestPriceUsd
        : 0;

      // Buy ratio from DexScreener
      entry.buyRatio = getBuyRatio(dexData);

      // Stability: price not making new lows
      if (priceUsd >= prevPrice * 0.98) { // Within 2% of previous = stable/rising
        entry.stabilityStreak++;
      } else {
        entry.stabilityStreak = Math.max(0, entry.stabilityStreak - 1);
      }

      // --- Phase detection ---
      this.updatePhase(entry, dexData);

    } catch (err) {
      logger.error({ err, mint: entry.mint.slice(0, 8) }, 'Graduation check failed');
    }
  }

  private updatePhase(entry: MonitoredGrad, dexData: DexScreenerPair): void {
    const cfg = this.cfg;
    const ageMins = (Date.now() - entry.detectedAt) / 60_000;

    // Phase transitions based on price action
    if (entry.drawdownPct > -cfg.minDipPct) {
      // Hasn't dipped enough yet — still in initial dump or never dumped
      entry.phase = 'DUMPING';
      return;
    }

    // Token has dipped past our minimum threshold
    if (entry.recoveryPct < cfg.minRecoveryPct) {
      // Dipped but not recovering yet
      entry.phase = 'BOTTOMING';
      return;
    }

    // Check if recovery conditions are met for a signal
    const isRecovering = entry.recoveryPct >= cfg.minRecoveryPct;
    const isStable = entry.stabilityStreak >= cfg.minStabilityChecks;
    const hasBuyPressure = entry.buyRatio >= cfg.minBuyRatio;
    const mcapOk = (dexData.marketCap || dexData.fdv || 0) >= cfg.minEntryMcap;
    const liqOk = (dexData.liquidity?.usd || 0) >= cfg.minEntryLiquidity;
    const timeOk = ageMins >= cfg.minTimeSinceGradMins;

    if (isRecovering && !isStable) {
      entry.phase = 'RECOVERING';
      return;
    }

    if (isRecovering && isStable && hasBuyPressure && mcapOk && liqOk && timeOk) {
      entry.phase = 'SIGNAL';
      entry.signalFired = true;

      const dipPct = entry.lowestPriceUsd > 0 && entry.graduationPriceUsd > 0
        ? (entry.lowestPriceUsd - entry.graduationPriceUsd) / entry.graduationPriceUsd
        : 0;

      const signal: GradSignal = {
        mint: entry.mint,
        symbol: entry.symbol,
        pairAddress: entry.pairAddress,
        dexData,
        graduationPriceUsd: entry.graduationPriceUsd,
        entryPriceUsd: entry.currentPriceUsd,
        dipPct,
        recoveryPct: entry.recoveryPct,
        timeSinceGradMins: ageMins,
        buyRatio: entry.buyRatio,
        mcap: dexData.marketCap || dexData.fdv || 0,
        liquidity: dexData.liquidity?.usd || 0,
      };

      logger.info({
        mint: entry.mint.slice(0, 8),
        symbol: entry.symbol,
        dip: `${(dipPct * 100).toFixed(0)}%`,
        recovery: `${(entry.recoveryPct * 100).toFixed(0)}%`,
        buyRatio: `${(entry.buyRatio * 100).toFixed(0)}%`,
        mcap: `$${signal.mcap.toLocaleString()}`,
        ageMins: ageMins.toFixed(0),
      }, 'GRADUATION BOUNCE SIGNAL — dip/recovery pattern confirmed');

      this.onSignal?.(signal);
    }
  }

  private cleanup(): void {
    const now = Date.now();
    const maxAge = this.cfg.monitorWindowMins * 60_000;
    let cleaned = 0;

    for (const [mint, entry] of this.monitored) {
      if (entry.signalFired || entry.phase === 'EXPIRED' || (now - entry.detectedAt) > maxAge) {
        this.monitored.delete(mint);
        cleaned++;
      }
    }

    // Clean old recent graduations (prevent memory leak)
    if (this.recentGraduations.size > 2000) {
      this.recentGraduations.clear();
    }

    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: this.monitored.size }, 'Graduation discovery cleanup');
    }
  }

  getStats(): { monitored: number; signalsFired: number; phases: Record<string, number> } {
    const phases: Record<string, number> = {};
    let signalsFired = 0;

    for (const entry of this.monitored.values()) {
      phases[entry.phase] = (phases[entry.phase] || 0) + 1;
      if (entry.signalFired) signalsFired++;
    }

    return { monitored: this.monitored.size, signalsFired, phases };
  }

  /** Get currently monitored tokens for debugging/Telegram */
  getMonitored(): MonitoredGrad[] {
    return Array.from(this.monitored.values())
      .sort((a, b) => b.recoveryPct - a.recoveryPct);
  }
}
