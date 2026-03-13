# ROSSYBOT COMPLETE SYSTEM EXPORT
## For Deep Dive Analysis — March 2026

---

# TABLE OF CONTENTS
1. [Architecture Overview](#1-architecture-overview)
2. [Token Discovery Pipeline](#2-token-discovery-pipeline)
3. [Signal Evaluation Pipeline](#3-signal-evaluation-pipeline)
4. [Scoring System — Full Breakdown](#4-scoring-system)
5. [Safety & Scam Filtering](#5-safety--scam-filtering)
6. [Bundle Detection](#6-bundle-detection)
7. [Momentum Analysis](#7-momentum-analysis)
8. [Candlestick / Price Action](#8-candlestick--price-action)
9. [Market Cap Tier System](#9-market-cap-tier-system)
10. [Signal Routing (Dual-Track)](#10-signal-routing-dual-track)
11. [Position Sizing](#11-position-sizing)
12. [Entry & Exit Strategy](#12-entry--exit-strategy)
13. [Performance Tracking](#13-performance-tracking)
14. [Threshold Optimizer (Self-Learning)](#14-threshold-optimizer)
15. [Daily Auto-Optimizer](#15-daily-auto-optimizer)
16. [Configuration & Constants](#16-configuration--constants)
17. [External API Integrations](#17-external-api-integrations)
18. [Known Gaps & Potential Edge Improvements](#18-known-gaps--potential-edge-improvements)

---

# 1. ARCHITECTURE OVERVIEW

RossyBot is a Solana memecoin signal generator focused on **micro-cap tokens ($30K-$225K mcap)**. It discovers tokens from multiple sources, scores them across 5 weighted dimensions, applies safety gates, and sends buy signals via Telegram. It tracks performance for 48 hours and uses a daily optimizer to self-adjust thresholds based on win/loss data.

**Core Loop (every 20 seconds):**
```
Token Discovery → Quick Pre-Filter → Full Evaluation → Score → Route → Signal → Track → Learn
```

**Signal Types:**
- **BUY** — KOL-validated, highest confidence
- **DISCOVERY** — Pure on-chain metrics, no KOL
- **KOL_VALIDATION** — Previously discovered token now bought by KOL
- **ALPHA_WALLET** — Tracked smart money wallet bought

**Current Mode:** Learning mode (relaxed thresholds to collect training data)

---

# 2. TOKEN DISCOVERY PIPELINE

## 2.1 Discovery Sources (6 sources)

| Source | Method | What It Finds |
|--------|--------|---------------|
| **DexScreener Boosted** | Poll boosted/trending tokens | Tokens paying for visibility |
| **DexScreener Profiles** | Poll latest claimed profiles | Tokens with verified teams |
| **Jupiter New Pairs** | Poll Jupiter for new listings | Fresh liquidity pool migrations |
| **GMGN Trending** | Poll gmgn.ai swaps ranking | Smart money activity leaders |
| **Alpha Wallets** | Monitor tracked wallet txns | Smart money buys in real-time |
| **Pump.fun Dev Tracker** | Track successful Pump.fun devs | Repeat launchers with >20% success rate |

## 2.2 Discovery Flow
```
Source detects token
  → Dedup check (skip if signaled in last 30 min)
  → Quick scam pre-filter (honeypot check)
  → Surge detection (momentum spike priority)
  → Fetch metrics (price, mcap, liquidity, holders, age)
  → Exclusion filter (stablecoins, LP tokens, protocol tokens, wrapped tokens)
  → Tier gate (must be in enabled mcap tier)
  → Full evaluation pipeline
```

## 2.3 Scan Configuration
- **Scan interval:** 20 seconds
- **Signal cooldown:** 30 minutes (skip recently signaled tokens)
- **Max on-chain signals per cycle:** 3
- **Surge check limit:** 15 candidates max per cycle
- **KOL activity window:** 2 hours
- **Discovery signal expiry:** 24 hours

## 2.4 Exclusion Patterns (Auto-Rejected)
- Stablecoins (USDC, USDT, BUSD, or price $0.95-$1.05)
- LP/Pool tokens
- Protocol tokens (Orca, Jupiter, Raydium, Marinade, etc.)
- Yield tokens (JitoSOL, mSOL, bSOL, stSOL)
- Wrapped tokens (wSOL, wETH, wBTC)
- Synthetic stocks (TSLAX, NVDAX, etc.)

---

# 3. SIGNAL EVALUATION PIPELINE

Full sequential evaluation when a token passes discovery:

```
1. Quick Scam Pre-Filter ──────────── Contract-level honeypot check
2. Surge Detection ────────────────── Momentum spike → priority queue
3. Metrics Retrieval ──────────────── Price, mcap, liquidity, holders, age
4. Exclusion Checks ───────────────── Block stablecoins, LP tokens, etc.
5. Tier Filtering ─────────────────── Market cap tier gating
6. Safety Check ───────────────────── Token safety analysis (FIRST gate)
7. Scam Filter ────────────────────── Full 4-stage scam detection
8. RugCheck Hard Gate ─────────────── DANGER level = instant reject
9. Compound Rug Detection ─────────── 3+ weak indicators = reject
10. On-Chain Scoring ──────────────── 5-component weighted score
11. Social Verification ───────────── DexScreener social presence bonus
12. Surge Bonus ───────────────────── Momentum spike multiplier (+5-15 pts)
13. Candlestick Analysis ──────────── Price pattern bonus/penalty (±10 pts)
14. Dual-Track Routing ────────────── PROVEN_RUNNER vs EARLY_QUALITY
15. Final Threshold Check ─────────── Score + recommendation gates
16. Signal Generation ─────────────── BUY / DISCOVERY / KOL_VALIDATION / ALPHA
17. Telegram Send ─────────────────── Signal delivered to user
18. Performance Tracking ──────────── Record metrics for ML learning
```

## 3.1 Hard Gates (Non-Negotiable Rejections)

| Gate | Condition | Action |
|------|-----------|--------|
| Safety Block | Safety score below dynamic minimum | REJECT |
| RugCheck DANGER | RugCheck action = AUTO_SKIP | REJECT |
| Compound Rug | 3+ rug indicators combined | REJECT |
| Critical Risk | Risk level = CRITICAL | REJECT |
| Too Early | Token age < 2 minutes | REJECT |
| Candlestick | Candle score ≤ -20 (production only) | REJECT |
| Honeypot | Cannot sell token | REJECT |

## 3.2 Three Signal Pathways

**PATH A: KOL-Triggered**
- KOL wallet activity detected + token passes all gates
- Signal Type: BUY
- Position Size: 100% × KOL weight multiplier

**PATH A2: Alpha Wallet**
- Tracked smart money wallet bought token
- Signal Type: ALPHA_WALLET
- Position Size: 75% × alpha weight × (1.25 if 2+ wallets)
- No score gate (smart money buying IS the signal)

**PATH B: On-Chain Momentum Only**
- No KOL/alpha activity detected
- Signal Type: DISCOVERY
- Pure on-chain metrics evaluated
- Can upgrade to KOL_VALIDATION if KOL buys within 24h

---

# 4. SCORING SYSTEM

## 4.1 Composite Score Formula

```
Total Score (0-100) =
  (Momentum      × 0.05) +    // 5%  — anti-predictive at entry, kept for learning
  (Safety        × 0.30) +    // 30% — loss prevention edge
  (Bundle Safety × 0.25) +    // 25% — insider detection
  (Market Struct × 0.35) +    // 35% — strongest predictor (holder count +0.37 correlation)
  (Timing        × 0.05)      // 5%  — binary gate, redistributed from 15%
```

**Plus bonuses applied to adjusted total:**
- Social verification: +0 to +25 points
- Surge detection: +5 to +15 points
- Candlestick analysis: -10 to +10 points

## 4.2 Market Structure Score (35% weight — HIGHEST)

**This is the most important component. Holder count has +0.37 correlation with wins.**

### Liquidity (0-20 points)
| Range | Points | Rationale |
|-------|--------|-----------|
| $5K-$15K | 20 | OPTIMAL — high volatility, tradeable |
| $15K-$30K | 16 | Good, less upside |
| $2.5K-$5K | 14 | Risky but high potential |
| $30K-$75K | 10 | Reduced upside |
| $75K+ | 5 | Limited upside for micro-cap |
| <$2.5K | 0 | Too illiquid |

### Holder Count (0-40 points) — STRONGEST FACTOR
| Range | Points |
|-------|--------|
| ≥100 holders | 40 |
| ≥300 | 35 |
| ≥150 | 28 |
| ≥75 | 20 |
| ≥15 | 12 |
| ≥10 | 5 |

### Top 10 Concentration (0-25 points)
| Range | Points |
|-------|--------|
| ≤45% | 25 (well distributed) |
| ≤50% | 20 |
| ≤80% | 12 |
| >80% | 0 (rejection threshold) |

### Volume/MCap Ratio (0-15 points)
| Range | Points |
|-------|--------|
| ≥0.5 | 15 (high velocity) |
| ≥0.2 | 12 |
| ≥0.1 | 8 |
| ≥0.05 | 4 |

## 4.3 Safety Score (30% weight)

**Base: 100 points, penalties are subtracted**

| Factor | Points | Condition |
|--------|--------|-----------|
| Mint authority enabled | -15 | Can mint new tokens |
| Freeze authority enabled | -12 | Can freeze accounts |
| Top 10 concentration >70% | -12 | High rug risk |
| Deployer holding >10% | -10 | Creator still holding |
| Token age <15 min | -5 | Very new |
| Honeypot risk | -30 | Cannot sell |
| Low RugCheck (<50) | -15 | Failed rug check |
| Medium RugCheck (50-70) | -5 | Marginal rug check |
| LP not locked | -15 | Rug risk — LP withdrawable |
| LP locked | +5 | Bonus — time-delayed rug resistance |
| LP burned | +10 | Bonus — strongest rug resistance |
| Insider risk >70 | -20 | High insider concentration |
| Insider risk 50-70 | -10 | Moderate insider concentration |

## 4.4 Bundle Safety Score (25% weight)

**Calculated as: 100 - bundleRiskScore (inverted: higher = safer)**

Bundle risk factors:
| Factor | Risk Points | Condition |
|--------|-------------|-----------|
| Same-block buyers ≥10 | +35 | CRITICAL coordinated buying |
| Same-block buyers ≥5 | +25 | HIGH coordinated buying |
| Same-block buyers ≥3 | +15 | MEDIUM coordinated buying |
| Insider supply >60% | +35 | CRITICAL concentration |
| Insider supply >40% | +25 | HIGH concentration |
| Insider supply >25% | +15 | MEDIUM concentration |
| Deployer-funded ≥5 | +20 | Deployer funding snipers |
| Deployer-funded ≥2 | +10 | Some deployer funding |
| Fresh wallets ≥70% | +15 | Suspicious new wallets |
| Fresh wallets ≥50% | +8 | Elevated new wallets |
| Distribution evenness ≥0.85 | +25 | Artificial uniformity (Bubblemaps-style) |
| Distribution evenness ≥0.65 | +15 | Suspicious uniformity |

**IMPORTANT: Bundle detection is INFORMATIONAL ONLY — it never blocks signals by itself**

## 4.5 Momentum Score (5% weight — DEMOTED)

**Demoted from 20% because performance data shows -0.04 correlation (anti-predictive at entry)**

### Buy Pressure (0-25 points)
- Buy/sell ratio component (0-15): ratio ≥1.8 = 15pts, ≥1.2 = 12pts, ≥0.9 = 8pts
- Net buy pressure component (0-10): pressureRatio × 20, capped at 10

### Volume Momentum (0-25 points)
- Volume velocity (0-15): ≥25% of hourly = 15pts, ≥12% = 12pts
- Volume acceleration (0-10): >0.5 = 10pts, >0.2 = 7pts

### Trade Quality (0-25 points)
- Unique buyers (0-10): ≥20 = 10pts, ≥10 = 7pts
- Trade size distribution (0-10): low small-trade ratio = organic
- Large trade presence (0-5): ≥5 large trades = 5pts

### Holder Growth (0-25 points)
- Growth rate (0-15): ≥2.0/min = 15pts, ≥1.0/min = 11pts
- Absolute count (0-10): ≥500 = 10pts, ≥200 = 7pts

## 4.6 Timing Score (5% weight — DEMOTED)

| Token Age | Points | Rationale |
|-----------|--------|-----------|
| <2 min | 0 | Hard blocked elsewhere |
| 2-5 min | 30 | Very early, risky |
| 5 min - 12 hours | 60 | Tradeable window, neutral |
| 12h - 2 days | 40 | Late, reduced |
| >2 days | 20 | Stale |

## 4.7 Score-Based Recommendations

| Score Range | Recommendation | Action |
|-------------|----------------|--------|
| ≥75 | STRONG_BUY | Generate signal (2+ bullish, 0 bearish) |
| 55-74 | BUY | Generate signal (≤2 bearish) |
| 30-54 | WATCH | Generate signal (monitored) |
| 20-29 | AVOID | Reject token |
| <20 | STRONG_AVOID | Reject token |

**Learning mode:** Only blocks STRONG_AVOID (score <20). AVOID tokens can still pass if numerical threshold met.

## 4.8 Social Verification Bonus (+0-25 points)

| Factor | Points |
|--------|--------|
| Twitter | +7 |
| Claimed DexScreener profile | +5 |
| Telegram | +4 |
| Website | +3 |
| Description >20 chars | +2 |
| Boosts (1-2) | +1-2 |
| Discord | +1 |

## 4.9 Surge Detection Bonus (+0-15 points)

| Surge Confidence | Points |
|-----------------|--------|
| HIGH (multi-surge or extreme) | +15 |
| MEDIUM (single type, moderate) | +10 |
| LOW (weak signal) | +5 |

Surge types: VOLUME_SURGE (3x+), BUY_SURGE (5+ buys/min at 3:1), PRICE_SURGE (5%+/min), MULTI_SURGE

## 4.10 Candlestick Bonus (±10 points)

```
candlestickBonus = clamp(-10, +10, round(candleScore / 5))
```
- Score ≤ -20: BLOCKED in production
- Applied as direct addition to adjusted total

## 4.11 Risk Level Determination

| Level | Condition | Action |
|-------|-----------|--------|
| CRITICAL | Bundle CRITICAL, or bundle risk ≥ max+20, or safety < min-15 | HARD REJECT |
| HIGH | Bundle risk ≥ max, or (score <50 + HIGH risk) | Production rejects |
| MEDIUM | Score 40-54 | Acceptable with warnings |
| LOW | Score 55-74 | Good signal |
| VERY_LOW | Score ≥75 + clean bundle + good safety | Excellent signal |

---

# 5. SAFETY & SCAM FILTERING

## 5.1 Token Safety Checker

**Philosophy: Permissive — only blocks extremely dangerous tokens (safety < 10)**

Safety checks performed (in order):
1. Mint & freeze authority status
2. Holder concentration analysis (top 10, deployer holding)
3. Token age check
4. LP lock/burn status via RugCheck API
5. RugCheck score integration
6. Honeypot risk detection
7. Insider activity analysis (same-block buyers, deployer-funded wallets)

**Only HONEYPOT_RISK is a hard block. All other flags are informational.**

## 5.2 Scam Filter (4-Stage Pipeline)

```
Stage 1: Honeypot Detection → INSTANT REJECT if can't sell
Stage 2: Contract Analysis → REJECT if known scam template, active authorities (>30min)
Stage 3: Bundle Analysis → FLAG/REJECT if 25%+ bundled supply + rug history
Stage 4: Dev Wallet Behaviour → REJECT if sold 10%+ AND transferred to CEX
Stage 5: Rug History → REJECT if 3+ wallets with prior rug involvement
```

## 5.3 Compound Rug Detection

Indicators counted (each adds +1):
- 2+ scam flags: +1
- 4+ scam flags: +1 extra
- Bundle rug history: +2
- >25% bundled supply: +1
- Dev transferred to CEX: +2
- Dev sold >10% in 48h: +1
- Both authorities still enabled: +1
- Safety score <40: +1

**BLOCK at 3+ indicators. CAUTION at 2.**

---

# 6. BUNDLE DETECTION

## 6.1 Analysis Method

Gets 100 recent transactions via Helius, analyzes first 30 transaction details:
- Extract early buyer wallets
- Estimate insider supply percentage
- Analyze funding patterns
- Calculate distribution evenness (Bubblemaps-style coefficient of variation)

## 6.2 Distribution Evenness Score

```
CV = stddev(top20Holdings) / mean(top20Holdings)
evennessScore = clamp(0, 1, 1 - CV/1.2)

High score (>0.85) = artificial (bot-created uniform distribution)
Low score (<0.3) = organic (natural variance)
```

## 6.3 Confidence & Risk Level

| Risk Score | Confidence | Risk Level |
|------------|------------|------------|
| ≥70 | HIGH | CRITICAL |
| ≥50 | HIGH | HIGH |
| ≥30 | MEDIUM | MEDIUM |
| ≥15 | LOW | LOW |
| <15 | NONE | LOW |

**CRITICAL: Bundle detection is INFORMATIONAL ONLY — it is used for scoring but never directly blocks signals.**

---

# 7. MOMENTUM ANALYSIS

## 7.1 Data Sources

**Primary:** DexScreener API (free tier)
- 1m, 5m, 1h, 24h volume and transaction data
- Price changes at all timeframes
- Buy/sell transaction counts

**Estimation Methods (when data unavailable):**
- Buy volume: 60% of total (estimated)
- Sell volume: 40% of total (estimated)
- Unique buyers: 60% of buy transactions
- New holders: 2% of total holder count per 5 minutes

## 7.2 Surge Detection (Ultra-Early Pump Signals)

| Surge Type | Threshold | Meaning |
|------------|-----------|---------|
| VOLUME_SURGE | 3x normal 1-min volume | Sudden volume spike |
| BUY_SURGE | 5+ buys/min at 3:1+ ratio | Coordinated buying |
| PRICE_SURGE | 5%+ price increase/min | Rapid price appreciation |
| MULTI_SURGE | Multiple types simultaneously | Highest confidence |

**Confidence:** HIGH if multi-surge or extreme values, MEDIUM for single moderate, LOW for weak

## 7.3 Minimum Momentum Filter (Quick Pre-Check)

Must pass ALL:
- buyCount5m ≥ 3
- volume5m ≥ $300
- buySellRatio ≥ 1.0
- uniqueBuyers5m ≥ 3

## 7.4 Cache TTL: 15 seconds (for fast surge detection)

---

# 8. CANDLESTICK / PRICE ACTION

- Source: `candlestickAnalyzer.analyze(tokenAddress, '5m')`
- Score range: -50 (bearish) to +50 (bullish)
- Applied as: ±10 bonus/penalty (score / 5, clamped)
- Production gate: Score ≤ -20 blocks signal
- Learning mode: Gate bypassed

---

# 9. MARKET CAP TIER SYSTEM

| Tier | Market Cap | Enabled | Min Liquidity | Min Safety | Position Multiplier |
|------|-----------|---------|---------------|------------|---------------------|
| **MICRO** | $30K-$225K | YES | $500 | 20 | 1.0x (PRIMARY) |
| **RISING** | $225K-$1M | YES | $2,000 | 25 | 0.5x (SECONDARY) |
| EMERGING | $1M-$5M | NO | $5,000 | 30 | 0x |
| GRADUATED | $5M-$25M | NO | $15,000 | 35 | 0x |
| ESTABLISHED | $25M-$150M | NO | $30,000 | 35 | 0x |

**Rationale:** Micro-cap $30K-$225K is the sweet spot. Larger caps have institutional bot competition reducing edge.

---

# 10. SIGNAL ROUTING (DUAL-TRACK)

## PROVEN_RUNNER Track (Token Age ≥90 min)
- Trust model: Time = proof of survival
- Min holder growth: 0.01 (1% growth rate)
- Safety requirement: Standard
- Target: 20-40 signals/day

## EARLY_QUALITY Track (Token Age 2-45 min)
- Trust model: KOL validation optional
- Min safety: 30 (learning) or 45 (production)
- Max bundle risk: 45 (no learning discount)
- Target: 10-20 signals/day

## Dead Zone (45-90 min)
- Routes to PROVEN_RUNNER with moderate requirements
- Allows transition-zone tokens if metrics strong

---

# 11. POSITION SIZING

## On-Chain Signal
```
base = tierConfig.positionSizeMultiplier × defaultPositionSizePercent (2%)
final = base × (1.5x for STRONG, 1.0x for MODERATE/WEAK)
capped at tier max
```

## KOL Signal
```
base = defaultPositionSizePercent (2%)
final = base × (1.5 if score≥90, 1.25 if score≥80) × kolWeight
  × (0.5 if LOW_LIQUIDITY, 0.75 if NEW_TOKEN)
capped at 3%
```

## Alpha Wallet Signal
```
base = defaultPositionSizePercent × 0.75 (1.5%)
final = base × alphaWeight × (1.25 if 2+ wallets)
  × (0.5 if LOW_LIQUIDITY, 0.75 if NEW_TOKEN)
capped at 2.5%
```

## Discovery Signal
```
base = defaultPositionSizePercent × 0.5 (1%)
final = base × (1.25 for A-grade, 1.0 for B, 0.75 for C)
  × (0.5 if LOW_LIQUIDITY, 0.75 if NEW_TOKEN)
capped at 1.5%
```

---

# 12. ENTRY & EXIT STRATEGY

## 12.1 Entry
- **Entry Zone:** Current price ±5%
- **ATH Detection:** Warns if near ATH, suggests pullback entry (10-20%)
- **Slippage:** 10% default (1000 bps) for memecoins via Jupiter
- **Execution:** Jupiter primary, Raydium fallback

## 12.2 Position Manager Exit System (7-Tier Priority)

The position manager runs every **15 seconds** and checks exits in this priority order:

### EXIT 1: MCAP Multiple Exit (Overextension Protection)
```
IF current_mcap >= entry_mcap × 4x → FULL EXIT
Rationale: Meme coins at 4x entry MCAP = overextended, dump risk high
```

### EXIT 2: Stop Loss (by Signal Category)
| Category | Stop Loss | Action |
|----------|-----------|--------|
| ULTRA_CONVICTION (3+ KOLs) | -65% | Full exit |
| HIGH_CONVICTION (2 KOLs) | -55% | Full exit |
| SCORE_90_PLUS | -45% | Full exit |
| KOL_VALIDATION | -40% | Full exit |
| MANUAL_CONFIRM | -35% | Full exit |

### EXIT 3: Time Decay Stop (Aging Losers)
```
After N hours without profit, tighten stop loss:
  ULTRA:  6h + still down >-40% → tighten to -50%
  HIGH:   4h + still down >-35% → tighten to -45%
  SCORE:  3h + still down >-30% → tighten to -35%
  KOL:    2h + still down >-25% → tighten to -30%
  MANUAL: 1h + still down >-20% → tighten to -25%
```

### EXIT 4: Trailing Stop (Protect Winners)
```
IF peak_pnl >= +40% AND retrace >= 25% of peak → FULL EXIT
Example: Peak +50%, now at +35% = 30% retrace → trigger
```

### EXIT 5: Momentum Fade (Early Exit on Fading Signal)
```
IF pnl >= +15% AND NOT already_took_tp1 AND:
  - sell/buy ratio > 1.5x (more sells than buys)
  OR
  - volume acceleration < -0.3 (declining interest)
→ PARTIAL EXIT (50%)
```

### EXIT 6: Take Profit 1 (First Target — Partial)
| Category | TP1 Target | Sell % |
|----------|------------|--------|
| ULTRA_CONVICTION | +400% | 30% |
| HIGH_CONVICTION | +300% | 35% |
| SCORE_90_PLUS | +200% | 40% |
| KOL_VALIDATION | +150% | 45% |
| MANUAL_CONFIRM | +100% | 50% |

### EXIT 7: Take Profit 2 (Final Exit — Only After TP1 Hit)
| Category | TP2 Target | Sell % |
|----------|------------|--------|
| ULTRA_CONVICTION | +1500% | Remaining 70% |
| HIGH_CONVICTION | +800% | Remaining 65% |
| SCORE_90_PLUS | +500% | Remaining 60% |
| KOL_VALIDATION | +350% | Remaining 55% |
| MANUAL_CONFIRM | +250% | Remaining 50% |

## 12.3 Signal-Level Targets (Displayed in Telegram)

These are the targets shown on signals (simpler than position manager):
- **Take Profit 1:** +50% (price × 1.5)
- **Take Profit 2:** +150% (price × 2.5)
- **Stop Loss:** -30% (price × 0.7)
- **Time Limit:** 72 hours

## 12.4 Performance Tracking Targets (Learning System — Different Again)
- **WIN condition:** Max return hits +100% (2x) at any point during 48h tracking
- **LOSS condition:** Price hits -40% stop OR ends below entry after 48h
- **EXPIRED_PROFIT:** Timed out at 48h but final_return > 0% (profitable but didn't 2x)
- **Tracking interval:** Every 15 minutes for 48 hours

**NOTE: There are 3 different exit/target systems operating simultaneously:**
1. Position manager (real trades, 7-tier, 15s monitoring)
2. Signal targets (Telegram display, simpler)
3. Performance tracker (learning system, 48h window, binary WIN/LOSS/EXPIRED_PROFIT)

---

# 13. PERFORMANCE TRACKING

## 13.1 Tracking Mechanics

```
Every 15 minutes for 48 hours:
  1. Fetch current price from DexScreener
  2. Calculate % change from entry
  3. Record snapshot
  4. Check milestone thresholds (+50%, +100%, +200%, -20%, -40%)
  5. Determine if exit conditions met
  6. Update interval returns (1h, 4h, 24h)
  7. Finalize outcome if conditions met
```

## 13.2 Outcome Classification

| Outcome | Condition |
|---------|-----------|
| WIN | Max return ≥ +100% at any point |
| LOSS | Hit -40% stop OR ended below entry (never hit +100%) |
| EXPIRED_PROFIT | Timed out (48h) with final_return > 0% (but max < +100%) |
| PENDING | Still tracking |

## 13.3 Metrics Recorded Per Signal

Entry data:
- All 5 component scores (momentum, safety, bundle, market structure, timing)
- Market metrics (liquidity, mcap, holder count, age, top10 concentration)
- Buy/sell ratio, unique buyers
- Signal track (PROVEN_RUNNER / EARLY_QUALITY)
- Signal strength (STRONG / MODERATE / WEAK)

Outcome data:
- Returns at 1h, 4h, 24h intervals
- Max return, min return, final return
- Hit stop loss / take profit flags

## 13.4 Factor Correlation Analysis

Analyzes which metrics best predict wins:
```
Factors analyzed:
- momentum_score, onchain_score, safety_score, bundle_risk_score
- entry_liquidity, entry_token_age, entry_holder_count
- entry_top10_concentration, entry_buy_sell_ratio, entry_unique_buyers

For each: winningAvg, losingAvg, separation, correlation
```

**Key findings from data:**
- Holder count: **+0.37 correlation** (strongest positive predictor)
- Momentum: **-0.04 correlation** (anti-predictive — high momentum at entry = late)
- Safety: Strong loss prevention (negative correlation with losses)

---

# 14. THRESHOLD OPTIMIZER

## 14.1 Default Thresholds (March 2026 Recalibrated)

```
minMomentumScore:       15    (soft gate, momentum only 5% weight)
minOnChainScore:        35    (lowered from 40, social/surge bonuses help)
minSafetyScore:         30    (lowered from 40, RugCheck hard gate catches dangers)
maxBundleRiskScore:     55    (raised from 50, bundling normal on micro-caps)
minLiquidity:           500   (aligned with MICRO tier)
maxTop10Concentration:  80    (aligned with micro-cap natural concentration)
```

## 14.2 Self-Learning Mechanics

```
Target Win Rate: 30%
Min Data Points: 20 completed signals before any adjustment
Max Change Per Cycle: 25% (threshold optimizer) / 5% (daily optimizer)
Optimization Window: Last 7-14 days

Decision Logic:
  Win rate < 27% → TIGHTEN thresholds (stricter filtering)
  Win rate > 38% → LOOSEN thresholds (more signals)
  Win rate 27-38% → FINE-TUNE only
```

## 14.3 Sanity Bounds (Hard Limits)

```
minMomentumScore:       [5, 70]
minOnChainScore:        [30, 75]
minSafetyScore:         [40, 80]
maxBundleRiskScore:     [20, 60]
minLiquidity:           [$5,000, $50,000]
maxTop10Concentration:  [30%, 70%]
```

## 14.4 Hot-Reload System

When thresholds change:
```
thresholdOptimizer.setThresholds()
  → Updates in-memory singleton
  → syncToOnChainEngine() pushes to on-chain scoring engine
  → Signal generator reads fresh values next eval cycle
  → No process restart needed
```

---

# 15. DAILY AUTO-OPTIMIZER

**Schedule:** 6:00 AM AEDT daily (Australia/Sydney timezone)

## Daily Cycle:
```
1. Query last 7 days of WIN/LOSS/EXPIRED_PROFIT signals
2. Require 50+ completed signals (skip if insufficient)
3. Analyze 6 factors: momentum, onchain, safety, bundle risk, liquidity, top10 concentration
4. Calculate winAvg vs lossAvg for each factor
5. Get tier performance breakdown
6. Determine tighten/loosen/fine-tune based on win rate vs 30% target
7. Calculate new thresholds within 5% change limit per cycle
8. Apply changes + sync to all consumers
9. Save to database
10. Send Telegram report
```

## Factor Analysis
```
For each factor:
  winAvg = average value in winning trades
  lossAvg = average value in losing trades
  diff = winAvg - lossAvg

  If diff > 10 for "higher better" factors → RAISE threshold
  If diff < -10 for "lower better" factors → LOWER threshold
```

## Liquidity Special Treatment
```
maxChangePercent: 10% (vs 5% for others)
adjustmentFactor: 0.15 (vs 0.1 for others)
Reason: Liquidity is strong differentiator in micro-cap
```

---

# 16. CONFIGURATION & CONSTANTS

## Token Screening (Micro-Cap Focused)
```
MIN_MARKET_CAP:         $30,000
MAX_MARKET_CAP:         $1,000,000
MIN_24H_VOLUME:         $2,000
MIN_VOLUME_MCAP_RATIO:  0.01 (1%)
MIN_HOLDER_COUNT:       10
MAX_TOP10_CONCENTRATION: 80%
MIN_LIQUIDITY_POOL:     $500
MIN_TOKEN_AGE_MINUTES:  1
```

## Trading
```
MAX_MEMECOIN_PORTFOLIO_PERCENT: 20%
DEFAULT_POSITION_SIZE_PERCENT:  2%
MAX_SIGNALS_PER_HOUR:           30 (MODERATE only; STRONG bypass)
MAX_SIGNALS_PER_DAY:            150 (MODERATE only; STRONG bypass)
MIN_SCORE_BUY_SIGNAL:           55
MIN_SCORE_WATCH_SIGNAL:         30
LEARNING_MODE:                  true (relaxed filtering)
ENABLE_EARLY_STRATEGY:          true (5-90 min tokens)
ENABLE_MATURE_STRATEGY:         false (micro-cap focus only)
```

## Pump.fun Dev Tracker
```
DEV_MIN_LAUNCHES:               5
DEV_MIN_SUCCESS_RATE:           0.20 (20%)
DEV_MAX_RUG_RATE:               0.50 (50%)
DEV_MIN_BEST_PEAK_MC:          $200,000
DEV_STATS_UPDATE_INTERVAL:     30 minutes
DEV_DISCOVERY_INTERVAL:        24 hours
```

## Rate Limiting
```
DexScreener:  30 req/min, 2s min delay
RugCheck:     30 req/min, 2s min delay
Solana RPC:   10 req/min, 6s min delay
Helius RPC:   5 req/sec (conservative)
```

---

# 17. EXTERNAL API INTEGRATIONS

| Service | Purpose | Auth | Rate Limit |
|---------|---------|------|------------|
| **DexScreener** | Token data, prices, socials, trending | Free, no key | 30/min |
| **Helius RPC** | Holder data, authorities, tx history, bundles | API key | 5/sec |
| **RugCheck** | LP status, honeypot, risk scoring | Free, no key | 30/min |
| **Jupiter** | DEX aggregator — swap execution | Free | — |
| **GMGN** | Trending token discovery (smart money) | Free | — |
| **Solscan** | Dev wallet tracking, token activity | API key | — |
| **Pump.fun** | Bonding curve status, migration progress | Free | — |
| **Solana RPC** | General blockchain queries | Free | 10/min |

---

# 18. KNOWN GAPS & POTENTIAL EDGE IMPROVEMENTS

## What's Working
- Holder count (+0.37 correlation) is genuine signal
- Safety scoring prevents catastrophic losses
- RugCheck hard gate catches real dangers
- Micro-cap focus ($30K-$225K) avoids institutional competition
- Self-learning optimizer adapts thresholds from real data
- Hot-reload ensures optimizer changes take effect immediately

## Auto-Trader Signal Categories & Confirmation Windows

| Category | Trigger | Confirmation | Auto-Buy? |
|----------|---------|-------------|-----------|
| ULTRA_CONVICTION | 3+ KOLs buying | 0 seconds | YES |
| HIGH_CONVICTION | 2 KOLs buying | 0 seconds | YES |
| SCORE_90_PLUS | 1 KOL + score ≥90 | 0 seconds | YES |
| KOL_VALIDATION | 1 KOL | 120 seconds | Wait for manual |
| MANUAL_CONFIRM | Discovery/other | 300 seconds | Wait for manual |

**Win rate gate:** 50% win rate required for auto-buy to be enabled.

## Smart Money Auto-Discovery Flywheel

The bot auto-discovers profitable traders from on-chain data:

```
Sources:
├── Early buyers (from winning token transactions)
├── High-volume traders (≥10 SOL per trade)
├── Raydium traders (high ROI over time)
└── Whale tracker (>10 SOL movers)

Promotion Criteria:
  Win rate ≥ 35% (great for memecoins)
  Min profit: 1+ SOL
  Min trades: 3
  Min unique tokens: 2

Rejection Criteria:
  Win rate < 15%
  Total loss > -25 SOL

Win Definition: 100% ROI (2x)
Evaluation Cycle: Every 30 minutes
Trade Scan Cycle: Every 5 minutes
```

## What's Questionable / Potential Improvements

### Scoring
1. **Momentum is anti-predictive (-0.04)** — Currently kept at 5% weight "for learning" but may be pure noise. Could consider removing entirely or inverting (low momentum = early entry opportunity?)
2. **Social bonus (+25 pts)** is large enough to push borderline tokens over threshold — is social presence truly predictive of micro-cap wins, or just legitimacy theater?
3. **Holder count scoring is step-function** (5→12→20→28→35→40) rather than continuous — creates cliff effects at boundaries
4. **Volume/MCap ratio** capped at 15 points but micro-caps can have extreme ratios — missing signal in velocity data?
5. **Bundle detection is informational only** — 25% of composite score comes from bundle safety but it "never blocks" — is this the right design?

### Entry/Exit
6. **Fixed take profit (+50%/+150%) and stop loss (-30%)** — No dynamic adjustment based on volatility, market conditions, or score quality
7. **No trailing stop** — Once TP1 hit, no mechanism to ride further upside
8. **No partial exits** — All-or-nothing at TP levels
9. **ATH detection suggests pullback but doesn't enforce it** — Signals still sent near ATH with a warning
10. **72h time limit on signals** but **48h tracking** — 24h gap where performance isn't tracked

### Discovery
11. **GMGN trending** finds tokens AFTER they're already trending — potentially late entry
12. **No Telegram/Twitter social sentiment analysis** — Missing narrative-driven pumps
13. **No whale wallet tracking beyond alpha wallets** — Missing large buyer signals
14. **No cross-token rotation detection** — When money flows from one meme to another

### Risk Management
15. **No portfolio-level risk** — Each signal evaluated independently, no correlation tracking
16. **No max concurrent positions limit** — Could be 30 open positions at once
17. **No market regime detection** — Same thresholds in bull/bear/crab markets
18. **No gas/slippage estimation** — Position sizing doesn't account for execution costs in illiquid tokens

### Data Quality
19. **Many momentum metrics are estimated** (60% buy volume assumption, 2% new holders assumption) — Could be wildly wrong for specific tokens
20. **DexScreener is sole price source** — No cross-reference with on-chain DEX data
21. **15-second momentum cache** may miss micro-movements in fast markets
22. **Holder concentration from Helius** can be stale — uses 60s cache for fast-moving launches

### Learning System
23. **Daily optimizer only adjusts 5% per cycle** — Very slow adaptation to market regime changes
24. **Factor analysis uses simple win/loss averages** — No multivariate regression, no interaction effects
25. **No holdout/validation set** — Optimizer could be overfitting to last 7 days
26. **Win rate target of 30%** — Is this the right metric? Expected value (EV) per trade might be better to optimize for
27. **No A/B testing framework** — Can't test threshold changes against control group

---

*Generated: March 2026 — RossyBot System Export for Deep Dive Analysis*
