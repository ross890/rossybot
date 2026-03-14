import { v4 as uuid } from 'uuid';
import { logger } from '../../utils/logger.js';
import { query, getMany, getOne } from '../../db/database.js';
import { config } from '../../config/index.js';
import { CapitalTier, PositionStatus, type TierConfig, type ShadowPosition } from '../../types/index.js';
import { fetchDexPair, getPriceUsd } from '../validation/dexscreener.js';
import type { ValidatedSignal } from '../signals/entry-engine.js';

export class ShadowTracker {
  private positions: Map<string, ShadowPosition> = new Map();
  private priceCheckInterval: ReturnType<typeof setInterval> | null = null;
  private onPositionClosed: ((pos: ShadowPosition) => void) | null = null;
  private onAlphaExitTriggered: ((pos: ShadowPosition, walletAddress: string, sellPct: number) => void) | null = null;

  setCloseCallback(cb: (pos: ShadowPosition) => void): void {
    this.onPositionClosed = cb;
  }

  setAlphaExitCallback(cb: (pos: ShadowPosition, walletAddress: string, sellPct: number) => void): void {
    this.onAlphaExitTriggered = cb;
  }

  /** Start price monitoring loop */
  start(): void {
    this.priceCheckInterval = setInterval(
      () => this.checkPrices(),
      config.dexScreener.priceCheckIntervalMs,
    );
    logger.info('Shadow position tracker started (price check every 10s)');
  }

  stop(): void {
    if (this.priceCheckInterval) {
      clearInterval(this.priceCheckInterval);
      this.priceCheckInterval = null;
    }
  }

  /** Open a new shadow position from a validated signal */
  async openPosition(signal: ValidatedSignal, positionSizeSol: number): Promise<ShadowPosition> {
    const price = signal.validation.dexData ? getPriceUsd(signal.validation.dexData) : 0;

    const pos: ShadowPosition = {
      id: uuid(),
      token_address: signal.tokenMint,
      token_symbol: signal.tokenSymbol,
      entry_price: price,
      entry_time: new Date(),
      alpha_buy_time: new Date(signal.firstSignal.blockTime * 1000),
      signal_wallets: signal.walletAddresses,
      capital_tier: signal.tierConfig.tier,
      simulated_entry_sol: positionSizeSol,
      status: PositionStatus.OPEN,
      current_price: price,
      peak_price: price,
      pnl_percent: 0,
      exit_reason: null,
      closed_at: null,
      hold_time_mins: null,
      partial_exits: [],
    };

    this.positions.set(pos.id, pos);

    // Persist to DB
    await query(
      `INSERT INTO shadow_positions (id, token_address, token_symbol, entry_price, entry_time, alpha_buy_time, signal_wallets, capital_tier, simulated_entry_sol, status, current_price, peak_price, pnl_percent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [pos.id, pos.token_address, pos.token_symbol, pos.entry_price, pos.entry_time, pos.alpha_buy_time,
       pos.signal_wallets, pos.capital_tier, pos.simulated_entry_sol, pos.status, pos.current_price, pos.peak_price, pos.pnl_percent],
    );

    logger.info({
      id: pos.id.slice(0, 8),
      token: pos.token_symbol || pos.token_address.slice(0, 8),
      price,
      sizeSol: positionSizeSol,
      tier: pos.capital_tier,
    }, 'Shadow position opened');

    return pos;
  }

  /** Handle alpha wallet sell detection — determines exit action */
  async handleAlphaExit(tokenMint: string, walletAddress: string, sellPercentage: number): Promise<void> {
    for (const pos of this.positions.values()) {
      if (pos.token_address !== tokenMint || pos.status === PositionStatus.CLOSED) continue;

      const tier = pos.capital_tier as CapitalTier;

      // MICRO/SMALL: alpha sells >30% → sell 100%
      if (tier === CapitalTier.MICRO || tier === CapitalTier.SMALL) {
        if (sellPercentage >= 0.30) {
          await this.closePosition(pos, `Alpha exit: ${walletAddress.slice(0, 8)} sold ${(sellPercentage * 100).toFixed(0)}%`);
          if (this.onAlphaExitTriggered) {
            this.onAlphaExitTriggered(pos, walletAddress, sellPercentage);
          }
        }
        return;
      }

      // MEDIUM: alpha sells >50% → sell 50% remaining + tighten trail
      if (tier === CapitalTier.MEDIUM) {
        if (sellPercentage >= 0.50) {
          // Full exit for shadow mode simplicity
          await this.closePosition(pos, `Alpha exit (MEDIUM): ${walletAddress.slice(0, 8)} sold ${(sellPercentage * 100).toFixed(0)}%`);
        }
        return;
      }

      // FULL: >30% sell → sell 50%, >70% sell → sell 100%
      if (tier === CapitalTier.FULL) {
        if (sellPercentage >= 0.70) {
          await this.closePosition(pos, `Alpha full exit: ${walletAddress.slice(0, 8)} sold ${(sellPercentage * 100).toFixed(0)}%`);
        } else if (sellPercentage >= 0.30) {
          // Partial — in shadow mode, just log it
          pos.partial_exits.push({
            time: new Date(),
            pct: 50,
            price: pos.current_price,
            reason: `Alpha partial: ${walletAddress.slice(0, 8)} sold ${(sellPercentage * 100).toFixed(0)}%`,
          });
          await this.updatePosition(pos);
        }
        return;
      }
    }
  }

  /** Check prices and apply exit rules */
  private async checkPrices(): Promise<void> {
    for (const pos of this.positions.values()) {
      if (pos.status === PositionStatus.CLOSED) continue;

      try {
        const pair = await fetchDexPair(pos.token_address);
        if (!pair) continue;

        const price = getPriceUsd(pair);
        if (price <= 0) continue;

        pos.current_price = price;
        if (price > pos.peak_price) pos.peak_price = price;
        pos.pnl_percent = pos.entry_price > 0 ? ((price - pos.entry_price) / pos.entry_price) : 0;

        // Apply exit rules based on tier
        await this.applyExitRules(pos);

        // Persist price update
        await this.updatePosition(pos);
      } catch (err) {
        logger.error({ err, posId: pos.id.slice(0, 8) }, 'Price check failed for position');
      }
    }
  }

  private async applyExitRules(pos: ShadowPosition): Promise<void> {
    const tier = pos.capital_tier as CapitalTier;
    const pnl = pos.pnl_percent;
    const holdMins = (Date.now() - pos.entry_time.getTime()) / (1000 * 60);

    // Hard time kill: 48 hours
    if (holdMins >= 48 * 60) {
      await this.closePosition(pos, 'Hard time kill (48h)');
      return;
    }

    // --- MICRO/SMALL exit rules ---
    if (tier === CapitalTier.MICRO || tier === CapitalTier.SMALL) {
      const profitTarget = tier === CapitalTier.MICRO ? 0.50 : 0.40;
      const stopLoss = -0.20;
      const hardKill = -0.25;

      if (pnl <= hardKill) { await this.closePosition(pos, `Hard kill (${(pnl * 100).toFixed(1)}%)`); return; }
      if (pnl <= stopLoss) { await this.closePosition(pos, `Stop loss (${(pnl * 100).toFixed(1)}%)`); return; }
      if (pnl >= profitTarget) { await this.closePosition(pos, `Profit target (${(pnl * 100).toFixed(1)}%)`); return; }

      // Time kills
      if (holdMins >= 60 && pnl < 0.05) { await this.closePosition(pos, 'Time kill 1h (<5%)'); return; }
      if (holdMins >= 240 && pnl < 0.15) { await this.closePosition(pos, 'Time kill 4h (<15%)'); return; }
      if (holdMins >= 720 && pnl < 0.25) { await this.closePosition(pos, 'Time kill 12h (<25%)'); return; }
      return;
    }

    // --- MEDIUM exit rules ---
    if (tier === CapitalTier.MEDIUM) {
      if (pnl <= -0.20) { await this.closePosition(pos, `Hard kill (${(pnl * 100).toFixed(1)}%)`); return; }
      if (pnl <= -0.15) { await this.closePosition(pos, `Stop loss (${(pnl * 100).toFixed(1)}%)`); return; }

      // Trailing after partial 1 (30%+)
      if (pos.partial_exits.length > 0 && pos.peak_price > 0) {
        const drawdown = (pos.peak_price - pos.current_price) / pos.peak_price;
        if (drawdown >= 0.20) { await this.closePosition(pos, `Trailing stop (${(drawdown * 100).toFixed(1)}% from peak)`); return; }
      }

      // Partials
      if (pnl >= 0.60 && pos.partial_exits.length < 2) {
        pos.partial_exits.push({ time: new Date(), pct: 50, price: pos.current_price, reason: 'Partial 2 (+60%)' });
      } else if (pnl >= 0.30 && pos.partial_exits.length < 1) {
        pos.partial_exits.push({ time: new Date(), pct: 50, price: pos.current_price, reason: 'Partial 1 (+30%)' });
      }

      if (holdMins >= 60 && pnl < 0.05) { await this.closePosition(pos, 'Time kill 1h (<5%)'); return; }
      if (holdMins >= 240 && pnl < 0.15) { await this.closePosition(pos, 'Time kill 4h (<15%)'); return; }
      return;
    }

    // --- FULL exit rules ---
    if (tier === CapitalTier.FULL) {
      if (pnl <= -0.20) { await this.closePosition(pos, `Hard kill (${(pnl * 100).toFixed(1)}%)`); return; }
      if (pnl <= -0.15) { await this.closePosition(pos, `Stop loss (${(pnl * 100).toFixed(1)}%)`); return; }

      // Trailing after partial 1
      if (pos.partial_exits.length > 0 && pos.peak_price > 0) {
        const drawdown = (pos.peak_price - pos.current_price) / pos.peak_price;
        const trailPct = pnl >= 1.0 ? 0.15 : pnl >= 0.50 ? 0.15 : 0.20;
        if (drawdown >= trailPct) { await this.closePosition(pos, `Trailing stop (${(drawdown * 100).toFixed(1)}% from peak)`); return; }
      }

      // Partials
      if (pnl >= 1.0 && pos.partial_exits.length < 3) {
        pos.partial_exits.push({ time: new Date(), pct: 50, price: pos.current_price, reason: 'Partial 3 (+100%)' });
      } else if (pnl >= 0.50 && pos.partial_exits.length < 2) {
        pos.partial_exits.push({ time: new Date(), pct: 60, price: pos.current_price, reason: 'Partial 2 (+50%)' });
      } else if (pnl >= 0.25 && pos.partial_exits.length < 1) {
        pos.partial_exits.push({ time: new Date(), pct: 50, price: pos.current_price, reason: 'Partial 1 (+25%)' });
      }

      if (holdMins >= 60 && pnl < 0.05) { await this.closePosition(pos, 'Time kill 1h (<5%)'); return; }
      if (holdMins >= 240 && pnl < 0.15) { await this.closePosition(pos, 'Time kill 4h (<15%)'); return; }
      if (holdMins >= 720 && pnl < 0.25) { await this.closePosition(pos, 'Time kill 12h (<25%)'); return; }
    }
  }

  private async closePosition(pos: ShadowPosition, reason: string): Promise<void> {
    pos.status = PositionStatus.CLOSED;
    pos.exit_reason = reason;
    pos.closed_at = new Date();
    pos.hold_time_mins = Math.round((pos.closed_at.getTime() - pos.entry_time.getTime()) / (1000 * 60));

    await this.updatePosition(pos);

    // Update wallet performance stats for all contributing wallets
    await this.updateWalletStats(pos);

    logger.info({
      id: pos.id.slice(0, 8),
      token: pos.token_symbol || pos.token_address.slice(0, 8),
      pnl: `${(pos.pnl_percent * 100).toFixed(1)}%`,
      holdMins: pos.hold_time_mins,
      reason,
    }, 'Shadow position CLOSED');

    if (this.onPositionClosed) {
      this.onPositionClosed(pos);
    }

    // Remove from active tracking
    this.positions.delete(pos.id);
  }

  /** Update wallet performance stats based on position outcome */
  private async updateWalletStats(pos: ShadowPosition): Promise<void> {
    const isWin = pos.pnl_percent > 0;

    for (const walletAddr of pos.signal_wallets) {
      try {
        await query(
          `UPDATE alpha_wallets SET
             our_total_trades = our_total_trades + 1,
             our_win_rate = CASE
               WHEN our_total_trades = 0 THEN ${isWin ? 1.0 : 0.0}
               ELSE (our_win_rate * our_total_trades + ${isWin ? 1 : 0}) / (our_total_trades + 1)
             END,
             our_avg_pnl_percent = CASE
               WHEN our_total_trades = 0 THEN $2
               ELSE (our_avg_pnl_percent * our_total_trades + $2) / (our_total_trades + 1)
             END,
             our_avg_hold_time_mins = CASE
               WHEN our_total_trades = 0 THEN $3
               ELSE (our_avg_hold_time_mins * our_total_trades + $3) / (our_total_trades + 1)
             END,
             consecutive_losses = CASE WHEN $4 THEN consecutive_losses + 1 ELSE 0 END,
             last_validated_at = NOW()
           WHERE address = $1`,
          [walletAddr, pos.pnl_percent, pos.hold_time_mins || 0, !isWin],
        );
      } catch (err) {
        logger.error({ err, wallet: walletAddr.slice(0, 8) }, 'Failed to update wallet stats');
      }
    }
  }

  private async updatePosition(pos: ShadowPosition): Promise<void> {
    try {
      await query(
        `UPDATE shadow_positions SET
           current_price = $1, peak_price = $2, pnl_percent = $3,
           status = $4, exit_reason = $5, closed_at = $6, hold_time_mins = $7,
           partial_exits = $8
         WHERE id = $9`,
        [pos.current_price, pos.peak_price, pos.pnl_percent, pos.status, pos.exit_reason,
         pos.closed_at, pos.hold_time_mins, JSON.stringify(pos.partial_exits), pos.id],
      );
    } catch (err) {
      logger.error({ err, posId: pos.id.slice(0, 8) }, 'Failed to update shadow position');
    }
  }

  /** Load open positions from DB on startup */
  async loadOpenPositions(): Promise<void> {
    const rows = await getMany<Record<string, unknown>>(
      `SELECT * FROM shadow_positions WHERE status = 'OPEN'`,
    );

    for (const row of rows) {
      const pos: ShadowPosition = {
        id: row.id as string,
        token_address: row.token_address as string,
        token_symbol: row.token_symbol as string | null,
        entry_price: Number(row.entry_price),
        entry_time: new Date(row.entry_time as string),
        alpha_buy_time: new Date(row.alpha_buy_time as string),
        signal_wallets: row.signal_wallets as string[],
        capital_tier: row.capital_tier as CapitalTier,
        simulated_entry_sol: Number(row.simulated_entry_sol),
        status: PositionStatus.OPEN,
        current_price: Number(row.current_price),
        peak_price: Number(row.peak_price),
        pnl_percent: Number(row.pnl_percent),
        exit_reason: null,
        closed_at: null,
        hold_time_mins: null,
        partial_exits: (row.partial_exits as Array<{ time: Date; pct: number; price: number; reason: string }>) || [],
      };
      this.positions.set(pos.id, pos);
    }

    logger.info({ count: this.positions.size }, 'Loaded open shadow positions');
  }

  /** Get all open positions */
  getOpenPositions(): ShadowPosition[] {
    return Array.from(this.positions.values()).filter((p) => p.status === PositionStatus.OPEN);
  }

  /** Check if we already hold a position in this token */
  hasPosition(tokenMint: string): boolean {
    return Array.from(this.positions.values()).some(
      (p) => p.token_address === tokenMint && p.status !== PositionStatus.CLOSED,
    );
  }

  getOpenCount(): number {
    return this.getOpenPositions().length;
  }
}
