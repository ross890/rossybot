import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config, getTierConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { testConnection } from './db/database.js';

// Modules
import { HeliusWebSocketManager, TransactionParser, FallbackPoller } from './modules/helius/index.js';
import { NansenClient, WalletDiscovery } from './modules/nansen/index.js';
import { EntryEngine, type ValidatedSignal } from './modules/signals/index.js';
import { ShadowTracker } from './modules/positions/index.js';
import { CapitalManager } from './modules/trading/capital-manager.js';
import { TelegramService } from './modules/telegram/index.js';
import { SignalType, type ParsedSignal } from './types/index.js';

class RossyBotV2 {
  private wsManager: HeliusWebSocketManager;
  private txParser: TransactionParser;
  private fallbackPoller: FallbackPoller;
  private nansen: NansenClient;
  private walletDiscovery: WalletDiscovery;
  private entryEngine: EntryEngine;
  private shadowTracker: ShadowTracker;
  private capitalManager: CapitalManager;
  private telegram: TelegramService;
  private walletAddresses: string[] = [];
  private dailySummaryInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Derive public key from private key (optional in shadow mode)
    let publicKey: string;
    if (config.wallet.privateKey) {
      const keypair = Keypair.fromSecretKey(bs58.decode(config.wallet.privateKey));
      publicKey = keypair.publicKey.toBase58();
    } else {
      // Shadow mode — use a dummy key for balance checks (will read 0 SOL = MICRO tier)
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
    this.shadowTracker = new ShadowTracker();
    this.telegram = new TelegramService();
  }

  async start(): Promise<void> {
    logger.info('=== ROSSYBOT V2 — Starting ===');
    logger.info({ shadowMode: config.shadowMode }, 'Mode');

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

    // 3. Seed wallets and load from DB
    await this.walletDiscovery.seedWallets(tier);
    const allActiveWallets = await this.walletDiscovery.getActiveWallets();

    // Helius WS monitors top N wallets (tier-limited)
    this.walletAddresses = allActiveWallets.slice(0, tierCfg.walletsMonitored);
    logger.info({ subscribed: this.walletAddresses.length, total: allActiveWallets.length }, 'Active wallets loaded');

    // 4. Update parsers (subscribed wallets for WS detection)
    this.txParser.updateWallets(this.walletAddresses);
    this.fallbackPoller.updateWallets(this.walletAddresses);

    // Give entry engine ALL tracked wallets for on-chain confluence checks
    this.entryEngine.updateAllTrackedWallets(allActiveWallets);

    // 5. Load open shadow positions
    await this.shadowTracker.loadOpenPositions();

    // 6. Wire up callbacks
    this.wireCallbacks();

    // 7. Connect Helius WebSocket (THE CRITICAL STEP)
    await this.wsManager.connect(this.walletAddresses);

    // 8. Start shadow position price monitoring
    this.shadowTracker.start();

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
            tokenSymbol: signal.tokenMint.slice(0, 6), // Mint only — no symbol lookup yet
            amountUsd: Math.abs(signal.solDelta) * 170, // Rough SOL→USD estimate
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
      logger.warn('Fallback mode ACTIVATED');
      this.fallbackPoller.start();
      await this.telegram.sendWebSocketAlert('down', {
        lastMessageAgo: `${((Date.now() - Date.now()) / 1000).toFixed(0)}s`,
        attempts: 5,
        maxAttempts: 5,
      });
    });

    this.wsManager.on('fallbackDeactivated', async () => {
      logger.info('Fallback mode DEACTIVATED');
      this.fallbackPoller.stop();
      await this.telegram.sendWebSocketAlert('restored', {
        wallets: this.walletAddresses.length,
        downtime: 'recovered',
      });
    });

    // --- Entry Engine → Shadow Tracker ---
    this.entryEngine.setSignalCallback(async (signal: ValidatedSignal) => {
      // Check if we can open a position
      if (!this.capitalManager.canOpenPosition(this.shadowTracker.getOpenCount())) {
        logger.info({ reason: 'max positions or daily limit' }, 'Skipping signal — cannot open position');
        return;
      }

      if (this.shadowTracker.hasPosition(signal.tokenMint)) {
        logger.info({ token: signal.tokenMint.slice(0, 8) }, 'Skipping signal — already have position');
        return;
      }

      const positionSize = this.capitalManager.getPositionSize();
      const pos = await this.shadowTracker.openPosition(signal, positionSize);

      // Send Telegram alert
      const dex = signal.validation.dexData;
      await this.telegram.sendEntryAlert({
        tokenSymbol: signal.tokenSymbol || signal.tokenMint.slice(0, 8),
        tier: signal.tierConfig.tier,
        wallets: signal.walletAddresses,
        walletCount: signal.walletCount,
        totalMonitored: this.walletAddresses.length,
        sizeSol: positionSize,
        price: pos.entry_price,
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
      });
    });

    // --- Shadow Tracker close callback ---
    this.shadowTracker.setCloseCallback(async (pos) => {
      const pnl = pos.pnl_percent;
      if (pnl >= 0) {
        await this.telegram.sendProfitTargetAlert({
          tokenSymbol: pos.token_symbol || pos.token_address.slice(0, 8),
          pnlPercent: pnl,
          entrySol: pos.simulated_entry_sol,
          exitSol: pos.simulated_entry_sol * (1 + pnl),
          netPnlSol: pos.simulated_entry_sol * pnl,
          holdMins: pos.hold_time_mins || 0,
          capitalBefore: this.capitalManager.capital,
          capitalAfter: this.capitalManager.capital + pos.simulated_entry_sol * pnl,
        });
      } else {
        this.capitalManager.recordLoss(pos.simulated_entry_sol * Math.abs(pnl));
        await this.telegram.sendStopLossAlert({
          tokenSymbol: pos.token_symbol || pos.token_address.slice(0, 8),
          pnlPercent: pnl,
          lossSol: pos.simulated_entry_sol * Math.abs(pnl),
          holdMins: pos.hold_time_mins || 0,
          reason: pos.exit_reason || 'Unknown',
        });
      }
    });

    // --- Wallet Discovery → Helius subscription ---
    this.walletDiscovery.setNewWalletCallback(async (address: string) => {
      // Always add to entry engine's tracked list for on-chain confluence
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
    });

    // --- Telegram callbacks ---
    this.telegram.setStatusCallback(() => {
      const ws = this.wsManager.getStatus();
      return {
        capitalSol: this.capitalManager.capital,
        tier: this.capitalManager.tier,
        openPositions: this.shadowTracker.getOpenCount(),
        maxPositions: this.capitalManager.tierConfig.maxPositions,
        wsConnected: ws.connected,
        wsFallback: ws.fallbackMode,
        dailyPnl: '0.00', // TODO: calculate from daily_stats
      };
    });

    this.telegram.setPositionsCallback(() => this.shadowTracker.getOpenPositions());
    this.telegram.setWsHealthCallback(() => this.wsManager.getStatus());
    this.telegram.setNansenUsageCallback(() => this.nansen.usage);
    this.telegram.setDiscoveryCallback(() => this.walletDiscovery.runDiscovery());
    this.telegram.setPauseCallback(() => logger.info('Trading PAUSED via Telegram'));
    this.telegram.setResumeCallback(() => logger.info('Trading RESUMED via Telegram'));
  }

  /** Handle sell signals from alpha wallets — triggers exit detection */
  private async handleSellSignal(signal: ParsedSignal): Promise<void> {
    // Check if we hold a position in this token
    const openPositions = this.shadowTracker.getOpenPositions();
    const affected = openPositions.filter((p) => p.token_address === signal.tokenMint);

    if (affected.length === 0) return;

    // This wallet sold a token we hold — trigger alpha exit logic
    logger.info({
      wallet: signal.walletAddress.slice(0, 8),
      token: signal.tokenMint.slice(0, 8),
      amount: signal.tokenAmount,
    }, 'Alpha wallet SELL detected on held token');

    // Estimate sell percentage from the signal
    // In production, this would use parseSellPercentage from the full tx
    // For now, estimate from SOL delta
    const estimatedSellPct = 0.5; // Conservative estimate

    await this.shadowTracker.handleAlphaExit(signal.tokenMint, signal.walletAddress, estimatedSellPct);

    // Log to alpha_wallet_exits
    try {
      const pos = affected[0];
      const { query: dbQuery } = await import('./db/database.js');
      await dbQuery(
        `INSERT INTO alpha_wallet_exits (position_id, wallet_address, detected_at, detection_lag_ms, sell_percentage, tx_signature, our_action, detection_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [pos.id, signal.walletAddress, signal.detectedAt, signal.detectionLagMs, estimatedSellPct,
         signal.txSignature, 'SHADOW_EXIT', signal.detectionSource],
      );
    } catch (err) {
      logger.error({ err }, 'Failed to log alpha exit');
    }
  }

  private scheduleDailySummary(): void {
    // Check every minute if it's midnight UTC
    this.dailySummaryInterval = setInterval(async () => {
      const now = new Date();
      if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
        await this.sendDailySummary();
        this.capitalManager.resetDaily();
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
      // Get wallet info from DB with performance stats
      const walletRows = await (await import('./db/database.js')).getMany<{
        address: string; label: string; tier: string; helius_subscribed: boolean;
        source: string; nansen_roi_percent: number; nansen_pnl_usd: number;
        our_total_trades: number; our_win_rate: number; our_avg_pnl_percent: number;
        consecutive_losses: number;
      }>(`SELECT address, label, tier, helius_subscribed, source,
              COALESCE(nansen_roi_percent, 0) as nansen_roi_percent,
              COALESCE(nansen_pnl_usd, 0) as nansen_pnl_usd,
              COALESCE(our_total_trades, 0) as our_total_trades,
              COALESCE(our_win_rate, 0) as our_win_rate,
              COALESCE(our_avg_pnl_percent, 0) as our_avg_pnl_percent,
              COALESCE(consecutive_losses, 0) as consecutive_losses
         FROM alpha_wallets WHERE active = TRUE
         ORDER BY
           CASE WHEN source = 'NANSEN_SEED' THEN 0 ELSE 1 END ASC,
           tier ASC, nansen_roi_percent DESC`);

      // Get signal count for today
      const today = new Date().toISOString().split('T')[0];
      const signalRow = await (await import('./db/database.js')).getOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM signal_events WHERE first_detected_at >= $1`, [today],
      );

      // Get total trades
      const tradeRow = await (await import('./db/database.js')).getOne<{ count: string }>(
        `SELECT COUNT(*) as count FROM shadow_positions`,
      );

      // Get latest discovery stats
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
        openPositions: this.shadowTracker.getOpenCount(),
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
    this.shadowTracker.stop();
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
