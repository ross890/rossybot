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
import { PumpFunTracker, validatePumpFunSignal, PumpPortalClient, PumpFunAlphaDiscovery, deriveBondingCurveAddress } from './modules/pumpfun/index.js';
import { fetchDexPair } from './modules/validation/dexscreener.js';
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

  // Quick symbol cache for BUY/SELL notifications
  private symbolCache: Map<string, string> = new Map();

  // Tokens we've closed/dropped — never re-buy in this session
  private blockedTokens: Set<string> = new Set();

  // Pump.fun position tracking (runs alongside standard tracker)
  private pumpFunTracker: PumpFunTracker;

  // Throttle "slots full" Telegram messages — at most once per 2 minutes
  private lastSlotsFullMsgAt = 0;

  // Pump.fun confluence tracking: multiple alpha wallets buying the same token
  private pumpFunConfluence: Map<string, { wallets: Set<string>; totalSol: number; firstSeen: number }> = new Map();

  // Pump.fun rejection cache: skip re-evaluation of tokens rejected for curve-range reasons
  // Key: tokenMint, Value: { reason, expiry timestamp }
  private pumpFunRejectionCache: Map<string, { reason: string; expiresAt: number }> = new Map();
  private static readonly PUMP_FUN_REJECTION_TTL_MS = 5 * 60_000; // 5 minutes

  // Real-time curve state cache from PumpPortal (avoids 200-400ms RPC call in validation)
  // Key: tokenMint, Value: { vSol (virtual), realSol, updatedAt }
  private pumpFunCurveCache: Map<string, { vSol: number; realSol: number; updatedAt: number }> = new Map();

  // Copy-trade stampede detection: count unique buyers per token from PumpPortal stream
  // Key: tokenMint, Value: { buyers: Map<walletAddr, buyTimestamp>, firstBuyAt, totalSol }
  private pumpFunBuyerTracker: Map<string, { buyers: Map<string, number>; firstBuyAt: number; totalSol: number }> = new Map();
  private static readonly STAMPEDE_WINDOW_MS = 60_000; // 60s window
  private static readonly STAMPEDE_BUYER_THRESHOLD = 20; // >20 unique (de-clustered) buyers = stampede
  private static readonly STAMPEDE_CURVE_FLOOR = 0.50; // Only reject stampedes above 50% curve fill
  private static readonly CLUSTER_BUCKET_MS = 2_000; // 2s window for grouping coordinated buys

  // In-memory wallet quality cache (avoids 50-150ms DB query per signal)
  private walletQualityCache: Map<string, {
    label: string; our_total_trades: number; our_win_rate: number;
    our_avg_pnl_percent: number; consecutive_losses: number; cachedAt: number;
  } | null> = new Map();
  private static readonly WALLET_QUALITY_CACHE_TTL_MS = 30 * 60_000; // 30 min

  // PumpPortal — real-time pump.fun trade stream for alpha wallet discovery
  private pumpPortal: PumpPortalClient;
  private pumpFunAlphaDiscovery: PumpFunAlphaDiscovery;

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
    this.pumpFunTracker = new PumpFunTracker();
    this.pumpPortal = new PumpPortalClient();
    this.pumpFunAlphaDiscovery = new PumpFunAlphaDiscovery();

    // Initialize position tracker based on mode
    if (!config.shadowMode && config.wallet.privateKey) {
      this.swapExecutor = new SwapExecutor();
      this.liveTracker = new LiveTracker(this.swapExecutor);
      // Wire pump.fun tracker for live trading too
      this.pumpFunTracker.setSwapExecutor(this.swapExecutor);
      logger.info('LIVE mode — Jupiter swap execution enabled (standard + pump.fun)');
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

  /** Quick symbol lookup — cached, 2s timeout, falls back to mint prefix */
  private async resolveSymbol(tokenMint: string): Promise<string> {
    const cached = this.symbolCache.get(tokenMint);
    if (cached) return cached;
    try {
      const pair = await Promise.race([
        fetchDexPair(tokenMint),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      const symbol = pair?.baseToken?.symbol || tokenMint.slice(0, 6);
      this.symbolCache.set(tokenMint, symbol);
      return symbol;
    } catch {
      return tokenMint.slice(0, 6);
    }
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
    const purged = await this.walletDiscovery.purgeWeakWallets();
    if (purged > 0) {
      console.log(`Startup purge: removed ${purged} weak/unproven wallets`);
    }
    await this.walletDiscovery.enforceMinimumPnl();
    await this.walletDiscovery.backfillNansenRoi();
    const activityDeactivated = await this.walletDiscovery.enforceTradeActivity(true);
    if (activityDeactivated > 0) {
      console.log(`Deactivated ${activityDeactivated} inactive wallets (no on-chain activity in 7 days)`);
    }

    // Auto-cleanup: purge stale, slow-holder, and excess wallets
    const cleanup = await this.walletDiscovery.autoCleanup();
    if (cleanup.removed > 0) {
      console.log(`Auto-cleanup removed ${cleanup.removed} wallets:`, cleanup.reasons);
    }

    const isPumpFunOnlyMode = this.capitalManager.capital < config.minCapitalForStandardTrading;
    const allActiveWallets = await this.walletDiscovery.getActiveWallets(isPumpFunOnlyMode);

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

    // 5b. Populate token blocklist from recently closed positions (last 24h)
    try {
      const { getMany: dbGetMany } = await import('./db/database.js');
      const closedMints = await dbGetMany<{ token_address: string }>(
        `SELECT DISTINCT token_address FROM positions WHERE status = 'CLOSED' AND closed_at > NOW() - INTERVAL '24 hours'
         UNION
         SELECT DISTINCT token_address FROM pumpfun_positions WHERE status = 'CLOSED' AND closed_at > NOW() - INTERVAL '24 hours'`,
      );
      for (const row of closedMints) {
        this.blockedTokens.add(row.token_address);
      }
      if (this.blockedTokens.size > 0) {
        logger.info({ count: this.blockedTokens.size }, 'Loaded blocked tokens from recent closed positions');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load blocked tokens from DB');
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

    // 8b. Start pump.fun tracker
    await this.pumpFunTracker.loadOpenPositions();
    this.pumpFunTracker.start();

    // 8c. Start PumpPortal — real-time pump.fun trade stream for alpha wallet discovery
    this.pumpFunAlphaDiscovery.setNewAlphaCallback((address) => {
      // Auto-subscribe new pump.fun alpha wallets to Helius WS
      this.txParser.addWallet(address);
      this.wsManager.addWallet(address);
      logger.info({ address: address.slice(0, 8) }, 'PumpPortal alpha discovered — added to Helius WS');
    });
    this.pumpFunAlphaDiscovery.start();

    this.pumpPortal.on('trade', (trade) => {
      this.pumpFunAlphaDiscovery.processTrade(trade).catch((err) =>
        logger.error({ err }, 'PumpPortal alpha discovery error'),
      );

      // Real-time curve fill updates for open positions — reacts instantly instead of 2s polling.
      // PumpPortal trade events include vSolInBondingCurve which we use to check TP/exits.
      if (trade.txType === 'buy' || trade.txType === 'sell') {
        this.pumpFunTracker.handleRealtimeCurveUpdate(trade.mint, trade.vSolInBondingCurve).catch((err) =>
          logger.error({ err, token: trade.mint.slice(0, 8) }, 'Real-time curve update failed'),
        );

        // Cache curve state from PumpPortal (used in validation to skip RPC call)
        const realSol = Math.max(0, trade.vSolInBondingCurve - 30); // 30 SOL virtual reserve
        this.pumpFunCurveCache.set(trade.mint, {
          vSol: trade.vSolInBondingCurve,
          realSol,
          updatedAt: Date.now(),
        });
      }

      // Track unique buyers per token for stampede detection (with timestamps for cluster analysis)
      if (trade.txType === 'buy') {
        const now = Date.now();
        let tracker = this.pumpFunBuyerTracker.get(trade.mint);
        if (!tracker || (now - tracker.firstBuyAt) > RossyBotV2.STAMPEDE_WINDOW_MS) {
          tracker = { buyers: new Map(), firstBuyAt: now, totalSol: 0 };
          this.pumpFunBuyerTracker.set(trade.mint, tracker);
        }
        if (!tracker.buyers.has(trade.traderPublicKey)) {
          tracker.buyers.set(trade.traderPublicKey, now);
        }
        // Estimate SOL from vSol change (rough but fast)
        tracker.totalSol += Math.max(0, trade.vSolInBondingCurve - 30 - (this.pumpFunCurveCache.get(trade.mint)?.realSol || 0));
      }

      // Evict old entries from buyer tracker + curve cache periodically
      if (Math.random() < 0.01) { // ~1% of trades, avoid per-trade overhead
        const cutoff = Date.now() - 5 * 60_000;
        for (const [mint, t] of this.pumpFunBuyerTracker) {
          if (t.firstBuyAt < cutoff) this.pumpFunBuyerTracker.delete(mint);
        }
        for (const [mint, c] of this.pumpFunCurveCache) {
          if (c.updatedAt < cutoff) this.pumpFunCurveCache.delete(mint);
        }
      }
    });

    this.pumpPortal.connect().catch((err) =>
      logger.error({ err }, 'PumpPortal connection failed — alpha discovery will not run'),
    );

    // Log PumpPortal + alpha discovery stats periodically
    setInterval(() => {
      const ppStats = this.pumpPortal.stats;
      const adStats = this.pumpFunAlphaDiscovery.getStats();
      if (ppStats.tradeCount > 0 || ppStats.createCount > 0) {
        logger.info({
          connected: ppStats.connected,
          trades: ppStats.tradeCount,
          creates: ppStats.createCount,
          tokens: ppStats.subscribedTokens,
          tracked: adStats.tracked,
          promoted: adStats.promoted,
        }, 'PumpPortal alpha discovery stats');
      }
    }, 5 * 60 * 1000); // every 5 min

    // Clean up expired pump.fun rejection cache entries every 5 min
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [mint, entry] of this.pumpFunRejectionCache) {
        if (entry.expiresAt <= now) {
          this.pumpFunRejectionCache.delete(mint);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.debug({ cleaned, remaining: this.pumpFunRejectionCache.size }, 'Pump.fun rejection cache cleanup');
      }
    }, 5 * 60 * 1000);

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
          // Look up wallet info (label + stats) for noise filtering
          const walletRow = await (await import('./db/database.js')).getOne<{
            label: string; pumpfun_only: boolean;
            our_total_trades: number; our_win_rate: number; our_avg_pnl_percent: number;
          }>(
            `SELECT label, COALESCE(pumpfun_only, FALSE) as pumpfun_only,
                    COALESCE(our_total_trades, 0) as our_total_trades,
                    COALESCE(our_win_rate, 0) as our_win_rate,
                    COALESCE(our_avg_pnl_percent, 0) as our_avg_pnl_percent
               FROM alpha_wallets WHERE address = $1`, [signal.walletAddress],
          );

          // Raw BUY/SELL detection messages removed from Telegram — too noisy.
          // Data is still recorded via wallet_transactions table and signal processing below.

          // Route signals: pumpfun_only wallets skip standard pipeline
          const isPumpFunOnly = walletRow?.pumpfun_only === true;

          if (signal.type === SignalType.BUY) {
            if (signal.isPumpFun) {
              await this.handlePumpFunBuy(signal);
              // Also subscribe PumpPortal to this token's trades — alpha discovery
              // sees who else is trading the same tokens our alphas trade
              if (this.pumpPortal.connected) {
                this.pumpPortal.subscribeTokenTrades([signal.tokenMint]);
              }
            } else if (!isPumpFunOnly) {
              // Gate standard V2 entries behind capital threshold
              // Below threshold, only pump.fun trades execute — faster compounding with small capital
              if (this.capitalManager.capital < config.minCapitalForStandardTrading) {
                logger.info({
                  token: signal.tokenMint.slice(0, 8),
                  capital: this.capitalManager.capital.toFixed(4),
                  threshold: config.minCapitalForStandardTrading,
                }, 'Standard V2 signal skipped — capital below threshold (pump.fun only mode)');
              } else {
                await this.entryEngine.processBuySignal(signal, tierCfg);
              }
            }
          } else if (signal.type === SignalType.SELL) {
            // Check both standard and pump.fun positions for sell signals
            if (signal.isPumpFun) {
              await this.pumpFunTracker.handleAlphaExit(signal.tokenMint, signal.walletAddress, signal.solDelta);
            }
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
        // Look up per-wallet EV stats from DB (our stats + Nansen bootstrap)
        const { getMany: dbGetMany } = await import('./db/database.js');
        const walletStats = await dbGetMany<{
          address: string; label: string; our_total_trades: number; our_win_rate: number; our_avg_pnl_percent: number;
          nansen_roi_percent: number; nansen_trade_count: number; nansen_pnl_usd: number;
          tier: string; short_term_alpha_score: number;
        }>(
          `SELECT address, COALESCE(label, '') as label,
                  COALESCE(our_total_trades, 0) as our_total_trades,
                  COALESCE(our_win_rate, 0) as our_win_rate,
                  COALESCE(our_avg_pnl_percent, 0) as our_avg_pnl_percent,
                  COALESCE(nansen_roi_percent, 0) as nansen_roi_percent,
                  COALESCE(nansen_trade_count, 0) as nansen_trade_count,
                  COALESCE(nansen_pnl_usd, 0) as nansen_pnl_usd,
                  COALESCE(tier, 'B') as tier,
                  COALESCE(short_term_alpha_score, 0) as short_term_alpha_score
             FROM alpha_wallets WHERE address = ANY($1)`,
          [signal.walletAddresses],
        );
        const walletEvMap = new Map<string, WalletEv>(walletStats.map((w) => [w.address, {
          trades: Number(w.our_total_trades),
          winRate: Number(w.our_win_rate),
          avgPnl: Number(w.our_avg_pnl_percent),
          nansenRoi: Number(w.nansen_roi_percent),
          nansenTrades: Number(w.nansen_trade_count),
          nansenPnlUsd: Number(w.nansen_pnl_usd),
          tier: w.tier,
          shortTermAlpha: Number(w.short_term_alpha_score),
        }]));

        // Score the signal
        const score = scoreSignal(signal, walletEvMap);
        const scoreDisplay = formatScoreForTelegram(score);

        logger.info({
          token: signal.tokenMint.slice(0, 8),
          score: score.total,
          breakdown: score.breakdown,
        }, 'Signal scored');

        // Send signal log with actual scoring outcome (not just validation pass/fail)
        const minScore = signal.tierConfig.minSignalScore;
        const scorePassed = score.total >= minScore && !score.walletRejected;
        try {
          const dex = signal.validation.dexData;
          await this.telegram.sendSignalLog({
            tokenSymbol: signal.tokenSymbol || signal.tokenMint.slice(0, 8),
            tokenMint: signal.tokenMint,
            passed: scorePassed,
            failReason: !scorePassed ? `Score ${score.total.toFixed(0)}/${minScore}` : null,
            wallets: signal.walletAddresses.map((addr) => {
              const stats = walletEvMap.get(addr);
              return {
                address: addr,
                label: walletStats.find((w) => w.address === addr)?.label || addr.slice(0, 8),
                trades: stats?.trades || 0,
                winRate: stats?.winRate || 0,
                avgPnl: stats?.avgPnl || 0,
                nansenRoi: stats?.nansenRoi || 0,
                nansenPnlUsd: stats?.nansenPnlUsd || 0,
              };
            }),
            totalMonitored: this.walletAddresses.length,
            safety: signal.validation.safety,
            liquidity: signal.validation.liquidity,
            momentum: signal.validation.momentum,
            mcap: signal.validation.mcap,
            age: signal.validation.age,
            dexData: dex ? {
              mcap: dex.marketCap || dex.fdv || 0,
              liquidity: dex.liquidity?.usd || 0,
              priceChange24h: dex.priceChange?.h24 || 0,
              priceChange6h: dex.priceChange?.h6 || 0,
              priceChange1h: dex.priceChange?.h1 || 0,
              volume24h: dex.volume?.h24 || 0,
              ageDays: dex.pairCreatedAt ? (Date.now() - dex.pairCreatedAt) / 86400000 : 0,
            } : null,
            validationMs: signal.validation.durationMs,
            action: scorePassed ? 'ENTERED' : `REJECTED (${score.total.toFixed(0)}/${minScore})`,
          });
        } catch (err) {
          logger.error({ err }, 'Error sending signal log');
        }

        // Score gate — reject weak signals
        if (score.total < minScore) {
          logger.info({
            token: signal.tokenMint.slice(0, 8),
            score: score.total,
            minScore,
            breakdown: score.breakdown,
          }, 'Skipping signal — below minimum score');

          await this.telegram.send(
            `⛔ Signal rejected: ${signal.tokenSymbol || signal.tokenMint.slice(0, 8)}\n` +
            `Score ${score.total.toFixed(0)}/${minScore} minimum\n` +
            scoreDisplay,
          );
          return;
        }

        // Wallet quality hard floor — only rejects truly terrible wallets (<30% WR AND <5% PnL)
        if (score.walletRejected) {
          logger.info({
            token: signal.tokenMint.slice(0, 8),
            wallets: signal.walletAddresses.length,
          }, 'Skipping signal — no wallet meets minimum quality floor (<30% WR and <5% PnL)');

          await this.telegram.send(
            `⛔ Wallet quality too low: ${signal.tokenSymbol || signal.tokenMint.slice(0, 8)}\n` +
            `No wallet meets minimum quality floor (blended <30% WR and <5% PnL)\n` +
            scoreDisplay,
          );
          return;
        }

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

        if (this.blockedTokens.has(signal.tokenMint)) {
          logger.info({ token: signal.tokenMint.slice(0, 8) }, 'Skipping signal — token was previously closed/dropped');
          return;
        }

        let positionSize = this.capitalManager.getPositionSize();

        // Scale position size down for dip entries — less capital at risk
        const entryMomentum = signal.validation.dexData?.priceChange?.h24 ?? 0;
        if (entryMomentum < 0) {
          let dipMultiplier: number;
          if (entryMomentum >= -10) {
            dipMultiplier = 0.85;   // Small dip: 85% size
          } else if (entryMomentum >= -25) {
            dipMultiplier = 0.70;   // Moderate dip: 70% size
          } else {
            dipMultiplier = 0.60;   // Deep dip: 60% size
          }
          positionSize = Math.max(positionSize * dipMultiplier, signal.tierConfig.minPositionSol);
          logger.info({
            token: signal.tokenMint.slice(0, 8),
            momentum: entryMomentum.toFixed(1),
            dipMultiplier,
            adjustedSize: positionSize.toFixed(3),
          }, 'Dip entry — reduced position size');
        }

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

    // Signal log is now sent from the signal callback (below) after scoring,
    // so the action reflects the actual outcome (ENTERED vs REJECTED by score).

    // --- Position close callback (works for both trackers) ---
    const handlePositionClose = async (posView: PositionView) => {
      // Block token from being re-bought this session
      this.blockedTokens.add(posView.token_address);
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

    // --- Pump.fun tracker callbacks ---
    // Wire balance refresh so capital manager stays in sync after pump.fun trades
    this.pumpFunTracker.setBalanceRefreshCallback(async () => {
      await this.capitalManager.refreshBalance();
    });

    // Wire swap failure notifications
    this.pumpFunTracker.setSwapFailedCallback(async (tokenSymbol, error, type) => {
      await this.telegram.send(
        `⚠️ PUMP.FUN ${type} SWAP FAILED\n` +
        `├ Token: ${tokenSymbol}\n` +
        `└ Error: ${error}`,
      );
    });

    this.pumpFunTracker.setCloseCallback(async (pos) => {
      this.blockedTokens.add(pos.token_address);
      try {
        const pnl = pos.pnl_percent;
        const emoji = pnl >= 0 ? '🟢' : '🔴';
        const mode = this.pumpFunTracker.isLive ? 'LIVE' : 'SHADOW';
        const liveDetails = this.pumpFunTracker.isLive
          ? `├ Net PnL: ${pos.net_pnl_sol.toFixed(6)} SOL\n` +
            `├ Fees: ${pos.fees_paid_sol.toFixed(6)} SOL\n`
          : '';
        await this.telegram.send(
          `🎰 PUMP.FUN CLOSED ${emoji} [${mode}]\n` +
          `├ Token: ${pos.token_symbol || pos.token_address.slice(0, 8)}\n` +
          `├ PnL: ${(pnl * 100).toFixed(1)}%\n` +
          liveDetails +
          `├ Hold: ${pos.hold_time_mins}min\n` +
          `├ Graduated: ${pos.graduated ? `YES (at ${pos.graduated_at?.toISOString().slice(11, 19)} UTC)` : 'NO'}\n` +
          `├ Curve: ${(pos.curve_fill_pct_at_entry * 100).toFixed(0)}% → ${(pos.current_curve_fill_pct * 100).toFixed(0)}%\n` +
          `└ Reason: ${pos.exit_reason}`,
        );
      } catch (err) {
        logger.error({ err }, 'Error in pump.fun close callback');
      }
    });

    this.pumpFunTracker.setGraduationCallback(async (pos) => {
      try {
        await this.telegram.send(
          `🎓 GRADUATION: ${pos.token_symbol || pos.token_address.slice(0, 8)}\n` +
          `├ Migrated to Raydium!\n` +
          `├ Hold time: ${((Date.now() - pos.entry_time.getTime()) / 60_000).toFixed(0)}min\n` +
          `├ Entry curve: ${(pos.curve_fill_pct_at_entry * 100).toFixed(0)}%\n` +
          `└ Now tracking via DexScreener`,
        );
      } catch (err) {
        logger.error({ err }, 'Error in pump.fun graduation callback');
      }
    });

    // --- Wallet Discovery → Helius subscription ---
    this.walletDiscovery.setNewWalletCallback(async (address: string) => {
      try {
        const isPfOnly = this.capitalManager.capital < config.minCapitalForStandardTrading;
        this.entryEngine.updateAllTrackedWallets(
          await this.walletDiscovery.getActiveWallets(isPfOnly),
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
    this.telegram.setPumpFunPositionsCallback(() =>
      this.pumpFunTracker.getOpenPositions().map((p) => ({ ...p } as Record<string, unknown>)),
    );
    this.telegram.setWsHealthCallback(() => this.wsManager.getStatus());
    this.telegram.setNansenUsageCallback(() => this.nansen.usage);
    this.telegram.setDiscoveryCallback(() => this.walletDiscovery.runDiscovery());
    this.telegram.setPauseCallback(() => logger.info('Trading PAUSED via Telegram'));
    this.telegram.setResumeCallback(() => logger.info('Trading RESUMED via Telegram'));

    // /kill command — live mode force close (sells token)
    // /drop command — remove from tracking without selling (for manually-sold tokens)
    if (this.liveTracker) {
      this.telegram.setKillCallback(async (tokenIdentifier: string) => {
        // Try standard positions first, then pump.fun
        const standardResult = await this.liveTracker!.forceClose(tokenIdentifier);
        if (standardResult.success) return standardResult;
        return this.pumpFunTracker.forceClose(tokenIdentifier);
      });
      this.telegram.setDropCallback(async (tokenIdentifier: string) => {
        return this.liveTracker!.forceRemove(tokenIdentifier);
      });
      this.liveTracker.setManualSellCallback((tokenSymbol: string) => {
        this.telegram.send(
          `🗑 Auto-dropped $${tokenSymbol}\n` +
          `└ Token no longer in wallet (manual sell detected)`,
        ).catch(() => {});
      });
    }

    // /holdtime command — run hold-time analysis on demand
    this.telegram.setHoldTimeCallback(async () => {
      const analyzer = this.walletDiscovery.getHoldTimeAnalyzer();
      const profiles = await analyzer.analyzeAllWallets();
      return profiles.map((p) => analyzer.formatProfileForTelegram(p));
    });

    // Hold-time enforcement alerts
    this.walletDiscovery.setHoldTimeCallback(async (results) => {
      if (results.deactivated.length > 0) {
        await this.telegram.send(
          `🎰 HOLD-TIME ENFORCEMENT\n` +
          `├ Pump.fun only: ${results.deactivated.length} wallet(s) — bag-holders for standard trades\n` +
          `│  ${results.deactivated.map((a) => a.slice(0, 8)).join(', ')}\n` +
          `└ Still active for pump.fun signals (short holds work there)`,
        );
      }
      if (results.demoted.length > 0) {
        await this.telegram.send(
          `⚠️ HOLD-TIME DEMOTION\n` +
          `├ Demoted to Tier B: ${results.demoted.length} wallet(s)\n` +
          `│  ${results.demoted.map((a) => a.slice(0, 8)).join(', ')}\n` +
          `└ Poor short-term alpha — deprioritized in ranking`,
        );
      }
    });
  }

  /** Handle pump.fun bonding curve buy from an alpha wallet — CURVE SCALP STRATEGY */
  private async handlePumpFunBuy(signal: ParsedSignal): Promise<void> {
    try {
      const cfg = config.pumpFun;
      const mint = signal.tokenMint;
      const solSpent = Math.abs(signal.solDelta);

      // Track confluence: accumulate alpha wallets buying the same token
      const now = Date.now();
      let confluence = this.pumpFunConfluence.get(mint);
      if (!confluence || (now - confluence.firstSeen) > 5 * 60_000) {
        // Fresh confluence window (5 min) or expired
        confluence = { wallets: new Set(), totalSol: 0, firstSeen: now };
        this.pumpFunConfluence.set(mint, confluence);
      }
      confluence.wallets.add(signal.walletAddress);
      confluence.totalSol += solSpent;

      // Skip if we already have a pump.fun position on this token
      if (this.pumpFunTracker.hasPosition(mint)) {
        logger.info({ token: mint.slice(0, 8), confluence: confluence.wallets.size }, 'Pump.fun skip — already holding');
        return;
      }

      // Skip if we also have a standard position
      if (this.hasPosition(mint)) {
        logger.info({ token: mint.slice(0, 8) }, 'Pump.fun skip — standard position exists');
        return;
      }

      // Skip tokens we've previously closed/dropped
      if (this.blockedTokens.has(mint)) {
        logger.info({ token: mint.slice(0, 8) }, 'Pump.fun skip — token was previously closed/dropped');
        return;
      }

      // Skip tokens recently rejected for curve-range reasons (avoid re-fetching RPC + Telegram spam)
      const cached = this.pumpFunRejectionCache.get(mint);
      if (cached && cached.expiresAt > Date.now()) {
        logger.debug({ token: mint.slice(0, 8), reason: cached.reason }, 'Pump.fun skip — cached rejection');
        return;
      }

      // Max pump.fun positions check
      if (this.pumpFunTracker.getOpenCount() >= cfg.maxPositions) {
        logger.info({ open: this.pumpFunTracker.getOpenCount(), max: cfg.maxPositions },
          'Pump.fun skip — max positions reached');
        const slotNow = Date.now();
        if (slotNow - this.lastSlotsFullMsgAt >= 120_000) {
          this.lastSlotsFullMsgAt = slotNow;
          await this.telegram.send(
            `🎰 PUMP.FUN signal blocked: $${signal.tokenMint.slice(0, 8)}\n` +
            `└ ${this.pumpFunTracker.getOpenCount()}/${cfg.maxPositions} pump.fun slots full`,
          );
        }
        return;
      }

      // Wallet quality gate: check in-memory cache first, then DB (saves 50-150ms)
      let walletRow = this.walletQualityCache.get(signal.walletAddress);
      if (walletRow === undefined) {
        // Cache miss — fetch from DB and cache
        const dbRow = await (await import('./db/database.js')).getOne<{
          label: string; our_total_trades: number; our_win_rate: number;
          our_avg_pnl_percent: number; consecutive_losses: number;
        }>(
          `SELECT label, our_total_trades, our_win_rate, our_avg_pnl_percent, consecutive_losses
           FROM alpha_wallets WHERE address = $1`, [signal.walletAddress],
        );
        walletRow = dbRow ? { ...dbRow, cachedAt: Date.now() } : null;
        this.walletQualityCache.set(signal.walletAddress, walletRow);
      } else if (walletRow && (Date.now() - walletRow.cachedAt) > RossyBotV2.WALLET_QUALITY_CACHE_TTL_MS) {
        // Stale cache — refresh in background, use cached value for now
        (async () => {
          const dbRow = await (await import('./db/database.js')).getOne<{
            label: string; our_total_trades: number; our_win_rate: number;
            our_avg_pnl_percent: number; consecutive_losses: number;
          }>(
            `SELECT label, our_total_trades, our_win_rate, our_avg_pnl_percent, consecutive_losses
             FROM alpha_wallets WHERE address = $1`, [signal.walletAddress],
          );
          this.walletQualityCache.set(signal.walletAddress, dbRow ? { ...dbRow, cachedAt: Date.now() } : null);
        })().catch(() => {});
      }
      const walletLabel = walletRow?.label || signal.walletAddress.slice(0, 8);

      // Skip wallets with proven bad track records (3+ trades, <25% WR or 3+ consecutive losses)
      if (walletRow && walletRow.our_total_trades >= 3) {
        const wr = walletRow.our_win_rate;
        const consLosses = walletRow.consecutive_losses || 0;
        if (wr < 0.25 || consLosses >= 3) {
          logger.info({
            token: mint.slice(0, 8), wallet: walletLabel,
            winRate: `${(wr * 100).toFixed(0)}%`, consLosses,
          }, 'Pump.fun REJECTED — wallet quality too low');
          await this.telegram.send(
            `🎰 PUMP.FUN rejected: ${mint.slice(0, 8)}\n` +
            `├ Wallet: ${walletLabel}\n` +
            `├ Reason: WALLET_QUALITY (WR ${(wr * 100).toFixed(0)}%, ${consLosses} consecutive losses)\n` +
            `├ SOL spent: ${solSpent.toFixed(2)}\n` +
            `└ <a href="https://pump.fun/coin/${mint}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">dex</a>`,
            { parse_mode: 'HTML' },
          );
          return;
        }
      }

      // Confluence tracking: single wallet is enough now that exits work properly.
      // Multi-wallet confluence still gets a size bonus (see confluenceMultiplier below).
      const confluenceCount = confluence.wallets.size;

      // Stampede detection: curve-aware + cluster de-duplication
      // Early stampedes (curve <50%) are bullish momentum, not crowded trades.
      // Also discount "unique" buyers that are really coordinated bots (same 2s window clusters).
      const buyerTracker = this.pumpFunBuyerTracker.get(mint);
      if (buyerTracker && buyerTracker.buyers.size >= RossyBotV2.STAMPEDE_BUYER_THRESHOLD) {
        // Check curve fill — stampede at low curve fill is momentum, not danger
        const curveData = this.pumpFunCurveCache.get(mint);
        const realSol = curveData?.realSol ?? 0;
        const curveFill = realSol / 85; // 85 SOL = graduation threshold
        if (curveFill >= RossyBotV2.STAMPEDE_CURVE_FLOOR) {
          // De-cluster: bucket buyers into 2s windows, count only distinct time clusters
          const buckets = new Map<number, number>();
          for (const [, buyTime] of buyerTracker.buyers) {
            const bucket = Math.floor(buyTime / RossyBotV2.CLUSTER_BUCKET_MS);
            buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
          }
          // Effective unique buyers = number of time clusters + solo buyers in large clusters
          // A bucket with >3 buyers in 2s is likely coordinated — count it as 1 "buyer group"
          let effectiveBuyers = 0;
          for (const count of buckets.values()) {
            effectiveBuyers += count <= 3 ? count : 1;
          }

          if (effectiveBuyers >= RossyBotV2.STAMPEDE_BUYER_THRESHOLD) {
            logger.info({
              token: mint.slice(0, 8),
              rawBuyers: buyerTracker.buyers.size,
              effectiveBuyers,
              curveFill: `${(curveFill * 100).toFixed(0)}%`,
              clusters: buckets.size,
              wallet: walletLabel,
            }, 'Pump.fun REJECTED — stampede (curve-aware, de-clustered)');
            this.pumpFunRejectionCache.set(mint, {
              reason: 'STAMPEDE',
              expiresAt: Date.now() + RossyBotV2.PUMP_FUN_REJECTION_TTL_MS,
            });
            await this.telegram.send(
              `🎰 PUMP.FUN rejected: ${mint.slice(0, 8)}\n` +
              `├ Wallet: ${walletLabel}\n` +
              `├ Reason: STAMPEDE (${effectiveBuyers} effective / ${buyerTracker.buyers.size} raw buyers, curve ${(curveFill * 100).toFixed(0)}%)\n` +
              `├ SOL spent: ${solSpent.toFixed(2)}\n` +
              `└ <a href="https://pump.fun/coin/${mint}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">dex</a>`,
              { parse_mode: 'HTML' },
            );
            return;
          } else {
            logger.info({
              token: mint.slice(0, 8),
              rawBuyers: buyerTracker.buyers.size,
              effectiveBuyers,
              curveFill: `${(curveFill * 100).toFixed(0)}%`,
            }, 'Stampede de-clustered — passing (bots inflated count)');
          }
        } else {
          logger.info({
            token: mint.slice(0, 8),
            rawBuyers: buyerTracker.buyers.size,
            curveFill: `${(curveFill * 100).toFixed(0)}%`,
          }, 'Stampede bypassed — curve too early for rejection, momentum is bullish');
        }
      }

      // Calculate position size early (needed for parallel quote)
      const tierSize = this.capitalManager.getPositionSize();
      let pumpSize = tierSize * cfg.positionSizeMultiplier;
      const confluenceMultiplier = Math.min(1 + (confluenceCount - 1) * 0.25, 1.5);
      pumpSize = pumpSize * confluenceMultiplier;

      // Pass cached PumpPortal curve data to validation (avoids 200-400ms RPC call)
      const cachedCurve = this.pumpFunCurveCache.get(mint);
      const curveHint = cachedCurve && (Date.now() - cachedCurve.updatedAt) < 10_000
        ? { realSol: cachedCurve.realSol }
        : undefined;

      // Run validation + Jupiter quote in parallel (saves 200-400ms)
      const swapExec = this.pumpFunTracker.getSwapExecutor();
      const [validation, prefetchedQuote] = await Promise.all([
        validatePumpFunSignal(signal, curveHint),
        swapExec ? swapExec.prefetchQuote(mint, pumpSize) : Promise.resolve(null),
      ]);

      if (!validation.passed) {
        logger.info({
          token: mint.slice(0, 8),
          reason: validation.failReason,
          wallet: walletLabel,
          curveFill: `${(validation.curveFillPct * 100).toFixed(0)}%`,
        }, `Pump.fun signal rejected: ${validation.failReason}`);

        // Cache curve-range AND low-conviction rejections to stop spam
        // Curve-range: avoid re-fetching RPC. Low-conviction: same wallet+token spams 50+ alerts.
        const cacheableReasons = ['CURVE_TOO_EARLY', 'CURVE_NEARLY_GRADUATED', 'LOW_CONVICTION'];
        if (cacheableReasons.includes(validation.failReason || '')) {
          this.pumpFunRejectionCache.set(mint, {
            reason: validation.failReason!,
            expiresAt: Date.now() + RossyBotV2.PUMP_FUN_REJECTION_TTL_MS,
          });
          // Only send Telegram for LOW_CONVICTION once (first occurrence gets through, rest cached)
          if (validation.failReason === 'LOW_CONVICTION') {
            await this.telegram.send(
              `🎰 PUMP.FUN rejected: ${mint.slice(0, 8)}\n` +
              `├ Wallet: ${walletLabel}\n` +
              `├ Reason: ${validation.failReason}\n` +
              `├ Curve: ${(validation.curveFillPct * 100).toFixed(0)}% (${validation.solInCurve.toFixed(1)} SOL)\n` +
              `├ SOL spent: ${solSpent.toFixed(2)}\n` +
              `└ <a href="https://pump.fun/coin/${mint}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">dex</a>`,
              { parse_mode: 'HTML' },
            );
          }
        } else {
          // Other rejections (WALLET_QUALITY, etc.) still get Telegram alerts
          await this.telegram.send(
            `🎰 PUMP.FUN rejected: ${mint.slice(0, 8)}\n` +
            `├ Wallet: ${walletLabel}\n` +
            `├ Reason: ${validation.failReason}\n` +
            `├ Curve: ${(validation.curveFillPct * 100).toFixed(0)}% (${validation.solInCurve.toFixed(1)} SOL)\n` +
            `├ SOL spent: ${solSpent.toFixed(2)}\n` +
            `└ <a href="https://pump.fun/coin/${mint}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">dex</a>`,
            { parse_mode: 'HTML' },
          );
        }
        return;
      }

      logger.info({ token: mint.slice(0, 8), confluenceCount, totalSol: confluence.totalSol.toFixed(2), multiplier: confluenceMultiplier },
        'Pump.fun confluence confirmed — entering');

      // Open pump.fun position (pass prefetched quote to skip re-fetching)
      const pos = await this.pumpFunTracker.openPosition({
        tokenMint: mint,
        tokenSymbol: signal.tokenMint.slice(0, 6),
        bondingCurveAddress: signal.pumpFunData?.bondingCurveAddress || deriveBondingCurveAddress(mint),
        solAmount: pumpSize,
        curveFillPct: validation.curveFillPct,
        solInCurve: validation.solInCurve,
        alphaBuyTime: new Date(signal.blockTime * 1000),
        signalWallets: Array.from(confluence.wallets),
        capitalTier: this.capitalManager.tier,
        prefetchedQuote: prefetchedQuote || undefined,
      });

      if (!pos) {
        await this.telegram.send(
          `🎰 PUMP.FUN BUY FAILED: ${mint.slice(0, 8)}\n` +
          `├ Wallet: ${walletLabel}\n` +
          `├ Size: ${pumpSize.toFixed(4)} SOL\n` +
          `└ Swap execution failed — check logs`,
        );
        return;
      }

      const mode = this.pumpFunTracker.isLive ? 'LIVE' : 'SHADOW';
      const confluenceTag = confluenceCount >= 2 ? ` (${confluenceCount} wallets, ${confluence.totalSol.toFixed(1)} SOL total)` : '';

      // Telegram alert — curve scalp strategy
      await this.telegram.send(
        `🎰 CURVE SCALP ENTRY: ${mint.slice(0, 8)}\n` +
        `├ Wallet: ${walletLabel}${confluenceTag}\n` +
        `├ Size: ${pumpSize.toFixed(4)} SOL\n` +
        `├ Curve: ${(validation.curveFillPct * 100).toFixed(0)}% → TP at ${(cfg.curveProfitTarget * 100).toFixed(0)}% | exit at ${(cfg.curveHardExit * 100).toFixed(0)}%\n` +
        `├ Alpha spent: ${solSpent.toFixed(2)} SOL\n` +
        `├ Exits: stall ${cfg.staleTimeKillMins}min | SL ${(cfg.stopLoss * 100).toFixed(0)}% | hard ${cfg.maxTokenAgeMins}min\n` +
        (pos.entry_tx ? `├ TX: ${pos.entry_tx.slice(0, 16)}...\n` : '') +
        `├ <a href="https://pump.fun/coin/${mint}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">dex</a>\n` +
        `└ Mode: ${mode} | Strategy: PRE-GRAD SCALP`,
        { parse_mode: 'HTML' },
      );

      // Position opened log is in tracker._executeOpen — no duplicate needed here
    } catch (err) {
      logger.error({ err, token: signal.tokenMint?.slice(0, 8) }, 'Error in pump.fun buy handler');
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

      // Count from all trade tables (standard + pump.fun)
      const tradeTable = this.isLive ? 'positions' : 'shadow_positions';
      const tradeRow = await (await import('./db/database.js')).getOne<{ count: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM ${tradeTable}) +
           (SELECT COUNT(*) FROM pumpfun_positions WHERE status = 'CLOSED')
         ) as count`,
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
        pumpFunCurveProfitTarget: config.pumpFun.curveProfitTarget,
        pumpFunCurveHardExit: config.pumpFun.curveHardExit,
        pumpFunStaleTimeMins: config.pumpFun.staleTimeKillMins,
        pumpFunMinConviction: config.pumpFun.minConvictionSol,
        pumpFunConfluenceBonus: config.pumpFun.confluenceBonus,
        pumpFunPositionSizeMultiplier: config.pumpFun.positionSizeMultiplier,
        pumpFunStopLoss: config.pumpFun.stopLoss,
        pumpFunMaxPositions: config.pumpFun.maxPositions,
        pumpFunMaxTokenAgeMins: config.pumpFun.maxTokenAgeMins,
        pumpFunSlippageBps: config.pumpFun.slippageBps,
        minCapitalForStandardTrading: config.minCapitalForStandardTrading,
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
    this.pumpFunTracker.stop();
    this.pumpFunAlphaDiscovery.stop();
    this.pumpPortal.disconnect();
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
