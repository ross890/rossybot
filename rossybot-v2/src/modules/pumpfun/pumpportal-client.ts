import WebSocket from 'ws';
import { logger } from '../../utils/logger.js';

/**
 * Trade event from PumpPortal WebSocket.
 * See: https://pumpportal.fun/data-api/real-time/
 */
export interface PumpPortalTrade {
  txType: 'buy' | 'sell' | 'create';
  signature: string;
  mint: string;
  traderPublicKey: string;
  bondingCurveKey: string;
  tokenAmount: number;
  newTokenBalance: number;
  marketCapSol: number;
  vSolInBondingCurve: number;
  vTokensInBondingCurve: number;
}

/**
 * Migration (graduation) event from PumpPortal.
 * Fired when a token's bonding curve completes and liquidity migrates to PumpSwap.
 */
export interface PumpPortalMigration {
  mint: string;
  signature?: string;
  /** Timestamp of the migration transaction */
  timestamp?: number;
}

export interface PumpPortalEvents {
  trade: (trade: PumpPortalTrade) => void;
  newToken: (trade: PumpPortalTrade) => void;
  migration: (migration: PumpPortalMigration) => void;
  connected: () => void;
  disconnected: () => void;
}

/**
 * PumpPortal WebSocket client — streams real-time pump.fun bonding curve trades.
 *
 * Strategy for alpha discovery:
 * 1. subscribeNewToken → receive creation events for new mints
 * 2. For each new mint, auto-subscribe to its trades via subscribeTokenTrade
 * 3. Now we receive all buy/sell activity on new tokens → feed into alpha discovery
 * 4. Cap tracked tokens and evict after graduation/staleness to control memory
 */
export class PumpPortalClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private listeners = new Map<string, Set<Function>>();
  private tradeCount = 0;
  private createCount = 0;
  private migrationCount = 0;
  private lastTradeAt = 0;

  // Track subscribed tokens to avoid duplicates and manage memory
  private subscribedTokens: Map<string, number> = new Map(); // mint → subscribe timestamp
  private static readonly MAX_SUBSCRIBED_TOKENS = 500;
  private static readonly TOKEN_EVICT_AGE_MS = 30 * 60 * 1000; // 30 min — most pump.fun tokens resolve by then
  private evictInterval: ReturnType<typeof setInterval> | null = null;

  // Batch token subscriptions to reduce WS message rate
  private pendingTokenSubs: string[] = [];
  private subBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SUB_BATCH_INTERVAL_MS = 2_000; // Batch every 2s

  private static readonly WS_URL = 'wss://pumpportal.fun/api/data';
  private static readonly MAX_RECONNECT_DELAY = 60_000;
  private static readonly INITIAL_RECONNECT_DELAY = 2_000;

  on<K extends keyof PumpPortalEvents>(event: K, listener: PumpPortalEvents[K]): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  private emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get stats(): {
    tradeCount: number;
    createCount: number;
    migrationCount: number;
    lastTradeAt: number;
    connected: boolean;
    subscribedTokens: number;
  } {
    return {
      tradeCount: this.tradeCount,
      createCount: this.createCount,
      migrationCount: this.migrationCount,
      lastTradeAt: this.lastTradeAt,
      connected: this.connected,
      subscribedTokens: this.subscribedTokens.size,
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.intentionalClose = false;

    return new Promise((resolve) => {
      this.ws = new WebSocket(PumpPortalClient.WS_URL);

      this.ws.on('open', () => {
        this.reconnectAttempt = 0;
        logger.info('PumpPortal WebSocket connected');

        // Subscribe to new token creation events — we'll auto-subscribe to their trades
        this.ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));

        // Subscribe to migration (graduation) events — tokens moving from bonding curve to PumpSwap
        this.ws!.send(JSON.stringify({ method: 'subscribeMigration' }));

        // Start token eviction loop
        this.evictInterval = setInterval(() => this.evictStaleTokens(), 60_000);

        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => this.handleMessage(data));

      this.ws.on('close', (code: number, reason: Buffer) => {
        logger.warn({ code, reason: reason.toString() }, 'PumpPortal WebSocket closed');
        this.clearTimers();
        this.emit('disconnected');
        if (!this.intentionalClose) this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        logger.error({ err: err.message }, 'PumpPortal WebSocket error');
      });

      // Resolve after timeout if connection takes too long
      setTimeout(() => resolve(), 10_000);
    });
  }

  /** Subscribe to trades on specific tokens (for tracking tokens we're interested in) */
  subscribeTokenTrades(mints: string[]): void {
    if (!this.connected || mints.length === 0) return;
    for (const mint of mints) {
      if (this.subscribedTokens.has(mint)) continue;
      this.subscribedTokens.set(mint, Date.now());
      this.pendingTokenSubs.push(mint);
    }
    this.flushPendingSubs();
  }

  /** Subscribe to trades by specific accounts (for tracking alpha wallets) */
  subscribeAccountTrades(accounts: string[]): void {
    if (!this.connected || accounts.length === 0) return;
    this.ws!.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: accounts }));
    logger.info({ count: accounts.length }, 'PumpPortal: subscribed to account trades');
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  private clearTimers(): void {
    if (this.evictInterval) { clearInterval(this.evictInterval); this.evictInterval = null; }
    if (this.subBatchTimer) { clearTimeout(this.subBatchTimer); this.subBatchTimer = null; }
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString());

      // Skip non-trade messages (subscription confirmations, etc.)
      if (!msg.mint) return;

      // Migration (graduation) event — token moved from bonding curve to PumpSwap
      // PumpPortal sends these with txType absent or as a separate event structure
      if (msg.txType === 'migration' || msg.pool || (msg.signature && !msg.txType && !msg.traderPublicKey)) {
        this.migrationCount++;
        const migration: PumpPortalMigration = {
          mint: msg.mint,
          signature: msg.signature,
          timestamp: msg.timestamp || Date.now(),
        };
        this.emit('migration', migration);

        // Also detect graduation from high curve fill in trade events
        // Remove from tracked tokens since it graduated
        this.subscribedTokens.delete(msg.mint);
        return;
      }

      if (!msg.txType) return;

      if (msg.txType === 'create') {
        this.createCount++;
        // New token created — auto-subscribe to its trades for alpha discovery
        this.autoSubscribeToken(msg.mint);
        this.emit('newToken', msg as PumpPortalTrade);
        return;
      }

      // Buy or sell trade
      if (!msg.traderPublicKey) return;

      this.tradeCount++;
      this.lastTradeAt = Date.now();

      // Detect graduation from curve fill: if vSol exceeds graduation threshold (~85 SOL real),
      // emit a synthetic migration event. This catches graduations even if the explicit
      // subscribeMigration event is delayed or missing.
      const trade = msg as PumpPortalTrade;
      if (trade.vSolInBondingCurve) {
        const realSol = Math.max(0, trade.vSolInBondingCurve - 30);
        if (realSol >= 82 && !this.emittedGraduations.has(trade.mint)) {
          this.emittedGraduations.add(trade.mint);
          this.migrationCount++;
          this.emit('migration', {
            mint: trade.mint,
            signature: trade.signature,
            timestamp: Date.now(),
          } as PumpPortalMigration);
        }
      }

      this.emit('trade', trade);
    } catch {
      // Ignore parse errors (subscription confirmations, etc.)
    }
  }

  // Track graduations detected from curve fill to avoid duplicate events
  private emittedGraduations = new Set<string>();

  /**
   * Auto-subscribe to trades on a newly created token.
   * This is the key to alpha discovery: by watching trades on new tokens,
   * we can identify wallets with consistently profitable entries.
   */
  private autoSubscribeToken(mint: string): void {
    if (this.subscribedTokens.has(mint)) return;

    // Cap subscriptions — evict oldest if needed
    if (this.subscribedTokens.size >= PumpPortalClient.MAX_SUBSCRIBED_TOKENS) {
      this.evictOldestToken();
    }

    this.subscribedTokens.set(mint, Date.now());
    this.pendingTokenSubs.push(mint);
    this.flushPendingSubs();
  }

  /** Batch pending token subscriptions to reduce WS message rate */
  private flushPendingSubs(): void {
    if (this.subBatchTimer) return; // Already scheduled
    this.subBatchTimer = setTimeout(() => {
      this.subBatchTimer = null;
      if (this.pendingTokenSubs.length === 0 || !this.connected) return;

      const batch = this.pendingTokenSubs.splice(0);
      this.ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: batch }));

      if (this.createCount <= 5 || this.createCount % 50 === 0) {
        logger.info({
          batchSize: batch.length,
          totalTokens: this.subscribedTokens.size,
          totalTrades: this.tradeCount,
        }, 'PumpPortal: subscribed to token trades batch');
      }
    }, PumpPortalClient.SUB_BATCH_INTERVAL_MS);
  }

  private evictStaleTokens(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [mint, timestamp] of this.subscribedTokens) {
      if (now - timestamp > PumpPortalClient.TOKEN_EVICT_AGE_MS) {
        this.subscribedTokens.delete(mint);
        evicted++;
      }
    }
    // Cap emitted graduations set to prevent unbounded growth
    if (this.emittedGraduations.size > 2000) {
      this.emittedGraduations.clear();
    }
    if (evicted > 0) {
      logger.debug({ evicted, remaining: this.subscribedTokens.size }, 'PumpPortal: evicted stale token subscriptions');
    }
  }

  private evictOldestToken(): void {
    let oldestMint: string | null = null;
    let oldestTime = Infinity;
    for (const [mint, timestamp] of this.subscribedTokens) {
      if (timestamp < oldestTime) {
        oldestTime = timestamp;
        oldestMint = mint;
      }
    }
    if (oldestMint) {
      this.subscribedTokens.delete(oldestMint);
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const delay = Math.min(
      PumpPortalClient.INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempt - 1),
      PumpPortalClient.MAX_RECONNECT_DELAY,
    );
    logger.info({ attempt: this.reconnectAttempt, delayMs: delay }, 'PumpPortal reconnecting...');
    setTimeout(() => this.connect(), delay);
  }
}
