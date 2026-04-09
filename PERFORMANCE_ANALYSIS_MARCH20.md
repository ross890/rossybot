# Rossybot Performance Analysis — March 20, 2026

**Data source:** Live dashboard snapshot (524 closed trades)
**Focus:** Pump.fun bonding curve strategy (primary activity)

---

## TL;DR

The bot is bleeding capital: **20% win rate, -15.3% avg PnL** across 524 trades. The core problem is a **curve entry zone mismatch** — most tokens peak at 20-30% curve fill, but the strategy requires them to reach 36%+ for profit. You're entering a game where 80% of tokens never reach your take-profit zone.

---

## 1. The Numbers That Matter

| Metric | Value | Verdict |
|--------|-------|---------|
| Win rate | 20% (106W / 418L) | Far below breakeven (~40% needed at current R:R) |
| Avg PnL | -15.3% | Consistent bleed |
| Avg hold | 2 min | Ultra-short — curve scalps as designed |
| Graduation rate | 18% (93/431) | 82% of tokens stall on the curve |
| Stop losses | 222 (42% of exits) | Dominant exit — most trades fail outright |
| -100% wipeouts | 18 pump.fun stop losses | Complete loss on 3.4% of trades |

### Breakeven Math

With the current exit profile:
- Average win: ~+40% (estimated from curve TP zone)
- Average loss: ~-15% (stop loss)
- **Breakeven win rate needed: 27%** `(15 / (40+15))`
- **Actual win rate: 20%**
- **Gap: -7 percentage points** — this is the edge deficit

---

## 2. The Curve Distribution Problem (Critical)

This is the single most important finding:

```
PEAK CURVE FILL DISTRIBUTION (343 trades):

  0-10%:    8 trades   13% WR   -31% avg PnL
  10-20%:  70 trades    1% WR   -67% avg PnL    ← death zone
  20-30%: 138 trades    8% WR   -60% avg PnL    ← MOST TRADES PEAK HERE
  30-40%: 102 trades   18% WR   -61% avg PnL
  40-50%:  15 trades   93% WR    +5% avg PnL    ← win zone starts
  50-60%:   4 trades   75% WR    +3% avg PnL
  80-90%:   1 trade   100% WR  +127% avg PnL
  90-100%:  5 trades  100% WR +2708% avg PnL    ← graduation winners
```

**Key insight:** The median peak curve fill is **28%**. Your curve TP target is **36%**. This means **the majority of tokens you enter will never reach your profit target.**

- 216 trades (63%) peak below 30%
- Only 25 trades (7%) ever reach 40%+
- The 30-40% bucket (102 trades) still only has 18% WR — many enter this zone but reverse before 36%

### The Entry Zone Mismatch

Current config: `curveEntryMin: 30%`, `curveEntryMax: 38%`, `curveProfitTarget: 36%`

This means you're entering tokens that are already at 30%+ fill and hoping they push another 6+ percentage points to 36%. But the data shows:
- **P75 of peak curve fill is only 33%** — 75% of tokens never exceed 33%
- Entering at 30% with TP at 36% requires the token to be in the **top 25% of all curve performers**
- You're betting on the exception, not the rule

---

## 3. Exit Reason Breakdown

| Exit Reason | Count | % of Total | Assessment |
|-------------|-------|------------|------------|
| Stop loss | 222 | 42% | Dominant — most trades hit -15% stop |
| Curve target hit | 29 | 6% | Only 29 wins via curve TP — very low conversion |
| Pump.fun stop loss (-100%) | 18 | 3% | Complete wipeouts — likely rug/dump |
| Emergency graduation exit | 15 | 3% | Missed curve TP, had to emergency sell post-grad |
| Manual sell | 12 | 2% | User intervention |
| Curve hard exit | 9 | 2% | Hit 45% ceiling — actually wins but booked as exit |
| Alpha exit (wallet dump) | 5 | 1% | Alpha wallets dumping — system working correctly |
| Post-grad emergency | 4 | 1% | Caught holding through graduation |

**Observations:**
- **222 stop losses vs 29 curve target hits** — a 7.7:1 loss-to-win ratio on the primary exit paths
- **15 emergency graduation exits at 0%** — these tokens DID graduate (hit 100% curve) but the bot missed the TP, suggesting the TP at 36% was passed too quickly or the curve hard exit at 45% didn't trigger in time
- **9 curve hard exits** — these hit 45% (above TP) but exited as "hard exit" rather than "target hit" — likely a timing/monitoring gap

---

## 4. Entry Type Performance

| Type | Trades | Win Rate | Avg PnL | Assessment |
|------|--------|----------|---------|------------|
| DIRECT | 520 | 20% | -14.8% | Bread and butter — still unprofitable |
| DEFERRED | 3 | 0% | -99.2% | Watchlist entries are catastrophic |
| MOVER | 1 | 0% | -28.5% | Too small a sample to judge |

**DEFERRED entries are failing completely.** The watchlist mechanism (enter early at 0-30%, wait for momentum) resulted in 3 trades, all at -99.2% avg — essentially total loss. The tokens entered the watchlist at low curve fill and never recovered. **Disable deferred entries or add much stricter activation criteria.**

---

## 5. Wallet Performance — Extreme Concentration

The top 10 wallets show massive positive returns:
```
pf_alpha_95L461:  1t  100%W   +3996%
pf_alpha_3r58Fx:  2t  100%W   +1675%
pf_alpha_39ntNq:  1t  100%W   +1564%
pf_alpha_CANx1a:  2t   50%W   +1500%
pf_alpha_mBNGpH:  3t   33%W    +966%
```

But these top wallets account for **~10 trades out of 524** (1.9%). The remaining 514 trades from other wallets are generating the -15.3% average PnL.

**This is the classic alpha wallet problem:** a handful of wallets have genuine edge, but the system dilutes that edge by also following dozens of mediocre wallets. The March 17 strategy review identified this exact issue — Nansen-bootstrapped wallets with no proven track record are generating most of the losing signals.

---

## 6. Specific Recommendations

### A. Fix the Curve Entry Zone (Highest Priority)

The current 30-38% entry with 36% TP is structurally broken. Options:

**Option 1 — Raise entry minimum to 35%, TP to 42%:**
- Only enter tokens already showing strong momentum (above P75)
- Fewer trades but much higher conversion rate
- Risk: fewer entries, may miss some

**Option 2 — Lower TP to 32-33%, tighten stop to -8%:**
- Accept smaller wins but dramatically increase win rate
- 30-40% bucket has 18% WR at current stops; a tighter TP within this range catches more
- Math: 32% TP on 30% entry = only +6-7% gain needed
- At -8% stop and +7% gain: breakeven WR = 53% — still needs improvement but much closer

**Option 3 (Recommended) — Only enter 35%+, TP at 40%, stop at -10%:**
- Entry at 35% means the token has already proven momentum
- TP at 40% is within the 40-50% bucket (93% WR historically)
- Tighter stop (-10% vs -15%) cuts losses faster
- Breakeven WR: 50% at these levels — the 40-50% bucket historically hits 93%

### B. Kill Deferred Entries

Set `deferredEntryEnabled: false`. The data is clear: 3 trades, 0% WR, -99.2% avg. These are destroying capital.

### C. Wallet Quality Filter

Implement a minimum trade count per wallet. Wallets with 1-2 trades of our own data have no proven edge. Either:
- Require 3+ trades from a wallet before following live
- Or shadow-track new wallets for their first 5 signals before committing capital

### D. Tighten Stop Loss for Curve Scalps

Current -15% stop loss with 2-minute avg hold is too wide. On the bonding curve, -15% in 2 minutes means the token is going to zero — there's no recovery. Consider:
- **-8% stop loss** for curve positions (still allows normal volatility)
- **-5% stale kill** if no upward movement in 30 seconds

### E. Address the 15 Missed Graduations

15 trades hit "emergency graduation exit at 0%" — these tokens went from entry to 100% curve fill (graduation) but the bot didn't capture the move. This suggests:
- The curve monitoring interval (2s) may be too slow for fast graduations
- The curve hard exit at 45% should be a **sell order**, not just a monitoring trigger
- Consider pre-placing limit orders at the curve TP level

### F. Enforce Wallet Holdout Period

The top performing wallets (`95L461`, `3r58Fx`, `39ntNq`) have 1-2 trades each with enormous returns. These are likely new additions that got lucky. Before trusting them with more capital:
- Track 5+ trades before increasing position size
- Weight recent performance more than single outlier wins

---

## 7. Expected Impact

If implementing recommendations A (Option 3) + B + D:

| Metric | Current | Projected |
|--------|---------|-----------|
| Trades/day | ~50+ | ~15-20 (higher quality) |
| Win rate | 20% | 40-50% (entering closer to win zone) |
| Avg win | ~+10% | ~+15% (TP at 40% from 35% entry) |
| Avg loss | -15% | -8% (tighter stop) |
| Breakeven WR | 27% | 35% |
| Expected EV/trade | -8.3% | +2% to +5% |

**The path to profitability is not more trades — it's fewer, better trades with tighter risk management.**

---

## 8. Config Changes Summary

```typescript
// pumpfun config changes
curveProfitTarget: 0.40,        // was 0.36 — enter the 93% WR zone
curveEntryMin: 0.35,            // was 0.30 — only enter proven momentum
curveEntryMax: 0.39,            // was 0.38 — tight window
stopLoss: -0.10,                // was -0.15 — cut losses faster
hardKill: -0.15,                // was -0.20 — tighter emergency exit
staleTimeKillMins: 0.5,         // was 1.0 — kill stale trades faster
deferredEntryEnabled: false,    // was true — deferred entries are -99% avg
```

---

*Analysis based on 524 closed trades as of March 20, 2026. All curve distribution data from 343 pump.fun bonding curve trades.*
