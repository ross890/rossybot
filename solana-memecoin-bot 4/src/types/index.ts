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
  ALERT = 'ALERT',
  DISCOVERY = 'DISCOVERY',        // Metrics-based early signal (no KOL required)
  KOL_VALIDATION = 'KOL_VALIDATION' // Follow-up when KOL buys a discovered token
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

export interface KolMention {
  handle: string;
  tier?: 'S' | 'A' | 'B' | 'C';
  followers?: number;
}

export interface SocialMetrics {
  mentionVelocity1h: number;
  engagementQuality: number;
  accountAuthenticity: number;
  sentimentPolarity: number; // -1 to 1
  kolMentionDetected: boolean;
  kolMentions: KolMention[]; // KOL mentions with optional tier and follower data
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

  // DexScreener & CTO Info
  dexScreenerInfo?: DexScreenerTokenInfo;
  ctoAnalysis?: CTOAnalysis;

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
  learningMode: boolean;
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
  pairCreatedAt?: number; // Unix timestamp in milliseconds when the pair was created
  info?: {
    imageUrl?: string;
    header?: string;
    openGraph?: string;
    websites?: { label: string; url: string }[];
    socials?: { type: string; url: string }[];
  };
  boosts?: {
    active: number; // Number of active boosts
  };
}

// ============ DEXSCREENER INFO TYPES ============

export interface DexScreenerTokenInfo {
  tokenAddress: string;
  hasPaidDexscreener: boolean;
  boostCount: number;
  hasTokenProfile: boolean;
  hasTokenAds: boolean;
  socialLinks: {
    twitter?: string;
    telegram?: string;
    website?: string;
    discord?: string;
  };
  description?: string;
}

// ============ CTO (COMMUNITY TAKEOVER) TYPES ============

export interface CTOAnalysis {
  isCTO: boolean;
  ctoConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  ctoIndicators: string[];
  devAbandoned: boolean;
  devSoldPercent: number;
  communityDriven: boolean;
  authoritiesRevoked: boolean;
  hasCTOInName: boolean;
}

// ============ FEATURE 1 & 5: TOKEN SAFETY TYPES ============

export interface TokenSafetyResult {
  tokenAddress: string;
  mintAuthorityEnabled: boolean;
  freezeAuthorityEnabled: boolean;
  lpLocked: boolean;
  lpLockDuration: number | null;
  top10HolderConcentration: number;
  deployerHolding: number;
  tokenAgeMins: number;
  rugCheckScore: number | null;
  honeypotRisk: boolean;
  safetyScore: number;
  flags: string[];
  // Insider detection (Feature 5)
  insiderAnalysis: InsiderAnalysis;
}

export interface InsiderAnalysis {
  sameBlockBuyers: number;
  deployerFundedBuyers: number;
  suspiciousPatterns: string[];
  insiderRiskScore: number;
}

// ============ FEATURE 2: CONVICTION TRACKER TYPES ============

export interface KolBuyInfo {
  kolId: string;
  kolName: string;
  walletAddress: string;
  timestamp: number;
  solAmount?: number;
  txSignature?: string;
}

export interface ConvictionLevel {
  tokenAddress: string;
  level: number;
  buyers: KolBuyInfo[];
  isHighConviction: boolean;
  isUltraConviction: boolean;
}

// ============ FEATURE 3: KOL ACTIVITY TYPES ============

export enum TradeType {
  BUY = 'BUY',
  SELL = 'SELL'
}

export interface KolActivity {
  type: TradeType;
  kol: Kol;
  wallet: KolWallet;
  tokenAddress: string;
  tokenTicker?: string;
  solAmount: number;
  tokenAmount: number;
  percentSold?: number;
  isFullExit?: boolean;
  timestamp: Date;
  txSignature: string;
}

export interface AggregatedExitSignal {
  tokenAddress: string;
  tokenTicker: string;
  totalKolsExited: number;
  totalKolsHolding: number;
  exitedKols: string[];
  holdingKols: string[];
}

// ============ FEATURE 4: PUMP.FUN TYPES ============

export interface BondingCurveStatus {
  tokenMint: string;
  bondingProgress: number;
  currentMarketCap: number;
  targetMarketCap: number;
  estimatedTimeToMigration: number | null;
  isMigrated: boolean;
}

export interface PumpfunAlert {
  type: 'PROGRESS_85' | 'PROGRESS_90' | 'PROGRESS_95' | 'MIGRATION';
  token: BondingCurveStatus;
}

// ============ FEATURE 7: KOL ANALYTICS TYPES ============

export interface KolPerformanceStats {
  kolId: string;
  kolHandle: string;
  totalTrades: number;
  winRate: number;
  avgRoi: number;
  avgHoldTimeHours: number;
  bestTrade: {
    token: string;
    ticker: string;
    roi: number;
  } | null;
  worstTrade: {
    token: string;
    ticker: string;
    roi: number;
  } | null;
  last7DaysRoi: number;
  last7DaysTrades: number;
  last7DaysWins: number;
  consistencyScore: number;
}

// ============ FEATURE 8: DAILY DIGEST TYPES ============

export interface DailyDigest {
  date: Date;
  signalsSent: number;
  winners: number;
  losers: number;
  neutral: number;
  winRate: number;
  bestPerformer: {
    token: string;
    ticker: string;
    roi: number;
  } | null;
  worstPerformer: {
    token: string;
    ticker: string;
    roi: number;
  } | null;
  topKol: {
    handle: string;
    wins: number;
    total: number;
  } | null;
  simulatedPnl: {
    entrySol: number;
    currentSol: number;
    roi: number;
  };
  highConvictionTokens: Array<{
    tokenAddress: string;
    ticker: string;
    kolCount: number;
  }>;
}

// ============ MOONSHOT ASSESSMENT TYPES ============
// Based on patterns from memecoins that reached $5M+ MC within 2 weeks

export interface MoonshotAssessment {
  score: number; // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  factors: MoonshotFactors;
  matchedPatterns: string[];
  estimatedPotential: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface MoonshotFactors {
  // Early momentum (critical for moonshots)
  volumeVelocity: number;         // Volume growth rate in first hours
  holderGrowthRate: number;       // Holder acquisition speed

  // Token structure (successful tokens tend to have these)
  liquidityRatio: number;         // Liquidity as % of mcap (healthy = 5-15%)
  holderDistribution: number;     // How well distributed (lower top10 = better)

  // Narrative strength
  narrativeScore: number;         // Theme alignment with current meta
  memeticPotential: number;       // Name/ticker viral potential

  // Safety baseline
  contractSafety: number;         // Renounced, no honeypot, etc.

  // Timing
  ageOptimality: number;          // Sweet spot is 30min - 4hrs old
}

// ============ DISCOVERY SIGNAL TYPES ============

export interface DiscoverySignal {
  id: string;
  tokenAddress: string;
  tokenTicker: string;
  tokenName: string;

  // Core metrics
  score: TokenScore;
  tokenMetrics: TokenMetrics;
  volumeAuthenticity: VolumeAuthenticityScore;
  scamFilter: ScamFilterOutput;
  safetyResult: TokenSafetyResult;
  socialMetrics: SocialMetrics;

  // Moonshot assessment
  moonshotAssessment: MoonshotAssessment;

  // NO KOL activity required
  kolActivity: KolWalletActivity | null;

  // DexScreener & CTO Info
  dexScreenerInfo?: DexScreenerTokenInfo;
  ctoAnalysis?: CTOAnalysis;

  // Suggested action (more conservative than BuySignal)
  suggestedPositionSize: number;  // Typically 50% of normal
  riskWarnings: string[];

  // Metadata
  generatedAt: Date;
  signalType: SignalType.DISCOVERY;

  // For tracking KOL follow-up
  discoveredAt: Date;
  kolValidatedAt: Date | null;
}
