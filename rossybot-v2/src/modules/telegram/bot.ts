import TelegramBot from 'node-telegram-bot-api';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getMany, getOne, query } from '../../db/database.js';
import type { PositionView } from '../../types/index.js';

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
  private onMarketAnalysis: ((force: boolean) => Promise<void>) | null = null;
  private getPumpFunPositions: (() => Array<Record<string, unknown>>) | null = null;

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
  setMarketAnalysisCallback(cb: (force: boolean) => Promise<void>): void { this.onMarketAnalysis = cb; }
  setPumpFunPositionsCallback(cb: () => Array<Record<string, unknown>>): void { this.getPumpFunPositions = cb; }

  get isPaused(): boolean { return this.paused; }

  // --- Alert methods ---

  async sendEntryAlert(data: {
    tokenSymbol: string;
    tokenMint: string;
    tier: string;
    wallets: string[];
    walletCount: number;
    totalMonitored: number;
    walletEv?: Array<{ address: string; trades: number; winRate: number; avgPnl: number }>;
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
    entryTx?: string;
    feesSol?: number;
    isLive?: boolean;
  }): Promise<void> {
    const walletLabels = data.wallets.map((w) => w.slice(0, 8)).join(' + ');
    const dexLink = `https://dexscreener.com/solana/${data.tokenMint}`;
    const modeTag = data.isLive ? '' : ' (SHADOW)';

    const evLines: string[] = [];
    if (data.walletEv && data.walletEv.length > 0) {
      for (const w of data.walletEv) {
        const addr = w.address.slice(0, 8);
        if (w.trades > 0) {
          const pnlSign = w.avgPnl >= 0 ? '+' : '';
          evLines.push(`│  ${addr}: ${w.trades}t ${(w.winRate * 100).toFixed(0)}%W EV ${pnlSign}${w.avgPnl.toFixed(1)}%`);
        } else {
          evLines.push(`│  ${addr}: new (no trades yet)`);
        }
      }
    }

    const msg = [
      `🟢 ENTRY: $${data.tokenSymbol} [${data.tier}]${modeTag}`,
      `├ Wallets: ${walletLabels} (${data.walletCount}/${data.totalMonitored} via Helius ✅)`,
      ...(evLines.length > 0 ? [`├ Wallet EV:`, ...evLines] : []),
      `├ Size: ${data.sizeSol.toFixed(2)} SOL @ $${data.price.toFixed(6)}`,
      `├ Momentum: ${data.momentum24h > 0 ? '+' : ''}${data.momentum24h.toFixed(0)}% (24h) | Vol ${data.volumeMultiplier.toFixed(1)}x avg`,
      `├ MCap: $${this.formatNum(data.mcap)} | Liq: $${this.formatNum(data.liquidity)} | Age: ${data.ageDays.toFixed(0)}d`,
      `├ Safety: ✅ | Helius lag: ${(data.detectionLagMs / 1000).toFixed(1)}s`,
      `├ Execution lag: ${this.formatLag(data.executionLagSecs)}`,
      ...(data.signalScore ? [data.signalScore] : []),
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
    currentPositionSymbol: string;
    currentPositionPnl: number;
    currentPositionHoldMins: number;
  }): Promise<void> {
    const dexLink = `https://dexscreener.com/solana/${data.tokenMint}`;
    const pnlSign = data.currentPositionPnl >= 0 ? '+' : '';
    const msg = [
      `⚠️ SKIPPED (at max positions)`,
      `├ Missed: $${data.tokenSymbol}`,
      data.signalScore,
      `├ Blocked by: $${data.currentPositionSymbol} (${pnlSign}${data.currentPositionPnl.toFixed(1)}%, hold ${this.formatHoldTime(data.currentPositionHoldMins)})`,
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
  }): Promise<void> {
    const msg = [
      `💰 TARGET: $${data.tokenSymbol} +${(data.pnlPercent * 100).toFixed(0)}%`,
      `├ ${data.entrySol.toFixed(2)} SOL → ${data.exitSol.toFixed(3)} SOL | Net: +${data.netPnlSol.toFixed(3)} SOL`,
      ...(data.feesSol ? [`├ Fees: ${data.feesSol.toFixed(4)} SOL`] : []),
      `├ Hold: ${this.formatHoldTime(data.holdMins)}`,
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
  }): Promise<void> {
    const msg = [
      `🔴 EXIT: $${data.tokenSymbol} ${(data.pnlPercent * 100).toFixed(1)}%`,
      `├ Loss: ${data.lossSol.toFixed(3)} SOL`,
      ...(data.feesSol ? [`├ Fees: ${data.feesSol.toFixed(4)} SOL`] : []),
      `├ Hold: ${this.formatHoldTime(data.holdMins)}`,
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
    const msg = [
      `📊 DAILY — ${data.date}`,
      `├ Trades: ${data.wins}W/${data.losses}L | P&L: ${data.pnlSol >= 0 ? '+' : ''}${data.pnlSol.toFixed(3)} SOL (${data.pnlPercent >= 0 ? '+' : ''}${(data.pnlPercent * 100).toFixed(0)}%)`,
      `├ Capital: ${data.capitalStart.toFixed(2)} → ${data.capitalEnd.toFixed(2)} SOL [${data.tier}]`,
      `├ Fees: ${data.feesSol.toFixed(3)} SOL | Signals: ${data.signalsSeen} seen, ${data.signalsEntered} entered`,
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
    version: string;
    shadowMode: boolean;
    capitalSol: number;
    tier: string;
    maxPositions: number;
    openPositions: number;
    wallets: Array<{
      address: string; label: string; tier: string; subscribed: boolean;
      nansenRoi: number; nansenPnl: number; ourTrades: number; ourWinRate: number;
      ourAvgPnl: number; consecutiveLosses: number; source: string;
      lastActiveAgo?: string;
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
  }): Promise<void> {
    const walletLines = data.wallets.map((w) => {
      const status = w.subscribed ? '📡' : '⏸️';
      const stats: string[] = [];
      if (w.nansenRoi > 0) stats.push(`ROI ${w.nansenRoi.toFixed(0)}%`);
      if (w.nansenPnl > 0) stats.push(`PnL $${this.formatNum(w.nansenPnl)}`);
      if (w.ourTrades > 0) stats.push(`${w.ourTrades}t ${(w.ourWinRate * 100).toFixed(0)}%W`);
      if (w.consecutiveLosses > 0) stats.push(`${w.consecutiveLosses}L`);
      if (w.lastActiveAgo) stats.push(`🕐${w.lastActiveAgo}`);
      const statsStr = stats.length > 0 ? ` | ${stats.join(' · ')}` : '';
      return `│  ${status} [${w.tier}] ${w.address.slice(0, 6)}...${w.address.slice(-4)}${statsStr}`;
    }).join('\n');

    const isPumpFunOnly = data.capitalSol < data.minCapitalForStandardTrading;

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
      `├─ WALLETS MONITORED (${data.wallets.length})`,
      walletLines,
      `│`,
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

    msg.push(
      `├─ STATS`,
      `│ Signals today: ${data.signalsToday}`,
      `│ All-time trades: ${data.tradesAllTime}`,
      `│`,
      `└─ STATUS: ✅ RUNNING`,
    );

    await this.send(msg.join('\n'));
  }

  // --- Command handlers ---

  private async setBotMenu(): Promise<void> {
    const commands: TelegramBot.BotCommand[] = [
      { command: 'status', description: 'Bot status & strategy info' },
      { command: 'pumpfun', description: 'Pump.fun dashboard' },
      { command: 'positions', description: 'Open positions with PnL' },
      { command: 'pnl', description: 'P&L report (open + closed)' },
      { command: 'signals', description: 'Recent signals & outcomes' },
      { command: 'curve', description: 'Curve fill distribution analysis' },
      { command: 'tuning', description: 'Aggregate tuning report' },
      { command: 'stats', description: 'Performance stats (7d)' },
      { command: 'wallets', description: 'Alpha wallets' },
      { command: 'pump_wallets', description: 'Pump.fun wallet roster & discovery' },
      { command: 'kill', description: 'Force close position' },
      { command: 'health', description: 'System health check' },
      { command: 'discover', description: 'Trigger wallet discovery' },
      { command: 'market', description: 'Pump.fun market analysis' },
      { command: 'graduation', description: 'Graduation retroanalysis' },
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
      const text = [
        `📍 STATUS`,
        `├ Capital: ${(status.capitalSol as number || 0).toFixed(2)} SOL [${status.tier || 'MICRO'}]`,
        `├ Positions: ${status.openPositions || 0}/${status.maxPositions || 2}`,
        `├ Mode: ${(status.isLive as boolean) ? '💰 LIVE' : '👻 SHADOW'}`,
        `├ Paused: ${this.paused ? 'YES' : 'NO'}`,
        `├ WebSocket: ${(status.wsConnected as boolean) ? '✅' : '❌'}${(status.wsFallback as boolean) ? ' (FALLBACK)' : ''}`,
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
          `SELECT address, label, tier, active, helius_subscribed, our_win_rate, our_total_trades
           FROM alpha_wallets WHERE active = TRUE ORDER BY tier ASC, our_win_rate DESC`,
        );
        const lines = wallets.map((w) => {
          const wr = w.our_total_trades ? `${((w.our_win_rate as number) * 100).toFixed(0)}%` : 'N/A';
          return `${w.helius_subscribed ? '📡' : '⏸️'} [${w.tier}] ${w.label} | WR: ${wr} | Trades: ${w.our_total_trades}`;
        });
        const walletMsg = `👛 WALLETS (${wallets.length})\n${lines.join('\n')}`;
        for (const chunk of this.chunkMessage(walletMsg)) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load wallets');
      }
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
        const wr = totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses) * 100).toFixed(0) : 'N/A';
        await this.bot.sendMessage(msg.chat.id, [
          `📊 STATS (${stats.length}d)`,
          `├ P&L: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(3)} SOL`,
          `├ W/L: ${totalWins}/${totalLosses} (${wr}%)`,
          `└ Days: ${stats.length}`,
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
             COALESCE(AVG(hold_time_mins), 0) as avg_hold,
             ${isLive ? 'COALESCE(SUM(fees_paid_sol), 0) as total_fees,' : ''}
             MIN(entry_time) as first_trade
           FROM ${tableName} WHERE status = 'CLOSED'`,
        );

        const total = Number(closed?.total || 0);
        const wins = Number(closed?.wins || 0);
        const losses = Number(closed?.losses || 0);
        const realizedSol = Number(closed?.realized_sol || 0);
        const avgPnl = Number(closed?.avg_pnl || 0);
        const avgHold = Number(closed?.avg_hold || 0);
        const totalFees = isLive ? Number(closed?.total_fees || 0) : 0;
        const wr = total > 0 ? (wins / total * 100).toFixed(0) : 'N/A';
        const netSol = realizedSol + unrealizedSol;
        const firstTrade = closed?.first_trade ? new Date(closed.first_trade as string) : null;
        const sinceStr = firstTrade
          ? firstTrade.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : 'N/A';

        const lines = [
          `📈 ${isLive ? 'LIVE' : 'SHADOW'} P&L`,
          `├ Open positions: ${openCount}`,
          `├ Unrealized: ${unrealizedSol >= 0 ? '+' : ''}${unrealizedSol.toFixed(3)} SOL (${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(1)}% avg)`,
          `├ Realized: ${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(3)} SOL (${total} trades)`,
          `├ Net: ${netSol >= 0 ? '+' : ''}${netSol.toFixed(3)} SOL`,
          `├ Win rate: ${wr}% (${wins}W / ${losses}L)`,
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
        await this.onMarketAnalysis(force);
        await this.bot.sendMessage(msg.chat.id, '✅ Market analysis complete — report sent above');
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, `❌ Market analysis failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    });

    this.bot.onText(/\/signals/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        const signals = await getMany<Record<string, unknown>>(
          `SELECT token_address, token_symbol, validation_result, validation_details, action_taken, first_detected_at, wallet_count
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
          return `${icon} $${sym} | ${reason} | ${ago}m ago | ${s.wallet_count}w`;
        });

        const signalMsg = [
          `🔍 SIGNALS (last ${signals.length})`,
          ...lines,
          `└ ${passed}/${signals.length} passed validation`,
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

        // --- Per-source wallet lines (capped for large sources) ---
        const sourceBlocks: string[] = [];
        const MAX_DISPLAY_ACTIVE = 20;
        const MAX_DISPLAY_INACTIVE = 5;

        const formatWalletLine = (w: Record<string, unknown>): string => {
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
          let lastActiveStr = '';
          if (w.last_active_at) {
            const ago = Math.round((Date.now() - new Date(w.last_active_at as string).getTime()) / 86400000);
            lastActiveStr = ago === 0 ? ' (today)' : ago === 1 ? ' (1d ago)' : ` (${ago}d ago)`;
          }
          const label = w.label as string;
          const shortAddr = (w.address as string).slice(0, 6);
          const displayName = label.length > 20 ? `${label.slice(0, 20)}…` : label;
          return `│  ${status} ${tierTag} ${displayName} [${shortAddr}] | ${trades}t ${wr}W ${pnl}pnl | hold ${hold}${streak}${alphaTag}${lastActiveStr}`;
        };

        for (const [src, srcWallets] of Object.entries(sourceMap)) {
          const srcActiveWallets = srcWallets.filter((w) => w.active);
          const srcInactiveWallets = srcWallets.filter((w) => !w.active);
          const srcLabel = sourceLabels[src] || src;
          sourceBlocks.push(`├─ ${srcLabel} (${srcActiveWallets.length}/${srcWallets.length} active)`);

          // For large sources (PumpPortal Discovery), cap display and show summary
          const isLargeSource = srcWallets.length > MAX_DISPLAY_ACTIVE + MAX_DISPLAY_INACTIVE + 5;

          if (isLargeSource) {
            // Show top active wallets by win rate
            const topActive = srcActiveWallets.slice(0, MAX_DISPLAY_ACTIVE);
            for (const w of topActive) {
              sourceBlocks.push(formatWalletLine(w));
            }
            if (srcActiveWallets.length > MAX_DISPLAY_ACTIVE) {
              sourceBlocks.push(`│  ... +${srcActiveWallets.length - MAX_DISPLAY_ACTIVE} more active`);
            }

            // Show top inactive by win rate (already sorted by our_win_rate DESC)
            const topInactive = srcInactiveWallets.slice(0, MAX_DISPLAY_INACTIVE);
            if (topInactive.length > 0) {
              sourceBlocks.push(`│  ── top inactive:`);
              for (const w of topInactive) {
                sourceBlocks.push(formatWalletLine(w));
              }
              if (srcInactiveWallets.length > MAX_DISPLAY_INACTIVE) {
                sourceBlocks.push(`│  ... +${srcInactiveWallets.length - MAX_DISPLAY_INACTIVE} more inactive`);
              }
            }

            // Summary stats for the source
            const withTradesSrc = srcWallets.filter((w) => Number(w.our_total_trades) > 0);
            if (withTradesSrc.length > 0) {
              const avgWrSrc = (withTradesSrc.reduce((s, w) => s + Number(w.our_win_rate), 0) / withTradesSrc.length * 100).toFixed(0);
              const avgPnlSrc = (withTradesSrc.reduce((s, w) => s + Number(w.our_avg_pnl_percent), 0) / withTradesSrc.length * 100).toFixed(1);
              sourceBlocks.push(`│  📊 Source avg: ${avgWrSrc}% WR, ${avgPnlSrc}% PnL across ${withTradesSrc.length} wallets w/ trades`);
            }
          } else {
            // Small sources: show all wallets
            for (const w of srcWallets) {
              sourceBlocks.push(formatWalletLine(w));
            }
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

    // /tuning — aggregate tuning report for copy-paste analysis
    this.bot.onText(/\/tuning/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        // 1. Overall performance
        const overall = await getOne<Record<string, unknown>>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COALESCE(SUM(net_pnl_sol), 0) as total_pnl_sol,
             COALESCE(AVG(hold_time_mins), 0) as avg_hold,
             COALESCE(AVG(peak_curve_fill_pct), 0) as avg_peak_curve,
             COALESCE(AVG(curve_fill_pct_at_entry), 0) as avg_entry_curve,
             COALESCE(AVG(EXTRACT(EPOCH FROM (entry_time - alpha_buy_time))), 0) as avg_alpha_lag_secs,
             COUNT(*) FILTER (WHERE graduated = TRUE) as graduated
           FROM pumpfun_positions WHERE status = 'CLOSED'`,
        );

        const total = Number(overall?.total || 0);
        if (total === 0) {
          await this.bot.sendMessage(msg.chat.id, '📭 No closed trades yet');
          return;
        }

        const wins = Number(overall?.wins || 0);
        const losses = total - wins;
        const wr = (wins / total * 100).toFixed(0);
        const avgPnl = (Number(overall?.avg_pnl || 0) * 100).toFixed(1);
        const totalPnlSol = Number(overall?.total_pnl_sol || 0).toFixed(4);
        const avgHold = Number(overall?.avg_hold || 0).toFixed(0);
        const avgPeakCurve = (Number(overall?.avg_peak_curve || 0) * 100).toFixed(0);
        const avgEntryCurve = (Number(overall?.avg_entry_curve || 0) * 100).toFixed(0);
        const avgAlphaLag = Number(overall?.avg_alpha_lag_secs || 0).toFixed(0);
        const gradCount = Number(overall?.graduated || 0);

        // 2. Entry type breakdown
        const entryTypes = await getMany<Record<string, unknown>>(
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

        const entryTypeLines = entryTypes.map((et) => {
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

        // 3. Exit reason breakdown with WR
        const exitReasons = await getMany<Record<string, unknown>>(
          `SELECT
             exit_reason,
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl
           FROM pumpfun_positions WHERE status = 'CLOSED' AND exit_reason IS NOT NULL
           GROUP BY exit_reason ORDER BY total DESC LIMIT 8`,
        );

        const exitLines = exitReasons.map((r) => {
          const rTotal = Number(r.total);
          const rWins = Number(r.wins);
          const rWr = rTotal > 0 ? (rWins / rTotal * 100).toFixed(0) : '0';
          const rPnl = (Number(r.avg_pnl) * 100).toFixed(1);
          return `│ ${rTotal}x ${r.exit_reason} (${rWr}%W, avg ${rPnl}%)`;
        });

        // 4. Curve entry zone analysis — where do wins vs losses enter?
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

        // 5. Alpha lag buckets — how does lag correlate with outcomes?
        const lagBuckets = await getMany<Record<string, unknown>>(
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

        const lagLines = lagBuckets.map((l) => {
          const lTotal = Number(l.total);
          const lWins = Number(l.wins);
          const lWr = lTotal > 0 ? (lWins / lTotal * 100).toFixed(0) : '0';
          const lPnl = (Number(l.avg_pnl) * 100).toFixed(1);
          return `│ ${(l.lag_bucket as string).padEnd(6)} ${String(lTotal).padStart(3)}t ${lWr}%W avg${lPnl}%`;
        });

        // 6. Peak curve fill — wins vs losses
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

        // 7. Recent trades detail (last 15 for context)
        const recent = await getMany<Record<string, unknown>>(
          `SELECT token_address, pnl_percent, net_pnl_sol, hold_time_mins, exit_reason,
                  curve_fill_pct_at_entry, peak_curve_fill_pct, graduated,
                  COALESCE(entry_type, 'DIRECT') as entry_type,
                  EXTRACT(EPOCH FROM (entry_time - alpha_buy_time)) as alpha_lag_secs,
                  entry_time
           FROM pumpfun_positions WHERE status = 'CLOSED'
           ORDER BY closed_at DESC LIMIT 15`,
        );

        const recentLines = recent.map((r) => {
          const rPnl = (Number(r.pnl_percent) * 100).toFixed(1);
          const icon = Number(r.pnl_percent) > 0 ? '✅' : '❌';
          const entry = (Number(r.curve_fill_pct_at_entry) * 100).toFixed(0);
          const peak = (Number(r.peak_curve_fill_pct) * 100).toFixed(0);
          const lag = Number(r.alpha_lag_secs || 0).toFixed(0);
          const hold = Number(r.hold_time_mins || 0);
          const grad = r.graduated ? '🎓' : '';
          const type = String(r.entry_type).charAt(0); // D/M/D
          return `│ ${icon} ${(r.token_address as string).slice(0, 6)} ${rPnl}% ${hold}m e${entry}% p${peak}% ${type} ${lag}s ${r.exit_reason}${grad}`;
        });

        // 8. Per-wallet performance
        const walletPerf = await getMany<Record<string, unknown>>(
          `SELECT w.label, COUNT(*) as trades,
                  COUNT(*) FILTER (WHERE p.pnl_percent > 0) as wins,
                  COALESCE(AVG(p.pnl_percent), 0) as avg_pnl,
                  COALESCE(SUM(p.net_pnl_sol), 0) as total_pnl
           FROM pumpfun_positions p
           JOIN wallets w ON w.address = ANY(p.signal_wallets)
           WHERE p.status = 'CLOSED'
           GROUP BY w.label ORDER BY trades DESC LIMIT 10`,
        );

        const walletLines = walletPerf.map((w) => {
          const wTotal = Number(w.trades);
          const wWins = Number(w.wins);
          const wWr = wTotal > 0 ? (wWins / wTotal * 100).toFixed(0) : '0';
          const wPnl = (Number(w.avg_pnl) * 100).toFixed(1);
          const wSol = Number(w.total_pnl).toFixed(4);
          return `│ ${w.label}: ${wTotal}t ${wWr}%W avg${wPnl}% ${wSol}SOL`;
        });

        // Build the full report
        const lines = [
          `🔧 TUNING REPORT (${total} trades)`,
          ``,
          `┌─ OVERVIEW`,
          `│ ${wins}W/${losses}L (${wr}%) · Avg PnL: ${avgPnl}% · Total: ${totalPnlSol} SOL`,
          `│ Avg hold: ${avgHold}min · Avg entry curve: ${avgEntryCurve}% · Avg peak: ${avgPeakCurve}%`,
          `│ Avg alpha lag: ${avgAlphaLag}s · Graduated: ${gradCount}/${total}`,
          `│`,
          `├─ ENTRY TYPE BREAKDOWN`,
          ...(entryTypeLines.length > 0 ? entryTypeLines : ['│  (all DIRECT)']),
          `│`,
          `├─ EXIT REASONS`,
          ...(exitLines.length > 0 ? exitLines : ['│  (none)']),
          `│`,
          `├─ ENTRY CURVE ZONE → OUTCOME`,
          ...zoneLines,
          `│`,
          `├─ ALPHA LAG → OUTCOME`,
          ...lagLines,
          `│`,
          `├─ PEAK CURVE (wins vs losses)`,
          `│ Wins: avg ${avgPeakWins}% median ${medPeakWins}%`,
          `│ Losses: avg ${avgPeakLosses}% median ${medPeakLosses}%`,
          `│`,
          `├─ WALLET PERFORMANCE`,
          ...(walletLines.length > 0 ? walletLines : ['│  (none)']),
          `│`,
          `├─ RECENT TRADES (newest first)`,
          `│ [icon token pnl hold entry peak type lag exit]`,
          ...recentLines,
          `│`,
          `└─ Copy this entire message for tuning analysis`,
        ];

        for (const chunk of this.chunkMessage(lines.join('\n'))) {
          await this.bot.sendMessage(msg.chat.id, chunk);
        }
      } catch (err) {
        logger.error({ err }, 'Failed to generate tuning report');
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load tuning data');
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
      const ourStats = w.trades > 0
        ? `${w.trades}t ${(w.winRate * 100).toFixed(0)}%W EV ${w.avgPnl >= 0 ? '+' : ''}${(w.avgPnl * 100).toFixed(1)}%`
        : 'new';
      // Show Nansen data when available so we can diagnose blended quality
      const nansenTag = w.nansenRoi && w.nansenRoi > 0
        ? ` | Nansen: ${w.nansenRoi.toFixed(0)}% ROI`
        : w.nansenPnlUsd && w.nansenPnlUsd > 0
          ? ` | Nansen: $${this.formatNum(w.nansenPnlUsd)} PnL (ROI=0!)`
          : '';
      return `│  ${w.label} (${w.address.slice(0, 6)}): ${ourStats}${nansenTag}`;
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
    wallets: Array<{ address: string; label: string; trades: number; winRate: number; avgPnl: number }>;
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
      const stats = w.trades > 0
        ? `${w.trades}t ${(w.winRate * 100).toFixed(0)}%W EV ${w.avgPnl >= 0 ? '+' : ''}${(w.avgPnl * 100).toFixed(1)}%`
        : 'new (first trade)';
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

  async shutdown(): Promise<void> {
    this.bot.stopPolling();
  }
}
