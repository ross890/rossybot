// ===========================================
// MODULE: PUMP.FUN BONDING CURVE MONITOR (Feature 4)
// Monitors tokens approaching migration
// ===========================================

import { Connection, PublicKey } from '@solana/web3.js';
import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import type { BondingCurveStatus, PumpfunAlert } from '../../types/index.js';

// ============ CONSTANTS ============

// Pump.fun Program ID
const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Migration thresholds
const TARGET_MARKET_CAP = 69000; // ~$69k for migration
const ALERT_THRESHOLDS = [85, 90, 95]; // Alert at 85%, 90%, 95%

// Polling interval for tracked tokens
const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

// ============ BONDING MONITOR CLASS ============

export class BondingCurveMonitor {
  private connection: Connection;
  private trackedTokens: Map<string, BondingCurveStatus> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private alertCallback: ((alert: PumpfunAlert) => void) | null = null;

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
