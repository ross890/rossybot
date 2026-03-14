# ROSSYBOT SYSTEM REDESIGN PLAN

## The Problem

The current system has ~80 TypeScript files, 11+ modules, and layers of features that were
never validated. Social metrics return hardcoded values. Three exit systems contradict each
other. Market regime detection exists but isn't wired in. There's no backtesting, no
automated execution, and the strategic analysis rates it 4.2/10 for profitability.

**Nothing works as a cohesive system. It needs to be stripped back to a working core and
rebuilt deliberately.**

---

## Phase 0: Strip Back to Bare Minimum (Working Foundation)

**Goal:** A bot that does ONE thing well — detects alpha wallet buys and sends clean
Telegram alerts. Nothing else. No scoring, no optimization, no phases 3/4.

### Keep:
- `src/index.ts` — gutted to just: database init, telegram init, signal loop
- `src/config/index.ts` — simplified config
- `src/utils/database.ts` — PostgreSQL connection + minimal schema
- `src/utils/logger.ts` — logging
- `src/modules/telegram.ts` — Telegram bot (simplified, fewer commands)
- `src/modules/signal-generator.ts` — stripped to CORE logic only
- `src/modules/onchain-scoring.ts` — simplified scoring (safety + holder + liquidity only)
- `src/modules/scam-filter.ts` — essential safety gates
- `src/modules/rugcheck.ts` — contract safety check
- `src/modules/alpha/alpha-wallet-manager.ts` — alpha wallet tracking (the actual edge)
- `src/types/index.ts` — shared types
- `src/utils/rate-limiter.ts` — API rate limiting

### Remove (move to `/archive` so nothing is lost):
- `src/nansen/` — entire directory (unvalidated integration)
- `src/risk/` — portfolio manager, correlation tracker (premature)
- `src/analysis/` — regime detector, narrative detector, time optimizer, rotation detector (never validated)
- `src/wallets/` — wallet engine, graduation, GMGN discovery (over-engineered)
- `src/modules/pumpfun/` — dev tracker (separate concern, add back later)
- `src/modules/discovery/` — 8 discovery sources is too many. Keep alpha wallets only
- `src/modules/trading/` — auto-trader, jupiter, raydium (not functional)
- `src/modules/performance/` — daily optimizer, threshold optimizer (optimizing what?)
- `src/modules/signals/` — conviction tracker, sell detector
- `src/modules/momentum-analyzer.ts` — anti-predictive per your own data
- `src/modules/candlestick-analyzer.ts` — noise
- `src/modules/kol/` — KOL analytics
- `src/modules/entry/` — pullback detector
- `src/modules/telegram/` — wallet commands, trading commands, daily digest

### Simplify `signal-generator.ts`:
- Remove: surge detection, momentum scoring, social metrics (all placeholder/broken)
- Remove: multi-tier market cap routing, discovery signals, KOL validation signals
- Keep: alpha wallet buy detection → safety check → basic scoring → Telegram alert
- One signal type: "Alpha wallet X bought Y" with safety score and basic metrics

### Simplify `onchain-scoring.ts`:
- Remove: 5-dimension weighted scoring, momentum weight, social bonus
- Replace with 3 hard gates + 1 simple score:
  - Gate 1: RugCheck safety pass (hard reject on fail)
  - Gate 2: Minimum liquidity ($5K+)
  - Gate 3: Not in exclusion list (stablecoins, LP tokens, etc.)
  - Score: holder count + liquidity depth + token age (simple additive, 0-100)

---

## Phase 1: Data Collection Mode (Weeks 1-2)

**Goal:** Run the stripped bot in observation mode. Log everything. Build the dataset
needed to make informed decisions about what to add back.

### What to build:
1. **Signal logger** — every alert the bot would send, log to DB with full context:
   - Token address, discovery time, alpha wallet that triggered it
   - Price at signal, price at +1h, +4h, +12h, +24h, +48h
   - Liquidity, holders, age at signal time
   - Outcome: peak price, trough price, final price

2. **Simple Telegram output:**
   - Clean signal: wallet label, token, mcap, liquidity, holders, links
   - No scoring numbers, no TP/SL targets, no position sizing
   - Just the facts — let yourself make the trading decisions

3. **Price tracker** — background job that updates signal outcomes over time
   - Poll DexScreener every 5 min for open signals
   - Record price history for each signaled token

### What NOT to build:
- No auto-optimization
- No threshold adjustment
- No position management
- No exit strategies
- No multiple discovery sources

---

## Phase 2: Analysis & Validation (Week 3)

**Goal:** With 2 weeks of clean data, answer the fundamental questions.

### Questions to answer from the data:
1. What % of alpha wallet signals are profitable at +1h? +4h? +24h?
2. What's the average return if you bought at signal and sold at +4h?
3. Do any specific wallets consistently outperform others?
4. Does holder count at signal time predict outcome?
5. Does liquidity depth predict outcome?
6. Does time of day matter?
7. What's the optimal hold time?

### Deliverable:
- A Telegram `/stats` command that shows real performance data
- A clear go/no-go decision: is there actually an edge here?

---

## Phase 3: Rebuild With Evidence (Weeks 4+)

**Only add features that the data from Phase 2 justifies:**

### If alpha wallet signals show edge:
- Add wallet performance weighting (trust wallets with track record)
- Add simple position sizing based on wallet confidence
- Add ONE exit strategy (time-based or trailing stop, whichever data supports)
- Consider adding Jupiter auto-execution for speed

### If alpha wallet signals DON'T show edge:
- Pivot strategy entirely
- Options: bonding curve plays, KOL exit signals (inverse), high-conviction multi-wallet
- The stripped-back architecture makes pivoting easy

### Features to add back ONLY with evidence:
- Market regime detection — only if data shows regime affects win rate
- Multiple discovery sources — only if alpha wallets alone miss opportunities
- Scoring complexity — only if simple gates leave money on the table
- Auto-optimization — only after manual optimization proves the concept

---

## Implementation Approach

### Step 1: Archive current code
```
mkdir -p archive/v1
cp -r src/ archive/v1/
```

### Step 2: Gut `index.ts`
Remove all Phase 3/4 imports, Nansen, wallet engine, dev tracker.
Keep: database, telegram, signal generator.

### Step 3: Rewrite `signal-generator.ts`
~200 lines max. Single responsibility: detect alpha wallet buys, check safety, alert.

### Step 4: Simplify `onchain-scoring.ts`
3 gates + simple score. No weights, no dimensions, no optimization hooks.

### Step 5: Add signal logger + price tracker
New: `src/modules/signal-logger.ts` — logs signals with outcome tracking.

### Step 6: Clean up Telegram
Minimal commands: `/start`, `/status`, `/stats`, `/help`

### Step 7: Test locally, deploy, observe

---

## What This Achieves

- **From ~80 files to ~15 files**
- **From 11 modules to 3** (telegram, signal detection, safety checking)
- **From "nothing works" to "one thing works well"**
- **From guessing to data-driven decisions**
- **From feature creep to deliberate, evidence-based expansion**

The hardest part isn't building features — it's having the discipline to NOT build
them until the data says you should.
