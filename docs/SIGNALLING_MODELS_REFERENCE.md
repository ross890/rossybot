# RossyBot Signalling Models & Thresholds Reference

> Comprehensive reference of all signalling models, scoring engines, thresholds, and parameters.
> Use this document to understand what drives signal generation and where to tune for more/better signals.

---

## Table of Contents

1. [On-Chain Scoring Engine](#1-on-chain-scoring-engine)
2. [Momentum Analyzer](#2-momentum-analyzer)
3. [Conviction Tracker](#3-conviction-tracker)
4. [KOL Sell Detector](#4-kol-sell-detector)
5. [Bundle Detector](#5-bundle-detector)
6. [MEV Bot Detector](#6-mev-bot-detector)
7. [Scam Filter](#7-scam-filter)
8. [Token Safety Checker](#8-token-safety-checker)
9. [Insider Detector](#9-insider-detector)
10. [Moonshot Assessor](#10-moonshot-assessor)
11. [Mature Token Scorer](#11-mature-token-scorer)
12. [Accumulation Detector](#12-accumulation-detector)
13. [Breakout Analyzer](#13-breakout-analyzer)
14. [Holder Dynamics Analyzer](#14-holder-dynamics-analyzer)
15. [Volume Profile Analyzer](#15-volume-profile-analyzer)
16. [Smart Money Tracker](#16-smart-money-tracker)
17. [KOL Re-Entry Detector](#17-kol-re-entry-detector)
18. [Technical Analysis](#18-technical-analysis)
19. [Threshold Optimizer](#19-threshold-optimizer)
20. [Win Predictor](#20-win-predictor)
21. [Signal Performance Tracker](#21-signal-performance-tracker)
22. [Social Metrics Analyzer](#22-social-metrics-analyzer)
23. [Discovery Scanners](#23-discovery-scanners)
24. [Small Capital Manager](#24-small-capital-manager)
25. [Market Cap Tier Configuration (Early Strategy)](#25-market-cap-tier-configuration-early-strategy)
26. [Market Cap Tier Configuration (Mature Strategy)](#26-market-cap-tier-configuration-mature-strategy)
27. [Global Config Parameters](#27-global-config-parameters)
28. [Critical Thresholds Summary Table](#28-critical-thresholds-summary-table)

---

## 1. On-Chain Scoring Engine

**File:** `src/modules/onchain-scoring.ts`
**Purpose:** Produces a composite 0-100 score for any token based on on-chain fundamentals.

### Component Weights

| Component        | Weight |
|------------------|--------|
| Momentum         | 30%    |
| Safety           | 25%    |
| Bundle Safety    | 20%    |
| Market Structure | 15%    |
| Timing           | 10%    |

### Grade Thresholds

| Grade | Score Range | Recommendation |
|-------|-------------|----------------|
| A     | 80-100      | STRONG_BUY     |
| B     | 65-79       | BUY            |
| C     | 50-64       | WATCH          |
| D     | 35-49       | AVOID          |
| F     | 0-34        | STRONG_AVOID   |

### Key Component Thresholds

| Parameter                 | Value              | Notes                          |
|---------------------------|--------------------|--------------------------------|
| Min safety score          | 40                 | Dynamic, adjustable by optimizer |
| Max bundle risk           | 60                 | Dynamic                        |
| Ideal liquidity ratio     | 5% of market cap   |                                |
| Min liquidity             | $2,000             |                                |
| Ideal top10 concentration | 40%                |                                |
| Max top10 concentration   | 75%                |                                |
| Min holder count          | 20                 |                                |
| Ideal holder count        | 200                |                                |
| Optimal token age         | 30 min - 4 hours   |                                |
| Too early                 | < 15 minutes       |                                |
| Too late                  | > 24 hours         |                                |

---

## 2. Momentum Analyzer

**File:** `src/modules/momentum-analyzer.ts`
**Purpose:** Real-time buy/sell pressure, volume velocity, and surge detection on 1-min and 5-min windows.

### Buy/Sell Ratio Thresholds

| Level              | Ratio | Interpretation         |
|--------------------|-------|------------------------|
| EXCELLENT          | > 2.0 | Very strong buy signal  |
| GOOD               | > 1.5 | Healthy momentum        |
| MIN (acceptable)   | > 1.2 | Marginal momentum       |
| WEAK               | < 0.8 | Sell pressure           |

### Volume Velocity (5m volume as % of 1h)

| Level     | Threshold | Meaning                  |
|-----------|-----------|--------------------------|
| EXCELLENT | > 30%     | Strong volume compression |
| GOOD      | > 20%     | Active trading            |
| MIN       | > 10%     | Baseline activity         |

### Quality Filters

| Parameter               | Threshold | Purpose                        |
|-------------------------|-----------|--------------------------------|
| Max small trade ratio   | 70%       | > 70% tiny trades = bot activity |
| Min unique buyers (5m)  | 5         | Real demand validation          |
| Max volatility          | 50%       | Reject extreme swings           |
| Min price support       | -15%      | Max drawdown in 5 minutes       |

### Surge Detection

- **Volume spike:** 5x+ normal volume = detected
- **Buy surge:** Extreme buy/sell ratio
- **Price surge:** Rapid price movement
- **Confidence levels:** HIGH, MEDIUM, LOW

---

## 3. Conviction Tracker

**File:** `src/modules/signals/conviction-tracker.ts`
**Purpose:** Tracks when multiple KOLs buy the same token within a time window.

| Parameter                   | Value     |
|-----------------------------|-----------|
| HIGH_CONVICTION_THRESHOLD   | 2 KOLs   |
| ULTRA_CONVICTION_THRESHOLD  | 3+ KOLs  |
| CONVICTION_WINDOW_MS        | 24 hours  |

**Metrics tracked per KOL buy:** ID, name, wallet, timestamp, SOL amount, tx signature.
**Storage:** In-memory cache + database persistence.

---

## 4. KOL Sell Detector

**File:** `src/modules/signals/sell-detector.ts`
**Purpose:** Detects KOL exits to produce sell signals and track holding patterns.

| Parameter                    | Value | Meaning                |
|------------------------------|-------|------------------------|
| FULL_EXIT_THRESHOLD          | 0.95  | 95% sold = full exit   |
| SIGNIFICANT_SELL_THRESHOLD   | 0.25  | 25%+ = significant sell |
| Tracking window              | 24h   | Recent sell history     |

---

## 5. Bundle Detector

**File:** `src/modules/bundle-detector.ts`
**Purpose:** Detects bundled/coordinated launches where insiders accumulate in the first blocks.

### Same-Block Buyer Risk

| Level    | Buyers in Same Block |
|----------|----------------------|
| CRITICAL | 10+                  |
| HIGH     | 5+                   |
| MEDIUM   | 3+                   |

### Insider Supply Risk

| Level    | Supply % Held |
|----------|---------------|
| CRITICAL | > 60%         |
| HIGH     | > 40%         |
| MEDIUM   | > 25%         |

### Fresh Wallet Risk

| Level       | Fresh Wallet % |
|-------------|----------------|
| HIGH_RISK   | > 70%          |
| MEDIUM_RISK | > 50%          |

### Deployer Funding

| Level  | Funded Buyers |
|--------|---------------|
| HIGH   | 5+            |
| MEDIUM | 2+            |

### Timing

| Parameter           | Value                    |
|---------------------|--------------------------|
| EARLY_BLOCKS        | First 3 blocks after creation |
| SNIPER_WINDOW_MS    | 2 seconds from creation  |
| Cache TTL           | 5 minutes                |

---

## 6. MEV Bot Detector

**File:** `src/modules/mev-detector.ts`
**Purpose:** Identifies sandwich attacks, arbitrage, frontrunning, and backrunning on token pairs.

### MEV Activity Types

SANDWICH, ARBITRAGE, LIQUIDATION, FRONTRUN, BACKRUN

### Bot Characteristic Thresholds

| Parameter                | Value           |
|--------------------------|-----------------|
| MAX_BLOCK_DISTANCE       | 2 blocks        |
| MIN_PROFIT_THRESHOLD     | 0.001 SOL       |
| UNUSUAL_SIZE_MULTIPLIER  | 5x average      |
| RAPID_TRADE_WINDOW_MS    | 5 seconds       |
| FRESH_WALLET_AGE_HOURS   | 24 hours        |
| HIGH_TX_FREQUENCY        | 100+ tx/day     |

### Signal Levels

HIGH, MEDIUM, LOW, NONE

### Caches

- Bot wallet cache: 1 hour TTL
- MEV activity cache: 5 minutes TTL

**Known MEV Programs monitored:** Jupiter V6/V4, Raydium V4, Orca Whirlpool, Pump.fun

---

## 7. Scam Filter

**File:** `src/modules/scam-filter.ts`
**Purpose:** Multi-stage pipeline that produces PASS, FLAG, or REJECT for each token.

### Pipeline Stages

1. Contract Analysis
2. Bundle Analysis
3. Dev Wallet Behaviour
4. Rug History Check

### Thresholds

| Parameter                 | Value  | Action  |
|---------------------------|--------|---------|
| Bundle high risk supply   | > 25%  | FLAG    |
| Bundle medium risk supply | > 10%  | FLAG    |
| Dev sell high risk        | > 10%  | FLAG    |
| Dev sell flag             | > 5%   | FLAG    |
| Rug history (wallets)     | >= 3   | REJECT  |
| Rug history (wallets)     | >= 1   | FLAG    |
| Min liquidity for trade   | $5,000 | REJECT if below |

---

## 8. Token Safety Checker

**File:** `src/modules/safety/token-safety-checker.ts`
**Purpose:** Produces a 0-100 safety score (100 = safest).

### Point Deductions

| Check                     | Deduction | Notes                  |
|---------------------------|-----------|------------------------|
| Mint authority enabled    | -15       |                        |
| Freeze authority enabled  | -12       |                        |
| Top10 holders > 70%       | -12       |                        |
| Deployer holds > 10%      | -10       |                        |
| LP not locked             | -10       |                        |
| Token age < 15 minutes    | -5        |                        |
| RugCheck score < 50       | -15       | LOW_RUGCHECK_SCORE     |
| RugCheck score 50-70      | -5        | MEDIUM_RUGCHECK_SCORE  |

### Additional Checks

- Honeypot risk detection
- Update authority verification
- Metadata verification

| Parameter           | Value      |
|---------------------|------------|
| Min safety threshold | 30        |
| Cache TTL           | 15 minutes |

---

## 9. Insider Detector

**File:** `src/modules/safety/insider-detector.ts`
**Purpose:** Detects coordinated insider activity around token launches.

| Parameter                   | Value    |
|-----------------------------|----------|
| INSIDER_RISK_THRESHOLD      | 70/100   |
| SAME_BLOCK_BUYERS_WARNING   | 3        |
| DEPLOYER_FUNDED_WARNING     | 2        |
| FUNDING_LOOKBACK_HOURS      | 24       |

**Detects:** Same-block sniper activity, deployer-funded buyer patterns, suspicious wallet coordination.

---

## 10. Moonshot Assessor

**File:** `src/modules/moonshot-assessor.ts`
**Purpose:** Scores tokens for 10x+ moonshot potential using empirical patterns from successful tokens.

### Factor Weights

| Factor            | Weight |
|-------------------|--------|
| Volume velocity   | 18%    |
| Narrative score   | 15%    |
| Holder growth rate | 15%   |
| Liquidity ratio   | 12%    |
| Holder distribution | 12%  |
| Memetic potential  | 8%    |

### Ideal Ranges

| Metric               | Ideal Value     | Min/Max              |
|----------------------|-----------------|----------------------|
| Volume/MCap ratio    | 50%             | Min $10K volume      |
| Holder growth/hour   | 50+             |                      |
| Min holders (early)  | 100             |                      |
| Holders at 1 hour    | 200             |                      |
| Top10 concentration  | 25%             | Max 40%              |
| Liquidity/MCap ratio | 10%             | Min 3%, max 25%      |
| Min abs. liquidity   | $15,000         |                      |

### Token Age Sweet Spots

| Phase      | Age Range       |
|------------|-----------------|
| Too early  | < 15 minutes    |
| Optimal    | 30 min - 4 hours |
| Late       | > 12 hours      |
| Too late   | > 24 hours      |

---

## 11. Mature Token Scorer

**File:** `src/modules/mature-token/mature-token-scorer.ts`
**Purpose:** Composite scorer for tokens that have passed the early phase (aged, with established holders).

### Component Weights

| Component           | Weight |
|---------------------|--------|
| Accumulation        | 20%    |
| Breakout            | 15%    |
| Holder Dynamics     | 15%    |
| Contract Safety     | 10%    |
| Volume Authenticity | 10%    |
| Smart Money         | 10%    |
| KOL Activity        | 10%    |
| Narrative Momentum  | 5%     |
| Bundle Risk         | 5%     |

### Score Thresholds

| Level      | Score |
|------------|-------|
| STRONG_BUY | 75+   |
| BUY        | 50+   |
| WATCH      | 45+   |

### Score Multipliers (Applied Post-Scoring)

| Condition              | Multiplier |
|------------------------|------------|
| Single KOL buy         | 1.10x      |
| Multi KOL buy          | 1.25x      |
| Tier 1 KOL buy         | 1.15x      |
| Whale accumulation     | 1.12x      |
| Smart money inflow     | 1.08x      |
| Strong accumulation    | 1.15x      |
| Breakout confirmed     | 1.20x      |
| Trending narrative     | 1.10x      |
| Viral moment           | 1.25x      |
| High bot activity      | 0.85x      |
| Concentrated holders   | 0.90x      |
| Low liquidity          | 0.80x      |

---

## 12. Accumulation Detector

**File:** `src/modules/mature-token/accumulation-detector.ts`
**Purpose:** Identifies classic accumulation patterns (Wyckoff, range breaks, double bottoms, etc.).

### Detected Patterns

WYCKOFF_SPRING, RANGE_BREAK, ASCENDING_TRIANGLE, DOUBLE_BOTTOM, CONSOLIDATION, NONE

### Thresholds

| Parameter                  | Value     |
|----------------------------|-----------|
| Price range 24h (max)      | 20%       |
| Volume decline 7d (min)    | 30%       |
| Buy volume ratio (min)     | 1.2       |
| New holders 24h (min)      | 50        |
| Holder retention (min)     | 70%       |
| Large wallet accumulation  | min 3     |
| Consolidation days         | 2-7 days  |
| Distance from ATH          | 40-80%    |
| Cache TTL                  | 5 minutes |

---

## 13. Breakout Analyzer

**File:** `src/modules/mature-token/breakout-analyzer.ts`
**Purpose:** Detects breakout conditions from consolidation or accumulation patterns.

| Parameter              | Threshold |
|------------------------|-----------|
| Volume expansion (min) | 2.0x      |
| Resistance tests (min) | 2         |
| RSI14 range            | 45-70     |
| Bid/ask ratio (min)    | 1.3       |
| Social velocity 3h     | 1.5x      |
| KOL mentions 24h       | min 1     |
| Cache TTL              | 2 minutes |

---

## 14. Holder Dynamics Analyzer

**File:** `src/modules/mature-token/holder-dynamics.ts`
**Purpose:** Measures holder quality, growth, and distribution health.

| Parameter                | Threshold |
|--------------------------|-----------|
| Holder growth 24h (min)  | 5%        |
| Buyer/seller ratio (min) | 1.5       |
| Gini coefficient (max)   | 0.75      |
| Diamond hands ratio (min)| 30%       |
| Quality wallet ratio (min)| 60%      |
| Smart money holders (min)| 5         |
| Cache TTL                | 5 minutes |

---

## 15. Volume Profile Analyzer

**File:** `src/modules/mature-token/volume-profile.ts`
**Purpose:** Validates volume authenticity and detects wash trading.

| Parameter                | Target    |
|--------------------------|-----------|
| Volume trend 7d          | INCREASING |
| Organic volume ratio (min)| 50%      |
| Wash trading score (max) | 30        |
| Bot activity score (max) | 50        |
| Volume consistency (min) | 40%       |
| Cache TTL                | 3 minutes |

---

## 16. Smart Money Tracker

**File:** `src/modules/mature-token/smart-money-tracker.ts`
**Purpose:** Tracks whale and smart money wallet activity.

| Parameter                     | Value      |
|-------------------------------|------------|
| Whale threshold               | 1% of supply |
| Smart money min win rate      | 55%        |
| Smart money inflow 24h (min)  | $10,000    |
| Whale accumulation (min)      | 2          |
| Whale buy/sell ratio (min)    | 2.0        |
| Profitable wallet ratio (min) | 40%        |
| Exchange net flow (max)       | 0          |
| Cache TTL                     | 3 minutes  |

---

## 17. KOL Re-Entry Detector

**File:** `src/modules/mature-token/kol-reentry-detector.ts`
**Purpose:** Detects when KOLs re-enter positions in mature tokens.

| Parameter                  | Value   |
|----------------------------|---------|
| Activity window            | 7 days  |
| KOL buys 24h (min)         | 1       |
| Tier 1 KOL count (min)     | 1       |
| Avg KOL win rate (min)     | 55%     |
| KOL conviction score (min) | 50      |
| Current vs KOL entry price | max 1.2x |
| Cache TTL                  | 2 minutes |

---

## 18. Technical Analysis

**File:** `src/modules/mature-token/technical-analysis.ts`
**Purpose:** Classic TA indicators for mature token analysis.

### Indicator Configuration

| Indicator   | Period  |
|-------------|---------|
| RSI         | 14      |
| MACD fast   | 12      |
| MACD slow   | 26      |
| MACD signal | 9       |

### Bias Levels

BULLISH, BEARISH, NEUTRAL

### RSI Interpretation

OVERSOLD, NEUTRAL, OVERBOUGHT

| Parameter | Value    |
|-----------|----------|
| Cache TTL | 1 minute |

---

## 19. Threshold Optimizer

**File:** `src/modules/performance/threshold-optimizer.ts`
**Purpose:** Dynamically adjusts signal thresholds based on historical performance data.

### Default Thresholds (Tightened)

| Parameter              | Default Value |
|------------------------|---------------|
| minMomentumScore       | 25            |
| minOnChainScore        | 35            |
| minSafetyScore         | 45            |
| maxBundleRiskScore     | 55            |
| minLiquidity           | $8,000        |
| maxTop10Concentration  | 60%           |

### Optimizer Configuration

| Parameter                    | Value |
|------------------------------|-------|
| Target win rate              | 50%   |
| Min data points for optimize | 20    |
| Max threshold change/cycle   | 15%   |

---

## 20. Win Predictor

**File:** `src/modules/performance/win-predictor.ts`
**Purpose:** ML-style predictor that learns from historical trade outcomes.

### Configuration

| Parameter                 | Value           |
|---------------------------|-----------------|
| Min samples for prediction | 15             |
| Min pattern samples        | 5              |
| Retrain interval           | 7 days (weekly) |

### Feature Normalization Ranges

| Feature              | Min       | Max          |
|----------------------|-----------|--------------|
| Momentum score       | 0         | 100          |
| On-chain score       | 0         | 100          |
| Safety score         | 0         | 100          |
| Bundle risk          | 0         | 100          |
| Liquidity            | $1,000    | $500,000     |
| Token age (minutes)  | 5         | 10,000       |
| Holder count         | 10        | 5,000        |
| Top10 concentration  | 10%       | 90%          |
| Buy/sell ratio       | 0.1       | 10           |
| Unique buyers        | 1         | 500          |
| Market cap           | $10,000   | $25,000,000  |
| Volume/MCap ratio    | 0.01      | 2            |

---

## 21. Signal Performance Tracker

**File:** `src/modules/performance/signal-performance-tracker.ts`
**Purpose:** Tracks how signals perform after generation.

| Parameter         | Value  |
|-------------------|--------|
| Stop loss target  | -40%   |
| Take profit target| +100%  |
| Tracking intervals| 1h, 4h, 24h returns |

---

## 22. Social Metrics Analyzer

**File:** `src/modules/social/social-analyzer.ts`
**Purpose:** Produces a 0-100 social score from platform mentions and engagement.

### Score Components (each 0-25)

| Component     | Measures                      |
|---------------|-------------------------------|
| Velocity      | Mention acceleration          |
| Engagement    | Quality of interactions       |
| Authenticity  | Account quality / bot filter  |
| Sentiment     | Positive sentiment ratio      |

### KOL Tier System

S, A, B, C (with minimum follower requirements per tier)

### Confidence Levels

HIGH, MEDIUM, LOW

---

## 23. Discovery Scanners

### 23a. Holder Growth Scanner

**File:** `src/modules/discovery/holder-growth-scanner.ts`

| Parameter              | Value        |
|------------------------|--------------|
| Min holders/hour       | 50           |
| Min token age          | 2 hours      |
| Max token age          | 2,160 hours (90 days) |
| Min existing holders   | 100          |
| Min liquidity          | $15,000      |
| Scan interval          | 5 minutes    |
| Min relative growth    | 5%           |
| Suspicious growth rate | > 50% in 1h  |

### 23b. Volume Anomaly Scanner

**File:** `src/modules/discovery/volume-anomaly-scanner.ts`

| Parameter              | Value        |
|------------------------|--------------|
| Min volume multiplier  | 5x normal    |
| Min absolute volume    | $25,000      |
| Min token age          | 1 day        |
| Max token age          | 90 days      |
| Min liquidity          | $15,000      |
| Scan interval          | 10 minutes   |
| Max repetitive tx      | 40%          |
| Max top wallet volume  | 60%          |
| Min unique traders     | 20           |

### 23c. Smart Money Scanner

**File:** `src/modules/discovery/smart-money-scanner.ts`

| Parameter                 | Value           |
|---------------------------|-----------------|
| Min trade size            | 0.5 SOL         |
| Max candidates tracked    | 500             |
| Min trades for evaluation | 10              |
| Min unique tokens         | 5               |
| Promote win rate          | 50%+            |
| Promote min profit        | 5 SOL           |
| Promote consistency max   | 150 ROI std dev |
| Reject win rate           | < 30%           |
| Reject max loss           | -10 SOL         |

### 23d. Narrative Scanner

**File:** `src/modules/discovery/narrative-scanner.ts`

**Tracked narratives:** AI agent, GPT, neural, intelligence, trump, maga, election, pepe, wojak, and more.
Dynamic learning enabled. Parameters vary by narrative.

---

## 24. Small Capital Manager

**File:** `src/modules/small-capital-manager.ts`
**Purpose:** Optimized parameters for accounts with < 10 SOL (~$150).

### Portfolio Limits

| Parameter            | Value  |
|----------------------|--------|
| Max open positions   | 2      |
| Max daily trades     | 5      |
| Max portfolio risk   | 30%    |

### Position Sizing

| Parameter | Value  |
|-----------|--------|
| Base size | 10%    |
| Min size  | 0.05 SOL |
| Max size  | 20%    |

### Risk Management

| Parameter        | Value   |
|------------------|---------|
| Stop loss        | 40%     |
| Take profit      | 100% (2x) |
| Trailing stop    | 30% activation |

### Scaling Rules

| Parameter              | Value |
|------------------------|-------|
| Scale down after       | 2 losses |
| Scale up after         | 3 wins   |
| Max scale multiplier   | 1.5x    |
| Min scale multiplier   | 0.5x    |

---

## 25. Market Cap Tier Configuration (Early Strategy)

**File:** `src/modules/signal-generator.ts`

| Tier        | MCap Range      | Min Liquidity | Min Safety | Position Mult. | Win Rate | Enabled |
|-------------|-----------------|---------------|------------|----------------|----------|---------|
| MICRO       | $0-$500K        | $5,000        | 50         | 0.5x           | -        | YES     |
| RISING      | $500K-$8M       | $10,000       | 50         | 1.0x           | 47%      | YES     |
| EMERGING    | $8M-$20M        | $20,000       | 55         | 0.5x           | 11%      | YES*    |
| GRADUATED   | $20M-$50M       | $50,000       | 60         | 0.75x          | -        | YES     |
| ESTABLISHED | $50M-$150M      | $100,000      | 55         | 0.5x           | -        | YES     |

*EMERGING tier has problematic 11% win rate; position size reduced.

---

## 26. Market Cap Tier Configuration (Mature Strategy)

**File:** `src/modules/mature-token/types.ts`

### Tier Definitions

| Tier        | MCap Range   | Min Volume | Min Holders | Min Age     | Signal Alloc. |
|-------------|-------------|------------|-------------|-------------|---------------|
| MICRO       | $200K-$500K | $15K       | 250         | 72h (3d)    | 15%           |
| RISING      | $500K-$8M   | $25K       | 300         | 72h (3d)    | 35%           |
| EMERGING    | $8M-$20M    | $300K      | 100         | 504h (21d)  | 0% (DISABLED) |
| GRADUATED   | $20M-$50M   | $500K      | 100         | 504h (21d)  | 30%           |
| ESTABLISHED | $50M-$150M  | $1M        | 100         | 504h (21d)  | 20%           |

### Stop Loss Configuration (by tier)

| Tier        | Initial Stop Loss | After 8h Stop Loss |
|-------------|-------------------|--------------------|
| MICRO       | 30%               | 22%                |
| RISING      | 25%               | 18%                |
| EMERGING    | 20%               | 15%                |
| GRADUATED   | 18%               | 12%                |
| ESTABLISHED | 15%               | 10%                |

### Take Profit Configuration (all tiers)

| Level | Target | Sell % | Notes    |
|-------|--------|--------|----------|
| TP1   | +30%   | 40%    |          |
| TP2   | +60%   | 40%    |          |
| TP3   | +100%  | 20%    | Trailing |

### Position Configuration

| Score Range     | Level    | Size | Risk |
|-----------------|----------|------|------|
| 80+             | Strong   | 25%  | 5%   |
| 65-79           | Standard | 15%  | 3%   |
| Max concurrent  | -        | 3    | -    |
| Dry powder reserve | -     | 50%  | -    |

---

## 27. Global Config Parameters

**File:** `src/config/index.ts`

### Trading Config

| Parameter                      | Value  |
|--------------------------------|--------|
| MAX_MEMECOIN_PORTFOLIO_PERCENT | 20%    |
| DEFAULT_POSITION_SIZE_PERCENT  | 2%     |
| MAX_SIGNALS_PER_HOUR           | 50     |
| MAX_SIGNALS_PER_DAY            | 200    |
| MIN_SCORE_BUY_SIGNAL           | 70     |
| MIN_SCORE_WATCH_SIGNAL         | 55     |
| LEARNING_MODE                  | true   |

### Strategy Toggles

| Parameter              | Default |
|------------------------|---------|
| ENABLE_EARLY_STRATEGY  | false   |
| ENABLE_MATURE_STRATEGY | true    |

### Screening Config

| Parameter              | Value        |
|------------------------|--------------|
| MIN_MARKET_CAP         | $10,000      |
| MAX_MARKET_CAP         | $25,000,000  |
| MIN_24H_VOLUME         | $3,000       |
| MIN_VOLUME_MCAP_RATIO  | 0.05         |
| MIN_HOLDER_COUNT       | 20           |
| MAX_TOP10_CONCENTRATION| 75%          |
| MIN_LIQUIDITY_POOL     | $2,000       |
| MIN_TOKEN_AGE_MINUTES  | 5            |

### Scan Intervals

| Scan                    | Interval    |
|-------------------------|-------------|
| Main scan               | 10 seconds  |
| KOL activity window     | 2 hours     |
| Discovery signal expiry | 24 hours    |
| Mature token scan       | 5 minutes   |

---

## 28. Critical Thresholds Summary Table

| Model              | Critical (Bad)   | Warning          | Healthy (Good)   |
|--------------------|------------------|------------------|------------------|
| **Conviction**     | < 2 KOLs         | 2 KOLs (HIGH)    | 3+ KOLs (ULTRA)  |
| **Momentum**       | < 0.8 buy/sell   | 1.2 buy/sell     | > 2.0 buy/sell   |
| **On-chain Score** | < 35 (AVOID)     | 35-50 (WATCH)    | 80+ (STRONG_BUY) |
| **Bundle Risk**    | > 60% insiders   | 40-60%           | < 25%            |
| **Safety Score**   | < 30             | 30-50            | > 70             |
| **MEV Activity**   | HIGH level       | MEDIUM level     | LOW/NONE         |
| **Top10 Conc.**    | > 75%            | 60-75%           | < 40%            |
| **Holder Count**   | < 20             | 20-100           | > 300            |
| **Volume/MCap**    | < 0.05           | 0.05-0.10        | > 0.50           |
| **Win Predictor**  | < 15% win prob   | 15-25%           | > 50%            |
| **Liquidity**      | < $2,000         | $2K-$8K          | > $15,000        |
| **Token Age**      | < 15 min         | 15-30 min        | 30 min - 4h      |

---

## Notes for Parameter Tuning

**To generate MORE signals:**
- Lower `minOnChainScore` (currently 35)
- Lower `minSafetyScore` (currently 45)
- Raise `maxBundleRiskScore` (currently 55)
- Lower `minLiquidity` (currently $8,000)
- Raise `maxTop10Concentration` (currently 60%)
- Lower `MIN_SCORE_BUY_SIGNAL` (currently 70)
- Enable EARLY_STRATEGY (currently false)

**To generate BETTER signals (higher quality):**
- Raise `minMomentumScore` (currently 25)
- Raise `minSafetyScore` (currently 45)
- Lower `maxBundleRiskScore` (currently 55)
- Raise conviction thresholds
- Raise `MIN_SCORE_BUY_SIGNAL` (currently 70)
- Increase smart money / KOL weight in mature scorer

**Known Problem Areas:**
- EMERGING tier ($8M-$20M): 11% win rate in early strategy, 0% allocation in mature strategy - this tier consistently underperforms
- Early strategy is disabled by default (`ENABLE_EARLY_STRATEGY: false`)
- Win predictor needs minimum 15 samples before producing predictions
- Threshold optimizer needs 20 data points before it can adjust thresholds
