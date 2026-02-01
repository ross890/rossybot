# Rossybot Strategy Improvements

**Date:** February 1, 2026
**Starting Capital:** 1 SOL (~$150)
**Focus:** On-chain metrics first, KOL tracking as secondary validation

---

## Executive Summary

This document outlines strategic improvements to rossybot that address the weaknesses identified in the strategic analysis. The key changes shift focus from KOL-dependent signals to **independent on-chain metric analysis**.

### Core Philosophy Change

| Before | After |
|--------|-------|
| KOL tracking as primary signal | On-chain metrics as primary signal |
| Follow what influencers buy | Detect momentum before influencers |
| 60-second scan cycles | Real-time momentum detection |
| 2-3% position sizes | 10-20% with strict risk management |
| Score >= 70 for signals | Multi-factor independent scoring |

---

## New Modules Created

### 1. Momentum Analyzer (`momentum-analyzer.ts`)

**Purpose:** Detect genuine buying momentum independent of KOL activity.

**Key Metrics:**
```
Buy/Sell Analysis:
- buyCount5m, sellCount5m
- buyVolume5m, sellVolume5m
- buySellRatio (target: >1.2)
- netBuyPressure

Volume Velocity:
- volume5m / volume1h ratio (target: >20%)
- volumeAcceleration (-1 to 1)

Trade Quality:
- uniqueBuyers5m (target: >5)
- smallTradeRatio (< 70% = organic)
- largeTradeCount

Holder Dynamics:
- holderGrowthRate (target: >1/minute)
- newHolders5m
```

**Scoring (0-100):**
- Buy Pressure: 0-25 points
- Volume Momentum: 0-25 points
- Trade Quality: 0-25 points
- Holder Growth: 0-25 points

**Research-Backed Thresholds:**
```typescript
EXCELLENT_BUY_RATIO: 2.0      // Strong buying pressure
GOOD_BUY_RATIO: 1.5           // Healthy buying
MIN_BUY_RATIO: 1.2            // Minimum for momentum
EXCELLENT_VELOCITY: 0.30      // 30% of 1h volume in 5m = explosive
GOOD_VELOCITY: 0.20           // 20% = strong momentum
MAX_SMALL_TRADE_RATIO: 0.70   // >70% tiny trades = bots
```

---

### 2. Bundle Detector (`bundle-detector.ts`)

**Purpose:** Detect insider allocations and coordinated launches that precede dumps.

**Key Metrics:**
```
Bundle Detection:
- sameBlockBuyers (target: < 5)
- firstBlockBuyers
- insiderSupplyPercent (critical if > 60%)
- clusteredWalletCount

Funding Analysis:
- deployerFundedBuyers (suspicious if > 2)
- freshWalletBuyers ratio
- fundingSourceCount
```

**Risk Thresholds (from Focai $20M insider case study):**
```typescript
CRITICAL_SAME_BLOCK: 10       // 10+ buyers = critical
CRITICAL_INSIDER_SUPPLY: 60   // >60% insider = critical
HIGH_INSIDER_SUPPLY: 40       // >40% = high risk
HIGH_DEPLOYER_FUNDED: 5       // 5+ deployer-funded = high risk
```

**Risk Levels:**
- CRITICAL: Score >= 70
- HIGH: Score >= 50
- MEDIUM: Score >= 30
- LOW: Score < 15

---

### 3. Small Capital Manager (`small-capital-manager.ts`)

**Purpose:** Position sizing and risk management optimized for 1 SOL capital.

**Configuration for 1 SOL:**
```typescript
initialCapitalSol: 1.0
maxOpenPositions: 2           // Only 2 concurrent positions
maxDailyTrades: 5             // Max 5 trades per day
maxPortfolioRisk: 30          // Max 30% at risk simultaneously

basePositionPercent: 10       // 0.1 SOL base position
minPositionSol: 0.05          // Minimum ~$7.50
maxPositionPercent: 20        // Maximum 0.2 SOL

stopLossPercent: 40           // Wide stops for memecoin volatility
takeProfitPercent: 100        // 2x target
trailingStopPercent: 30       // Trail after gains
```

**Dynamic Position Sizing:**
Position size adjusts based on:
1. Signal strength (STRONG/MODERATE/WEAK): 0.6x - 1.3x
2. Momentum score: 0.6x - 1.3x
3. Safety score: 0.5x - 1.2x
4. Bundle safety: 0.5x - 1.15x
5. Win/loss streak: 0.5x - 1.5x

**Example Calculations:**
```
STRONG signal + 80 momentum + 70 safety + clean launch:
Base: 10% × 1.3 × 1.15 × 1.1 × 1.0 = 16.4%
Position: 0.164 SOL (~$24)
Max loss: 0.066 SOL (~$10)

MODERATE signal + 60 momentum + 60 safety + medium bundle risk:
Base: 10% × 1.0 × 1.0 × 1.0 × 0.8 = 8%
Position: 0.08 SOL (~$12)
Max loss: 0.032 SOL (~$5)
```

---

### 4. On-Chain Scoring Engine (`onchain-scoring.ts`)

**Purpose:** Pure on-chain scoring independent of KOL tracking.

**Component Weights:**
```typescript
momentum: 0.30        // 30% - Buy pressure, volume velocity
safety: 0.25          // 25% - Contract safety, honeypot checks
bundleSafety: 0.20    // 20% - Insider/bundle risk
marketStructure: 0.15 // 15% - Liquidity, distribution
timing: 0.10          // 10% - Launch timing optimization
```

**Market Structure Scoring:**
- Liquidity ratio (ideal: 10% of mcap)
- Top 10 concentration (ideal: <25%)
- Holder count (ideal: 500+)
- Volume/MCap ratio

**Timing Optimization:**
```
Too early (<15 min): 20-50 points - high risk
Early (15-30 min): 50-80 points - getting better
Optimal (30 min - 2 hrs): 100 points - sweet spot
Good (2-4 hrs): 70-90 points - still viable
Late (4-24 hrs): 20-70 points - declining
Too late (>24 hrs): 20 points - established or dead
```

**Recommendations:**
- STRONG_BUY: Score >= 80, 3+ bullish signals, no bearish
- BUY: Score >= 65, <= 1 bearish signal
- WATCH: Score >= 50
- AVOID: Score >= 35
- STRONG_AVOID: Score < 35 or critical risk

---

## Strategy for 1 SOL Capital

### Entry Criteria (All Must Pass)

1. **Momentum Score >= 55**
   - Buy/sell ratio >= 1.2
   - Volume velocity >= 10%
   - At least 5 unique buyers in 5 minutes

2. **Safety Score >= 50**
   - Mint authority revoked
   - Freeze authority revoked
   - No honeypot risk
   - RugCheck score >= 50

3. **Bundle Risk Score < 50**
   - No critical insider flags
   - Same-block buyers < 10
   - Insider supply < 40%

4. **Market Structure**
   - Liquidity >= $15,000
   - Top 10 concentration < 50%
   - Holders >= 50

5. **Timing**
   - Token age: 30 minutes - 4 hours (optimal)
   - Or: 15-30 minutes with extra caution

### Position Sizing Rules

| Signal Quality | Position Size | Max Risk |
|---------------|---------------|----------|
| STRONG (score >= 75) | 15-20% (0.15-0.2 SOL) | 6-8% |
| MODERATE (score 60-74) | 10-15% (0.1-0.15 SOL) | 4-6% |
| WATCH (score 55-59) | 5-10% (0.05-0.1 SOL) | 2-4% |

### Risk Management

**Stop Loss:** 40% (accounts for memecoin volatility)
**Take Profit:** 100% (2x)
**Trailing Stop:** Activate at +50%, trail by 30%

**Portfolio Limits:**
- Max 2 open positions
- Max 5 trades per day
- Max 30% portfolio at risk

### Exit Rules

1. **Stop Loss Hit:** Exit immediately at -40%
2. **Take Profit:** Sell 50% at +100%, trail remainder
3. **Time Stop:** Exit if no movement after 4 hours
4. **Momentum Reversal:** Exit if buy/sell ratio drops below 0.8
5. **KOL Exit:** If tracked KOL sells, evaluate exit

---

## Expected Performance

### Probability Model (Based on Research)

**Pump.fun Statistics:**
- Graduation rate: 1.4%
- User profitability: 3% earn > $1,000
- Average token lifespan: 3-7 days

**With Improved Filtering:**
```
If we filter to only trade tokens that:
- Pass safety checks (~30% of tokens)
- Show genuine momentum (~10% of those)
- Have clean launches (~50% of those)
- Are in optimal timing window (~30% of those)

Effective filter rate: 0.3 × 0.1 × 0.5 × 0.3 = 0.45%
This is much more selective than the 1.4% graduation rate
```

**Conservative Estimates:**
- Win rate: 25-35% (improved from base ~10%)
- Average win: +100% (2x)
- Average loss: -40%
- Trades per week: 10-15

**Expected Value per Trade:**
```
EV = (Win Rate × Avg Win) - (Loss Rate × Avg Loss)
EV = (0.30 × 1.0) - (0.70 × 0.4)
EV = 0.30 - 0.28
EV = +0.02 (+2% per trade)
```

**Monthly Projection (1 SOL start):**
- 40 trades × 0.1 SOL average × 2% EV = 0.08 SOL
- After 6 months: ~1.5 SOL (if consistent)
- Highly variable - could be -50% or +200%

---

## Implementation Checklist

### Phase 1: Core Modules (Completed)
- [x] Momentum Analyzer
- [x] Bundle Detector
- [x] Small Capital Manager
- [x] On-Chain Scoring Engine

### Phase 2: Integration (TODO)
- [ ] Update signal-generator.ts to use new scoring
- [ ] Add momentum checks to evaluation pipeline
- [ ] Integrate bundle detection into safety checks
- [ ] Update Telegram alerts with new score format

### Phase 3: Testing (TODO)
- [ ] Paper trade for 2 weeks minimum
- [ ] Track all signals vs. actual outcomes
- [ ] Calibrate thresholds based on results
- [ ] Validate position sizing logic

### Phase 4: Optimization (TODO)
- [ ] Implement holder growth tracking (currently placeholder)
- [ ] Add real trade size distribution analysis
- [ ] Integrate LP lock detection
- [ ] Add historical backtesting capability

---

## Key Differences from Original Strategy

| Aspect | Original | Improved |
|--------|----------|----------|
| Primary Signal | KOL wallet activity | On-chain momentum |
| KOL Dependency | Required | Optional validation |
| Position Size | 2-3% fixed | 5-20% dynamic |
| Risk per Trade | ~0.6% | 2-8% (appropriate for small capital) |
| Stop Loss | 30% | 40% (memecoin volatility) |
| Entry Criteria | Score >= 70 + KOL | Multi-factor >= 55 |
| Bundle Detection | Placeholder (always 0) | Functional analysis |
| Momentum Analysis | Not present | Core component |

---

## Files Created/Modified

### New Files:
1. `src/modules/momentum-analyzer.ts` - Momentum detection
2. `src/modules/bundle-detector.ts` - Bundle/insider detection
3. `src/modules/small-capital-manager.ts` - Position sizing
4. `src/modules/onchain-scoring.ts` - Independent scoring
5. `IMPROVEMENTS.md` - This document

### Modified Files:
1. `src/modules/safety/token-safety-checker.ts` - Added type re-export

---

## Risk Warnings

1. **Memecoins are extremely high risk** - 99%+ fail
2. **1 SOL is very small capital** - limited room for error
3. **Past patterns may not repeat** - markets evolve
4. **API costs may exceed profits** - monitor expenses
5. **No strategy guarantees profits** - only risk management

**Recommendation:** Paper trade for minimum 30 days before risking real capital.

---

## Conclusion

These improvements shift rossybot from a KOL copy-trading system (which suffers from latency and information decay) to an **independent on-chain momentum detection system** that uses KOL activity as secondary validation rather than primary signal.

The small capital manager ensures appropriate position sizing for 1 SOL, with strict risk limits that allow for the high failure rate of memecoin trading while providing asymmetric upside on winners.

**The core thesis changes from:**
> "Follow KOLs who have information edge"

**To:**
> "Detect momentum patterns that indicate organic buying pressure, validated by safety checks and bundle analysis, with KOL activity as confirmation bias"

This is a more robust approach that doesn't depend on being faster than other copy-traders.
