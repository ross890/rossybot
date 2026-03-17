import { v4 as uuid } from 'uuid';
import { logger } from '../../utils/logger.js';
import { query, getMany } from '../../db/database.js';
import { config } from '../../config/index.js';
import { PositionStatus } from '../../types/index.js';
import { checkGraduation } from './detector.js';
import { fetchCurveState, estimateCurveFillPct } from './detector.js';
import { fetchDexPair, getPriceUsd } from '../validation/dexscreener.js';
import type { SwapExecutor, SwapResult } from '../trading/swap-executor.js';

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
  sol_in_curve_at_entry: number;  // SOL in curve when we entered — baseline for stall detection
  last_curve_check_sol: number;
  // Price tracking (post-graduation)
  graduated: boolean;
  graduated_at: Date | null;
  graduation_price: number; // Price at graduation — fixed baseline for PnL
  current_price: number;
  peak_price: number;
  pnl_percent: number;
  // Exit
  exit_reason: string | null;
  closed_at: Date | null;
  hold_time_mins: number | null;
  // Live trading fields
  entry_tx: string | null;
  fees_paid_sol: number;
  net_pnl_sol: number;
  // Retry tracking
  sell_retry_count: number;
}

export class PumpFunTracker {
  private positions: Map<string, PumpFunPosition> = new Map();
  private pendingEntries: Set<string> = new Set(); // Dedup lock: token mints being processed
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private onPositionClosed: ((pos: PumpFunPosition) => void) | null = null;
  private onGraduation: ((pos: PumpFunPosition) => void) | null = null;
  private onSwapFailed: ((tokenSymbol: string, error: string, type: 'BUY' | 'SELL') => void) | null = null;
  private onBalanceRefresh: (() => Promise<void>) | null = null;

  // Live trading: when set, executes real swaps via Jupiter
  private swapExecutor: SwapExecutor | null = null;

  get isLive(): boolean {
    return this.swapExecutor !== null;
  }

  setSwapExecutor(executor: SwapExecutor): void {
    this.swapExecutor = executor;
    logger.info('Pump.fun tracker: LIVE trading enabled via SwapExecutor');
  }

  setCloseCallback(cb: (pos: PumpFunPosition) => void): void {
    this.onPositionClosed = cb;
  }

  setGraduationCallback(cb: (pos: PumpFunPosition) => void): void {
    this.onGraduation = cb;
  }

  setSwapFailedCallback(cb: (tokenSymbol: string, error: string, type: 'BUY' | 'SELL') => void): void {
    this.onSwapFailed = cb;
  }

  setBalanceRefreshCallback(cb: () => Promise<void>): void {
    this.onBalanceRefresh = cb;
  }

  start(): void {
    // Check every 5 seconds (faster than standard 10s — pump.fun moves fast)
    this.checkInterval = setInterval(() => this.checkPositions(), 5000);
    logger.info(`Pump.fun position tracker started (check every 5s, mode: ${this.isLive ? 'LIVE' : 'SHADOW'})`);
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
  }): Promise<PumpFunPosition | null> {
    // Dedup lock: prevent concurrent entries on the same token
    if (this.pendingEntries.has(params.tokenMint)) {
      logger.info({ token: params.tokenMint.slice(0, 8) }, 'Pump.fun skip — entry already in progress (dedup)');
      return null;
    }
    this.pendingEntries.add(params.tokenMint);

    try {
      return await this._executeOpen(params);
    } finally {
      this.pendingEntries.delete(params.tokenMint);
    }
  }

  private async _executeOpen(params: {
    tokenMint: string;
    tokenSymbol: string | null;
    bondingCurveAddress: string;
    solAmount: number;
    curveFillPct: number;
    solInCurve: number;
    alphaBuyTime: Date;
    signalWallets: string[];
    capitalTier: string;
  }): Promise<PumpFunPosition | null> {
    let entryTx: string | null = null;
    let feesSol = 0;

    // LIVE MODE: execute real buy swap
    if (this.swapExecutor) {
      const tokenName = params.tokenSymbol || params.tokenMint.slice(0, 8);
      logger.info({
        token: tokenName,
        sizeSol: params.solAmount,
        curveFill: `${(params.curveFillPct * 100).toFixed(0)}%`,
      }, 'Pump.fun LIVE BUY — executing swap');

      // Use pump.fun slippage (5%) since bonding curve tokens have higher slippage
      // Retry up to 2 times on transient failures (400s can be RPC/quote timing issues)
      const MAX_BUY_RETRIES = 2;
      let result: SwapResult | null = null;

      for (let attempt = 0; attempt <= MAX_BUY_RETRIES; attempt++) {
        result = await this.swapExecutor.buyToken(
          params.tokenMint,
          params.solAmount,
          0, // liquidityUsd=0 forces thinLiquiditySlippageBps in SwapExecutor
        );

        if (result.success) break;

        // Don't retry on clearly terminal errors (insufficient balance, invalid token)
        const err = result.error || '';
        const isTerminal = err.includes('insufficient') || err.includes('Invalid') || err.includes('not found');
        if (isTerminal || attempt === MAX_BUY_RETRIES) break;

        logger.warn({ error: err, token: tokenName, attempt: attempt + 1 }, 'Pump.fun BUY retry');
        await new Promise((r) => setTimeout(r, 1500)); // 1.5s backoff
      }

      if (!result || !result.success) {
        logger.error({ error: result?.error, token: tokenName }, `Pump.fun BUY swap failed: ${result?.error}`);
        this.onSwapFailed?.(tokenName, result?.error || 'Unknown error', 'BUY');
        return null;
      }

      entryTx = result.txSignature;
      feesSol = result.feesSol;

      logger.info({
        token: tokenName,
        tx: result.txSignature?.slice(0, 16),
        fees: feesSol.toFixed(6),
      }, 'Pump.fun LIVE BUY executed');

      // Refresh wallet balance after buy
      if (this.onBalanceRefresh) {
        try { await this.onBalanceRefresh(); } catch { /* ignore */ }
      }
    }

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
      sol_in_curve_at_entry: params.solInCurve,
      last_curve_check_sol: params.solInCurve,
      graduated: false,
      graduated_at: null,
      graduation_price: 0,
      current_price: 0,
      peak_price: 0,
      pnl_percent: 0,
      exit_reason: null,
      closed_at: null,
      hold_time_mins: null,
      entry_tx: entryTx,
      fees_paid_sol: feesSol,
      net_pnl_sol: -feesSol, // Start negative due to entry fees
      sell_retry_count: 0,
    };

    this.positions.set(pos.id, pos);

    await query(
      `INSERT INTO pumpfun_positions (id, token_address, token_symbol, bonding_curve_address,
         entry_price_sol, entry_time, alpha_buy_time, signal_wallets, capital_tier,
         simulated_entry_sol, status, curve_fill_pct_at_entry, current_curve_fill_pct,
         sol_in_curve_at_entry, last_curve_check_sol, graduated, graduation_price, entry_tx, fees_paid_sol, net_pnl_sol)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [pos.id, pos.token_address, pos.token_symbol, pos.bonding_curve_address,
       pos.entry_price_sol, pos.entry_time, pos.alpha_buy_time, pos.signal_wallets,
       pos.capital_tier, pos.simulated_entry_sol, pos.status,
       pos.curve_fill_pct_at_entry, pos.current_curve_fill_pct,
       pos.sol_in_curve_at_entry, pos.last_curve_check_sol, pos.graduated, pos.graduation_price,
       pos.entry_tx, pos.fees_paid_sol, pos.net_pnl_sol],
    );

    logger.info({
      id: pos.id.slice(0, 8),
      token: pos.token_symbol || pos.token_address.slice(0, 8),
      curveFill: `${(pos.curve_fill_pct_at_entry * 100).toFixed(0)}%`,
      sol: pos.simulated_entry_sol.toFixed(4),
      mode: this.isLive ? 'LIVE' : 'SHADOW',
      tx: entryTx?.slice(0, 16) || 'n/a',
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

  // Track last graduation check time per position to throttle DexScreener API calls
  private lastGradCheckAt: Map<string, number> = new Map();
  private static readonly GRAD_CHECK_INTERVAL_MS = 30_000; // Check graduation every 30s, not 5s

  /** Check a pre-graduation position on the bonding curve */
  private async checkCurvePosition(pos: PumpFunPosition): Promise<void> {
    const holdMins = (Date.now() - pos.entry_time.getTime()) / 60_000;
    const cfg = config.pumpFun;

    // 1. Check if token has graduated — throttled to every 30s (DexScreener rate limit)
    const now = Date.now();
    const lastGradCheck = this.lastGradCheckAt.get(pos.id) || 0;
    const shouldCheckGrad = (now - lastGradCheck) >= PumpFunTracker.GRAD_CHECK_INTERVAL_MS;

    let graduation = { graduated: false } as { graduated: boolean; dexPairAddress?: string };
    if (shouldCheckGrad) {
      this.lastGradCheckAt.set(pos.id, now);
      graduation = await checkGraduation(pos.token_address);
    }
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
        pos.graduation_price = pos.current_price; // Lock in graduation price as PnL baseline
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

        // 3. Curve stall exit — compare SOL growth since ENTRY (not last 5s check)
        const solDeltaSinceEntry = curveState.solBalance - pos.sol_in_curve_at_entry;
        const solDeltaSinceLastCheck = curveState.solBalance - prevSol;
        if (holdMins >= cfg.staleTimeKillMins && solDeltaSinceEntry <= 0.5) {
          await this.closePosition(pos, `Curve stall (${holdMins.toFixed(0)}min, no momentum)`);
          return;
        }

        // 3b. Early stall — if curve is going backwards (net sells vs entry) after 5 min
        if (holdMins >= 5 && solDeltaSinceEntry < -0.05) {
          await this.closePosition(pos, `Curve reversal (${holdMins.toFixed(0)}min, SOL leaving curve)`);
          return;
        }
      }
    }

    // 4. Hard time kill — aligned with maxTokenAgeMins config
    if (holdMins >= cfg.maxTokenAgeMins) {
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

    // Post-graduation PnL tracking — use locked graduation_price, NOT peak_price
    if (pos.graduation_price > 0 && pos.graduated_at) {
      pos.pnl_percent = (price - pos.graduation_price) / pos.graduation_price;
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
    // LIVE MODE: execute real sell swap
    if (this.swapExecutor) {
      const tokenName = pos.token_symbol || pos.token_address.slice(0, 8);
      logger.info({ token: tokenName, reason }, 'Pump.fun LIVE SELL — executing swap');

      // Use low liquidity estimate to get higher slippage tolerance for pump.fun tokens
      const pair = await fetchDexPair(pos.token_address);
      const liquidityUsd = pair?.liquidity?.usd || 0;

      const result = await this.swapExecutor.sellToken(pos.token_address, liquidityUsd);

      if (!result.success) {
        const errorMsg = result.error || 'Unknown';
        const isNoBalance = errorMsg.includes('No token balance') || errorMsg.includes('amount is zero');

        if (isNoBalance) {
          // Tokens are gone (already sold, transferred, or rugged) — force close as total loss
          logger.warn({ token: tokenName, reason }, 'Pump.fun SELL — no token balance, force closing as loss');
          pos.net_pnl_sol = -pos.entry_price_sol - pos.fees_paid_sol;
          pos.pnl_percent = -1;
          // Fall through to close the position below
        } else {
          pos.sell_retry_count = (pos.sell_retry_count || 0) + 1;
          const MAX_SELL_RETRIES = 3;

          if (pos.sell_retry_count >= MAX_SELL_RETRIES) {
            logger.error({ token: tokenName, retries: pos.sell_retry_count, reason }, 'Pump.fun SELL failed after max retries — force closing');
            this.onSwapFailed?.(tokenName, `${errorMsg} (gave up after ${MAX_SELL_RETRIES} retries)`, 'SELL');
            pos.net_pnl_sol = -pos.entry_price_sol - pos.fees_paid_sol;
            pos.pnl_percent = -1;
            // Fall through to close
          } else {
            logger.error({ error: errorMsg, token: tokenName, retry: pos.sell_retry_count, reason }, 'Pump.fun SELL swap failed — will retry');
            // Only notify on first failure, not every retry
            if (pos.sell_retry_count === 1) {
              this.onSwapFailed?.(tokenName, errorMsg, 'SELL');
            }
            return;
          }
        }
      } else {
        // Calculate actual P&L from SOL received
        const solReceived = result.outputAmount / 1e9;
        pos.fees_paid_sol += result.feesSol;
        pos.net_pnl_sol = solReceived - pos.entry_price_sol - pos.fees_paid_sol;
        pos.pnl_percent = pos.entry_price_sol > 0 ? (solReceived - pos.entry_price_sol) / pos.entry_price_sol : 0;

        logger.info({
          token: tokenName,
          solReceived: solReceived.toFixed(6),
          pnl: `${(pos.pnl_percent * 100).toFixed(1)}%`,
          netPnl: `${pos.net_pnl_sol.toFixed(6)} SOL`,
          tx: result.txSignature?.slice(0, 16),
        }, 'Pump.fun LIVE SELL executed');
      }
    }

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
      mode: this.isLive ? 'LIVE' : 'SHADOW',
      reason,
    }, 'Pump.fun position CLOSED');

    this.onPositionClosed?.(pos);
    this.positions.delete(pos.id);
    this.lastGradCheckAt.delete(pos.id);

    // Refresh wallet balance after sell
    if (this.swapExecutor && this.onBalanceRefresh) {
      try { await this.onBalanceRefresh(); } catch { /* ignore */ }
    }
  }

  /** Force close a pump.fun position by token (for /kill command) */
  async forceClose(tokenIdentifier: string): Promise<{ success: boolean; token?: string; error?: string }> {
    const match = Array.from(this.positions.values()).find((p) =>
      p.status !== PositionStatus.CLOSED &&
      (p.token_symbol?.toLowerCase() === tokenIdentifier.toLowerCase() ||
       p.token_address.toLowerCase().startsWith(tokenIdentifier.toLowerCase())),
    );

    if (!match) {
      return { success: false, error: `No open pump.fun position found for "${tokenIdentifier}"` };
    }

    await this.closePosition(match, 'Force close (/kill)');
    return { success: true, token: match.token_symbol || match.token_address.slice(0, 8) };
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
           graduated = $4, graduated_at = $5, graduation_price = $6, current_price = $7, peak_price = $8,
           pnl_percent = $9, exit_reason = $10, closed_at = $11, hold_time_mins = $12,
           fees_paid_sol = $13, net_pnl_sol = $14
         WHERE id = $15`,
        [pos.status, pos.current_curve_fill_pct, pos.last_curve_check_sol,
         pos.graduated, pos.graduated_at, pos.graduation_price, pos.current_price, pos.peak_price,
         pos.pnl_percent, pos.exit_reason, pos.closed_at, pos.hold_time_mins,
         pos.fees_paid_sol, pos.net_pnl_sol, pos.id],
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
          sol_in_curve_at_entry: Number(row.sol_in_curve_at_entry || row.last_curve_check_sol),
          last_curve_check_sol: Number(row.last_curve_check_sol),
          graduated: Boolean(row.graduated),
          graduated_at: row.graduated_at ? new Date(row.graduated_at as string) : null,
          graduation_price: Number(row.graduation_price || 0),
          current_price: Number(row.current_price || 0),
          peak_price: Number(row.peak_price || 0),
          pnl_percent: Number(row.pnl_percent || 0),
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

      logger.info({ count: this.positions.size, mode: this.isLive ? 'LIVE' : 'SHADOW' }, 'Loaded open pump.fun positions');
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
