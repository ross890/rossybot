import TelegramBot from 'node-telegram-bot-api';
import { config, TIER_CONFIGS, getTierForCapital, getTierConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getMany, getOne, query } from '../../db/database.js';
import type { PositionView } from '../../types/index.js';
import { CapitalTier } from '../../types/index.js';

export class TelegramService {
  private bot: TelegramBot;
  private chatId: string;
  private paused = false;

  // Callbacks for commands
  private onPause: (() => void) | null = null;
  private onResume: (() => void) | null = null;
  private onForceDiscovery: (() => void) | null = null;
  private getStatus: (() => Record<string, unknown>) | null = null;
  private getPositions: (() => PositionView[]) | null = null;
  private getWsHealth: (() => Record<string, unknown>) | null = null;
  private onKill: ((token: string) => Promise<{ success: boolean; token?: string; error?: string }>) | null = null;
  private onDrop: ((token: string) => Promise<{ success: boolean; token?: string; error?: string }>) | null = null;
  private onGraduationAnalysis: (() => Promise<{ tokensAnalyzed: number; walletsFound: number; walletsPromoted: number }>) | null = null;
  private onMarketAnalysis: ((force: boolean) => Promise<{ status: string; message: string; totalGraduated: number; tokensAnalyzed: number; newDiscoveries: number; durationSeconds: number }>) | null = null;
  private getPumpFunPositions: (() => Array<Record<string, unknown>>) | null = null;
  private onDiagnostics: (() => Promise<void>) | null = null;

  constructor() {
    this.bot = new TelegramBot(config.telegram.botToken, {
      polling: { autoStart: false },
    });
    this.chatId = config.telegram.chatId;
    this.bot.on('polling_error', (err) => {
      console.error(`Telegram polling error: ${err.message}`);
    });
    this.setupCommands();
  }

  async startPolling(): Promise<void> {
    try {
      await this.bot.startPolling();
      await this.setBotMenu();
      logger.info('Telegram bot polling started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Telegram polling — bot commands unavailable');
    }
  }

  // --- Callback setters ---
  setPauseCallback(cb: () => void): void { this.onPause = cb; }
  setResumeCallback(cb: () => void): void { this.onResume = cb; }
  setDiscoveryCallback(cb: () => void): void { this.onForceDiscovery = cb; }
  setStatusCallback(cb: () => Record<string, unknown>): void { this.getStatus = cb; }
  setPositionsCallback(cb: () => PositionView[]): void { this.getPositions = cb; }
  setWsHealthCallback(cb: () => Record<string, unknown>): void { this.getWsHealth = cb; }
  setKillCallback(cb: (token: string) => Promise<{ success: boolean; token?: string; error?: string }>): void { this.onKill = cb; }
  setDropCallback(cb: (token: string) => Promise<{ success: boolean; token?: string; error?: string }>): void { this.onDrop = cb; }
  setGraduationCallback(cb: () => Promise<{ tokensAnalyzed: number; walletsFound: number; walletsPromoted: number }>): void { this.onGraduationAnalysis = cb; }
  setMarketAnalysisCallback(cb: (force: boolean) => Promise<{ status: string; message: string; totalGraduated: number; tokensAnalyzed: number; newDiscoveries: number; durationSeconds: number }>): void { this.onMarketAnalysis = cb; }
  setPumpFunPositionsCallback(cb: () => Array<Record<string, unknown>>): void { this.getPumpFunPositions = cb; }
  setDiagnosticsCallback(cb: () => Promise<void>): void { this.onDiagnostics = cb; }

  get isPaused(): boolean { return this.paused; }

  // --- Alert methods ---

  async sendEntryAlert(data: {
    tokenSymbol: string;
    tokenMint: string;
    tier: string;
    wallets: string[];
    walletCount: number;
    totalMonitored: number;
    walletEv?: Array<{ address: string; trades: number; winRate: number; avgPnl: number; alphaScore?: number; nansenRoi?: number; nansenPnlUsd?: number; nansenTrades?: number }>;
    sizeSol: number;
    price: number;
    momentum24h: number;
    volumeMultiplier: number;
    mcap: number;
    liquidity: number;
    ageDays: number;
    detectionLagMs: number;
    executionLagSecs: number;
    profitTarget: number;
    stopLoss: number;
    hardTime: number;
    signalScore?: string;
    signalScoreBreakdown?: { walletQuality: number; momentum: number; mcapFit: number; liquidity: number; confluence: number; total: number };
    entryTx?: string;
    feesSol?: number;
    isLive?: boolean;
    curveFillPct?: number;
  }): Promise<void> {
    const walletLabels = data.wallets.map((w) => w.slice(0, 8)).join(' + ');
    const dexLink = `https://dexscreener.com/solana/${data.tokenMint}`;
    const modeTag = data.isLive ? '' : ' (SHADOW)';

    const evLines: string[] = [];
    if (data.walletEv && data.walletEv.length > 0) {
      for (const w of data.walletEv) {
        const addr = w.address.slice(0, 8);
        const hasNansen = (w.nansenRoi && w.nansenRoi > 0) || (w.nansenPnlUsd && w.nansenPnlUsd > 0);
        const nansenPart = w.nansenRoi && w.nansenRoi > 0
          ? `Nansen: ${w.nansenRoi.toFixed(0)}%ROI ${w.nansenTrades || '?'}t`
          : w.nansenPnlUsd && w.nansenPnlUsd > 0
            ? `Nansen: $${this.formatNum(w.nansenPnlUsd)} PnL`
            : '';
        const ourPart = w.trades > 0
          ? `Ours: ${w.trades}t ${(w.winRate * 100).toFixed(0)}%W EV ${w.avgPnl >= 0 ? '+' : ''}${w.avgPnl.toFixed(1)}%`
          : '';
        const alphaTag = w.alphaScore ? ` α${w.alphaScore}` : '';
        const stats = hasNansen
          ? nansenPart + (ourPart ? ` | ${ourPart}` : '') + alphaTag
          : ourPart ? ourPart + alphaTag : 'new (no data)';
        evLines.push(`│  ${addr}: ${stats}`);
      }
    }

    // Signal score breakdown for tuning feedback
    const scoreLines: string[] = [];
    if (data.signalScoreBreakdown) {
      const b = data.signalScoreBreakdown;
      scoreLines.push(`├ Score: ${b.total}/100 [W${b.walletQuality} M${b.momentum} C${b.mcapFit} L${b.liquidity} CF${b.confluence}]`);
    } else if (data.signalScore) {
      scoreLines.push(data.signalScore);
    }

    const msg = [
      `🟢 ENTRY: $${data.tokenSymbol} [${data.tier}]${modeTag}`,
      `├ Wallets: ${walletLabels} (${data.walletCount}/${data.totalMonitored} via Helius ✅)`,
      ...(evLines.length > 0 ? [`├ Wallet EV:`, ...evLines] : []),
      `├ Size: ${data.sizeSol.toFixed(2)} SOL @ $${data.price.toFixed(6)}`,
      ...(data.curveFillPct !== undefined ? [`├ Curve fill: ${(data.curveFillPct * 100).toFixed(0)}% at entry`] : []),
      `├ Momentum: ${data.momentum24h > 0 ? '+' : ''}${data.momentum24h.toFixed(0)}% (24h) | Vol ${data.volumeMultiplier.toFixed(1)}x avg`,
      `├ MCap: $${this.formatNum(data.mcap)} | Liq: $${this.formatNum(data.liquidity)} | Age: ${data.ageDays.toFixed(0)}d`,
      `├ Helius lag: ${(data.detectionLagMs / 1000).toFixed(1)}s | Exec: ${this.formatLag(data.executionLagSecs)}`,
      ...scoreLines,
      ...(data.feesSol ? [`├ Fees: ${data.feesSol.toFixed(4)} SOL`] : []),
      `├ Exit: TP +${(data.profitTarget * 100).toFixed(0)}%, SL ${(data.stopLoss * 100).toFixed(0)}%, alpha exit, ${data.hardTime}h max`,
      ...(data.entryTx ? [`├ TX: https://solscan.io/tx/${data.entryTx}`] : []),
      `└ ${dexLink}`,
    ].join('\n');

    await this.send(msg);
  }

  async sendOpportunityCostAlert(data: {
    tokenSymbol: string;
    tokenMint: string;
    signalScore: string;
    signalScoreValue?: number;
    currentPositionSymbol: string;
    currentPositionPnl: number;
    currentPositionHoldMins: number;
    walletCount?: number;
  }): Promise<void> {
    const dexLink = `https://dexscreener.com/solana/${data.tokenMint}`;
    const pnlSign = data.currentPositionPnl >= 0 ? '+' : '';
    const scoreTag = data.signalScoreValue ? ` (score ${data.signalScoreValue})` : '';
    const walletTag = data.walletCount ? ` | ${data.walletCount}w` : '';
    const msg = [
      `⚠️ SKIPPED (at max positions)${scoreTag}`,
      `├ Missed: $${data.tokenSymbol}${walletTag}`,
      data.signalScore,
      `├ Blocked by: $${data.currentPositionSymbol} (${pnlSign}${data.currentPositionPnl.toFixed(1)}%, hold ${this.formatHoldTime(data.currentPositionHoldMins)})`,
      `├ Action: consider /kill worst position if this keeps happening`,
      `└ ${dexLink}`,
    ].join('\n');

    await this.send(msg);
  }

  async sendAlphaExitAlert(data: {
    walletLabel: string;
    sellPct: number;
    tokenSymbol: string;
    detectionLagMs: number;
    action: string;
    pnlPercent: number;
    pnlSol: number;
    holdMins: number;
  }): Promise<void> {
    const msg = [
      `🚨 ALPHA EXIT: ${data.walletLabel} sold ${(data.sellPct * 100).toFixed(0)}% of $${data.tokenSymbol} [via Helius]`,
      `├ Detected in: ${(data.detectionLagMs / 1000).toFixed(1)} seconds`,
      `├ ACTION: ${data.action}`,
      `├ Net P&L: ${data.pnlSol >= 0 ? '+' : ''}${data.pnlSol.toFixed(3)} SOL (${data.pnlPercent >= 0 ? '+' : ''}${(data.pnlPercent * 100).toFixed(1)}%)`,
      `└ Hold: ${this.formatHoldTime(data.holdMins)}`,
    ].join('\n');

    await this.send(msg);
  }

  async sendProfitTargetAlert(data: {
    tokenSymbol: string;
    pnlPercent: number;
    entrySol: number;
    exitSol: number;
    netPnlSol: number;
    holdMins: number;
    capitalBefore: number;
    capitalAfter: number;
    feesSol?: number;
    entryTx?: string;
    isLive?: boolean;
    entryLagSecs?: number;
    curveFillAtEntry?: number;
    peakCurveFill?: number;
  }): Promise<void> {
    const curveLine = data.curveFillAtEntry !== undefined
      ? `├ Curve: ${(data.curveFillAtEntry * 100).toFixed(0)}%→peak ${((data.peakCurveFill ?? data.curveFillAtEntry) * 100).toFixed(0)}%`
      : '';
    const lagLine = data.entryLagSecs !== undefined ? `├ Entry lag: ${data.entryLagSecs.toFixed(0)}s` : '';

    const msg = [
      `💰 TARGET: $${data.tokenSymbol} +${(data.pnlPercent * 100).toFixed(0)}%`,
      `├ ${data.entrySol.toFixed(2)} SOL → ${data.exitSol.toFixed(3)} SOL | Net: +${data.netPnlSol.toFixed(3)} SOL`,
      ...(data.feesSol ? [`├ Fees: ${data.feesSol.toFixed(4)} SOL`] : []),
      `├ Hold: ${this.formatHoldTime(data.holdMins)}`,
      ...(curveLine ? [curveLine] : []),
      ...(lagLine ? [lagLine] : []),
      `└ Capital: ${data.capitalBefore.toFixed(2)} → ${data.capitalAfter.toFixed(2)} SOL`,
    ].join('\n');

    await this.send(msg);
  }

  async sendStopLossAlert(data: {
    tokenSymbol: string;
    pnlPercent: number;
    lossSol: number;
    holdMins: number;
    reason: string;
    feesSol?: number;
    isLive?: boolean;
    peakPnlPercent?: number;
    entryLagSecs?: number;
    curveFillAtEntry?: number;
    peakCurveFill?: number;
  }): Promise<void> {
    const peakLine = data.peakPnlPercent !== undefined && data.peakPnlPercent > 0
      ? `├ Peak: +${(data.peakPnlPercent * 100).toFixed(1)}% (missed TP by ${((data.peakPnlPercent - Math.abs(data.pnlPercent)) * 100).toFixed(1)}%)`
      : '';
    const lagLine = data.entryLagSecs !== undefined ? `├ Entry lag: ${data.entryLagSecs.toFixed(0)}s` : '';
    const curveLine = data.curveFillAtEntry !== undefined
      ? `├ Curve: ${(data.curveFillAtEntry * 100).toFixed(0)}%→peak ${((data.peakCurveFill ?? data.curveFillAtEntry) * 100).toFixed(0)}%`
      : '';

    const msg = [
      `🔴 EXIT: $${data.tokenSymbol} ${(data.pnlPercent * 100).toFixed(1)}%`,
      `├ Loss: ${data.lossSol.toFixed(3)} SOL`,
      ...(data.feesSol ? [`├ Fees: ${data.feesSol.toFixed(4)} SOL`] : []),
      `├ Hold: ${this.formatHoldTime(data.holdMins)}`,
      ...(peakLine ? [peakLine] : []),
      ...(curveLine ? [curveLine] : []),
      ...(lagLine ? [lagLine] : []),
      `└ Reason: ${data.reason}`,
    ].join('\n');

    await this.send(msg);
  }

  async sendWebSocketAlert(status: 'down' | 'restored', details: Record<string, unknown>): Promise<void> {
    if (status === 'down') {
      const msg = [
        `⚠️ HELIUS WEBSOCKET DOWN — entering fallback mode`,
        `├ Last message: ${details.lastMessageAgo || 'unknown'}`,
        `├ Reconnect attempts: ${details.attempts || 0}/${details.maxAttempts || 5}`,
        `├ Fallback: RPC polling every 15s`,
        `├ Entry rules tightened`,
        `└ Position sizes halved`,
      ].join('\n');
      await this.send(msg);
    } else {
      const msg = [
        `✅ HELIUS WEBSOCKET RESTORED — normal mode`,
        `├ Downtime: ${details.downtime || 'unknown'}`,
        `└ All subscriptions reconfirmed (${details.wallets || 0} wallets)`,
      ].join('\n');
      await this.send(msg);
    }
  }

  async sendTierChangeAlert(data: {
    oldTier: string;
    newTier: string;
    capitalSol: number;
    capitalUsd: number;
    changes: string;
  }): Promise<void> {
    const direction = data.newTier > data.oldTier ? '📈' : '📉';
    const msg = [
      `${direction} TIER ${data.newTier > data.oldTier ? 'UPGRADE' : 'DOWNGRADE'}: ${data.oldTier} → ${data.newTier}`,
      `├ Capital: ${data.capitalSol.toFixed(2)} SOL ($${data.capitalUsd.toFixed(0)})`,
      `└ Changes: ${data.changes}`,
    ].join('\n');

    await this.send(msg);
  }

  async sendDailySummary(data: {
    date: string;
    wins: number;
    losses: number;
    pnlSol: number;
    pnlPercent: number;
    capitalStart: number;
    capitalEnd: number;
    tier: string;
    feesSol: number;
    signalsSeen: number;
    signalsEntered: number;
    heliusUptime: number;
    heliusAvgLag: number;
    nansenCalls: number;
    nextTier: string;
    nextTierNeed: number;
  }): Promise<void> {
    const totalTrades = data.wins + data.losses;
    const wr = totalTrades > 0 ? (data.wins / totalTrades * 100).toFixed(0) : 'N/A';
    const conversion = data.signalsSeen > 0 ? (data.signalsEntered / data.signalsSeen * 100).toFixed(0) : 'N/A';

    // Pull extra edge metrics for the daily report
    let edgeLines: string[] = [];
    try {
      const edge = await getOne<Record<string, unknown>>(
        `SELECT
           COALESCE(AVG(pnl_percent) FILTER (WHERE pnl_percent > 0), 0) as avg_win,
           COALESCE(AVG(pnl_percent) FILTER (WHERE pnl_percent <= 0), 0) as avg_loss,
           COALESCE(AVG(hold_time_mins), 0) as avg_hold,
           COALESCE(AVG(EXTRACT(EPOCH FROM (entry_time - alpha_buy_time))), 0) as avg_lag
         FROM pumpfun_positions
         WHERE status = 'CLOSED' AND closed_at::date = '${data.date}'`,
      );
      if (edge) {
        const avgWin = (Number(edge.avg_win || 0) * 100).toFixed(1);
        const avgLoss = (Number(edge.avg_loss || 0) * 100).toFixed(1);
        const avgHold = Number(edge.avg_hold || 0).toFixed(0);
        const avgLag = Number(edge.avg_lag || 0).toFixed(0);
        edgeLines = [
          `├ Avg win: +${avgWin}% | Avg loss: ${avgLoss}%`,
          `├ Avg hold: ${avgHold}min | Avg alpha lag: ${avgLag}s`,
        ];
      }
    } catch { /* ignore */ }

    const msg = [
      `📊 DAILY — ${data.date}`,
      `├ Trades: ${data.wins}W/${data.losses}L (${wr}% WR)`,
      `├ P&L: ${data.pnlSol >= 0 ? '+' : ''}${data.pnlSol.toFixed(3)} SOL (${data.pnlPercent >= 0 ? '+' : ''}${(data.pnlPercent * 100).toFixed(0)}%)`,
      `├ Capital: ${data.capitalStart.toFixed(2)} → ${data.capitalEnd.toFixed(2)} SOL [${data.tier}]`,
      `├ Signals: ${data.signalsSeen} seen → ${data.signalsEntered} entered (${conversion}% conversion)`,
      ...edgeLines,
      `├ Fees: ${data.feesSol.toFixed(3)} SOL`,
      `├ Helius: ${data.heliusUptime.toFixed(1)}% uptime, avg ${(data.heliusAvgLag / 1000).toFixed(1)}s lag`,
      `├ Nansen: ${data.nansenCalls} calls`,
      `└ Next tier: ${data.nextTier} (need ${data.nextTierNeed >= 0 ? '+' : ''}${data.nextTierNeed.toFixed(2)} SOL)`,
    ].join('\n');

    await this.send(msg);
  }

  async sendSignalSkippedAlert(data: {
    walletLabel: string;
    tokenSymbol: string;
    reason: string;
  }): Promise<void> {
    await this.send(`⚠️ ${data.walletLabel} bought $${data.tokenSymbol} — skipped: ${data.reason}`);
  }

  async sendTradeDetected(data: {
    action: 'BUY' | 'SELL';
    walletAddress: string;
    walletLabel: string;
    tokenMint: string;
    tokenSymbol: string;
    amountUsd: number;
    detectionLagMs: number;
  }): Promise<void> {
    const icon = data.action === 'BUY' ? '🔵' : '🔴';
    const lag = (data.detectionLagMs / 1000).toFixed(1);
    const dexLink = `https://dexscreener.com/solana/${data.tokenMint}`;
    const msg = [
      `${icon} ${data.action} detected`,
      `├ Wallet: ${data.walletLabel} (${data.walletAddress.slice(0, 6)}...${data.walletAddress.slice(-4)})`,
      `├ Token: $${data.tokenSymbol} (${data.tokenMint.slice(0, 8)}...)`,
      `├ Amount: ~$${this.formatNum(data.amountUsd)}`,
      `├ Lag: ${lag}s`,
      `└ ${dexLink}`,
    ].join('\n');
    await this.send(msg);
  }

  async sendStartupDiagnostics(data: {
    summaryOnly?: boolean;
    version: string;
    shadowMode: boolean;
    capitalSol: number;
    tier: string;
    maxPositions: number;
    openPositions: number;
    wallets: Array<{
      address: string; label: string; tier: string; subscribed: boolean;
      nansenRoi: number; nansenPnl: number; nansenTrades: number;
      avgBuySizeSol: number; ourTrades: number; ourWinRate: number;
      ourAvgPnl: number; ourAvgHoldMins: number; alphaScore: number;
      consecutiveLosses: number; pumpfunOnly: boolean; dexSignals: number;
      source: string; lastActiveHours: number | null;
    }>;
    wsConnected: boolean;
    wsFallbackActive: boolean;
    wsSubscribedCount: number;
    nansenApiKey: boolean;
    nansenUsage: { callsLastMinute: number; maxPerMinute: number };
    heliusApiKey: boolean;
    telegramOk: boolean;
    dbConnected: boolean;
    tierConfig: {
      profitTarget: number;
      stopLoss: number;
      walletConfluence: number;
      confluenceWindow: number;
      hardTime: number;
      mcapRange: string;
      liquidityMin: number;
      partialExits: boolean;
    };
    pumpFunCurveProfitTarget: number;
    pumpFunCurveHardExit: number;
    pumpFunStaleTimeMins: number;
    pumpFunMinConviction: number;
    pumpFunConfluenceBonus: boolean;
    pumpFunPositionSizeMultiplier: number;
    pumpFunStopLoss: number;
    pumpFunMaxPositions: number;
    pumpFunMaxTokenAgeMins: number;
    pumpFunSlippageBps: number;
    minCapitalForStandardTrading: number;
    signalsToday: number;
    tradesAllTime: number;
    discoveryTokens: number;
    discoveryWalletsAdded: number;
    performance: {
      pumpFun: {
        total: number; wins: number; wr: number;
        avgWinPct: number; avgLossPct: number; netSol: number;
        totalFees: number; avgHoldMins: number; avgLagSecs: number;
        profitFactor: number; expectancySol: number;
      };
      exitReasons: Array<{ reason: string; total: number; wins: number; avgPnl: number; netSol: number }>;
      curveZones: Array<{ zone: string; total: number; wins: number; avgPnl: number; netSol: number }>;
      entryTypes: Array<{ type: string; total: number; wins: number; avgPnl: number; netSol: number }>;
      signalFunnel: { total: number; executed: number; skippedValidation: number; skippedMaxPos: number; skippedDaily: number };
      rejections: Array<{ reason: string; count: number }>;
      topWallets: Array<{ label: string; trades: number; wins: number; netSol: number; avgPnl: number; dexTrades: number }>;
      bottomWallets: Array<{ label: string; trades: number; wins: number; netSol: number; avgPnl: number; dexTrades: number }>;
      trend: { recentTrades: number; recentWins: number; recentSol: number; priorTrades: number; priorWins: number; priorSol: number };
      tierChanges: Array<{ from: string; to: string; capital: number; at: Date }>;
      graduation: {
        total: number; graduated: number; curveExits: number;
        curveWins: number; curveSol: number; curveAvgPnl: number;
        gradWins: number; gradSol: number; gradAvgPnl: number;
      };
      holdBuckets: Array<{ bucket: string; total: number; wins: number; avgPnl: number; netSol: number }>;
      hourly: Array<{ block: string; total: number; wins: number; netSol: number; avgPnl: number }>;
      edge: {
        bestTrade: number; worstTrade: number; bestPct: number; worstPct: number;
        totalFees: number; totalDeployed: number; currentStreak: number; streakWinning: boolean;
      };
    };
    activeConfig: {
      minSignalScore: number; positionSizePct: number;
      curveEntryMin: number; curveEntryMax: number; curveVelocityMin: number;
      deferredEntryEnabled: boolean; deferredEntryMaxWaitMs: number;
    };
  }): Promise<void> {
    const isPumpFunOnly = data.capitalSol < data.minCapitalForStandardTrading;

    // Summary mode: key metrics only (used at startup to reduce spam)
    if (data.summaryOnly) {
      const pf = data.performance.pumpFun;
      const trend = data.performance.trend;
      const edge = data.performance.edge;
      const pfWr = pf.total > 0 ? (pf.wr * 100).toFixed(0) : 'N/A';
      const pfFactor = pf.profitFactor > 0 ? pf.profitFactor.toFixed(2) : 'N/A';

      const lines = [
        `🤖 ROSSYBOT V2 — STARTUP`,
        ``,
        `┌─ STATUS`,
        `│ Mode: ${data.shadowMode ? '👻 SHADOW' : '💰 LIVE'} | ${data.wsConnected ? 'WS ✅' : data.wsFallbackActive ? 'WS ⚠️ fallback' : 'WS ❌'}`,
        `│ Capital: ${data.capitalSol.toFixed(4)} SOL [${data.tier}]`,
        `│ Positions: ${data.openPositions}/${data.pumpFunMaxPositions} | Wallets: ${data.wallets.length}`,
        `│`,
      ];

      if (pf.total > 0) {
        lines.push(
          `├─ PERFORMANCE (${pf.total} trades)`,
          `│ WR: ${pfWr}% | PF: ${pfFactor} | Net: ${pf.netSol >= 0 ? '+' : ''}${pf.netSol.toFixed(4)}◎`,
          `│ EV: ${pf.expectancySol >= 0 ? '+' : ''}${pf.expectancySol.toFixed(4)}◎/trade | Streak: ${edge.currentStreak}${edge.streakWinning ? 'W' : 'L'}`,
          `│`,
        );
      }

      // Top 3 exit reasons
      const topExits = data.performance.exitReasons.slice(0, 3);
      if (topExits.length > 0) {
        lines.push(`├─ TOP EXITS`);
        for (const r of topExits) {
          const rWr = r.total > 0 ? (r.wins / r.total * 100).toFixed(0) : '0';
          lines.push(`│ ${r.reason}: ${r.total}t ${rWr}%W ${r.netSol >= 0 ? '+' : ''}${r.netSol.toFixed(4)}◎`);
        }
        lines.push(`│`);
      }

      // 7d trend
      if (trend.recentTrades > 0) {
        const recentWr = (trend.recentWins / trend.recentTrades * 100).toFixed(0);
        const solDelta = trend.recentSol - trend.priorSol;
        lines.push(
          `├─ 7D TREND ${solDelta > 0 ? '📈' : '📉'}`,
          `│ This week: ${trend.recentTrades}t ${recentWr}%W ${trend.recentSol >= 0 ? '+' : ''}${trend.recentSol.toFixed(4)}◎`,
          `│`,
        );
      }

      lines.push(
        `└─ ✅ RUNNING`,
        ``,
        `💡 Use /diagnostics for full startup dump`,
      );

      await this.send(lines.join('\n'));
      return;
    }

    // --- Group wallets by quality tier for readability ---
    // Buckets based on estimated value: Nansen PnL + our data + alpha score
    type WalletBucket = { label: string; wallets: typeof data.wallets };
    const buckets: WalletBucket[] = [
      { label: '🟢 DEX ACTIVE (generated standard signals)', wallets: [] },
      { label: '🟡 HIGH VALUE (PnL $50K+ or α40+)', wallets: [] },
      { label: '🔵 UNPROVEN (new / no DEX signals yet)', wallets: [] },
      { label: '🔴 PF-ONLY / UNDERPERFORMING', wallets: [] },
    ];

    for (const w of data.wallets) {
      const hasLossStreak = w.consecutiveLosses >= 2;
      const lowAlpha = w.alphaScore > 0 && w.alphaScore < 20 && w.ourTrades >= 3;

      if (w.pumpfunOnly || hasLossStreak || lowAlpha) {
        buckets[3].wallets.push(w);
      } else if (w.dexSignals > 0) {
        buckets[0].wallets.push(w);
      } else if (w.nansenPnl >= 50_000 || w.alphaScore >= 40) {
        buckets[1].wallets.push(w);
      } else {
        buckets[2].wallets.push(w);
      }
    }

    // Sort DEX ACTIVE bucket by dex signal count (most active first)
    buckets[0].wallets.sort((a, b) => b.dexSignals - a.dexSignals);

    const formatWallet = (w: typeof data.wallets[0]): string => {
      const ws = w.subscribed ? '📡' : '⏸️';
      const mode = w.pumpfunOnly ? '🎰' : w.dexSignals > 0 ? '📊' : '';
      const parts: string[] = [];

      // DEX signal count (prioritized)
      if (w.dexSignals > 0) parts.push(`${w.dexSignals}dex`);

      // Nansen data
      if (w.nansenPnl > 0) parts.push(`$${this.formatNum(w.nansenPnl)}`);
      if (w.nansenRoi > 0) parts.push(`${w.nansenRoi.toFixed(0)}%ROI`);
      if (w.avgBuySizeSol > 0) parts.push(`avg${w.avgBuySizeSol.toFixed(1)}◎`);

      // Our data
      if (w.ourTrades > 0) {
        parts.push(`${w.ourTrades}t ${(w.ourWinRate * 100).toFixed(0)}%W`);
        if (w.ourAvgPnl !== 0) parts.push(`${(w.ourAvgPnl * 100).toFixed(0)}%avg`);
      }
      if (w.alphaScore > 0) parts.push(`α${w.alphaScore.toFixed(0)}`);
      if (w.consecutiveLosses > 0) parts.push(`🔥${w.consecutiveLosses}L`);

      // Recency
      if (w.lastActiveHours !== null) {
        if (w.lastActiveHours <= 1) parts.push('🕐<1h');
        else if (w.lastActiveHours <= 24) parts.push(`🕐${w.lastActiveHours}h`);
        else parts.push(`🕐${Math.round(w.lastActiveHours / 24)}d`);
      }

      const info = parts.join(' · ');
      return `│  ${ws}${mode} [${w.tier}] ${w.label.split(' |')[0].slice(0, 10)} ${info}`;
    };

    const walletSections: string[] = [];
    const subscribedCount = data.wallets.filter((w) => w.subscribed).length;
    const pfOnlyCount = data.wallets.filter((w) => w.pumpfunOnly).length;
    const dexActiveCount = data.wallets.filter((w) => w.dexSignals > 0 && !w.pumpfunOnly).length;
    const withBuySize = data.wallets.filter((w) => w.avgBuySizeSol > 0);
    const avgBuyAll = withBuySize.length > 0
      ? withBuySize.reduce((s, w) => s + w.avgBuySizeSol, 0) / withBuySize.length
      : 0;

    walletSections.push(
      `├─ WALLETS (${data.wallets.length} active, ${subscribedCount} WS, ${dexActiveCount} DEX, ${pfOnlyCount} PF-only${avgBuyAll > 0 ? `, avg bid ${avgBuyAll.toFixed(1)}◎` : ''})`,
    );

    for (const bucket of buckets) {
      if (bucket.wallets.length === 0) continue;
      walletSections.push(`│`);
      walletSections.push(`│ ${bucket.label} (${bucket.wallets.length})`);
      // Show top 5 per bucket, summarize rest
      const shown = bucket.wallets.slice(0, 5);
      const hidden = bucket.wallets.length - shown.length;
      for (const w of shown) {
        walletSections.push(formatWallet(w));
      }
      if (hidden > 0) {
        walletSections.push(`│  ... +${hidden} more`);
      }
    }
    walletSections.push(`│`);

    const msg: string[] = [
      `🤖 ROSSYBOT V2 — STARTUP DIAGNOSTICS`,
      ``,
      `┌─ SYSTEM`,
      `│ Version: ${data.version}`,
      `│ Mode: ${data.shadowMode ? '👻 SHADOW (no real trades)' : '💰 LIVE'}`,
      `│ Database: ${data.dbConnected ? '✅ Connected' : '❌ Down'}`,
      `│ Telegram: ${data.telegramOk ? '✅ Connected' : '❌ Down'}`,
      `│`,
      `├─ CAPITAL`,
      `│ Balance: ${data.capitalSol.toFixed(4)} SOL`,
      `│ Tier: ${data.tier}`,
      `│ Strategy: ${isPumpFunOnly ? 'PUMP.FUN CURVE SCALP ONLY' : 'FULL (Pump.fun + Raydium)'}`,
      `│ ${isPumpFunOnly ? `Standard trading unlocks at: ${data.minCapitalForStandardTrading} SOL` : 'Standard trading: ✅ ACTIVE'}`,
      `│`,
      `├─ HELIUS (Real-time)`,
      `│ API key: ${data.heliusApiKey ? '✅ Set' : '❌ Missing'}`,
      `│ WebSocket: ${data.wsConnected ? '✅ Connected' : '❌ Disconnected'}`,
      `│ Fallback mode: ${data.wsFallbackActive ? '⚠️ ACTIVE (RPC polling)' : '✅ Off'}`,
      `│ Subscribed wallets: ${data.wsSubscribedCount}`,
      `│`,
      `├─ NANSEN (Intelligence)`,
      `│ API key: ${data.nansenApiKey ? '✅ Set' : '❌ Missing'}`,
      `│ Rate: ${data.nansenUsage.callsLastMinute}/${data.nansenUsage.maxPerMinute} calls/min`,
      `│ Discovery schedule: every 4h`,
      `│ Last run: ${data.discoveryTokens} tokens screened, ${data.discoveryWalletsAdded} wallets added`,
      `│`,
      ...walletSections,
    ];

    if (isPumpFunOnly) {
      // Pump.fun curve scalp is our ONLY strategy at this capital level
      msg.push(
        `├─ STRATEGY: PUMP.FUN CURVE SCALP`,
        `│ Position size: ${(data.capitalSol * 0.30 * data.pumpFunPositionSizeMultiplier).toFixed(4)} SOL (30% × ${(data.pumpFunPositionSizeMultiplier * 100).toFixed(0)}% multiplier)`,
        `│ Max positions: ${data.pumpFunMaxPositions}`,
        `│ Open positions: ${data.openPositions}`,
        `│`,
        `│ ── ENTRY`,
        `│ Min conviction: ${data.pumpFunMinConviction} SOL (alpha wallet spend)`,
        `│ Max token age: ${data.pumpFunMaxTokenAgeMins}min`,
        `│ Confluence bonus: ${data.pumpFunConfluenceBonus ? 'YES (multi-wallet convergence)' : 'NO'}`,
        `│ Slippage: ${(data.pumpFunSlippageBps / 100).toFixed(0)}%`,
        `│`,
        `│ ── EXIT`,
        `│ Curve TP: ${(data.pumpFunCurveProfitTarget * 100).toFixed(0)}% fill`,
        `│ Curve hard exit: ${(data.pumpFunCurveHardExit * 100).toFixed(0)}% fill (pre-graduation)`,
        `│ Stop loss: ${(data.pumpFunStopLoss * 100).toFixed(0)}%`,
        `│ Stall timer: ${data.pumpFunStaleTimeMins}min (no movement → exit)`,
        `│ Post-graduation: IMMEDIATE 100% EXIT`,
        `│`,
      );
    } else {
      // Full strategy — show both standard entry/exit AND pump.fun
      msg.push(
        `├─ ENTRY RULES [${data.tier}]${data.shadowMode ? ' (shadow: relaxed)' : ''}`,
        `│ Confluence: ${data.shadowMode ? '1 (shadow override)' : data.tierConfig.walletConfluence} wallets within ${data.tierConfig.confluenceWindow}min`,
        `│ MCap range: ${data.tierConfig.mcapRange}`,
        `│ Min liquidity: $${this.formatNum(data.tierConfig.liquidityMin)}`,
        `│ Validation: RugCheck + DexScreener (<30s)${data.shadowMode ? ' (thresholds loosened)' : ''}`,
        `│`,
        `├─ EXIT RULES [${data.tier}]`,
        `│ Profit target: +${(data.tierConfig.profitTarget * 100).toFixed(0)}%`,
        `│ Stop loss: ${(data.tierConfig.stopLoss * 100).toFixed(0)}%`,
        `│ Hard time: ${data.tierConfig.hardTime}h`,
        `│ Partial exits: ${data.tierConfig.partialExits ? 'YES' : 'NO (fee-destructive at this tier)'}`,
        `│ Alpha exit: sell on wallet sell >30%`,
        `│`,
        `├─ PUMP.FUN STRATEGY: CURVE SCALP`,
        `│ Curve TP: ${(data.pumpFunCurveProfitTarget * 100).toFixed(0)}% fill`,
        `│ Curve hard exit: ${(data.pumpFunCurveHardExit * 100).toFixed(0)}% fill (pre-graduation)`,
        `│ Stall timer: ${data.pumpFunStaleTimeMins}min`,
        `│ Min conviction: ${data.pumpFunMinConviction} SOL`,
        `│ Confluence bonus: ${data.pumpFunConfluenceBonus ? 'YES' : 'NO'}`,
        `│ Post-grad: IMMEDIATE EXIT`,
        `│`,
      );
    }

    // --- PERFORMANCE DATA (for self-improving feedback loop) ---
    const pf = data.performance.pumpFun;
    const funnel = data.performance.signalFunnel;
    const trend = data.performance.trend;
    const cfg = data.activeConfig;
    const grad = data.performance.graduation;
    const edge = data.performance.edge;

    if (pf.total > 0) {
      const pfWr = (pf.wr * 100).toFixed(0);
      const pfFactor = pf.profitFactor > 0 ? pf.profitFactor.toFixed(2) : 'N/A';
      const holdStr = pf.avgHoldMins < 60 ? `${pf.avgHoldMins.toFixed(0)}m` : `${(pf.avgHoldMins / 60).toFixed(1)}h`;
      const avgLossAbs = Math.abs(pf.avgLossPct);
      const breakEvenWr = avgLossAbs > 0 ? (avgLossAbs / (pf.avgWinPct + avgLossAbs) * 100).toFixed(0) : 'N/A';
      const feeDrag = edge.totalDeployed > 0 ? (edge.totalFees / edge.totalDeployed * 100).toFixed(1) : '0';

      msg.push(
        `├─ PUMP.FUN PERFORMANCE (${pf.total} trades)`,
        `│ WR: ${pfWr}% (${pf.wins}W/${pf.total - pf.wins}L) | PF: ${pfFactor} | BE WR: ${breakEvenWr}%`,
        `│ Avg win: +${(pf.avgWinPct * 100).toFixed(1)}% | Avg loss: ${(pf.avgLossPct * 100).toFixed(1)}%`,
        `│ Net: ${pf.netSol >= 0 ? '+' : ''}${pf.netSol.toFixed(4)}◎ | EV: ${pf.expectancySol >= 0 ? '+' : ''}${pf.expectancySol.toFixed(4)}◎/trade`,
        `│ Fees: ${pf.totalFees.toFixed(4)}◎ (${feeDrag}% drag) | Deployed: ${edge.totalDeployed.toFixed(2)}◎`,
        `│ Avg hold: ${holdStr} | Avg lag: ${pf.avgLagSecs.toFixed(0)}s`,
        `│ Best: +${edge.bestTrade.toFixed(4)}◎ (+${(edge.bestPct * 100).toFixed(0)}%) | Worst: ${edge.worstTrade.toFixed(4)}◎ (${(edge.worstPct * 100).toFixed(0)}%)`,
        `│ Streak: ${edge.currentStreak}${edge.streakWinning ? 'W' : 'L'}`,
        `│`,
      );

      // Graduation funnel
      if (grad.total > 0) {
        const gradRate = (grad.graduated / grad.total * 100).toFixed(0);
        const curveWr = grad.curveExits > 0 ? (grad.curveWins / grad.curveExits * 100).toFixed(0) : '0';
        const gradWr = grad.graduated > 0 ? (grad.gradWins / grad.graduated * 100).toFixed(0) : '0';
        msg.push(
          `│ ── GRADUATION FUNNEL`,
          `│  ${grad.total} entries → ${grad.graduated} graduated (${gradRate}%)`,
          `│  On-curve: ${grad.curveExits}t ${curveWr}%W avg${(grad.curveAvgPnl * 100).toFixed(1)}% ${grad.curveSol >= 0 ? '+' : ''}${grad.curveSol.toFixed(4)}◎`,
          `│  Post-grad: ${grad.graduated}t ${gradWr}%W avg${(grad.gradAvgPnl * 100).toFixed(1)}% ${grad.gradSol >= 0 ? '+' : ''}${grad.gradSol.toFixed(4)}◎`,
          `│`,
        );
      }

      // Exit reason breakdown (group rare types with ≤2 trades into "Other")
      if (data.performance.exitReasons.length > 0) {
        msg.push(`│ ── EXIT REASONS`);
        const major = data.performance.exitReasons.filter(r => r.total > 2);
        const minor = data.performance.exitReasons.filter(r => r.total <= 2);
        for (const r of major) {
          const rWr = r.total > 0 ? (r.wins / r.total * 100).toFixed(0) : '0';
          msg.push(`│  ${r.reason}: ${r.total}t ${rWr}%W avg${(r.avgPnl * 100).toFixed(1)}% ${r.netSol >= 0 ? '+' : ''}${r.netSol.toFixed(4)}◎`);
        }
        if (minor.length > 0) {
          const otherTotal = minor.reduce((s, r) => s + r.total, 0);
          const otherNet = minor.reduce((s, r) => s + r.netSol, 0);
          msg.push(`│  Other (${minor.length} types): ${otherTotal}t ${otherNet >= 0 ? '+' : ''}${otherNet.toFixed(4)}◎`);
        }
        msg.push(`│`);
      }

      // Curve zone breakdown
      if (data.performance.curveZones.length > 0) {
        msg.push(`│ ── ENTRY CURVE ZONE`);
        for (const z of data.performance.curveZones) {
          const zWr = z.total > 0 ? (z.wins / z.total * 100).toFixed(0) : '0';
          msg.push(`│  ${z.zone}: ${z.total}t ${zWr}%W avg${(z.avgPnl * 100).toFixed(1)}% ${z.netSol >= 0 ? '+' : ''}${z.netSol.toFixed(4)}◎`);
        }
        msg.push(`│`);
      }

      // Hold time buckets
      if (data.performance.holdBuckets.length > 0) {
        msg.push(`│ ── HOLD TIME`);
        for (const h of data.performance.holdBuckets) {
          const hWr = h.total > 0 ? (h.wins / h.total * 100).toFixed(0) : '0';
          msg.push(`│  ${h.bucket}: ${h.total}t ${hWr}%W avg${(h.avgPnl * 100).toFixed(1)}% ${h.netSol >= 0 ? '+' : ''}${h.netSol.toFixed(4)}◎`);
        }
        msg.push(`│`);
      }

      // Entry type breakdown
      if (data.performance.entryTypes.length > 0) {
        msg.push(`│ ── ENTRY TYPE`);
        for (const e of data.performance.entryTypes) {
          const eWr = e.total > 0 ? (e.wins / e.total * 100).toFixed(0) : '0';
          msg.push(`│  ${e.type}: ${e.total}t ${eWr}%W ${e.netSol >= 0 ? '+' : ''}${e.netSol.toFixed(4)}◎`);
        }
        msg.push(`│`);
      }

      // Hourly heatmap
      if (data.performance.hourly.length > 0) {
        msg.push(`│ ── TIME OF DAY (UTC)`);
        for (const h of data.performance.hourly) {
          const hWr = h.total > 0 ? (h.wins / h.total * 100).toFixed(0) : '0';
          const bar = h.netSol >= 0 ? '█'.repeat(Math.min(Math.round(h.netSol * 20), 8)) : '░'.repeat(Math.min(Math.round(Math.abs(h.netSol) * 20), 8));
          msg.push(`│  ${h.block}: ${h.total}t ${hWr}%W ${h.netSol >= 0 ? '+' : ''}${h.netSol.toFixed(4)}◎ ${h.netSol >= 0 ? '🟢' : '🔴'}${bar}`);
        }
        msg.push(`│`);
      }
    }

    // Signal funnel
    if (funnel.total > 0) {
      const passRate = (funnel.executed / funnel.total * 100).toFixed(0);
      msg.push(
        `├─ SIGNAL FUNNEL (${funnel.total} total)`,
        `│ ${funnel.total} detected → ${funnel.executed} entered (${passRate}% pass)`,
        `│ Rejected: ${funnel.skippedValidation} validation, ${funnel.skippedMaxPos} max-pos, ${funnel.skippedDaily} daily-limit`,
      );
      if (data.performance.rejections.length > 0) {
        const rejStr = data.performance.rejections.map((r) => `${r.reason}:${r.count}`).join(' · ');
        msg.push(`│ Top rejects: ${rejStr}`);
      }
      msg.push(`│`);
    }

    // Wallet leaderboard (combined PF + DEX)
    if (data.performance.topWallets.length > 0) {
      msg.push(`├─ WALLET LEADERBOARD (PF+DEX combined)`);
      msg.push(`│ ── BEST (by SOL)`);
      for (const w of data.performance.topWallets) {
        const wWr = w.trades > 0 ? (w.wins / w.trades * 100).toFixed(0) : '0';
        const dex = w.dexTrades > 0 ? ` [${w.dexTrades}dex]` : '';
        msg.push(`│  ${w.label}: ${w.trades}t ${wWr}%W avg${(w.avgPnl * 100).toFixed(0)}% ${w.netSol >= 0 ? '+' : ''}${w.netSol.toFixed(4)}◎${dex}`);
      }
      if (data.performance.bottomWallets.length > 0) {
        msg.push(`│ ── WORST (by SOL)`);
        for (const w of data.performance.bottomWallets) {
          const wWr = w.trades > 0 ? (w.wins / w.trades * 100).toFixed(0) : '0';
          const dex = w.dexTrades > 0 ? ` [${w.dexTrades}dex]` : '';
          msg.push(`│  ${w.label}: ${w.trades}t ${wWr}%W avg${(w.avgPnl * 100).toFixed(0)}% ${w.netSol >= 0 ? '+' : ''}${w.netSol.toFixed(4)}◎${dex}`);
        }
      }
      msg.push(`│`);
    }

    // 7d trend
    if (trend.recentTrades > 0 || trend.priorTrades > 0) {
      const recentWr = trend.recentTrades > 0 ? (trend.recentWins / trend.recentTrades * 100).toFixed(0) : 'N/A';
      const priorWr = trend.priorTrades > 0 ? (trend.priorWins / trend.priorTrades * 100).toFixed(0) : 'N/A';
      const solDelta = trend.recentSol - trend.priorSol;
      const improving = solDelta > 0;
      msg.push(
        `├─ 7D TREND ${improving ? '📈' : '📉'}`,
        `│ This week: ${trend.recentTrades}t ${recentWr}%W ${trend.recentSol >= 0 ? '+' : ''}${trend.recentSol.toFixed(4)}◎`,
        `│ Last week: ${trend.priorTrades}t ${priorWr}%W ${trend.priorSol >= 0 ? '+' : ''}${trend.priorSol.toFixed(4)}◎`,
        `│ Delta: ${solDelta >= 0 ? '+' : ''}${solDelta.toFixed(4)}◎ ${improving ? '(improving)' : '(declining)'}`,
        `│`,
      );
    }

    // Tier history
    if (data.performance.tierChanges.length > 0) {
      msg.push(`├─ TIER HISTORY`);
      for (const t of data.performance.tierChanges) {
        const ago = Math.round((Date.now() - t.at.getTime()) / 3600000);
        const agoStr = ago < 24 ? `${ago}h ago` : `${Math.round(ago / 24)}d ago`;
        msg.push(`│ ${t.from} → ${t.to} at ${t.capital.toFixed(2)}◎ (${agoStr})`);
      }
      msg.push(`│`);
    }

    // Active tuning params (the knobs that matter)
    msg.push(
      `├─ ACTIVE TUNING PARAMS`,
      `│ Min signal score: ${cfg.minSignalScore}`,
      `│ Position size: ${(cfg.positionSizePct * 100).toFixed(0)}% of capital`,
      `│ Curve entry: ${(cfg.curveEntryMin * 100).toFixed(0)}%-${(cfg.curveEntryMax * 100).toFixed(0)}% fill`,
      `│ Curve velocity: ${cfg.curveVelocityMin} SOL/min`,
      `│ Stall timer: ${data.pumpFunStaleTimeMins}min`,
      `│ Conviction: ${data.pumpFunMinConviction}◎ min`,
      `│ TP: ${(data.pumpFunCurveProfitTarget * 100).toFixed(0)}% fill | SL: ${(data.pumpFunStopLoss * 100).toFixed(0)}%`,
      `│ Deferred: ${cfg.deferredEntryEnabled ? `ON (${(cfg.deferredEntryMaxWaitMs / 60000).toFixed(0)}min max)` : 'OFF'}`,
      `│ PF size mult: ${data.pumpFunPositionSizeMultiplier}x`,
      `│`,
    );

    msg.push(
      `├─ STATS`,
      `│ Signals today: ${data.signalsToday}`,
      `│ All-time trades: ${data.tradesAllTime}`,
      `│`,
      `└─ STATUS: ✅ RUNNING`,
      ``,
      `💡 Copy this message to Claude for tuning recommendations`,
    );

    // Split into chunks if too long for Telegram (4096 char limit)
    const fullMsg = msg.join('\n');
    for (const chunk of this.chunkMessage(fullMsg)) {
      await this.send(chunk);
    }
  }

  // --- Command handlers ---

  private async setBotMenu(): Promise<void> {
    const commands: TelegramBot.BotCommand[] = [
      { command: 'status', description: 'Quick snapshot + key config' },
      { command: 'config', description: 'All tunable params (copy for Claude)' },
      { command: 'edge', description: 'What\'s working / not working' },
      { command: 'pumpfun', description: 'Pump.fun dashboard' },
      { command: 'positions', description: 'Open positions with PnL' },
      { command: 'pnl', description: 'P&L + expectancy + profit factor' },
      { command: 'signals', description: 'Recent signals with scores' },
      { command: 'signaldump', description: 'Signal quality analytics (copy for Claude)' },
      { command: 'curve', description: 'Curve fill distribution analysis' },
      { command: 'tuning', description: 'Full tuning report (copy for Claude)' },
      { command: 'stats', description: 'Performance + signal stats (7d)' },
      { command: 'wallets', description: 'Alpha wallets + quality scores' },
      { command: 'pump_wallets', description: 'Pump.fun wallet roster & discovery' },
      { command: 'kill', description: 'Force close position' },
      { command: 'health', description: 'System health check' },
      { command: 'discover', description: 'Trigger wallet discovery' },
      { command: 'market', description: 'Pump.fun market analysis' },
      { command: 'graduation', description: 'Graduation retroanalysis' },
      { command: 'diagnostics', description: 'Full startup diagnostics dump' },
      { command: 'pause', description: 'Pause trading' },
      { command: 'resume', description: 'Resume trading' },
    ];
    try {
      await this.bot.setMyCommands(commands);
      logger.info(`Bot command menu set (${commands.length} commands)`);
    } catch (err) {
      logger.error({ err }, 'Failed to set bot command menu');
    }
  }

  private setupCommands(): void {
    this.bot.onText(/\/status/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const status = this.getStatus?.() || {};
      const capSol = status.capitalSol as number || 0;
      const tier = getTierForCapital(capSol);
      const tc = getTierConfig(tier);
      const isPumpOnly = capSol < config.minCapitalForStandardTrading;

      // Quick edge stats from recent trades
      let edgeLine = '';
      try {
        const edge = await getOne<Record<string, unknown>>(
          `SELECT COUNT(*) as total,
                  COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
                  COALESCE(AVG(pnl_percent), 0) as avg_pnl,
                  COALESCE(SUM(net_pnl_sol), 0) as net_sol
           FROM pumpfun_positions WHERE status = 'CLOSED' AND closed_at > NOW() - INTERVAL '24 hours'`,
        );
        const t = Number(edge?.total || 0);
        if (t > 0) {
          const w = Number(edge?.wins || 0);
          const wr = (w / t * 100).toFixed(0);
          const pnl = (Number(edge?.avg_pnl || 0) * 100).toFixed(1);
          const net = Number(edge?.net_sol || 0);
          edgeLine = `├ 24h: ${t}t ${wr}%W avg${pnl}% net${net >= 0 ? '+' : ''}${net.toFixed(4)}SOL`;
        }
      } catch { /* ignore */ }

      // Signal conversion rate
      let signalLine = '';
      try {
        const sig = await getOne<Record<string, unknown>>(
          `SELECT COUNT(*) as total,
                  COUNT(*) FILTER (WHERE action_taken = 'EXECUTED') as entered
           FROM signal_events WHERE first_detected_at > NOW() - INTERVAL '24 hours'`,
        );
        const sTotal = Number(sig?.total || 0);
        const sEntered = Number(sig?.entered || 0);
        if (sTotal > 0) {
          signalLine = `├ Signals 24h: ${sEntered}/${sTotal} entered (${(sEntered / sTotal * 100).toFixed(0)}% conversion)`;
        }
      } catch { /* ignore */ }

      const exposure = tc.positionSizePct * (status.openPositions as number || 0);
      const text = [
        `📍 STATUS`,
        `├ Capital: ${capSol.toFixed(2)} SOL [${status.tier || 'MICRO'}]`,
        `├ Mode: ${(status.isLive as boolean) ? '💰 LIVE' : '👻 SHADOW'} | ${isPumpOnly ? 'PUMP.FUN ONLY' : 'FULL'}`,
        `├ Positions: ${status.openPositions || 0}/${tc.maxPositions} (${(exposure * 100).toFixed(0)}% exposure)`,
        `├ WS: ${(status.wsConnected as boolean) ? '✅' : '❌'}${(status.wsFallback as boolean) ? ' FALLBACK' : ''} | Paused: ${this.paused ? 'YES' : 'NO'}`,
        `├ Sizing: ${(tc.positionSizePct * 100).toFixed(0)}% per pos | SL ${(tc.stopLoss * 100).toFixed(0)}% | TP +${(tc.profitTarget * 100).toFixed(0)}%`,
        `├ Pump.fun: entry ${(config.pumpFun.curveEntryMin * 100).toFixed(0)}-${(config.pumpFun.curveEntryMax * 100).toFixed(0)}% | TP ${(config.pumpFun.curveProfitTarget * 100).toFixed(0)}% | stale ${config.pumpFun.staleTimeKillMins}min`,
        `├ Min signal score: ${tc.minSignalScore} | WS slots: ${tc.walletsMonitored}`,
        ...(edgeLine ? [edgeLine] : []),
        ...(signalLine ? [signalLine] : []),
        `└ Daily P&L: ${status.dailyPnl || '0.00'} SOL`,
      ].join('\n');
      await this.bot.sendMessage(msg.chat.id, text);
    });

    this.bot.onText(/\/positions/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const positions = this.getPositions?.() || [];
      if (positions.length === 0) {
        await this.bot.sendMessage(msg.chat.id, '📭 No open positions');
        return;
      }
      const lines = positions.map((p) => {
        const pnl = (p.pnl_percent * 100).toFixed(1);
        const holdMins = Math.round((Date.now() - p.entry_time.getTime()) / 60000);
        const feeLine = p.fees_paid_sol > 0 ? ` | fees ${p.fees_paid_sol.toFixed(4)}` : '';
        return `${p.pnl_percent >= 0 ? '🟢' : '🔴'} $${p.token_symbol || p.token_address.slice(0, 8)} | ${pnl}% | ${this.formatHoldTime(holdMins)} | ${p.entry_sol.toFixed(2)} SOL${feeLine}`;
      });
      await this.bot.sendMessage(msg.chat.id, `📊 POSITIONS\n${lines.join('\n')}`);
    });

    this.bot.onText(/\/wallets(?!_)/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        const wallets = await getMany<Record<string, unknown>>(
          `SELECT address, label, tier, active, helius_subscribed, source,
                  COALESCE(our_win_rate, 0) as our_win_rate,
                  COALESCE(our_total_trades, 0) as our_total_trades,
                  COALESCE(our_avg_pnl_percent, 0) as our_avg_pnl_percent,
                  COALESCE(short_term_alpha_score, 0) as alpha_score,
                  COALESCE(consecutive_losses, 0) as consecutive_losses,
                  last_active_at
           FROM alpha_wallets WHERE active = TRUE
           ORDER BY helius_subscribed DESC, short_term_alpha_score DESC NULLS LAST, our_win_rate DESC`,
        );

        const subscribed = wallets.filter((w) => w.helius_subscribed).length;
        const status = this.getStatus?.() || {};
        const capSol = status.capitalSol as number || 0;
        const tier = getTierForCapital(capSol);
        const tc = getTierConfig(tier);

        const lines = wallets.map((w) => {
          const trades = Number(w.our_total_trades);
          const wr = trades > 0 ? `${(Number(w.our_win_rate) * 100).toFixed(0)}%W` : 'new';
          const pnl = trades > 0 ? `${(Number(w.our_avg_pnl_percent) * 100).toFixed(1)}%` : '';
          const alpha = Number(w.alpha_score);
          const alphaTag = alpha > 0 ? `α${alpha}` : '';
          const losses = Number(w.consecutive_losses);
          const streak = losses >= 2 ? `🔥${losses}L` : '';
          const statusIcon = w.helius_subscribed ? '📡' : '⏸️';

          // Recency
          let recency = '';
          if (w.last_active_at) {
            const ago = Math.round((Date.now() - new Date(w.last_active_at as string).getTime()) / 86400000);
            if (ago > 3) recency = ` ${ago}d`;
          }

          return `${statusIcon} [${w.tier}] ${w.label} | ${trades}t ${wr} ${pnl} ${alphaTag}${streak}${recency}`.trim();
        });

        const walletMsg = [
          `👛 WALLETS (${wallets.length} active, ${subscribed}/${tc.walletsMonitored} WS slots)`,
          ...lines,
          ``,
          `Legend: 📡=subscribed ⏸️=not subscribed | α=alpha score | 🔥=loss streak`,
        ].join('\n');
        for (const chunk of this.chunkMessage(walletMsg)) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load wallets');
      }
    });

    this.bot.onText(/\/diagnostics/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      if (!this.onDiagnostics) {
        await this.send('Diagnostics not available yet (bot still initializing)');
        return;
      }
      await this.send('Generating full diagnostics...');
      await this.onDiagnostics();
    });

    this.bot.onText(/\/pause/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      this.paused = true;
      this.onPause?.();
      await this.bot.sendMessage(msg.chat.id, '⏸️ Trading paused');
    });

    this.bot.onText(/\/resume/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      this.paused = false;
      this.onResume?.();
      await this.bot.sendMessage(msg.chat.id, '▶️ Trading resumed');
    });

    this.bot.onText(/\/stats/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        const stats = await getMany<Record<string, unknown>>(
          `SELECT * FROM daily_stats ORDER BY date DESC LIMIT 7`,
        );
        if (stats.length === 0) {
          await this.bot.sendMessage(msg.chat.id, '📊 No stats yet');
          return;
        }
        const totalPnl = stats.reduce((s, d) => s + Number(d.net_pnl_sol || 0), 0);
        const totalWins = stats.reduce((s, d) => s + Number(d.win_count || 0), 0);
        const totalLosses = stats.reduce((s, d) => s + Number(d.loss_count || 0), 0);
        const totalSignals = stats.reduce((s, d) => s + Number(d.signals_detected || 0), 0);
        const totalEntered = stats.reduce((s, d) => s + Number(d.trades_entered || 0), 0);
        const avgLag = stats.reduce((s, d) => s + Number(d.avg_execution_lag_secs || 0), 0) / stats.length;
        const totalFees = stats.reduce((s, d) => s + Number(d.total_fees_sol || 0), 0);
        const avgHeliusUptime = stats.reduce((s, d) => s + Number(d.helius_ws_uptime_percent || 0), 0) / stats.length;
        const wr = totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses) * 100).toFixed(0) : 'N/A';
        const conversion = totalSignals > 0 ? (totalEntered / totalSignals * 100).toFixed(0) : 'N/A';

        // Per-day breakdown for trend
        const dayLines = stats.slice(0, 5).map((d) => {
          const date = new Date(d.date as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const pnl = Number(d.net_pnl_sol || 0);
          const w = Number(d.win_count || 0);
          const l = Number(d.loss_count || 0);
          return `│ ${date}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL (${w}W/${l}L)`;
        });

        await this.bot.sendMessage(msg.chat.id, [
          `📊 STATS (${stats.length}d)`,
          `├ P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(3)} SOL`,
          `├ W/L: ${totalWins}/${totalLosses} (${wr}% WR)`,
          `├ Signals: ${totalSignals} seen → ${totalEntered} entered (${conversion}% conversion)`,
          `├ Avg execution lag: ${avgLag.toFixed(1)}s`,
          `├ Helius uptime: ${avgHeliusUptime.toFixed(1)}%`,
          `├ Total fees: ${totalFees.toFixed(4)} SOL`,
          `│`,
          `├─ DAILY TREND`,
          ...dayLines,
          `│`,
          `└ ${stats.length} days tracked`,
        ].join('\n'));
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load stats');
      }
    });

    this.bot.onText(/\/discover/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      this.onForceDiscovery?.();
      await this.bot.sendMessage(msg.chat.id, '🔍 Discovery cycle triggered');
    });

    this.bot.onText(/\/health/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const ws = this.getWsHealth?.() || {};
      const status = this.getStatus?.() || {};
      await this.bot.sendMessage(msg.chat.id, [
        `🏥 SYSTEM HEALTH`,
        `├ Mode: ${(status.isLive as boolean) ? '💰 LIVE' : '👻 SHADOW'}`,
        `├ WebSocket: ${(ws.connected as boolean) ? '✅ Connected' : '❌ Disconnected'}`,
        `├ Fallback: ${(ws.fallbackMode as boolean) ? '⚠️ ACTIVE' : '✅ Off'}`,
        `├ Subscribed: ${ws.subscribedWallets || 0} wallets`,
        `├ Last msg: ${ws.lastMessageAgoMs ? Math.round((ws.lastMessageAgoMs as number) / 1000) + 's ago' : '?'} | Last TX: ${(ws.lastTxAgoMs as number) > 0 ? Math.round((ws.lastTxAgoMs as number) / 1000) + 's ago' : 'none yet'}`,
        `├ WS msgs: ${ws.totalMessages || 0} total | ${ws.txNotifications || 0} txs`,
        `├ Positions: ${status.openPositions || 0}/${status.maxPositions || 2}`,
        `├ Capital: ${(status.capitalSol as number || 0).toFixed(2)} SOL [${status.tier || 'MICRO'}]`,
        `└ Paused: ${this.paused ? 'YES' : 'NO'}`,
      ].join('\n'));
    });

    this.bot.onText(/\/wallet add (.+)/, async (msg, match) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const parts = match?.[1]?.split(' ') || [];
      if (parts.length < 2) {
        await this.bot.sendMessage(msg.chat.id, 'Usage: /wallet add <address> <label>');
        return;
      }
      const [address, label] = parts;
      try {
        await query(
          `INSERT INTO alpha_wallets (address, label, source, tier, active) VALUES ($1, $2, 'MANUAL', 'B', TRUE) ON CONFLICT (address) DO UPDATE SET active = TRUE, label = $2`,
          [address, label],
        );
        await this.bot.sendMessage(msg.chat.id, `✅ Wallet ${label} (${address.slice(0, 8)}...) added`);
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, `❌ Failed to add wallet`);
      }
    });

    this.bot.onText(/\/kill (.+)/, async (msg, match) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const token = match?.[1];
      if (!token) {
        await this.bot.sendMessage(msg.chat.id, 'Usage: /kill <token_symbol_or_address>');
        return;
      }

      if (!this.onKill) {
        await this.bot.sendMessage(msg.chat.id, `🔪 Force close not available in shadow mode`);
        return;
      }

      await this.bot.sendMessage(msg.chat.id, `🔪 Force closing $${token}...`);
      try {
        const result = await this.onKill(token);
        if (result.success) {
          await this.bot.sendMessage(msg.chat.id, `✅ Force closed $${result.token}`);
        } else {
          await this.bot.sendMessage(msg.chat.id, `❌ ${result.error}`);
        }
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, `❌ Kill failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    });

    this.bot.onText(/\/drop (.+)/, async (msg, match) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const token = match?.[1];
      if (!token) {
        await this.bot.sendMessage(msg.chat.id, 'Usage: /drop <token_symbol_or_address>\nRemoves position from tracking without selling (for manually-sold tokens)');
        return;
      }

      if (!this.onDrop) {
        await this.bot.sendMessage(msg.chat.id, `🗑 Drop not available in shadow mode`);
        return;
      }

      await this.bot.sendMessage(msg.chat.id, `🗑 Dropping $${token} from tracking...`);
      try {
        const result = await this.onDrop(token);
        if (result.success) {
          await this.bot.sendMessage(msg.chat.id, `✅ Dropped $${result.token} — removed from tracking (no sell executed)`);
        } else {
          await this.bot.sendMessage(msg.chat.id, `❌ ${result.error}`);
        }
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, `❌ Drop failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    });

    this.bot.onText(/\/pnl/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        const open = this.getPositions?.() || [];
        const openCount = open.length;
        const unrealizedSol = open.reduce((s, p) => s + p.entry_sol * p.pnl_percent, 0);
        const unrealizedPct = open.length > 0
          ? open.reduce((s, p) => s + p.pnl_percent, 0) / open.length * 100
          : 0;

        // Query both tables for P&L data
        const isLive = !config.shadowMode;
        const tableName = isLive ? 'positions' : 'shadow_positions';
        const solColumn = isLive ? 'entry_sol' : 'simulated_entry_sol';

        const closed = await getOne<Record<string, unknown>>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COUNT(*) FILTER (WHERE pnl_percent <= 0) as losses,
             COALESCE(SUM(${solColumn} * pnl_percent), 0) as realized_sol,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COALESCE(AVG(pnl_percent) FILTER (WHERE pnl_percent > 0), 0) as avg_win_pnl,
             COALESCE(AVG(pnl_percent) FILTER (WHERE pnl_percent <= 0), 0) as avg_loss_pnl,
             COALESCE(SUM(${solColumn} * pnl_percent) FILTER (WHERE pnl_percent > 0), 0) as gross_win_sol,
             COALESCE(SUM(${solColumn} * pnl_percent) FILTER (WHERE pnl_percent <= 0), 0) as gross_loss_sol,
             COALESCE(AVG(hold_time_mins), 0) as avg_hold,
             COALESCE(AVG(hold_time_mins) FILTER (WHERE pnl_percent > 0), 0) as avg_hold_wins,
             COALESCE(AVG(hold_time_mins) FILTER (WHERE pnl_percent <= 0), 0) as avg_hold_losses,
             ${isLive ? 'COALESCE(SUM(fees_paid_sol), 0) as total_fees,' : ''}
             MIN(entry_time) as first_trade
           FROM ${tableName} WHERE status = 'CLOSED'`,
        );

        const total = Number(closed?.total || 0);
        const wins = Number(closed?.wins || 0);
        const losses = Number(closed?.losses || 0);
        const realizedSol = Number(closed?.realized_sol || 0);
        const avgPnl = Number(closed?.avg_pnl || 0);
        const avgWinPnl = Number(closed?.avg_win_pnl || 0);
        const avgLossPnl = Number(closed?.avg_loss_pnl || 0);
        const grossWinSol = Number(closed?.gross_win_sol || 0);
        const grossLossSol = Math.abs(Number(closed?.gross_loss_sol || 0));
        const avgHold = Number(closed?.avg_hold || 0);
        const avgHoldWins = Number(closed?.avg_hold_wins || 0);
        const avgHoldLosses = Number(closed?.avg_hold_losses || 0);
        const totalFees = isLive ? Number(closed?.total_fees || 0) : 0;
        const wr = total > 0 ? (wins / total * 100).toFixed(0) : 'N/A';
        const netSol = realizedSol + unrealizedSol;
        const profitFactor = grossLossSol > 0 ? (grossWinSol / grossLossSol).toFixed(2) : total > 0 ? 'inf' : 'N/A';
        const expectancy = total > 0 ? (realizedSol / total) : 0;
        const firstTrade = closed?.first_trade ? new Date(closed.first_trade as string) : null;
        const sinceStr = firstTrade
          ? firstTrade.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : 'N/A';

        const lines = [
          `📈 ${isLive ? 'LIVE' : 'SHADOW'} P&L`,
          `├ Open: ${openCount} | Unrealized: ${unrealizedSol >= 0 ? '+' : ''}${unrealizedSol.toFixed(3)} SOL (${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(1)}%)`,
          `├ Realized: ${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(3)} SOL (${total} trades)`,
          `├ Net: ${netSol >= 0 ? '+' : ''}${netSol.toFixed(3)} SOL`,
          `│`,
          `├ Win rate: ${wr}% (${wins}W / ${losses}L)`,
          `├ Avg win: +${(avgWinPnl * 100).toFixed(1)}% (hold ${this.formatHoldTime(avgHoldWins)})`,
          `├ Avg loss: ${(avgLossPnl * 100).toFixed(1)}% (hold ${this.formatHoldTime(avgHoldLosses)})`,
          `├ Profit factor: ${profitFactor} (${grossWinSol.toFixed(3)} / ${grossLossSol.toFixed(3)})`,
          `├ Expectancy: ${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(4)} SOL/trade`,
          `├ Avg PnL: ${(avgPnl * 100).toFixed(1)}% | Avg hold: ${this.formatHoldTime(avgHold)}`,
        ];

        if (totalFees > 0) {
          lines.push(`├ Total fees: ${totalFees.toFixed(4)} SOL`);
        }

        lines.push(`└ Since: ${sinceStr}`);

        await this.bot.sendMessage(msg.chat.id, lines.join('\n'));
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load PnL data');
      }
    });

    this.bot.onText(/\/graduation/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      if (!this.onGraduationAnalysis) {
        await this.bot.sendMessage(msg.chat.id, '❌ Graduation analysis not available');
        return;
      }
      await this.bot.sendMessage(msg.chat.id, '🎓 Running graduation retroanalysis (this takes a few minutes)...');
      try {
        const result = await this.onGraduationAnalysis();
        await this.bot.sendMessage(msg.chat.id,
          `🎓 GRADUATION ANALYSIS COMPLETE\n` +
          `├ Tokens analyzed: ${result.tokensAnalyzed}\n` +
          `├ Unique early buyers found: ${result.walletsFound}\n` +
          `└ New wallets promoted: ${result.walletsPromoted}`,
        );
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, '❌ Graduation analysis failed');
      }
    });

    this.bot.onText(/\/market\s*(force)?/, async (msg, match) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      if (!this.onMarketAnalysis) {
        await this.bot.sendMessage(msg.chat.id, '❌ Market analysis not available');
        return;
      }
      const force = match?.[1] === 'force';
      await this.bot.sendMessage(msg.chat.id,
        `📊 Running pump.fun market analysis${force ? ' (FORCE re-run)' : ''} — this takes several minutes. Report will be sent when complete...`);
      try {
        const result = await this.onMarketAnalysis(force);
        if (result.status === 'skipped') {
          await this.bot.sendMessage(msg.chat.id, `⏭️ ${result.message}`);
        } else if (result.status === 'empty') {
          await this.bot.sendMessage(msg.chat.id, `📭 ${result.message}`);
        } else {
          await this.bot.sendMessage(msg.chat.id,
            `✅ Market analysis complete (${result.durationSeconds}s)\n` +
            `├ Graduated tokens: ${result.totalGraduated}\n` +
            `├ Analyzed: ${result.tokensAnalyzed}\n` +
            `└ New discoveries: ${result.newDiscoveries}`);
        }
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, `❌ Market analysis failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    });

    this.bot.onText(/\/signals/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        const signals = await getMany<Record<string, unknown>>(
          `SELECT token_address, token_symbol, validation_result, validation_details, action_taken, first_detected_at, wallet_count, signal_score
           FROM signal_events ORDER BY first_detected_at DESC LIMIT 15`,
        );
        if (signals.length === 0) {
          await this.bot.sendMessage(msg.chat.id, '📭 No signals recorded yet');
          return;
        }

        const passed = signals.filter((s) => s.action_taken === 'EXECUTED').length;
        const lines = signals.map((s) => {
          const sym = s.token_symbol || (s.token_address as string).slice(0, 8);
          const icon = s.action_taken === 'EXECUTED' ? '✅' : '❌';
          const result = s.validation_result as string;
          const details = s.validation_details as Record<string, unknown> || {};

          let reason = result.replace('FAILED_', '');
          if (result === 'FAILED_MCAP' && details.mcap) {
            const mcapDetail = details.mcap as Record<string, unknown>;
            reason = `MCAP ($${this.formatNum(Number(mcapDetail.mcap || 0))})`;
          } else if (result === 'FAILED_LIQUIDITY' && details.liquidity) {
            const liqDetail = details.liquidity as Record<string, unknown>;
            reason = `LIQ ($${this.formatNum(Number(liqDetail.liquidityUsd || 0))})`;
          } else if (result === 'FAILED_MOMENTUM' && details.momentum) {
            const momDetail = details.momentum as Record<string, unknown>;
            reason = `MOM (${Number(momDetail.priceChange || 0).toFixed(0)}%)`;
          } else if (result === 'FAILED_SAFETY') {
            reason = 'SAFETY';
          } else if (result === 'FAILED_AGE') {
            reason = 'AGE';
          } else if (result === 'PASSED') {
            reason = 'PASSED';
          }

          const ago = Math.round((Date.now() - new Date(s.first_detected_at as string).getTime()) / 60000);
          const score = s.signal_score ? `S${Number(s.signal_score).toFixed(0)}` : '';
          return `${icon} $${sym} | ${reason} | ${score} | ${ago}m ago | ${s.wallet_count}w`;
        });

        const status = this.getStatus?.() || {};
        const capSol = status.capitalSol as number || 0;
        const tierCfg = getTierConfig(getTierForCapital(capSol));
        const signalMsg = [
          `🔍 SIGNALS (last ${signals.length}) — min score: ${tierCfg.minSignalScore}`,
          ...lines,
          `└ ${passed}/${signals.length} passed | Score key: S=signal score (0-100)`,
        ].join('\n');
        for (const chunk of this.chunkMessage(signalMsg)) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load signals');
      }
    });

    this.bot.onText(/\/pumpfun/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        // --- Open positions ---
        const openPositions = this.getPumpFunPositions?.() || [];
        const openLines = openPositions.length > 0
          ? openPositions.map((p) => {
              const holdMins = Math.round((Date.now() - new Date(p.entry_time as string).getTime()) / 60_000);
              const curvePct = ((p.current_curve_fill_pct as number) * 100).toFixed(0);
              const entryPct = ((p.curve_fill_pct_at_entry as number) * 100).toFixed(0);
              const pnl = ((p.pnl_percent as number) * 100).toFixed(1);
              const grad = p.graduated ? '🎓' : `📈${curvePct}%`;
              return `│  ${(p.pnl_percent as number) >= 0 ? '🟢' : '🔴'} ${p.token_symbol || (p.token_address as string).slice(0, 8)} | ${pnl}% | ${this.formatHoldTime(holdMins)} | curve ${entryPct}%→${grad}`;
            })
          : ['│  (none)'];

        // --- Closed stats from DB ---
        const closed = await getOne<Record<string, unknown>>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COUNT(*) FILTER (WHERE pnl_percent <= 0) as losses,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COALESCE(AVG(hold_time_mins), 0) as avg_hold,
             COUNT(*) FILTER (WHERE graduated = TRUE) as graduated_count,
             COUNT(*) FILTER (WHERE graduated = FALSE) as not_graduated
           FROM pumpfun_positions WHERE status = 'CLOSED'`,
        );

        const total = Number(closed?.total || 0);
        const wins = Number(closed?.wins || 0);
        const losses = Number(closed?.losses || 0);
        const avgPnl = Number(closed?.avg_pnl || 0);
        const avgHold = Number(closed?.avg_hold || 0);
        const gradCount = Number(closed?.graduated_count || 0);
        const notGrad = Number(closed?.not_graduated || 0);
        const wr = total > 0 ? (wins / total * 100).toFixed(0) : 'N/A';
        const gradRate = total > 0 ? (gradCount / total * 100).toFixed(0) : 'N/A';

        // --- Exit reason breakdown ---
        const exitReasons = await getMany<{ exit_reason: string; count: string }>(
          `SELECT exit_reason, COUNT(*) as count
           FROM pumpfun_positions WHERE status = 'CLOSED' AND exit_reason IS NOT NULL
           GROUP BY exit_reason ORDER BY count DESC LIMIT 8`,
        );
        const exitLines = exitReasons.map((r) => `│  ${r.count}x ${r.exit_reason}`);

        // --- Per-wallet performance on pump.fun ---
        const walletPerf = await getMany<Record<string, unknown>>(
          `SELECT w.label, w.address,
                  COUNT(*) as trades,
                  COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
                  COALESCE(AVG(p.pnl_percent), 0) as avg_pnl,
                  COUNT(*) FILTER (WHERE p.graduated = TRUE) as grads
           FROM pumpfun_positions p, unnest(p.signal_wallets) sw
           JOIN alpha_wallets w ON w.address = sw
           WHERE p.status = 'CLOSED'
           GROUP BY w.label, w.address
           ORDER BY avg_pnl DESC LIMIT 10`,
        );
        const walletLines = walletPerf.length > 0
          ? walletPerf.map((w) => {
              const t = Number(w.trades);
              const wn = Number(w.wins);
              const wr2 = t > 0 ? (wn / t * 100).toFixed(0) : '0';
              const pnl = (Number(w.avg_pnl) * 100).toFixed(1);
              return `│  ${w.label || (w.address as string).slice(0, 8)} | ${t}t ${wr2}%W | avg ${pnl}% | ${w.grads} grad`;
            })
          : ['│  (no data yet)'];

        // --- Entry type breakdown ---
        const entryTypesRaw = await getMany<Record<string, unknown>>(
          `SELECT COALESCE(entry_type, 'DIRECT') as entry_type, COUNT(*) as total,
                  COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
                  COALESCE(AVG(pnl_percent), 0) as avg_pnl
           FROM pumpfun_positions WHERE status = 'CLOSED'
           GROUP BY COALESCE(entry_type, 'DIRECT') ORDER BY total DESC`,
        );
        const entryTypeLines = entryTypesRaw.length > 0
          ? entryTypesRaw.map((et) => {
              const etT = Number(et.total);
              const etW = Number(et.wins);
              const etWr = etT > 0 ? (etW / etT * 100).toFixed(0) : '0';
              const etPnl = (Number(et.avg_pnl) * 100).toFixed(1);
              return `│  ${et.entry_type}: ${etT}t ${etWr}%W avg ${etPnl}%`;
            })
          : ['│  (all DIRECT)'];

        // --- Recent signals (accepted + rejected) ---
        const recentSignals = await getMany<Record<string, unknown>>(
          `SELECT token_address, status, pnl_percent, graduated, hold_time_mins, exit_reason, entry_time
           FROM pumpfun_positions ORDER BY entry_time DESC LIMIT 5`,
        );
        const recentLines = recentSignals.length > 0
          ? recentSignals.map((s) => {
              const ago = Math.round((Date.now() - new Date(s.entry_time as string).getTime()) / 60_000);
              const pnl = ((s.pnl_percent as number) * 100).toFixed(1);
              const icon = s.status === 'OPEN' ? '🔵' : (s.pnl_percent as number) >= 0 ? '🟢' : '🔴';
              const grad = s.graduated ? '🎓' : '';
              return `│  ${icon} ${(s.token_address as string).slice(0, 8)} | ${pnl}% | ${this.formatHoldTime(ago)} ago ${grad}${s.exit_reason ? ` | ${s.exit_reason}` : ''}`;
            })
          : ['│  (no trades yet)'];

        const response = [
          `🎰 PUMP.FUN DASHBOARD`,
          ``,
          `┌─ OPEN POSITIONS (${openPositions.length})`,
          ...openLines,
          `│`,
          `├─ PERFORMANCE (${total} closed)`,
          `│ Win rate: ${wr}% (${wins}W / ${losses}L)`,
          `│ Avg PnL: ${(avgPnl * 100).toFixed(1)}%`,
          `│ Avg hold: ${this.formatHoldTime(avgHold)}`,
          `│ Graduation rate: ${gradRate}% (${gradCount} graduated / ${notGrad} stalled)`,
          `│`,
          `├─ EXIT REASONS`,
          ...(exitLines.length > 0 ? exitLines : ['│  (no exits yet)']),
          `│`,
          `├─ ENTRY TYPES`,
          ...entryTypeLines,
          `│`,
          `├─ WALLET PERFORMANCE (pump.fun)`,
          ...walletLines,
          `│`,
          `├─ RECENT TRADES`,
          ...recentLines,
          `│`,
          `└─ Use this data to tune: conviction threshold, stale kill timing, curve entry zone`,
        ].join('\n');

        for (const chunk of this.chunkMessage(response)) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to generate pump.fun stats');
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load pump.fun stats');
      }
    });

    // /pump_wallets — dedicated view of pump.fun wallet roster with discovery paths
    this.bot.onText(/\/pump_wallets/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        // All pump.fun wallets (active + inactive) with performance and discovery source
        const wallets = await getMany<Record<string, unknown>>(
          `SELECT address, label, source, tier, active, helius_subscribed, pumpfun_only,
                  COALESCE(our_total_trades, 0) as our_total_trades,
                  COALESCE(our_win_rate, 0) as our_win_rate,
                  COALESCE(our_avg_pnl_percent, 0) as our_avg_pnl_percent,
                  COALESCE(our_avg_hold_time_mins, 0) as our_avg_hold_time_mins,
                  COALESCE(consecutive_losses, 0) as consecutive_losses,
                  COALESCE(short_term_alpha_score, 0) as alpha_score,
                  COALESCE(nansen_pnl_usd, 0) as nansen_pnl_usd,
                  COALESCE(avg_buy_size_sol, 0) as avg_buy_size_sol,
                  discovered_at, last_active_at
           FROM alpha_wallets
           WHERE pumpfun_only = TRUE
           ORDER BY active DESC, source, our_win_rate DESC`,
        );

        if (wallets.length === 0) {
          await this.bot.sendMessage(msg.chat.id, '📭 No pump.fun wallets found');
          return;
        }

        // --- Summary counts ---
        const active = wallets.filter((w) => w.active);
        const inactive = wallets.filter((w) => !w.active);
        const subscribed = active.filter((w) => w.helius_subscribed);
        const withTrades = wallets.filter((w) => Number(w.our_total_trades) > 0);
        const totalTrades = withTrades.reduce((s, w) => s + Number(w.our_total_trades), 0);
        const avgWr = withTrades.length > 0
          ? (withTrades.reduce((s, w) => s + Number(w.our_win_rate), 0) / withTrades.length * 100).toFixed(0)
          : 'N/A';

        // --- Group by discovery source ---
        const sourceMap: Record<string, typeof wallets> = {};
        for (const w of wallets) {
          const src = w.source as string;
          if (!sourceMap[src]) sourceMap[src] = [];
          sourceMap[src].push(w);
        }

        const sourceLabels: Record<string, string> = {
          PUMPFUN_SEED: '🌱 Pump.fun Seeds (manual)',
          GRADUATION_SEED: '🎓 Graduation Leaders (top profit)',
          PUMPFUN_DISCOVERY: '🔍 PumpPortal Discovery (auto)',
          GRADUATION_DISCOVERY: '🔎 Graduation Discovery (auto)',
          NANSEN_SEED: '📊 Nansen Seeds',
          NANSEN_DISCOVERY: '📊 Nansen Discovery',
          MANUAL: '✋ Manual',
        };

        // --- Per-source wallet lines ---
        const sourceBlocks: string[] = [];
        for (const [src, srcWallets] of Object.entries(sourceMap)) {
          const srcActive = srcWallets.filter((w) => w.active).length;
          const srcLabel = sourceLabels[src] || src;
          sourceBlocks.push(`├─ ${srcLabel} (${srcActive}/${srcWallets.length} active)`);

          for (const w of srcWallets) {
            const trades = Number(w.our_total_trades);
            const wr = trades > 0 ? `${(Number(w.our_win_rate) * 100).toFixed(0)}%` : '-';
            const pnl = trades > 0 ? `${(Number(w.our_avg_pnl_percent) * 100).toFixed(1)}%` : '-';
            const hold = trades > 0 ? this.formatHoldTime(Number(w.our_avg_hold_time_mins)) : '-';
            const losses = Number(w.consecutive_losses);
            const alpha = Number(w.alpha_score);
            const status = w.active ? (w.helius_subscribed ? '📡' : '⏸️') : '❌';
            const tierTag = `[${w.tier}]`;
            const streak = losses >= 2 ? ` 🔥${losses}L` : '';
            const alphaTag = alpha > 0 ? ` α${alpha}` : '';

            // Last active relative time
            let lastActiveStr = '';
            if (w.last_active_at) {
              const ago = Math.round((Date.now() - new Date(w.last_active_at as string).getTime()) / 86400000);
              lastActiveStr = ago === 0 ? ' (today)' : ago === 1 ? ' (1d ago)' : ` (${ago}d ago)`;
            }

            const label = w.label as string;
            const shortAddr = (w.address as string).slice(0, 6);
            const displayName = label.length > 20 ? `${label.slice(0, 20)}…` : label;

            sourceBlocks.push(
              `│  ${status} ${tierTag} ${displayName} [${shortAddr}] | ${trades}t ${wr}W ${pnl}pnl | hold ${hold}${streak}${alphaTag}${lastActiveStr}`,
            );
          }
          sourceBlocks.push(`│`);
        }

        // --- Pump.fun signal performance from positions ---
        const pfPerf = await getOne<Record<string, unknown>>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COUNT(*) FILTER (WHERE graduated = TRUE) as graduated
           FROM pumpfun_positions WHERE status = 'CLOSED'`,
        );
        const pfTotal = Number(pfPerf?.total || 0);
        const pfWins = Number(pfPerf?.wins || 0);
        const pfWr = pfTotal > 0 ? `${(pfWins / pfTotal * 100).toFixed(0)}%` : 'N/A';
        const pfPnl = (Number(pfPerf?.avg_pnl || 0) * 100).toFixed(1);
        const pfGrad = Number(pfPerf?.graduated || 0);

        // --- Discovery pipeline stats ---
        const recentDiscoveries = await getMany<Record<string, unknown>>(
          `SELECT address, label, source, discovered_at
           FROM alpha_wallets
           WHERE pumpfun_only = TRUE AND discovered_at > NOW() - INTERVAL '7 days'
           ORDER BY discovered_at DESC LIMIT 5`,
        );
        const recentLines = recentDiscoveries.length > 0
          ? recentDiscoveries.map((d) => {
              const ago = Math.round((Date.now() - new Date(d.discovered_at as string).getTime()) / 86400000);
              return `│  ${d.label} [${(d.address as string).slice(0, 6)}] via ${d.source} (${ago}d ago)`;
            })
          : ['│  (none in last 7d)'];

        const response = [
          `🎯 PUMP.FUN WALLETS`,
          ``,
          `┌─ OVERVIEW`,
          `│ Total: ${wallets.length} (${active.length} active, ${inactive.length} inactive)`,
          `│ Subscribed: ${subscribed.length}/${active.length} on Helius WS`,
          `│ With trades: ${withTrades.length} (${totalTrades} total trades, ${avgWr}% avg WR)`,
          `│`,
          `├─ SIGNAL PERFORMANCE (all pump.fun trades)`,
          `│ ${pfTotal} trades | WR ${pfWr} | Avg PnL ${pfPnl}% | ${pfGrad} graduated`,
          `│`,
          `├─ DISCOVERY PATHS`,
          ...Object.entries(sourceMap).map(([src, ws]) => {
            const label = sourceLabels[src] || src;
            const act = ws.filter((w) => w.active).length;
            return `│  ${label}: ${act}/${ws.length}`;
          }),
          `│`,
          ...sourceBlocks,
          `├─ RECENT DISCOVERIES (7d)`,
          ...recentLines,
          `│`,
          `└─ /pumpfun for trade dashboard · /wallets for all wallets`,
        ].join('\n');

        for (const chunk of this.chunkMessage(response)) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to generate pump wallets view');
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load pump wallets');
      }
    });

    this.bot.onText(/\/curve/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        // Histogram buckets for peak curve fill distribution
        const buckets = await getMany<{ bucket: string; count: string; avg_pnl: string; wins: string }>(
          `SELECT
             CASE
               WHEN peak_curve_fill_pct < 0.10 THEN '0-10%'
               WHEN peak_curve_fill_pct < 0.20 THEN '10-20%'
               WHEN peak_curve_fill_pct < 0.30 THEN '20-30%'
               WHEN peak_curve_fill_pct < 0.40 THEN '30-40%'
               WHEN peak_curve_fill_pct < 0.50 THEN '40-50%'
               WHEN peak_curve_fill_pct < 0.60 THEN '50-60%'
               WHEN peak_curve_fill_pct < 0.70 THEN '60-70%'
               WHEN peak_curve_fill_pct < 0.80 THEN '70-80%'
               WHEN peak_curve_fill_pct < 0.90 THEN '80-90%'
               ELSE '90-100%'
             END as bucket,
             COUNT(*) as count,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins
           FROM pumpfun_positions
           WHERE status = 'CLOSED' AND peak_curve_fill_pct > 0
           GROUP BY bucket
           ORDER BY bucket`,
        );

        // Summary stats
        const summary = await getOne<Record<string, unknown>>(
          `SELECT
             COUNT(*) as total,
             COALESCE(AVG(peak_curve_fill_pct), 0) as avg_peak,
             COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY peak_curve_fill_pct), 0) as median_peak,
             COALESCE(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY peak_curve_fill_pct), 0) as p75_peak,
             COALESCE(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY peak_curve_fill_pct), 0) as p25_peak,
             COUNT(*) FILTER (WHERE graduated = TRUE) as graduated,
             COALESCE(AVG(peak_curve_fill_pct) FILTER (WHERE pnl_percent > 0), 0) as avg_peak_wins,
             COALESCE(AVG(peak_curve_fill_pct) FILTER (WHERE pnl_percent <= 0), 0) as avg_peak_losses
           FROM pumpfun_positions
           WHERE status = 'CLOSED' AND peak_curve_fill_pct > 0`,
        );

        const total = Number(summary?.total || 0);
        if (total === 0) {
          await this.bot.sendMessage(msg.chat.id, '📭 No peak curve data yet — need trades with new tracking');
          return;
        }

        const avgPeak = (Number(summary?.avg_peak || 0) * 100).toFixed(0);
        const medianPeak = (Number(summary?.median_peak || 0) * 100).toFixed(0);
        const p25 = (Number(summary?.p25_peak || 0) * 100).toFixed(0);
        const p75 = (Number(summary?.p75_peak || 0) * 100).toFixed(0);
        const gradCount = Number(summary?.graduated || 0);
        const avgPeakWins = (Number(summary?.avg_peak_wins || 0) * 100).toFixed(0);
        const avgPeakLosses = (Number(summary?.avg_peak_losses || 0) * 100).toFixed(0);

        // Build histogram bars
        const maxCount = Math.max(...buckets.map((b) => Number(b.count)));
        const histLines = buckets.map((b) => {
          const count = Number(b.count);
          const barLen = maxCount > 0 ? Math.round((count / maxCount) * 10) : 0;
          const bar = '█'.repeat(barLen) + '░'.repeat(10 - barLen);
          const wr = count > 0 ? `${((Number(b.wins) / count) * 100).toFixed(0)}%W` : '-';
          const pnl = (Number(b.avg_pnl) * 100).toFixed(0);
          return `│ ${b.bucket.padEnd(7)} ${bar} ${String(count).padStart(3)} (${wr}, ${pnl}%avg)`;
        });

        const lines = [
          `📊 CURVE DISTRIBUTION (${total} trades)`,
          ``,
          `┌─ PEAK CURVE FILL HISTOGRAM`,
          ...histLines,
          `│`,
          `├─ PERCENTILES`,
          `│ Median: ${medianPeak}% · Mean: ${avgPeak}%`,
          `│ P25: ${p25}% · P75: ${p75}%`,
          `│ Graduated: ${gradCount}/${total} (${total > 0 ? (gradCount / total * 100).toFixed(0) : 0}%)`,
          `│`,
          `├─ WINS vs LOSSES`,
          `│ Avg peak (wins): ${avgPeakWins}%`,
          `│ Avg peak (losses): ${avgPeakLosses}%`,
          `│`,
          `└─ Use median (${medianPeak}%) as baseline for TP threshold`,
        ];

        await this.bot.sendMessage(msg.chat.id, lines.join('\n'));
      } catch (err) {
        logger.error({ err }, 'Failed to generate curve analysis');
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load curve data');
      }
    });

    // /tuning — comprehensive tuning report across ALL position types
    this.bot.onText(/\/tuning/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        // Determine which tables to query based on mode
        const isLive = !config.shadowMode;
        const dexTable = isLive ? 'positions' : 'shadow_positions';
        const dexSolCol = isLive ? 'entry_sol' : 'simulated_entry_sol';
        const dexNetPnlExpr = isLive ? 'net_pnl_sol' : `(${dexSolCol} * pnl_percent)`;
        const dexFeesExpr = isLive ? 'fees_paid_sol' : '0';

        // Get current config for context
        const cfgStatus = this.getStatus?.() || {};
        const cfgCapSol = cfgStatus.capitalSol as number || 0;
        const cfgTier = getTierForCapital(cfgCapSol);
        const cfgTc = getTierConfig(cfgTier);
        const pf = config.pumpFun;

        // ── SECTION 1: COMBINED OVERVIEW (all tables) ──
        const dexOverall = await getOne<Record<string, unknown>>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COALESCE(SUM(${dexNetPnlExpr}), 0) as net_sol,
             COALESCE(SUM(${dexFeesExpr}), 0) as fees,
             COALESCE(AVG(hold_time_mins), 0) as avg_hold,
             COALESCE(AVG(EXTRACT(EPOCH FROM (entry_time - alpha_buy_time))), 0) as avg_lag
           FROM ${dexTable} WHERE status = 'CLOSED'`,
        );

        const pfOverall = await getOne<Record<string, unknown>>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COALESCE(SUM(net_pnl_sol), 0) as net_sol,
             COALESCE(SUM(fees_paid_sol), 0) as fees,
             COALESCE(AVG(hold_time_mins), 0) as avg_hold,
             COALESCE(AVG(EXTRACT(EPOCH FROM (entry_time - alpha_buy_time))), 0) as avg_lag,
             COALESCE(AVG(curve_fill_pct_at_entry), 0) as avg_entry_curve,
             COALESCE(AVG(peak_curve_fill_pct), 0) as avg_peak_curve,
             COUNT(*) FILTER (WHERE graduated = TRUE) as graduated
           FROM pumpfun_positions WHERE status = 'CLOSED'`,
        );

        const dexTotal = Number(dexOverall?.total || 0);
        const pfTotal = Number(pfOverall?.total || 0);
        const grandTotal = dexTotal + pfTotal;

        if (grandTotal === 0) {
          await this.bot.sendMessage(msg.chat.id, '📭 No closed trades yet');
          return;
        }

        const dexWins = Number(dexOverall?.wins || 0);
        const pfWins = Number(pfOverall?.wins || 0);
        const grandWins = dexWins + pfWins;
        const grandLosses = grandTotal - grandWins;
        const grandWr = (grandWins / grandTotal * 100).toFixed(0);
        const dexNetSol = Number(dexOverall?.net_sol || 0);
        const pfNetSol = Number(pfOverall?.net_sol || 0);
        const grandNetSol = dexNetSol + pfNetSol;
        const dexFees = Number(dexOverall?.fees || 0);
        const pfFees = Number(pfOverall?.fees || 0);
        const grandFees = dexFees + pfFees;

        // ── SECTION 2: DEX TRADES (positions/shadow_positions) ──
        const dexByTier = await getMany<Record<string, unknown>>(
          `SELECT
             capital_tier${isLive ? '_at_entry' : ''} as tier,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COALESCE(SUM(${dexNetPnlExpr}), 0) as net_sol,
             COALESCE(AVG(hold_time_mins), 0) as avg_hold
           FROM ${dexTable} WHERE status = 'CLOSED'
           GROUP BY 1 ORDER BY total DESC`,
        );

        const dexTierLines = dexByTier.map((t) => {
          const tTotal = Number(t.total);
          const tWins = Number(t.wins);
          const tWr = tTotal > 0 ? (tWins / tTotal * 100).toFixed(0) : '0';
          const tPnl = (Number(t.avg_pnl) * 100).toFixed(1);
          const tSol = Number(t.net_sol).toFixed(4);
          const tHold = Number(t.avg_hold).toFixed(0);
          return `│ ${t.tier}: ${tTotal}t ${tWr}%W avg${tPnl}% ${tSol}SOL hold${tHold}m`;
        });

        const dexExitReasons = await getMany<Record<string, unknown>>(
          `SELECT exit_reason, COUNT(*) as total,
                  COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
                  COALESCE(AVG(pnl_percent), 0) as avg_pnl
           FROM ${dexTable} WHERE status = 'CLOSED' AND exit_reason IS NOT NULL
           GROUP BY exit_reason ORDER BY total DESC LIMIT 10`,
        );

        const dexExitLines = this.compressExitReasons(dexExitReasons);

        // DEX alpha lag
        const dexLag = await getMany<Record<string, unknown>>(
          `SELECT
             CASE
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 5 THEN '<5s'
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 15 THEN '5-15s'
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 30 THEN '15-30s'
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 60 THEN '30-60s'
               ELSE '60s+'
             END as lag_bucket,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl
           FROM ${dexTable} WHERE status = 'CLOSED'
           GROUP BY lag_bucket ORDER BY lag_bucket`,
        );

        const dexLagLines = dexLag.map((l) => {
          const lTotal = Number(l.total);
          const lWins = Number(l.wins);
          const lWr = lTotal > 0 ? (lWins / lTotal * 100).toFixed(0) : '0';
          const lPnl = (Number(l.avg_pnl) * 100).toFixed(1);
          return `│ ${(l.lag_bucket as string).padEnd(6)} ${String(lTotal).padStart(3)}t ${lWr}%W avg${lPnl}%`;
        });

        // DEX recent trades
        const dexRecent = await getMany<Record<string, unknown>>(
          `SELECT token_address, token_symbol, pnl_percent, ${dexNetPnlExpr} as net_pnl_sol,
                  hold_time_mins, exit_reason, capital_tier${isLive ? '_at_entry' : ''} as tier,
                  EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) as alpha_lag_secs
           FROM ${dexTable} WHERE status = 'CLOSED'
           ORDER BY closed_at DESC LIMIT 10`,
        );

        const dexRecentLines = dexRecent.map((r) => {
          const rPnl = (Number(r.pnl_percent) * 100).toFixed(1);
          const icon = Number(r.pnl_percent) > 0 ? '✅' : '❌';
          const sym = r.token_symbol || (r.token_address as string).slice(0, 6);
          const lag = Number(r.alpha_lag_secs || 0).toFixed(0);
          const hold = Number(r.hold_time_mins || 0);
          const sol = Number(r.net_pnl_sol || 0).toFixed(4);
          return `│ ${icon} $${sym} ${rPnl}% ${sol}SOL ${hold}m lag${lag}s ${r.exit_reason || ''} [${r.tier}]`;
        });

        // ── SECTION 3: PUMP.FUN TRADES ──
        // Entry type breakdown
        const pfEntryTypes = await getMany<Record<string, unknown>>(
          `SELECT
             COALESCE(entry_type, 'DIRECT') as entry_type,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COALESCE(SUM(net_pnl_sol), 0) as total_pnl_sol,
             COALESCE(AVG(hold_time_mins), 0) as avg_hold,
             COALESCE(AVG(peak_curve_fill_pct), 0) as avg_peak,
             COALESCE(AVG(EXTRACT(EPOCH FROM (entry_time - alpha_buy_time))), 0) as avg_lag
           FROM pumpfun_positions WHERE status = 'CLOSED'
           GROUP BY COALESCE(entry_type, 'DIRECT')
           ORDER BY total DESC`,
        );

        const pfEntryTypeLines = pfEntryTypes.map((et) => {
          const etTotal = Number(et.total);
          const etWins = Number(et.wins);
          const etWr = etTotal > 0 ? (etWins / etTotal * 100).toFixed(0) : '0';
          const etPnl = (Number(et.avg_pnl) * 100).toFixed(1);
          const etSol = Number(et.total_pnl_sol).toFixed(4);
          const etHold = Number(et.avg_hold).toFixed(0);
          const etPeak = (Number(et.avg_peak) * 100).toFixed(0);
          const etLag = Number(et.avg_lag).toFixed(0);
          return `│ ${et.entry_type}: ${etTotal}t ${etWr}%W avg${etPnl}% ${etSol}SOL hold${etHold}m peak${etPeak}% lag${etLag}s`;
        });

        // Pump.fun exit reasons
        const pfExitReasons = await getMany<Record<string, unknown>>(
          `SELECT exit_reason, COUNT(*) as total,
                  COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
                  COALESCE(AVG(pnl_percent), 0) as avg_pnl
           FROM pumpfun_positions WHERE status = 'CLOSED' AND exit_reason IS NOT NULL
           GROUP BY exit_reason ORDER BY total DESC LIMIT 10`,
        );

        const pfExitLines = this.compressExitReasons(pfExitReasons);

        // Curve entry zone analysis
        const curveZones = await getMany<Record<string, unknown>>(
          `SELECT
             CASE
               WHEN curve_fill_pct_at_entry < 0.20 THEN '<20%'
               WHEN curve_fill_pct_at_entry < 0.25 THEN '20-25%'
               WHEN curve_fill_pct_at_entry < 0.30 THEN '25-30%'
               WHEN curve_fill_pct_at_entry < 0.35 THEN '30-35%'
               WHEN curve_fill_pct_at_entry < 0.40 THEN '35-40%'
               ELSE '40%+'
             END as zone,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COALESCE(AVG(peak_curve_fill_pct), 0) as avg_peak
           FROM pumpfun_positions WHERE status = 'CLOSED'
           GROUP BY zone ORDER BY zone`,
        );

        const zoneLines = curveZones.map((z) => {
          const zTotal = Number(z.total);
          const zWins = Number(z.wins);
          const zWr = zTotal > 0 ? (zWins / zTotal * 100).toFixed(0) : '0';
          const zPnl = (Number(z.avg_pnl) * 100).toFixed(1);
          const zPeak = (Number(z.avg_peak) * 100).toFixed(0);
          return `│ ${(z.zone as string).padEnd(6)} ${String(zTotal).padStart(3)}t ${zWr}%W avg${zPnl}% peak${zPeak}%`;
        });

        // Pump.fun alpha lag
        const pfLag = await getMany<Record<string, unknown>>(
          `SELECT
             CASE
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 5 THEN '<5s'
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 15 THEN '5-15s'
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 30 THEN '15-30s'
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 60 THEN '30-60s'
               ELSE '60s+'
             END as lag_bucket,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl
           FROM pumpfun_positions WHERE status = 'CLOSED'
           GROUP BY lag_bucket ORDER BY lag_bucket`,
        );

        const pfLagLines = pfLag.map((l) => {
          const lTotal = Number(l.total);
          const lWins = Number(l.wins);
          const lWr = lTotal > 0 ? (lWins / lTotal * 100).toFixed(0) : '0';
          const lPnl = (Number(l.avg_pnl) * 100).toFixed(1);
          return `│ ${(l.lag_bucket as string).padEnd(6)} ${String(lTotal).padStart(3)}t ${lWr}%W avg${lPnl}%`;
        });

        // Peak curve stats
        const peakStats = await getOne<Record<string, unknown>>(
          `SELECT
             COALESCE(AVG(peak_curve_fill_pct) FILTER (WHERE pnl_percent > 0), 0) as avg_peak_wins,
             COALESCE(AVG(peak_curve_fill_pct) FILTER (WHERE pnl_percent <= 0), 0) as avg_peak_losses,
             COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY peak_curve_fill_pct) FILTER (WHERE pnl_percent > 0), 0) as median_peak_wins,
             COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY peak_curve_fill_pct) FILTER (WHERE pnl_percent <= 0), 0) as median_peak_losses
           FROM pumpfun_positions WHERE status = 'CLOSED' AND peak_curve_fill_pct > 0`,
        );

        const avgPeakWins = (Number(peakStats?.avg_peak_wins || 0) * 100).toFixed(0);
        const avgPeakLosses = (Number(peakStats?.avg_peak_losses || 0) * 100).toFixed(0);
        const medPeakWins = (Number(peakStats?.median_peak_wins || 0) * 100).toFixed(0);
        const medPeakLosses = (Number(peakStats?.median_peak_losses || 0) * 100).toFixed(0);

        // Pump.fun recent trades
        const pfRecent = await getMany<Record<string, unknown>>(
          `SELECT token_address, pnl_percent, net_pnl_sol, hold_time_mins, exit_reason,
                  curve_fill_pct_at_entry, peak_curve_fill_pct, graduated,
                  COALESCE(entry_type, 'DIRECT') as entry_type,
                  EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) as alpha_lag_secs
           FROM pumpfun_positions WHERE status = 'CLOSED'
           ORDER BY closed_at DESC LIMIT 10`,
        );

        const pfRecentLines = pfRecent.map((r) => {
          const rPnl = (Number(r.pnl_percent) * 100).toFixed(1);
          const icon = Number(r.pnl_percent) > 0 ? '✅' : '❌';
          const entry = (Number(r.curve_fill_pct_at_entry) * 100).toFixed(0);
          const peak = (Number(r.peak_curve_fill_pct) * 100).toFixed(0);
          const lag = Number(r.alpha_lag_secs || 0).toFixed(0);
          const hold = Number(r.hold_time_mins || 0);
          const grad = r.graduated ? '🎓' : '';
          const type = String(r.entry_type).charAt(0);
          return `│ ${icon} ${(r.token_address as string).slice(0, 6)} ${rPnl}% ${hold}m e${entry}% p${peak}% ${type} ${lag}s ${r.exit_reason}${grad}`;
        });

        // ── SECTION 4: WALLET PERFORMANCE (across all tables) ──
        const walletPerfQuery = isLive
          ? `SELECT label, SUM(trades) as trades, SUM(wins) as wins, SUM(net_sol) as net_sol
             FROM (
               SELECT w.label, COUNT(*) as trades,
                      COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
                      COALESCE(SUM(p.net_pnl_sol), 0) as net_sol
               FROM pumpfun_positions p
               JOIN alpha_wallets w ON w.address = ANY(p.signal_wallets)
               WHERE p.status = 'CLOSED'
               GROUP BY w.label
               UNION ALL
               SELECT w.label, COUNT(*) as trades,
                      COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
                      COALESCE(SUM(p.net_pnl_sol), 0) as net_sol
               FROM positions p
               JOIN alpha_wallets w ON w.address = p.signal_wallet
               WHERE p.status = 'CLOSED'
               GROUP BY w.label
             ) combined
             GROUP BY label ORDER BY SUM(trades) DESC LIMIT 15`
          : `SELECT label, SUM(trades) as trades, SUM(wins) as wins, SUM(net_sol) as net_sol
             FROM (
               SELECT w.label, COUNT(*) as trades,
                      COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
                      COALESCE(SUM(p.net_pnl_sol), 0) as net_sol
               FROM pumpfun_positions p
               JOIN alpha_wallets w ON w.address = ANY(p.signal_wallets)
               WHERE p.status = 'CLOSED'
               GROUP BY w.label
               UNION ALL
               SELECT w.label, COUNT(*) as trades,
                      COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
                      COALESCE(SUM(p.simulated_entry_sol * p.pnl_percent), 0) as net_sol
               FROM shadow_positions p
               JOIN alpha_wallets w ON w.address = ANY(p.signal_wallets)
               WHERE p.status = 'CLOSED'
               GROUP BY w.label
             ) combined
             GROUP BY label ORDER BY SUM(trades) DESC LIMIT 15`;

        const walletPerf = await getMany<Record<string, unknown>>(walletPerfQuery);

        const walletLines = walletPerf.map((w) => {
          const wTotal = Number(w.trades);
          const wWins = Number(w.wins);
          const wWr = wTotal > 0 ? (wWins / wTotal * 100).toFixed(0) : '0';
          const wSol = Number(w.net_sol).toFixed(4);
          return `│ ${w.label}: ${wTotal}t ${wWr}%W ${Number(w.net_sol) >= 0 ? '+' : ''}${wSol}SOL`;
        });

        // ── SECTION 5: SIGNAL FUNNEL ──
        const funnel = await getOne<Record<string, unknown>>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE action_taken = 'EXECUTED') as executed,
             COUNT(*) FILTER (WHERE action_taken = 'SKIPPED_VALIDATION') as skipped_val,
             COUNT(*) FILTER (WHERE action_taken = 'SKIPPED_MAX_POSITIONS') as skipped_max,
             COUNT(*) FILTER (WHERE action_taken = 'SKIPPED_DAILY_LIMIT') as skipped_daily,
             COUNT(*) FILTER (WHERE action_taken = 'SKIPPED_MIN_POSITION') as skipped_min
           FROM signal_events`,
        );

        const totalSignals = Number(funnel?.total || 0);
        const executed = Number(funnel?.executed || 0);
        const skippedVal = Number(funnel?.skipped_val || 0);
        const skippedMax = Number(funnel?.skipped_max || 0);
        const skippedDaily = Number(funnel?.skipped_daily || 0);
        const skippedMin = Number(funnel?.skipped_min || 0);

        const rejections = await getMany<Record<string, unknown>>(
          `SELECT validation_result, COUNT(*) as total
           FROM signal_events WHERE validation_result != 'PASSED'
           GROUP BY validation_result ORDER BY total DESC`,
        );

        const rejectionLines = rejections.map((r) => {
          const reason = (r.validation_result as string).replace('FAILED_', '');
          const count = Number(r.total);
          const pct = totalSignals > 0 ? (count / totalSignals * 100).toFixed(0) : '0';
          return `│ ${reason}: ${count} (${pct}%)`;
        });

        // ── BUILD THE FULL REPORT ──
        const dexAvgPnl = (Number(dexOverall?.avg_pnl || 0) * 100).toFixed(1);
        const dexAvgHold = Number(dexOverall?.avg_hold || 0).toFixed(0);
        const dexAvgLag = Number(dexOverall?.avg_lag || 0).toFixed(0);
        const pfAvgPnl = (Number(pfOverall?.avg_pnl || 0) * 100).toFixed(1);
        const pfAvgHold = Number(pfOverall?.avg_hold || 0).toFixed(0);
        const pfAvgLag = Number(pfOverall?.avg_lag || 0).toFixed(0);
        const pfAvgEntryCurve = (Number(pfOverall?.avg_entry_curve || 0) * 100).toFixed(0);
        const pfAvgPeakCurve = (Number(pfOverall?.avg_peak_curve || 0) * 100).toFixed(0);
        const pfGradCount = Number(pfOverall?.graduated || 0);
        const dexWr = dexTotal > 0 ? (dexWins / dexTotal * 100).toFixed(0) : 'N/A';
        const pfWr = pfTotal > 0 ? (pfWins / pfTotal * 100).toFixed(0) : 'N/A';

        const lines = [
          `🔧 TUNING REPORT (${grandTotal} trades) — copy entire message to Claude`,
          ``,
          `┌─ ACTIVE CONFIG`,
          `│ Tier: ${cfgTier} | ${cfgCapSol.toFixed(2)} SOL | ${config.shadowMode ? 'SHADOW' : 'LIVE'}`,
          `│ Pos size: ${(cfgTc.positionSizePct * 100).toFixed(0)}% | Max: ${cfgTc.maxPositions} | WS: ${cfgTc.walletsMonitored}`,
          `│ Signal min: ${cfgTc.minSignalScore} | SL: ${(cfgTc.stopLoss * 100).toFixed(0)}% | TP: +${(cfgTc.profitTarget * 100).toFixed(0)}%`,
          `│ Pump.fun: entry ${(pf.curveEntryMin * 100).toFixed(0)}-${(pf.curveEntryMax * 100).toFixed(0)}% | TP ${(pf.curveProfitTarget * 100).toFixed(0)}% | stale ${pf.staleTimeKillMins}m`,
          `│ Conviction: ${pf.minConvictionSol}SOL | Velocity: ${pf.curveVelocityMin}SOL/m | Age: ${pf.maxTokenAgeMins}m`,
          `│`,
          `├─ COMBINED OVERVIEW`,
          `│ ${grandWins}W/${grandLosses}L (${grandWr}%) · Net: ${grandNetSol >= 0 ? '+' : ''}${grandNetSol.toFixed(4)} SOL · Fees: ${grandFees.toFixed(4)} SOL`,
          `│ DEX: ${dexTotal}t ${dexWr}%W avg${dexAvgPnl}% ${dexNetSol >= 0 ? '+' : ''}${dexNetSol.toFixed(4)}SOL hold${dexAvgHold}m lag${dexAvgLag}s`,
          `│ PF:  ${pfTotal}t ${pfWr}%W avg${pfAvgPnl}% ${pfNetSol >= 0 ? '+' : ''}${pfNetSol.toFixed(4)}SOL hold${pfAvgHold}m lag${pfAvgLag}s`,
          `│`,
        ];

        // DEX section (only if there are DEX trades)
        if (dexTotal > 0) {
          lines.push(
            `├─ DEX TRADES (${isLive ? 'LIVE' : 'SHADOW'}: ${dexTotal} trades)`,
            `│ ${dexWins}W/${dexTotal - dexWins}L (${dexWr}%) · Avg PnL: ${dexAvgPnl}% · Net: ${dexNetSol >= 0 ? '+' : ''}${dexNetSol.toFixed(4)} SOL`,
            `│ Avg hold: ${dexAvgHold}m · Avg lag: ${dexAvgLag}s${dexFees > 0 ? ` · Fees: ${dexFees.toFixed(4)} SOL` : ''}`,
            `│`,
            `│ By tier:`,
            ...(dexTierLines.length > 0 ? dexTierLines : ['│  (none)']),
            `│`,
            `│ Exit reasons:`,
            ...(dexExitLines.length > 0 ? dexExitLines : ['│  (none)']),
            `│`,
            `│ Alpha lag → outcome:`,
            ...(dexLagLines.length > 0 ? dexLagLines : ['│  (none)']),
            `│`,
            `│ Recent DEX trades:`,
            ...dexRecentLines,
            `│`,
          );
        }

        // Pump.fun section (only if there are PF trades)
        if (pfTotal > 0) {
          lines.push(
            `├─ PUMP.FUN TRADES (${pfTotal} trades)`,
            `│ ${pfWins}W/${pfTotal - pfWins}L (${pfWr}%) · Avg PnL: ${pfAvgPnl}% · Net: ${pfNetSol >= 0 ? '+' : ''}${pfNetSol.toFixed(4)} SOL`,
            `│ Avg hold: ${pfAvgHold}m · Entry curve: ${pfAvgEntryCurve}% · Peak: ${pfAvgPeakCurve}% · Graduated: ${pfGradCount}/${pfTotal}`,
            `│`,
            `│ Entry type breakdown:`,
            ...(pfEntryTypeLines.length > 0 ? pfEntryTypeLines : ['│  (all DIRECT)']),
            `│`,
            `│ Exit reasons:`,
            ...(pfExitLines.length > 0 ? pfExitLines : ['│  (none)']),
            `│`,
            `│ Entry curve zone → outcome:`,
            ...zoneLines,
            `│`,
            `│ Alpha lag → outcome:`,
            ...(pfLagLines.length > 0 ? pfLagLines : ['│  (none)']),
            `│`,
            `│ Peak curve (wins vs losses):`,
            `│ Wins: avg ${avgPeakWins}% median ${medPeakWins}%`,
            `│ Losses: avg ${avgPeakLosses}% median ${medPeakLosses}%`,
            `│`,
            `│ Recent PF trades:`,
            ...pfRecentLines,
            `│`,
          );
        }

        // Wallet performance (combined)
        lines.push(
          `├─ WALLET PERFORMANCE (all trades)`,
          ...(walletLines.length > 0 ? walletLines : ['│  (none)']),
          `│`,
        );

        // Signal funnel
        if (totalSignals > 0) {
          lines.push(
            `├─ SIGNAL FUNNEL`,
            `│ Total: ${totalSignals} · Executed: ${executed} (${(executed / totalSignals * 100).toFixed(0)}%)`,
            `│ Rejected: validation ${skippedVal} · max pos ${skippedMax} · daily limit ${skippedDaily} · min pos ${skippedMin}`,
            ...(rejectionLines.length > 0 ? [`│ By reason:`, ...rejectionLines] : []),
            `│`,
          );
        }

        lines.push(
          `└─ Send to Claude: "here's my tuning report, analyze and suggest config changes"`,
        );

        for (const chunk of this.chunkMessage(lines.join('\n'))) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to generate tuning report');
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load tuning data');
      }
    });

    // /config — all tunable params for copy-paste to Claude
    this.bot.onText(/\/config/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        const status = this.getStatus?.() || {};
        const capSol = status.capitalSol as number || 0;
        const tier = getTierForCapital(capSol);
        const tc = getTierConfig(tier);
        const isPumpOnly = capSol < config.minCapitalForStandardTrading;
        const pf = config.pumpFun;

        const lines = [
          `⚙️ CONFIG DUMP — copy this to Claude for tuning`,
          ``,
          `┌─ SYSTEM`,
          `│ Mode: ${config.shadowMode ? 'SHADOW' : 'LIVE'}`,
          `│ Capital: ${capSol.toFixed(4)} SOL`,
          `│ Tier: ${tier} (MICRO <3, SMALL 3-10, MEDIUM 10-50, FULL 50+)`,
          `│ Strategy: ${isPumpOnly ? 'PUMP.FUN ONLY (<5 SOL)' : 'FULL'}`,
          `│ Daily loss limit: ${(config.dailyLossLimitPct * 100).toFixed(0)}%`,
          `│ Exposure cap: 80%`,
          `│`,
          `├─ TIER CONFIG [${tier}]`,
          `│ Position size: ${(tc.positionSizePct * 100).toFixed(0)}%`,
          `│ Min position: ${tc.minPositionSol} SOL`,
          `│ Max positions: ${tc.maxPositions}`,
          `│ WS slots: ${tc.walletsMonitored}`,
          `│ Profit target: +${(tc.profitTarget * 100).toFixed(0)}%`,
          `│ Stop loss: ${(tc.stopLoss * 100).toFixed(0)}%`,
          `│ Hard kill: ${(tc.hardKill * 100).toFixed(0)}%`,
          `│ Hard time: ${tc.hardTimeHours}h`,
          `│ Partial exits: ${tc.partialExitsEnabled ? 'YES' : 'NO'}`,
          `│ Confluence: ${tc.walletConfluenceRequired} wallets in ${tc.confluenceWindow}min`,
          `│ Min signal score: ${tc.minSignalScore}`,
          `│ MCap: $${this.formatNum(tc.mcapMin)}-$${this.formatNum(tc.mcapMax)}`,
          `│ Min liquidity: $${this.formatNum(tc.liquidityMin)}`,
          `│ Momentum: ${tc.momentumMin}% to ${tc.momentumMax}%`,
          `│ Max token age: ${tc.tokenMaxAgeDays ?? 'none'}d`,
          `│ Time kills: ${tc.timeKills.map((tk) => `${tk.hours}h>${(tk.minPnlPct * 100).toFixed(0)}%`).join(', ')}`,
          `│`,
          `├─ PUMP.FUN CONFIG`,
          `│ Size multiplier: ${(pf.positionSizeMultiplier * 100).toFixed(0)}%`,
          `│ Max positions: ${pf.maxPositions}`,
          `│ Entry zone: ${(pf.curveEntryMin * 100).toFixed(0)}-${(pf.curveEntryMax * 100).toFixed(0)}% curve fill`,
          `│ Velocity min: ${pf.curveVelocityMin} SOL/min`,
          `│ Curve TP: ${(pf.curveProfitTarget * 100).toFixed(0)}% fill`,
          `│ Curve hard exit: ${(pf.curveHardExit * 100).toFixed(0)}% fill`,
          `│ PnL TP: +${(pf.profitTarget * 100).toFixed(0)}%`,
          `│ Stop loss: ${(pf.stopLoss * 100).toFixed(0)}%`,
          `│ Hard kill: ${(pf.hardKill * 100).toFixed(0)}%`,
          `│ Stale timer: ${pf.staleTimeKillMins}min`,
          `│ Min conviction: ${pf.minConvictionSol} SOL`,
          `│ Max token age: ${pf.maxTokenAgeMins}min`,
          `│ Slippage: ${(pf.slippageBps / 100).toFixed(0)}%`,
          `│ Confluence bonus: ${pf.confluenceBonus ? 'YES' : 'NO'}`,
          `│ Deferred entry: ${pf.deferredEntryEnabled ? 'YES' : 'NO'} (max ${pf.deferredEntryMaxWaitMs / 1000}s)`,
          `│ Graduation sell: ${pf.graduationSellPct}%`,
          `│`,
          `├─ SIGNAL SCORING (0-100)`,
          `│ Wallet quality: 35pts (WR + PnL + confidence)`,
          `│ Momentum: 25pts (24h + buy ratio + recency)`,
          `│ MCap fit: 20pts (sweet spot $30K-$300K)`,
          `│ Liquidity: 10pts ($5K-$100K)`,
          `│ Confluence: 10pts (2+ wallets)`,
          `│ Min to enter: ${tc.minSignalScore}`,
          `│`,
          `├─ WALLET MANAGEMENT`,
          `│ Discovery: every ${(config.nansen.discoveryIntervalMs / 3600000).toFixed(0)}h`,
          `│ Auto-promote: 3+ trades, >50%WR, <4h hold, >40 alpha → Tier A`,
          `│ Auto-demote: 2 consecutive losses → Tier B`,
          `│ Deactivate: 3+ losses, <$1K PnL, 7d inactive`,
          `│ Quality rotation: evict lowest quality when slots full`,
          `│`,
          `└─ Send this to Claude with "tune X to Y" or "analyze and suggest changes"`,
        ];

        for (const chunk of this.chunkMessage(lines.join('\n'))) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to generate config');
      }
    });

    // /edge — what's working and what's not
    this.bot.onText(/\/edge/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        // 1. Win rate by signal score band
        const scoreBands = await getMany<Record<string, unknown>>(
          `SELECT
             CASE
               WHEN se.signal_score < 40 THEN '<40'
               WHEN se.signal_score < 50 THEN '40-50'
               WHEN se.signal_score < 60 THEN '50-60'
               WHEN se.signal_score < 70 THEN '60-70'
               ELSE '70+'
             END as band,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
             COALESCE(AVG(p.pnl_percent), 0) as avg_pnl
           FROM pumpfun_positions p
           LEFT JOIN signal_events se ON se.position_id = p.id
           WHERE p.status = 'CLOSED' AND se.signal_score IS NOT NULL
           GROUP BY band ORDER BY band`,
        );

        // 2. Win rate by entry curve zone
        const curveZones = await getMany<Record<string, unknown>>(
          `SELECT
             CASE
               WHEN curve_fill_pct_at_entry < 0.25 THEN '<25%'
               WHEN curve_fill_pct_at_entry < 0.30 THEN '25-30%'
               WHEN curve_fill_pct_at_entry < 0.35 THEN '30-35%'
               WHEN curve_fill_pct_at_entry < 0.40 THEN '35-40%'
               ELSE '40%+'
             END as zone,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COALESCE(SUM(net_pnl_sol), 0) as net_sol
           FROM pumpfun_positions WHERE status = 'CLOSED'
           GROUP BY zone ORDER BY zone`,
        );

        // 3. Top 5 / bottom 5 wallets by P&L
        const topWallets = await getMany<Record<string, unknown>>(
          `SELECT w.label, COUNT(*) as trades,
                  COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
                  COALESCE(SUM(p.net_pnl_sol), 0) as net_sol,
                  COALESCE(AVG(p.pnl_percent), 0) as avg_pnl
           FROM pumpfun_positions p, unnest(p.signal_wallets) sw
           JOIN alpha_wallets w ON w.address = sw
           WHERE p.status = 'CLOSED'
           GROUP BY w.label
           HAVING COUNT(*) >= 2
           ORDER BY net_sol DESC LIMIT 5`,
        );

        const bottomWallets = await getMany<Record<string, unknown>>(
          `SELECT w.label, COUNT(*) as trades,
                  COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
                  COALESCE(SUM(p.net_pnl_sol), 0) as net_sol,
                  COALESCE(AVG(p.pnl_percent), 0) as avg_pnl
           FROM pumpfun_positions p, unnest(p.signal_wallets) sw
           JOIN alpha_wallets w ON w.address = sw
           WHERE p.status = 'CLOSED'
           GROUP BY w.label
           HAVING COUNT(*) >= 2
           ORDER BY net_sol ASC LIMIT 5`,
        );

        // 4. Exit reason effectiveness
        const exits = await getMany<Record<string, unknown>>(
          `SELECT exit_reason, COUNT(*) as total,
                  COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
                  COALESCE(AVG(pnl_percent), 0) as avg_pnl,
                  COALESCE(SUM(net_pnl_sol), 0) as net_sol
           FROM pumpfun_positions WHERE status = 'CLOSED' AND exit_reason IS NOT NULL
           GROUP BY exit_reason ORDER BY total DESC`,
        );

        // 5. Alpha lag effectiveness
        const lagBands = await getMany<Record<string, unknown>>(
          `SELECT
             CASE
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 10 THEN '<10s'
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 30 THEN '10-30s'
               WHEN EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) < 60 THEN '30-60s'
               ELSE '60s+'
             END as band,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl
           FROM pumpfun_positions WHERE status = 'CLOSED'
           GROUP BY band ORDER BY band`,
        );

        // 6. Overall expectancy
        const overall = await getOne<Record<string, unknown>>(
          `SELECT COUNT(*) as total,
                  COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
                  COALESCE(AVG(pnl_percent) FILTER (WHERE pnl_percent > 0), 0) as avg_win,
                  COALESCE(AVG(pnl_percent) FILTER (WHERE pnl_percent <= 0), 0) as avg_loss,
                  COALESCE(SUM(net_pnl_sol), 0) as net_sol,
                  COALESCE(SUM(net_pnl_sol) FILTER (WHERE pnl_percent > 0), 0) as gross_wins,
                  COALESCE(ABS(SUM(net_pnl_sol) FILTER (WHERE pnl_percent <= 0)), 0) as gross_losses
           FROM pumpfun_positions WHERE status = 'CLOSED'`,
        );

        const total = Number(overall?.total || 0);
        if (total === 0) {
          await this.bot.sendMessage(msg.chat.id, '📭 No closed trades — need data for edge analysis');
          return;
        }

        const wins = Number(overall?.wins || 0);
        const wr = (wins / total * 100).toFixed(0);
        const avgWin = (Number(overall?.avg_win || 0) * 100).toFixed(1);
        const avgLoss = (Number(overall?.avg_loss || 0) * 100).toFixed(1);
        const netSol = Number(overall?.net_sol || 0);
        const grossWins = Number(overall?.gross_wins || 0);
        const grossLosses = Number(overall?.gross_losses || 0);
        const profitFactor = grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : 'inf';
        const expectancy = (netSol / total);

        const formatBand = (rows: Record<string, unknown>[], keyField: string) =>
          rows.map((r) => {
            const t = Number(r.total);
            const w = Number(r.wins);
            const wRate = t > 0 ? (w / t * 100).toFixed(0) : '0';
            const pnl = (Number(r.avg_pnl) * 100).toFixed(1);
            const sol = r.net_sol !== undefined ? ` ${Number(r.net_sol) >= 0 ? '+' : ''}${Number(r.net_sol).toFixed(4)}SOL` : '';
            return `│ ${String(r[keyField]).padEnd(7)} ${String(t).padStart(3)}t ${wRate}%W avg${pnl}%${sol}`;
          });

        const lines = [
          `🎯 EDGE ANALYSIS (${total} trades)`,
          ``,
          `┌─ OVERALL`,
          `│ WR: ${wr}% | Avg win: +${avgWin}% | Avg loss: ${avgLoss}%`,
          `│ Profit factor: ${profitFactor} | Expectancy: ${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(4)} SOL/trade`,
          `│ Net: ${netSol >= 0 ? '+' : ''}${netSol.toFixed(4)} SOL`,
          `│`,
          ...(scoreBands.length > 0 ? [
            `├─ SIGNAL SCORE → OUTCOME`,
            ...formatBand(scoreBands, 'band'),
            `│`,
          ] : []),
          `├─ ENTRY CURVE ZONE → OUTCOME`,
          ...formatBand(curveZones, 'zone'),
          `│`,
          `├─ ALPHA LAG → OUTCOME`,
          ...formatBand(lagBands, 'band'),
          `│`,
          `├─ EXIT REASONS`,
          ...exits.map((r) => {
            const t = Number(r.total);
            const w = Number(r.wins);
            const wRate = t > 0 ? (w / t * 100).toFixed(0) : '0';
            const pnl = (Number(r.avg_pnl) * 100).toFixed(1);
            const sol = Number(r.net_sol);
            return `│ ${r.exit_reason}: ${t}t ${wRate}%W avg${pnl}% ${sol >= 0 ? '+' : ''}${sol.toFixed(4)}SOL`;
          }),
          `│`,
          `├─ BEST WALLETS (by SOL)`,
          ...topWallets.map((w) => {
            const t = Number(w.trades);
            const wn = Number(w.wins);
            const wr2 = t > 0 ? (wn / t * 100).toFixed(0) : '0';
            const sol = Number(w.net_sol);
            return `│ ${w.label}: ${t}t ${wr2}%W ${sol >= 0 ? '+' : ''}${sol.toFixed(4)}SOL`;
          }),
          `│`,
          `├─ WORST WALLETS (by SOL)`,
          ...bottomWallets.map((w) => {
            const t = Number(w.trades);
            const wn = Number(w.wins);
            const wr2 = t > 0 ? (wn / t * 100).toFixed(0) : '0';
            const sol = Number(w.net_sol);
            return `│ ${w.label}: ${t}t ${wr2}%W ${sol >= 0 ? '+' : ''}${sol.toFixed(4)}SOL`;
          }),
          `│`,
          `└─ Copy this to Claude: "here's my edge data, suggest config changes"`,
        ];

        for (const chunk of this.chunkMessage(lines.join('\n'))) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to generate edge analysis');
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load edge data');
      }
    });

    // /signaldump — signal quality analytics for tuning
    this.bot.onText(/\/signaldump/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        const status = this.getStatus?.() || {};
        const capSol = status.capitalSol as number || 0;
        const tierCfg = getTierConfig(getTierForCapital(capSol));

        // 1. Overall signal funnel
        const funnel = await getOne<Record<string, unknown>>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE action_taken = 'EXECUTED') as executed,
             COUNT(*) FILTER (WHERE action_taken = 'SKIPPED_VALIDATION') as skipped_validation,
             COUNT(*) FILTER (WHERE action_taken = 'SKIPPED_MAX_POSITIONS') as skipped_max_pos,
             COUNT(*) FILTER (WHERE action_taken = 'SKIPPED_DAILY_LIMIT') as skipped_daily,
             COUNT(*) FILTER (WHERE action_taken = 'SKIPPED_MIN_POSITION') as skipped_min_pos
           FROM signal_events`,
        );

        const totalSignals = Number(funnel?.total || 0);
        if (totalSignals === 0) {
          await this.bot.sendMessage(msg.chat.id, '📭 No signals recorded yet');
          return;
        }

        const executed = Number(funnel?.executed || 0);
        const skippedValidation = Number(funnel?.skipped_validation || 0);
        const skippedMaxPos = Number(funnel?.skipped_max_pos || 0);
        const skippedDaily = Number(funnel?.skipped_daily || 0);
        const skippedMinPos = Number(funnel?.skipped_min_pos || 0);
        const passRate = (executed / totalSignals * 100).toFixed(0);

        // 2. Rejection breakdown by validation reason
        const rejections = await getMany<Record<string, unknown>>(
          `SELECT
             validation_result,
             COUNT(*) as total
           FROM signal_events
           WHERE validation_result != 'PASSED'
           GROUP BY validation_result ORDER BY total DESC`,
        );

        const rejectionLines = rejections.map((r) => {
          const reason = (r.validation_result as string).replace('FAILED_', '');
          const count = Number(r.total);
          const pct = (count / totalSignals * 100).toFixed(0);
          return `│ ${reason}: ${count} (${pct}%)`;
        });

        // 3. Signal score distribution (executed signals only)
        const scoreDist = await getMany<Record<string, unknown>>(
          `SELECT
             CASE
               WHEN signal_score < 30 THEN '<30'
               WHEN signal_score < 40 THEN '30-40'
               WHEN signal_score < 50 THEN '40-50'
               WHEN signal_score < 60 THEN '50-60'
               WHEN signal_score < 70 THEN '60-70'
               ELSE '70+'
             END as band,
             COUNT(*) as total
           FROM signal_events
           WHERE action_taken = 'EXECUTED' AND signal_score IS NOT NULL
           GROUP BY band ORDER BY band`,
        );

        const scoreLines = scoreDist.map((s) => {
          const count = Number(s.total);
          const pct = executed > 0 ? (count / executed * 100).toFixed(0) : '0';
          return `│ ${(s.band as string).padEnd(6)} ${String(count).padStart(3)} (${pct}%)`;
        });

        // 4. Signal score → trade outcome (wins/losses by score band)
        const scoreOutcome = await getMany<Record<string, unknown>>(
          `SELECT
             CASE
               WHEN se.signal_score < 40 THEN '<40'
               WHEN se.signal_score < 50 THEN '40-50'
               WHEN se.signal_score < 60 THEN '50-60'
               WHEN se.signal_score < 70 THEN '60-70'
               ELSE '70+'
             END as band,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
             COALESCE(AVG(p.pnl_percent), 0) as avg_pnl,
             COALESCE(SUM(p.net_pnl_sol), 0) as net_sol
           FROM pumpfun_positions p
           LEFT JOIN signal_events se ON se.position_id = p.id
           WHERE p.status = 'CLOSED' AND se.signal_score IS NOT NULL
           GROUP BY band ORDER BY band`,
        );

        const outcomeLines = scoreOutcome.map((s) => {
          const sTotal = Number(s.total);
          const sWins = Number(s.wins);
          const sWr = sTotal > 0 ? (sWins / sTotal * 100).toFixed(0) : '0';
          const sPnl = (Number(s.avg_pnl) * 100).toFixed(1);
          const sSol = Number(s.net_sol).toFixed(4);
          return `│ ${(s.band as string).padEnd(6)} ${String(sTotal).padStart(3)}t ${sWr}%W avg${sPnl}% ${sSol}SOL`;
        });

        // 5. Wallet confluence → outcome
        const confluenceOutcome = await getMany<Record<string, unknown>>(
          `SELECT
             se.wallet_count,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
             COALESCE(AVG(p.pnl_percent), 0) as avg_pnl,
             COALESCE(SUM(p.net_pnl_sol), 0) as net_sol
           FROM signal_events se
           JOIN pumpfun_positions p ON se.position_id = p.id
           WHERE p.status = 'CLOSED'
           GROUP BY se.wallet_count ORDER BY se.wallet_count`,
        );

        const confluenceLines = confluenceOutcome.map((c) => {
          const cTotal = Number(c.total);
          const cWins = Number(c.wins);
          const cWr = cTotal > 0 ? (cWins / cTotal * 100).toFixed(0) : '0';
          const cPnl = (Number(c.avg_pnl) * 100).toFixed(1);
          const cSol = Number(c.net_sol).toFixed(4);
          return `│ ${c.wallet_count}w: ${cTotal}t ${cWr}%W avg${cPnl}% ${cSol}SOL`;
        });

        // 6. Hourly signal volume (last 24h)
        const hourly = await getMany<Record<string, unknown>>(
          `SELECT
             EXTRACT(HOUR FROM first_detected_at) as hr,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE action_taken = 'EXECUTED') as executed
           FROM signal_events
           WHERE first_detected_at > NOW() - INTERVAL '24 hours'
           GROUP BY hr ORDER BY hr`,
        );

        const hourlyLines = hourly.map((h) => {
          const hTotal = Number(h.total);
          const hExec = Number(h.executed);
          const bar = '█'.repeat(Math.min(Math.ceil(hTotal / 2), 20));
          return `│ ${String(h.hr).padStart(2, '0')}h ${String(hTotal).padStart(3)} sig ${String(hExec).padStart(2)} exec ${bar}`;
        });

        // 7. Top signal wallets (which wallets produce winning signals?)
        const topSignalWallets = await getMany<Record<string, unknown>>(
          `SELECT
             w.label,
             COUNT(*) as signals,
             COUNT(*) FILTER (WHERE se.action_taken = 'EXECUTED') as executed,
             COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
             COUNT(*) FILTER (WHERE p.pnl_percent <= 0) as losses,
             COALESCE(AVG(p.pnl_percent) FILTER (WHERE p.id IS NOT NULL), 0) as avg_pnl
           FROM signal_events se, unnest(se.wallet_addresses) sw
           JOIN alpha_wallets w ON w.address = sw
           LEFT JOIN pumpfun_positions p ON se.position_id = p.id AND p.status = 'CLOSED'
           GROUP BY w.label
           HAVING COUNT(*) >= 3
           ORDER BY COUNT(*) FILTER (WHERE p.pnl_percent > 0) DESC LIMIT 10`,
        );

        const walletSignalLines = topSignalWallets.map((w) => {
          const wSigs = Number(w.signals);
          const wExec = Number(w.executed);
          const wWins = Number(w.wins);
          const wLosses = Number(w.losses);
          const wPnl = (Number(w.avg_pnl) * 100).toFixed(1);
          return `│ ${w.label}: ${wSigs}sig ${wExec}exec ${wWins}W/${wLosses}L avg${wPnl}%`;
        });

        // 8. Recent signal flow (last 20)
        const recentSignals = await getMany<Record<string, unknown>>(
          `SELECT
             se.token_symbol, se.token_address, se.validation_result, se.action_taken,
             se.signal_score, se.wallet_count, se.first_detected_at,
             p.pnl_percent, p.status as pos_status
           FROM signal_events se
           LEFT JOIN pumpfun_positions p ON se.position_id = p.id
           ORDER BY se.first_detected_at DESC LIMIT 20`,
        );

        const recentLines = recentSignals.map((s) => {
          const sym = s.token_symbol || (s.token_address as string).slice(0, 6);
          const ago = Math.round((Date.now() - new Date(s.first_detected_at as string).getTime()) / 60000);
          const score = s.signal_score ? `S${Number(s.signal_score).toFixed(0)}` : 'S??';
          const action = s.action_taken as string;

          let outcome = '';
          if (action === 'EXECUTED' && s.pos_status === 'CLOSED') {
            const pnl = (Number(s.pnl_percent) * 100).toFixed(1);
            outcome = Number(s.pnl_percent) > 0 ? `✅${pnl}%` : `❌${pnl}%`;
          } else if (action === 'EXECUTED' && s.pos_status === 'OPEN') {
            outcome = '⏳OPEN';
          } else if (action === 'SKIPPED_VALIDATION') {
            const reason = (s.validation_result as string).replace('FAILED_', '');
            outcome = `🚫${reason}`;
          } else if (action === 'SKIPPED_MAX_POSITIONS') {
            outcome = '🚫MAX_POS';
          } else if (action === 'SKIPPED_DAILY_LIMIT') {
            outcome = '🚫DAILY';
          } else if (action === 'SKIPPED_MIN_POSITION') {
            outcome = '🚫MIN_POS';
          }

          return `│ $${sym} ${score} ${s.wallet_count}w ${outcome} ${ago}m`;
        });

        const lines = [
          `📊 SIGNAL QUALITY DUMP — copy to Claude for tuning`,
          ``,
          `┌─ SIGNAL FUNNEL (all time)`,
          `│ Total signals: ${totalSignals}`,
          `│ Executed: ${executed} (${passRate}%)`,
          `│ Rejected validation: ${skippedValidation}`,
          `│ Rejected max positions: ${skippedMaxPos}`,
          `│ Rejected daily limit: ${skippedDaily}`,
          `│ Rejected min position: ${skippedMinPos}`,
          `│`,
          `├─ REJECTION REASONS`,
          ...(rejectionLines.length > 0 ? rejectionLines : ['│  (none)']),
          `│`,
          `├─ EXECUTED SIGNAL SCORE DISTRIBUTION`,
          ...(scoreLines.length > 0 ? scoreLines : ['│  (no scored signals)']),
          `│ Min score threshold: ${tierCfg.minSignalScore}`,
          `│`,
          `├─ SCORE BAND → TRADE OUTCOME`,
          ...(outcomeLines.length > 0 ? outcomeLines : ['│  (no closed trades with scores)']),
          `│`,
          `├─ WALLET CONFLUENCE → OUTCOME`,
          ...(confluenceLines.length > 0 ? confluenceLines : ['│  (no data)']),
          `│`,
          `├─ HOURLY SIGNAL VOLUME (24h)`,
          ...(hourlyLines.length > 0 ? hourlyLines : ['│  (no recent signals)']),
          `│`,
          `├─ WALLET SIGNAL QUALITY (3+ signals)`,
          ...(walletSignalLines.length > 0 ? walletSignalLines : ['│  (not enough data)']),
          `│`,
          `├─ RECENT SIGNAL FLOW (newest first)`,
          `│ [token score wallets outcome age]`,
          ...recentLines,
          `│`,
          `└─ Send to Claude: "here's my signal dump, analyze quality and suggest tuning"`,
        ];

        for (const chunk of this.chunkMessage(lines.join('\n'))) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to generate signal dump');
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load signal data');
      }
    });

    logger.info('Telegram bot commands registered');
  }

  async sendSignalLog(data: {
    tokenSymbol: string;
    tokenMint: string;
    passed: boolean;
    failReason: string | null;
    wallets: Array<{ address: string; label: string; trades: number; winRate: number; avgPnl: number; nansenRoi?: number; nansenPnlUsd?: number }>;
    totalMonitored: number;
    safety: { passed: boolean; reason?: string };
    liquidity: { passed: boolean; reason?: string; details?: Record<string, unknown> };
    momentum: { passed: boolean; reason?: string; details?: Record<string, unknown> };
    mcap: { passed: boolean; reason?: string; details?: Record<string, unknown> };
    age: { passed: boolean; reason?: string; details?: Record<string, unknown> };
    dexData: {
      mcap: number;
      liquidity: number;
      priceChange24h: number;
      priceChange6h: number;
      priceChange1h: number;
      volume24h: number;
      ageDays: number;
    } | null;
    validationMs: number;
    action: string;
  }): Promise<void> {
    const icon = data.passed ? '✅' : '❌';
    const gate = (check: { passed: boolean; reason?: string }) =>
      check.passed ? '✅' : '❌';

    const walletLines = data.wallets.map((w) => {
      const hasNansen = (w.nansenRoi && w.nansenRoi > 0) || (w.nansenPnlUsd && w.nansenPnlUsd > 0);
      // Lead with Nansen data (source of truth), show our stats as supplement
      const nansenPart = w.nansenRoi && w.nansenRoi > 0
        ? `Nansen: ${w.nansenRoi.toFixed(0)}%ROI`
        : w.nansenPnlUsd && w.nansenPnlUsd > 0
          ? `Nansen: $${this.formatNum(w.nansenPnlUsd)} PnL`
          : '';
      const ourPart = w.trades > 0
        ? `Ours: ${w.trades}t ${(w.winRate * 100).toFixed(0)}%W EV ${w.avgPnl >= 0 ? '+' : ''}${(w.avgPnl * 100).toFixed(1)}%`
        : '';
      const stats = hasNansen
        ? nansenPart + (ourPart ? ` | ${ourPart}` : '')
        : ourPart || 'new';
      return `│  ${w.label} (${w.address.slice(0, 6)}): ${stats}`;
    });

    const dex = data.dexData;
    const dexLines = dex ? [
      `├ MCap: $${this.formatNum(dex.mcap)} | Liq: $${this.formatNum(dex.liquidity)}`,
      `├ Price: ${dex.priceChange1h >= 0 ? '+' : ''}${dex.priceChange1h.toFixed(1)}% 1h | ${dex.priceChange6h >= 0 ? '+' : ''}${dex.priceChange6h.toFixed(1)}% 6h | ${dex.priceChange24h >= 0 ? '+' : ''}${dex.priceChange24h.toFixed(1)}% 24h`,
      `├ Vol 24h: $${this.formatNum(dex.volume24h)} | Age: ${dex.ageDays.toFixed(1)}d`,
    ] : [`├ DexScreener: no data`];

    const msg = [
      `${icon} SIGNAL LOG | $${data.tokenSymbol} | ${data.passed ? 'PASSED' : data.failReason || 'FAILED'}`,
      `├ Wallets (${data.wallets.length}/${data.totalMonitored}):`,
      ...walletLines,
      `├ Gates:`,
      `│  Safety: ${gate(data.safety)} ${data.safety.reason || ''}`,
      `│  Liquidity: ${gate(data.liquidity)} ${data.liquidity.reason || ''}`,
      `│  Momentum: ${gate(data.momentum)} ${data.momentum.reason || ''}`,
      `│  MCap: ${gate(data.mcap)} ${data.mcap.reason || ''}`,
      `│  Age: ${gate(data.age)} ${data.age.reason || ''}`,
      ...dexLines,
      `├ Validation: ${data.validationMs}ms`,
      `├ Action: ${data.action}`,
      `└ ${data.tokenMint}`,
    ].join('\n');

    await this.send(msg);
  }

  async sendTradeCloseLog(data: {
    tokenSymbol: string;
    tokenMint: string;
    pnlPercent: number;
    pnlSol: number;
    entryPrice: number;
    exitPrice: number;
    peakPrice: number;
    sizeSol: number;
    holdMins: number;
    exitReason: string;
    tier: string;
    wallets: Array<{ address: string; label: string; trades: number; winRate: number; avgPnl: number; nansenRoi?: number; nansenPnlUsd?: number }>;
    entryTime: string;
    exitTime: string;
    detectionLagMs: number;
    feesSol?: number;
    netPnlSol?: number;
    isLive?: boolean;
  }): Promise<void> {
    const isWin = data.pnlPercent > 0;
    const icon = isWin ? '💰' : '💸';
    const result = isWin ? 'WIN' : 'LOSS';
    const pnlSign = data.pnlPercent >= 0 ? '+' : '';

    const peakPnl = data.entryPrice > 0 ? ((data.peakPrice - data.entryPrice) / data.entryPrice * 100) : 0;
    const drawdownFromPeak = data.peakPrice > 0 ? ((data.peakPrice - data.exitPrice) / data.peakPrice * 100) : 0;

    const walletLines = data.wallets.map((w) => {
      const hasNansen = (w.nansenRoi && w.nansenRoi > 0) || (w.nansenPnlUsd && w.nansenPnlUsd > 0);
      const nansenPart = w.nansenRoi && w.nansenRoi > 0
        ? `Nansen: ${w.nansenRoi.toFixed(0)}%ROI`
        : w.nansenPnlUsd && w.nansenPnlUsd > 0
          ? `Nansen: $${this.formatNum(w.nansenPnlUsd)} PnL`
          : '';
      const ourPart = w.trades > 0
        ? `Ours: ${w.trades}t ${(w.winRate * 100).toFixed(0)}%W EV ${w.avgPnl >= 0 ? '+' : ''}${(w.avgPnl * 100).toFixed(1)}%`
        : '';
      const stats = hasNansen
        ? nansenPart + (ourPart ? ` | ${ourPart}` : '')
        : ourPart || 'new (first trade)';
      return `│  ${w.label} (${w.address.slice(0, 6)}): ${stats}`;
    });

    const msg = [
      `${icon} TRADE LOG | $${data.tokenSymbol} | ${pnlSign}${(data.pnlPercent * 100).toFixed(1)}% ${result}`,
      `├ Entry: ${data.sizeSol.toFixed(2)} SOL @ $${data.entryPrice.toFixed(8)}`,
      `├ Exit: $${data.exitPrice.toFixed(8)} | ${data.exitReason}`,
      `├ Net: ${pnlSign}${(data.netPnlSol ?? data.pnlSol).toFixed(4)} SOL`,
      ...(data.feesSol ? [`├ Fees: ${data.feesSol.toFixed(4)} SOL`] : []),
      `├ Peak: +${peakPnl.toFixed(1)}% | Drawdown from peak: ${drawdownFromPeak.toFixed(1)}%`,
      `├ Hold: ${this.formatHoldTime(data.holdMins)} | Tier: ${data.tier}`,
      `├ Detection lag: ${(data.detectionLagMs / 1000).toFixed(1)}s`,
      `├ Wallets:`,
      ...walletLines,
      `├ Entry: ${data.entryTime} | Exit: ${data.exitTime}`,
      `└ ${data.tokenMint}`,
    ].join('\n');

    await this.send(msg);
  }

  // --- Helpers ---

  async send(text: string, opts?: { parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2' }): Promise<void> {
    try {
      for (const chunk of this.chunkMessage(text)) {
        await this.bot.sendMessage(this.chatId, chunk, { parse_mode: opts?.parse_mode });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to send Telegram message');
    }
  }

  private chunkMessage(text: string, maxLen = 4096): string[] {
    if (text.length <= maxLen) return [text];
    const lines = text.split('\n');
    const chunks: string[] = [];
    let current = '';
    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length > maxLen) {
        if (current) chunks.push(current);
        current = line.length > maxLen ? line.slice(0, maxLen) : line;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  private formatNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return n.toFixed(0);
  }

  private formatLag(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }

  private formatHoldTime(mins: number): string {
    mins = Math.round(mins);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const m = mins % 60;
    return `${hours}h ${m}m`;
  }

  /** Compress exit reasons: show top types individually, group rare ones (≤2 trades) into "Other" */
  private compressExitReasons(rows: Record<string, unknown>[]): string[] {
    const major = rows.filter(r => Number(r.total) > 2);
    const minor = rows.filter(r => Number(r.total) <= 2);
    const lines = major.map((r) => {
      const rTotal = Number(r.total);
      const rWins = Number(r.wins);
      const rWr = rTotal > 0 ? (rWins / rTotal * 100).toFixed(0) : '0';
      const rPnl = (Number(r.avg_pnl) * 100).toFixed(1);
      return `│ ${rTotal}x ${r.exit_reason} (${rWr}%W, avg ${rPnl}%)`;
    });
    if (minor.length > 0) {
      const otherTotal = minor.reduce((s, r) => s + Number(r.total), 0);
      const otherPnl = minor.reduce((s, r) => s + Number(r.avg_pnl) * Number(r.total), 0);
      const avgPnl = otherTotal > 0 ? (otherPnl / otherTotal * 100).toFixed(1) : '0.0';
      lines.push(`│ ${otherTotal}x Other (${minor.length} types, avg ${avgPnl}%)`);
    }
    return lines;
  }

  async shutdown(): Promise<void> {
    this.bot.stopPolling();
  }
}
