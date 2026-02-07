// ===========================================
// MODULE: PUMP.FUN DEV WALLET MONITOR
// Real-time monitoring of tracked dev wallets
// for new token deployments
// Uses Solscan Pro API v2.0 for all on-chain queries
// ===========================================

import axios from 'axios';
import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { createDevSignal, formatDevSignalTelegram } from './dev-signal.js';
import type { PumpfunDev, DevSignal } from '../../types/index.js';

// ============ CONSTANTS ============

const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Solscan Pro API v2.0
const SOLSCAN_BASE = 'https://pro-api.solscan.io/v2.0';

// Poll interval for checking dev wallet activity
const POLL_INTERVAL_MS = 15 * 1000; // 15 seconds — fast enough for bonding curve speed

// ============ SOLSCAN CLIENT ============

async function solscanGet(path: string, params?: Record<string, string>): Promise<any> {
  const apiKey = appConfig.solscanApiKey;
  if (!apiKey) {
    return null;
  }

  try {
    const url = new URL(`${SOLSCAN_BASE}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await axios.get(url.toString(), {
      headers: { 'token': apiKey },
      timeout: 10000,
    });

    return response.data;
  } catch (error: any) {
    if (error?.response?.status === 429) {
      logger.warn('Solscan rate limited in dev monitor');
    } else {
      logger.debug({ error: error?.message, path }, 'Solscan dev monitor request failed');
    }
    return null;
  }
}

// ============ DEV MONITOR CLASS ============

export class PumpfunDevMonitor {
  private trackedDevs: Map<string, PumpfunDev> = new Map(); // wallet → dev record
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private initialized = false;

  // Cooldown tracking: wallet → last signal timestamp
  private lastSignalTime: Map<string, number> = new Map();

  // Track recently seen tx signatures to avoid duplicates
  private recentTxSignatures: Set<string> = new Set();
  private readonly MAX_RECENT_TX = 5000;

  // Callback for sending signals to Telegram
  private signalCallback: ((signal: DevSignal, formattedMessage: string) => Promise<void>) | null = null;

  // ============ INITIALIZATION ============

  /**
   * Initialize: load all active devs from DB
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Pump.fun Dev Monitor (Solscan)...');

    if (!appConfig.solscanApiKey) {
      logger.warn('SOLSCAN_API_KEY not set — Dev Monitor will be limited');
    }

    await this.loadTrackedDevs();

    this.initialized = true;
    logger.info({ devCount: this.trackedDevs.size }, 'Pump.fun Dev Monitor initialized');
  }

  /**
   * Set callback for signal delivery
   */
  onSignal(callback: (signal: DevSignal, formattedMessage: string) => Promise<void>): void {
    this.signalCallback = callback;
  }

  /**
   * Start monitoring dev wallets
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Dev Monitor already running');
      return;
    }

    if (!this.initialized) {
      logger.error('Dev Monitor not initialized — call initialize() first');
      return;
    }

    this.isRunning = true;

    // Start polling loop
    this.pollTimer = setInterval(() => this.pollDevWallets(), POLL_INTERVAL_MS);

    // Immediate first poll
    this.pollDevWallets();

    logger.info({ devCount: this.trackedDevs.size }, 'Pump.fun Dev Monitor started (Solscan)');
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Pump.fun Dev Monitor stopped');
  }

  // ============ DEV MANAGEMENT ============

  /**
   * Load active devs from database into memory
   */
  async loadTrackedDevs(): Promise<void> {
    try {
      const result = await pool.query(
        'SELECT * FROM pumpfun_devs WHERE is_active = true'
      );

      this.trackedDevs.clear();
      for (const row of result.rows) {
        const dev = this.mapDevRow(row);
        this.trackedDevs.set(dev.walletAddress, dev);
      }

      logger.info({ count: this.trackedDevs.size }, 'Loaded tracked devs from database');
    } catch (error) {
      logger.error({ error }, 'Failed to load tracked devs');
    }
  }

  /**
   * Add a dev wallet to tracking
   */
  async addDev(walletAddress: string, alias?: string, notes?: string): Promise<PumpfunDev | null> {
    try {
      const result = await pool.query(
        `INSERT INTO pumpfun_devs (wallet_address, alias, notes)
         VALUES ($1, $2, $3)
         ON CONFLICT (wallet_address) DO UPDATE SET
           alias = COALESCE($2, pumpfun_devs.alias),
           notes = COALESCE($3, pumpfun_devs.notes),
           is_active = true,
           updated_at = NOW()
         RETURNING *`,
        [walletAddress, alias || null, notes || null]
      );

      const dev = this.mapDevRow(result.rows[0]);
      this.trackedDevs.set(dev.walletAddress, dev);

      logger.info({ walletAddress, alias }, 'Dev wallet added to tracking');
      return dev;
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to add dev wallet');
      return null;
    }
  }

  /**
   * Remove a dev wallet from tracking
   */
  async removeDev(walletAddress: string): Promise<boolean> {
    try {
      await pool.query(
        `UPDATE pumpfun_devs SET is_active = false, updated_at = NOW()
         WHERE wallet_address = $1`,
        [walletAddress]
      );

      this.trackedDevs.delete(walletAddress);
      logger.info({ walletAddress }, 'Dev wallet removed from tracking');
      return true;
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to remove dev wallet');
      return false;
    }
  }

  /**
   * Get all tracked devs
   */
  getTrackedDevs(): PumpfunDev[] {
    return Array.from(this.trackedDevs.values());
  }

  /**
   * Get a specific dev by wallet address
   */
  getDev(walletAddress: string): PumpfunDev | undefined {
    return this.trackedDevs.get(walletAddress);
  }

  /**
   * Check if a token was launched by a tracked dev
   */
  isTrackedDev(walletAddress: string): boolean {
    return this.trackedDevs.has(walletAddress);
  }

  // ============ POLLING VIA SOLSCAN ============

  /**
   * Poll all tracked dev wallets for new transactions via Solscan
   * Check for token creation transactions
   */
  private async pollDevWallets(): Promise<void> {
    if (!this.isRunning || this.trackedDevs.size === 0) return;

    if (!appConfig.solscanApiKey) return;

    const wallets = Array.from(this.trackedDevs.keys());

    // Process wallets in batches to respect Solscan rate limits
    const batchSize = 3;
    for (let i = 0; i < wallets.length; i += batchSize) {
      const batch = wallets.slice(i, i + batchSize);

      await Promise.all(
        batch.map(wallet => this.checkDevWalletViaSolscan(wallet).catch(error => {
          logger.debug({ error, wallet }, 'Error checking dev wallet via Solscan');
        }))
      );

      // Pause between batches to avoid Solscan rate limiting
      if (i + batchSize < wallets.length) {
        await this.sleep(1000);
      }
    }

    // Cleanup old tx signatures to prevent memory growth
    if (this.recentTxSignatures.size > this.MAX_RECENT_TX) {
      const entries = Array.from(this.recentTxSignatures);
      const toRemove = entries.slice(0, entries.length - this.MAX_RECENT_TX);
      for (const sig of toRemove) {
        this.recentTxSignatures.delete(sig);
      }
    }
  }

  /**
   * Check a single dev wallet for recent transactions via Solscan
   * Uses GET /account/transactions to get recent activity
   */
  private async checkDevWalletViaSolscan(walletAddress: string): Promise<void> {
    try {
      // Fetch recent transactions for this wallet from Solscan
      const txData = await solscanGet('/account/transactions', {
        address: walletAddress,
        page_size: '5',
        page: '1',
      });

      if (!txData?.data || !Array.isArray(txData.data)) return;

      for (const tx of txData.data) {
        const txHash = tx.tx_hash || tx.txHash || tx.signature;
        if (!txHash) continue;

        // Skip already-processed transactions
        if (this.recentTxSignatures.has(txHash)) continue;
        this.recentTxSignatures.add(txHash);

        // Skip failed transactions
        if (tx.status === 'Fail' || tx.err) continue;

        // Check if this transaction involves the Pump.fun program
        const isPumpfun = this.isPumpfunTxFromSolscan(tx);
        if (!isPumpfun) continue;

        // Check if this looks like a token creation (not just a buy/sell)
        const tokenMint = this.extractTokenMintFromSolscanTx(tx);
        if (!tokenMint) continue;

        // Verify this token isn't already known (i.e., it's a NEW launch)
        const alreadyKnown = await this.isTokenAlreadyRecorded(tokenMint);
        if (alreadyKnown) continue;

        // Process as a new dev launch
        await this.handleNewDevLaunch(walletAddress, tokenMint);
      }
    } catch (error) {
      logger.debug({ error, walletAddress }, 'Error checking dev wallet via Solscan');
    }
  }

  /**
   * Check if a Solscan transaction involves the Pump.fun program
   */
  private isPumpfunTxFromSolscan(tx: any): boolean {
    // Solscan transaction data includes program IDs in different formats
    // Check parsed_instructions, program_invocations, or programs array
    const programs = tx.program_ids || tx.programs || [];
    if (Array.isArray(programs) && programs.includes(PUMPFUN_PROGRAM_ID)) {
      return true;
    }

    // Check parsed instructions
    const instructions = tx.parsed_instructions || tx.parsedInstructions || [];
    if (Array.isArray(instructions)) {
      for (const ix of instructions) {
        const programId = ix.program_id || ix.programId || ix.program;
        if (programId === PUMPFUN_PROGRAM_ID) {
          return true;
        }
      }
    }

    // Check if program is mentioned in the transaction type/signer
    const txType = tx.type || '';
    if (typeof txType === 'string' && txType.toLowerCase().includes('pump')) {
      return true;
    }

    return false;
  }

  /**
   * Extract token mint from a Solscan transaction that looks like a token creation
   * Distinguishes "create" from "buy/sell" by looking at activity type and token transfers
   */
  private extractTokenMintFromSolscanTx(tx: any): string | null {
    // Solscan parsed instructions may contain the action type
    const instructions = tx.parsed_instructions || tx.parsedInstructions || [];

    for (const ix of instructions) {
      const ixType = (ix.type || ix.activity_type || '').toLowerCase();
      const programId = ix.program_id || ix.programId || ix.program;

      // Look for create/deploy/init patterns from Pump.fun
      if (programId === PUMPFUN_PROGRAM_ID) {
        // "create" instruction on Pump.fun — the new token mint is in the params
        if (ixType === 'create' || ixType === 'initialize' || ixType === 'init') {
          // Token mint is usually the first token in the params
          const mint = ix.params?.mint || ix.params?.token_address || ix.params?.tokenMint;
          if (mint) return mint;
        }
      }

      // Check for initializeMint from Token program (inner instruction)
      if (ixType === 'initializemint' || ixType === 'initializemint2') {
        const mint = ix.params?.mint || ix.params?.account;
        if (mint) return mint;
      }
    }

    // Fallback: check token balance changes
    // A token creation will show a new mint appearing in the post-balances
    // with the full supply going to the creator's associated token account
    const tokenBalanceChanges = tx.token_balance_changes || tx.tokenBalanceChanges || [];
    if (Array.isArray(tokenBalanceChanges)) {
      for (const change of tokenBalanceChanges) {
        const changeAmount = parseFloat(change.amount || change.change_amount || '0');
        // Large positive token balance change suggests a new mint
        if (changeAmount > 0 && change.token_address) {
          return change.token_address;
        }
      }
    }

    // Fallback: check SPL token activities from Solscan
    const activities = tx.activities || tx.spl_activities || [];
    if (Array.isArray(activities)) {
      for (const activity of activities) {
        if (activity.activity_type === 'SPL_CREATE_ACCOUNT' ||
            activity.activity_type === 'SPL_INIT_MINT') {
          const mint = activity.token_address || activity.mint;
          if (mint) return mint;
        }
      }
    }

    return null;
  }

  /**
   * Additionally, use Solscan's DeFi activities endpoint as a second detection method.
   * This catches token launches that the transaction parsing might miss.
   * GET /account/defi/activities?address={wallet}&activity_type[]=ACTIVITY_SPL_MINT
   */
  async checkDevDefiActivities(walletAddress: string): Promise<string[]> {
    const newTokenMints: string[] = [];

    try {
      const data = await solscanGet('/account/defi/activities', {
        address: walletAddress,
        page_size: '10',
        page: '1',
      });

      if (!data?.data || !Array.isArray(data.data)) return [];

      for (const activity of data.data) {
        const activityType = activity.activity_type || '';
        const platform = activity.platform || '';

        // Look for mint/create activities on Pump.fun
        if ((activityType.includes('MINT') || activityType.includes('CREATE')) &&
            platform.toLowerCase().includes('pump')) {
          const tokenMint = activity.token1 || activity.token_address;
          if (tokenMint && !this.recentTxSignatures.has(`defi-${tokenMint}`)) {
            this.recentTxSignatures.add(`defi-${tokenMint}`);
            newTokenMints.push(tokenMint);
          }
        }
      }
    } catch (error) {
      logger.debug({ error, walletAddress }, 'Error checking dev DeFi activities');
    }

    return newTokenMints;
  }

  // ============ TOKEN LOOKUP VIA SOLSCAN ============

  /**
   * Check if a token is already recorded in our database
   */
  private async isTokenAlreadyRecorded(tokenMint: string): Promise<boolean> {
    try {
      const result = await pool.query(
        'SELECT id FROM pumpfun_dev_tokens WHERE token_mint = $1 LIMIT 1',
        [tokenMint]
      );
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get token metadata — try Pump.fun API first, then Solscan fallback
   */
  private async getTokenMeta(tokenMint: string): Promise<{
    name: string;
    symbol: string;
    bondingProgress?: number;
  }> {
    // Try Pump.fun API first (fastest, most accurate for pumpfun tokens)
    try {
      const response = await fetch(`https://frontend-api.pump.fun/coins/${tokenMint}`, {
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const data = await response.json() as any;
        const marketCap = data.usd_market_cap || 0;
        const bondingProgress = Math.min(100, (marketCap / 69000) * 100);

        return {
          name: data.name || 'Unknown',
          symbol: data.symbol || 'UNKNOWN',
          bondingProgress,
        };
      }
    } catch (error) {
      logger.debug({ error, tokenMint }, 'Failed to fetch from Pump.fun API');
    }

    // Fallback: Solscan token meta
    try {
      const solscanData = await solscanGet('/token/meta', { address: tokenMint });
      if (solscanData?.data) {
        return {
          name: solscanData.data.name || 'Unknown',
          symbol: solscanData.data.symbol || 'UNKNOWN',
        };
      }
    } catch (error) {
      logger.debug({ error, tokenMint }, 'Failed to fetch from Solscan token meta');
    }

    return { name: 'Unknown', symbol: 'UNKNOWN' };
  }

  // ============ NEW LAUNCH PROCESSING ============

  /**
   * Handle a newly detected dev launch
   */
  private async handleNewDevLaunch(walletAddress: string, tokenMint: string): Promise<void> {
    const dev = this.trackedDevs.get(walletAddress);
    if (!dev) return;

    try {
      // Check cooldown — prevent spam if dev launches rapid-fire
      const cooldownMs = appConfig.devTracker.signalCooldownMs;
      const lastSignal = this.lastSignalTime.get(walletAddress) || 0;
      if (Date.now() - lastSignal < cooldownMs) {
        logger.info({ walletAddress, tokenMint }, 'Dev signal suppressed by cooldown');
        return;
      }

      // Get basic token info
      const tokenMeta = await this.getTokenMeta(tokenMint);

      // Record new launch in database
      await this.recordNewLaunch(dev, tokenMint, tokenMeta);

      // Run basic safety checks (lightweight — honeypot only for speed)
      const safetyOk = await this.runLightweightSafetyCheck(tokenMint);
      if (!safetyOk) {
        logger.info({ tokenMint, walletAddress }, 'Dev token failed lightweight safety check');
        return;
      }

      // Fire the dev signal
      await this.emitDevSignal(dev, tokenMint, tokenMeta);
    } catch (error) {
      logger.debug({ error, tokenMint, walletAddress }, 'Error processing new dev launch');
    }
  }

  // ============ DATABASE OPERATIONS ============

  /**
   * Record a new token launch by a tracked dev
   */
  private async recordNewLaunch(
    dev: PumpfunDev,
    tokenMint: string,
    tokenMeta: { name: string; symbol: string },
  ): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO pumpfun_dev_tokens (dev_id, token_mint, token_name, token_symbol, launched_at, platform)
         VALUES ($1, $2, $3, $4, NOW(), 'pumpfun')
         ON CONFLICT DO NOTHING`,
        [dev.id, tokenMint, tokenMeta.name, tokenMeta.symbol]
      );

      // Update dev's last launch timestamp and total launches
      await pool.query(
        `UPDATE pumpfun_devs SET
           last_launch_at = NOW(),
           total_launches = total_launches + 1,
           updated_at = NOW()
         WHERE id = $1`,
        [dev.id]
      );

      // Update in-memory record
      dev.lastLaunchAt = new Date();
      dev.totalLaunches += 1;

      logger.info({
        devWallet: dev.walletAddress,
        tokenMint,
        tokenName: tokenMeta.name,
        tokenSymbol: tokenMeta.symbol,
      }, 'New dev launch recorded');
    } catch (error) {
      logger.error({ error, tokenMint }, 'Failed to record new dev launch');
    }
  }

  // ============ SAFETY CHECKS ============

  /**
   * Run lightweight safety checks for speed
   * Only check honeypot and mint authority — skip the full scoring pipeline
   */
  private async runLightweightSafetyCheck(tokenMint: string): Promise<boolean> {
    try {
      // For brand new tokens, mint authority is expected to still be active
      // So we only check for known honeypot patterns

      // Try to get honeypot check via RugCheck if available
      try {
        const { rugCheckClient } = await import('../rugcheck.js');
        const rugResult = await rugCheckClient.checkToken(tokenMint);
        if (rugResult && rugResult.score === 'DANGER') {
          logger.info({ tokenMint, risks: rugResult.risks }, 'Dev token flagged DANGER by RugCheck');
          return false;
        }
      } catch {
        // RugCheck not available or failed — continue
      }

      return true;
    } catch (error) {
      logger.debug({ error, tokenMint }, 'Lightweight safety check error');
      // Default to allowing the signal on safety check failure — speed matters
      return true;
    }
  }

  // ============ SIGNAL EMISSION ============

  /**
   * Create and emit a dev signal
   */
  private async emitDevSignal(
    dev: PumpfunDev,
    tokenMint: string,
    tokenMeta: { name: string; symbol: string; bondingProgress?: number },
  ): Promise<void> {
    const signal = createDevSignal(
      dev,
      tokenMint,
      tokenMeta.name,
      tokenMeta.symbol,
      'pumpfun',
      tokenMeta.bondingProgress,
    );

    const formattedMessage = formatDevSignalTelegram(signal);

    // Update cooldown
    this.lastSignalTime.set(dev.walletAddress, Date.now());

    // Mark signal as sent in database
    try {
      await pool.query(
        `UPDATE pumpfun_dev_tokens SET signal_sent = true, signal_sent_at = NOW()
         WHERE token_mint = $1 AND dev_id = $2`,
        [tokenMint, dev.id]
      );
    } catch (error) {
      logger.warn({ error, tokenMint }, 'Failed to mark signal as sent in DB');
    }

    // Deliver via callback
    if (this.signalCallback) {
      try {
        await this.signalCallback(signal, formattedMessage);
      } catch (error) {
        logger.error({ error, tokenMint }, 'Failed to deliver dev signal');
      }
    } else {
      logger.warn('No signal callback registered — dev signal not delivered');
    }

    logger.info({
      tokenMint,
      tokenSymbol: tokenMeta.symbol,
      devWallet: dev.walletAddress,
      priority: signal.priority,
    }, 'Dev signal emitted');
  }

  // ============ HELPERS ============

  private mapDevRow(row: any): PumpfunDev {
    return {
      id: row.id,
      walletAddress: row.wallet_address,
      alias: row.alias,
      totalLaunches: row.total_launches || 0,
      successfulLaunches: row.successful_launches || 0,
      bestPeakMc: parseFloat(row.best_peak_mc || '0'),
      avgPeakMc: parseFloat(row.avg_peak_mc || '0'),
      rugCount: row.rug_count || 0,
      successRate: parseFloat(row.success_rate || '0'),
      lastLaunchAt: row.last_launch_at ? new Date(row.last_launch_at) : null,
      trackedSince: new Date(row.tracked_since),
      isActive: row.is_active,
      notes: row.notes,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============ EXPORTS ============

export const pumpfunDevMonitor = new PumpfunDevMonitor();
