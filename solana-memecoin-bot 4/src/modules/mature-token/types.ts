// ===========================================
// MATURE TOKEN SIGNAL MODULE - TYPE DEFINITIONS
// For tokens that have been live 24+ hours
// ===========================================

// ============ ENUMS ============

export enum MatureSignalType {
  ACCUMULATION_BREAKOUT = 'ACCUMULATION_BREAKOUT',
  SMART_MONEY_ACCUMULATION = 'SMART_ACCUMULATION',
  KOL_REENTRY = 'KOL_REENTRY',
  KOL_FIRST_BUY = 'KOL_FIRST_BUY',
  MULTI_KOL_CONVICTION = 'MULTI_KOL_CONVICTION',
  VOLUME_BREAKOUT = 'VOLUME_BREAKOUT',
  HOLDER_SURGE = 'HOLDER_SURGE',
  NARRATIVE_CATALYST = 'NARRATIVE_CATALYST',
}

export enum AccumulationPattern {
  WYCKOFF_SPRING = 'WYCKOFF_SPRING',
  RANGE_BREAK = 'RANGE_BREAK',
  ASCENDING_TRIANGLE = 'ASCENDING_TRIANGLE',
  DOUBLE_BOTTOM = 'DOUBLE_BOTTOM',
  CONSOLIDATION = 'CONSOLIDATION',
  NONE = 'NONE',
}

export enum VolumeTrend {
  INCREASING = 'INCREASING',
  STABLE = 'STABLE',
  DECLINING = 'DECLINING',
}

export enum ExitRecommendation {
  FULL_EXIT = 'FULL_EXIT',
  PARTIAL_EXIT_75 = 'PARTIAL_EXIT_75',
  PARTIAL_EXIT_50 = 'PARTIAL_EXIT_50',
  PARTIAL_EXIT_25 = 'PARTIAL_EXIT_25',
  MOVE_STOP = 'MOVE_STOP',
  HOLD = 'HOLD',
}

// ============ ELIGIBILITY ============

export interface MatureTokenEligibility {
  minTokenAgeHours: number;
  maxTokenAgeDays: number;
  minMarketCap: number;
  maxMarketCap: number;
  minLiquidity: number;
  minLiquidityRatio: number;
  min24hVolume: number;
  minVolumeMarketCapRatio: number;
  minHolderCount: number;
  maxTop10Concentration: number;
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  lpLocked: boolean;
}

// ============ ACCUMULATION METRICS ============

export interface AccumulationMetrics {
  // Price Action (Wyckoff-style)
  priceRange24h: number;
  priceRangePercentile: number;
  lowerHighsCount: number;
  higherLowsCount: number;

  // Volume Analysis
  volumeDecline7d: number;
  volumeSpikesInRange: number;
  buyVolumeRatio: number;

  // Wallet Dynamics
  newHolders24h: number;
  holderRetentionRate: number;
  avgPositionSize: number;
  largeWalletAccumulation: number;

  // Time in Range
  consolidationDays: number;
  distanceFromATH: number;
  distanceFromATL: number;

  // Pattern detection
  pattern: AccumulationPattern;
  patternConfidence: number;

  // Scores
  accumulationScore: number;
}

// ============ BREAKOUT METRICS ============

export interface BreakoutMetrics {
  // Technical Patterns
  volumeExpansion: number;
  priceVelocity5m: number;
  resistanceTests: number;
  supportBounces: number;

  // Momentum Indicators
  rsi14: number;
  macdCrossover: boolean;
  ema9CrossEma21: boolean;
  volumeOBV: number;

  // Order Flow
  bidAskRatio: number;
  largeOrderFlow: number;
  marketOrderRatio: number;

  // Social Catalyst
  socialVelocity3h: number;
  narrativeStrength: number;
  kolMentions24h: number;

  // Scores
  breakoutScore: number;
  breakoutProbability: number;
}

// ============ HOLDER DYNAMICS ============

export interface HolderDynamicsMetrics {
  // Growth Metrics
  holderGrowth24h: number;
  holderGrowth7d: number;
  uniqueBuyers24h: number;
  uniqueSellers24h: number;
  buyerSellerRatio: number;

  // Distribution Quality
  giniCoefficient: number;
  medianHolding: number;
  top10Change7d: number;
  freshWalletRatio: number;

  // Retention Metrics
  diamondHandsRatio: number;
  paperHandsExitRate: number;
  avgHoldTime: number;

  // Wallet Quality
  qualityWalletRatio: number;
  smartMoneyHolders: number;
  institutionalWallets: number;

  // Score
  holderDynamicsScore: number;
}

// ============ SMART MONEY METRICS ============

export interface SmartMoneyMetrics {
  // Accumulation Signals
  smartMoneyInflow24h: number;
  whaleAccumulation: number;
  avgWhaleBuySize: number;
  whaleBuySellRatio: number;

  // Wallet Profiling
  profitableWalletRatio: number;
  avgWalletWinRate: number;
  topTraderHoldings: number;

  // Movement Patterns
  exchangeNetFlow: number;
  dexLiquidityAdds: number;
  stakingIncrease: number;

  // Cross-Chain Signals
  bridgeInflows: number;
  multiChainInterest: boolean;

  // Score
  smartMoneyScore: number;
}

// ============ KOL REENTRY METRICS ============

export interface KolReentryMetrics {
  // Activity Detection
  kolBuys24h: number;
  kolBuys7d: number;
  kolTotalHolding: number;
  kolHoldingChange: number;

  // KOL Quality
  tier1KolCount: number;
  tier2KolCount: number;
  tier3KolCount: number;
  avgKolWinRate: number;
  kolConvictionScore: number;

  // Timing Analysis
  kolEntryTiming: 'EARLY' | 'MIDDLE' | 'LATE';
  kolAvgEntryPrice: number;
  currentVsKolEntry: number;

  // Social Amplification
  kolMentions24h: number;
  kolSentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  kolEngagementRate: number;

  // Score
  kolActivityScore: number;
}

// ============ VOLUME PROFILE ============

export interface VolumeProfileMetrics {
  // Volume Patterns
  volumeTrend7d: VolumeTrend;
  volumeSpikes24h: number;
  avgSpikeMultiplier: number;
  volumeAtKeyLevels: number;

  // Trade Analysis
  avgTradeSize: number;
  medianTradeSize: number;
  largeTradeRatio: number;
  microTradeRatio: number;

  // Authenticity Score
  organicVolumeRatio: number;
  washTradingScore: number;
  botActivityScore: number;

  // Time Distribution
  volumeByHour: number[];
  peakTradingHours: number[];
  volumeConsistency: number;

  // Score
  volumeAuthenticityScore: number;
}

// ============ COMPOSITE SCORING ============

export interface MatureTokenScore {
  // Core Metrics (60% weight)
  accumulationScore: number;
  breakoutScore: number;
  holderDynamicsScore: number;
  volumeAuthenticityScore: number;

  // Catalyst Metrics (25% weight)
  smartMoneyScore: number;
  kolActivityScore: number;
  narrativeMomentumScore: number;

  // Safety Metrics (15% weight)
  contractSafetyScore: number;
  bundleRiskScore: number;

  // Final Composite
  compositeScore: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendation: 'STRONG_BUY' | 'BUY' | 'WATCH' | 'AVOID';

  // Flags
  bullishSignals: string[];
  bearishSignals: string[];
  warnings: string[];
}

// ============ SIGNAL TYPES ============

export interface MatureTokenSignal {
  id: string;
  tokenAddress: string;
  tokenTicker: string;
  tokenName: string;

  // Signal metadata
  signalType: MatureSignalType;
  score: MatureTokenScore;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  riskLevel: number; // 1-5

  // Token age info
  tokenAgeHours: number;
  tokenAgeDays: number;

  // Metrics
  accumulationMetrics: AccumulationMetrics;
  breakoutMetrics: BreakoutMetrics;
  holderDynamics: HolderDynamicsMetrics;
  smartMoneyMetrics: SmartMoneyMetrics;
  kolReentryMetrics: KolReentryMetrics;
  volumeProfile: VolumeProfileMetrics;

  // Market data
  currentPrice: number;
  marketCap: number;
  volume24h: number;
  liquidity: number;
  holderCount: number;
  top10Concentration: number;

  // Trade setup
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
  takeProfit3: {
    price: number;
    percent: number;
  };
  maxHoldDays: number;

  // Metadata
  generatedAt: Date;
  expiresAt: Date;
}

// ============ EXIT SIGNAL ============

export interface MatureTokenExitSignal {
  id: string;
  tokenAddress: string;
  tokenTicker: string;

  // Exit details
  recommendation: ExitRecommendation;
  urgency: 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
  triggers: string[];

  // Position status
  entryPrice: number;
  currentPrice: number;
  pnlPercent: number;
  pnlUsd: number;
  holdTimeHours: number;

  // Original signal reference
  originalSignalId: string;
  originalSignalType: MatureSignalType;

  // Metadata
  generatedAt: Date;
}

// ============ WATCHLIST ============

export interface MatureTokenWatchlist {
  id: string;
  tokenAddress: string;
  tokenTicker: string;

  // Watch reason
  addedReason: string;
  currentScore: number;
  targetScore: number;
  targetConditions: string[];

  // Key levels
  resistanceLevel: number;
  supportLevel: number;
  breakoutTarget: number;
  volumeTrigger: number;

  // Status
  addedAt: Date;
  expiresAt: Date;
  lastCheckedAt: Date;
}

// ============ CONFIGURATION ============

export interface MatureTokenConfig {
  // Scanning
  scanIntervalMinutes: number;
  maxTokensPerScan: number;

  // Filtering
  tokenAgeRange: {
    minHours: number;
    maxDays: number;
  };

  // Rate Limits
  rateLimits: {
    maxSignalsPerHour: number;
    maxSignalsPerDay: number;
    tokenCooldownHours: number;
  };

  // Scoring Thresholds
  thresholds: {
    strongBuy: number;
    buy: number;
    watch: number;
  };

  // Risk Management
  riskLimits: {
    maxPortfolioAllocation: number;
    maxSinglePosition: number;
    maxOpenPositions: number;
  };

  // Features
  features: {
    enableKolTracking: boolean;
    enableSmartMoneyTracking: boolean;
    enableSocialAnalysis: boolean;
    enableWatchlist: boolean;
    enableAutoExitSignals: boolean;
  };
}

// ============ THRESHOLDS ============

export const ACCUMULATION_THRESHOLDS = {
  priceRange24h: { max: 20 },
  volumeDecline7d: { min: 30 },
  buyVolumeRatio: { min: 1.2 },
  newHolders24h: { min: 50 },
  holderRetentionRate: { min: 0.70 },
  largeWalletAccumulation: { min: 3 },
  consolidationDays: { min: 2, max: 7 },
  distanceFromATH: { min: 40, max: 80 },
} as const;

export const BREAKOUT_THRESHOLDS = {
  volumeExpansion: { min: 2.0 },
  resistanceTests: { min: 2 },
  rsi14: { min: 45, max: 70 },
  bidAskRatio: { min: 1.3 },
  socialVelocity3h: { min: 1.5 },
  kolMentions24h: { min: 1 },
} as const;

export const HOLDER_THRESHOLDS = {
  holderGrowth24h: { min: 5 },
  buyerSellerRatio: { min: 1.5 },
  giniCoefficient: { max: 0.75 },
  diamondHandsRatio: { min: 0.30 },
  qualityWalletRatio: { min: 0.60 },
  smartMoneyHolders: { min: 5 },
} as const;

export const SMART_MONEY_THRESHOLDS = {
  smartMoneyInflow24h: { min: 10_000 },
  whaleAccumulation: { min: 2 },
  whaleBuySellRatio: { min: 2.0 },
  profitableWalletRatio: { min: 0.40 },
  exchangeNetFlow: { max: 0 },
} as const;

export const KOL_REENTRY_THRESHOLDS = {
  kolBuys24h: { min: 1 },
  tier1KolCount: { min: 1 },
  avgKolWinRate: { min: 0.55 },
  kolConvictionScore: { min: 50 },
  currentVsKolEntry: { max: 1.2 },
} as const;

export const VOLUME_THRESHOLDS = {
  volumeTrend7d: { target: 'INCREASING' as VolumeTrend },
  organicVolumeRatio: { min: 0.50 },
  washTradingScore: { max: 30 },
  botActivityScore: { max: 50 },
  volumeConsistency: { min: 0.40 },
} as const;

export const SIGNAL_THRESHOLDS = {
  STRONG_BUY: {
    compositeScore: 75,
    minAccumulation: 60,
    minBreakout: 50,
    minSafety: 70,
  },
  BUY: {
    compositeScore: 60,
    minAccumulation: 45,
    minBreakout: 40,
    minSafety: 60,
  },
  WATCH: {
    compositeScore: 45,
    minAccumulation: 30,
    minBreakout: 30,
    minSafety: 50,
  },
} as const;

export const SCORING_WEIGHTS = {
  accumulationScore: 0.20,
  breakoutScore: 0.15,
  holderDynamicsScore: 0.15,
  volumeAuthenticityScore: 0.10,
  smartMoneyScore: 0.10,
  kolActivityScore: 0.10,
  narrativeMomentumScore: 0.05,
  contractSafetyScore: 0.10,
  bundleRiskScore: 0.05,
} as const;

export const SCORE_MULTIPLIERS = {
  singleKolBuy: 1.10,
  multiKolBuy: 1.25,
  tier1KolBuy: 1.15,
  whaleAccumulation: 1.12,
  smartMoneyInflow: 1.08,
  strongAccumulation: 1.15,
  breakoutConfirmed: 1.20,
  trendingNarrative: 1.10,
  viralMoment: 1.25,
  highBotActivity: 0.85,
  concentratedHolders: 0.90,
  lowLiquidity: 0.80,
} as const;

// ============ DEFAULT CONFIG ============

export const DEFAULT_MATURE_TOKEN_CONFIG: MatureTokenConfig = {
  scanIntervalMinutes: 5,
  maxTokensPerScan: 100,

  tokenAgeRange: {
    minHours: 24,
    maxDays: 14,
  },

  rateLimits: {
    maxSignalsPerHour: 3,
    maxSignalsPerDay: 10,
    tokenCooldownHours: 12,
  },

  thresholds: {
    strongBuy: 75,
    buy: 60,
    watch: 45,
  },

  riskLimits: {
    maxPortfolioAllocation: 0.20,
    maxSinglePosition: 0.05,
    maxOpenPositions: 5,
  },

  features: {
    enableKolTracking: true,
    enableSmartMoneyTracking: true,
    enableSocialAnalysis: true,
    enableWatchlist: true,
    enableAutoExitSignals: true,
  },
};

// ============ ELIGIBILITY DEFAULTS ============

export const DEFAULT_ELIGIBILITY: MatureTokenEligibility = {
  minTokenAgeHours: 24,
  maxTokenAgeDays: 14,
  minMarketCap: 100_000,
  maxMarketCap: 50_000_000,
  minLiquidity: 50_000,
  minLiquidityRatio: 0.05,
  min24hVolume: 50_000,
  minVolumeMarketCapRatio: 0.10,
  minHolderCount: 200,
  maxTop10Concentration: 50,
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  lpLocked: true,
};
