import { v4 as uuid } from 'uuid';
import { logger } from '../../utils/logger.js';
import { query, getMany, getOne } from '../../db/database.js';
import { config } from '../../config/index.js';
import { PositionStatus } from '../../types/index.js';
import { checkGraduation } from './detector.js';
import { fetchCurveState, estimateCurveFillPct, deriveBondingCurveAddress } from './detector.js';
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
  peak_curve_fill_pct: number;  // Highest curve fill observed during position lifetime
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
  // Entry type for tuning analytics
  entry_type: 'DIRECT' | 'DEFERRED' | 'MOVER';
  // Retry tracking
  sell_retry_count: number;
}

export class PumpFunTracker {
  private positions: Map<string, PumpFunPosition> = new Map();
  private pendingEntries: Set<string> = new Set(); // Dedup lock: token mints being processed
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private balanceScanInterval: ReturnType<typeof setInterval> | null = null;
  private onPositionClosed: ((pos: PumpFunPosition) => void) | null = null;
  private onGraduation: ((pos: PumpFunPosition) => void) | null = null;
  private onSwapFailed: ((tokenSymbol: string, error: string, type: 'BUY' | 'SELL') => void) | null = null;
  private onBalanceRefresh: (() => Promise<void>) | null = null;

  // Cumulative alpha sell tracking: positionId → total SOL sold by signal wallets
  private alphaExitAccumulator: Map<string, number> = new Map();
  private static readonly ALPHA_EXIT_SINGLE_THRESHOLD = 0.5; // Single dump ≥0.5 SOL triggers exit
  private static readonly ALPHA_EXIT_CUMULATIVE_THRESHOLD = 1.0; // Cumulative sells ≥1.0 SOL triggers exit

  // Live trading: when set, executes real swaps via Jupiter
  private swapExecutor: SwapExecutor | null = null;

  // Session PnL tracking (resets on restart)
  private sessionStats = {
    trades: 0,
    wins: 0,
    totalPnlSol: 0,
    totalFeesSol: 0,
    startedAt: new Date(),
  };

  getSessionStats(): { trades: number; wins: number; winRate: number; totalPnlSol: number; totalFeesSol: number; startedAt: Date } {
    return {
      ...this.sessionStats,
      winRate: this.sessionStats.trades > 0 ? this.sessionStats.wins / this.sessionStats.trades : 0,
    };
  }

  async getAllTimeStats(): Promise<{ trades: number; wins: number; winRate: number; totalPnlSol: number; totalFeesSol: number }> {
    try {
      const row = await getOne<{ total: string; wins: string; total_pnl: string; total_fees: string }>(
        `SELECT COUNT(*) as total,
                COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
                COALESCE(SUM(net_pnl_sol), 0) as total_pnl,
                COALESCE(SUM(fees_paid_sol), 0) as total_fees
         FROM pumpfun_positions WHERE status = 'CLOSED'`,
      );
      const trades = Number(row?.total || 0);
      const wins = Number(row?.wins || 0);
      return {
        trades,
        wins,
        winRate: trades > 0 ? wins / trades : 0,
        totalPnlSol: Number(row?.total_pnl || 0),
        totalFeesSol: Number(row?.total_fees || 0),
      };
    } catch {
      return { trades: 0, wins: 0, winRate: 0, totalPnlSol: 0, totalFeesSol: 0 };
    }
  }

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
    this.checkInterval = setInterval(() => this.checkPositions(), 2000);
    // Scan wallet balances every 60s to detect manual sells and free up slots
    if (this.swapExecutor) {
      this.balanceScanInterval = setInterval(() => this.scanWalletBalances(), 60_000);
    }
    logger.info(`Pump.fun position tracker started (check every 5s, balance scan every 60s, mode: ${this.isLive ? 'LIVE' : 'SHADOW'})`);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.balanceScanInterval) {
      clearInterval(this.balanceScanInterval);
      this.balanceScanInterval = null;
    }
  }

  /** Expose swap executor for prefetching quotes */
  getSwapExecutor(): SwapExecutor | null {
    return this.swapExecutor;
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
    prefetchedQuote?: unknown;
    entryType?: 'DIRECT' | 'DEFERRED' | 'MOVER';
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
    prefetchedQuote?: unknown;
    entryType?: 'DIRECT' | 'DEFERRED' | 'MOVER';
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
          attempt === 0 ? params.prefetchedQuote : undefined, // Only use prefetched quote on first attempt
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

      // Re-calibrate curve baseline from RPC after buy confirms.
      // The entry solInCurve may come from PumpPortal cache (vSol - 30) which can differ
      // from RPC account lamports. Using RPC here ensures the baseline matches the
      // checkCurvePosition monitoring path and prevents phantom PnL on first tick.
      try {
        const postBuyCurve = await fetchCurveState(params.bondingCurveAddress);
        if (postBuyCurve?.exists && postBuyCurve.solBalance > 0) {
          const rpcFillPct = estimateCurveFillPct(postBuyCurve.solBalance);
          logger.debug({
            token: tokenName,
            oldSol: params.solInCurve.toFixed(2),
            rpcSol: postBuyCurve.solBalance.toFixed(2),
            oldFill: `${(params.curveFillPct * 100).toFixed(0)}%`,
            rpcFill: `${(rpcFillPct * 100).toFixed(0)}%`,
          }, 'Pump.fun entry baseline re-calibrated from RPC');
          params.solInCurve = postBuyCurve.solBalance;
          params.curveFillPct = rpcFillPct;
        }
      } catch { /* non-fatal — keep PumpPortal value */ }
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
      peak_curve_fill_pct: params.curveFillPct,
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
      entry_type: params.entryType || 'DIRECT',
      sell_retry_count: 0,
    };

    this.positions.set(pos.id, pos);

    await query(
      `INSERT INTO pumpfun_positions (id, token_address, token_symbol, bonding_curve_address,
         entry_price_sol, entry_time, alpha_buy_time, signal_wallets, capital_tier,
         simulated_entry_sol, status, curve_fill_pct_at_entry, current_curve_fill_pct, peak_curve_fill_pct,
         sol_in_curve_at_entry, last_curve_check_sol, graduated, graduation_price, entry_tx, fees_paid_sol, net_pnl_sol, entry_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [pos.id, pos.token_address, pos.token_symbol, pos.bonding_curve_address,
       pos.entry_price_sol, pos.entry_time, pos.alpha_buy_time, pos.signal_wallets,
       pos.capital_tier, pos.simulated_entry_sol, pos.status,
       pos.curve_fill_pct_at_entry, pos.current_curve_fill_pct, pos.peak_curve_fill_pct,
       pos.sol_in_curve_at_entry, pos.last_curve_check_sol, pos.graduated, pos.graduation_price,
       pos.entry_tx, pos.fees_paid_sol, pos.net_pnl_sol, pos.entry_type],
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
  async handleAlphaExit(tokenMint: string, walletAddress: string, solReceived: number): Promise<void> {
    for (const pos of this.positions.values()) {
      if (pos.token_address !== tokenMint || pos.status === PositionStatus.CLOSED) continue;

      // Only react to sells from wallets that triggered OUR entry.
      // Random alpha wallets selling the same token shouldn't cause panic exits.
      const isSignalWallet = pos.signal_wallets.some(
        (w) => w.toLowerCase() === walletAddress.toLowerCase(),
      );
      if (!isSignalWallet) {
        logger.info({ token: pos.token_symbol || tokenMint.slice(0, 8), wallet: walletAddress.slice(0, 8), solReceived: solReceived.toFixed(2) },
          'Pump.fun alpha sell ignored — not our signal wallet');
        continue;
      }

      const absSol = Math.abs(solReceived);

      // Single large dump — exit immediately
      if (absSol >= PumpFunTracker.ALPHA_EXIT_SINGLE_THRESHOLD) {
        this.alphaExitAccumulator.delete(pos.id);
        await this.closePosition(pos, `Alpha exit on curve: ${walletAddress.slice(0, 8)} dumped ${absSol.toFixed(1)} SOL`);
        continue;
      }

      // Accumulate smaller sells — alpha may be unwinding incrementally
      const prevCumulative = this.alphaExitAccumulator.get(pos.id) || 0;
      const newCumulative = prevCumulative + absSol;
      this.alphaExitAccumulator.set(pos.id, newCumulative);

      if (newCumulative >= PumpFunTracker.ALPHA_EXIT_CUMULATIVE_THRESHOLD) {
        this.alphaExitAccumulator.delete(pos.id);
        await this.closePosition(pos, `Alpha incremental exit: ${walletAddress.slice(0, 8)} sold ${newCumulative.toFixed(2)} SOL total`);
        continue;
      }

      logger.info({
        token: pos.token_symbol || tokenMint.slice(0, 8),
        wallet: walletAddress.slice(0, 8),
        thisSell: absSol.toFixed(2),
        cumulative: newCumulative.toFixed(2),
        threshold: PumpFunTracker.ALPHA_EXIT_CUMULATIVE_THRESHOLD,
      }, 'Pump.fun signal wallet partial sell — tracking cumulative');
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
  private static readonly GRAD_CHECK_INTERVAL_MS = 2_000; // Check graduation every 2s — must beat the 85% curve exit

  /** Check a pre-graduation position on the bonding curve — CURVE SCALP STRATEGY */
  private async checkCurvePosition(pos: PumpFunPosition): Promise<void> {
    const holdMins = (Date.now() - pos.entry_time.getTime()) / 60_000;
    const cfg = config.pumpFun;

    // 1. Update curve progress — derive PDA if stored address is unknown
    if (pos.bonding_curve_address === 'unknown' || !pos.bonding_curve_address) {
      try {
        pos.bonding_curve_address = deriveBondingCurveAddress(pos.token_address);
      } catch { /* keep unknown */ }
    }
    if (pos.bonding_curve_address && pos.bonding_curve_address !== 'unknown') {
      const curveState = await fetchCurveState(pos.bonding_curve_address);
      if (curveState?.exists) {
        const prevSol = pos.last_curve_check_sol;
        pos.last_curve_check_sol = curveState.solBalance;
        pos.current_curve_fill_pct = estimateCurveFillPct(curveState.solBalance);
        if (pos.current_curve_fill_pct > pos.peak_curve_fill_pct) {
          pos.peak_curve_fill_pct = pos.current_curve_fill_pct;
        }

        // Estimate PnL from curve SOL balance change.
        // Bonding curve: price ∝ sqrt(solBalance), so PnL ≈ sqrt(sol_now/sol_entry) - 1
        if (pos.sol_in_curve_at_entry > 0 && curveState.solBalance > 0) {
          pos.pnl_percent = Math.sqrt(curveState.solBalance / pos.sol_in_curve_at_entry) - 1;
        } else if (curveState.solBalance <= 0) {
          pos.pnl_percent = -1; // Curve emptied — total loss
        }

        // --- CURVE SCALP EXITS (highest priority — take profit before graduation) ---

        // 2a. Curve hard exit — NEVER hold through graduation (force-exit at 45%)
        if (pos.current_curve_fill_pct >= cfg.curveHardExit) {
          await this.closePosition(pos, 'Curve hard exit (pre-graduation)');
          return;
        }

        // 2b. PnL-based take profit — must hold ≥30s to avoid false TP on first tick
        if (holdMins >= 0.5 && pos.pnl_percent >= cfg.profitTarget) {
          await this.closePosition(pos, 'Take profit');
          return;
        }

        // 2c. Curve fill TP fallback — sell at curve target regardless of PnL calc
        if (pos.current_curve_fill_pct >= cfg.curveProfitTarget) {
          await this.closePosition(pos, 'Curve target hit');
          return;
        }

        // --- DEFENSIVE EXITS ---

        // 3. Curve stall exit — compare SOL growth since ENTRY (not last 5s check)
        //    Stale time reduced from 3min to 1.5min — data shows avg hold is 2min, stalls resolve fast
        const solDeltaSinceEntry = curveState.solBalance - pos.sol_in_curve_at_entry;
        if (holdMins >= cfg.staleTimeKillMins && solDeltaSinceEntry <= 0.5) {
          await this.closePosition(pos, 'Stall (no momentum)');
          return;
        }

        // 3b. Early reversal — curve going backwards after 60s (was 2min — faster cut)
        if (holdMins >= 1 && solDeltaSinceEntry < -0.05) {
          await this.closePosition(pos, 'Curve reversal');
          return;
        }
      }
    }

    // 4. Check graduation as fallback — if we somehow miss the curve fill, sell immediately
    const now = Date.now();
    const lastGradCheck = this.lastGradCheckAt.get(pos.id) || 0;
    const shouldCheckGrad = (now - lastGradCheck) >= PumpFunTracker.GRAD_CHECK_INTERVAL_MS;

    if (shouldCheckGrad) {
      this.lastGradCheckAt.set(pos.id, now);
      const graduation = await checkGraduation(pos.token_address, pos.current_curve_fill_pct);
      if (graduation.graduated) {
        pos.graduated = true;
        pos.graduated_at = new Date();

        logger.warn({
          token: pos.token_symbol || pos.token_address.slice(0, 8),
          holdMins: holdMins.toFixed(1),
          curveFill: `${(pos.current_curve_fill_pct * 100).toFixed(0)}%`,
        }, 'GRADUATION DETECTED — should have exited pre-grad, selling immediately');

        this.onGraduation?.(pos);
        // Sell immediately — don't wait for post-grad monitoring
        await this.closePosition(pos, 'Graduated (emergency exit)');
        return;
      }
    }

    // 5. Hard time kill — tighter at 15 min (curve scalps resolve fast)
    if (holdMins >= cfg.maxTokenAgeMins) {
      await this.closePosition(pos, 'Time limit');
      return;
    }

    // 6. Stop loss based on curve regression — must hold ≥15s to avoid false SL on transient dips
    //    PumpPortal events can briefly show low vSol on a single sell, then recover on the next buy.
    //    Without this guard, the bot exits instantly on phantom dips and misses real winners.
    if (holdMins >= 0.25 && pos.pnl_percent <= cfg.stopLoss) {
      await this.closePosition(pos, 'Stop loss');
      return;
    }

    await this.updatePosition(pos);
  }

  /** Post-graduation fallback — we should have exited pre-grad, sell immediately */
  private async checkGraduatedPosition(pos: PumpFunPosition): Promise<void> {
    // Curve scalp strategy: we should NEVER be here. If we are, sell ASAP.
    // No cooldown — every second costs money post-graduation.
    await this.closePosition(pos, 'Graduated (emergency exit)');
  }

  /** Scan wallet for tokens we think we hold — auto-drop if balance is 0 */
  private async scanWalletBalances(): Promise<void> {
    if (!this.swapExecutor) return;

    const openPositions = Array.from(this.positions.values()).filter(
      (p) => p.status !== PositionStatus.CLOSED,
    );
    if (openPositions.length === 0) return;

    for (const pos of openPositions) {
      try {
        const balance = await this.swapExecutor.getTokenBalance(pos.token_address);
        if (balance > 0) continue;

        // Token is gone from wallet — manual sell detected
        const tokenName = pos.token_symbol || pos.token_address.slice(0, 8);
        logger.info({
          id: pos.id.slice(0, 8),
          token: tokenName,
          holdMins: Math.round((Date.now() - pos.entry_time.getTime()) / 60_000),
        }, 'Pump.fun balance scan: token gone from wallet — auto-dropping');

        pos.status = PositionStatus.CLOSED;
        pos.exit_reason = 'Manual sell detected (balance scan)';
        pos.closed_at = new Date();
        pos.hold_time_mins = Math.round((pos.closed_at.getTime() - pos.entry_time.getTime()) / 60_000);

        await this.updatePosition(pos);
        this.onPositionClosed?.(pos);
        this.positions.delete(pos.id);
        this.lastGradCheckAt.delete(pos.id);
      } catch (err) {
        logger.error({ err, token: pos.token_symbol }, 'Pump.fun balance scan failed for position');
      }
    }
  }

  // Sell lock: prevent concurrent sells for the same position (race condition guard)
  private pendingSells: Set<string> = new Set();

  private async closePosition(pos: PumpFunPosition, reason: string): Promise<void> {
    // Race condition guard: if a sell is already in progress for this position, skip
    if (this.pendingSells.has(pos.id)) {
      logger.debug({ token: pos.token_symbol || pos.token_address.slice(0, 8), reason },
        'Pump.fun sell skipped — already selling this position');
      return;
    }
    // Also skip if already closed (another concurrent path may have closed it)
    if (pos.status === PositionStatus.CLOSED) {
      logger.debug({ token: pos.token_symbol || pos.token_address.slice(0, 8) },
        'Pump.fun sell skipped — position already closed');
      return;
    }
    this.pendingSells.add(pos.id);

    try {
    // LIVE MODE: execute real sell swap
    if (this.swapExecutor) {
      const tokenName = pos.token_symbol || pos.token_address.slice(0, 8);
      logger.info({ token: tokenName, reason }, 'Pump.fun LIVE SELL — executing swap');

      // Use pump.fun slippage as base, higher for post-graduation (price volatile after migration)
      // Pre-grad: 500→700→900 bps | Post-grad: 800→1000→1200 bps (tighter to preserve profit)
      const baseSlippage = pos.graduated ? 800 : config.pumpFun.slippageBps;
      const retryCount = pos.sell_retry_count || 0;
      const slippageBps = retryCount === 0
        ? baseSlippage
        : Math.min(baseSlippage + retryCount * 200, 1500); // Cap at 15% (was 20%)

      const pair = await fetchDexPair(pos.token_address);
      const liquidityUsd = pair?.liquidity?.usd || 0;

      logger.info({ token: tokenName, slippageBps, retry: retryCount }, 'Pump.fun sell slippage');

      const result = await this.swapExecutor.sellToken(pos.token_address, liquidityUsd, 100, slippageBps);

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
          const MAX_SELL_RETRIES = 5;

          if (pos.sell_retry_count >= MAX_SELL_RETRIES) {
            logger.error({ token: tokenName, retries: pos.sell_retry_count, reason }, 'Pump.fun SELL failed after max retries — force closing');
            this.onSwapFailed?.(tokenName, `${errorMsg} (gave up after ${MAX_SELL_RETRIES} retries)`, 'SELL');
            pos.net_pnl_sol = -pos.entry_price_sol - pos.fees_paid_sol;
            pos.pnl_percent = -1;
            // Fall through to close
          } else {
            const nextSlippage = Math.min(config.pumpFun.slippageBps + pos.sell_retry_count * 300, 1500);
            logger.error({ error: errorMsg, token: tokenName, retry: pos.sell_retry_count, nextSlippageBps: nextSlippage, reason }, 'Pump.fun SELL swap failed — will retry with higher slippage');
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

    // Shadow mode: simulate net PnL from curve-estimated pnl_percent
    if (!this.swapExecutor) {
      pos.net_pnl_sol = pos.entry_price_sol * pos.pnl_percent;
    }

    pos.status = PositionStatus.CLOSED;
    pos.exit_reason = reason;
    pos.closed_at = new Date();
    pos.hold_time_mins = Math.round((pos.closed_at.getTime() - pos.entry_time.getTime()) / 60_000);

    // Update session stats
    this.sessionStats.trades++;
    if (pos.pnl_percent > 0) this.sessionStats.wins++;
    this.sessionStats.totalPnlSol += pos.net_pnl_sol;
    this.sessionStats.totalFeesSol += pos.fees_paid_sol;

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
    this.alphaExitAccumulator.delete(pos.id);

    // Refresh wallet balance after sell
    if (this.swapExecutor && this.onBalanceRefresh) {
      try { await this.onBalanceRefresh(); } catch { /* ignore */ }
    }
    } finally {
      this.pendingSells.delete(pos.id);
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
           fees_paid_sol = $13, net_pnl_sol = $14, peak_curve_fill_pct = $16
         WHERE id = $15`,
        [pos.status, pos.current_curve_fill_pct, pos.last_curve_check_sol,
         pos.graduated, pos.graduated_at, pos.graduation_price, pos.current_price, pos.peak_price,
         pos.pnl_percent, pos.exit_reason, pos.closed_at, pos.hold_time_mins,
         pos.fees_paid_sol, pos.net_pnl_sol, pos.id, pos.peak_curve_fill_pct],
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
          peak_curve_fill_pct: Number(row.peak_curve_fill_pct || row.current_curve_fill_pct || row.curve_fill_pct_at_entry),
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
          entry_type: (row.entry_type as 'DIRECT' | 'DEFERRED' | 'MOVER') || 'DIRECT',
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

  /**
   * Real-time curve update from PumpPortal WebSocket trade events.
   * Called on every buy/sell on tokens we hold — much faster than 2s RPC polling.
   * Uses vSolInBondingCurve from the trade event to update curve fill and check exits instantly.
   */
  async handleRealtimeCurveUpdate(tokenMint: string, vSolInBondingCurve: number): Promise<void> {
    for (const pos of this.positions.values()) {
      if (pos.token_address !== tokenMint || pos.status === PositionStatus.CLOSED || pos.graduated) continue;
      // Don't update curve state while a sell is executing — prevents false "recovered" data in close messages
      if (this.pendingSells.has(pos.id)) continue;

      const cfg = config.pumpFun;

      // vSolInBondingCurve includes virtual reserves (~30 SOL), so subtract to get real SOL deposited
      // Real SOL ≈ vSol - 30 (pump.fun uses 30 SOL virtual reserve)
      const realSol = Math.max(0, vSolInBondingCurve - 30);

      // Spike protection: reject wild jumps in curve fill from a single event.
      // Prevents false -100% PnL (transient sell dip) and false 100% fill (anomalous data).
      const prevSol = pos.last_curve_check_sol;
      const solDelta = Math.abs(realSol - prevSol);
      // Reject absolute jumps > 20 SOL OR drops > 50% in a single event (likely bad data)
      const isHugeDrop = prevSol > 0 && realSol < prevSol * 0.5;
      if ((solDelta > 20 || isHugeDrop) && prevSol > 0) {
        logger.warn({
          token: tokenMint.slice(0, 8),
          prevSol: prevSol.toFixed(1),
          newSol: realSol.toFixed(1),
          delta: solDelta.toFixed(1),
          vSol: vSolInBondingCurve.toFixed(1),
        }, 'Curve update spike rejected — anomalous single event');
        return;
      }

      pos.last_curve_check_sol = realSol;
      pos.current_curve_fill_pct = estimateCurveFillPct(realSol);
      if (pos.current_curve_fill_pct > pos.peak_curve_fill_pct) {
        pos.peak_curve_fill_pct = pos.current_curve_fill_pct;
      }

      // Estimate PnL from curve SOL balance change (bonding curve: price ∝ sqrt(solBalance))
      if (pos.sol_in_curve_at_entry > 0 && realSol > 0) {
        pos.pnl_percent = Math.sqrt(realSol / pos.sol_in_curve_at_entry) - 1;
      } else if (realSol <= 0) {
        pos.pnl_percent = -1; // Curve emptied — total loss
      }

      const holdMins = (Date.now() - pos.entry_time.getTime()) / 60_000;

      // --- INSTANT CURVE SCALP EXITS ---

      // Hard exit at curve hard exit threshold
      if (pos.current_curve_fill_pct >= cfg.curveHardExit) {
        await this.closePosition(pos, 'Curve hard exit (pre-graduation)');
        return;
      }

      // PnL-based take profit — must hold ≥30s to avoid false TP on first tick
      if (holdMins >= 0.5 && pos.pnl_percent >= cfg.profitTarget) {
        await this.closePosition(pos, 'Take profit');
        return;
      }

      // Curve fill TP at target
      if (pos.current_curve_fill_pct >= cfg.curveProfitTarget) {
        await this.closePosition(pos, 'Curve target hit');
        return;
      }

      // Stop loss based on curve regression — must hold ≥15s (same guard as polling path)
      if (holdMins >= 0.25 && pos.pnl_percent <= cfg.stopLoss) {
        await this.closePosition(pos, 'Stop loss');
        return;
      }
    }
  }
}
