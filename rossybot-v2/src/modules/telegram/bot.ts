import TelegramBot from 'node-telegram-bot-api';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getMany, getOne, query } from '../../db/database.js';
import type { ShadowPosition } from '../../types/index.js';

export class TelegramService {
  private bot: TelegramBot;
  private chatId: string;
  private paused = false;

  // Callbacks for commands
  private onPause: (() => void) | null = null;
  private onResume: (() => void) | null = null;
  private onForceDiscovery: (() => void) | null = null;
  private getStatus: (() => Record<string, unknown>) | null = null;
  private getPositions: (() => ShadowPosition[]) | null = null;
  private getWsHealth: (() => Record<string, unknown>) | null = null;
  private getNansenUsage: (() => Record<string, unknown>) | null = null;

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
  setPositionsCallback(cb: () => ShadowPosition[]): void { this.getPositions = cb; }
  setWsHealthCallback(cb: () => Record<string, unknown>): void { this.getWsHealth = cb; }
  setNansenUsageCallback(cb: () => Record<string, unknown>): void { this.getNansenUsage = cb; }

  get isPaused(): boolean { return this.paused; }

  // --- Alert methods ---

  async sendEntryAlert(data: {
    tokenSymbol: string;
    tokenMint: string;
    tier: string;
    wallets: string[];
    walletCount: number;
    totalMonitored: number;
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
  }): Promise<void> {
    const walletLabels = data.wallets.map((w) => w.slice(0, 8)).join(' + ');
    const dexLink = `https://dexscreener.com/solana/${data.tokenMint}`;
    const msg = [
      `🟢 ENTRY: $${data.tokenSymbol} [${data.tier}] (SHADOW)`,
      `├ Wallets: ${walletLabels} (${data.walletCount}/${data.totalMonitored} via Helius ✅)`,
      `├ Size: ${data.sizeSol.toFixed(2)} SOL @ $${data.price.toFixed(6)}`,
      `├ Momentum: ${data.momentum24h > 0 ? '+' : ''}${data.momentum24h.toFixed(0)}% (24h) | Vol ${data.volumeMultiplier.toFixed(1)}x avg`,
      `├ MCap: $${this.formatNum(data.mcap)} | Liq: $${this.formatNum(data.liquidity)} | Age: ${data.ageDays.toFixed(0)}d`,
      `├ Safety: ✅ | Helius lag: ${(data.detectionLagMs / 1000).toFixed(1)}s`,
      `├ Execution lag: ${this.formatLag(data.executionLagSecs)}`,
      `├ Exit: TP +${(data.profitTarget * 100).toFixed(0)}%, SL ${(data.stopLoss * 100).toFixed(0)}%, alpha exit, ${data.hardTime}h max`,
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
  }): Promise<void> {
    const msg = [
      `💰 TARGET: $${data.tokenSymbol} +${(data.pnlPercent * 100).toFixed(0)}%`,
      `├ ${data.entrySol.toFixed(2)} SOL → ${data.exitSol.toFixed(3)} SOL | Net: +${data.netPnlSol.toFixed(3)} SOL`,
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
  }): Promise<void> {
    const msg = [
      `🔴 EXIT: $${data.tokenSymbol} ${(data.pnlPercent * 100).toFixed(1)}%`,
      `├ Loss: ${data.lossSol.toFixed(3)} SOL`,
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

  /** Notify on every individual wallet trade detection */
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
      const statsStr = stats.length > 0 ? ` | ${stats.join(' · ')}` : '';
      return `│  ${status} [${w.tier}] ${w.address.slice(0, 6)}...${w.address.slice(-4)}${statsStr}`;
    }).join('\n');

    const msg = [
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
      `│ Max positions: ${data.maxPositions}`,
      `│ Open positions: ${data.openPositions}`,
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
      `├─ STATS`,
      `│ Signals today: ${data.signalsToday}`,
      `│ All-time trades: ${data.tradesAllTime}`,
      `│`,
      `└─ STATUS: ✅ RUNNING`,
    ].join('\n');

    await this.send(msg);
  }

  // --- Command handlers ---

  private setupCommands(): void {
    this.bot.onText(/\/status/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const status = this.getStatus?.() || {};
      const text = [
        `📍 STATUS`,
        `├ Capital: ${(status.capitalSol as number || 0).toFixed(2)} SOL [${status.tier || 'MICRO'}]`,
        `├ Positions: ${status.openPositions || 0}/${status.maxPositions || 2}`,
        `├ Paused: ${this.paused ? 'YES' : 'NO'}`,
        `├ Shadow mode: ${config.shadowMode ? 'YES' : 'NO'}`,
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
        return `${p.pnl_percent >= 0 ? '🟢' : '🔴'} $${p.token_symbol || p.token_address.slice(0, 8)} | ${pnl}% | ${this.formatHoldTime(holdMins)} | ${p.simulated_entry_sol.toFixed(2)} SOL`;
      });
      await this.bot.sendMessage(msg.chat.id, `📊 POSITIONS\n${lines.join('\n')}`);
    });

    this.bot.onText(/\/wallets/, async (msg) => {
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

    this.bot.onText(/\/api/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const nansen = this.getNansenUsage?.() || {};
      const ws = this.getWsHealth?.() || {};
      await this.bot.sendMessage(msg.chat.id, [
        `📡 API USAGE`,
        `├ Nansen: ${nansen.callsLastMinute || 0}/${nansen.maxPerMinute || 80} calls/min`,
        `├ Nansen queue: ${nansen.queueLength || 0}`,
        `├ Helius WS: ${(ws.connected as boolean) ? '✅' : '❌'}`,
        `├ Helius wallets: ${ws.subscribedWallets || 0}`,
        `└ Last message: ${ws.lastMessageAgoMs ? `${((ws.lastMessageAgoMs as number) / 1000).toFixed(0)}s ago` : 'N/A'}`,
      ].join('\n'));
    });

    this.bot.onText(/\/health/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const ws = this.getWsHealth?.() || {};
      const nansen = this.getNansenUsage?.() || {};
      const status = this.getStatus?.() || {};
      await this.bot.sendMessage(msg.chat.id, [
        `🏥 SYSTEM HEALTH`,
        `├ WebSocket: ${(ws.connected as boolean) ? '✅ Connected' : '❌ Disconnected'}`,
        `├ Fallback: ${(ws.fallbackMode as boolean) ? '⚠️ ACTIVE' : '✅ Off'}`,
        `├ Subscribed: ${ws.subscribedWallets || 0} wallets`,
        `├ Last msg: ${ws.lastMessageAgoMs ? Math.round((ws.lastMessageAgoMs as number) / 1000) + 's ago' : '?'} | Last TX: ${(ws.lastTxAgoMs as number) > 0 ? Math.round((ws.lastTxAgoMs as number) / 1000) + 's ago' : 'none yet'}`,
        `├ WS msgs: ${ws.totalMessages || 0} total | ${ws.txNotifications || 0} txs`,
        `├ Nansen: ${nansen.callsLastMinute || 0}/${nansen.maxPerMinute || 80}/min`,
        `├ Positions: ${status.openPositions || 0}/${status.maxPositions || 2}`,
        `├ Capital: ${(status.capitalSol as number || 0).toFixed(2)} SOL [${status.tier || 'MICRO'}]`,
        `├ Shadow: ${config.shadowMode ? 'YES' : 'NO'}`,
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
      await this.bot.sendMessage(msg.chat.id, `🔪 Force close for ${token} — not implemented in shadow mode`);
    });

    this.bot.onText(/\/pnl/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      try {
        // Open positions from in-memory tracker
        const open = this.getPositions?.() || [];
        const openCount = open.length;
        const unrealizedSol = open.reduce((s, p) => s + p.simulated_entry_sol * p.pnl_percent, 0);
        const unrealizedPct = open.length > 0
          ? open.reduce((s, p) => s + p.pnl_percent, 0) / open.length * 100
          : 0;

        // Closed positions from DB
        const closed = await getOne<Record<string, unknown>>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (WHERE pnl_percent > 0) as wins,
             COUNT(*) FILTER (WHERE pnl_percent <= 0) as losses,
             COALESCE(SUM(simulated_entry_sol * pnl_percent), 0) as realized_sol,
             COALESCE(AVG(pnl_percent), 0) as avg_pnl,
             COALESCE(AVG(hold_time_mins), 0) as avg_hold,
             MIN(entry_time) as first_trade
           FROM shadow_positions WHERE status = 'CLOSED'`,
        );

        const total = Number(closed?.total || 0);
        const wins = Number(closed?.wins || 0);
        const losses = Number(closed?.losses || 0);
        const realizedSol = Number(closed?.realized_sol || 0);
        const avgPnl = Number(closed?.avg_pnl || 0);
        const avgHold = Number(closed?.avg_hold || 0);
        const wr = total > 0 ? (wins / total * 100).toFixed(0) : 'N/A';
        const netSol = realizedSol + unrealizedSol;
        const firstTrade = closed?.first_trade ? new Date(closed.first_trade as string) : null;
        const sinceStr = firstTrade
          ? firstTrade.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : 'N/A';

        await this.bot.sendMessage(msg.chat.id, [
          `📈 SHADOW P&L`,
          `├ Open positions: ${openCount}`,
          `├ Unrealized: ${unrealizedSol >= 0 ? '+' : ''}${unrealizedSol.toFixed(3)} SOL (${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(1)}% avg)`,
          `├ Realized: ${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(3)} SOL (${total} trades)`,
          `├ Net: ${netSol >= 0 ? '+' : ''}${netSol.toFixed(3)} SOL`,
          `├ Win rate: ${wr}% (${wins}W / ${losses}L)`,
          `├ Avg PnL: ${(avgPnl * 100).toFixed(1)}% | Avg hold: ${this.formatHoldTime(avgHold)}`,
          `└ Since: ${sinceStr}`,
        ].join('\n'));
      } catch (err) {
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to load PnL data');
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

          // Extract the specific failure reason from validation details
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

    logger.info('Telegram bot commands registered');
  }

  // --- Helpers ---

  private async send(text: string): Promise<void> {
    try {
      for (const chunk of this.chunkMessage(text)) {
        await this.bot.sendMessage(this.chatId, chunk, { parse_mode: undefined });
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
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const m = mins % 60;
    return `${hours}h ${m}m`;
  }

  async shutdown(): Promise<void> {
    this.bot.stopPolling();
  }
}
