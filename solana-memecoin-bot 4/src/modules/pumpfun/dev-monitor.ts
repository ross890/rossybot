// ===========================================
// MODULE: PUMP.FUN DEV WALLET MONITOR
// Real-time monitoring of tracked dev wallets
// for new token deployments
// ===========================================

import { Connection, PublicKey } from '@solana/web3.js';
import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { createDevSignal, formatDevSignalTelegram } from './dev-signal.js';
import type { PumpfunDev, DevSignal } from '../../types/index.js';

// ============ CONSTANTS ============

const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Poll interval for checking dev wallet activity
// Using polling approach consistent with existing KOL monitor pattern
const POLL_INTERVAL_MS = 15 * 1000; // 15 seconds — fast enough for bonding curve speed

// ============ DEV MONITOR CLASS ============

export class PumpfunDevMonitor {
  private connection: Connection;
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

  constructor() {
    this.connection = new Connection(appConfig.heliusRpcUrl, 'confirmed');
  }

  // ============ INITIALIZATION ============

  /**
   * Initialize: load all active devs from DB
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing Pump.fun Dev Monitor...');

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

    logger.info({ devCount: this.trackedDevs.size }, 'Pump.fun Dev Monitor started');
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

  // ============ POLLING ============

  /**
   * Poll all tracked dev wallets for new transactions
   * Check for token creation transactions
   */
  private async pollDevWallets(): Promise<void> {
    if (!this.isRunning || this.trackedDevs.size === 0) return;

    // Skip if Helius is disabled
    if (appConfig.heliusDisabled) return;

    const wallets = Array.from(this.trackedDevs.keys());

    // Process wallets in batches to respect rate limits
    const batchSize = 5;
    for (let i = 0; i < wallets.length; i += batchSize) {
      const batch = wallets.slice(i, i + batchSize);

      await Promise.all(
        batch.map(wallet => this.checkDevWallet(wallet).catch(error => {
          logger.debug({ error, wallet }, 'Error checking dev wallet');
        }))
      );

      // Brief pause between batches to avoid rate limiting
      if (i + batchSize < wallets.length) {
        await this.sleep(500);
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
   * Check a single dev wallet for recent token creation transactions
   */
  private async checkDevWallet(walletAddress: string): Promise<void> {
    try {
      const pubkey = new PublicKey(walletAddress);

      // Get recent transactions (last few)
      const signatures = await this.connection.getSignaturesForAddress(
        pubkey,
        { limit: 5 },
        'confirmed'
      );

      for (const sigInfo of signatures) {
        // Skip already-processed transactions
        if (this.recentTxSignatures.has(sigInfo.signature)) continue;
        this.recentTxSignatures.add(sigInfo.signature);

        // Skip failed transactions
        if (sigInfo.err) continue;

        // Check if this is a Pump.fun token creation
        await this.handleDevTransaction(walletAddress, sigInfo.signature);
      }
    } catch (error) {
      logger.debug({ error, walletAddress }, 'Error checking dev wallet transactions');
    }
  }

  // ============ TRANSACTION PROCESSING ============

  /**
   * Called when a tracked dev makes a transaction
   * Determine if it's a new token launch
   */
  async handleDevTransaction(walletAddress: string, txSignature: string): Promise<void> {
    const dev = this.trackedDevs.get(walletAddress);
    if (!dev) return;

    try {
      // Parse transaction
      const parsedTx = await this.connection.getParsedTransaction(
        txSignature,
        { maxSupportedTransactionVersion: 0 }
      );

      if (!parsedTx) return;

      // Check if this is a Pump.fun token creation
      if (!this.isPumpfunTokenCreation(parsedTx)) return;

      // Extract the new token mint address
      const tokenMint = this.extractTokenMint(parsedTx);
      if (!tokenMint) return;

      // Check cooldown — prevent spam if dev launches rapid-fire
      const cooldownMs = appConfig.devTracker.signalCooldownMs;
      const lastSignal = this.lastSignalTime.get(walletAddress) || 0;
      if (Date.now() - lastSignal < cooldownMs) {
        logger.info({ walletAddress, tokenMint }, 'Dev signal suppressed by cooldown');
        return;
      }

      // Get basic token info from Pump.fun API
      const tokenMeta = await this.getTokenMeta(tokenMint);

      // Record new launch in database
      await this.recordNewLaunch(dev, tokenMint, tokenMeta);

      // Run basic safety checks (lightweight — honeypot + mint authority only)
      const safetyOk = await this.runLightweightSafetyCheck(tokenMint);
      if (!safetyOk) {
        logger.info({ tokenMint, walletAddress }, 'Dev token failed lightweight safety check');
        return;
      }

      // Fire the dev signal
      await this.emitDevSignal(dev, tokenMint, tokenMeta);
    } catch (error) {
      logger.debug({ error, txSignature, walletAddress }, 'Error processing dev transaction');
    }
  }

  /**
   * Check if a parsed transaction is a Pump.fun token creation
   */
  private isPumpfunTokenCreation(tx: any): boolean {
    try {
      const accountKeys = tx.transaction.message.accountKeys;

      // Check if Pump.fun program is in the transaction
      const hasPumpfun = accountKeys.some((key: any) => {
        const address = typeof key === 'string' ? key : key.pubkey?.toString();
        return address === PUMPFUN_PROGRAM_ID;
      });

      if (!hasPumpfun) return false;

      // Look for token creation patterns in the instructions
      // Pump.fun create instruction typically involves:
      // 1. System program create account
      // 2. Token program initialize mint
      // 3. Pump.fun program create instruction
      const instructions = tx.transaction.message.instructions || [];
      const innerInstructions = tx.meta?.innerInstructions || [];

      // Check main instructions for Pump.fun program
      const hasPumpfunInstruction = instructions.some((ix: any) => {
        const programId = typeof ix.programId === 'string'
          ? ix.programId
          : ix.programId?.toString();
        return programId === PUMPFUN_PROGRAM_ID;
      });

      if (!hasPumpfunInstruction) return false;

      // Check for token mint initialization in inner instructions
      // This distinguishes "create" from "buy/sell" operations
      const hasInitMint = innerInstructions.some((group: any) =>
        group.instructions?.some((ix: any) => {
          if (ix.parsed?.type === 'initializeMint' || ix.parsed?.type === 'initializeMint2') {
            return true;
          }
          return false;
        })
      );

      // Also check if there's a createAccount instruction in inner instructions
      const hasCreateAccount = innerInstructions.some((group: any) =>
        group.instructions?.some((ix: any) => {
          if (ix.parsed?.type === 'createAccount') {
            return true;
          }
          return false;
        })
      );

      return hasInitMint || hasCreateAccount;
    } catch (error) {
      logger.debug({ error }, 'Error checking if Pump.fun token creation');
      return false;
    }
  }

  /**
   * Extract the token mint address from a Pump.fun create transaction
   */
  private extractTokenMint(tx: any): string | null {
    try {
      const innerInstructions = tx.meta?.innerInstructions || [];

      // Look for initializeMint instruction — the mint address is the account being initialized
      for (const group of innerInstructions) {
        for (const ix of group.instructions || []) {
          if (ix.parsed?.type === 'initializeMint' || ix.parsed?.type === 'initializeMint2') {
            // The mint address is in the info
            const mint = ix.parsed?.info?.mint;
            if (mint) return mint;
          }
        }
      }

      // Fallback: look at post-token balances for new mints
      const postTokenBalances = tx.meta?.postTokenBalances || [];
      if (postTokenBalances.length > 0) {
        // The first token balance entry often has the new mint
        return postTokenBalances[0]?.mint || null;
      }

      return null;
    } catch (error) {
      logger.debug({ error }, 'Error extracting token mint');
      return null;
    }
  }

  // ============ TOKEN METADATA ============

  /**
   * Get basic token metadata from Pump.fun API
   */
  private async getTokenMeta(tokenMint: string): Promise<{
    name: string;
    symbol: string;
    bondingProgress?: number;
  }> {
    try {
      const response = await fetch(`https://frontend-api.pump.fun/coins/${tokenMint}`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { name: 'Unknown', symbol: 'UNKNOWN' };
      }

      const data = await response.json() as any;

      const marketCap = data.usd_market_cap || 0;
      const bondingProgress = Math.min(100, (marketCap / 69000) * 100);

      return {
        name: data.name || 'Unknown',
        symbol: data.symbol || 'UNKNOWN',
        bondingProgress,
      };
    } catch (error) {
      logger.debug({ error, tokenMint }, 'Failed to fetch token meta from Pump.fun');
      return { name: 'Unknown', symbol: 'UNKNOWN' };
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
