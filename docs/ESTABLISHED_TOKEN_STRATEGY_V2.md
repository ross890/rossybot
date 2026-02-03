# Rossybot v2: Established Token Strategy

> **Status**: APPROVED
> **Date**: February 2026
> **Supersedes**: Original new-token sniping strategy
> **Related**: `MATURE_TOKEN_SIGNAL_MODULE_PROPOSAL.md` (foundational research)

---

## Executive Summary

Pivot Rossybot from high-risk new memecoin sniping to swing trading established Solana memecoins with better risk-adjusted returns. This strategy prioritizes capital preservation while maintaining growth potential through disciplined position sizing and tighter risk management.

---

## 1. Goals & Expectations

### Portfolio Growth Targets

| Phase | Timeline | Weekly Target | Portfolio Growth |
|-------|----------|---------------|------------------|
| **Phase 1** | Weeks 1-4 | 20-30% | 2 SOL → 5-8 SOL |
| **Phase 2** | Months 2-3 | 15-20% | 8 SOL → 20-30 SOL |
| **Phase 3** | Month 4+ | 10-15% | 30+ SOL base, sustainable |

### Success Metrics

| Metric | Target |
|--------|--------|
| Win rate | >50% |
| Average winner | +30-50% |
| Average loser | -15-20% |
| Max portfolio drawdown | 20% |
| Reward:Risk ratio | ~2:1 |
| Signals per day | Max 10 (quality over quantity) |

---

## 2. Token Universe

### Three-Tier System

| Tier | Market Cap | Min Age | Min Daily Volume | Signal Allocation |
|------|------------|---------|------------------|-------------------|
| **Emerging** | $8-20M | 21 days* | $300K | 40% |
| **Graduated** | $20-50M | 21 days | $500K | 40% |
| **Established** | $50-150M | 21 days | $1M | 20% |

*Exception: 14 days acceptable if token has completed a verified "second pump" (proves sustained demand beyond launch)

### Universal Filters (All Tiers)

| Filter | Requirement |
|--------|-------------|
| Blockchain | Solana only |
| Mint authority | Disabled |
| Freeze authority | Disabled |
| Top 10 holder concentration | <50% |
| Liquidity pool | >$50K |
| Social presence | Active Twitter with engagement |

### Dynamic Token Discovery (Option B)

Tokens are automatically discovered and managed rather than manually curated:

```
DISCOVERY PIPELINE
│
├── Birdeye/DexScreener API
│   ├── Query tokens matching market cap range ($8M-$150M)
│   ├── Filter by age (21+ days)
│   ├── Filter by volume thresholds
│   └── Apply safety checks
│
├── Graduation Pipeline (from pump.fun)
│   ├── Track graduating tokens
│   ├── Add to 21-day watchlist queue
│   ├── Collect intelligence during waiting period
│   └── Auto-promote when criteria met
│
└── Active Universe
    ├── Auto-refresh every 6 hours
    ├── Remove tokens falling below criteria
    ├── Add new qualifiers
    └── Maintain 50-100 active tokens
```

---

## 3. pump.fun Repurposing

Instead of removing pump.fun monitoring, repurpose it as intelligence infrastructure:

### 3.1 Graduation Pipeline

```
pump.fun launch
    ↓
Token graduates to Raydium
    ↓
Add to "Watchlist Queue" (NOT tradeable yet)
    ↓
Collect data for 21 days:
├── Launch metrics (bundling, dev behavior)
├── Growth trajectory (organic vs manipulated)
├── KOL involvement history
├── Volume patterns
├── Holder retention
└── How it handled first dump
    ↓
Token meets criteria after 21 days
    ↓
Auto-promote to Active Universe with full history
```

### 3.2 Narrative/Trend Detection

```
pump.fun trending analysis
    ↓
Identify hot themes (AI, political, dog memes, etc.)
    ↓
Calculate "narrative strength" scores
    ↓
Apply bonus multiplier to matching established tokens
```

**Example:** If dog-themed tokens are launching frequently on pump.fun, apply +10-15% score bonus to BONK, WIF, etc.

### 3.3 Market Regime Indicator

| pump.fun Activity | Market Regime | Position Sizing Adjustment |
|-------------------|---------------|---------------------------|
| High launches + High volume | Bull / Risk-on | +20% position sizes |
| High launches + Low volume | Frothy / Caution | Standard sizes, tighter stops |
| Low launches + Low volume | Bear / Quiet | -20% position sizes |
| Low launches + High volume | Rotation to established | Best time for this strategy |

### 3.4 Graduate Quality Scoring

For tokens that came through pump.fun, track "graduation quality":

| Factor | Good Sign | Bad Sign | Score Impact |
|--------|-----------|----------|--------------|
| Time to graduate | 2-6 hours | <30 min | +/- 10 |
| Holders at graduation | 500+ | <100 | +/- 15 |
| Dev sold? | No | Yes (>50%) | +/- 20 |
| Bundle % | <10% | >25% | +/- 15 |
| First dump recovery | Bounced | Never recovered | +/- 10 |
| KOL involvement | Organic | Paid only | +/- 10 |

---

## 4. Entry Signals

### Primary Signals (High Weight)

| Signal | Description | Weight |
|--------|-------------|--------|
| KOL accumulation | Tracked KOL buys token in our universe | 25% |
| Social sentiment spike | +50% mentions in 4h window | 20% |
| Technical: RSI oversold | RSI <35 with price at support | 20% |
| Whale accumulation | Wallets >$50K adding positions | 15% |
| Volume breakout | 2x+ 7-day average volume | 20% |

### Secondary Signals (Confirmation)

| Signal | Description |
|--------|-------------|
| Holder count increasing | Net new holders in 24h |
| Narrative catalyst | Partnership, listing rumor, event |
| Correlation play | SOL pumping, sector rotation |
| pump.fun narrative match | Theme trending on pump.fun |

### Signal Requirements

- **Minimum score to alert:** 65/100
- **Minimum score for "strong buy":** 80/100
- **Required:** At least 1 primary + 1 secondary signal

---

## 5. Exit Strategy

### Stop Losses (Per Tier)

| Tier | Initial Stop | Time-Decay Stop (after 8h) |
|------|--------------|----------------------------|
| Emerging ($8-20M) | -20% | -15% |
| Graduated ($20-50M) | -18% | -12% |
| Established ($50-150M) | -15% | -10% |

### Take Profit Targets

| Level | Target | Action |
|-------|--------|--------|
| TP1 | +25-30% | Sell 40% of position |
| TP2 | +50-60% | Sell 40% of position |
| TP3 | +100%+ | Let remaining 20% ride with trailing stop |

### Trailing Stop

- Activates at +30% profit
- Trails at 20% below peak
- Example: Price hits +50%, stop moves to +30%

### Time-Based Exits

| Condition | Action |
|-----------|--------|
| Flat (<5% move) after 12h | Evaluate exit |
| Max hold time reached (48h) | Exit unless strong momentum |
| No volume for 6h | Tighten stop to -10% |

---

## 6. Position Sizing

### Base Portfolio: 2 SOL (scales as portfolio grows)

| Signal Strength | Position Size | Risk (with 20% SL) |
|-----------------|---------------|---------------------|
| Strong (80+ score) | 25% (0.5 SOL) | 5% (0.1 SOL) |
| Standard (65-79) | 15% (0.3 SOL) | 3% (0.06 SOL) |

### Rules

| Rule | Limit |
|------|-------|
| Max concurrent positions | 3 |
| Max portfolio deployed | 50% |
| Dry powder reserve | 50% (always) |

---

## 7. Risk Management

### Portfolio Level

| Control | Limit | Action When Hit |
|---------|-------|-----------------|
| Max drawdown | 20% | Pause trading 48h, review strategy |
| Daily loss limit | 10% | Stop trading for day |
| Weekly loss limit | 15% | Reduce position sizes 50% next week |

### Per-Trade Level

| Control | Limit |
|---------|-------|
| Max risk per trade | 5% of portfolio |
| Stop losses | Always required |
| Averaging down | Never allowed |

### Recovery Protocol

| Drawdown | Action |
|----------|--------|
| 15%+ down | Reduce position sizes by 50% |
| 20% down | Pause 48h, full strategy review |

---

## 8. Technical Analysis Integration

### New Indicators to Add

| Indicator | Use Case |
|-----------|----------|
| RSI (14) | Oversold/overbought detection |
| Support/Resistance | Entry/exit zones |
| Volume profile | Confirm breakouts |
| EMA (9/21) | Trend direction |
| MACD | Momentum confirmation |

### Technical Entry Conditions

| Setup | Entry Trigger |
|-------|---------------|
| Oversold bounce | RSI <35, price at support, volume uptick |
| Breakout | Price breaks resistance on 2x volume |
| Trend continuation | Price pulls back to EMA 21 in uptrend |

---

## 9. What Changes From Current Bot

### Removing

| Component | Reason |
|-----------|--------|
| New token sniping (EARLY_QUALITY track) | Opposite of strategy |
| Bundle detection | Less relevant at 21+ days |
| Insider detection (same-block buyers) | Irrelevant after 21 days |
| Dev wallet 48h tracking | Window already passed |
| Wide stop losses (-35% to -65%) | Too loose |
| High TP targets (100-1500%) | Unrealistic for established |
| 20-second scan cycles | Overkill |
| Conviction multipliers | Overcomplicated |
| ML model (old data) | Trained on wrong strategy |
| 50 signals/hour limit | Too many |

### Keeping

| Component | Modifications |
|-----------|---------------|
| KOL wallet tracking | Filter for our token universe only |
| Telegram alerts | Updated formatting |
| On-chain scoring | Adjusted weights |
| Social scoring | Enhanced |
| Basic safety checks | Simplified |
| Position manager | New TP/SL params |
| All infrastructure | Unchanged |

### Adding

| Component | Purpose |
|-----------|---------|
| Dynamic token discovery | Auto-maintain universe |
| Technical analysis | RSI, support/resistance |
| Three-tier system | Risk-appropriate sizing |
| pump.fun intelligence | Graduation pipeline, narratives |
| Market regime detection | Adjust risk dynamically |

### Repurposing

| Component | Old Use | New Use |
|-----------|---------|---------|
| pump.fun monitor | Trade new tokens | Graduation pipeline + narrative detection |
| Volume anomaly scanner | Find new tokens | Confirm breakouts on established |
| Holder growth scanner | Early token quality | Established token momentum |

---

## 10. Operational Parameters

### Scan Cycles

| Component | Old | New |
|-----------|-----|-----|
| Token scanning | 20 seconds | 60 seconds |
| KOL detection window | 2 hours | 6 hours |
| Position monitoring | 15 seconds | 60 seconds |
| Universe refresh | N/A | 6 hours |

### Signal Limits

| Limit | Old | New |
|-------|-----|-----|
| Signals per hour | 50 | 3 |
| Signals per day | 200 | 10 |
| Token cooldown | None | 12 hours |

---

## 11. Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)
- [ ] Implement dynamic token discovery
- [ ] Create three-tier classification system
- [ ] Update filters for market cap/age/volume
- [ ] Modify KOL tracking to filter for universe
- [ ] Update Telegram alert formatting

### Phase 2: pump.fun Repurposing (Week 2-3)
- [ ] Build graduation pipeline
- [ ] Implement 21-day watchlist queue
- [ ] Add narrative trend detection
- [ ] Create market regime indicator
- [ ] Add graduate quality scoring

### Phase 3: Technical Analysis (Week 3-4)
- [ ] Integrate RSI indicator
- [ ] Add support/resistance detection
- [ ] Implement volume confirmation
- [ ] Add EMA crossover signals

### Phase 4: Risk Management Updates (Week 4)
- [ ] Implement new stop loss levels
- [ ] Add time-decay stop tightening
- [ ] Create trailing stop logic
- [ ] Add position sizing rules
- [ ] Implement daily/weekly loss limits

### Phase 5: Testing & Optimization (Week 5+)
- [ ] Paper trading period
- [ ] Threshold optimization
- [ ] Performance tracking
- [ ] Strategy refinement

---

## 12. Success Criteria

Before going live with real capital:

| Criteria | Target |
|----------|--------|
| Paper trading period | 2 weeks minimum |
| Simulated win rate | >45% |
| Simulated avg return | >20% per winner |
| Max simulated drawdown | <25% |
| Signal quality | <3 false signals per day |

---

## Appendix A: Example Signal Flow

```
1. Universe Scan (every 60s)
   └── Check all tokens in active universe

2. Token Qualifies for Analysis
   ├── $EXAMPLE: $15M mcap, 25 days old, $400K volume
   └── Tier: Emerging

3. Signal Detection
   ├── Primary: KOL @trader123 bought $5K
   ├── Primary: RSI at 32 (oversold)
   └── Secondary: Holder count +8% in 24h

4. Score Calculation
   ├── KOL signal: 25 points
   ├── RSI oversold: 20 points
   ├── Holder growth: 10 points
   ├── On-chain health: 15 points
   └── Total: 70/100 (STANDARD BUY)

5. Position Sizing
   ├── Portfolio: 2 SOL
   ├── Signal strength: Standard (65-79)
   ├── Position: 15% = 0.3 SOL
   └── Risk: 0.06 SOL (3%)

6. Trade Parameters
   ├── Entry: Current price
   ├── Stop loss: -20% (Emerging tier)
   ├── TP1: +25% (sell 40%)
   ├── TP2: +50% (sell 40%)
   └── TP3: +100% (sell 20%, trailing)

7. Telegram Alert Sent
   └── User decides to execute or pass
```

---

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| Emerging | $8-20M market cap, higher risk/reward tier |
| Graduated | $20-50M market cap, balanced tier |
| Established | $50-150M market cap, lower risk tier |
| Universe | Active list of tokens we monitor and trade |
| Graduation Pipeline | pump.fun tokens waiting to enter universe |
| Market Regime | Current market conditions affecting strategy |
| Dry Powder | SOL held in reserve for opportunities |

---

*Strategy Document v2.0 - February 2026*
*Rossybot Established Token Trading System*
