import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config, getTierConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { testConnection } from './db/database.js';

// Modules
import { HeliusWebSocketManager, TransactionParser, FallbackPoller } from './modules/helius/index.js';
import { NansenClient, WalletDiscovery } from './modules/nansen/index.js';
import { EntryEngine, type ValidatedSignal } from './modules/signals/index.js';
import { scoreSignal, formatScoreForTelegram, type WalletEv } from './modules/signals/signal-scorer.js';
import { ShadowTracker } from './modules/positions/index.js';
import { LiveTracker } from './modules/positions/live-tracker.js';
import { CapitalManager } from './modules/trading/capital-manager.js';
import { SwapExecutor } from './modules/trading/swap-executor.js';
import { TelegramService } from './modules/telegram/index.js';
import { SignalType, type ParsedSignal, type PositionView } from './types/index.js';

/** Convert ShadowPosition to common PositionView */
function shadowToView(p: ReturnType<ShadowTracker['getOpenPositions']>[number]): PositionView {
  return {
    id: p.id,
    token_address: p.token_address,
    token_symbol: p.token_symbol,
    entry_price: p.entry_price,
    entry_sol: p.simulated_entry_sol,
    entry_time: p.entry_time,
    alpha_buy_time: p.alpha_buy_time,
    status: p.status,
    current_price: p.current_price,
    peak_price: p.peak_price,
    pnl_percent: p.pnl_percent,
    pnl_sol: p.simulated_entry_sol * p.pnl_percent,
    fees_paid_sol: 0,
    net_pnl_sol: p.simulated_entry_sol * p.pnl_percent,
    exit_reason: p.exit_reason,
    closed_at: p.closed_at,
    hold_time_mins: p.hold_time_mins,
    partial_exits: p.partial_exits,
    signal_wallets: p.signal_wallets,
    capital_tier: p.capital_tier,
  };
}

/** Convert Position to common PositionView */
function liveToView(p: ReturnType<LiveTracker['getOpenPositions']>[number]): PositionView {
  return {
    id: p.id,
    token_address: p.token_address,
    token_symbol: p.token_symbol,
    entry_price: p.entry_price,
    entry_sol: p.entry_sol,
    entry_time: p.entry_time,
    alpha_buy_time: p.alpha_buy_time,
    status: p.status,
    current_price: p.current_price,
    peak_price: p.peak_price,
    pnl_percent: p.pnl_percent,
    pnl_sol: p.pnl_sol,
    fees_paid_sol: p.fees_paid_sol,
    net_pnl_sol: p.net_pnl_sol,
    exit_reason: p.exit_reason,
    closed_at: p.closed_at,
    hold_time_mins: p.hold_time_mins,
    partial_exits: p.partial_exits.map((pe) => ({
      time: (pe as Record<string, unknown>).time as Date,
      pct: (pe as Record<string, unknown>).pct as number,
      price: (pe as Record<string, unknown>).price as number,
      reason: (pe as Record<string, unknown>).reason as string,
    })),
    signal_wallets: [p.signal_wallet],
    capital_tier: p.capital_tier_at_entry,
    entry_tx: p.entry_tx,
  };
}

class RossyBotV2 {
  private wsManager: HeliusWebSocketManager;
  private txParser: TransactionParser;
  private fallbackPoller: FallbackPoller;
  private nansen: NansenClient;
  private walletDiscovery: WalletDiscovery;
  private entryEngine: EntryEngine;
  private capitalManager: CapitalManager;
  private telegram: TelegramService;
  private walletAddresses: string[] = [];
  private dailySummaryInterval: ReturnType<typeof setInterval> | null = null;

  // Position tracking — one or the other based on mode
  private shadowTracker: ShadowTracker | null = null;
  private liveTracker: LiveTracker | null = null;
  private swapExecutor: SwapExecutor | null = null;

  private get isLive(): boolean {
    return !config.shadowMode && this.liveTracker !== null;
  }

  constructor() {
    // Derive public key from private key (optional in shadow mode)
    let publicKey: string;
    if (config.wallet.privateKey) {
      const keypair = Keypair.fromSecretKey(bs58.decode(config.wallet.privateKey));
      publicKey = keypair.publicKey.toBase58();
    } else {
      publicKey = '11111111111111111111111111111111';
      console.log('No WALLET_PRIVATE_KEY set — running in shadow-only mode (MICRO tier, 0 SOL)');
    }

    // Initialize all modules
    this.capitalManager = new CapitalManager(publicKey);
    this.wsManager = new HeliusWebSocketManager();
    this.txParser = new TransactionParser([]);
    this.fallbackPoller = new FallbackPoller(this.txParser, []);
    this.nansen = new NansenClient();
    this.walletDiscovery = new WalletDiscovery(this.nansen);
    this.entryEngine = new EntryEngine();
    this.telegram = new TelegramService();

    // Initialize position tracker based on mode
    if (!config.shadowMode && config.wallet.privateKey) {
      this.swapExecutor = new SwapExecutor();
      this.liveTracker = new LiveTracker(this.swapExecutor);
      logger.info('LIVE mode — Jupiter swap execution enabled');
    } else {
      this.shadowTracker = new ShadowTracker();
      logger.info('SHADOW mode — simulated positions only');
    }
  }

  // --- Unified position accessors ---
  private getOpenPositions(): PositionView[] {
    if (this.liveTracker) return this.liveTracker.getOpenPositions().map(liveToView);
    return this.shadowTracker!.getOpenPositions().map(shadowToView);
  }

  private getOpenCount(): number {
    return this.liveTracker?.getOpenCount() ?? this.shadowTracker!.getOpenCount();
  }

  private hasPosition(tokenMint: string): boolean {
    return this.liveTracker?.hasPosition(tokenMint) ?? this.shadowTracker!.hasPosition(tokenMint);
  }

  async start(): Promise<void> {
    logger.info('=== ROSSYBOT V2 — Starting ===');
    logger.info({ shadowMode: config.shadowMode, live: this.isLive }, 'Mode');

    // 1. Test database connection
    const dbOk = await testConnection();
    if (!dbOk) {
      logger.error('Database connection failed — exiting');
      process.exit(1);
    }

    // 2. Initialize capital manager
    await this.capitalManager.initialize();
    const tier = this.capitalManager.tier;
    const tierCfg = getTierConfig(tier);
    logger.info({
      capital: this.capitalManager.capital,
      tier,
      maxPositions: tierCfg.maxPositions,
      walletsToMonitor: tierCfg.walletsMonitored,
    }, 'Capital tier determined');

    // 3. Seed wallets, enforce $10K PnL minimum, check on-chain activity, and load from DB
    await this.walletDiscovery.seedWallets(tier);
    await this.walletDiscovery.enforceMinimumPnl();
    const activityDeactivated = await this.walletDiscovery.enforceTradeActivity(true);
    if (activityDeactivated > 0) {
      console.log(`Deactivated ${activityDeactivated} inactive wallets (no on-chain activity in 7 days)`);
    }
    const allActiveWallets = await this.walletDiscovery.getActiveWallets();

    // Helius WS monitors top N wallets (tier-limited)
    this.walletAddresses = allActiveWallets.slice(0, tierCfg.walletsMonitored);
    logger.info({ subscribed: this.walletAddresses.length, total: allActiveWallets.length }, 'Active wallets loaded');

    // 4. Update parsers (subscribed wallets for WS detection)
    this.txParser.updateWallets(this.walletAddresses);
    this.fallbackPoller.updateWallets(this.walletAddresses);

    // Give entry engine ALL tracked wallets for on-chain confluence checks
    this.entryEngine.updateAllTrackedWallets(allActiveWallets);

    // 5. Load open positions
    if (this.liveTracker) {
      await this.liveTracker.loadOpenPositions();
    } else {
      await this.shadowTracker!.loadOpenPositions();
    }

    // 6. Wire up callbacks
    this.wireCallbacks();

    // 7. Connect Helius WebSocket (THE CRITICAL STEP)
    await this.wsManager.connect(this.walletAddresses);

    // 8. Start position price monitoring
    if (this.liveTracker) {
      this.liveTracker.start();
    } else {
      this.shadowTracker!.start();
    }

    // 9. Start Nansen wallet discovery (scheduled every 4h + immediate first run)
    this.walletDiscovery.start();
    this.walletDiscovery.runDiscovery().catch((err) =>
      console.error('Initial discovery failed:', err),
    );

    // 10. Start Telegram bot polling
    await this.telegram.startPolling();

    // 11. Schedule daily summary at UTC midnight
    this.scheduleDailySummary();

    // 12. Send full startup diagnostics to Telegram
    await this.sendStartupDiagnostics();

    logger.info('=== ROSSYBOT V2 — Running ===');
  }

  private wireCallbacks(): void {
    // --- Helius WebSocket → Transaction Parser ---
    this.wsManager.on('transaction', async (data: unknown) => {
      if (this.telegram.isPaused) return;

      try {
        const signals = await this.txParser.parse(data as Parameters<typeof this.txParser.parse>[0]);
        const tierCfg = getTierConfig(this.capitalManager.tier);

        for (const signal of signals) {
          // Send Telegram alert for every detected trade (pipeline visibility)
          const walletRow = await (await import('./db/database.js')).getOne<{ label: string }>(
            `SELECT label FROM alpha_wallets WHERE address = $1`, [signal.walletAddress],
          );
          await this.telegram.sendTradeDetected({
            action: signal.type === SignalType.BUY ? 'BUY' : 'SELL',
            walletAddress: signal.walletAddress,
            walletLabel: walletRow?.label || signal.walletAddress.slice(0, 8),
            tokenMint: signal.tokenMint,
            tokenSymbol: signal.tokenMint.slice(0, 6),
            amountUsd: Math.abs(signal.solDelta) * 170,
            detectionLagMs: signal.detectionLagMs,
          });

          if (signal.type === SignalType.BUY) {
            await this.entryEngine.processBuySignal(signal, tierCfg);
          } else if (signal.type === SignalType.SELL) {
            await this.handleSellSignal(signal);
          }
        }
      } catch (err) {
        logger.error({ err }, 'Error processing transaction');
      }
    });

    // --- WebSocket fallback ---
    this.wsManager.on('fallbackActivated', async () => {
      try {
        logger.warn('Fallback mode ACTIVATED');
        this.fallbackPoller.start();
        await this.telegram.sendWebSocketAlert('down', {
          lastMessageAgo: `${((Date.now() - Date.now()) / 1000).toFixed(0)}s`,
          attempts: 5,
          maxAttempts: 5,
        });
      } catch (err) {
        logger.error({ err }, 'Error in fallbackActivated handler');
      }
    });

    this.wsManager.on('fallbackDeactivated', async () => {
      try {
        logger.info('Fallback mode DEACTIVATED');
        this.fallbackPoller.stop();
        await this.telegram.sendWebSocketAlert('restored', {
          wallets: this.walletAddresses.length,
          downtime: 'recovered',
        });
      } catch (err) {
        logger.error({ err }, 'Error in fallbackDeactivated handler');
      }
    });

    // --- Entry Engine → Position Tracker ---
    this.entryEngine.setSignalCallback(async (signal: ValidatedSignal) => {
      try {
        // Look up per-wallet EV stats from DB
        const { getMany: dbGetMany } = await import('./db/database.js');
        const walletStats = await dbGetMany<{
          address: string; our_total_trades: number; our_win_rate: number; our_avg_pnl_percent: number;
        }>(
          `SELECT address, COALESCE(our_total_trades, 0) as our_total_trades,
                  COALESCE(our_win_rate, 0) as our_win_rate,
                  COALESCE(our_avg_pnl_percent, 0) as our_avg_pnl_percent
             FROM alpha_wallets WHERE address = ANY($1)`,
          [signal.walletAddresses],
        );
        const walletEvMap = new Map<string, WalletEv>(walletStats.map((w) => [w.address, {
          trades: Number(w.our_total_trades),
          winRate: Number(w.our_win_rate),
          avgPnl: Number(w.our_avg_pnl_percent),
        }]));

        // Score the signal
        const score = scoreSignal(signal, walletEvMap);
        const scoreDisplay = formatScoreForTelegram(score);

        logger.info({
          token: signal.tokenMint.slice(0, 8),
          score: score.total,
          breakdown: score.breakdown,
        }, 'Signal scored');

        // Check if we can open a position
        if (!this.capitalManager.canOpenPosition(this.getOpenCount())) {
          logger.info({
            reason: 'max positions or daily limit',
            score: score.total,
          }, 'Skipping signal — cannot open position');

          const openPositions = this.getOpenPositions();
          const weakest = openPositions.length > 0
            ? openPositions.reduce((a, b) => a.pnl_percent < b.pnl_percent ? a : b)
            : null;

          await this.telegram.sendOpportunityCostAlert({
            tokenSymbol: signal.tokenSymbol || signal.tokenMint.slice(0, 8),
            tokenMint: signal.tokenMint,
            signalScore: scoreDisplay,
            currentPositionSymbol: weakest?.token_symbol || weakest?.token_address?.slice(0, 8) || 'unknown',
            currentPositionPnl: weakest?.pnl_percent || 0,
            currentPositionHoldMins: weakest?.hold_time_mins || (weakest ? Math.round((Date.now() - weakest.entry_time.getTime()) / 60000) : 0),
          });
          return;
        }

        if (this.hasPosition(signal.tokenMint)) {
          logger.info({ token: signal.tokenMint.slice(0, 8) }, 'Skipping signal — already have position');
          return;
        }

        const positionSize = this.capitalManager.getPositionSize();
        let posView: PositionView;

        if (this.liveTracker) {
          // LIVE: Execute real swap
          const pos = await this.liveTracker.openPosition(signal, positionSize);
          if (!pos) return; // Swap failed — already logged
          posView = liveToView(pos);

          // Refresh balance after trade
          await this.capitalManager.refreshBalance();
        } else {
          // SHADOW: Simulated
          const pos = await this.shadowTracker!.openPosition(signal, positionSize);
          posView = shadowToView(pos);
        }

        // Send Telegram alert
        const dex = signal.validation.dexData;
        await this.telegram.sendEntryAlert({
          tokenSymbol: signal.tokenSymbol || signal.tokenMint.slice(0, 8),
          tokenMint: signal.tokenMint,
          tier: signal.tierConfig.tier,
          wallets: signal.walletAddresses,
          walletCount: signal.walletCount,
          totalMonitored: this.walletAddresses.length,
          walletEv: signal.walletAddresses.map((addr) => {
            const stats = walletEvMap.get(addr);
            return {
              address: addr,
              trades: stats?.trades || 0,
              winRate: stats?.winRate || 0,
              avgPnl: stats?.avgPnl || 0,
            };
          }),
          signalScore: scoreDisplay,
          sizeSol: posView.entry_sol,
          price: posView.entry_price,
          momentum24h: dex?.priceChange?.h24 || 0,
          volumeMultiplier: dex ? (dex.volume?.h24 || 0) / Math.max((dex.volume?.h24 || 1), 1) : 0,
          mcap: dex?.marketCap || dex?.fdv || 0,
          liquidity: dex?.liquidity?.usd || 0,
          ageDays: dex?.pairCreatedAt ? (Date.now() - dex.pairCreatedAt) / 86400000 : 0,
          detectionLagMs: signal.firstSignal.detectionLagMs,
          executionLagSecs: Math.round((Date.now() - signal.firstSignal.blockTime * 1000) / 1000),
          profitTarget: signal.tierConfig.profitTarget,
          stopLoss: signal.tierConfig.stopLoss,
          hardTime: signal.tierConfig.hardTimeHours,
          entryTx: posView.entry_tx,
          feesSol: posView.fees_paid_sol,
          isLive: this.isLive,
        });
      } catch (err) {
        logger.error({ err, token: signal.tokenMint?.slice(0, 8) }, 'Error in entry signal callback');
      }
    });

    // --- Entry Engine → Signal validation log ---
    this.entryEngine.setSignalLogCallback(async (signal, validation) => {
      try {
        const { getMany: dbGetMany } = await import('./db/database.js');
        const walletRows = await dbGetMany<{
          address: string; label: string; our_total_trades: number; our_win_rate: number; our_avg_pnl_percent: number;
        }>(
          `SELECT address, label, COALESCE(our_total_trades, 0) as our_total_trades,
                  COALESCE(our_win_rate, 0) as our_win_rate,
                  COALESCE(our_avg_pnl_percent, 0) as our_avg_pnl_percent
             FROM alpha_wallets WHERE address = ANY($1)`,
          [signal.walletAddresses],
        );
        const walletMap = new Map(walletRows.map((w) => [w.address, w]));

        const dex = validation.dexData;
        await this.telegram.sendSignalLog({
          tokenSymbol: signal.tokenSymbol || signal.tokenMint.slice(0, 8),
          tokenMint: signal.tokenMint,
          passed: signal.passed,
          failReason: signal.failReason,
          wallets: signal.walletAddresses.map((addr) => {
            const w = walletMap.get(addr);
            return {
              address: addr,
              label: w?.label || addr.slice(0, 8),
              trades: Number(w?.our_total_trades || 0),
              winRate: Number(w?.our_win_rate || 0),
              avgPnl: Number(w?.our_avg_pnl_percent || 0),
            };
          }),
          totalMonitored: this.walletAddresses.length,
          safety: validation.safety,
          liquidity: validation.liquidity,
          momentum: validation.momentum,
          mcap: validation.mcap,
          age: validation.age,
          dexData: dex ? {
            mcap: dex.marketCap || dex.fdv || 0,
            liquidity: dex.liquidity?.usd || 0,
            priceChange24h: dex.priceChange?.h24 || 0,
            priceChange6h: dex.priceChange?.h6 || 0,
            priceChange1h: dex.priceChange?.h1 || 0,
            volume24h: dex.volume?.h24 || 0,
            ageDays: dex.pairCreatedAt ? (Date.now() - dex.pairCreatedAt) / 86400000 : 0,
          } : null,
          validationMs: validation.durationMs,
          action: signal.passed ? 'ENTERED' : 'SKIPPED',
        });
      } catch (err) {
        logger.error({ err }, 'Error in signal log callback');
      }
    });

    // --- Position close callback (works for both trackers) ---
    const handlePositionClose = async (posView: PositionView) => {
      try {
        const pnl = posView.pnl_percent;
        if (pnl >= 0) {
          await this.telegram.sendProfitTargetAlert({
            tokenSymbol: posView.token_symbol || posView.token_address.slice(0, 8),
            pnlPercent: pnl,
            entrySol: posView.entry_sol,
            exitSol: posView.entry_sol * (1 + pnl),
            netPnlSol: posView.net_pnl_sol,
            holdMins: posView.hold_time_mins || 0,
            capitalBefore: this.capitalManager.capital,
            capitalAfter: this.capitalManager.capital + posView.net_pnl_sol,
            feesSol: posView.fees_paid_sol,
            entryTx: posView.entry_tx,
            isLive: this.isLive,
          });
        } else {
          this.capitalManager.recordLoss(Math.abs(posView.net_pnl_sol));
          await this.telegram.sendStopLossAlert({
            tokenSymbol: posView.token_symbol || posView.token_address.slice(0, 8),
            pnlPercent: pnl,
            lossSol: Math.abs(posView.net_pnl_sol),
            holdMins: posView.hold_time_mins || 0,
            reason: posView.exit_reason || 'Unknown',
            feesSol: posView.fees_paid_sol,
            isLive: this.isLive,
          });
        }

        // Refresh balance after close in live mode
        if (this.isLive) {
          await this.capitalManager.refreshBalance();
        }

        // Send detailed trade close log
        const { getMany: dbGetMany } = await import('./db/database.js');
        const walletRows = await dbGetMany<{
          address: string; label: string; our_total_trades: number; our_win_rate: number; our_avg_pnl_percent: number;
        }>(
          `SELECT address, label, COALESCE(our_total_trades, 0) as our_total_trades,
                  COALESCE(our_win_rate, 0) as our_win_rate,
                  COALESCE(our_avg_pnl_percent, 0) as our_avg_pnl_percent
             FROM alpha_wallets WHERE address = ANY($1)`,
          [posView.signal_wallets],
        );
        const walletMap = new Map(walletRows.map((w) => [w.address, w]));

        const detectionLagMs = posView.entry_time.getTime() - posView.alpha_buy_time.getTime();

        await this.telegram.sendTradeCloseLog({
          tokenSymbol: posView.token_symbol || posView.token_address.slice(0, 8),
          tokenMint: posView.token_address,
          pnlPercent: pnl,
          pnlSol: posView.pnl_sol,
          entryPrice: posView.entry_price,
          exitPrice: posView.current_price,
          peakPrice: posView.peak_price,
          sizeSol: posView.entry_sol,
          holdMins: posView.hold_time_mins || 0,
          exitReason: posView.exit_reason || 'Unknown',
          tier: posView.capital_tier,
          wallets: posView.signal_wallets.map((addr) => {
            const w = walletMap.get(addr);
            return {
              address: addr,
              label: w?.label || addr.slice(0, 8),
              trades: Number(w?.our_total_trades || 0),
              winRate: Number(w?.our_win_rate || 0),
              avgPnl: Number(w?.our_avg_pnl_percent || 0),
            };
          }),
          entryTime: posView.entry_time.toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
          exitTime: (posView.closed_at || new Date()).toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
          detectionLagMs: Math.max(0, detectionLagMs),
          feesSol: posView.fees_paid_sol,
          netPnlSol: posView.net_pnl_sol,
          isLive: this.isLive,
        });
      } catch (err) {
        logger.error({ err, token: posView.token_address?.slice(0, 8) }, 'Error in position close callback');
      }
    };

    if (this.liveTracker) {
      this.liveTracker.setCloseCallback((pos) => handlePositionClose(liveToView(pos)));
      this.liveTracker.setAlphaExitCallback(async (pos, walletAddress, sellPct) => {
        const { getOne: dbGetOne } = await import('./db/database.js');
        const walletRow = await dbGetOne<{ label: string }>(
          `SELECT label FROM alpha_wallets WHERE address = $1`, [walletAddress],
        );
        await this.telegram.sendAlphaExitAlert({
          walletLabel: walletRow?.label || walletAddress.slice(0, 8),
          sellPct,
          tokenSymbol: pos.token_symbol || pos.token_address.slice(0, 8),
          detectionLagMs: 0,
          action: `SOLD 100% (${pos.capital_tier_at_entry})`,
          pnlPercent: pos.pnl_percent,
          pnlSol: pos.net_pnl_sol,
          holdMins: pos.hold_time_mins || Math.round((Date.now() - pos.entry_time.getTime()) / 60000),
        });
      });
      this.liveTracker.setSwapFailedCallback(async (tokenSymbol, error, type) => {
        await this.telegram.send(`🚫 ${type} SWAP FAILED: $${tokenSymbol}\n└ ${error}`);
      });
    } else {
      this.shadowTracker!.setCloseCallback((pos) => handlePositionClose(shadowToView(pos)));
      this.shadowTracker!.setAlphaExitCallback(async (pos, walletAddress, sellPct) => {
        const { getOne: dbGetOne } = await import('./db/database.js');
        const walletRow = await dbGetOne<{ label: string }>(
          `SELECT label FROM alpha_wallets WHERE address = $1`, [walletAddress],
        );
        await this.telegram.sendAlphaExitAlert({
          walletLabel: walletRow?.label || walletAddress.slice(0, 8),
          sellPct,
          tokenSymbol: pos.token_symbol || pos.token_address.slice(0, 8),
          detectionLagMs: 0,
          action: `SOLD 100% (${pos.capital_tier} — SHADOW)`,
          pnlPercent: pos.pnl_percent,
          pnlSol: pos.simulated_entry_sol * pos.pnl_percent,
          holdMins: pos.hold_time_mins || Math.round((Date.now() - pos.entry_time.getTime()) / 60000),
        });
      });
    }

    // --- Wallet Discovery → Helius subscription ---
    this.walletDiscovery.setNewWalletCallback(async (address: string) => {
      try {
        this.entryEngine.updateAllTrackedWallets(
          await this.walletDiscovery.getActiveWallets(),
        );

        const tierCfg = getTierConfig(this.capitalManager.tier);
        if (this.walletAddresses.length >= tierCfg.walletsMonitored) {
          logger.info({ address: address.slice(0, 8) }, 'New wallet added for on-chain confluence (WS slots full)');
          return;
        }
        this.walletAddresses.push(address);
        this.txParser.addWallet(address);
        await this.wsManager.addWallet(address);
        logger.info({ address: address.slice(0, 8), total: this.walletAddresses.length }, 'New wallet subscribed via Helius');
      } catch (err) {
        logger.error({ err, address: address?.slice(0, 8) }, 'Error in new wallet callback');
      }
    });

    // --- Telegram callbacks ---
    this.telegram.setStatusCallback(() => {
      const ws = this.wsManager.getStatus();
      return {
        capitalSol: this.capitalManager.capital,
        tier: this.capitalManager.tier,
        openPositions: this.getOpenCount(),
        maxPositions: this.capitalManager.tierConfig.maxPositions,
        wsConnected: ws.connected,
        wsFallback: ws.fallbackMode,
        dailyPnl: '0.00',
        isLive: this.isLive,
      };
    });

    this.telegram.setPositionsCallback(() => this.getOpenPositions());
    this.telegram.setWsHealthCallback(() => this.wsManager.getStatus());
    this.telegram.setNansenUsageCallback(() => this.nansen.usage);
    this.telegram.setDiscoveryCallback(() => this.walletDiscovery.runDiscovery());
    this.telegram.setPauseCallback(() => logger.info('Trading PAUSED via Telegram'));
    this.telegram.setResumeCallback(() => logger.info('Trading RESUMED via Telegram'));

    // /kill command — live mode force close
    if (this.liveTracker) {
      this.telegram.setKillCallback(async (tokenIdentifier: string) => {
        return this.liveTracker!.forceClose(tokenIdentifier);
      });
    }
  }

  /** Handle sell signals from alpha wallets */
  private async handleSellSignal(signal: ParsedSignal): Promise<void> {
    const openPositions = this.getOpenPositions();
    const affected = openPositions.filter((p) => p.token_address === signal.tokenMint);

    if (affected.length === 0) return;

    logger.info({
      wallet: signal.walletAddress.slice(0, 8),
      token: signal.tokenMint.slice(0, 8),
      amount: signal.tokenAmount,
    }, 'Alpha wallet SELL detected on held token');

    const estimatedSellPct = 0.5;

    if (this.liveTracker) {
      await this.liveTracker.handleAlphaExit(signal.tokenMint, signal.walletAddress, estimatedSellPct);
    } else {
      await this.shadowTracker!.handleAlphaExit(signal.tokenMint, signal.walletAddress, estimatedSellPct);
    }

    // Log to alpha_wallet_exits
    try {
      const pos = affected[0];
      const { query: dbQuery } = await import('./db/database.js');
      await dbQuery(
        `INSERT INTO alpha_wallet_exits (position_id, wallet_address, detected_at, detection_lag_ms, sell_percentage, tx_signature, our_action, detection_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [pos.id, signal.walletAddress, signal.detectedAt, signal.detectionLagMs, estimatedSellPct,
         signal.txSignature, this.isLive ? 'LIVE_EXIT' : 'SHADOW_EXIT', signal.detectionSource],
      );
    } catch (err) {
      logger.error({ err }, 'Failed to log alpha exit');
    }
  }

  private scheduleDailySummary(): void {
    this.dailySummaryInterval = setInterval(async () => {
      try {
        const now = new Date();
        if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
          await this.sendDailySummary();
          this.capitalManager.resetDaily();
        }
      } catch (err) {
        logger.error({ err }, 'Error in daily summary');
      }
    }, 60_000);
  }

  private async sendDailySummary(): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0];
      await this.telegram.sendDailySummary({
        date: today,
        wins: 0, losses: 0,
        pnlSol: 0, pnlPercent: 0,
        capitalStart: this.capitalManager.capital,
        capitalEnd: this.capitalManager.capital,
        tier: this.capitalManager.tier,
        feesSol: 0,
        signalsSeen: 0, signalsEntered: 0,
        heliusUptime: 100,
        heliusAvgLag: 0,
        nansenCalls: this.nansen.usage.callsLastMinute,
        nextTier: 'SMALL',
        nextTierNeed: 3 - this.capitalManager.capital,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to send daily summary');
    }
  }

  private async sendStartupDiagnostics(): Promise<void> {
    try {
      const walletRows = await (await import('./db/database.js')).getMany<{
        address: string; label: string; tier: string; helius_subscribed: boolean;
        source: string; nansen_roi_percent: number; nansen_pnl_usd: number;
        our_total_trades: number; our_win_rate: number; our_avg_pnl_percent: number;
        consecutive_losses: number; last_active_at: string | null;
      }>(`SELECT address, label, tier, helius_subscribed, source,
              COALESCE(nansen_roi_percent, 0) as nansen_roi_percent,
              COALESCE(nansen_pnl_usd, 0) as nansen_pnl_usd,
              COALESCE(our_total_trades, 0) as our_total_trades,
              COALESCE(our_win_rate, 0) as our_win_rate,
              COALESCE(our_avg_pnl_percent, 0) as our_avg_pnl_percent,
              COALESCE(consecutive_losses, 0) as consecutive_losses,
              last_active_at
         FROM alpha_wallets WHERE active = TRUE
         ORDER BY
           CASE WHEN source = 'NANSEN_SEED' THEN 0 ELSE 1 END ASC,
           tier ASC, nansen_roi_percent DESC`);

      const today = new Date().toISOString().split('T')[0];
      const signalRow = await (await import('./db/database.js')).getOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM signal_events WHERE first_detected_at >= $1`, [today],
      );

      // Count from whichever table is active
      const tradeTable = this.isLive ? 'positions' : 'shadow_positions';
      const tradeRow = await (await import('./db/database.js')).getOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM ${tradeTable}`,
      );

      const discoveryRow = await (await import('./db/database.js')).getOne<{
        tokens_screened: number; wallets_added: number;
      }>(`SELECT tokens_screened, wallets_added FROM wallet_discovery_log ORDER BY run_at DESC LIMIT 1`);

      const tierCfg = this.capitalManager.tierConfig;
      const wsStatus = this.wsManager.getStatus();

      await this.telegram.sendStartupDiagnostics({
        version: 'v2.0.0',
        shadowMode: config.shadowMode,
        capitalSol: this.capitalManager.capital,
        tier: this.capitalManager.tier,
        maxPositions: tierCfg.maxPositions,
        openPositions: this.getOpenCount(),
        wallets: walletRows.map((w) => ({
          address: w.address,
          label: w.label,
          tier: w.tier,
          subscribed: this.walletAddresses.includes(w.address),
          nansenRoi: Number(w.nansen_roi_percent) || 0,
          nansenPnl: Number(w.nansen_pnl_usd) || 0,
          ourTrades: Number(w.our_total_trades) || 0,
          ourWinRate: Number(w.our_win_rate) || 0,
          ourAvgPnl: Number(w.our_avg_pnl_percent) || 0,
          consecutiveLosses: Number(w.consecutive_losses) || 0,
          source: w.source,
          lastActiveAgo: w.last_active_at
            ? `${Math.round((Date.now() - new Date(w.last_active_at).getTime()) / 3600000)}h`
            : undefined,
        })),
        wsConnected: wsStatus.connected,
        wsFallbackActive: wsStatus.fallbackMode,
        wsSubscribedCount: wsStatus.subscribedWallets,
        nansenApiKey: !!config.nansen.apiKey,
        nansenUsage: this.nansen.usage,
        heliusApiKey: !!config.helius.apiKey,
        telegramOk: true,
        dbConnected: true,
        tierConfig: {
          profitTarget: tierCfg.profitTarget,
          stopLoss: tierCfg.stopLoss,
          walletConfluence: tierCfg.walletConfluenceRequired,
          confluenceWindow: tierCfg.confluenceWindow,
          hardTime: tierCfg.hardTimeHours,
          mcapRange: `$${(tierCfg.mcapMin/1000).toFixed(0)}k–$${(tierCfg.mcapMax/1000000).toFixed(0)}M`,
          liquidityMin: tierCfg.liquidityMin,
          partialExits: tierCfg.partialExitsEnabled,
        },
        signalsToday: parseInt(signalRow?.count || '0'),
        tradesAllTime: parseInt(tradeRow?.count || '0'),
        discoveryTokens: discoveryRow?.tokens_screened || 0,
        discoveryWalletsAdded: discoveryRow?.wallets_added || 0,
      });
    } catch (err) {
      console.error('Failed to send startup diagnostics:', err);
    }
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down...');
    if (this.dailySummaryInterval) clearInterval(this.dailySummaryInterval);
    await this.wsManager.shutdown();
    this.fallbackPoller.stop();
    this.liveTracker?.stop();
    this.shadowTracker?.stop();
    this.walletDiscovery.stop();
    await this.telegram.shutdown();
    const { pool } = await import('./db/database.js');
    await pool.end();
    logger.info('Shutdown complete');
  }
}

// --- Main ---

async function main() {
  console.log('RossyBot V2 — initializing...');

  let bot: RossyBotV2;
  try {
    bot = new RossyBotV2();
    console.log('RossyBot V2 — constructor OK');
  } catch (err) {
    console.error('FATAL: Failed to construct RossyBotV2:', err);
    process.exit(1);
  }

  process.on('SIGINT', async () => { await bot.shutdown(); process.exit(0); });
  process.on('SIGTERM', async () => { await bot.shutdown(); process.exit(0); });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
  });

  try {
    await bot.start();
  } catch (err) {
    console.error('FATAL: Failed to start RossyBot V2:', err);
    process.exit(1);
  }
}

main();
