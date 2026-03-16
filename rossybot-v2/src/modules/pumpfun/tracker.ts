import { v4 as uuid } from 'uuid';
import { logger } from '../../utils/logger.js';
import { query, getMany } from '../../db/database.js';
import { config } from '../../config/index.js';
import { PositionStatus } from '../../types/index.js';
import { checkGraduation } from './detector.js';
import { fetchCurveState, estimateCurveFillPct } from './detector.js';
import { fetchDexPair, getPriceUsd } from '../validation/dexscreener.js';

export interface PumpFunPosition {
  id: string;
  token_address: string;
  token_symbol: string | null;
  bonding_curve_address: string;
  entry_price_sol: number; // SOL spent
  entry_time: Date;
  alpha_buy_time: Date;
  signal_wallets: string[];
  capital_tier: string;
  simulated_entry_sol: number;
  status: PositionStatus;
  // Curve tracking
  curve_fill_pct_at_entry: number;
  current_curve_fill_pct: number;
  last_curve_check_sol: number;
  // Price tracking (post-graduation)
  graduated: boolean;
  graduated_at: Date | null;
  current_price: number;
  peak_price: number;
  pnl_percent: number;
  // Exit
  exit_reason: string | null;
  closed_at: Date | null;
  hold_time_mins: number | null;
}

export class PumpFunTracker {
  private positions: Map<string, PumpFunPosition> = new Map();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private onPositionClosed: ((pos: PumpFunPosition) => void) | null = null;
  private onGraduation: ((pos: PumpFunPosition) => void) | null = null;

  setCloseCallback(cb: (pos: PumpFunPosition) => void): void {
    this.onPositionClosed = cb;
  }

  setGraduationCallback(cb: (pos: PumpFunPosition) => void): void {
    this.onGraduation = cb;
  }

  start(): void {
    // Check every 5 seconds (faster than standard 10s — pump.fun moves fast)
    this.checkInterval = setInterval(() => this.checkPositions(), 5000);
    logger.info('Pump.fun position tracker started (check every 5s)');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  async openPosition(params: {
    tokenMint: string;
    tokenSymbol: string | null;
    bondingCurveAddress: string;
    solAmount: number;
    curveFillPct: number;
    solInCurve: number;
    alphaBuyTime: Date;
    signalWallets: string[];
    capitalTier: string;
  }): Promise<PumpFunPosition> {
    const pos: PumpFunPosition = {
      id: uuid(),
      token_address: params.tokenMint,
      token_symbol: params.tokenSymbol,
      bonding_curve_address: params.bondingCurveAddress,
      entry_price_sol: params.solAmount,
      entry_time: new Date(),
      alpha_buy_time: params.alphaBuyTime,
      signal_wallets: params.signalWallets,
      capital_tier: params.capitalTier,
      simulated_entry_sol: params.solAmount,
      status: PositionStatus.OPEN,
      curve_fill_pct_at_entry: params.curveFillPct,
      current_curve_fill_pct: params.curveFillPct,
      last_curve_check_sol: params.solInCurve,
      graduated: false,
      graduated_at: null,
      current_price: 0,
      peak_price: 0,
      pnl_percent: 0,
      exit_reason: null,
      closed_at: null,
      hold_time_mins: null,
    };

    this.positions.set(pos.id, pos);

    await query(
      `INSERT INTO pumpfun_positions (id, token_address, token_symbol, bonding_curve_address,
         entry_price_sol, entry_time, alpha_buy_time, signal_wallets, capital_tier,
         simulated_entry_sol, status, curve_fill_pct_at_entry, current_curve_fill_pct,
         last_curve_check_sol, graduated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [pos.id, pos.token_address, pos.token_symbol, pos.bonding_curve_address,
       pos.entry_price_sol, pos.entry_time, pos.alpha_buy_time, pos.signal_wallets,
       pos.capital_tier, pos.simulated_entry_sol, pos.status,
       pos.curve_fill_pct_at_entry, pos.current_curve_fill_pct,
       pos.last_curve_check_sol, pos.graduated],
    );

    logger.info({
      id: pos.id.slice(0, 8),
      token: pos.token_symbol || pos.token_address.slice(0, 8),
      curveFill: `${(pos.curve_fill_pct_at_entry * 100).toFixed(0)}%`,
      sol: pos.simulated_entry_sol.toFixed(2),
    }, 'Pump.fun position opened');

    return pos;
  }

  /** Handle alpha wallet sell on the bonding curve */
  async handleAlphaExit(tokenMint: string, walletAddress: string, sellPct: number): Promise<void> {
    for (const pos of this.positions.values()) {
      if (pos.token_address !== tokenMint || pos.status === PositionStatus.CLOSED) continue;

      // Any alpha sell >20% on pump.fun = full exit (pre-graduation liquidity is thin)
      if (sellPct >= 0.20) {
        await this.closePosition(pos, `Alpha exit on curve: ${walletAddress.slice(0, 8)} sold ${(sellPct * 100).toFixed(0)}%`);
      }
    }
  }

  private async checkPositions(): Promise<void> {
    for (const pos of this.positions.values()) {
      if (pos.status === PositionStatus.CLOSED) continue;

      try {
        if (pos.graduated) {
          await this.checkGraduatedPosition(pos);
        } else {
          await this.checkCurvePosition(pos);
        }
      } catch (err) {
        logger.error({ err, posId: pos.id.slice(0, 8) }, 'Pump.fun position check failed');
      }
    }
  }

  /** Check a pre-graduation position on the bonding curve */
  private async checkCurvePosition(pos: PumpFunPosition): Promise<void> {
    const holdMins = (Date.now() - pos.entry_time.getTime()) / 60_000;
    const cfg = config.pumpFun;

    // 1. Check if token has graduated to Raydium
    const graduation = await checkGraduation(pos.token_address);
    if (graduation.graduated) {
      pos.graduated = true;
      pos.graduated_at = new Date();
      await this.updatePosition(pos);

      logger.info({
        token: pos.token_symbol || pos.token_address.slice(0, 8),
        holdMins: holdMins.toFixed(1),
        curveFill: `${(pos.current_curve_fill_pct * 100).toFixed(0)}%`,
      }, 'GRADUATION DETECTED — token migrated to Raydium');

      this.onGraduation?.(pos);

      // Fetch DexScreener price now that it's on Raydium
      const pair = await fetchDexPair(pos.token_address);
      if (pair) {
        pos.current_price = getPriceUsd(pair);
        pos.peak_price = pos.current_price;
      }

      await this.updatePosition(pos);
      return;
    }

    // 2. Update curve progress
    if (pos.bonding_curve_address && pos.bonding_curve_address !== 'unknown') {
      const curveState = await fetchCurveState(pos.bonding_curve_address);
      if (curveState?.exists) {
        const prevSol = pos.last_curve_check_sol;
        pos.last_curve_check_sol = curveState.solBalance;
        pos.current_curve_fill_pct = estimateCurveFillPct(curveState.solBalance);

        // Estimate PnL from curve progress: if curve SOL increased, our position likely gained
        if (pos.curve_fill_pct_at_entry > 0) {
          pos.pnl_percent = (pos.current_curve_fill_pct / pos.curve_fill_pct_at_entry) - 1;
        }

        // 3. Curve stall exit — if no SOL inflow for staleTimeKillMins
        const solDelta = curveState.solBalance - prevSol;
        if (holdMins >= cfg.staleTimeKillMins && solDelta <= 0.05) {
          await this.closePosition(pos, `Curve stall (${holdMins.toFixed(0)}min, no momentum)`);
          return;
        }
      }
    }

    // 4. Hard time kill — tighter than standard V2
    if (holdMins >= 60) {
      await this.closePosition(pos, `Pump.fun hard time kill (${holdMins.toFixed(0)}min)`);
      return;
    }

    // 5. Stop loss based on curve regression
    if (pos.pnl_percent <= cfg.stopLoss) {
      await this.closePosition(pos, `Pump.fun stop loss (${(pos.pnl_percent * 100).toFixed(1)}%)`);
      return;
    }

    await this.updatePosition(pos);
  }

  /** Check a post-graduation position (now on Raydium, use DexScreener pricing) */
  private async checkGraduatedPosition(pos: PumpFunPosition): Promise<void> {
    const pair = await fetchDexPair(pos.token_address);
    if (!pair) return;

    const price = getPriceUsd(pair);
    if (price <= 0) return;

    pos.current_price = price;
    if (price > pos.peak_price) pos.peak_price = price;

    // Post-graduation PnL is harder to track in shadow mode without actual token balance
    // Use price change from graduation as proxy
    if (pos.peak_price > 0 && pos.graduated_at) {
      const graduationPrice = pos.peak_price; // First price we saw at graduation
      pos.pnl_percent = (price - graduationPrice) / graduationPrice;
    }

    const holdMins = (Date.now() - pos.entry_time.getTime()) / 60_000;
    const holdSinceGrad = pos.graduated_at
      ? (Date.now() - pos.graduated_at.getTime()) / 60_000
      : 0;

    // Post-graduation: apply standard-ish exit rules but more aggressive
    // Profit target at graduation
    if (pos.pnl_percent >= config.pumpFun.graduationProfitTarget) {
      await this.closePosition(pos, `Graduation TP (${(pos.pnl_percent * 100).toFixed(1)}%)`);
      return;
    }

    // Trailing stop: 20% drawdown from peak post-graduation
    if (pos.peak_price > 0) {
      const drawdown = (pos.peak_price - price) / pos.peak_price;
      if (drawdown >= 0.20 && holdSinceGrad >= 2) {
        await this.closePosition(pos, `Post-grad trailing stop (${(drawdown * 100).toFixed(1)}% from peak)`);
        return;
      }
    }

    // Hard stop
    if (pos.pnl_percent <= config.pumpFun.hardKill) {
      await this.closePosition(pos, `Post-grad hard kill (${(pos.pnl_percent * 100).toFixed(1)}%)`);
      return;
    }

    // Time kill: 2 hours post-graduation with no significant gain
    if (holdSinceGrad >= 120 && pos.pnl_percent < 0.10) {
      await this.closePosition(pos, 'Post-grad time kill (2h <10%)');
      return;
    }

    await this.updatePosition(pos);
  }

  private async closePosition(pos: PumpFunPosition, reason: string): Promise<void> {
    pos.status = PositionStatus.CLOSED;
    pos.exit_reason = reason;
    pos.closed_at = new Date();
    pos.hold_time_mins = Math.round((pos.closed_at.getTime() - pos.entry_time.getTime()) / 60_000);

    await this.updatePosition(pos);
    await this.updateWalletStats(pos);

    logger.info({
      id: pos.id.slice(0, 8),
      token: pos.token_symbol || pos.token_address.slice(0, 8),
      pnl: `${(pos.pnl_percent * 100).toFixed(1)}%`,
      holdMins: pos.hold_time_mins,
      graduated: pos.graduated,
      reason,
    }, 'Pump.fun position CLOSED');

    this.onPositionClosed?.(pos);
    this.positions.delete(pos.id);
  }

  private async updateWalletStats(pos: PumpFunPosition): Promise<void> {
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
             consecutive_losses = CASE WHEN $3 THEN consecutive_losses + 1 ELSE 0 END,
             last_validated_at = NOW()
           WHERE address = $1`,
          [walletAddr, pos.pnl_percent, !isWin],
        );
      } catch (err) {
        logger.error({ err, wallet: walletAddr.slice(0, 8) }, 'Failed to update wallet stats (pump.fun)');
      }
    }
  }

  private async updatePosition(pos: PumpFunPosition): Promise<void> {
    try {
      await query(
        `UPDATE pumpfun_positions SET
           status = $1, current_curve_fill_pct = $2, last_curve_check_sol = $3,
           graduated = $4, graduated_at = $5, current_price = $6, peak_price = $7,
           pnl_percent = $8, exit_reason = $9, closed_at = $10, hold_time_mins = $11
         WHERE id = $12`,
        [pos.status, pos.current_curve_fill_pct, pos.last_curve_check_sol,
         pos.graduated, pos.graduated_at, pos.current_price, pos.peak_price,
         pos.pnl_percent, pos.exit_reason, pos.closed_at, pos.hold_time_mins, pos.id],
      );
    } catch (err) {
      logger.error({ err, posId: pos.id.slice(0, 8) }, 'Failed to update pump.fun position');
    }
  }

  async loadOpenPositions(): Promise<void> {
    try {
      const rows = await getMany<Record<string, unknown>>(
        `SELECT * FROM pumpfun_positions WHERE status = 'OPEN'`,
      );

      for (const row of rows) {
        const pos: PumpFunPosition = {
          id: row.id as string,
          token_address: row.token_address as string,
          token_symbol: row.token_symbol as string | null,
          bonding_curve_address: row.bonding_curve_address as string,
          entry_price_sol: Number(row.entry_price_sol),
          entry_time: new Date(row.entry_time as string),
          alpha_buy_time: new Date(row.alpha_buy_time as string),
          signal_wallets: row.signal_wallets as string[],
          capital_tier: row.capital_tier as string,
          simulated_entry_sol: Number(row.simulated_entry_sol),
          status: PositionStatus.OPEN,
          curve_fill_pct_at_entry: Number(row.curve_fill_pct_at_entry),
          current_curve_fill_pct: Number(row.current_curve_fill_pct),
          last_curve_check_sol: Number(row.last_curve_check_sol),
          graduated: Boolean(row.graduated),
          graduated_at: row.graduated_at ? new Date(row.graduated_at as string) : null,
          current_price: Number(row.current_price || 0),
          peak_price: Number(row.peak_price || 0),
          pnl_percent: Number(row.pnl_percent || 0),
          exit_reason: null,
          closed_at: null,
          hold_time_mins: null,
        };
        this.positions.set(pos.id, pos);
      }

      logger.info({ count: this.positions.size }, 'Loaded open pump.fun positions');
    } catch {
      // Table may not exist yet
      logger.info('No pump.fun positions table found (will be created on first migration)');
    }
  }

  getOpenPositions(): PumpFunPosition[] {
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
