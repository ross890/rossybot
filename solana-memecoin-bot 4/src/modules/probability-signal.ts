// ===========================================
// PROBABILITY SIGNAL INTEGRATION
// Wires 2x probability, RugCheck, and Dev Scoring
// into the existing signal pipeline
// ===========================================

import { logger } from '../utils/logger.js';
import { pool } from '../utils/database.js';
import { twoXProbabilityEngine, TwoXSignal, TwoXSignalInput } from './two-x-probability.js';
import { rugCheckClient, RugCheckResult } from './rugcheck.js';
import { devWalletScorer, DevScore } from './dev-scorer.js';
import { tokenCrawler } from './token-crawler.js';
import { backtestAnalysis, ConversionStats } from './backtest-analysis.js';
import { formatTwoXAlert, TwoXAlertData } from './telegram/two-x-formatter.js';
import { KolWalletActivity, TokenMetrics } from '../types/index.js';

// ============ TYPES ============

export interface ProbabilityCheckResult {
  shouldSignal: boolean;
  twoXSignal: TwoXSignal;
  formattedAlert: string | null;
  skipReason: string | null;
}

// ============ PROBABILITY SIGNAL MODULE ============

class ProbabilitySignalModule {
  private initialized = false;
  private backtestTimer: NodeJS.Timeout | null = null;
  private latestStats: ConversionStats | null = null;

  /**
   * Initialize the probability signal module
   * - Loads probability config from DB
   * - Starts the token crawler
   * - Schedules periodic backtest analysis
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing probability signal module...');

    // Run DB migration inline (create tables if not exist)
    await this.ensureTables();

    // Load probability config
    await twoXProbabilityEngine.loadConfig();

    // Initialize token crawler
    await tokenCrawler.initialize();

    this.initialized = true;
    logger.info('Probability signal module initialized');
  }

  /**
   * Start background services
   */
  start(): void {
    // Start token crawler
    tokenCrawler.start();
    logger.info('Token crawler started');

    // Schedule backtest analysis every 6 hours
    this.backtestTimer = setInterval(
      () => this.runBacktest(),
      6 * 60 * 60 * 1000
    );

    // Run initial backtest after 5 minutes (allow some data collection)
    setTimeout(() => this.runBacktest(), 5 * 60 * 1000);

    logger.info('Probability signal module started');
  }

  /**
   * Stop background services
   */
  stop(): void {
    tokenCrawler.stop();
    if (this.backtestTimer) {
      clearInterval(this.backtestTimer);
      this.backtestTimer = null;
    }
    logger.info('Probability signal module stopped');
  }

  /**
   * Check a token against the 2x probability engine
   * Called from the signal generator when a token hits $50k MC
   */
  async checkToken(
    tokenMetrics: TokenMetrics,
    kolActivity: KolWalletActivity | null,
    holders30minAgo: number,
    volumeRollingAvg: number
  ): Promise<ProbabilityCheckResult> {
    // Build input for the 2x probability engine
    const input: TwoXSignalInput = {
      contractAddress: tokenMetrics.address,
      marketCap: tokenMetrics.marketCap,
      liquidityUsd: tokenMetrics.liquidityPool,
      holdersNow: tokenMetrics.holderCount,
      holders30minAgo,
      volume24h: tokenMetrics.volume24h,
      volumeRollingAvg,
      kolBuyDetected: kolActivity !== null,
      kolName: kolActivity?.kol?.handle || null,
    };

    // Calculate 2x probability
    const twoXSignal = await twoXProbabilityEngine.calculate(input);

    // Check if signal should fire
    if (!twoXSignal.gatesPassed) {
      return {
        shouldSignal: false,
        twoXSignal,
        formattedAlert: null,
        skipReason: twoXSignal.skipReason,
      };
    }

    // Check alert rate limiting
    const canAlert = twoXProbabilityEngine.canSendAlert(tokenMetrics.address);
    if (!canAlert.allowed) {
      return {
        shouldSignal: false,
        twoXSignal,
        formattedAlert: null,
        skipReason: canAlert.reason || null,
      };
    }

    // Format the alert
    const alertData: TwoXAlertData = {
      ticker: tokenMetrics.ticker,
      tokenName: tokenMetrics.name,
      contractAddress: tokenMetrics.address,
      marketCap: tokenMetrics.marketCap,
      twoXSignal,
      holdersNow: tokenMetrics.holderCount,
      holders30minAgo,
      volume24h: tokenMetrics.volume24h,
      volumeRollingAvg,
      liquidityUsd: tokenMetrics.liquidityPool,
      kolName: kolActivity?.kol?.handle || null,
    };

    const formattedAlert = formatTwoXAlert(alertData);

    // Record that we're sending an alert
    twoXProbabilityEngine.recordAlertSent(tokenMetrics.address);

    return {
      shouldSignal: true,
      twoXSignal,
      formattedAlert,
      skipReason: null,
    };
  }

  /**
   * Get a RugCheck result for a token (for use in existing pipeline)
   */
  async getRugCheck(contractAddress: string): Promise<RugCheckResult> {
    return rugCheckClient.checkToken(contractAddress);
  }

  /**
   * Get a dev score for a deployer wallet (for use in existing pipeline)
   */
  async getDevScore(deployerAddress: string): Promise<DevScore> {
    return devWalletScorer.scoreDevWallet(deployerAddress);
  }

  /**
   * Run backtest analysis and update base rate
   */
  async runBacktest(): Promise<ConversionStats> {
    this.latestStats = await backtestAnalysis.runAnalysis();
    return this.latestStats;
  }

  /**
   * Get latest stats (for /stats command)
   */
  getLatestStats(): ConversionStats | null {
    return this.latestStats;
  }

  /**
   * Get formatted stats for Telegram
   */
  getFormattedStats(): string {
    if (!this.latestStats) {
      return '📊 No backtest data available yet. Crawler is collecting data.';
    }
    return backtestAnalysis.formatForTelegram(this.latestStats);
  }

  /**
   * Get crawler status
   */
  getCrawlerStats(): { active: number; candidate: number; background: number; total: number } {
    return tokenCrawler.getTrackedStats();
  }

  /**
   * Ensure all required tables exist (inline migration)
   */
  private async ensureTables(): Promise<void> {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS api_log (
          id SERIAL PRIMARY KEY,
          service VARCHAR(32),
          endpoint VARCHAR(256),
          status_code INTEGER,
          response_time_ms INTEGER,
          timestamp TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_api_log_service ON api_log(service, timestamp);

        CREATE TABLE IF NOT EXISTS token_tracking (
          id SERIAL PRIMARY KEY,
          contract_address VARCHAR(64) NOT NULL UNIQUE,
          pair_address VARCHAR(64),
          ticker VARCHAR(32),
          deployer_wallet VARCHAR(64),
          launch_timestamp TIMESTAMPTZ,
          first_50k_timestamp TIMESTAMPTZ,
          mc_at_50k NUMERIC,
          holders_at_50k INTEGER,
          volume_24h_at_50k NUMERIC,
          liquidity_at_50k NUMERIC,
          peak_mc NUMERIC,
          peak_mc_timestamp TIMESTAMPTZ,
          time_50k_to_peak_minutes INTEGER,
          hit_100k BOOLEAN DEFAULT FALSE,
          hit_250k BOOLEAN DEFAULT FALSE,
          hit_500k BOOLEAN DEFAULT FALSE,
          hit_1m BOOLEAN DEFAULT FALSE,
          time_50k_to_100k_minutes INTEGER,
          rugcheck_score VARCHAR(16),
          mint_authority_revoked BOOLEAN,
          freeze_authority_revoked BOOLEAN,
          lp_locked BOOLEAN,
          top10_holder_pct NUMERIC,
          rugcheck_raw JSONB,
          dev_total_launches INTEGER,
          dev_launches_over_100k INTEGER,
          dev_score VARCHAR(16),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_tt_deployer ON token_tracking(deployer_wallet);
        CREATE INDEX IF NOT EXISTS idx_tt_hit_100k ON token_tracking(hit_100k);
        CREATE INDEX IF NOT EXISTS idx_tt_first_50k ON token_tracking(first_50k_timestamp);
        CREATE INDEX IF NOT EXISTS idx_tt_dev_score ON token_tracking(dev_score);

        CREATE TABLE IF NOT EXISTS dev_wallet_cache (
          deployer_wallet VARCHAR(64) PRIMARY KEY,
          total_launches INTEGER,
          launches_over_100k INTEGER,
          known_tokens JSONB,
          dev_score VARCHAR(16),
          last_updated TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS probability_config (
          key VARCHAR(64) PRIMARY KEY,
          value NUMERIC NOT NULL,
          description TEXT,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        INSERT INTO probability_config (key, value, description) VALUES
          ('base_rate', 0.32, 'Base conversion rate'),
          ('mod_dev_red_flag', -1.0, 'Dev RED_FLAG: auto-skip'),
          ('mod_dev_caution', -0.08, 'Dev CAUTION modifier'),
          ('mod_dev_clean', 0.10, 'Dev CLEAN modifier'),
          ('mod_dev_new', 0.00, 'Dev NEW_DEV modifier'),
          ('mod_rugcheck_warning', -0.10, 'RugCheck WARNING modifier'),
          ('mod_rugcheck_good', 0.00, 'RugCheck GOOD modifier'),
          ('mod_holder_velocity_positive', 0.10, 'Holder growth >15% in 30min'),
          ('mod_holder_velocity_negative', -0.05, 'Holder velocity flat/declining'),
          ('mod_volume_acceleration', 0.08, 'Volume >3x rolling avg'),
          ('mod_kol_buy_detected', 0.12, 'KOL buy in last 1hr'),
          ('mod_liquidity_high', 0.05, 'LP > $25k'),
          ('mod_liquidity_low', -0.05, 'LP < $15k'),
          ('min_probability_threshold', 0.30, 'Min probability to fire'),
          ('high_confidence_threshold', 0.45, 'HIGH confidence threshold'),
          ('alert_cooldown_hours', 4, 'Hours between alerts per token'),
          ('max_alerts_per_hour', 10, 'Max alerts/hour across all signals')
        ON CONFLICT (key) DO NOTHING;
      `);

      logger.debug('Probability signal tables verified');
    } catch (error) {
      logger.error({ error }, 'Failed to ensure probability tables exist');
      throw error;
    }
  }
}

// ============ EXPORTS ============

export const probabilitySignalModule = new ProbabilitySignalModule();
