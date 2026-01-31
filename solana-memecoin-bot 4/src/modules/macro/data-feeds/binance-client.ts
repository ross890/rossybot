// ===========================================
// BINANCE FREE DATA CLIENT
// ===========================================
// Free Binance API for order book, funding rates, OI, and liquidations
// No API key required for public endpoints

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../../../utils/logger.js';
import {
  BinanceOrderBook,
  BinanceFundingRate,
  BinanceOpenInterest,
  BinanceLiquidation,
  OrderBookMetrics,
} from '../types.js';

/**
 * Binance Free Client
 *
 * Uses Binance's free public APIs:
 * - WebSocket for real-time order book and liquidations
 * - REST for funding rates and open interest
 *
 * Rate limits:
 * - REST: 1200 requests/minute
 * - WebSocket: 10 messages/second per connection
 */
export class BinanceFreeClient extends EventEmitter {
  private orderBookWs: WebSocket | null = null;
  private liquidationWs: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private orderBookCache: BinanceOrderBook | null = null;
  private isConnected = false;

  // REST API endpoints
  private readonly FUTURES_BASE_URL = 'https://fapi.binance.com';
  private readonly SPOT_BASE_URL = 'https://api.binance.com';

  // WebSocket endpoints
  private readonly FUTURES_WS_URL = 'wss://fstream.binance.com/ws';
  private readonly SPOT_WS_URL = 'wss://stream.binance.com:9443/ws';

  constructor() {
    super();
  }

  /**
   * Connect to order book WebSocket stream
   */
  async connectOrderBook(symbol: string = 'btcusdt'): Promise<void> {
    const url = `${this.SPOT_WS_URL}/${symbol}@depth@100ms`;

    return new Promise((resolve, reject) => {
      try {
        this.orderBookWs = new WebSocket(url);

        this.orderBookWs.on('open', () => {
          logger.info({ symbol }, 'Binance order book WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          resolve();
        });

        this.orderBookWs.on('message', (data: Buffer) => {
          try {
            const parsed = JSON.parse(data.toString());
            this.orderBookCache = this.processOrderBookUpdate(parsed);
            this.emit('orderbook', this.orderBookCache);
          } catch (err) {
            logger.error({ err }, 'Failed to parse order book message');
          }
        });

        this.orderBookWs.on('close', () => {
          logger.warn('Binance order book WebSocket closed');
          this.isConnected = false;
          this.handleReconnect('orderbook', symbol);
        });

        this.orderBookWs.on('error', (err) => {
          logger.error({ err }, 'Binance order book WebSocket error');
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Connect to liquidation WebSocket stream
   */
  async connectLiquidations(): Promise<void> {
    const url = `${this.FUTURES_WS_URL}/!forceOrder@arr`;

    return new Promise((resolve, reject) => {
      try {
        this.liquidationWs = new WebSocket(url);

        this.liquidationWs.on('open', () => {
          logger.info('Binance liquidations WebSocket connected');
          resolve();
        });

        this.liquidationWs.on('message', (data: Buffer) => {
          try {
            const parsed = JSON.parse(data.toString());
            const liquidation = this.processLiquidation(parsed);
            if (liquidation) {
              this.emit('liquidation', liquidation);
            }
          } catch (err) {
            logger.error({ err }, 'Failed to parse liquidation message');
          }
        });

        this.liquidationWs.on('close', () => {
          logger.warn('Binance liquidations WebSocket closed');
          this.handleReconnect('liquidations');
        });

        this.liquidationWs.on('error', (err) => {
          logger.error({ err }, 'Binance liquidations WebSocket error');
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Process order book update from WebSocket
   */
  private processOrderBookUpdate(data: any): BinanceOrderBook {
    return {
      bids: (data.b || []).map(([price, qty]: string[]) => ({
        price: parseFloat(price),
        quantity: parseFloat(qty),
      })),
      asks: (data.a || []).map(([price, qty]: string[]) => ({
        price: parseFloat(price),
        quantity: parseFloat(qty),
      })),
      timestamp: Date.now(),
    };
  }

  /**
   * Process liquidation from WebSocket
   */
  private processLiquidation(data: any): BinanceLiquidation | null {
    if (!data.o) return null;

    return {
      symbol: data.o.s,
      side: data.o.S as 'BUY' | 'SELL',
      quantity: parseFloat(data.o.q),
      price: parseFloat(data.o.p),
      timestamp: data.o.T,
    };
  }

  /**
   * Handle WebSocket reconnection
   */
  private handleReconnect(type: 'orderbook' | 'liquidations', symbol?: string): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error({ type }, 'Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.pow(2, this.reconnectAttempts) * 1000;  // Exponential backoff

    logger.info({ type, attempt: this.reconnectAttempts, delayMs: delay }, 'Reconnecting...');

    setTimeout(() => {
      if (type === 'orderbook' && symbol) {
        this.connectOrderBook(symbol).catch((err) => {
          logger.error({ err }, 'Reconnect failed');
        });
      } else if (type === 'liquidations') {
        this.connectLiquidations().catch((err) => {
          logger.error({ err }, 'Reconnect failed');
        });
      }
    }, delay);
  }

  /**
   * Get funding rate (REST API - FREE)
   */
  async getFundingRate(symbol: string = 'BTCUSDT'): Promise<BinanceFundingRate> {
    const response = await fetch(
      `${this.FUTURES_BASE_URL}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch funding rate: ${response.status}`);
    }

    const data = await response.json() as Array<{ fundingRate: string; fundingTime: number }>;
    const latest = data[0];

    return {
      symbol,
      fundingRate: parseFloat(latest.fundingRate),
      fundingTime: latest.fundingTime,
      nextFundingTime: latest.fundingTime + 8 * 60 * 60 * 1000,  // 8 hours later
    };
  }

  /**
   * Get open interest (REST API - FREE)
   */
  async getOpenInterest(symbol: string = 'BTCUSDT'): Promise<BinanceOpenInterest> {
    const response = await fetch(
      `${this.FUTURES_BASE_URL}/fapi/v1/openInterest?symbol=${symbol}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch open interest: ${response.status}`);
    }

    const data = await response.json() as { openInterest: string; time?: number };

    return {
      symbol,
      openInterest: parseFloat(data.openInterest),
      timestamp: data.time || Date.now(),
    };
  }

  /**
   * Get current price (REST API - FREE)
   */
  async getPrice(symbol: string = 'BTCUSDT'): Promise<number> {
    const response = await fetch(
      `${this.SPOT_BASE_URL}/api/v3/ticker/price?symbol=${symbol}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch price: ${response.status}`);
    }

    const data = await response.json() as { price: string };
    return parseFloat(data.price);
  }

  /**
   * Get SOL price
   */
  async getSolPrice(): Promise<number> {
    return this.getPrice('SOLUSDT');
  }

  /**
   * Get BTC price
   */
  async getBtcPrice(): Promise<number> {
    return this.getPrice('BTCUSDT');
  }

  /**
   * Calculate bid/ask imbalance from order book
   * Returns -1 to +1 (negative = more selling pressure)
   */
  calculateImbalance(orderBook: BinanceOrderBook, depth: number = 10): number {
    const topBids = orderBook.bids.slice(0, depth);
    const topAsks = orderBook.asks.slice(0, depth);

    const bidVolume = topBids.reduce((sum, b) => sum + b.quantity * b.price, 0);
    const askVolume = topAsks.reduce((sum, a) => sum + a.quantity * a.price, 0);

    const total = bidVolume + askVolume;
    if (total === 0) return 0;

    return (bidVolume - askVolume) / total;
  }

  /**
   * Find largest bid and ask walls in order book
   */
  findWalls(orderBook: BinanceOrderBook, depth: number = 50): {
    topBidWall: { price: number; size: number };
    topAskWall: { price: number; size: number };
  } {
    const topBids = orderBook.bids.slice(0, depth);
    const topAsks = orderBook.asks.slice(0, depth);

    let topBidWall = { price: 0, size: 0 };
    let topAskWall = { price: 0, size: 0 };

    for (const bid of topBids) {
      const notional = bid.price * bid.quantity;
      if (notional > topBidWall.size) {
        topBidWall = { price: bid.price, size: notional };
      }
    }

    for (const ask of topAsks) {
      const notional = ask.price * ask.quantity;
      if (notional > topAskWall.size) {
        topAskWall = { price: ask.price, size: notional };
      }
    }

    return { topBidWall, topAskWall };
  }

  /**
   * Calculate depth within 1% of mid price
   */
  calculateDepth1Percent(orderBook: BinanceOrderBook): {
    bids: number;
    asks: number;
  } {
    if (orderBook.bids.length === 0 || orderBook.asks.length === 0) {
      return { bids: 0, asks: 0 };
    }

    const midPrice = (orderBook.bids[0].price + orderBook.asks[0].price) / 2;
    const threshold = midPrice * 0.01;

    const bidDepth = orderBook.bids
      .filter((b) => midPrice - b.price <= threshold)
      .reduce((sum, b) => sum + b.quantity * b.price, 0);

    const askDepth = orderBook.asks
      .filter((a) => a.price - midPrice <= threshold)
      .reduce((sum, a) => sum + a.quantity * a.price, 0);

    return { bids: bidDepth, asks: askDepth };
  }

  /**
   * Get aggregated order book metrics
   */
  getOrderBookMetrics(): OrderBookMetrics | null {
    if (!this.orderBookCache) {
      return null;
    }

    const imbalance = this.calculateImbalance(this.orderBookCache);
    const walls = this.findWalls(this.orderBookCache);
    const depth = this.calculateDepth1Percent(this.orderBookCache);

    return {
      bidAskImbalance: imbalance,
      topBidWall: walls.topBidWall,
      topAskWall: walls.topAskWall,
      depth1Percent: depth,
      spoofingDetected: false,  // Would need more sophisticated analysis
    };
  }

  /**
   * Get cached order book
   */
  getOrderBook(): BinanceOrderBook | null {
    return this.orderBookCache;
  }

  /**
   * Check if connected
   */
  isWebSocketConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Disconnect all WebSockets
   */
  disconnect(): void {
    if (this.orderBookWs) {
      this.orderBookWs.close();
      this.orderBookWs = null;
    }
    if (this.liquidationWs) {
      this.liquidationWs.close();
      this.liquidationWs = null;
    }
    this.isConnected = false;
  }
}

// Export singleton instance
export const binanceClient = new BinanceFreeClient();
