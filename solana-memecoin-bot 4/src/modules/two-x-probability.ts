// ===========================================
// 2x PROBABILITY CALCULATOR (Task E)
// Calculates probability of token doubling from $50k → $100k MC
// ===========================================

import { logger } from '../utils/logger.js';
import { pool } from '../utils/database.js';
import { rugCheckClient, RugCheckResult, RugCheckDecision } from './rugcheck.js';
import { devWalletScorer, DevScore } from './dev-scorer.js';
import { TTLCache } from '../utils/rate-limiter.js';

// ============ TYPES ============

export interface TwoXModifiers {
  devScore: number;
  rugCheckResult: number;
  holderVelocity: number;
  volumeAcceleration: number;
  kolBuyDetected: number;
  liquidityDepth: number;
}

export interface TwoXSignal {
  baseRate: number;
  adjustedProbability: number;
  modifiers: TwoXModifiers;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  gatesPassed: boolean;
  skipReason: string | null;
  // Supporting data
  rugCheck: RugCheckResult | null;
  devScoreData: DevScore | null;
  kolName: string | null;
}

export interface TwoXSignalInput {
  contractAddress: string;
  marketCap: number;
  liquidityUsd: number;
  holdersNow: number;
  holders30minAgo: number;
  volume24h: number;
  volumeRollingAvg: number;
  kolBuyDetected: boolean;
  kolName: string | null;
}

// ============ CONFIGURATION ============
// All values loaded from probability_config table, with these defaults

interface ProbabilityModifiers {
  baseRate: number;
  modDevRedFlag: number;
  modDevCaution: number;
  modDevClean: number;
  modDevNew: number;
  modRugcheckWarning: number;
  modRugcheckGood: number;
  modHolderVelocityPositive: number;
  modHolderVelocityNegative: number;
  modVolumeAcceleration: number;
  modKolBuyDetected: number;
  modLiquidityHigh: number;
  modLiquidityLow: number;
  minProbabilityThreshold: number;
  highConfidenceThreshold: number;
  alertCooldownHours: number;
  maxAlertsPerHour: number;
}

const DEFAULT_MODIFIERS: ProbabilityModifiers = {
  baseRate: 0.32,
  modDevRedFlag: -1.0,
  modDevCaution: -0.08,
  modDevClean: 0.10,
  modDevNew: 0.00,
  modRugcheckWarning: -0.10,
  modRugcheckGood: 0.00,
  modHolderVelocityPositive: 0.10,
  modHolderVelocityNegative: -0.05,
  modVolumeAcceleration: 0.08,
  modKolBuyDetected: 0.12,
  modLiquidityHigh: 0.05,
  modLiquidityLow: -0.05,
  minProbabilityThreshold: 0.30,
  highConfidenceThreshold: 0.45,
  alertCooldownHours: 4,
  maxAlertsPerHour: 10,
};

// Alert cooldown tracking
const alertCooldowns = new TTLCache<number>(500);
let alertsThisHour = 0;
let alertHourStart = Date.now();

// ============ 2x PROBABILITY ENGINE ============

class TwoXProbabilityEngine {
  private modifiers: ProbabilityModifiers = { ...DEFAULT_MODIFIERS };
  private configLoaded = false;

  /**
   * Load configurable modifiers from the probability_config table
   */
  async loadConfig(): Promise<void> {
    try {
      const result = await pool.query('SELECT key, value FROM probability_config');

      for (const row of result.rows) {
        const key = row.key as string;
        const value = Number(row.value);

        switch (key) {
          case 'base_rate': this.modifiers.baseRate = value; break;
          case 'mod_dev_red_flag': this.modifiers.modDevRedFlag = value; break;
          case 'mod_dev_caution': this.modifiers.modDevCaution = value; break;
          case 'mod_dev_clean': this.modifiers.modDevClean = value; break;
          case 'mod_dev_new': this.modifiers.modDevNew = value; break;
          case 'mod_rugcheck_warning': this.modifiers.modRugcheckWarning = value; break;
          case 'mod_rugcheck_good': this.modifiers.modRugcheckGood = value; break;
          case 'mod_holder_velocity_positive': this.modifiers.modHolderVelocityPositive = value; break;
          case 'mod_holder_velocity_negative': this.modifiers.modHolderVelocityNegative = value; break;
          case 'mod_volume_acceleration': this.modifiers.modVolumeAcceleration = value; break;
          case 'mod_kol_buy_detected': this.modifiers.modKolBuyDetected = value; break;
          case 'mod_liquidity_high': this.modifiers.modLiquidityHigh = value; break;
          case 'mod_liquidity_low': this.modifiers.modLiquidityLow = value; break;
          case 'min_probability_threshold': this.modifiers.minProbabilityThreshold = value; break;
          case 'high_confidence_threshold': this.modifiers.highConfidenceThreshold = value; break;
          case 'alert_cooldown_hours': this.modifiers.alertCooldownHours = value; break;
          case 'max_alerts_per_hour': this.modifiers.maxAlertsPerHour = value; break;
        }
      }

      this.configLoaded = true;
      logger.info({ baseRate: this.modifiers.baseRate }, '2x probability config loaded from database');
    } catch (error) {
      logger.warn({ error }, 'Failed to load probability config from DB, using defaults');
    }
  }

  /**
   * Calculate the 2x probability for a token
   * Returns the full signal with all modifiers applied
   */
  async calculate(input: TwoXSignalInput): Promise<TwoXSignal> {
    if (!this.configLoaded) {
      await this.loadConfig();
    }

    const mod = this.modifiers;
    const modifiers: TwoXModifiers = {
      devScore: 0,
      rugCheckResult: 0,
      holderVelocity: 0,
      volumeAcceleration: 0,
      kolBuyDetected: 0,
      liquidityDepth: 0,
    };

    let rugCheckResult: RugCheckResult | null = null;
    let devScoreData: DevScore | null = null;
    let skipReason: string | null = null;

    // =========== GATE 1: Market Cap >= $50k ===========
    if (input.marketCap < 50000) {
      return this.buildSkipSignal(modifiers, 'Market cap below $50k', rugCheckResult, devScoreData);
    }

    // =========== GATE 2: RugCheck (Layer 1) ===========
    try {
      rugCheckResult = await rugCheckClient.checkToken(input.contractAddress);
      const decision = rugCheckClient.getDecision(rugCheckResult);

      if (decision.action === 'AUTO_SKIP') {
        return this.buildSkipSignal(modifiers, decision.reason, rugCheckResult, devScoreData);
      }

      if (decision.action === 'NEGATIVE_MODIFIER') {
        modifiers.rugCheckResult = mod.modRugcheckWarning;
      } else {
        modifiers.rugCheckResult = mod.modRugcheckGood;
      }
    } catch (error) {
      logger.warn({ error, address: input.contractAddress.slice(0, 8) }, 'RugCheck failed during 2x calc');
      modifiers.rugCheckResult = mod.modRugcheckWarning; // Default to warning penalty
    }

    // =========== GATE 3: Dev Score (Layer 2) ===========
    try {
      // Try to get deployer wallet from our DB
      const deployerResult = await pool.query(
        `SELECT deployer_wallet FROM token_tracking WHERE contract_address = $1`,
        [input.contractAddress]
      );

      let deployerWallet = deployerResult.rows[0]?.deployer_wallet;

      if (!deployerWallet) {
        // Try to discover deployer
        deployerWallet = await devWalletScorer.discoverDeployer(input.contractAddress);
      }

      if (deployerWallet) {
        devScoreData = await devWalletScorer.scoreDevWallet(deployerWallet);

        switch (devScoreData.score) {
          case 'RED_FLAG':
            return this.buildSkipSignal(
              modifiers,
              `Dev RED_FLAG: ${devScoreData.totalLaunches} launches, 0 hit $100k`,
              rugCheckResult,
              devScoreData
            );
          case 'CAUTION':
            modifiers.devScore = mod.modDevCaution;
            break;
          case 'CLEAN':
            modifiers.devScore = mod.modDevClean;
            break;
          case 'NEW_DEV':
            modifiers.devScore = mod.modDevNew;
            break;
        }
      } else {
        // Unknown deployer — treat as NEW_DEV (neutral)
        modifiers.devScore = mod.modDevNew;
      }
    } catch (error) {
      logger.debug({ error, address: input.contractAddress.slice(0, 8) }, 'Dev scoring failed during 2x calc');
      modifiers.devScore = mod.modDevNew; // Default to neutral
    }

    // =========== MODIFIER: Holder Velocity ===========
    if (input.holders30minAgo > 0) {
      const growthRate = (input.holdersNow - input.holders30minAgo) / input.holders30minAgo;

      if (growthRate > 0.15) {
        modifiers.holderVelocity = mod.modHolderVelocityPositive;
      } else if (growthRate <= 0) {
        modifiers.holderVelocity = mod.modHolderVelocityNegative;
      }
      // 0-15% growth → no modifier (neutral zone)
    }

    // =========== MODIFIER: Volume Acceleration ===========
    if (input.volumeRollingAvg > 0) {
      const volumeMultiple = input.volume24h / input.volumeRollingAvg;

      if (volumeMultiple > 3) {
        modifiers.volumeAcceleration = mod.modVolumeAcceleration;
      }
    }

    // =========== MODIFIER: KOL Buy Detected ===========
    if (input.kolBuyDetected) {
      modifiers.kolBuyDetected = mod.modKolBuyDetected;
    }

    // =========== MODIFIER: Liquidity Depth ===========
    if (input.liquidityUsd > 25000) {
      modifiers.liquidityDepth = mod.modLiquidityHigh;
    } else if (input.liquidityUsd < 15000) {
      modifiers.liquidityDepth = mod.modLiquidityLow;
    }

    // =========== CALCULATE ADJUSTED PROBABILITY ===========
    const totalModifier =
      modifiers.devScore +
      modifiers.rugCheckResult +
      modifiers.holderVelocity +
      modifiers.volumeAcceleration +
      modifiers.kolBuyDetected +
      modifiers.liquidityDepth;

    const adjustedProbability = Math.max(0, Math.min(1, mod.baseRate + totalModifier));

    // =========== GATE 4: Minimum probability threshold ===========
    const gatesPassed = adjustedProbability >= mod.minProbabilityThreshold;

    if (!gatesPassed) {
      skipReason = `Probability ${(adjustedProbability * 100).toFixed(1)}% below threshold ${(mod.minProbabilityThreshold * 100).toFixed(1)}%`;
    }

    // =========== DETERMINE CONFIDENCE ===========
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW';

    if (
      adjustedProbability >= mod.highConfidenceThreshold &&
      devScoreData?.score === 'CLEAN' &&
      rugCheckResult?.score === 'GOOD'
    ) {
      confidence = 'HIGH';
    } else if (adjustedProbability >= mod.minProbabilityThreshold) {
      confidence = 'MEDIUM';
    } else {
      confidence = 'LOW';
    }

    const signal: TwoXSignal = {
      baseRate: mod.baseRate,
      adjustedProbability,
      modifiers,
      confidence,
      gatesPassed,
      skipReason,
      rugCheck: rugCheckResult,
      devScoreData,
      kolName: input.kolName,
    };

    logger.info({
      address: input.contractAddress.slice(0, 8),
      baseRate: (mod.baseRate * 100).toFixed(1) + '%',
      adjusted: (adjustedProbability * 100).toFixed(1) + '%',
      confidence,
      gatesPassed,
      modifiers: {
        dev: modifiers.devScore,
        rug: modifiers.rugCheckResult,
        holders: modifiers.holderVelocity,
        volume: modifiers.volumeAcceleration,
        kol: modifiers.kolBuyDetected,
        liq: modifiers.liquidityDepth,
      },
    }, '2x probability calculated');

    return signal;
  }

  /**
   * Check if we can send an alert (cooldown + rate limiting)
   */
  canSendAlert(contractAddress: string): { allowed: boolean; reason?: string } {
    // Check per-token cooldown
    const lastAlertTime = alertCooldowns.get(contractAddress);
    if (lastAlertTime) {
      const cooldownMs = this.modifiers.alertCooldownHours * 60 * 60 * 1000;
      if (Date.now() - lastAlertTime < cooldownMs) {
        return {
          allowed: false,
          reason: `Token on cooldown (${this.modifiers.alertCooldownHours}h between alerts)`,
        };
      }
    }

    // Check hourly rate limit
    if (Date.now() - alertHourStart >= 60 * 60 * 1000) {
      alertsThisHour = 0;
      alertHourStart = Date.now();
    }

    if (alertsThisHour >= this.modifiers.maxAlertsPerHour) {
      return {
        allowed: false,
        reason: `Max ${this.modifiers.maxAlertsPerHour} alerts/hour exceeded`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record that an alert was sent (for cooldown tracking)
   */
  recordAlertSent(contractAddress: string): void {
    alertCooldowns.set(
      contractAddress,
      Date.now(),
      this.modifiers.alertCooldownHours * 60 * 60 * 1000
    );
    alertsThisHour++;
  }

  /**
   * Get current base rate (for display)
   */
  getBaseRate(): number {
    return this.modifiers.baseRate;
  }

  /**
   * Update base rate from backtest data
   */
  async updateBaseRate(newRate: number): Promise<void> {
    this.modifiers.baseRate = newRate;
    try {
      await pool.query(
        `UPDATE probability_config SET value = $1, updated_at = NOW() WHERE key = 'base_rate'`,
        [newRate]
      );
      logger.info({ newRate: (newRate * 100).toFixed(1) + '%' }, 'Base rate updated from backtest data');
    } catch (error) {
      logger.error({ error }, 'Failed to update base rate in DB');
    }
  }

  /**
   * Build a "skip" signal (token didn't pass gates)
   */
  private buildSkipSignal(
    modifiers: TwoXModifiers,
    skipReason: string,
    rugCheck: RugCheckResult | null,
    devScoreData: DevScore | null
  ): TwoXSignal {
    return {
      baseRate: this.modifiers.baseRate,
      adjustedProbability: 0,
      modifiers,
      confidence: 'LOW',
      gatesPassed: false,
      skipReason,
      rugCheck,
      devScoreData,
      kolName: null,
    };
  }
}

// ============ EXPORTS ============

export const twoXProbabilityEngine = new TwoXProbabilityEngine();
