// ===========================================
// SOLANA MEMECOIN BOT - TYPE DEFINITIONS
// ===========================================

// ============ ENUMS ============

export enum KolTier {
  TIER_1 = 'TIER_1',
  TIER_2 = 'TIER_2',
  TIER_3 = 'TIER_3'
}

export enum WalletType {
  MAIN = 'MAIN',
  SIDE = 'SIDE'
}

export enum AttributionConfidence {
  HIGH = 'HIGH',
  MEDIUM_HIGH = 'MEDIUM_HIGH',
  MEDIUM = 'MEDIUM',
  LOW_MEDIUM = 'LOW_MEDIUM',
  LOW = 'LOW'
}

export enum LinkMethod {
  DIRECT_KNOWN = 'DIRECT_KNOWN',
  FUNDING_CLUSTER = 'FUNDING_CLUSTER',
  BEHAVIOURAL_MATCH = 'BEHAVIOURAL_MATCH',
  TEMPORAL_CORRELATION = 'TEMPORAL_CORRELATION',
  CEX_WITHDRAWAL_PATTERN = 'CEX_WITHDRAWAL_PATTERN',
  SHARED_TOKEN_OVERLAP = 'SHARED_TOKEN_OVERLAP'
}

export enum ScamFilterResult {
  PASS = 'PASS',
  FLAG = 'FLAG',
  REJECT = 'REJECT'
}

export enum SignalType {
  BUY = 'BUY',
  WATCH = 'WATCH',
  ALERT = 'ALERT'
}

export enum RiskLevel {
  VERY_LOW = 1,
  LOW = 2,
  MEDIUM = 3,
  HIGH = 4,
  VERY_HIGH = 5
}

// ============ KOL TYPES ============

export interface Kol {
  id: string;
  handle: string;
  followerCount: number;
  tier: KolTier;
  createdAt: Date;
  updatedAt: Date;
}

export interface KolWallet {
  id: string;
  kolId: string;
  address: string;
  walletType: WalletType;
  attributionConfidence: AttributionConfidence;
  linkMethod: LinkMethod;
  notes: string | null;
  verified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface KolPerformance {
  kolId: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgRoi: number;
  medianRoi: number;
  lastCalculated: Date;
}

export interface KolTrade {
  id: string;
  kolId: string;
  walletId: string;
  tokenAddress: string;
  tokenTicker: string;
  entryPrice: number;
  exitPrice: number | null;
  entryTimestamp: Date;
  exitTimestamp: Date | null;
  roi: number | null;
  isWin: boolean | null;
  createdAt: Date;
}

export interface KolWalletActivity {
  kol: Kol;
  wallet: KolWallet;
  performance: KolPerformance;
  transaction: {
    signature: string;
    solAmount: number;
    usdValue: number;
    tokensAcquired: number;
    supplyPercent: number;
    timestamp: Date;
  };
}

// ============ TOKEN TYPES ============

export interface TokenMetrics {
  address: string;
  ticker: string;
  name: string;
  price: number;
  marketCap: number;
  volume24h: number;
  volumeMarketCapRatio: number;
  holderCount: number;
  holderChange1h: number;
  top10Concentration: number;
  liquidityPool: number;
  tokenAge: number; // in minutes
  lpLocked: boolean;
  lpLockDuration: number | null;
}

export interface TokenContractAnalysis {
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  metadataMutable: boolean;
  isKnownScamTemplate: boolean;
}

export interface BundleAnalysis {
  bundleDetected: boolean;
  bundledSupplyPercent: number;
  clusteredWalletCount: number;
  fundingOverlapDetected: boolean;
  hasRugHistory: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface DevWalletBehaviour {
  deployerAddress: string;
  soldPercent48h: number;
  transferredToCex: boolean;
  cexAddresses: string[];
  bridgeActivity: boolean;
}

export interface ScamFilterOutput {
  result: ScamFilterResult;
  flags: string[];
  contractAnalysis: TokenContractAnalysis;
  bundleAnalysis: BundleAnalysis;
  devBehaviour: DevWalletBehaviour | null;
  rugHistoryWallets: number;
}

// ============ SOCIAL TYPES ============

export interface SocialMetrics {
  mentionVelocity1h: number;
  engagementQuality: number;
  accountAuthenticity: number;
  sentimentPolarity: number; // -1 to 1
  kolMentionDetected: boolean;
  kolMentions: string[]; // KOL handles
  narrativeFit: string | null;
}

export interface VolumeAuthenticityScore {
  score: number; // 0-100
  uniqueWalletRatio: number;
  sizeDistributionScore: number;
  temporalPatternScore: number;
  isWashTradingSuspected: boolean;
}

// ============ SCORING TYPES ============

export interface ScoreFactors {
  onChainHealth: number; // 0-100
  socialMomentum: number; // 0-100
  kolConvictionMain: number; // 0-100
  kolConvictionSide: number; // 0-100
  scamRiskInverse: number; // 0-100
  narrativeBonus: number; // 0-30
  timingBonus: number; // 0-20
}

export interface TokenScore {
  tokenAddress: string;
  compositeScore: number;
  factors: ScoreFactors;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  confidenceBand: number; // ±points
  flags: string[];
  riskLevel: RiskLevel;
}

// ============ SIGNAL TYPES ============

export interface BuySignal {
  id: string;
  tokenAddress: string;
  tokenTicker: string;
  tokenName: string;
  
  // Metrics
  score: TokenScore;
  tokenMetrics: TokenMetrics;
  socialMetrics: SocialMetrics;
  volumeAuthenticity: VolumeAuthenticityScore;
  scamFilter: ScamFilterOutput;
  
  // KOL Activity (REQUIRED)
  kolActivity: KolWalletActivity;
  
  // Suggested Action
  entryZone: {
    low: number;
    high: number;
  };
  positionSizePercent: number;
  stopLoss: {
    price: number;
    percent: number;
  };
  takeProfit1: {
    price: number;
    percent: number;
  };
  takeProfit2: {
    price: number;
    percent: number;
  };
  timeLimitHours: number;
  
  // Metadata
  generatedAt: Date;
  signalType: SignalType;
}

// ============ POSITION TYPES ============

export interface Position {
  id: string;
  tokenAddress: string;
  tokenTicker: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  entryTimestamp: Date;
  signalId: string;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit1Hit: boolean;
  takeProfit2Hit: boolean;
  trailingStopActive: boolean;
  trailingStopPrice: number | null;
  status: 'OPEN' | 'CLOSED';
  closedAt: Date | null;
  closeReason: string | null;
  realizedPnl: number | null;
}

// ============ CONFIG TYPES ============

export interface TradingConfig {
  maxMemecoinPortfolioPercent: number;
  defaultPositionSizePercent: number;
  maxSignalsPerHour: number;
  maxSignalsPerDay: number;
  minScoreBuySignal: number;
  minScoreWatchSignal: number;
}

export interface ScreeningConfig {
  minMarketCap: number;
  maxMarketCap: number;
  min24hVolume: number;
  minVolumeMarketCapRatio: number;
  minHolderCount: number;
  maxTop10Concentration: number;
  minLiquidityPool: number;
  minTokenAgeMinutes: number;
}

export interface AppConfig {
  trading: TradingConfig;
  screening: ScreeningConfig;
  databaseUrl: string;
  redisUrl: string;
  heliusApiKey: string;
  heliusRpcUrl: string;
  birdeyeApiKey: string;
  twitterBearerToken: string;
  twitterConsumerKey: string;
  twitterConsumerSecret: string;
  telegramBotToken: string;
  telegramChatId: string;
  nodeEnv: string;
  logLevel: string;
}

// ============ API RESPONSE TYPES ============

export interface HeliusTokenData {
  mint: string;
  onChainMetadata: {
    metadata: {
      name: string;
      symbol: string;
    };
  };
  offChainMetadata?: {
    description?: string;
  };
}

export interface BirdeyeTokenOverview {
  address: string;
  symbol: string;
  name: string;
  price: number;
  mc: number;
  v24h: number;
  holder: number;
  liquidity: number;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd: string;
  volume: {
    h24: number;
  };
  liquidity: {
    usd: number;
  };
  fdv: number;
}
