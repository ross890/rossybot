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

export interface PumpPortalEvents {
  trade: (trade: PumpPortalTrade) => void;
  connected: () => void;
  disconnected: () => void;
}

/**
 * PumpPortal WebSocket client — streams real-time pump.fun bonding curve trades.
 * Single connection, subscribes to new token events to capture all trades.
 */
export class PumpPortalClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private listeners = new Map<string, Set<Function>>();
  private tradeCount = 0;
  private lastTradeAt = 0;

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

  get stats(): { tradeCount: number; lastTradeAt: number; connected: boolean } {
    return { tradeCount: this.tradeCount, lastTradeAt: this.lastTradeAt, connected: this.connected };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.intentionalClose = false;

    return new Promise((resolve) => {
      this.ws = new WebSocket(PumpPortalClient.WS_URL);

      this.ws.on('open', () => {
        this.reconnectAttempt = 0;
        logger.info('PumpPortal WebSocket connected');

        // Subscribe to ALL new token creation events — this captures every trade on new tokens
        this.ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));

        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data) => this.handleMessage(data));

      this.ws.on('close', (code, reason) => {
        logger.warn({ code, reason: reason.toString() }, 'PumpPortal WebSocket closed');
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
    this.ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: mints }));
  }

  /** Subscribe to trades by specific accounts (for tracking alpha wallets) */
  subscribeAccountTrades(accounts: string[]): void {
    if (!this.connected || accounts.length === 0) return;
    this.ws!.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: accounts }));
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.ws?.close();
    this.ws = null;
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString()) as PumpPortalTrade;

      // Skip creation events and non-trade messages
      if (!msg.txType || !msg.traderPublicKey || !msg.mint) return;

      this.tradeCount++;
      this.lastTradeAt = Date.now();

      this.emit('trade', msg);
    } catch {
      // Ignore parse errors (subscription confirmations, etc.)
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
