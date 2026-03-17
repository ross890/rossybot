import { v4 as uuid } from 'uuid';
import { logger } from '../../utils/logger.js';
import { query, getMany } from '../../db/database.js';
import { config } from '../../config/index.js';
import { CapitalTier, PositionStatus, type Position } from '../../types/index.js';
import { fetchDexPair, getPriceUsd } from '../validation/dexscreener.js';
import { SwapExecutor, type SwapResult } from '../trading/swap-executor.js';
import { TIER_CONFIGS } from '../../config/index.js';
import type { ValidatedSignal } from '../signals/entry-engine.js';

export class LiveTracker {
  private positions: Map<string, Position> = new Map();
  private priceCheckInterval: ReturnType<typeof setInterval> | null = null;
  private balanceScanInterval: ReturnType<typeof setInterval> | null = null;
  private swapExecutor: SwapExecutor;

  // Callbacks
  private onPositionClosed: ((pos: Position) => void) | null = null;
  private onAlphaExitTriggered: ((pos: Position, walletAddress: string, sellPct: number) => void) | null = null;
  private onSwapFailed: ((tokenSymbol: string, error: string, type: 'BUY' | 'SELL') => void) | null = null;
  private onManualSellDetected: ((tokenSymbol: string) => void) | null = null;

  constructor(swapExecutor: SwapExecutor) {
    this.swapExecutor = swapExecutor;
  }

  setCloseCallback(cb: (pos: Position) => void): void {
    this.onPositionClosed = cb;
  }

  setAlphaExitCallback(cb: (pos: Position, walletAddress: string, sellPct: number) => void): void {
    this.onAlphaExitTriggered = cb;
  }

  setSwapFailedCallback(cb: (tokenSymbol: string, error: string, type: 'BUY' | 'SELL') => void): void {
    this.onSwapFailed = cb;
  }

  setManualSellCallback(cb: (tokenSymbol: string) => void): void {
    this.onManualSellDetected = cb;
  }

  start(): void {
    this.priceCheckInterval = setInterval(
      () => this.checkPrices(),
      config.dexScreener.priceCheckIntervalMs,
    );
    // Scan wallet balances every 5 minutes to detect manual sells
    this.balanceScanInterval = setInterval(
      () => this.scanWalletBalances(),
      5 * 60 * 1000,
    );
    logger.info('Live position tracker started (price check every 10s, balance scan every 5m)');
  }

  stop(): void {
    if (this.priceCheckInterval) {
      clearInterval(this.priceCheckInterval);
      this.priceCheckInterval = null;
    }
    if (this.balanceScanInterval) {
      clearInterval(this.balanceScanInterval);
      this.balanceScanInterval = null;
    }
  }

  /** Open a real position — executes Jupiter swap */
  async openPosition(signal: ValidatedSignal, positionSizeSol: number): Promise<Position | null> {
    const tokenSymbol = signal.tokenSymbol || signal.tokenMint.slice(0, 8);
    const liquidityUsd = signal.validation.dexData?.liquidity?.usd || 0;

    logger.info({
      token: tokenSymbol,
      sizeSol: positionSizeSol,
      liquidity: liquidityUsd,
    }, 'Executing BUY swap');

    // Execute the actual swap
    const result = await this.swapExecutor.buyToken(signal.tokenMint, positionSizeSol, liquidityUsd);

    if (!result.success) {
      logger.error({ error: result.error, token: tokenSymbol }, `BUY swap failed: ${result.error}`);
      this.onSwapFailed?.(tokenSymbol, result.error || 'Unknown error', 'BUY');
      return null;
    }

    const price = signal.validation.dexData ? getPriceUsd(signal.validation.dexData) : 0;
    const executionLag = Math.round((Date.now() - signal.firstSignal.blockTime * 1000) / 1000);

    const pos: Position = {
      id: uuid(),
      token_address: signal.tokenMint,
      token_symbol: tokenSymbol,
      entry_price: price,
      entry_sol: positionSizeSol,
      entry_tx: result.txSignature || '',
      entry_time: new Date(),
      alpha_buy_time: new Date(signal.firstSignal.blockTime * 1000),
      execution_lag_seconds: executionLag,
      signal_wallet: signal.walletAddresses[0],
      signal_wallet_count: signal.walletCount,
      capital_tier_at_entry: signal.tierConfig.tier,
      confluence_score: null,
      confluence_details: null,
      momentum_at_entry: {
        priceChange24h: signal.validation.dexData?.priceChange?.h24 || 0,
        volume24h: signal.validation.dexData?.volume?.h24 || 0,
        mcap: signal.validation.dexData?.marketCap || signal.validation.dexData?.fdv || 0,
      },
      status: PositionStatus.OPEN,
      current_price: price,
      peak_price: price,
      pnl_sol: 0,
      pnl_percent: 0,
      fees_paid_sol: result.feesSol,
      net_pnl_sol: -result.feesSol, // Start negative due to entry fees
      exit_reason: null,
      partial_exits: [],
      closed_at: null,
      sell_retry_count: 0,
      hold_time_mins: null,
    };

    this.positions.set(pos.id, pos);

    // Persist to DB
    await query(
      `INSERT INTO positions (id, token_address, token_symbol, entry_price, entry_sol, entry_tx,
         entry_time, alpha_buy_time, execution_lag_seconds, signal_wallet, signal_wallet_count,
         capital_tier_at_entry, momentum_at_entry, status, current_price, peak_price,
         pnl_sol, pnl_percent, fees_paid_sol, net_pnl_sol)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [pos.id, pos.token_address, pos.token_symbol, pos.entry_price, pos.entry_sol,
       pos.entry_tx, pos.entry_time, pos.alpha_buy_time, pos.execution_lag_seconds,
       pos.signal_wallet, pos.signal_wallet_count, pos.capital_tier_at_entry,
       JSON.stringify(pos.momentum_at_entry), pos.status, pos.current_price, pos.peak_price,
       pos.pnl_sol, pos.pnl_percent, pos.fees_paid_sol, pos.net_pnl_sol],
    );

    logger.info({
      id: pos.id.slice(0, 8),
      token: tokenSymbol,
      price,
      sizeSol: positionSizeSol,
      tx: result.txSignature?.slice(0, 16),
      fees: result.feesSol.toFixed(6),
      executionLag: `${executionLag}s`,
    }, 'LIVE position opened');

    return pos;
  }

  /** Handle alpha wallet sell detection */
  async handleAlphaExit(tokenMint: string, walletAddress: string, sellPercentage: number): Promise<void> {
    for (const pos of this.positions.values()) {
      if (pos.token_address !== tokenMint || pos.status === PositionStatus.CLOSED) continue;

      const tier = pos.capital_tier_at_entry as CapitalTier;

      // MICRO/SMALL: alpha sells >30% → sell 100%
      if (tier === CapitalTier.MICRO || tier === CapitalTier.SMALL) {
        if (sellPercentage >= 0.30) {
          await this.closePosition(pos, `Alpha exit: ${walletAddress.slice(0, 8)} sold ${(sellPercentage * 100).toFixed(0)}%`);
          this.onAlphaExitTriggered?.(pos, walletAddress, sellPercentage);
        }
        return;
      }

      // MEDIUM: alpha sells >50% → sell 100%
      if (tier === CapitalTier.MEDIUM) {
        if (sellPercentage >= 0.50) {
          await this.closePosition(pos, `Alpha exit (MEDIUM): ${walletAddress.slice(0, 8)} sold ${(sellPercentage * 100).toFixed(0)}%`);
        } else if (sellPercentage >= 0.30) {
          // Partial sell 50%
          await this.executePartialSell(pos, 50, `Alpha partial: ${walletAddress.slice(0, 8)} sold ${(sellPercentage * 100).toFixed(0)}%`);
        }
        return;
      }

      // FULL: >70% → sell 100%, >30% → sell 50%
      if (tier === CapitalTier.FULL) {
        if (sellPercentage >= 0.70) {
          await this.closePosition(pos, `Alpha full exit: ${walletAddress.slice(0, 8)} sold ${(sellPercentage * 100).toFixed(0)}%`);
        } else if (sellPercentage >= 0.30) {
          await this.executePartialSell(pos, 50, `Alpha partial: ${walletAddress.slice(0, 8)} sold ${(sellPercentage * 100).toFixed(0)}%`);
        }
        return;
      }
    }
  }

  /** Scan wallet for tokens we think we hold — auto-drop if balance is 0 */
  private async scanWalletBalances(): Promise<void> {
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
          holdMins: Math.round((Date.now() - pos.entry_time.getTime()) / (1000 * 60)),
        }, 'Balance scan: token gone from wallet — auto-dropping position');

        pos.status = PositionStatus.CLOSED;
        pos.exit_reason = 'Manual sell detected (balance scan)';
        pos.closed_at = new Date();
        pos.hold_time_mins = Math.round((pos.closed_at.getTime() - pos.entry_time.getTime()) / (1000 * 60));

        await this.updatePosition(pos);

        if (this.onPositionClosed) {
          try { await this.onPositionClosed(pos); } catch (err) {
            logger.error({ err, posId: pos.id.slice(0, 8) }, 'Error in position close callback');
          }
        }

        if (this.onManualSellDetected) {
          try { this.onManualSellDetected(tokenName); } catch { /* ignore */ }
        }

        this.positions.delete(pos.id);
      } catch (err) {
        logger.error({ err, token: pos.token_symbol }, 'Balance scan failed for position');
      }
    }
  }

  /** Force close a position by token (for /kill command) */
  async forceClose(tokenIdentifier: string): Promise<{ success: boolean; token?: string; error?: string }> {
    // Match by symbol or address prefix
    const match = Array.from(this.positions.values()).find((p) =>
      p.status !== PositionStatus.CLOSED &&
      (p.token_symbol?.toLowerCase() === tokenIdentifier.toLowerCase() ||
       p.token_address.toLowerCase().startsWith(tokenIdentifier.toLowerCase())),
    );

    if (!match) {
      return { success: false, error: `No open position found for "${tokenIdentifier}"` };
    }

    await this.closePosition(match, 'Force close (/kill)');
    return { success: true, token: match.token_symbol || match.token_address.slice(0, 8) };
  }

  /** Remove a position from tracking without executing a sell (for manually-sold tokens) */
  async forceRemove(tokenIdentifier: string): Promise<{ success: boolean; token?: string; error?: string }> {
    const match = Array.from(this.positions.values()).find((p) =>
      p.status !== PositionStatus.CLOSED &&
      (p.token_symbol?.toLowerCase() === tokenIdentifier.toLowerCase() ||
       p.token_address.toLowerCase().startsWith(tokenIdentifier.toLowerCase())),
    );

    if (!match) {
      return { success: false, error: `No open position found for "${tokenIdentifier}"` };
    }

    match.status = PositionStatus.CLOSED;
    match.exit_reason = 'Manual sell — removed from tracking (/drop)';
    match.closed_at = new Date();
    match.hold_time_mins = Math.round((match.closed_at.getTime() - match.entry_time.getTime()) / (1000 * 60));

    await this.updatePosition(match);

    logger.info({
      id: match.id.slice(0, 8),
      token: match.token_symbol,
      holdMins: match.hold_time_mins,
    }, 'LIVE position DROPPED (manual sell)');

    if (this.onPositionClosed) {
      try { await this.onPositionClosed(match); } catch (err) {
        logger.error({ err, posId: match.id.slice(0, 8) }, 'Error in position close callback');
      }
    }

    this.positions.delete(match.id);
    return { success: true, token: match.token_symbol || match.token_address.slice(0, 8) };
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
        pos.pnl_sol = pos.entry_sol * pos.pnl_percent;
        pos.net_pnl_sol = pos.pnl_sol - pos.fees_paid_sol;

        await this.applyExitRules(pos);
        await this.updatePosition(pos);
      } catch (err) {
        logger.error({ err, posId: pos.id.slice(0, 8) }, 'Price check failed');
      }
    }
  }

  private async applyExitRules(pos: Position): Promise<void> {
    const tier = pos.capital_tier_at_entry as CapitalTier;
    const tierCfg = TIER_CONFIGS[tier];
    const pnl = pos.pnl_percent;
    const holdMins = (Date.now() - pos.entry_time.getTime()) / (1000 * 60);

    // Hard time kill from config
    if (holdMins >= tierCfg.hardTimeHours * 60) {
      await this.closePosition(pos, `Hard time kill (${tierCfg.hardTimeHours}h)`);
      return;
    }

    // Hard kill and stop loss from config
    if (pnl <= tierCfg.hardKill) { await this.closePosition(pos, `Hard kill (${(pnl * 100).toFixed(1)}%)`); return; }
    if (pnl <= tierCfg.stopLoss) { await this.closePosition(pos, `Stop loss (${(pnl * 100).toFixed(1)}%)`); return; }

    // Profit target (MICRO/SMALL — non-partial tiers)
    if (!tierCfg.partialExitsEnabled && pnl >= tierCfg.profitTarget) {
      await this.closePosition(pos, `Profit target (${(pnl * 100).toFixed(1)}%)`);
      return;
    }

    // Trailing stop after first partial (MEDIUM+)
    if (tierCfg.partialExitsEnabled && pos.partial_exits.length > 0 && pos.peak_price > 0) {
      const drawdown = (pos.peak_price - pos.current_price) / pos.peak_price;
      const trailPct = (tier === CapitalTier.FULL && pnl >= 0.50) ? 0.15 : 0.20;
      if (drawdown >= trailPct) {
        await this.closePosition(pos, `Trailing stop (${(drawdown * 100).toFixed(1)}% from peak)`);
        return;
      }
    }

    // Partial exits for MEDIUM+
    if (tierCfg.partialExitsEnabled) {
      if (tier === CapitalTier.FULL) {
        if (pnl >= 1.0 && pos.partial_exits.length < 3) {
          await this.executePartialSell(pos, 50, 'Partial 3 (+100%)');
        } else if (pnl >= 0.50 && pos.partial_exits.length < 2) {
          await this.executePartialSell(pos, 60, 'Partial 2 (+50%)');
        } else if (pnl >= 0.25 && pos.partial_exits.length < 1) {
          await this.executePartialSell(pos, 50, 'Partial 1 (+25%)');
        }
      } else if (tier === CapitalTier.MEDIUM) {
        if (pnl >= 0.60 && pos.partial_exits.length < 2) {
          await this.executePartialSell(pos, 50, 'Partial 2 (+60%)');
        } else if (pnl >= 0.30 && pos.partial_exits.length < 1) {
          await this.executePartialSell(pos, 50, 'Partial 1 (+30%)');
        }
      }
    }

    // Time kills from config — use the tier's configured windows
    for (const tk of tierCfg.timeKills) {
      if (holdMins >= tk.hours * 60 && pnl < tk.minPnlPct) {
        await this.closePosition(pos, `Time kill ${tk.hours}h (<${(tk.minPnlPct * 100).toFixed(0)}%)`);
        return;
      }
    }
  }

  /** Execute a partial sell (MEDIUM+ tiers) */
  private async executePartialSell(pos: Position, percent: number, reason: string): Promise<void> {
    const pair = await fetchDexPair(pos.token_address);
    const liquidityUsd = pair?.liquidity?.usd || 0;

    const result = await this.swapExecutor.sellToken(pos.token_address, liquidityUsd, percent);

    if (!result.success) {
      logger.error({ error: result.error, token: pos.token_symbol, percent }, 'Partial sell failed');
      return;
    }

    pos.fees_paid_sol += result.feesSol;
    pos.partial_exits.push({
      time: new Date(),
      pct: percent,
      price: pos.current_price,
      reason,
      txSignature: result.txSignature,
      solReceived: result.outputAmount / 1e9, // lamports to SOL
    } as Record<string, unknown>);
    pos.status = PositionStatus.PARTIAL_EXIT;

    await this.updatePosition(pos);

    logger.info({
      id: pos.id.slice(0, 8),
      token: pos.token_symbol,
      percent,
      reason,
      tx: result.txSignature?.slice(0, 16),
    }, 'Partial sell executed');
  }

  /** Close position fully — executes sell swap */
  private async closePosition(pos: Position, reason: string): Promise<void> {
    // Execute the actual sell swap with slippage escalation on retries
    const pair = await fetchDexPair(pos.token_address);
    const liquidityUsd = pair?.liquidity?.usd || 0;

    // Base slippage from liquidity, escalate on retries: +200bps per retry, cap at 1200bps (12%)
    const retryCount = pos.sell_retry_count || 0;
    const baseSlippage = liquidityUsd < 50_000
      ? config.jupiter.thinLiquiditySlippageBps
      : config.jupiter.defaultSlippageBps;
    const slippageBps = retryCount === 0
      ? baseSlippage
      : Math.min(baseSlippage + retryCount * 200, 1200);

    const result = await this.swapExecutor.sellToken(pos.token_address, liquidityUsd, 100, slippageBps);

    if (!result.success) {
      const errorMsg = result.error || 'Unknown';
      const isNoBalance = errorMsg.includes('No token balance') || errorMsg.includes('amount is zero');

      if (isNoBalance) {
        // Tokens are gone — force close as total loss
        logger.warn({ token: pos.token_symbol, reason }, 'EXIT sell — no token balance, force closing as loss');
        pos.net_pnl_sol = -pos.entry_sol - pos.fees_paid_sol;
        pos.pnl_percent = -1;
        // Fall through to close
      } else {
        pos.sell_retry_count = (pos.sell_retry_count || 0) + 1;
        const MAX_SELL_RETRIES = 5;

        if (pos.sell_retry_count >= MAX_SELL_RETRIES) {
          logger.error({ token: pos.token_symbol, retries: pos.sell_retry_count, reason }, 'EXIT sell failed after max retries — force closing');
          this.onSwapFailed?.(pos.token_symbol, `${errorMsg} (gave up after ${MAX_SELL_RETRIES} retries)`, 'SELL');
          pos.net_pnl_sol = -pos.entry_sol - pos.fees_paid_sol;
          pos.pnl_percent = -1;
          // Fall through to close
        } else {
          const nextBase = liquidityUsd < 50_000
            ? config.jupiter.thinLiquiditySlippageBps
            : config.jupiter.defaultSlippageBps;
          const nextSlippage = Math.min(nextBase + pos.sell_retry_count * 200, 1200);
          logger.error({ error: errorMsg, token: pos.token_symbol, retry: pos.sell_retry_count, nextSlippageBps: nextSlippage, reason }, 'EXIT sell failed — will retry with higher slippage');
          if (pos.sell_retry_count === 1) {
            this.onSwapFailed?.(pos.token_symbol, errorMsg, 'SELL');
          }
          return;
        }
      }
    } else {
      pos.fees_paid_sol += result.feesSol;

      // Calculate final P&L from actual SOL received
      const totalSolReceived = (result.outputAmount / 1e9) +
        pos.partial_exits.reduce((s, p) => s + (Number((p as Record<string, unknown>).solReceived) || 0), 0);
      pos.pnl_sol = totalSolReceived - pos.entry_sol;
      pos.net_pnl_sol = pos.pnl_sol - pos.fees_paid_sol;
      pos.pnl_percent = pos.entry_sol > 0 ? pos.pnl_sol / pos.entry_sol : 0;
    }

    pos.status = PositionStatus.CLOSED;
    pos.exit_reason = reason;
    pos.closed_at = new Date();
    pos.hold_time_mins = Math.round((pos.closed_at.getTime() - pos.entry_time.getTime()) / (1000 * 60));

    await this.updatePosition(pos);
    await this.updateWalletStats(pos);

    logger.info({
      id: pos.id.slice(0, 8),
      token: pos.token_symbol,
      pnl: `${(pos.pnl_percent * 100).toFixed(1)}%`,
      netPnl: `${pos.net_pnl_sol.toFixed(4)} SOL`,
      fees: `${pos.fees_paid_sol.toFixed(4)} SOL`,
      holdMins: pos.hold_time_mins,
      reason,
      tx: result.txSignature?.slice(0, 16),
    }, 'LIVE position CLOSED');

    if (this.onPositionClosed) {
      try {
        await this.onPositionClosed(pos);
      } catch (err) {
        logger.error({ err, posId: pos.id.slice(0, 8) }, 'Error in position close callback');
      }
    }

    this.positions.delete(pos.id);
  }

  private async updateWalletStats(pos: Position): Promise<void> {
    const isWin = pos.pnl_percent > 0;
    const wallets = [pos.signal_wallet]; // Live positions track the primary wallet

    for (const walletAddr of wallets) {
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

  private async updatePosition(pos: Position): Promise<void> {
    try {
      await query(
        `UPDATE positions SET
           current_price = $1, peak_price = $2, pnl_percent = $3, pnl_sol = $4,
           status = $5, exit_reason = $6, closed_at = $7, hold_time_mins = $8,
           partial_exits = $9, fees_paid_sol = $10, net_pnl_sol = $11
         WHERE id = $12`,
        [pos.current_price, pos.peak_price, pos.pnl_percent, pos.pnl_sol,
         pos.status, pos.exit_reason, pos.closed_at, pos.hold_time_mins,
         JSON.stringify(pos.partial_exits), pos.fees_paid_sol, pos.net_pnl_sol, pos.id],
      );
    } catch (err) {
      logger.error({ err, posId: pos.id.slice(0, 8) }, 'Failed to update position');
    }
  }

  async loadOpenPositions(): Promise<void> {
    const rows = await getMany<Record<string, unknown>>(
      `SELECT * FROM positions WHERE status IN ('OPEN', 'PARTIAL_EXIT')`,
    );

    for (const row of rows) {
      const pos: Position = {
        id: row.id as string,
        token_address: row.token_address as string,
        token_symbol: row.token_symbol as string,
        entry_price: Number(row.entry_price),
        entry_sol: Number(row.entry_sol),
        entry_tx: row.entry_tx as string,
        entry_time: new Date(row.entry_time as string),
        alpha_buy_time: new Date(row.alpha_buy_time as string),
        execution_lag_seconds: Number(row.execution_lag_seconds),
        signal_wallet: row.signal_wallet as string,
        signal_wallet_count: Number(row.signal_wallet_count),
        capital_tier_at_entry: row.capital_tier_at_entry as CapitalTier,
        confluence_score: row.confluence_score ? Number(row.confluence_score) : null,
        confluence_details: row.confluence_details as Record<string, unknown> | null,
        momentum_at_entry: (row.momentum_at_entry as Record<string, unknown>) || {},
        status: row.status as PositionStatus,
        current_price: Number(row.current_price),
        peak_price: Number(row.peak_price),
        pnl_sol: Number(row.pnl_sol),
        pnl_percent: Number(row.pnl_percent),
        fees_paid_sol: Number(row.fees_paid_sol),
        net_pnl_sol: Number(row.net_pnl_sol),
        exit_reason: null,
        partial_exits: (row.partial_exits as Record<string, unknown>[]) || [],
        closed_at: null,
        hold_time_mins: null,
        sell_retry_count: 0,
      };
      this.positions.set(pos.id, pos);
    }

    logger.info({ count: this.positions.size }, 'Loaded open LIVE positions');
  }

  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter((p) => p.status !== PositionStatus.CLOSED);
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
