# Mature Token Signal Module Proposal

## Overview

A new signal module for RossyBot targeting **tokens that have been live for 24+ hours** - the "survivors" that have passed the initial kill zone where 98% of memecoins fail. This module focuses on identifying accumulation patterns, breakout potential, and renewed momentum in established tokens.

---

## Rationale

### Why 24+ Hour Tokens?

| Metric | New Tokens (<4hrs) | Mature Tokens (24hrs+) |
|--------|-------------------|------------------------|
| Survival Rate | ~2% | 100% (already survived) |
| Rug Risk | Extremely High | Significantly Lower |
| Data Availability | Limited | Rich historical data |
| Pattern Recognition | Difficult | Clear trends visible |
| Smart Money Signals | Noisy | Clear accumulation patterns |
| Average Hold Time | Minutes | Hours to days |

**Key Insight**: Only 2% of tokens survive past 24 hours. These survivors have:
- Proven they're not immediate rugs
- Established holder bases
- Historical volume/price data for analysis
- Clear support/resistance levels
- Identifiable accumulation phases

---

## Module Architecture

### File Structure

```
src/modules/mature-token/
├── mature-token-scanner.ts       # Main scanner orchestrator
├── accumulation-detector.ts      # Detects accumulation patterns
├── breakout-analyzer.ts          # Identifies breakout potential
├── holder-dynamics.ts            # Tracks holder growth/retention
├── volume-profile-analyzer.ts    # Volume pattern analysis
├── smart-money-tracker.ts        # Whale/smart wallet tracking
├── kol-reentry-detector.ts       # Detects KOLs returning to tokens
├── narrative-momentum.ts         # Social/narrative trend detection
├── mature-token-scorer.ts        # Composite scoring engine
└── types.ts                      # Type definitions
```

---

## Core Metrics & Thresholds

### 1. Token Eligibility Criteria

```typescript
interface MatureTokenEligibility {
  // Age Requirements
  minTokenAgeHours: 24;           // Minimum 24 hours old
  maxTokenAgeDays: 14;            // Maximum 14 days (still "fresh" enough)

  // Market Structure
  minMarketCap: 100_000;          // $100K minimum (survived initial phase)
  maxMarketCap: 50_000_000;       // $50M maximum (room for growth)
  minLiquidity: 50_000;           // $50K minimum liquidity
  minLiquidityRatio: 0.05;        // 5% liquidity/mcap ratio

  // Volume Requirements
  min24hVolume: 50_000;           // $50K daily volume (active trading)
  minVolumeMarketCapRatio: 0.10;  // 10% volume/mcap ratio

  // Holder Requirements
  minHolderCount: 200;            // At least 200 holders
  maxTop10Concentration: 50;      // Top 10 wallets < 50%

  // Safety
  mintAuthorityDisabled: true;    // Must be disabled
  freezeAuthorityDisabled: true;  // Must be disabled
  lpLocked: true;                 // LP must be locked
}
```

### 2. Accumulation Detection Metrics

Detects when smart money is quietly accumulating before a move.

```typescript
interface AccumulationMetrics {
  // Price Action (Wyckoff-style analysis)
  priceRange24h: number;           // Tight range = accumulation
  priceRangePercentile: number;    // vs historical volatility
  lowerHighsCount: number;         // Descending tops (compression)
  higherLowsCount: number;         // Ascending bottoms (support)

  // Volume Analysis
  volumeDecline7d: number;         // Declining volume during range
  volumeSpikesInRange: number;     // Absorption spikes
  buyVolumeRatio: number;          // Buy vs sell volume

  // Wallet Dynamics
  newHolders24h: number;           // New unique holders
  holderRetentionRate: number;     // % holding > 24hrs
  avgPositionSize: number;         // Average buy size trending up
  largeWalletAccumulation: number; // Whales adding positions

  // Time in Range
  consolidationDays: number;       // Days in current range
  distanceFromATH: number;         // % below all-time high
  distanceFromATL: number;         // % above all-time low
}

// Thresholds
const ACCUMULATION_THRESHOLDS = {
  priceRange24h: { max: 20 },              // <20% daily range
  volumeDecline7d: { min: 30 },            // >30% volume decline
  buyVolumeRatio: { min: 1.2 },            // 20% more buying
  newHolders24h: { min: 50 },              // At least 50 new holders
  holderRetentionRate: { min: 0.70 },      // 70% retention
  largeWalletAccumulation: { min: 3 },     // 3+ whales adding
  consolidationDays: { min: 2, max: 7 },   // 2-7 days ideal
  distanceFromATH: { min: 40, max: 80 },   // 40-80% below ATH
};
```

### 3. Breakout Potential Metrics

Identifies tokens ready to break out of consolidation.

```typescript
interface BreakoutMetrics {
  // Technical Patterns
  volumeExpansion: number;         // Volume spike vs 7d average
  priceVelocity5m: number;         // Rate of price change
  resistanceTests: number;         // Times tested resistance
  supportBounces: number;          // Times bounced off support

  // Momentum Indicators
  rsi14: number;                   // Relative Strength Index
  macdCrossover: boolean;          // MACD signal crossover
  ema9CrossEma21: boolean;         // Short/long EMA cross
  volumeOBV: number;               // On-Balance Volume trend

  // Order Flow
  bidAskRatio: number;             // Bid vs ask pressure
  largeOrderFlow: number;          // Large buy orders incoming
  marketOrderRatio: number;        // Market vs limit orders

  // Social Catalyst
  socialVelocity3h: number;        // Social mentions acceleration
  narrativeStrength: number;       // Narrative fit score
  kolMentions24h: number;          // KOL mentions in last 24h
}

// Thresholds
const BREAKOUT_THRESHOLDS = {
  volumeExpansion: { min: 2.0 },           // 2x volume spike
  resistanceTests: { min: 2 },              // At least 2 tests
  rsi14: { min: 45, max: 70 },              // Not overbought
  bidAskRatio: { min: 1.3 },                // Strong bid pressure
  socialVelocity3h: { min: 1.5 },           // 50% increase
  kolMentions24h: { min: 1 },               // At least 1 KOL mention
};
```

### 4. Holder Dynamics Metrics

Analyzes holder behavior for health signals.

```typescript
interface HolderDynamicsMetrics {
  // Growth Metrics
  holderGrowth24h: number;         // % holder growth
  holderGrowth7d: number;          // Weekly growth rate
  uniqueBuyers24h: number;         // Unique buying wallets
  uniqueSellers24h: number;        // Unique selling wallets
  buyerSellerRatio: number;        // Buyers / Sellers

  // Distribution Quality
  giniCoefficient: number;         // Wealth distribution (0-1)
  medianHolding: number;           // Median position size
  top10Change7d: number;           // Top 10 concentration change
  freshWalletRatio: number;        // % of new wallets (bot indicator)

  // Retention Metrics
  diamondHandsRatio: number;       // % holding > 7 days
  paperHandsExitRate: number;      // Short-term seller exit rate
  avgHoldTime: number;             // Average holding duration

  // Wallet Quality
  qualityWalletRatio: number;      // % wallets with history
  smartMoneyHolders: number;       // Known profitable wallets
  institutionalWallets: number;    // Large, stable holders
}

// Thresholds
const HOLDER_THRESHOLDS = {
  holderGrowth24h: { min: 5 },              // 5% daily growth
  buyerSellerRatio: { min: 1.5 },           // 50% more buyers
  giniCoefficient: { max: 0.75 },           // Not too concentrated
  diamondHandsRatio: { min: 0.30 },         // 30% long-term holders
  qualityWalletRatio: { min: 0.60 },        // 60% quality wallets
  smartMoneyHolders: { min: 5 },            // 5+ smart money holders
};
```

### 5. Smart Money Tracking Metrics

Tracks whale and smart wallet behavior.

```typescript
interface SmartMoneyMetrics {
  // Accumulation Signals
  smartMoneyInflow24h: number;     // $ inflow from smart wallets
  whaleAccumulation: number;       // # of whales accumulating
  avgWhaleBuySize: number;         // Average whale purchase
  whaleBuySellRatio: number;       // Whale buy/sell activity

  // Wallet Profiling
  profitableWalletRatio: number;   // % of holders in profit
  avgWalletWinRate: number;        // Avg win rate of holders
  topTraderHoldings: number;       // Holdings by top performers

  // Movement Patterns
  exchangeNetFlow: number;         // CEX in/out flow
  dexLiquidityAdds: number;        // LP additions
  stakingIncrease: number;         // Staked token increase

  // Cross-Chain Signals
  bridgeInflows: number;           // Cross-chain buys
  multiChainInterest: boolean;     // Activity on other chains
}

// Thresholds
const SMART_MONEY_THRESHOLDS = {
  smartMoneyInflow24h: { min: 10_000 },    // $10K smart money
  whaleAccumulation: { min: 2 },            // 2+ whales buying
  whaleBuySellRatio: { min: 2.0 },          // 2:1 buy ratio
  profitableWalletRatio: { min: 0.40 },     // 40% in profit
  exchangeNetFlow: { max: 0 },              // Net outflow (bullish)
};
```

### 6. KOL Re-entry Detection

Detects when KOLs are returning to or newly entering a mature token.

```typescript
interface KolReentryMetrics {
  // Activity Detection
  kolBuys24h: number;              // KOL purchases in 24h
  kolBuys7d: number;               // KOL purchases in 7d
  kolTotalHolding: number;         // Total KOL holdings
  kolHoldingChange: number;        // Change in KOL holdings

  // KOL Quality
  tier1KolCount: number;           // Tier 1 KOLs holding
  tier2KolCount: number;           // Tier 2 KOLs holding
  avgKolWinRate: number;           // Avg win rate of KOLs
  kolConvictionScore: number;      // Multi-KOL conviction

  // Timing Analysis
  kolEntryTiming: string;          // EARLY | MIDDLE | LATE
  kolAvgEntryPrice: number;        // Avg KOL entry price
  currentVsKolEntry: number;       // Current price vs KOL avg

  // Social Amplification
  kolMentions24h: number;          // Public KOL mentions
  kolSentiment: string;            // BULLISH | NEUTRAL | BEARISH
  kolEngagementRate: number;       // Engagement on mentions
}

// Thresholds
const KOL_REENTRY_THRESHOLDS = {
  kolBuys24h: { min: 1 },                   // At least 1 KOL buy
  tier1KolCount: { min: 1 },                // At least 1 tier 1
  avgKolWinRate: { min: 0.55 },             // 55% win rate
  kolConvictionScore: { min: 50 },          // Conviction score
  currentVsKolEntry: { max: 1.2 },          // Within 20% of KOL entry
};
```

### 7. Volume Profile Analysis

Deep volume pattern analysis for mature tokens.

```typescript
interface VolumeProfileMetrics {
  // Volume Patterns
  volumeTrend7d: 'INCREASING' | 'STABLE' | 'DECLINING';
  volumeSpikes24h: number;         // Number of volume spikes
  avgSpikeMultiplier: number;      // Average spike size
  volumeAtKeyLevels: number;       // Volume at support/resistance

  // Trade Analysis
  avgTradeSize: number;            // Average trade size
  medianTradeSize: number;         // Median trade size
  largeTradeRatio: number;         // % of large trades
  microTradeRatio: number;         // % of micro trades (bots)

  // Authenticity Score
  organicVolumeRatio: number;      // Estimated organic %
  washTradingScore: number;        // Wash trading detection
  botActivityScore: number;        // Bot activity level

  // Time Distribution
  volumeByHour: number[];          // Hourly distribution
  peakTradingHours: number[];      // Most active hours
  volumeConsistency: number;       // Consistency score
}

// Thresholds
const VOLUME_THRESHOLDS = {
  volumeTrend7d: { target: 'INCREASING' },
  organicVolumeRatio: { min: 0.50 },        // 50% organic
  washTradingScore: { max: 30 },            // Low wash trading
  botActivityScore: { max: 50 },            // Moderate bot activity
  volumeConsistency: { min: 0.40 },         // Consistent volume
};
```

---

## Composite Scoring Engine

### Score Components (0-100 each)

```typescript
interface MatureTokenScore {
  // Core Metrics (60% weight)
  accumulationScore: number;       // 20% - Accumulation patterns
  breakoutScore: number;           // 15% - Breakout potential
  holderDynamicsScore: number;     // 15% - Holder health
  volumeAuthenticityScore: number; // 10% - Volume quality

  // Catalyst Metrics (25% weight)
  smartMoneyScore: number;         // 10% - Smart money activity
  kolActivityScore: number;        // 10% - KOL interest
  narrativeMomentumScore: number;  // 5%  - Social momentum

  // Safety Metrics (15% weight)
  contractSafetyScore: number;     // 10% - Contract safety
  bundleRiskScore: number;         // 5%  - Insider risk inverse

  // Final Composite
  compositeScore: number;          // Weighted average
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendation: 'STRONG_BUY' | 'BUY' | 'WATCH' | 'AVOID';
}

// Scoring Weights
const SCORING_WEIGHTS = {
  accumulationScore: 0.20,
  breakoutScore: 0.15,
  holderDynamicsScore: 0.15,
  volumeAuthenticityScore: 0.10,
  smartMoneyScore: 0.10,
  kolActivityScore: 0.10,
  narrativeMomentumScore: 0.05,
  contractSafetyScore: 0.10,
  bundleRiskScore: 0.05,
};
```

### Signal Thresholds

```typescript
const SIGNAL_THRESHOLDS = {
  STRONG_BUY: {
    compositeScore: 75,
    minAccumulation: 60,
    minBreakout: 50,
    minSafety: 70,
    confidence: 'HIGH',
  },
  BUY: {
    compositeScore: 60,
    minAccumulation: 45,
    minBreakout: 40,
    minSafety: 60,
    confidence: 'MEDIUM',
  },
  WATCH: {
    compositeScore: 45,
    minAccumulation: 30,
    minBreakout: 30,
    minSafety: 50,
    confidence: 'LOW',
  },
  AVOID: {
    compositeScore: 0,  // Below WATCH thresholds
  },
};
```

### Multipliers

```typescript
const SCORE_MULTIPLIERS = {
  // KOL Conviction
  singleKolBuy: 1.10,              // +10%
  multiKolBuy: 1.25,               // +25% (2+ KOLs)
  tier1KolBuy: 1.15,               // +15% additional

  // Smart Money
  whaleAccumulation: 1.12,         // +12%
  smartMoneyInflow: 1.08,          // +8%

  // Pattern Strength
  strongAccumulation: 1.15,        // +15% (clear Wyckoff)
  breakoutConfirmed: 1.20,         // +20% (volume + price)

  // Narrative
  trendingNarrative: 1.10,         // +10%
  viralMoment: 1.25,               // +25%

  // Risk Reduction
  highBotActivity: 0.85,           // -15%
  concentratedHolders: 0.90,       // -10%
  lowLiquidity: 0.80,              // -20%
};
```

---

## Buy Signal Logic

### Entry Triggers

```typescript
interface BuyTrigger {
  // Primary Triggers (any one required)
  primaryTriggers: {
    accumulationBreakout: boolean;     // Breaking out of accumulation
    volumeBreakout: boolean;           // 3x volume spike
    kolEntry: boolean;                 // KOL buy detected
    smartMoneyEntry: boolean;          // Smart money inflow
    multiKolConviction: boolean;       // 2+ KOLs buying
  };

  // Confirmation Requirements (2+ required)
  confirmations: {
    holderGrowth: boolean;             // Positive holder growth
    buyPressure: boolean;              // Buy/sell ratio > 1.5
    volumeAuthenticity: boolean;       // Organic volume > 50%
    priceAboveSupport: boolean;        // Price above key support
    socialMomentum: boolean;           // Increasing social activity
  };

  // Safety Checks (all required)
  safetyChecks: {
    contractSafe: boolean;             // No dangerous authorities
    sufficientLiquidity: boolean;      // Adequate liquidity
    noRugSignals: boolean;             // No rug indicators
    notOverextended: boolean;          // RSI < 80
  };
}
```

### Signal Types

```typescript
enum MatureSignalType {
  // Accumulation Signals
  ACCUMULATION_BREAKOUT = 'ACCUMULATION_BREAKOUT',   // Breaking out of range
  SMART_MONEY_ACCUMULATION = 'SMART_ACCUMULATION',   // Whale accumulation

  // KOL Signals
  KOL_REENTRY = 'KOL_REENTRY',                       // KOL returning to token
  KOL_FIRST_BUY = 'KOL_FIRST_BUY',                   // KOL new entry
  MULTI_KOL_CONVICTION = 'MULTI_KOL_CONVICTION',     // Multiple KOLs

  // Momentum Signals
  VOLUME_BREAKOUT = 'VOLUME_BREAKOUT',               // Volume spike
  HOLDER_SURGE = 'HOLDER_SURGE',                     // Rapid holder growth

  // Narrative Signals
  NARRATIVE_CATALYST = 'NARRATIVE_CATALYST',         // Social trending
}
```

---

## Sell Signal Logic

### Exit Triggers

```typescript
interface SellTrigger {
  // Profit Taking
  profitTaking: {
    hitTP1: boolean;                   // Hit take profit 1 (50%)
    hitTP2: boolean;                   // Hit take profit 2 (100%)
    hitTP3: boolean;                   // Hit take profit 3 (200%)
  };

  // Risk Management
  stopLoss: {
    hitStopLoss: boolean;              // Hit stop loss (-25%)
    hitTrailingStop: boolean;          // Trailing stop triggered
    breakEvenStop: boolean;            // Break-even stop hit
  };

  // Warning Signals
  warningSignals: {
    kolExit: boolean;                  // KOL sold position
    multiKolExit: boolean;             // Multiple KOLs exiting
    whaleDistribution: boolean;        // Whales selling
    volumeCollapse: boolean;           // Volume dried up
    holderDecline: boolean;            // Holders decreasing
    narrativeDying: boolean;           // Social momentum dead
  };

  // Time-Based
  timeBasedExit: {
    maxHoldTime: boolean;              // Exceeded max hold (7d)
    stagnantPrice: boolean;            // No movement for 48h
  };
}
```

### Exit Recommendations

```typescript
enum ExitRecommendation {
  FULL_EXIT = 'FULL_EXIT',             // Sell 100%
  PARTIAL_EXIT_75 = 'PARTIAL_EXIT_75', // Sell 75%
  PARTIAL_EXIT_50 = 'PARTIAL_EXIT_50', // Sell 50%
  PARTIAL_EXIT_25 = 'PARTIAL_EXIT_25', // Sell 25%
  MOVE_STOP = 'MOVE_STOP',             // Tighten stop loss
  HOLD = 'HOLD',                       // Continue holding
}
```

---

## Position Sizing

### Risk-Based Allocation

```typescript
interface PositionSizing {
  // Base Allocation by Signal Strength
  baseAllocation: {
    STRONG_BUY: 0.03,      // 3% of portfolio
    BUY: 0.02,             // 2% of portfolio
    WATCH: 0.01,           // 1% of portfolio (monitoring only)
  };

  // Adjustments
  adjustments: {
    // Positive (increase size)
    multiKolConviction: 1.25,    // +25%
    strongAccumulation: 1.20,    // +20%
    tier1KolBuy: 1.15,           // +15%

    // Negative (decrease size)
    noKolActivity: 0.75,         // -25%
    moderateRisk: 0.80,          // -20%
    highVolatility: 0.85,        // -15%
  };

  // Limits
  limits: {
    maxSinglePosition: 0.05,     // 5% max per token
    maxMatureTokens: 0.20,       // 20% max in mature tokens
    minPosition: 0.005,          // 0.5% minimum
  };
}
```

### Entry Strategy

```typescript
interface EntryStrategy {
  // Scaling In
  scalingStrategy: {
    initialEntry: 0.50,          // 50% of position
    confirmationEntry: 0.30,     // 30% on confirmation
    breakoutEntry: 0.20,         // 20% on breakout
  };

  // Entry Zones
  entryZones: {
    optimal: 'SUPPORT_LEVEL',    // Near support
    acceptable: 'RANGE_MIDDLE',  // Mid-range
    avoid: 'RESISTANCE_LEVEL',   // Near resistance
  };
}
```

---

## Telegram Signal Formatting

### Buy Signal Template

```
🔵 ROSSYBOT MATURE TOKEN SIGNAL

Token: $TICKER
Address: `{address}`
Chain: Solana

━━━━━━━━━━━━━━━━━━━━━━━━━

📊 SIGNAL OVERVIEW
├─ Signal Type: {ACCUMULATION_BREAKOUT | KOL_REENTRY | etc}
├─ Composite Score: {score}/100
├─ Confidence: {HIGH | MEDIUM | LOW}
├─ Risk Level: {1-5}/5
└─ Token Age: {X} days

━━━━━━━━━━━━━━━━━━━━━━━━━

📈 ACCUMULATION ANALYSIS
├─ Pattern: {WYCKOFF_SPRING | RANGE_BREAK | ASCENDING_TRIANGLE}
├─ Consolidation: {X} days
├─ Distance from ATH: -{X}%
├─ Volume Trend: {📈 INCREASING | ➡️ STABLE | 📉 DECLINING}
├─ Buy/Sell Ratio: {X}:1
└─ Accumulation Score: {score}/100

━━━━━━━━━━━━━━━━━━━━━━━━━

🧠 SMART MONEY ACTIVITY
├─ Whale Accumulation: {X} whales adding
├─ Smart Money Inflow: ${X} (24h)
├─ Smart Wallet Holdings: {X}%
├─ Exchange Net Flow: {📤 OUTFLOW | 📥 INFLOW}
└─ Smart Money Score: {score}/100

━━━━━━━━━━━━━━━━━━━━━━━━━

👑 KOL ACTIVITY
├─ Status: {🟢 ACTIVE | 🟡 WATCHING | ⚪ NONE}
├─ KOLs Holding: {X} ({tier breakdown})
├─ Recent Buys: {X} in 24h / {X} in 7d
├─ Avg Entry vs Current: {+/-X}%
├─ KOL Conviction: {HIGH | MEDIUM | LOW}
└─ KOL Score: {score}/100

━━━━━━━━━━━━━━━━━━━━━━━━━

👥 HOLDER DYNAMICS
├─ Total Holders: {X} ({+X}% 24h)
├─ Buyer/Seller Ratio: {X}:1 (24h)
├─ Diamond Hands: {X}% (>7d holders)
├─ Top 10 Concentration: {X}%
├─ Quality Wallets: {X}%
└─ Holder Score: {score}/100

━━━━━━━━━━━━━━━━━━━━━━━━━

📉 ON-CHAIN DATA
├─ Price: ${X}
├─ Market Cap: ${X}
├─ 24h Volume: ${X} ({X}x avg)
├─ Liquidity: ${X} ({X}% of mcap)
├─ Volume Authenticity: {X}%
└─ LP Status: {🔒 LOCKED | 🔓 UNLOCKED}

━━━━━━━━━━━━━━━━━━━━━━━━━

🛡️ SAFETY CHECK
├─ Contract: {🟢 SAFE | 🟡 CAUTION | 🔴 RISK}
├─ Mint Authority: {✅ Disabled | ❌ Enabled}
├─ Freeze Authority: {✅ Disabled | ❌ Enabled}
├─ Insider Risk: {LOW | MEDIUM | HIGH}
└─ Safety Score: {score}/100

━━━━━━━━━━━━━━━━━━━━━━━━━

🐦 SOCIAL MOMENTUM
├─ Mentions (24h): {X} ({📈+X}% vs 7d avg)
├─ Sentiment: {🟢 BULLISH | 🟡 NEUTRAL | 🔴 BEARISH}
├─ KOL Mentions: {X}
├─ Narrative: {narrative tag}
└─ Social Score: {score}/100

━━━━━━━━━━━━━━━━━━━━━━━━━

⚡ TRADE SETUP

📍 Entry Zone: ${X} - ${Y}
📊 Position Size: {X}% of portfolio

🎯 Take Profits:
├─ TP1 (50%): ${X} (+50%) → Sell 33%
├─ TP2 (100%): ${X} (+100%) → Sell 33%
└─ TP3 (200%): ${X} (+200%) → Sell 34%

🛑 Stop Loss: ${X} (-25%)
📈 Trailing Stop: -15% from highs (after TP1)
⏱️ Max Hold: 7 days

━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ FLAGS: {flag1, flag2, ...}

🔗 Quick Links:
[Birdeye](url) | [DexScreener](url) | [RugCheck](url)

💱 Quick Trade:
[Jupiter](url) | [Raydium](url)

━━━━━━━━━━━━━━━━━━━━━━━━━

⏱️ {timestamp} UTC
🔵 Mature Token Signal - Tokens 24hrs+

⚠️ DYOR. Not financial advice. Higher conviction,
still volatile. Mature tokens have lower rug risk
but can still lose value rapidly.
```

### Sell/Exit Signal Template

```
🔴 ROSSYBOT EXIT SIGNAL

Token: $TICKER
Address: `{address}`

━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ EXIT RECOMMENDATION
├─ Action: {FULL_EXIT | PARTIAL_EXIT_50 | etc}
├─ Urgency: {🔴 HIGH | 🟡 MEDIUM | 🟢 LOW}
└─ Reason: {reason}

━━━━━━━━━━━━━━━━━━━━━━━━━

📊 POSITION STATUS
├─ Entry Price: ${X}
├─ Current Price: ${X}
├─ P&L: {+/-X}% (${X})
├─ Hold Time: {X}d {X}h
└─ Original Signal: {signal_type}

━━━━━━━━━━━━━━━━━━━━━━━━━

🚨 EXIT TRIGGERS
{trigger details}

━━━━━━━━━━━━━━━━━━━━━━━━━

💱 Quick Exit:
[Jupiter](url) | [Raydium](url)

⏱️ {timestamp} UTC
```

### Watch List Alert Template

```
👁️ ROSSYBOT WATCHLIST ALERT

Token: $TICKER
Added to: Mature Token Watchlist

━━━━━━━━━━━━━━━━━━━━━━━━━

📊 WATCH REASON
├─ Score: {score}/100 (Below buy threshold)
├─ Status: Accumulating | Approaching Breakout
├─ Missing: {what's needed for buy signal}
└─ Est. Trigger: {conditions}

━━━━━━━━━━━━━━━━━━━━━━━━━

📈 KEY LEVELS TO WATCH
├─ Resistance: ${X}
├─ Support: ${X}
├─ Breakout Target: ${X}
└─ Volume Trigger: ${X}

━━━━━━━━━━━━━━━━━━━━━━━━━

🔔 You'll be notified when conditions are met.

⏱️ {timestamp} UTC
```

---

## Configuration

### Module Configuration

```typescript
interface MatureTokenConfig {
  // Scanning
  scanIntervalMinutes: 5;           // Scan every 5 minutes
  maxTokensPerScan: 100;            // Process top 100 candidates

  // Filtering
  tokenAgeRange: {
    minHours: 24,
    maxDays: 14,
  };

  // Rate Limits
  rateLimits: {
    maxSignalsPerHour: 3,           // Lower frequency
    maxSignalsPerDay: 10,
    tokenCooldownHours: 12,         // 12hr cooldown per token
  };

  // Scoring Thresholds
  thresholds: {
    strongBuy: 75,
    buy: 60,
    watch: 45,
  };

  // Risk Management
  riskLimits: {
    maxPortfolioAllocation: 0.20,
    maxSinglePosition: 0.05,
    maxOpenPositions: 5,
  };

  // Features
  features: {
    enableKolTracking: true,
    enableSmartMoneyTracking: true,
    enableSocialAnalysis: true,
    enableWatchlist: true,
    enableAutoExitSignals: true,
  };
}
```

---

## Integration Points

### With Existing Modules

```typescript
// Reuse existing infrastructure
import { TokenSafetyChecker } from '../safety/token-safety-checker';
import { BundleDetector } from '../bundle-detector';
import { KolWalletMonitor } from '../kol-tracker';
import { TelegramBot } from '../telegram/telegram';
import { SignalPerformanceTracker } from '../performance/signal-performance-tracker';

// New module integrations
class MatureTokenScanner {
  constructor(
    private safetyChecker: TokenSafetyChecker,
    private bundleDetector: BundleDetector,
    private kolMonitor: KolWalletMonitor,
    private telegram: TelegramBot,
    private performanceTracker: SignalPerformanceTracker,
    // New components
    private accumulationDetector: AccumulationDetector,
    private breakoutAnalyzer: BreakoutAnalyzer,
    private holderDynamics: HolderDynamicsAnalyzer,
    private smartMoneyTracker: SmartMoneyTracker,
    private volumeProfiler: VolumeProfileAnalyzer,
  ) {}
}
```

### Database Schema Additions

```sql
-- Mature token tracking
CREATE TABLE mature_token_signals (
  signal_id UUID PRIMARY KEY,
  token_address VARCHAR(64) NOT NULL,
  ticker VARCHAR(32),
  signal_type VARCHAR(32) NOT NULL,
  composite_score INTEGER,
  accumulation_score INTEGER,
  breakout_score INTEGER,
  holder_score INTEGER,
  smart_money_score INTEGER,
  kol_score INTEGER,
  entry_price DECIMAL,
  token_age_hours INTEGER,
  market_cap DECIMAL,
  sent_at TIMESTAMP DEFAULT NOW()
);

-- Accumulation patterns
CREATE TABLE accumulation_patterns (
  id UUID PRIMARY KEY,
  token_address VARCHAR(64) NOT NULL,
  pattern_type VARCHAR(32),
  start_date TIMESTAMP,
  range_low DECIMAL,
  range_high DECIMAL,
  consolidation_days INTEGER,
  breakout_detected BOOLEAN DEFAULT FALSE,
  breakout_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Smart money activity
CREATE TABLE smart_money_activity (
  id UUID PRIMARY KEY,
  token_address VARCHAR(64) NOT NULL,
  wallet_address VARCHAR(64) NOT NULL,
  wallet_type VARCHAR(32), -- WHALE | SMART_MONEY | INSTITUTION
  action VARCHAR(16), -- BUY | SELL
  amount_usd DECIMAL,
  tokens_acquired DECIMAL,
  tx_signature VARCHAR(128),
  detected_at TIMESTAMP DEFAULT NOW()
);

-- Watchlist
CREATE TABLE mature_token_watchlist (
  id UUID PRIMARY KEY,
  token_address VARCHAR(64) NOT NULL UNIQUE,
  ticker VARCHAR(32),
  added_reason TEXT,
  target_conditions JSONB,
  current_score INTEGER,
  target_score INTEGER,
  added_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);
```

---

## Performance Expectations

### Target Metrics

| Metric | Target | Rationale |
|--------|--------|-----------|
| Signal Frequency | 5-10/day | Higher quality, lower volume |
| Win Rate | 55-65% | Mature = more predictable |
| Avg Return | 40-80% | Lower ceiling than new tokens |
| Max Drawdown | -25% | Tighter stops |
| False Signal Rate | <20% | Better data = fewer fakes |
| Avg Hold Time | 2-5 days | Longer than discovery signals |

### vs Discovery Signals

| Aspect | Discovery (New) | Mature Token |
|--------|-----------------|--------------|
| Token Age | 30min - 4hrs | 24hrs - 14 days |
| Risk Level | Very High | Medium-High |
| Upside Potential | 5-100x | 2-10x |
| Win Rate | 35-45% | 55-65% |
| Position Size | 0.5-1.5% | 2-3% |
| Data Quality | Limited | Rich |
| Rug Risk | Very High | Lower |
| Signal Confidence | Lower | Higher |

---

## Implementation Priority

### Phase 1 - Core Infrastructure
1. Token eligibility scanner
2. Basic accumulation detection
3. Holder dynamics analysis
4. Integration with existing safety checks
5. Basic Telegram formatting

### Phase 2 - Advanced Analysis
1. Breakout pattern recognition
2. Smart money tracking integration
3. Volume profile analysis
4. KOL re-entry detection
5. Composite scoring engine

### Phase 3 - Signal Optimization
1. Watchlist functionality
2. Exit signal automation
3. Performance tracking integration
4. Threshold optimization
5. Advanced position sizing

---

## Research Sources

This proposal is informed by research on successful memecoin metrics:

- [CoinLaw - Memecoin Statistics 2026](https://coinlaw.io/memecoin-statistics/)
- [CoinGecko - State of Memecoins Report 2025](https://www.coingecko.com/research/publications/state-of-memecoins-2025)
- [Nansen - How to Identify Viral Memecoins](https://www.nansen.ai/post/how-to-identify-the-next-viral-memecoin-using-nansen)
- [Nansen - Smart Money Wallet Tracking](https://www.nansen.ai/guides/how-to-find-and-track-smart-money-wallets-in-crypto)
- [altFINS - Smart Money Whales Guide](https://altfins.com/knowledge-base/the-ultimate-guide-to-smart-money-whales-in-crypto/)
- [Bitbond - KOL Data Analysis in Web3](https://www.bitbond.com/resources/kol-data-analysis-in-web3-marketing/)
- [CryptoSlate - Memecoin Hall of Shame 2025](https://cryptoslate.com/the-memecoin-hall-of-shame-10-tokens-that-defined-2025-wildest-trades/)
- [arXiv - Memecoin Phenomenon Study](https://arxiv.org/html/2512.11850v3)

---

*Proposal created for RossyBot - Mature Token Signal Module*
*Version 1.0 - February 2026*
