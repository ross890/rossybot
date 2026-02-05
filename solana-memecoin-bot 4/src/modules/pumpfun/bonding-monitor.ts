// ===========================================
// MODULE: PUMP.FUN BONDING CURVE MONITOR (Feature 4)
// Monitors tokens approaching migration
// Extended for Established Token Strategy v2 - Graduation Pipeline
// ===========================================

import { Connection, PublicKey } from '@solana/web3.js';
import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import type { BondingCurveStatus, PumpfunAlert } from '../../types/index.js';

// ============ GRADUATION PIPELINE TYPES ============

interface GraduationPipelineEntry {
  tokenAddress: string;
  tokenName: string;
  ticker: string;
  pumpFunMint: string;
  launchTimestamp: Date;
  graduationTimestamp: Date;
  initialMarketCap: number;
  observationEnd: Date;
}

interface NarrativeTrend {
  theme: string;
  count: number;
  volume: number;
  trending: boolean;
}

// ============ CONSTANTS ============

// Pump.fun Program ID
const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Migration thresholds
const TARGET_MARKET_CAP = 69000; // ~$69k for migration
const ALERT_THRESHOLDS = [85, 90, 95]; // Alert at 85%, 90%, 95%

// Polling interval for tracked tokens
const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

// Graduation pipeline constants
const OBSERVATION_PERIOD_DAYS = 21;
const NARRATIVE_KEYWORDS = {
  AI: ['ai', 'agent', 'gpt', 'claude', 'llm', 'neural', 'bot'],
  POLITICAL: ['trump', 'biden', 'maga', 'democrat', 'republican', 'politics'],
  DOG: ['dog', 'doge', 'shib', 'inu', 'puppy', 'woof', 'bark'],
  CAT: ['cat', 'kitty', 'meow', 'kitten', 'feline'],
  PEPE: ['pepe', 'frog', 'kek', 'rare'],
  ELON: ['elon', 'musk', 'tesla', 'spacex', 'x.com'],
  ANIME: ['anime', 'waifu', 'chan', 'kun', 'senpai'],
  MEME: ['meme', 'wojak', 'chad', 'virgin', 'based'],
};

// ============ BONDING MONITOR CLASS ============

export class BondingCurveMonitor {
  private connection: Connection;
  private trackedTokens: Map<string, BondingCurveStatus> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private alertCallback: ((alert: PumpfunAlert) => void) | null = null;

  // Graduation pipeline tracking
  private recentGraduations: Map<string, GraduationPipelineEntry> = new Map();

  // Narrative tracking
  private narrativeCounts: Map<string, number> = new Map();
  private lastNarrativeReset: number = Date.now();

  constructor() {
    this.connection = new Connection(appConfig.heliusRpcUrl, 'confirmed');
  }

  /**
   * Set callback for alerts
   */
  onAlert(callback: (alert: PumpfunAlert) => void): void {
    this.alertCallback = callback;
  }

  /**
   * Start monitoring
   */
  start(): void {
    if (this.pollTimer) {
      return;
    }

    logger.info('Starting Pump.fun bonding curve monitor');

    // Load tracked tokens from database
    this.loadTrackedTokens();

    // Start polling
    this.pollTimer = setInterval(() => this.pollTrackedTokens(), POLL_INTERVAL_MS);

    // Initial poll
    this.pollTrackedTokens();
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Stopped Pump.fun bonding curve monitor');
  }

  /**
   * Add token to track
   */
  async trackToken(tokenMint: string): Promise<BondingCurveStatus | null> {
    const status = await this.getBondingCurveStatus(tokenMint);

    if (status && !status.isMigrated) {
      this.trackedTokens.set(tokenMint, status);
      await this.saveToDb(status);
      logger.info({ tokenMint, progress: status.bondingProgress }, 'Started tracking Pump.fun token');
    }

    return status;
  }

  /**
   * Get bonding curve status for a token
   */
  async getBondingCurveStatus(tokenMint: string): Promise<BondingCurveStatus | null> {
    try {
      // Try to get from Pump.fun API first (faster)
      const apiStatus = await this.fetchFromPumpfunApi(tokenMint);
      if (apiStatus) {
        return apiStatus;
      }

      // Fall back to on-chain analysis
      return this.analyzeOnChain(tokenMint);
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to get bonding curve status');
      return null;
    }
  }

  /**
   * Fetch status from Pump.fun API (if available)
   */
  private async fetchFromPumpfunApi(tokenMint: string): Promise<BondingCurveStatus | null> {
    try {
      // Pump.fun provides a free API for token data
      const response = await fetch(`https://frontend-api.pump.fun/coins/${tokenMint}`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;

      // Extract relevant data
      const marketCap = data.usd_market_cap || 0;
      const bondingProgress = Math.min(100, (marketCap / TARGET_MARKET_CAP) * 100);
      const isMigrated = data.complete || data.raydium_pool !== null;

      return {
        tokenMint,
        bondingProgress,
        currentMarketCap: marketCap,
        targetMarketCap: TARGET_MARKET_CAP,
        estimatedTimeToMigration: this.estimateTimeToMigration(bondingProgress, marketCap),
        isMigrated,
      };
    } catch (error) {
      logger.debug({ error, tokenMint }, 'Failed to fetch from Pump.fun API');
      return null;
    }
  }

  /**
   * Analyze bonding curve on-chain
   */
  private async analyzeOnChain(tokenMint: string): Promise<BondingCurveStatus | null> {
    // Skip RPC call when Helius is disabled
    if (appConfig.heliusDisabled) {
      return null;
    }

    try {
      const mintPubkey = new PublicKey(tokenMint);

      // Get token supply
      const supplyInfo = await this.connection.getTokenSupply(mintPubkey);
      const totalSupply = Number(supplyInfo.value.amount) / Math.pow(10, supplyInfo.value.decimals);

      // Estimate market cap based on bonding curve math
      // Pump.fun uses a bonding curve where price increases with supply sold
      // This is a simplified approximation
      const estimatedPrice = this.estimatePriceFromSupply(totalSupply);
      const currentMarketCap = totalSupply * estimatedPrice;

      const bondingProgress = Math.min(100, (currentMarketCap / TARGET_MARKET_CAP) * 100);

      return {
        tokenMint,
        bondingProgress,
        currentMarketCap,
        targetMarketCap: TARGET_MARKET_CAP,
        estimatedTimeToMigration: this.estimateTimeToMigration(bondingProgress, currentMarketCap),
        isMigrated: false, // Can't determine from on-chain alone
      };
    } catch (error) {
      logger.debug({ error, tokenMint }, 'Failed to analyze on-chain');
      return null;
    }
  }

  /**
   * Estimate price based on supply (simplified bonding curve)
   */
  private estimatePriceFromSupply(supply: number): number {
    // Pump.fun bonding curve approximation
    // In reality, this depends on the specific curve parameters
    const basePrice = 0.000001;
    const curveCoefficient = 0.00000001;
    return basePrice + (curveCoefficient * supply);
  }

  /**
   * Estimate time to migration based on progress velocity
   */
  private estimateTimeToMigration(progress: number, _currentMcap: number): number | null {
    if (progress >= 100) {
      return 0;
    }

    // Would need historical data to calculate velocity
    // For now, return null (unknown)
    return null;
  }

  /**
   * Load tracked tokens from database
   */
  private async loadTrackedTokens(): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT * FROM pumpfun_tokens WHERE is_migrated = FALSE`
      );

      for (const row of result.rows) {
        this.trackedTokens.set(row.token_address, {
          tokenMint: row.token_address,
          bondingProgress: parseFloat(row.bonding_progress),
          currentMarketCap: parseFloat(row.current_market_cap || '0'),
          targetMarketCap: parseFloat(row.target_market_cap),
          estimatedTimeToMigration: row.estimated_time_to_migration,
          isMigrated: row.is_migrated,
        });
      }

      logger.info({ count: this.trackedTokens.size }, 'Loaded tracked Pump.fun tokens');
    } catch (error) {
      logger.warn({ error }, 'Failed to load tracked tokens');
    }
  }

  /**
   * Poll all tracked tokens for updates
   */
  private async pollTrackedTokens(): Promise<void> {
    for (const [tokenMint, oldStatus] of this.trackedTokens) {
      try {
        const newStatus = await this.getBondingCurveStatus(tokenMint);

        if (!newStatus) continue;

        // Update tracking
        this.trackedTokens.set(tokenMint, newStatus);
        await this.saveToDb(newStatus);

        // Check for migration
        if (newStatus.isMigrated && !oldStatus.isMigrated) {
          this.emitAlert({
            type: 'MIGRATION',
            token: newStatus,
          });
        }

        // Check for progress thresholds
        for (const threshold of ALERT_THRESHOLDS) {
          if (newStatus.bondingProgress >= threshold && oldStatus.bondingProgress < threshold) {
            const alertType = threshold === 85 ? 'PROGRESS_85'
              : threshold === 90 ? 'PROGRESS_90'
              : 'PROGRESS_95';

            this.emitAlert({
              type: alertType,
              token: newStatus,
            });

            // Update last alert progress in DB
            await this.updateLastAlertProgress(tokenMint, threshold);
          }
        }

        // Remove migrated tokens from active tracking
        if (newStatus.isMigrated) {
          this.trackedTokens.delete(tokenMint);
        }
      } catch (error) {
        logger.debug({ error, tokenMint }, 'Error polling token');
      }
    }
  }

  /**
   * Emit alert to callback
   */
  private emitAlert(alert: PumpfunAlert): void {
    logger.info({
      type: alert.type,
      tokenMint: alert.token.tokenMint,
      progress: alert.token.bondingProgress,
    }, 'Pump.fun alert');

    if (this.alertCallback) {
      this.alertCallback(alert);
    }
  }

  /**
   * Save status to database
   */
  private async saveToDb(status: BondingCurveStatus): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO pumpfun_tokens (
          token_address, bonding_progress, current_market_cap,
          target_market_cap, estimated_time_to_migration,
          is_migrated, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (token_address) DO UPDATE SET
          bonding_progress = EXCLUDED.bonding_progress,
          current_market_cap = EXCLUDED.current_market_cap,
          estimated_time_to_migration = EXCLUDED.estimated_time_to_migration,
          is_migrated = EXCLUDED.is_migrated,
          migration_detected_at = CASE
            WHEN EXCLUDED.is_migrated AND NOT pumpfun_tokens.is_migrated THEN NOW()
            ELSE pumpfun_tokens.migration_detected_at
          END,
          updated_at = NOW()`,
        [
          status.tokenMint,
          status.bondingProgress,
          status.currentMarketCap,
          status.targetMarketCap,
          status.estimatedTimeToMigration,
          status.isMigrated,
        ]
      );
    } catch (error) {
      logger.warn({ error, tokenMint: status.tokenMint }, 'Failed to save to DB');
    }
  }

  /**
   * Update last alert progress in DB
   */
  private async updateLastAlertProgress(tokenMint: string, progress: number): Promise<void> {
    try {
      await pool.query(
        `UPDATE pumpfun_tokens SET last_alert_progress = $2 WHERE token_address = $1`,
        [tokenMint, progress]
      );
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to update alert progress');
    }
  }

  /**
   * Get tokens approaching migration (>80% bonded)
   */
  async getTokensApproachingMigration(minProgress: number = 80): Promise<BondingCurveStatus[]> {
    const approaching: BondingCurveStatus[] = [];

    for (const status of this.trackedTokens.values()) {
      if (status.bondingProgress >= minProgress && !status.isMigrated) {
        approaching.push(status);
      }
    }

    // Sort by progress descending
    approaching.sort((a, b) => b.bondingProgress - a.bondingProgress);

    return approaching;
  }

  /**
   * Format alert message for Telegram
   */
  formatAlertMessage(alert: PumpfunAlert): string {
    const token = alert.token;
    const progress = token.bondingProgress.toFixed(1);
    const mcap = token.currentMarketCap.toFixed(0);

    switch (alert.type) {
      case 'MIGRATION':
        return `*PUMP.FUN MIGRATION*\n\n` +
          `Token: \`${token.tokenMint.slice(0, 8)}...\`\n` +
          `Bonding curve complete!\n` +
          `Market Cap: $${mcap}\n\n` +
          `Token is now migrating to Raydium!`;

      case 'PROGRESS_95':
        return `*PUMP.FUN ALERT - 95%*\n\n` +
          `Token: \`${token.tokenMint.slice(0, 8)}...\`\n` +
          `Progress: ${progress}%\n` +
          `Market Cap: $${mcap}\n\n` +
          `Migration imminent!`;

      case 'PROGRESS_90':
        return `*PUMP.FUN ALERT - 90%*\n\n` +
          `Token: \`${token.tokenMint.slice(0, 8)}...\`\n` +
          `Progress: ${progress}%\n` +
          `Market Cap: $${mcap}\n\n` +
          `Approaching migration threshold!`;

      case 'PROGRESS_85':
        return `*PUMP.FUN ALERT - 85%*\n\n` +
          `Token: \`${token.tokenMint.slice(0, 8)}...\`\n` +
          `Progress: ${progress}%\n` +
          `Market Cap: $${mcap}\n\n` +
          `Watch for migration opportunity!`;

      default:
        return `Pump.fun update for ${token.tokenMint}`;
    }
  }

  /**
   * Format list of tokens for /pumpfun command
   */
  formatTokenList(tokens: BondingCurveStatus[]): string {
    if (tokens.length === 0) {
      return 'No tokens approaching migration (>80%) currently tracked.';
    }

    let msg = `*PUMP.FUN TOKENS APPROACHING MIGRATION*\n\n`;

    for (const token of tokens.slice(0, 10)) {
      const progress = token.bondingProgress.toFixed(1);
      const mcap = token.currentMarketCap.toFixed(0);
      const progressBar = this.makeProgressBar(token.bondingProgress);

      msg += `\`${token.tokenMint.slice(0, 8)}...\`\n`;
      msg += `${progressBar} ${progress}%\n`;
      msg += `MCap: $${mcap}\n\n`;
    }

    return msg;
  }

  /**
   * Make ASCII progress bar
   */
  private makeProgressBar(progress: number): string {
    const filled = Math.round(progress / 10);
    const empty = 10 - filled;
    return '[' + '='.repeat(filled) + '-'.repeat(empty) + ']';
  }

  /**
   * Check if token is a Pump.fun token
   */
  async isPumpfunToken(tokenMint: string): Promise<boolean> {
    // Skip RPC call when Helius is disabled
    if (appConfig.heliusDisabled) {
      return false;
    }

    try {
      // Check if token was created by Pump.fun program
      const mintPubkey = new PublicKey(tokenMint);
      const signatures = await this.connection.getSignaturesForAddress(
        mintPubkey,
        { limit: 1 },
        'confirmed'
      );

      if (signatures.length === 0) {
        return false;
      }

      const tx = await this.connection.getParsedTransaction(
        signatures[0].signature,
        { maxSupportedTransactionVersion: 0 }
      );

      if (!tx) {
        return false;
      }

      // Check if Pump.fun program is in the transaction
      const accounts = tx.transaction.message.accountKeys.map(k =>
        typeof k === 'string' ? k : k.pubkey.toString()
      );

      return accounts.includes(PUMPFUN_PROGRAM_ID);
    } catch (error) {
      logger.debug({ error, tokenMint }, 'Failed to check if Pump.fun token');
      return false;
    }
  }

  // ============ GRADUATION PIPELINE METHODS ============

  /**
   * Add a migrated token to the graduation pipeline for 21-day observation
   * Called when a token migrates from pump.fun to Raydium
   */
  async addToGraduationPipeline(
    tokenAddress: string,
    tokenName: string,
    ticker: string,
    pumpFunMint: string,
    initialMarketCap: number
  ): Promise<void> {
    const now = new Date();
    const observationEnd = new Date(now.getTime() + OBSERVATION_PERIOD_DAYS * 24 * 60 * 60 * 1000);

    try {
      await pool.query(
        `INSERT INTO graduation_pipeline (
          token_address, token_name, ticker, pump_fun_mint,
          launch_timestamp, graduation_timestamp, peak_market_cap,
          observation_start, observation_end
        ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, NOW(), $7)
        ON CONFLICT (token_address) DO UPDATE SET
          graduation_timestamp = NOW(),
          observation_start = NOW(),
          observation_end = $7,
          updated_at = NOW()`,
        [tokenAddress, tokenName, ticker, pumpFunMint, now, initialMarketCap, observationEnd]
      );

      // Track locally
      this.recentGraduations.set(tokenAddress, {
        tokenAddress,
        tokenName,
        ticker,
        pumpFunMint,
        launchTimestamp: now,
        graduationTimestamp: now,
        initialMarketCap,
        observationEnd,
      });

      // Detect narrative for this token
      await this.detectAndRecordNarrative(tokenName, ticker);

      logger.info({
        tokenAddress,
        ticker,
        observationEnd: observationEnd.toISOString(),
      }, 'Token added to graduation pipeline for 21-day observation');
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to add token to graduation pipeline');
    }
  }

  /**
   * Check if any tokens in the pipeline are ready for promotion (21 days passed)
   */
  async checkPipelinePromotions(): Promise<string[]> {
    const promoted: string[] = [];

    try {
      const result = await pool.query(
        `SELECT token_address, token_name, ticker, graduation_quality_score
         FROM graduation_pipeline
         WHERE observation_end <= NOW()
         AND promoted_to_universe = FALSE
         AND rejection_reason IS NULL`
      );

      for (const row of result.rows) {
        // Calculate quality score if not already done
        if (!row.graduation_quality_score) {
          await this.calculateGraduationQuality(row.token_address);
        }

        // Mark as promoted (the mature token scanner will pick it up)
        await pool.query(
          `UPDATE graduation_pipeline
           SET promoted_to_universe = TRUE, promoted_at = NOW()
           WHERE token_address = $1`,
          [row.token_address]
        );

        promoted.push(row.token_address);
        logger.info({
          tokenAddress: row.token_address,
          ticker: row.ticker,
        }, 'Token promoted from graduation pipeline to universe');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to check pipeline promotions');
    }

    return promoted;
  }

  /**
   * Calculate graduation quality score for a token
   */
  async calculateGraduationQuality(tokenAddress: string): Promise<number> {
    let score = 50; // Base score
    const factors: Record<string, number> = {};

    try {
      const result = await pool.query(
        `SELECT * FROM graduation_pipeline WHERE token_address = $1`,
        [tokenAddress]
      );

      if (result.rows.length === 0) return 0;

      const token = result.rows[0];

      // Factor 1: Bundle percent (lower is better)
      if (token.launch_bundle_percent !== null) {
        if (token.launch_bundle_percent < 10) {
          factors.bundle = 15;
          score += 15;
        } else if (token.launch_bundle_percent < 25) {
          factors.bundle = 5;
          score += 5;
        } else {
          factors.bundle = -15;
          score -= 15;
        }
      }

      // Factor 2: Dev sell percent (lower is better)
      if (token.dev_sell_percent !== null) {
        if (token.dev_sell_percent < 10) {
          factors.devSell = 20;
          score += 20;
        } else if (token.dev_sell_percent < 50) {
          factors.devSell = 0;
        } else {
          factors.devSell = -20;
          score -= 20;
        }
      }

      // Factor 3: Holder retention
      if (token.holder_retention_rate !== null) {
        if (token.holder_retention_rate > 70) {
          factors.retention = 15;
          score += 15;
        } else if (token.holder_retention_rate > 40) {
          factors.retention = 5;
          score += 5;
        } else {
          factors.retention = -10;
          score -= 10;
        }
      }

      // Factor 4: KOL involvement
      if (token.kol_involvement_count !== null) {
        if (token.kol_involvement_count >= 3) {
          factors.kolInvolvement = 15;
          score += 15;
        } else if (token.kol_involvement_count >= 1) {
          factors.kolInvolvement = 5;
          score += 5;
        }
      }

      // Factor 5: First dump recovery
      if (token.first_dump_recovered === true) {
        factors.dumpRecovery = 10;
        score += 10;
      } else if (token.first_dump_recovered === false) {
        factors.dumpRecovery = -10;
        score -= 10;
      }

      // Clamp score between 0 and 100
      score = Math.max(0, Math.min(100, score));

      // Save score
      await pool.query(
        `UPDATE graduation_pipeline
         SET graduation_quality_score = $2, quality_factors = $3, updated_at = NOW()
         WHERE token_address = $1`,
        [tokenAddress, score, JSON.stringify(factors)]
      );

      return score;
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to calculate graduation quality');
      return 0;
    }
  }

  /**
   * Update observation metrics for a token in the pipeline
   */
  async updatePipelineMetrics(
    tokenAddress: string,
    metrics: {
      holderRetentionRate?: number;
      peakMarketCap?: number;
      lowestMarketCap?: number;
      kolInvolvementCount?: number;
      firstDumpRecovered?: boolean;
      growthTrajectory?: string;
    }
  ): Promise<void> {
    try {
      const updates: string[] = [];
      const values: any[] = [tokenAddress];
      let paramIndex = 2;

      if (metrics.holderRetentionRate !== undefined) {
        updates.push(`holder_retention_rate = $${paramIndex++}`);
        values.push(metrics.holderRetentionRate);
      }
      if (metrics.peakMarketCap !== undefined) {
        updates.push(`peak_market_cap = GREATEST(peak_market_cap, $${paramIndex++})`);
        values.push(metrics.peakMarketCap);
      }
      if (metrics.lowestMarketCap !== undefined) {
        updates.push(`lowest_market_cap = LEAST(COALESCE(lowest_market_cap, $${paramIndex}), $${paramIndex++})`);
        values.push(metrics.lowestMarketCap);
      }
      if (metrics.kolInvolvementCount !== undefined) {
        updates.push(`kol_involvement_count = $${paramIndex++}`);
        values.push(metrics.kolInvolvementCount);
      }
      if (metrics.firstDumpRecovered !== undefined) {
        updates.push(`first_dump_recovered = $${paramIndex++}`);
        values.push(metrics.firstDumpRecovered);
      }
      if (metrics.growthTrajectory !== undefined) {
        updates.push(`growth_trajectory = $${paramIndex++}`);
        values.push(metrics.growthTrajectory);
      }

      if (updates.length > 0) {
        updates.push('updated_at = NOW()');
        await pool.query(
          `UPDATE graduation_pipeline SET ${updates.join(', ')} WHERE token_address = $1`,
          values
        );
      }
    } catch (error) {
      logger.error({ error, tokenAddress }, 'Failed to update pipeline metrics');
    }
  }

  // ============ NARRATIVE DETECTION METHODS ============

  /**
   * Detect narrative theme from token name/ticker
   */
  detectNarrative(tokenName: string, ticker: string): string[] {
    const themes: string[] = [];
    const searchText = `${tokenName} ${ticker}`.toLowerCase();

    for (const [theme, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
      for (const keyword of keywords) {
        if (searchText.includes(keyword)) {
          themes.push(theme);
          break;
        }
      }
    }

    return themes;
  }

  /**
   * Detect and record narrative for a token
   */
  private async detectAndRecordNarrative(tokenName: string, ticker: string): Promise<void> {
    const themes = this.detectNarrative(tokenName, ticker);

    // Reset counts every hour
    if (Date.now() - this.lastNarrativeReset > 60 * 60 * 1000) {
      this.narrativeCounts.clear();
      this.lastNarrativeReset = Date.now();
    }

    for (const theme of themes) {
      const current = this.narrativeCounts.get(theme) || 0;
      this.narrativeCounts.set(theme, current + 1);
    }
  }

  /**
   * Get trending narratives based on recent pump.fun activity
   */
  getTrendingNarratives(): NarrativeTrend[] {
    const trends: NarrativeTrend[] = [];

    for (const [theme, count] of this.narrativeCounts) {
      trends.push({
        theme,
        count,
        volume: 0, // Would need to track volume separately
        trending: count >= 3, // Consider trending if 3+ tokens in last hour
      });
    }

    // Sort by count descending
    trends.sort((a, b) => b.count - a.count);

    return trends;
  }

  /**
   * Get narrative bonus multiplier for an established token
   * Based on whether its theme is currently trending on pump.fun
   */
  getNarrativeBonus(tokenName: string, ticker: string): number {
    const themes = this.detectNarrative(tokenName, ticker);
    const trendingNarratives = this.getTrendingNarratives().filter(t => t.trending);

    for (const theme of themes) {
      const trend = trendingNarratives.find(t => t.theme === theme);
      if (trend) {
        // More tokens launching = stronger narrative = higher bonus
        if (trend.count >= 10) return 1.15; // +15%
        if (trend.count >= 5) return 1.10;  // +10%
        return 1.05; // +5%
      }
    }

    return 1.0; // No bonus
  }

  // ============ MARKET REGIME METHODS ============

  /**
   * Get current market regime based on pump.fun activity
   */
  async getMarketRegime(): Promise<{
    regime: 'BULL' | 'CAUTION' | 'BEAR' | 'ROTATION';
    positionSizeMultiplier: number;
    launchesLast24h: number;
    migrationsLast24h: number;
  }> {
    try {
      // Count recent migrations
      const migrationsResult = await pool.query(
        `SELECT COUNT(*) as count FROM pumpfun_tokens
         WHERE is_migrated = TRUE
         AND migration_detected_at > NOW() - INTERVAL '24 hours'`
      );
      const migrationsLast24h = parseInt(migrationsResult.rows[0]?.count || '0');

      // Count recent launches in pipeline
      const launchesResult = await pool.query(
        `SELECT COUNT(*) as count FROM graduation_pipeline
         WHERE created_at > NOW() - INTERVAL '24 hours'`
      );
      const launchesLast24h = parseInt(launchesResult.rows[0]?.count || '0');

      // Determine regime
      let regime: 'BULL' | 'CAUTION' | 'BEAR' | 'ROTATION';
      let positionSizeMultiplier: number;

      if (launchesLast24h >= 50 && migrationsLast24h >= 20) {
        // High launches + high migrations = bull
        regime = 'BULL';
        positionSizeMultiplier = 1.2;
      } else if (launchesLast24h >= 30 && migrationsLast24h < 10) {
        // High launches + low migrations = frothy/caution
        regime = 'CAUTION';
        positionSizeMultiplier = 1.0;
      } else if (launchesLast24h < 15 && migrationsLast24h < 5) {
        // Low activity overall = bear
        regime = 'BEAR';
        positionSizeMultiplier = 0.8;
      } else {
        // Low launches + decent migrations = rotation to established
        regime = 'ROTATION';
        positionSizeMultiplier = 1.1;
      }

      return {
        regime,
        positionSizeMultiplier,
        launchesLast24h,
        migrationsLast24h,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to calculate market regime');
      return {
        regime: 'CAUTION',
        positionSizeMultiplier: 1.0,
        launchesLast24h: 0,
        migrationsLast24h: 0,
      };
    }
  }

  /**
   * Get tokens currently in observation pipeline
   */
  async getTokensInPipeline(): Promise<GraduationPipelineEntry[]> {
    try {
      const result = await pool.query(
        `SELECT token_address, token_name, ticker, pump_fun_mint,
                launch_timestamp, graduation_timestamp, peak_market_cap as initial_market_cap,
                observation_end
         FROM graduation_pipeline
         WHERE promoted_to_universe = FALSE
         AND rejection_reason IS NULL
         ORDER BY observation_end ASC`
      );

      return result.rows.map(row => ({
        tokenAddress: row.token_address,
        tokenName: row.token_name,
        ticker: row.ticker,
        pumpFunMint: row.pump_fun_mint,
        launchTimestamp: row.launch_timestamp,
        graduationTimestamp: row.graduation_timestamp,
        initialMarketCap: parseFloat(row.initial_market_cap || '0'),
        observationEnd: row.observation_end,
      }));
    } catch (error) {
      logger.error({ error }, 'Failed to get tokens in pipeline');
      return [];
    }
  }
}

// ============ EXPORTS ============

export const bondingCurveMonitor = new BondingCurveMonitor();

export default {
  BondingCurveMonitor,
  bondingCurveMonitor,
  PUMPFUN_PROGRAM_ID,
  TARGET_MARKET_CAP,
  ALERT_THRESHOLDS,
};
