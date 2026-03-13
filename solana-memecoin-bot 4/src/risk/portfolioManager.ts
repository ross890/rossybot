// ===========================================
// MODULE: PORTFOLIO MANAGER
// Max concurrent positions, signal queue, and circuit breakers
// Phase 3.1 — prevents correlated blowups
// ===========================================

import { logger } from '../utils/logger.js';
import { pool } from '../utils/database.js';
import { appConfig } from '../config/index.js';

// ============ TYPES ============

export interface PositionLimitResult {
  allowed: boolean;
  reason?: string;
}

export interface QueuedSignal {
  id: string;
  tokenAddress: string;
  tokenTicker: string;
  score: number;
  queuedAt: number;
  expiresAt: number;
}

export type CircuitBreakerState = 'ACTIVE' | 'HALTED_24H' | 'HALTED_MANUAL';

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  haltedAt: Date | null;
  resumeAt: Date | null;
  reason: string | null;
  drawdown24h: number;
  drawdown3d: number;
}

// ============ CONFIGURATION ============

const CONFIG = {
  // Position limits
  MAX_CONCURRENT_POSITIONS: 8,
  MAX_POSITIONS_PER_HOUR: 4,
  MAX_PORTFOLIO_ALLOCATION_PERCENT: 20,

  // Correlation guard
  MAX_ENTRIES_IN_30_MIN: 3,

  // Signal queue
  MAX_QUEUE_SIZE: 10,
  QUEUE_EXPIRY_MS: 15 * 60 * 1000, // 15 minutes

  // Circuit breakers
  DRAWDOWN_24H_HALT_PERCENT: -5,     // -5% → 6-hour halt
  DRAWDOWN_3D_HALT_PERCENT: -10,     // -10% → manual resume required
  AUTO_HALT_DURATION_MS: 6 * 60 * 60 * 1000, // 6 hours

  // Bankroll tracking
  BANKROLL_UPDATE_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
} as const;

// ============ PORTFOLIO MANAGER CLASS ============

export class PortfolioManager {
  // Position tracking
  private openPositionCount = 0;
  private recentEntries: number[] = []; // timestamps of recent entries

  // Signal queue (priority queue by score, max 10, 15-min expiry)
  private signalQueue: QueuedSignal[] = [];

  // Circuit breaker state
  private circuitState: CircuitBreakerState = 'ACTIVE';
  private haltedAt: Date | null = null;
  private resumeAt: Date | null = null;
  private haltReason: string | null = null;

  // Bankroll tracking
  private currentBankroll = 0;
  private bankroll24hAgo = 0;
  private bankroll3dAgo = 0;
  private totalAllocated = 0;

  // Callback for Telegram notifications
  private notifyCallback: ((message: string) => Promise<void>) | null = null;

  // ============ INITIALIZATION ============

  async initialize(): Promise<void> {
    await this.syncPositionCount();
    await this.loadBankrollSnapshots();
    logger.info({
      openPositions: this.openPositionCount,
      circuitState: this.circuitState,
    }, 'Portfolio manager initialized');
  }

  /**
   * Set notification callback (for Telegram alerts)
   */
  onNotify(callback: (message: string) => Promise<void>): void {
    this.notifyCallback = callback;
  }

  // ============ POSITION LIMIT CHECKS ============

  /**
   * Check if a new position can be opened.
   * Returns { allowed, reason } — never throws.
   */
  canOpenPosition(newPositionSizePercent: number): PositionLimitResult {
    // Circuit breaker check
    if (this.circuitState !== 'ACTIVE') {
      if (this.circuitState === 'HALTED_24H' && this.resumeAt) {
        if (Date.now() < this.resumeAt.getTime()) {
          return {
            allowed: false,
            reason: `Circuit breaker active: ${this.haltReason}. Resumes at ${this.resumeAt.toISOString()}`,
          };
        }
        // Auto-resume
        this.circuitState = 'ACTIVE';
        this.haltedAt = null;
        this.resumeAt = null;
        this.haltReason = null;
        logger.info('Circuit breaker auto-resumed after 6-hour halt');
      } else {
        return {
          allowed: false,
          reason: `Circuit breaker active (manual resume required): ${this.haltReason}`,
        };
      }
    }

    // Hard concurrent limit
    if (this.openPositionCount >= CONFIG.MAX_CONCURRENT_POSITIONS) {
      return {
        allowed: false,
        reason: `Max concurrent positions reached (${this.openPositionCount}/${CONFIG.MAX_CONCURRENT_POSITIONS})`,
      };
    }

    // Hourly rate limit
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const lastHourEntries = this.recentEntries.filter(t => t > oneHourAgo).length;
    if (lastHourEntries >= CONFIG.MAX_POSITIONS_PER_HOUR) {
      return {
        allowed: false,
        reason: `Hourly position limit reached (${lastHourEntries}/${CONFIG.MAX_POSITIONS_PER_HOUR})`,
      };
    }

    // Portfolio allocation cap
    if (this.totalAllocated + newPositionSizePercent > CONFIG.MAX_PORTFOLIO_ALLOCATION_PERCENT) {
      return {
        allowed: false,
        reason: `Portfolio allocation cap would be exceeded (${(this.totalAllocated + newPositionSizePercent).toFixed(1)}% > ${CONFIG.MAX_PORTFOLIO_ALLOCATION_PERCENT}%)`,
      };
    }

    // Correlation guard: 3+ entries in 30-min window
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    const last30minEntries = this.recentEntries.filter(t => t > thirtyMinAgo).length;
    if (last30minEntries >= CONFIG.MAX_ENTRIES_IN_30_MIN) {
      return {
        allowed: false,
        reason: `Correlation guard: ${last30minEntries} entries in last 30 min (max ${CONFIG.MAX_ENTRIES_IN_30_MIN})`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a new position entry.
   */
  recordEntry(positionSizePercent: number): void {
    this.openPositionCount++;
    this.totalAllocated += positionSizePercent;
    this.recentEntries.push(Date.now());

    // Clean old entries (keep last 2 hours)
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    this.recentEntries = this.recentEntries.filter(t => t > twoHoursAgo);
  }

  /**
   * Record a position close. Dequeue pending signals if space opens up.
   */
  async recordClose(positionSizePercent: number): Promise<QueuedSignal | null> {
    this.openPositionCount = Math.max(0, this.openPositionCount - 1);
    this.totalAllocated = Math.max(0, this.totalAllocated - positionSizePercent);

    // Try to dequeue a signal
    return this.dequeueSignal();
  }

  // ============ SIGNAL QUEUE ============

  /**
   * Queue a signal that was blocked by position limits.
   * Priority queue by score, max 10, 15-min expiry.
   */
  queueSignal(signal: QueuedSignal): boolean {
    // Remove expired signals
    this.cleanQueue();

    // Check queue size
    if (this.signalQueue.length >= CONFIG.MAX_QUEUE_SIZE) {
      // Replace lowest-score signal if new one is better
      const lowestIdx = this.signalQueue.reduce(
        (minIdx, s, idx) => s.score < this.signalQueue[minIdx].score ? idx : minIdx,
        0
      );
      if (signal.score > this.signalQueue[lowestIdx].score) {
        this.signalQueue.splice(lowestIdx, 1);
      } else {
        return false; // Queue full, new signal isn't good enough
      }
    }

    this.signalQueue.push({
      ...signal,
      queuedAt: Date.now(),
      expiresAt: Date.now() + CONFIG.QUEUE_EXPIRY_MS,
    });

    // Sort by score descending
    this.signalQueue.sort((a, b) => b.score - a.score);

    logger.info({
      token: signal.tokenTicker,
      score: signal.score,
      queueSize: this.signalQueue.length,
    }, 'Signal queued');

    return true;
  }

  /**
   * Dequeue the highest-priority signal that's still fresh.
   */
  private dequeueSignal(): QueuedSignal | null {
    this.cleanQueue();

    if (this.signalQueue.length === 0) return null;

    const signal = this.signalQueue.shift()!;
    logger.info({
      token: signal.tokenTicker,
      score: signal.score,
      queuedAgoMs: Date.now() - signal.queuedAt,
    }, 'Signal dequeued for re-evaluation');

    return signal;
  }

  /**
   * Remove expired signals from queue.
   */
  private cleanQueue(): void {
    const now = Date.now();
    this.signalQueue = this.signalQueue.filter(s => s.expiresAt > now);
  }

  /**
   * Get current queue status.
   */
  getQueueStatus(): { size: number; signals: QueuedSignal[] } {
    this.cleanQueue();
    return {
      size: this.signalQueue.length,
      signals: [...this.signalQueue],
    };
  }

  // ============ CIRCUIT BREAKERS ============

  /**
   * Check drawdown levels and trigger circuit breakers if needed.
   * Call this periodically (every 5 minutes).
   */
  async checkCircuitBreakers(): Promise<void> {
    if (this.circuitState !== 'ACTIVE') return;

    const drawdown24h = this.calculateDrawdown24h();
    const drawdown3d = this.calculateDrawdown3d();

    // 3-day drawdown check (more severe — manual resume)
    if (drawdown3d <= CONFIG.DRAWDOWN_3D_HALT_PERCENT) {
      this.circuitState = 'HALTED_MANUAL';
      this.haltedAt = new Date();
      this.resumeAt = null; // No auto-resume
      this.haltReason = `3-day drawdown ${drawdown3d.toFixed(1)}% exceeds -10% threshold`;

      const message = [
        '🔴🔴 *EXTENDED HALT — MANUAL RESUME REQUIRED*',
        '',
        `3-day drawdown: ${drawdown3d.toFixed(1)}%`,
        `Current bankroll: ${this.currentBankroll.toFixed(2)} SOL`,
        '',
        'Trading halted until manual /resume\\_trading command.',
      ].join('\n');

      await this.notify(message);
      logger.error({ drawdown3d }, 'CIRCUIT BREAKER: 3-day halt triggered — manual resume required');
      return;
    }

    // 24-hour drawdown check (auto-resume after 6 hours)
    if (drawdown24h <= CONFIG.DRAWDOWN_24H_HALT_PERCENT) {
      this.circuitState = 'HALTED_24H';
      this.haltedAt = new Date();
      this.resumeAt = new Date(Date.now() + CONFIG.AUTO_HALT_DURATION_MS);
      this.haltReason = `24h drawdown ${drawdown24h.toFixed(1)}% exceeds -5% threshold`;

      const message = [
        '🔴 *CIRCUIT BREAKER — 6-HOUR HALT*',
        '',
        `24h drawdown: ${drawdown24h.toFixed(1)}%`,
        `Current bankroll: ${this.currentBankroll.toFixed(2)} SOL`,
        `Resumes at: ${this.resumeAt.toISOString()}`,
        '',
        'Use /resume\\_trading to override.',
      ].join('\n');

      await this.notify(message);
      logger.warn({ drawdown24h }, 'CIRCUIT BREAKER: 6-hour halt triggered');
    }
  }

  /**
   * Manual resume — overrides any circuit breaker.
   */
  resumeTrading(): void {
    const previousState = this.circuitState;
    this.circuitState = 'ACTIVE';
    this.haltedAt = null;
    this.resumeAt = null;
    this.haltReason = null;

    logger.info({ previousState }, 'Trading manually resumed');
  }

  /**
   * Get circuit breaker status.
   */
  getCircuitBreakerStatus(): CircuitBreakerStatus {
    return {
      state: this.circuitState,
      haltedAt: this.haltedAt,
      resumeAt: this.resumeAt,
      reason: this.haltReason,
      drawdown24h: this.calculateDrawdown24h(),
      drawdown3d: this.calculateDrawdown3d(),
    };
  }

  // ============ BANKROLL TRACKING ============

  /**
   * Update current bankroll value.
   */
  updateBankroll(currentSol: number): void {
    this.currentBankroll = currentSol;
  }

  /**
   * Snapshot bankroll for drawdown calculations.
   * Called periodically to maintain rolling windows.
   */
  async snapshotBankroll(): Promise<void> {
    if (this.currentBankroll <= 0) return;

    try {
      await pool.query(`
        INSERT INTO bankroll_snapshots (bankroll_sol, snapshot_time)
        VALUES ($1, NOW())
      `, [this.currentBankroll]);
    } catch (error) {
      logger.debug({ error }, 'Failed to snapshot bankroll (table may not exist)');
    }
  }

  private calculateDrawdown24h(): number {
    if (this.bankroll24hAgo <= 0) return 0;
    return ((this.currentBankroll - this.bankroll24hAgo) / this.bankroll24hAgo) * 100;
  }

  private calculateDrawdown3d(): number {
    if (this.bankroll3dAgo <= 0) return 0;
    return ((this.currentBankroll - this.bankroll3dAgo) / this.bankroll3dAgo) * 100;
  }

  // ============ STATE SYNC ============

  /**
   * Sync open position count from database.
   */
  private async syncPositionCount(): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'`
      );
      this.openPositionCount = parseInt(result.rows[0]?.count || '0');
    } catch {
      // Positions table may not exist in learning mode
      this.openPositionCount = 0;
    }
  }

  /**
   * Load bankroll snapshots for drawdown calculations.
   */
  private async loadBankrollSnapshots(): Promise<void> {
    try {
      // Ensure table exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bankroll_snapshots (
          id SERIAL PRIMARY KEY,
          bankroll_sol DECIMAL(20,8) NOT NULL,
          snapshot_time TIMESTAMP DEFAULT NOW()
        )
      `);

      // Get 24h ago bankroll
      const result24h = await pool.query(`
        SELECT bankroll_sol FROM bankroll_snapshots
        WHERE snapshot_time <= NOW() - INTERVAL '24 hours'
        ORDER BY snapshot_time DESC LIMIT 1
      `);
      if (result24h.rows.length > 0) {
        this.bankroll24hAgo = parseFloat(result24h.rows[0].bankroll_sol);
      }

      // Get 3d ago bankroll
      const result3d = await pool.query(`
        SELECT bankroll_sol FROM bankroll_snapshots
        WHERE snapshot_time <= NOW() - INTERVAL '3 days'
        ORDER BY snapshot_time DESC LIMIT 1
      `);
      if (result3d.rows.length > 0) {
        this.bankroll3dAgo = parseFloat(result3d.rows[0].bankroll_sol);
      }
    } catch (error) {
      logger.debug({ error }, 'Failed to load bankroll snapshots');
    }
  }

  // ============ STATUS ============

  /**
   * Get comprehensive portfolio status.
   */
  getStatus(): {
    openPositions: number;
    maxPositions: number;
    totalAllocated: number;
    circuitBreaker: CircuitBreakerStatus;
    queue: { size: number; signals: QueuedSignal[] };
  } {
    return {
      openPositions: this.openPositionCount,
      maxPositions: CONFIG.MAX_CONCURRENT_POSITIONS,
      totalAllocated: this.totalAllocated,
      circuitBreaker: this.getCircuitBreakerStatus(),
      queue: this.getQueueStatus(),
    };
  }

  // ============ HELPERS ============

  private async notify(message: string): Promise<void> {
    if (this.notifyCallback) {
      try {
        await this.notifyCallback(message);
      } catch (error) {
        logger.error({ error }, 'Failed to send portfolio manager notification');
      }
    }
  }
}

// ============ EXPORTS ============

export const portfolioManager = new PortfolioManager();

export default {
  PortfolioManager,
  portfolioManager,
  CONFIG,
};
