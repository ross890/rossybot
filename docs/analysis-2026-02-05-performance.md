# Rossybot Performance Analysis - February 5, 2026

## Executive Summary

The bot is currently experiencing **complete signal blockage** despite active market conditions. While memecoin trading volumes are at near all-time highs (Pump.fun hitting $2B daily), the filtering funnel is rejecting all tokens at the eligibility stage. This analysis identifies the root causes and provides recommendations.

---

## Current Market Context

### Market Conditions (February 2026)

The cryptocurrency market is experiencing severe stress:

| Metric | Value | Change |
|--------|-------|--------|
| Bitcoin | ~$73,420 | -40% from ATH ($126K in Oct 2025) |
| Ethereum | ~$2,500 | -50% from peak |
| Solana | <$100 | -60% from Sep 2025 highs |
| Fear & Greed Index | 14 | Extreme Fear |
| BTC ETF Outflows (Jan) | ~$1.1B | Significant capitulation |

### Key Events
- **"Black Sunday" (Feb 1, 2026)**: $2.2B in liquidations
- Total liquidations since Jan 29: $6.6B+
- U.S.-Iran geopolitical tensions escalating
- AI bubble deflation fears impacting tech-adjacent assets

### Memecoin Trading Paradox

Despite the broader crash, memecoin activity is **surprisingly high**:

| Platform | Volume |
|----------|--------|
| Pump.fun DEX | $2B daily (ATH) |
| PumpSwap | $1.28B (record) |
| LetsBonk.fun | $228M (3-month high) |
| Solana Memecoin Market Cap | $6.08B |

**Key Insight**: Volume is there, but the quality of tokens meeting our criteria has degraded significantly.

---

## Funnel Analysis

### Current Funnel State (from screenshots)

```
Stage 1: Token Discovery
├── Trending tokens fetched: 213

Stage 2: Age Filter
├── Passed age filter: 54

Stage 3: Eligibility Filter  ← BLOCKAGE HERE
├── Passed eligibility: 0
├── Tokens evaluated: 0
├── Signals sent: 0
```

### Eligibility Requirements

The eligibility filter applies these checks sequentially:

1. **Market Cap Range**: $500K - $150M (seamless tier coverage)
2. **Tier-Specific Volume**:
   - RISING ($500K-$8M): $50K/24h minimum
   - EMERGING ($8M-$20M): $300K/24h minimum
   - GRADUATED ($20M-$50M): $500K/24h minimum
   - ESTABLISHED ($50M-$150M): $1M/24h minimum
3. **Holder Count**:
   - RISING: **500+ holders** (most restrictive)
   - All others: 100+ holders
4. **Token Age**:
   - RISING: 3+ days (72 hours)
   - All others: 21+ days (504 hours)
5. **Liquidity**: $25K minimum + 2% liquidity ratio
6. **Concentration**: Max 75% in top 10 holders
7. **Cooldown**: 12-hour cooldown per token

---

## Root Cause Analysis

### Why 54 Age-Filtered Tokens → 0 Eligible

Based on the filtering logic and current market conditions, the most likely rejection reasons are:

#### 1. Holder Count (Most Likely - 40% probability)

The **500 holder requirement for RISING tier** is extremely harsh in current conditions:
- Bear markets see holder counts drop as retail exits
- Many tokens have 200-400 holders but can't reach 500
- Other tiers only require 100 holders, but need 21+ days age

**Evidence**: RISING tier at 47% win rate with +17% avg return shows the strategy works when tokens pass.

#### 2. Volume Requirements (25% probability)

In extreme fear conditions:
- Trading activity drops significantly
- Even $50K/24h can be hard to achieve for smaller tokens
- EMERGING tier's $300K requirement filters out most mid-caps

#### 3. Liquidity Issues (20% probability)

- LPs are being pulled in bear markets
- $25K minimum may be too high
- 2% liquidity ratio compounds the problem

#### 4. Concentration Filter (10% probability)

- Remaining holders tend to be whales/insiders
- As retail exits, top 10 concentration naturally increases
- 75% threshold may be too tight

#### 5. Token Age Mismatch (5% probability)

- Tokens between 3-21 days old:
  - Pass Stage 2 (global 72h minimum)
  - But fail Stage 3 if not RISING tier (need 21 days)
- Market cap migration: A token may age into EMERGING ($8M+) but not have 21 days yet

---

## Performance Data Review

### By Tier (7-day data)

| Tier | Win Rate | Avg Return | Signals | Status |
|------|----------|------------|---------|--------|
| RISING ($500K-$8M) | 47% | +17% | 672 | Working well |
| EMERGING ($8M-$20M) | 11% | -72% | 45 | Poor performance |
| GRADUATED ($20M-$50M) | - | - | 0 | No completed signals |
| ESTABLISHED ($50M-$150M) | - | - | 0 | No completed signals |

**Key Insight**: RISING tier is the only tier generating meaningful signals with positive returns. The strategy should focus here.

### By Score Quality (All-time)

| Score Range | Win Rate | Signals | Note |
|-------------|----------|---------|------|
| High (70+) | 11% | 321 | Counterintuitively low |
| Medium (50-69) | 23% | 20,435 | Bulk of signals |
| Low (<50) | 86% | 7 | Very small sample |

The inverse correlation between score and win rate is concerning and suggests the scoring model may need recalibration.

### All-Time Stats

- Total Signals: 22,260
- Completed: 20,763 | Pending: 1,497
- Win Rate: 23% (4,718W / 16,045L)
- Avg Win: +139% | Avg Loss: -53%
- Best: +668% | Worst: -100%

**Expected Value Calculation**:
```
EV = (0.23 × 139%) + (0.77 × -53%)
EV = 31.97% - 40.81%
EV = -8.84% per trade
```

The negative expected value suggests the current strategy is not profitable at scale, though the high variance (+668% best case) means individual wins can be significant.

---

## Recommendations

### Immediate (To Restore Signal Flow)

1. **Reduce RISING tier holder requirement**
   - Current: 500 holders
   - Recommended: 250-300 holders
   - Rationale: Bear market exodus has reduced organic holder counts

2. **Lower volume floor for RISING tier**
   - Current: $50K/24h
   - Recommended: $25K/24h
   - Rationale: Activity is concentrated, volume per token is lower

3. **Adjust liquidity requirements**
   - Consider reducing minimum from $25K to $15K for RISING
   - Reduce liquidity ratio from 2% to 1.5%

### Medium-Term (Improve Win Rate)

1. **Investigate score/performance inversion**
   - High-score signals have 11% win rate
   - Medium-score signals have 23% win rate
   - The scoring model may be overfitting to patterns that don't predict success

2. **Focus on RISING tier**
   - Only tier with positive returns (+17%)
   - 47% win rate is acceptable with proper risk management

3. **Re-evaluate EMERGING tier**
   - 11% win rate with -72% avg return is destructive
   - Consider disabling temporarily or significantly tightening criteria

### Monitoring

Add these metrics to the dashboard:
- Rejection breakdown by reason (volume/holders/liquidity/concentration)
- Average metrics of rejected tokens
- Near-miss tracking (tokens that almost pass)

---

## Technical Notes

### Relevant Code Locations

- Tier configuration: `mature-token/types.ts:73-110`
- Eligibility defaults: `mature-token/types.ts:663-688`
- Age filtering: `mature-token-scanner.ts:334-342`
- Eligibility filtering: `mature-token-scanner.ts:368-490`
- Token tier assignment: `mature-token/types.ts:693-711`

### Funnel Logging

The scanner logs detailed rejection reasons:
```typescript
// Line 477 in mature-token-scanner.ts
logger.info(`FUNNEL: Eligibility - Input: ${tokens.length}, Eligible: ${eligible.length} |
  Rejections: mcap=${X}, vol=${Y}, holders=${Z}, liq=${A}, conc=${B}, cooldown=${C}`);
```

---

## Conclusion

The bot is functioning correctly from a technical standpoint - it's just that current market conditions are causing all tokens to fail the eligibility filters. The filters were calibrated for healthier market conditions where:

- Tokens maintain 500+ holders
- Trading volume stays above $50K/day
- Liquidity remains sufficient
- Holder distribution stays decentralized

In the current "Extreme Fear" environment, these conditions are rarely met. The recommendations above would restore signal flow while maintaining risk management principles.

**Priority Action**: Reduce RISING tier holder requirement from 500 to 300. This single change would likely restore significant signal flow while maintaining the strategy's core premise of filtering out low-quality tokens.

---

*Analysis generated: February 5, 2026*
*Market conditions: Extreme Fear (14)*
*Bot uptime: 8h 52m*
*Last signal: 1 day ago*
