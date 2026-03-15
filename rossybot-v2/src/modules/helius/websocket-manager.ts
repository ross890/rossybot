import WebSocket from 'ws';
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

export class HeliusWebSocketManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedWallets: Set<string> = new Set();
  private reconnectAttempt = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private staleCheckInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastMessageAt: number = Date.now();
  private subscriptionId: number | null = null;
  private isConnecting = false;
  private isFallbackMode = false;
  private intentionalClose = false;
  private rpcJsonId = 1;

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
      await this.rebuildSubscription();
    }
    logger.info({ address, total: this.subscribedWallets.size }, 'Wallet added to Helius WS');
  }

  removeWallet(address: string): void {
    this.subscribedWallets.delete(address);
    logger.info({ address, total: this.subscribedWallets.size }, 'Wallet removed from Helius WS');
    // Resubscribe with updated list on next reconnect or force it now
    if (this.connected) {
      this.rebuildSubscription();
    }
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

    logger.info({ wallets: this.subscribedWallets.size }, 'Helius WebSocket connected');
    await this.logHealth(WsHealthEvent.CONNECTED, {});

    // Exit fallback mode if active
    if (this.isFallbackMode) {
      this.isFallbackMode = false;
      this.emit('fallbackDeactivated');
      await this.logHealth(WsHealthEvent.RECONNECTED, { wasInFallback: true });
    }

    // Send subscription
    await this.sendSubscription();

    // Start heartbeat
    this.startHeartbeat();

    this.emit('connected');
  }

  private onMessage(data: WebSocket.Data): void {
    this.lastMessageAt = Date.now();

    try {
      const msg = JSON.parse(data.toString());

      // Handle subscription confirmation
      if (msg.result !== undefined && msg.id !== undefined) {
        this.subscriptionId = msg.result;
        logger.info({ subscriptionId: this.subscriptionId }, 'Helius subscription confirmed');
        return;
      }

      // Handle transaction notification
      if (msg.method === 'transactionNotification' && msg.params?.result) {
        this.emit('transaction', msg.params.result);
      }
    } catch (err) {
      logger.error({ err, data: data.toString().slice(0, 200) }, 'Failed to parse WebSocket message');
    }
  }

  private async onClose(code: number, reason: string): Promise<void> {
    console.error(`Helius WebSocket closed: code=${code} reason=${reason}`);
    this.clearTimers();

    await this.logHealth(WsHealthEvent.DISCONNECTED, { code, reason });

    if (!this.intentionalClose) {
      await this.handleReconnect();
    }

    this.emit('disconnected');
  }

  private async onError(err: Error & { code?: string }): Promise<void> {
    console.error(`Helius WebSocket error: ${err.message} | code: ${err.code || 'none'}`);
    // onClose will be called after onError, which triggers reconnect
  }

  private onPong(): void {
    this.lastMessageAt = Date.now(); // Pong proves connection is alive
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  // --- Subscription management ---

  private async sendSubscription(): Promise<void> {
    if (!this.connected || this.subscribedWallets.size === 0) return;

    const wallets = Array.from(this.subscribedWallets);
    const msg = {
      jsonrpc: '2.0',
      id: this.rpcJsonId++,
      method: 'transactionSubscribe',
      params: [
        {
          accountInclude: wallets,
        },
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          showRewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
    };

    this.ws!.send(JSON.stringify(msg));
    logger.info({ wallets: wallets.length }, 'Sent transactionSubscribe');
    await this.logHealth(WsHealthEvent.SUBSCRIPTION_SENT, { walletCount: wallets.length, wallets });
  }

  private async rebuildSubscription(): Promise<void> {
    // Unsubscribe from current, then resubscribe
    if (this.subscriptionId !== null && this.connected) {
      const unsub = {
        jsonrpc: '2.0',
        id: this.rpcJsonId++,
        method: 'transactionUnsubscribe',
        params: [this.subscriptionId],
      };
      this.ws!.send(JSON.stringify(unsub));
      this.subscriptionId = null;
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

      // Set pong timeout
      this.pongTimeout = setTimeout(async () => {
        logger.warn('Helius WebSocket pong timeout — force reconnecting');
        await this.logHealth(WsHealthEvent.PING_TIMEOUT, {});
        this.ws?.terminate();
      }, config.helius.pongTimeoutMs);
    }, config.helius.pingIntervalMs);

    // Stale check every 30 seconds
    this.staleCheckInterval = setInterval(async () => {
      const elapsed = Date.now() - this.lastMessageAt;
      if (elapsed > config.helius.staleTimeoutMs) {
        logger.warn({ elapsedMs: elapsed }, 'Helius WebSocket stale — no messages for 2 min, reconnecting');
        await this.logHealth(WsHealthEvent.STALE_DETECTED, { elapsedMs: elapsed });
        this.ws?.terminate();
      }
    }, 30_000);
  }

  private clearTimers(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    if (this.staleCheckInterval) { clearInterval(this.staleCheckInterval); this.staleCheckInterval = null; }
    if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null; }
  }

  // --- Reconnection ---

  private async handleReconnect(): Promise<void> {
    this.isConnecting = false;
    this.reconnectAttempt++;

    const delays = config.helius.reconnectDelays;
    const delay = delays[Math.min(this.reconnectAttempt - 1, delays.length - 1)];

    logger.info({ attempt: this.reconnectAttempt, delayMs: delay }, 'Reconnecting to Helius WebSocket');
    await this.logHealth(WsHealthEvent.RECONNECTING, { attempt: this.reconnectAttempt, delayMs: delay });

    // Activate fallback after max attempts
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
  } {
    return {
      connected: this.connected,
      fallbackMode: this.isFallbackMode,
      subscribedWallets: this.subscribedWallets.size,
      reconnectAttempt: this.reconnectAttempt,
      lastMessageAgoMs: Date.now() - this.lastMessageAt,
    };
  }
}
