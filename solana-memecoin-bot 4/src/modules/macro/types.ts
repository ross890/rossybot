// ===========================================
// MACRO GANN ANALYZER - TYPE DEFINITIONS
// ===========================================

// ============ ENUMS ============

export enum MacroBias {
  LONG = 'LONG',
  SHORT = 'SHORT',
  NEUTRAL = 'NEUTRAL'
}

export enum BiasStrength {
  WEAK = 'WEAK',
  MODERATE = 'MODERATE',
  STRONG = 'STRONG',
  EXTREME = 'EXTREME'
}

export enum MacroAction {
  OPEN_LONG = 'OPEN_LONG',
  OPEN_SHORT = 'OPEN_SHORT',
  CLOSE_LONG = 'CLOSE_LONG',
  CLOSE_SHORT = 'CLOSE_SHORT',
  ADD_LONG = 'ADD_LONG',
  ADD_SHORT = 'ADD_SHORT',
  REDUCE_LONG = 'REDUCE_LONG',
  REDUCE_SHORT = 'REDUCE_SHORT',
  HOLD = 'HOLD',
  FLAT = 'FLAT'
}

export enum MarketRegime {
  ACCUMULATION = 'ACCUMULATION',
  MARKUP = 'MARKUP',
  DISTRIBUTION = 'DISTRIBUTION',
  MARKDOWN = 'MARKDOWN',
  RANGING = 'RANGING',
  CAPITULATION = 'CAPITULATION'
}

export enum GannAngleName {
  ANGLE_8X1 = '8x1',
  ANGLE_4X1 = '4x1',
  ANGLE_3X1 = '3x1',
  ANGLE_2X1 = '2x1',
  ANGLE_1X1 = '1x1',
  ANGLE_1X2 = '1x2',
  ANGLE_1X3 = '1x3',
  ANGLE_1X4 = '1x4',
  ANGLE_1X8 = '1x8'
}

export enum TrendStrength {
  VERY_STRONG = 'VERY_STRONG',
  STRONG = 'STRONG',
  MODERATE = 'MODERATE',
  WEAK = 'WEAK',
  VERY_WEAK = 'VERY_WEAK'
}

export enum CycleSignificance {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW'
}

export enum PivotType {
  HIGH = 'HIGH',
  LOW = 'LOW'
}

// ============ GANN TYPES ============

export interface GannLevels {
  support: number[];
  resistance: number[];
  cardinalCross: Array<{ angle: number; price: number }>;
}

export interface DetailedGannLevel {
  angle: number;
  priceUp: number;
  priceDown: number;
}

export interface GannAngleResult {
  currentAngle: number;
  closestGannAngle: GannAngleName;
  trendStrength: TrendStrength;
  direction: 'UP' | 'DOWN';
  isAbove1x1: boolean;
}

export interface TimeCycleWindow {
  cycleLength: number;
  expectedDate: Date;
  barsRemaining: number;
  fromPivot: PivotType;
  significance: CycleSignificance;
}

export interface SeasonalCycle {
  name: string;
  date: Date;
  type: 'EQUINOX' | 'SOLSTICE';
}

export interface ConfluenceSignal {
  type: 'PRICE_TIME_CONFLUENCE';
  confidence: number;
  priceLevel: number;
  timeCycle: TimeCycleWindow;
  expectedReversal: 'BULLISH' | 'BEARISH';
  message: string;
}

export interface GannPivot {
  id?: string;
  timestamp: Date;
  asset: string;
  pivotType: PivotType;
  price: number;
  timeframe: '1h' | '4h' | '1d';
  isMajor: boolean;
}

export interface GannAnalysis {
  currentAngle: GannAngleResult;
  squareOf9Levels: GannLevels;
  activeCycles: TimeCycleWindow[];
  confluence: ConfluenceSignal | null;
  nearestSupport: number;
  nearestResistance: number;
}

// ============ DATA FEED TYPES ============

export interface BinanceOrderBook {
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
  timestamp: number;
}

export interface BinanceFundingRate {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
  nextFundingTime: number;
}

export interface BinanceOpenInterest {
  symbol: string;
  openInterest: number;
  timestamp: number;
}

export interface BinanceLiquidation {
  symbol: string;
  side: 'BUY' | 'SELL';  // BUY = short liquidated, SELL = long liquidated
  quantity: number;
  price: number;
  timestamp: number;
}

export interface CoinalyzeOI {
  symbol: string;
  openInterest: number;
  openInterestUsd: number;
  timestamp: number;
}

export interface CoinalyzeFunding {
  symbol: string;
  fundingRate: number;
  timestamp: number;
}

export interface CoinalyzeLiquidation {
  symbol: string;
  longLiquidations: number;
  shortLiquidations: number;
  timestamp: number;
}

export interface FearGreedData {
  value: number;
  classification: string;
  timestamp: Date;
  cached: boolean;
}

export interface FearGreedHistory {
  value: number;
  classification: string;
  timestamp: Date;
}

export interface WhaleTransaction {
  amount: number;
  asset: string;
  usdValue: number;
  type: 'EXCHANGE_INFLOW' | 'EXCHANGE_OUTFLOW' | 'TRANSFER';
  timestamp: Date;
}

export interface ExchangeFlows {
  inflows: number;
  outflows: number;
  netFlow: number;
  transactionCount: number;
}

export interface LunarCrushMetrics {
  symbol: string;
  socialVolume: number;
  socialScore: number;
  sentiment: number;
  galaxyScore: number;
  altRank: number;
}

// ============ AGGREGATED METRICS ============

export interface DerivativesMetrics {
  fundingRate: number;
  openInterest: number;
  oiChange24h: number;
  liquidations24h: {
    long: number;
    short: number;
    total: number;
  };
}

export interface OrderBookMetrics {
  bidAskImbalance: number;
  topBidWall: { price: number; size: number };
  topAskWall: { price: number; size: number };
  depth1Percent: { bids: number; asks: number };
  spoofingDetected: boolean;
}

export interface SentimentMetrics {
  fearGreedIndex: number;
  fearGreedClassification: string;
  socialScore: number;
  sentimentPolarity: number;
}

export interface WhaleActivityMetrics {
  recentLargeTransfers: number;
  exchangeFlowBias: 'INFLOW' | 'OUTFLOW' | 'NEUTRAL';
  netFlow24h: number;
}

// ============ LEVERAGE TYPES ============

export interface LeverageRecommendation {
  suggested: number;
  maximum: number;
  reasoning: string;
}

// ============ MAIN SIGNAL TYPE ============

export interface MacroGannSignal {
  id: string;
  timestamp: Date;

  // Directional
  bias: MacroBias;
  biasStrength: BiasStrength;
  action: MacroAction;

  // Leverage
  leverage: LeverageRecommendation;

  // Gann Analysis
  gann: GannAnalysis;

  // Live Metrics
  derivatives: DerivativesMetrics;
  orderBook: OrderBookMetrics;
  sentiment: SentimentMetrics;
  whaleActivity: WhaleActivityMetrics;

  // Price data
  btcPrice: number;
  solPrice: number;
  solBtcRatio: number;

  // Meta
  confidence: number;
  regime: MarketRegime;
  summary: string;
  keyLevels: {
    support: number[];
    resistance: number[];
  };

  // Explicit informational flag
  isInformationalOnly: true;
}

// ============ CONFIG TYPES ============

export interface MacroConfig {
  // Data refresh intervals (ms)
  orderBookRefreshMs: number;
  derivativesRefreshMs: number;
  sentimentRefreshMs: number;
  gannRecalcMs: number;

  // Signal generation
  signalCooldownMs: number;
  minConfidenceForSignal: number;

  // Gann parameters
  gannPriceScale: number;  // Price units per time unit for 1x1 angle
  confluenceTolerancePrice: number;  // e.g., 0.01 = 1%
  confluenceToleranceBars: number;

  // API keys (optional)
  coinalyzeApiKey?: string;
  lunarcrushApiKey?: string;
}

export const DEFAULT_MACRO_CONFIG: MacroConfig = {
  orderBookRefreshMs: 5000,        // 5 seconds
  derivativesRefreshMs: 60000,     // 1 minute
  sentimentRefreshMs: 300000,      // 5 minutes
  gannRecalcMs: 60000,             // 1 minute

  signalCooldownMs: 4 * 60 * 60 * 1000,  // 4 hours
  minConfidenceForSignal: 60,

  gannPriceScale: 1000,            // $1000 per time unit
  confluenceTolerancePrice: 0.01,  // 1%
  confluenceToleranceBars: 3,

  coinalyzeApiKey: undefined,
  lunarcrushApiKey: undefined,
};

// ============ DATABASE TYPES ============

export interface MacroSignalRecord {
  id: string;
  timestamp: Date;
  bias: MacroBias;
  biasStrength: BiasStrength;
  action: MacroAction;
  suggestedLeverage: number;
  maxLeverage: number;
  leverageReasoning: string;
  gannAngle: number;
  gannAngleName: string;
  nearestSupport: number;
  nearestResistance: number;
  activeCycles: TimeCycleWindow[];
  confluenceDetected: boolean;
  confluenceDetails: ConfluenceSignal | null;
  onchainMetrics: DerivativesMetrics;
  orderbookMetrics: OrderBookMetrics;
  sentimentMetrics: SentimentMetrics;
  confidence: number;
  regime: MarketRegime;
  summary: string;
}

export interface MacroPivotRecord {
  id: string;
  timestamp: Date;
  asset: string;
  pivotType: PivotType;
  price: number;
  timeframe: string;
  isMajor: boolean;
}

export interface MacroMetricsRecord {
  id: string;
  timestamp: Date;
  btcPrice: number;
  solPrice: number;
  exchangeNetFlow: number;
  whaleTxnsCount: number;
  liquidationsLong: number;
  liquidationsShort: number;
  openInterest: number;
  fundingRate: number;
  bidAskImbalance: number;
  depth1PctBids: number;
  depth1PctAsks: number;
  fearGreed: number;
  socialMentions: number;
  sentimentPolarity: number;
}
