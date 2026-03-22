import { v4 as uuid } from 'uuid';
import { logger } from '../../utils/logger.js';
import { query, getMany, getOne } from '../../db/database.js';
import { config } from '../../config/index.js';
import { PositionStatus } from '../../types/index.js';
import { fetchDexPair, getPriceUsd } from '../validation/dexscreener.js';
import type { SwapExecutor, SwapResult } from '../trading/swap-executor.js';
import type { GradSignal } from './graduation-discovery.js';

/**
 * A position opened on a freshly graduated pump.fun token.
 * These use the dip/recovery strategy — NOT the bonding curve scalp strategy.
 *
 * Key differences from PumpFunPosition:
 * - Entry is AFTER graduation (token is on PumpSwap/Raydium, not bonding curve)
 * - Uses DexScreener USD prices for tracking (not curve SOL balance)
 * - Longer hold times expected (minutes to hours, not seconds)
 * - Trailing stop + time-based exits
 */
export interface GraduatedPosition {
  id: string;
  token_address: string;
  token_symbol: string | null;
  pair_address: string | null;
  /** SOL spent on entry */
  entry_sol: number;
  /** USD price at entry */
  entry_price_usd: number;
  entry_time: Date;
  status: PositionStatus;
  /** USD price at graduation (reference point for dip %) */
  graduation_price_usd: number;
  /** How far the token dipped from graduation before we entered */
  dip_pct: number;
  /** Recovery % from bottom when we entered */
  recovery_at_entry: number;
  /** Time between graduation and our entry */
  time_to_entry_mins: number;
  /** Buy ratio at entry (fraction of txns that are buys) */
  buy_ratio_at_entry: number;
  /** Current tracking */
  current_price_usd: number;
  peak_price_usd: number;
  pnl_percent: number;
  /** Trailing stop: highest PnL seen (for drawdown calculation) */
  peak_pnl_percent: number;
  /** Exit info */
  exit_reason: string | null;
  closed_at: Date | null;
  hold_time_mins: number | null;
  entry_tx: string | null;
  fees_paid_sol: number;
  net_pnl_sol: number;
  sell_retry_count: number;
}

export class GraduatedTracker {
  private positions = new Map<string, GraduatedPosition>();
  private pendingEntries = new Set<string>();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private onPositionClosed: ((pos: GraduatedPosition) => void) | null = null;
  private onSwapFailed: ((tokenSymbol: string, error: string, type: 'BUY' | 'SELL') => void) | null = null;
  private onBalanceRefresh: (() => Promise<void>) | null = null;
  private swapExecutor: SwapExecutor | null = null;
  private pendingSells = new Set<string>();

  private sessionStats = {
    trades: 0,
    wins: 0,
    totalPnlSol: 0,
    totalFeesSol: 0,
    startedAt: new Date(),
  };

  private get cfg() {
    return config.graduationDiscovery;
  }

  get isLive(): boolean {
    return this.swapExecutor !== null;
  }

  setSwapExecutor(executor: SwapExecutor): void {
    this.swapExecutor = executor;
    logger.info('Graduated tracker: LIVE trading enabled via SwapExecutor');
  }

  setCloseCallback(cb: (pos: GraduatedPosition) => void): void {
    this.onPositionClosed = cb;
  }

  setSwapFailedCallback(cb: (tokenSymbol: string, error: string, type: 'BUY' | 'SELL') => void): void {
    this.onSwapFailed = cb;
  }

  setBalanceRefreshCallback(cb: () => Promise<void>): void {
    this.onBalanceRefresh = cb;
  }

  start(): void {
    this.checkInterval = setInterval(() => this.checkPositions(), config.dexScreener.priceCheckIntervalMs);
    logger.info({
      mode: this.isLive ? 'LIVE' : 'SHADOW',
      maxPositions: this.cfg.maxPositions,
    }, 'Graduated position tracker started');
  }

  stop(): void {
    if (this.checkInterval) { clearInterval(this.checkInterval); this.checkInterval = null; }
  }

  getSessionStats() {
    return {
      ...this.sessionStats,
      winRate: this.sessionStats.trades > 0 ? this.sessionStats.wins / this.sessionStats.trades : 0,
    };
  }

  /**
   * Open a position on a freshly graduated token based on a GradSignal.
   */
  async openPosition(signal: GradSignal, solAmount: number): Promise<GraduatedPosition | null> {
    if (this.pendingEntries.has(signal.mint)) {
      logger.info({ token: signal.mint.slice(0, 8) }, 'Graduated skip — entry already in progress');
      return null;
    }
    this.pendingEntries.add(signal.mint);

    try {
      return await this._executeOpen(signal, solAmount);
    } finally {
      this.pendingEntries.delete(signal.mint);
    }
  }

  private async _executeOpen(signal: GradSignal, solAmount: number): Promise<GraduatedPosition | null> {
    let entryTx: string | null = null;
    let feesSol = 0;

    // LIVE MODE: execute real buy
    if (this.swapExecutor) {
      const tokenName = signal.symbol || signal.mint.slice(0, 8);
      logger.info({ token: tokenName, sizeSol: solAmount }, 'Graduated LIVE BUY — executing swap');

      const result = await this.swapExecutor.buyToken(
        signal.mint,
        solAmount,
        signal.liquidity, // Use actual liquidity for slippage calc
      );

      if (!result.success) {
        logger.error({ error: result.error, token: tokenName }, 'Graduated BUY swap failed');
        this.onSwapFailed?.(tokenName, result.error || 'Unknown error', 'BUY');
        return null;
      }

      entryTx = result.txSignature;
      feesSol = result.feesSol;

      logger.info({
        token: tokenName,
        tx: result.txSignature?.slice(0, 16),
        fees: feesSol.toFixed(6),
      }, 'Graduated LIVE BUY executed');

      if (this.onBalanceRefresh) {
        try { await this.onBalanceRefresh(); } catch { /* ignore */ }
      }
    }

    const pos: GraduatedPosition = {
      id: uuid(),
      token_address: signal.mint,
      token_symbol: signal.symbol,
      pair_address: signal.pairAddress,
      entry_sol: solAmount,
      entry_price_usd: signal.entryPriceUsd,
      entry_time: new Date(),
      status: PositionStatus.OPEN,
      graduation_price_usd: signal.graduationPriceUsd,
      dip_pct: signal.dipPct,
      recovery_at_entry: signal.recoveryPct,
      time_to_entry_mins: signal.timeSinceGradMins,
      buy_ratio_at_entry: signal.buyRatio,
      current_price_usd: signal.entryPriceUsd,
      peak_price_usd: signal.entryPriceUsd,
      pnl_percent: 0,
      peak_pnl_percent: 0,
      exit_reason: null,
      closed_at: null,
      hold_time_mins: null,
      entry_tx: entryTx,
      fees_paid_sol: feesSol,
      net_pnl_sol: -feesSol,
      sell_retry_count: 0,
    };

    this.positions.set(pos.id, pos);

    // Persist to DB
    await query(
      `INSERT INTO graduated_positions (id, token_address, token_symbol, pair_address,
         entry_sol, entry_price_usd, entry_time, status, graduation_price_usd,
         dip_pct, recovery_at_entry, time_to_entry_mins, buy_ratio_at_entry,
         current_price_usd, peak_price_usd, pnl_percent, peak_pnl_percent,
         entry_tx, fees_paid_sol, net_pnl_sol)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [pos.id, pos.token_address, pos.token_symbol, pos.pair_address,
       pos.entry_sol, pos.entry_price_usd, pos.entry_time, pos.status,
       pos.graduation_price_usd, pos.dip_pct, pos.recovery_at_entry,
       pos.time_to_entry_mins, pos.buy_ratio_at_entry,
       pos.current_price_usd, pos.peak_price_usd, pos.pnl_percent, pos.peak_pnl_percent,
       pos.entry_tx, pos.fees_paid_sol, pos.net_pnl_sol],
    );

    logger.info({
      id: pos.id.slice(0, 8),
      token: pos.token_symbol || pos.token_address.slice(0, 8),
      entryPrice: `$${pos.entry_price_usd.toFixed(6)}`,
      dip: `${(pos.dip_pct * 100).toFixed(0)}%`,
      recovery: `${(pos.recovery_at_entry * 100).toFixed(0)}%`,
      sol: pos.entry_sol.toFixed(4),
      mode: this.isLive ? 'LIVE' : 'SHADOW',
    }, 'Graduated position opened');

    return pos;
  }

  private async checkPositions(): Promise<void> {
    for (const pos of this.positions.values()) {
      if (pos.status === PositionStatus.CLOSED) continue;
      try {
        await this.checkPosition(pos);
      } catch (err) {
        logger.error({ err, posId: pos.id.slice(0, 8) }, 'Graduated position check failed');
      }
    }
  }

  private async checkPosition(pos: GraduatedPosition): Promise<void> {
    const cfg = this.cfg;
    const holdMins = (Date.now() - pos.entry_time.getTime()) / 60_000;

    // Fetch current price from DexScreener
    const dexData = await fetchDexPair(pos.token_address);
    if (!dexData) return;

    const priceUsd = getPriceUsd(dexData);
    if (priceUsd <= 0) return;

    pos.current_price_usd = priceUsd;
    if (priceUsd > pos.peak_price_usd) {
      pos.peak_price_usd = priceUsd;
    }

    // Calculate PnL
    pos.pnl_percent = pos.entry_price_usd > 0
      ? (priceUsd - pos.entry_price_usd) / pos.entry_price_usd
      : 0;

    if (pos.pnl_percent > pos.peak_pnl_percent) {
      pos.peak_pnl_percent = pos.pnl_percent;
    }

    // --- EXIT RULES (priority order) ---

    // 1. Hard kill — emergency exit on deep loss
    if (pos.pnl_percent <= cfg.hardKill) {
      await this.closePosition(pos, `Hard kill (${(pos.pnl_percent * 100).toFixed(0)}%)`);
      return;
    }

    // 2. Stop loss
    if (holdMins >= 1 && pos.pnl_percent <= cfg.stopLoss) {
      await this.closePosition(pos, `Stop loss (${(pos.pnl_percent * 100).toFixed(0)}%)`);
      return;
    }

    // 3. Take profit — graduated tokens can run, but take profit at target
    if (pos.pnl_percent >= cfg.profitTarget) {
      await this.closePosition(pos, `Take profit (${(pos.pnl_percent * 100).toFixed(0)}%)`);
      return;
    }

    // 4. Trailing stop — protect gains once we're above trailing activation threshold
    if (pos.peak_pnl_percent >= cfg.trailingActivationPct) {
      const drawdownFromPeak = pos.peak_pnl_percent - pos.pnl_percent;
      if (drawdownFromPeak >= cfg.trailingStopPct) {
        await this.closePosition(pos,
          `Trailing stop (peak +${(pos.peak_pnl_percent * 100).toFixed(0)}% → now +${(pos.pnl_percent * 100).toFixed(0)}%)`);
        return;
      }
    }

    // 5. Hard time limit
    if (holdMins >= cfg.hardTimeHours * 60) {
      await this.closePosition(pos, `Time limit (${holdMins.toFixed(0)}min)`);
      return;
    }

    // 6. Time-based tightening: if still losing after N minutes, cut
    if (holdMins >= cfg.staleTimeMins && pos.pnl_percent <= 0) {
      await this.closePosition(pos, `Stale position (${holdMins.toFixed(0)}min, ${(pos.pnl_percent * 100).toFixed(1)}%)`);
      return;
    }

    await this.updatePosition(pos);
  }

  private async closePosition(pos: GraduatedPosition, reason: string): Promise<void> {
    if (this.pendingSells.has(pos.id)) return;
    if (pos.status === PositionStatus.CLOSED) return;
    this.pendingSells.add(pos.id);

    try {
      // LIVE MODE: execute sell
      if (this.swapExecutor) {
        const tokenName = pos.token_symbol || pos.token_address.slice(0, 8);
        logger.info({ token: tokenName, reason }, 'Graduated LIVE SELL — executing swap');

        const dexData = await fetchDexPair(pos.token_address);
        const liquidityUsd = dexData?.liquidity?.usd || 0;
        const slippageBps = config.jupiter.thinLiquiditySlippageBps + (pos.sell_retry_count * 200);

        const result = await this.swapExecutor.sellToken(
          pos.token_address, liquidityUsd, 100, Math.min(slippageBps, 1500),
        );

        if (!result.success) {
          const errorMsg = result.error || 'Unknown';
          const isNoBalance = errorMsg.includes('No token balance') || errorMsg.includes('amount is zero');

          if (isNoBalance) {
            pos.net_pnl_sol = -pos.entry_sol - pos.fees_paid_sol;
            pos.pnl_percent = -1;
          } else {
            pos.sell_retry_count++;
            if (pos.sell_retry_count >= 5) {
              logger.error({ token: tokenName, retries: pos.sell_retry_count }, 'Graduated SELL failed after max retries');
              this.onSwapFailed?.(tokenName, `${errorMsg} (gave up after 5 retries)`, 'SELL');
              pos.net_pnl_sol = -pos.entry_sol - pos.fees_paid_sol;
              pos.pnl_percent = -1;
            } else {
              if (pos.sell_retry_count === 1) this.onSwapFailed?.(tokenName, errorMsg, 'SELL');
              return;
            }
          }
        } else {
          const solReceived = result.outputAmount / 1e9;
          pos.fees_paid_sol += result.feesSol;
          pos.net_pnl_sol = solReceived - pos.entry_sol - pos.fees_paid_sol;
          pos.pnl_percent = pos.entry_sol > 0 ? (solReceived - pos.entry_sol) / pos.entry_sol : 0;
        }
      } else {
        // Shadow mode
        pos.net_pnl_sol = pos.entry_sol * pos.pnl_percent;
      }

      pos.status = PositionStatus.CLOSED;
      pos.exit_reason = reason;
      pos.closed_at = new Date();
      pos.hold_time_mins = Math.round((pos.closed_at.getTime() - pos.entry_time.getTime()) / 60_000);

      this.sessionStats.trades++;
      if (pos.pnl_percent > 0) this.sessionStats.wins++;
      this.sessionStats.totalPnlSol += pos.net_pnl_sol;
      this.sessionStats.totalFeesSol += pos.fees_paid_sol;

      await this.updatePosition(pos);

      logger.info({
        id: pos.id.slice(0, 8),
        token: pos.token_symbol || pos.token_address.slice(0, 8),
        pnl: `${(pos.pnl_percent * 100).toFixed(1)}%`,
        holdMins: pos.hold_time_mins,
        reason,
        mode: this.isLive ? 'LIVE' : 'SHADOW',
      }, 'Graduated position CLOSED');

      this.onPositionClosed?.(pos);
      this.positions.delete(pos.id);

      if (this.swapExecutor && this.onBalanceRefresh) {
        try { await this.onBalanceRefresh(); } catch { /* ignore */ }
      }
    } finally {
      this.pendingSells.delete(pos.id);
    }
  }

  async forceClose(tokenIdentifier: string): Promise<{ success: boolean; token?: string; error?: string }> {
    const match = Array.from(this.positions.values()).find((p) =>
      p.status !== PositionStatus.CLOSED &&
      (p.token_symbol?.toLowerCase() === tokenIdentifier.toLowerCase() ||
       p.token_address.toLowerCase().startsWith(tokenIdentifier.toLowerCase())),
    );

    if (!match) return { success: false, error: `No open graduated position found for "${tokenIdentifier}"` };
    await this.closePosition(match, 'Force close (/kill)');
    return { success: true, token: match.token_symbol || match.token_address.slice(0, 8) };
  }

  private async updatePosition(pos: GraduatedPosition): Promise<void> {
    try {
      await query(
        `UPDATE graduated_positions SET
           status = $1, current_price_usd = $2, peak_price_usd = $3,
           pnl_percent = $4, peak_pnl_percent = $5,
           exit_reason = $6, closed_at = $7, hold_time_mins = $8,
           fees_paid_sol = $9, net_pnl_sol = $10
         WHERE id = $11`,
        [pos.status, pos.current_price_usd, pos.peak_price_usd,
         pos.pnl_percent, pos.peak_pnl_percent,
         pos.exit_reason, pos.closed_at, pos.hold_time_mins,
         pos.fees_paid_sol, pos.net_pnl_sol, pos.id],
      );
    } catch (err) {
      logger.error({ err, posId: pos.id.slice(0, 8) }, 'Failed to update graduated position');
    }
  }

  async loadOpenPositions(): Promise<void> {
    try {
      const rows = await getMany<Record<string, unknown>>(
        `SELECT * FROM graduated_positions WHERE status = 'OPEN'`,
      );

      for (const row of rows) {
        const pos: GraduatedPosition = {
          id: row.id as string,
          token_address: row.token_address as string,
          token_symbol: row.token_symbol as string | null,
          pair_address: row.pair_address as string | null,
          entry_sol: Number(row.entry_sol),
          entry_price_usd: Number(row.entry_price_usd),
          entry_time: new Date(row.entry_time as string),
          status: PositionStatus.OPEN,
          graduation_price_usd: Number(row.graduation_price_usd),
          dip_pct: Number(row.dip_pct),
          recovery_at_entry: Number(row.recovery_at_entry),
          time_to_entry_mins: Number(row.time_to_entry_mins),
          buy_ratio_at_entry: Number(row.buy_ratio_at_entry),
          current_price_usd: Number(row.current_price_usd),
          peak_price_usd: Number(row.peak_price_usd),
          pnl_percent: Number(row.pnl_percent || 0),
          peak_pnl_percent: Number(row.peak_pnl_percent || 0),
          exit_reason: null,
          closed_at: null,
          hold_time_mins: null,
          entry_tx: (row.entry_tx as string) || null,
          fees_paid_sol: Number(row.fees_paid_sol || 0),
          net_pnl_sol: Number(row.net_pnl_sol || 0),
          sell_retry_count: 0,
        };
        this.positions.set(pos.id, pos);
      }

      logger.info({ count: this.positions.size }, 'Loaded open graduated positions');
    } catch {
      logger.info('No graduated_positions table found (will be created on first migration)');
    }
  }

  getOpenPositions(): GraduatedPosition[] {
    return Array.from(this.positions.values()).filter((p) => p.status === PositionStatus.OPEN);
  }

  hasPosition(tokenMint: string): boolean {
    return Array.from(this.positions.values()).some(
      (p) => p.token_address === tokenMint && p.status !== PositionStatus.CLOSED,
    );
  }

  getOpenCount(): number {
    return this.getOpenPositions().length;
  }
}
