import WebSocket from 'ws';
import axios from 'axios';
import { EventEmitter } from 'events';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { query } from '../../db/database.js';
import { WsHealthEvent } from '../../types/index.js';

export interface HeliusWsEvents {
  transaction: (data: unknown) => void;
  connected: () => void;
  disconnected: () => void;
  fallbackActivated: () => void;
  fallbackDeactivated: () => void;
}

/**
 * WebSocket manager using standard Solana `logsSubscribe` (works on all Helius plans).
 * Creates one subscription per wallet using { mentions: [address] }.
 * On log notification, fetches the full transaction via RPC and emits it.
 */
export class HeliusWebSocketManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedWallets: Set<string> = new Set();
  private reconnectAttempt = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private staleCheckInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastMessageAt: number = Date.now();
  private lastTxAt: number = 0;
  private activeSubscriptionIds: number[] = [];
  private isConnecting = false;
  private isFallbackMode = false;
  private intentionalClose = false;
  private rpcJsonId = 1;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private messageCount = 0;
  private txNotificationCount = 0;
  // Dedup: avoid fetching the same signature twice (concurrent log notifications)
  private recentSignatures: Set<string> = new Set();
  // Track in-flight tx fetches to avoid overwhelming RPC
  private activeFetches = 0;
  private filteredTxCount = 0; // TXs skipped by log pre-filter (no token activity)
  private static readonly MAX_CONCURRENT_FETCHES = 5;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get fallbackActive(): boolean {
    return this.isFallbackMode;
  }

  get walletCount(): number {
    return this.subscribedWallets.size;
  }

  async connect(walletAddresses: string[]): Promise<void> {
    walletAddresses.forEach((w) => this.subscribedWallets.add(w));
    await this.establishConnection();
  }

  async addWallet(address: string): Promise<void> {
    this.subscribedWallets.add(address);
    if (this.connected) {
      // Subscribe to the new wallet immediately
      this.sendLogsSubscribe(address);
    }
    logger.info({ address: address.slice(0, 8), total: this.subscribedWallets.size }, 'Wallet added to Helius WS');
  }

  removeWallet(address: string): void {
    this.subscribedWallets.delete(address);
    logger.info({ address: address.slice(0, 8), total: this.subscribedWallets.size }, 'Wallet removed from Helius WS');
    if (this.connected) {
      this.scheduleRebuild();
    }
  }

  /** Debounce subscription rebuilds so rapid add/remove calls batch into one */
  private scheduleRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildSubscription();
    }, 2_000);
  }

  async shutdown(): Promise<void> {
    this.intentionalClose = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // --- Connection lifecycle ---

  private async establishConnection(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.close();
        this.ws = null;
      }

      const maskedUrl = config.helius.wsUrl.replace(/api-key=(.{4}).*/, 'api-key=$1***');
      console.log(`Connecting to Helius WebSocket: ${maskedUrl}`);

      this.ws = new WebSocket(config.helius.wsUrl);

      this.ws.on('open', () => this.onOpen());
      this.ws.on('message', (data: WebSocket.Data) => this.onMessage(data));
      this.ws.on('close', (code: number, reason: Buffer) => this.onClose(code, reason.toString()));
      this.ws.on('error', (err: Error) => this.onError(err));
      this.ws.on('pong', () => this.onPong());
    } catch (err) {
      logger.error({ err }, 'Failed to create WebSocket');
      this.isConnecting = false;
      await this.handleReconnect();
    }
  }

  private async onOpen(): Promise<void> {
    this.isConnecting = false;
    this.reconnectAttempt = 0;
    this.lastMessageAt = Date.now();
    this.lastTxAt = 0;

    logger.info({ wallets: this.subscribedWallets.size }, 'Helius WebSocket connected');
    await this.logHealth(WsHealthEvent.CONNECTED, {});

    // Exit fallback mode if active
    if (this.isFallbackMode) {
      this.isFallbackMode = false;
      this.emit('fallbackDeactivated');
      await this.logHealth(WsHealthEvent.RECONNECTED, { wasInFallback: true });
    }

    // Send logsSubscribe for each wallet
    await this.sendSubscription();

    // Start heartbeat
    this.startHeartbeat();

    this.emit('connected');
  }

  private onMessage(data: WebSocket.Data): void {
    this.lastMessageAt = Date.now();
    this.messageCount++;

    try {
      const msg = JSON.parse(data.toString());

      // Handle subscription confirmation
      if (msg.result !== undefined && msg.id !== undefined) {
        if (typeof msg.result === 'number') {
          this.activeSubscriptionIds.push(msg.result);
        }
        // Only log milestone confirmations to avoid spam with many wallets
        if (this.activeSubscriptionIds.length <= 3 ||
            this.activeSubscriptionIds.length === this.subscribedWallets.size) {
          logger.info({
            subscriptionId: msg.result,
            confirmed: this.activeSubscriptionIds.length,
            total: this.subscribedWallets.size,
          }, 'logsSubscribe confirmed');
        }
        return;
      }

      // Handle log notification (standard Solana method)
      if (msg.method === 'logsNotification' && msg.params?.result) {
        const logResult = msg.params.result;
        const signature = logResult?.value?.signature;
        const err = logResult?.value?.err;

        // Skip failed transactions
        if (err || !signature) return;

        // Dedup: skip if we've already seen this signature
        if (this.recentSignatures.has(signature)) return;
        this.recentSignatures.add(signature);

        // Pre-filter: check log messages for token-related activity before expensive RPC fetch.
        // logsNotification includes program log messages — if none mention token programs or
        // pump.fun, the TX is almost certainly a SOL-only interaction (staking, DeFi, etc.)
        const logs: string[] = logResult?.value?.logs || [];
        const hasTokenActivity = logs.some((log: string) =>
          log.includes('TokenkegQ') ||      // SPL Token program
          log.includes('Token2') ||          // Token2022 program
          log.includes('6EF8rrecthR5') ||    // Pump.fun program
          log.includes('Transfer') ||        // Token transfer instruction
          log.includes('MintTo') ||          // Mint instruction
          log.includes('Burn'),              // Burn instruction
        );
        if (!hasTokenActivity) {
          this.filteredTxCount++;
          return; // Skip RPC fetch entirely — no token-related activity
        }

        // Keep dedup set small
        if (this.recentSignatures.size > 500) {
          const iter = this.recentSignatures.values();
          for (let i = 0; i < 250; i++) iter.next();
          const remaining = new Set<string>();
          for (const v of iter) remaining.add(v);
          this.recentSignatures = remaining;
        }

        this.lastTxAt = Date.now();
        this.txNotificationCount++;
        if (this.txNotificationCount <= 5 || this.txNotificationCount % 10 === 0) {
          console.log(`📡 WS LOG #${this.txNotificationCount} | sig: ${signature.slice(0, 12)}... | total msgs: ${this.messageCount}`);
        }

        // Fetch full transaction via RPC and emit
        this.fetchAndEmitTransaction(signature, logResult?.context?.slot);
      }
    } catch (err) {
      logger.error({ err, data: data.toString().slice(0, 200) }, 'Failed to parse WebSocket message');
    }
  }

  /**
   * Fetch the full transaction via Helius RPC and emit it for parsing.
   * Rate-limited to MAX_CONCURRENT_FETCHES to avoid overwhelming the RPC.
   */
  private async fetchAndEmitTransaction(signature: string, slot?: number): Promise<void> {
    if (this.activeFetches >= HeliusWebSocketManager.MAX_CONCURRENT_FETCHES) {
      logger.debug({ signature: signature.slice(0, 12) }, 'Skipping tx fetch — too many concurrent fetches');
      return;
    }

    this.activeFetches++;
    try {
      const resp = await axios.post(config.helius.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [signature, {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        }],
      }, { timeout: 10_000 });

      if (resp.data?.result) {
        const result = {
          signature,
          slot: slot || resp.data.result.slot,
          transaction: resp.data.result,
        };
        this.emit('transaction', result);
      } else {
        logger.warn({ sig: signature.slice(0, 12), error: resp.data?.error }, 'getTransaction returned null — tx may not be confirmed yet');
      }
    } catch (err) {
      logger.debug({ err, sig: signature.slice(0, 12) }, 'Failed to fetch transaction for log notification');
    } finally {
      this.activeFetches--;
    }
  }

  private async onClose(code: number, reason: string): Promise<void> {
    console.error(`Helius WebSocket closed: code=${code} reason=${reason}`);
    this.clearTimers();
    this.activeSubscriptionIds = [];

    await this.logHealth(WsHealthEvent.DISCONNECTED, { code, reason });

    if (!this.intentionalClose) {
      await this.handleReconnect();
    }

    this.emit('disconnected');
  }

  private async onError(err: Error & { code?: string }): Promise<void> {
    console.error(`Helius WebSocket error: ${err.message} | code: ${err.code || 'none'}`);
  }

  private onPong(): void {
    this.lastMessageAt = Date.now();
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  // --- Subscription management ---

  /**
   * Send logsSubscribe for each wallet using standard Solana { mentions: [address] }.
   * Each wallet gets its own subscription since `mentions` only accepts one address.
   */
  private async sendSubscription(): Promise<void> {
    if (!this.connected || this.subscribedWallets.size === 0) return;

    const wallets = Array.from(this.subscribedWallets);

    for (const wallet of wallets) {
      this.sendLogsSubscribe(wallet);
    }

    console.log(`Sent logsSubscribe for ${wallets.length} wallets`);
    await this.logHealth(WsHealthEvent.SUBSCRIPTION_SENT, { walletCount: wallets.length });
  }

  private sendLogsSubscribe(walletAddress: string): void {
    if (!this.connected) return;

    const msg = {
      jsonrpc: '2.0',
      id: this.rpcJsonId++,
      method: 'logsSubscribe',
      params: [
        { mentions: [walletAddress] },
        { commitment: 'confirmed' },
      ],
    };

    this.ws!.send(JSON.stringify(msg));
  }

  private async rebuildSubscription(): Promise<void> {
    // Unsubscribe from ALL active subscriptions
    if (this.connected && this.activeSubscriptionIds.length > 0) {
      for (const subId of this.activeSubscriptionIds) {
        const unsub = {
          jsonrpc: '2.0',
          id: this.rpcJsonId++,
          method: 'logsUnsubscribe',
          params: [subId],
        };
        this.ws!.send(JSON.stringify(unsub));
      }
      logger.info({ unsubscribed: this.activeSubscriptionIds.length }, 'Unsubscribed all active log subscriptions');
      this.activeSubscriptionIds = [];
    }
    await this.sendSubscription();
  }

  // --- Heartbeat & stale detection ---

  private startHeartbeat(): void {
    this.clearTimers();

    // Ping every 30 seconds
    this.pingInterval = setInterval(() => {
      if (!this.connected) return;

      this.ws!.ping();

      this.pongTimeout = setTimeout(async () => {
        logger.warn('Helius WebSocket pong timeout — force reconnecting');
        await this.logHealth(WsHealthEvent.PING_TIMEOUT, {});
        this.ws?.terminate();
      }, config.helius.pongTimeoutMs);
    }, config.helius.pingIntervalMs);

    // Stale check every 30 seconds
    this.staleCheckInterval = setInterval(async () => {
      const msgElapsed = Date.now() - this.lastMessageAt;
      if (msgElapsed > config.helius.staleTimeoutMs) {
        logger.warn({ elapsedMs: msgElapsed }, 'Helius WebSocket stale — no messages at all, reconnecting');
        await this.logHealth(WsHealthEvent.STALE_DETECTED, { elapsedMs: msgElapsed });
        this.ws?.terminate();
        return;
      }

      // Subscription-level staleness — no tx notifications for 30 min
      const TX_STALE_MS = 30 * 60 * 1000;
      if (this.lastTxAt > 0) {
        const txElapsed = Date.now() - this.lastTxAt;
        if (txElapsed > TX_STALE_MS) {
          logger.warn({ txElapsedMs: txElapsed, lastTxAgo: `${Math.round(txElapsed / 60000)}min` },
            'Helius subscription stale — no tx for 30 min, resubscribing');
          await this.logHealth(WsHealthEvent.STALE_DETECTED, { txElapsedMs: txElapsed, action: 'resubscribe' });
          this.lastTxAt = Date.now();
          await this.rebuildSubscription();
        }
      }
    }, 30_000);
  }

  private clearTimers(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    if (this.staleCheckInterval) { clearInterval(this.staleCheckInterval); this.staleCheckInterval = null; }
    if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null; }
    if (this.rebuildTimer) { clearTimeout(this.rebuildTimer); this.rebuildTimer = null; }
  }

  // --- Reconnection ---

  private async handleReconnect(): Promise<void> {
    this.isConnecting = false;
    this.reconnectAttempt++;

    const delays = config.helius.reconnectDelays;
    const delay = delays[Math.min(this.reconnectAttempt - 1, delays.length - 1)];

    logger.info({ attempt: this.reconnectAttempt, delayMs: delay }, 'Reconnecting to Helius WebSocket');
    await this.logHealth(WsHealthEvent.RECONNECTING, { attempt: this.reconnectAttempt, delayMs: delay });

    if (this.reconnectAttempt >= config.helius.maxReconnectAttempts && !this.isFallbackMode) {
      this.isFallbackMode = true;
      logger.error('Helius WebSocket failed after max attempts — activating fallback mode');
      this.emit('fallbackActivated');
    }

    await new Promise((resolve) => setTimeout(resolve, delay));

    if (!this.intentionalClose) {
      await this.establishConnection();
    }
  }

  // --- Health logging ---

  private async logHealth(event: WsHealthEvent, details: Record<string, unknown>): Promise<void> {
    try {
      await query(
        `INSERT INTO ws_health (event, details, reconnect_attempt, subscribed_wallets)
         VALUES ($1, $2, $3, $4)`,
        [event, JSON.stringify(details), this.reconnectAttempt, this.subscribedWallets.size],
      );
    } catch (err) {
      logger.error({ err }, 'Failed to log WS health');
    }
  }

  // --- Status ---

  getStatus(): {
    connected: boolean;
    fallbackMode: boolean;
    subscribedWallets: number;
    reconnectAttempt: number;
    lastMessageAgoMs: number;
    lastTxAgoMs: number;
    totalMessages: number;
    txNotifications: number;
    filteredTxCount: number;
  } {
    return {
      connected: this.connected,
      fallbackMode: this.isFallbackMode,
      subscribedWallets: this.subscribedWallets.size,
      reconnectAttempt: this.reconnectAttempt,
      lastMessageAgoMs: Date.now() - this.lastMessageAt,
      lastTxAgoMs: this.lastTxAt > 0 ? Date.now() - this.lastTxAt : -1,
      totalMessages: this.messageCount,
      txNotifications: this.txNotificationCount,
      filteredTxCount: this.filteredTxCount,
    };
  }
}
