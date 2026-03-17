# Rossybot V2 — Strategy Review & Recommendations

**Date:** March 17, 2026
**Scope:** Full codebase review of `rossybot-v2/src/`
**Context:** Bot is not profitable despite bullish market conditions

---

## Executive Summary

Rossybot V2 is a well-architected Solana memecoin trading system built around alpha wallet tracking via Nansen + Helius WebSocket. The system has strong foundations — wallet discovery, hold-time analysis, tiered position management, and Jupiter execution — but **five structural issues** are preventing profitability:

1. **The scoring system is disconnected from the validation gate** — signals pass validation but scoring is a separate, additive step that doesn't gate entries effectively
2. **Exit rules are too aggressive on winners and too lenient on losers** for the MICRO tier
3. **Signal noise is high** because single-wallet confluence is sufficient (MICRO tier)
4. **The wallet quality floor is too permissive** — Nansen bootstrap estimates create false confidence
5. **No portfolio-level risk management** — positions are evaluated independently

**Verdict:** The system's edge (alpha wallet tracking) is real but is being diluted by noise, aggressive time kills, and lack of position-level quality gating. Fixing these issues doesn't require architectural changes — they're configuration and logic adjustments.

---

## Module Interconnectivity Map

```
Helius WebSocket
  → TransactionParser (detect BUY/SELL by tracked wallets)
    → [BUY] EntryEngine.processBuySignal()
      → Confluence check (MICRO: 1 wallet sufficient)
      → validateToken() [gate.ts]
        → Only enforces: MCap range, Liquidity minimum, Momentum range
        → Safety, RugCheck, Bundle: ALL SKIPPED ("wallet quality is the validation")
      → [PASSED] Signal callback in index.ts
        → scoreSignal() [signal-scorer.ts]
          → Wallet quality (0-35), Momentum (0-25), MCap fit (0-20), Liquidity (0-10), Confluence (0-10)
          → minSignalScore gate (35 for MICRO)
        → [PASSED] Open position via LiveTracker or ShadowTracker
          → CapitalManager.getPositionSize()
          → Price monitoring every 10s
          → Exit rules: stop loss, profit target, time kills, trailing stop, alpha exit
    → [SELL] handleAlphaExit() on position trackers

Nansen WalletDiscovery (every 1h)
  → Token screener → PnL leaderboard → discover top traders
  → HoldTimeAnalyzer enforces quick-flip profile
  → Auto-cleanup: stale, slow-holder, excess wallets

PumpFun Tracker (parallel system)
  → Bonding curve monitoring every 5s
  → Graduation detection → Raydium price tracking
  → Tighter exits: 20min stale kill, 60min hard kill
```

---

## Issue 1: Validation Gate Is Too Thin

**File:** `src/modules/validation/gate.ts`

The validation gate's comment says it all: *"Wallet quality IS the validation — smart wallets are the edge."* But this philosophy is only valid when wallet quality is actually high. In practice:

**What the gate enforces:**
- Market cap range (per tier config)
- Minimum liquidity ($10K for MICRO)
- Momentum range (-50% to +300%)

**What the gate SKIPS:**
- Safety checks (mint authority, freeze authority, honeypot)
- RugCheck (LP lock status, risk score)
- Bundle detection (insider concentration)
- Token age minimum

**The problem:** A wallet with 0 of our trades and a Nansen-estimated 50% win rate (which is literally just `0.50 + roi/1000`) can trigger a buy into a token with active mint authority, unlocked LP, and 80% insider holdings. The "wallet quality is the validation" assumption breaks down when most wallets are Nansen-bootstrapped rather than proven through our own trade data.

**Recommendation:**
```
Re-enable safety hard gates for tokens when the triggering wallet has <3 of our own trades.
Keep the permissive gate only for wallets with proven track records (3+ trades, >45% WR).
This is a 10-line change in gate.ts — add a walletProven parameter.
```

---

## Issue 2: Scoring System Is Additive But Should Be Multiplicative

**File:** `src/modules/signals/signal-scorer.ts`

The signal scorer adds five independent components:
- Wallet quality: 0-35
- Momentum: 0-25
- MCap fit: 0-20
- Liquidity: 0-10
- Confluence: 0-10

**Total: 0-100, minimum 35 to pass (MICRO tier)**

**The noise problem:** A token can score 35 with:
- Wallet quality: 15 (mediocre wallet with Nansen bootstrap padding)
- Momentum: 10 (slight pump)
- MCap fit: 5 (under $50K — too micro)
- Liquidity: 2 (under $10K)
- Confluence: 2 (single wallet, shadow mode)

This is a low-quality signal that passes purely through accumulation of mediocre sub-scores. No single component is strong.

**Recommendation:**
```
Add minimum sub-score gates:
- walletQuality >= 15 (hard floor — this IS the edge)
- At least ONE sub-score in top 60% of its range
  (e.g., momentum >= 15 OR mcapFit >= 14 OR confluence >= 5)

This prevents "death by mediocrity" signals while keeping the total score gate.
```

---

## Issue 3: Exit Rules Kill Winners Too Early (MICRO Tier)

**File:** `src/config/index.ts` — TIER_CONFIGS[MICRO]

Current MICRO tier exits:
| Rule | Trigger | Problem |
|------|---------|---------|
| Profit target | +50% | Exits at 1.5x — too early for memecoins that can do 5-20x |
| Stop loss | -20% | Reasonable |
| Hard kill | -25% | Reasonable |
| Time kill 1 | 2h if PnL < -5% | Aggressively cuts positions that haven't moved |
| Time kill 2 | 4h if PnL < +15% | Kills positions that are +10% and climbing |
| Time kill 3 | 12h if PnL < +25% | Kills profitable positions |
| Hard time | 48h | Reasonable |

**The EV problem:** With -20% stop loss and +50% profit target:
```
To break even: need win rate > 28.6%
  EV = (WR × 50%) - ((1-WR) × 20%) = 0
  WR = 20/70 = 28.6%

But time kills convert potential winners into small losses/flat exits:
  - A token at +8% after 2 hours gets killed (time kill 1 requires -5% min, meaning it survives,
    but at 4 hours needs +15% or it's killed)
  - Memecoins regularly consolidate for 2-4h before the next leg up
```

The 2h time kill (`minPnlPct: -0.05`) is actually lenient (only kills if below -5%), but the 4h kill (`minPnlPct: 0.15`) is aggressive — it kills any position that hasn't done +15% in 4 hours. In memecoins, a 4-hour consolidation between +5% and +14% is common before a breakout.

**Recommendation:**
```
MICRO tier adjustments:
1. Raise profit target: 50% → 80% (or implement partial exits: 50% at +50%, remainder trails)
2. Loosen 4h time kill: +15% → +5% (don't kill winners still above entry)
3. Add trailing stop: once +30% peak, exit if retrace to +10%
4. Keep stop loss at -20%, hard kill at -25%

Expected impact: Lets winners run further. Even if win rate stays flat,
average win size increases from ~50% to ~80-120% (accounting for partial exits and trails).
```

---

## Issue 4: Wallet Quality Scoring Has a Bootstrap Problem

**File:** `src/modules/signals/signal-scorer.ts` — `scoreWalletQuality()`

The scoring uses a blend of our trade data and Nansen estimates:
```typescript
const ourWeight = Math.min(1.0, ev.trades / 5);
const nansenWeight = 1.0 - ourWeight;

// Nansen win rate estimate: ROI > 100% maps to ~0.65 WR
const nansenEstWinRate = 0.50 + Math.max(0, ev.nansenRoi) / 1000;

// Nansen avg PnL: sqrt curve
const nansenEstAvgPnl = Math.min(50, Math.sqrt(ev.nansenRoi) * 3);
```

**Problem:** A wallet with 0 of our trades, Nansen ROI of 150%, and $2K PnL gets:
- Blended WR: 0.65 (from `0.50 + 150/1000`)
- Blended PnL: 36.7% (from `sqrt(150) * 3`)
- No floor penalty (both above thresholds)
- Confidence: 0.4 (minimum, since 0 our trades)
- WR score: (0.65 - 0.50) × 37.5 = 5.6
- EV score: min(20, 5 + 36.7) = 20
- Final: (5.6 + 20) × 0.4 = **10.2/35**

This wallet scores 10/35 on wallet quality alone — enough to contribute meaningfully to a passing total score. But we have **zero** evidence this wallet trades profitably within our exit windows. Nansen ROI could be from a single lucky 150x hold over 6 months.

**Recommendation:**
```
1. Cap Nansen-only wallet scores at 8/35 (currently uncapped at confidence 0.4)
2. Require at least 1 of our own trades before scoring above 8
3. Weight nansen_pnl_usd more heavily than roi_percent
   ($50K PnL across 20 trades >> $500 PnL with 200% ROI on 1 trade)
4. Add hold-time alignment: if the wallet's median hold time (from HoldTimeAnalyzer)
   doesn't match our exit windows, apply a 0.5x multiplier
```

---

## Issue 5: No Portfolio-Level Risk Management

**File:** `src/modules/trading/capital-manager.ts`

CapitalManager tracks:
- Total capital
- Daily loss limit (30%)
- Position size (25% × capital for MICRO)
- Max positions (4 for MICRO)

**What's missing:**

1. **No correlation check:** If 3 of 4 positions are in similar tokens (e.g., all AI-themed memecoins), a sector rotation kills them all simultaneously.

2. **No drawdown circuit breaker:** Daily loss limit is 30%, but if you lose 20% in 2 hours, the system happily opens more positions. Need a short-term drawdown detector.

3. **No win streak / loss streak adaptation:** After 3 consecutive losses, position sizes should decrease. After 3 wins, can increase modestly.

4. **Position count vs. capital isn't coordinated:** 4 positions × 25% each = 100% deployed. In MICRO tier, you can be 100% in memecoins — no SOL reserve for averaging down or new opportunities.

**Recommendation:**
```
1. Reduce maxPositions × positionSizePct to ≤ 60% total exposure
   (e.g., 4 positions × 12% = 48%, or 3 positions × 18% = 54%)
2. Add consecutive loss scaling: after 2 losses, halve position size for next 2 trades
3. Add 1-hour drawdown check: if portfolio down >10% in last hour, pause new entries for 30min
4. Track token themes/sectors and limit to 2 positions per "cluster"
```

---

## Issue 6: Pump.fun and Standard Pipeline Compete for Attention

**Files:** `src/modules/pumpfun/tracker.ts`, `src/index.ts`

The pump.fun system runs alongside the standard V2 pipeline but uses different exit rules, different position sizing (40% multiplier), and has its own position cap (3). When a wallet buys a pump.fun token:

1. Signal routes to `handlePumpFunBuy()` — separate from EntryEngine
2. No signal scoring happens — just validation checks
3. Position tracked by PumpFunTracker with its own exit rules

**The noise issue:** Pump.fun tokens are the noisiest part of the memecoin market. The system's hold-time analyzer correctly identifies bag-holders and routes them to `pumpfun_only`, but this means the pump.fun pipeline gets wallets that *already failed* the quick-flip standard. You're routing your weakest wallets to your hardest game.

**Recommendation:**
```
Option A: Disable pump.fun entirely for MICRO tier — focus capital on proven runners
Option B: Only enter pump.fun when 2+ wallets buy the same curve (confluence)
Option C: Apply signal scoring to pump.fun entries too (currently bypassed)

The pump.fun pipeline should not be a dumping ground for wallets that failed
standard hold-time requirements. Either invest in it properly or cut it.
```

---

## Issue 7: DexScreener Price Is the Only Data Source

**Files:** `src/modules/validation/dexscreener.ts`, `src/modules/positions/live-tracker.ts`

Every price check, validation, and exit decision depends on DexScreener's free API:
- Rate limited to 30 req/min
- No real-time WebSocket pricing
- 10-second polling interval for position monitoring

**In a volatile memecoin market, 10 seconds is an eternity.** A -20% stop loss hit could actually be -35% by the time the next price check runs and the Jupiter swap executes.

**Recommendation:**
```
1. Use Helius WebSocket for price monitoring on open positions (you already have the connection)
2. Add Jupiter quote-based pricing as a cross-reference before exit decisions
3. Consider reducing position monitoring interval to 5s for MICRO tier (already done for pump.fun)
4. Add slippage estimation to position sizing:
   slippage_est = position_sol / (liquidity_usd / sol_price / 2)
   If estimated slippage > 5%, reduce position size or skip
```

---

## Ranked Recommendations (by expected impact)

### Do Now (highest impact, lowest effort)

| # | Change | File(s) | Impact |
|---|--------|---------|--------|
| 1 | **Raise MICRO profit target** from +50% to +80%, add trailing stop at +30% peak | `config/index.ts` | Lets winners run — directly improves avg win size |
| 2 | **Loosen 4h time kill** from +15% to +5% | `config/index.ts` | Stops killing consolidating winners |
| 3 | **Add wallet quality sub-score minimum** of 15/35 | `index.ts` (signal callback) | Filters out Nansen-bootstrap-only signals |
| 4 | **Cap Nansen-only wallet scores** at 8/35 | `signal-scorer.ts` | Prevents unproven wallets from driving entries |
| 5 | **Reduce total exposure** to 60% max (3 × 20% or 4 × 15%) | `config/index.ts` | Preserves capital for better opportunities |

### Do This Week (medium effort)

| # | Change | File(s) | Impact |
|---|--------|---------|--------|
| 6 | **Re-enable safety gates** for unproven wallets (<3 our trades) | `gate.ts` | Prevents entering unsafe tokens on bootstrap data |
| 7 | **Add consecutive loss scaling** — halve size after 2 losses | `capital-manager.ts`, `index.ts` | Reduces drawdown velocity |
| 8 | **Add 1-hour drawdown circuit breaker** (pause if >10% down in 1h) | `capital-manager.ts` | Prevents cascading losses |
| 9 | **Implement partial exits for MICRO** — sell 50% at +50%, trail remainder | `live-tracker.ts`, `shadow-tracker.ts` | Captures guaranteed profit while letting runners run |
| 10 | **Add slippage-aware position sizing** | `capital-manager.ts` | Prevents large slippage eating edge on thin pools |

### Do Next Week (requires more work)

| # | Change | File(s) | Impact |
|---|--------|---------|--------|
| 11 | **Score pump.fun entries** same as standard pipeline | `index.ts`, `signal-scorer.ts` | Reduces pump.fun noise |
| 12 | **Use Helius for position price monitoring** | `live-tracker.ts` | Faster exit execution, tighter stops |
| 13 | **Track token theme/sector clustering** | New utility + `capital-manager.ts` | Prevents correlated position risk |
| 14 | **Add holdout validation** to prevent optimizer overfitting | `threshold-optimizer.ts` | Better learning system |

---

## What's Working Well (Don't Break These)

1. **Wallet discovery pipeline** — Nansen token screener → PnL leaderboard → candidate scoring is a solid flywheel
2. **Hold-time analyzer** — Correctly identifies and routes bag-holders vs. quick flippers
3. **Alpha exit detection** — Following the wallet OUT is as important as following it IN
4. **Tiered capital system** — Appropriate risk scaling for different capital levels
5. **Token blocklist** — Prevents re-buying recently closed positions
6. **Death spiral detection** in momentum gate — Smart dip-buying logic

---

## Key Metrics to Track

After implementing changes, track these weekly:

| Metric | Current (estimated) | Target |
|--------|--------------------|--------|
| Win rate | ~25-30% | 35%+ |
| Average win size | ~50% (hard TP) | 80-120% (with trails) |
| Average loss size | ~20% | ~18% (tighter stops) |
| Signals per day | Unknown (likely 10-20+) | 5-10 (quality over quantity) |
| Expected value per trade | Negative | +5% to +10% |
| Max concurrent positions | 4 (100% exposure) | 3-4 (60% max exposure) |
| Nansen-only wallet signals | High % | <30% of total |

---

## Summary

The market is pumping but Rossybot isn't profitable because it's trading too much, exiting winners too early, and trusting unproven wallets. The core thesis — alpha wallet tracking — is sound, but it's being diluted by:

1. **Quantity over quality** in signal generation
2. **Aggressive time kills** that cut winners before they mature
3. **Over-reliance on Nansen bootstrap estimates** for wallet quality
4. **100% capital deployment** with no portfolio-level risk controls
5. **Pump.fun noise** from wallets that already failed standard quality checks

The fixes are configuration changes and small logic additions, not architectural rewrites. Focus on **raising the quality bar for entries** and **letting winners run longer**.

---

*Review based on full codebase analysis of rossybot-v2/src/ — March 17, 2026*
