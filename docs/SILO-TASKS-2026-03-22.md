# Silo-Specific Research & Task Lists — 22 March 2026

**Source data:** Startup diagnostics + 540 pump.fun trades, net -6.88 SOL, 20% WR, PF 0.36

---

## SILO 1: INFRASTRUCTURE (Restarts & Stability)

### Problem
Bot is restarting regularly — HOLD-TIME ENFORCEMENT messages repeat every 15 min (discovery cycle interval), and the startup diagnostics message appeared again at 6:20 PM, meaning the process restarted.

### Research
- `src/index.ts` lines 2653-2658: `unhandledRejection` and `uncaughtException` handlers log errors but **do not exit the process**. This means the bot can continue in a broken state (stale WS connections, half-initialized modules) until Docker's `restart: unless-stopped` restarts it.
- No memory monitoring exists. Unbounded caches: `symbolCache`, `pumpFunBuyerTracker`, `deferredEntries`.
- WebSocket reconnect logic (`websocket-manager.ts:435-456`) has exponential backoff but after 5 failures enters fallback polling mode — this could silently degrade signal latency.
- The HOLD-TIME ENFORCEMENT firing every 15 min is **expected** — it's the wallet discovery cycle (`discoveryIntervalMs: 15 * 60 * 1000`), not a restart indicator. The STARTUP DIAGNOSTICS message at 6:20 PM IS the restart.

### Tasks
1. **Add process health monitoring**: Track `process.memoryUsage()` on each discovery cycle. If RSS > threshold (e.g., 512MB), log warning and optionally trigger graceful restart.
2. **Bound unbounded caches**: Add TTL or max-size to `symbolCache`, `pumpFunBuyerTracker`. Use LRU eviction.
3. **Fix exception handlers**: On `uncaughtException`, log + flush + `process.exit(1)` so Docker restarts cleanly instead of running in a zombie state.
4. **Add uptime tracking to diagnostics**: Include `process.uptime()` in the startup message so you can see how long it ran before crashing.
5. **Investigate actual crash cause**: Check container logs (`docker logs --tail 200 rossybot`) for the error that triggered the restart at ~6:20 PM. Could be OOM kill, unhandled rejection in discovery, or WS failure cascade.
6. **Reduce HOLD-TIME ENFORCEMENT spam**: Only send the Telegram message if the wallet list actually changed since last cycle. Currently it sends the same 37 wallets every 15 minutes with no diff.

### Key Files
- `rossybot-v2/src/index.ts` — main lifecycle, intervals, exception handlers
- `rossybot-v2/src/modules/helius/websocket-manager.ts` — WS reconnection
- `rossybot-v2/src/modules/nansen/wallet-discovery.ts` — 15-min discovery cycle
- `rossybot-v2/src/config/index.ts` — interval timings

---

## SILO 2: STRATEGY (Pump.Fun Curve Scalp)

### Problem
540 trades, 20% WR, PF 0.36 (need >1.0 to be profitable). Net -6.88 SOL. The strategy is structurally unprofitable.

### Research — Root Causes

**A. Stop Loss Deadlock (FIXED but damage done)**
- `tracker.ts:421-434`: Old code rejected ALL large price drops as "bad RPC data". On actual rug pulls, `last_curve_check_sol` never updated → position stuck until time kill. Result: 230 stop losses at avg **-79.7%** instead of target -10%.
- Current code only rejects upward spikes. Verify this fix is actually deployed.

**B. Curve TP exits showing -100% losses (BUG)**
- Config comment line 92: "Curve TP exits show LOSSES because sqrt PnL estimate >> actual swap output after slippage+fees."
- Several "Curve TP (X% PnL)" exits show 0% WR and -100% avg loss. These are phantom TPs — the PnL estimate triggers a sell, but the actual execution gets nothing back (token already dead, slippage ate everything, or the sell tx failed).
- Affected exits: `Curve TP (40% PnL)` = -0.3018◎, `Curve TP (84% PnL)` = -0.1664◎, `Curve TP (26% PnL)` = -0.1115◎

**C. Entry Curve Zone Mismatch**
- Config says `curveEntryMin: 0.33` (33%), but 201 trades entered at 0-20% fill and 161 at 20-30%. That's 362 trades (67%!) below the stated 33% minimum.
- Either the entry gate isn't enforcing properly, or these are from before the config was tightened. Need to check if these are all historical.

**D. Emergency Graduation Exits**
- 15+ different "Emergency graduation exit" reasons, mostly losses. Token graduates before curve TP triggers, and post-graduation price dumps.

### Tasks
1. **Verify stop loss fix is deployed**: Check production code matches the upward-only spike rejection. If the old deadlock code is still running, this is the single biggest leak (-5.53 SOL from stop losses alone).
2. **Fix Curve TP PnL calculation**: Before triggering a TP sell, verify the estimated PnL against actual curve state. If `sqrt(sol_now/sol_entry) - 1` shows +40% but actual sellable SOL is near zero, do NOT sell — classify as hard kill instead.
3. **Add sell simulation before TP**: Before executing a "take profit" sell, simulate the swap (or use a smaller test amount) to verify the exit is actually profitable. If simulated output < entry cost, reclassify exit reason.
4. **Investigate 0-20% entries**: Query the database for trades with `curve_fill_pct_at_entry < 0.33` — are these all pre-config-change? If recent, the entry gate has a bypass.
5. **Tighten graduation exit**: If curve fill is >30% and approaching graduation (>90% fill), exit immediately rather than waiting for the graduation event. The "emergency" path loses money because it's reactive.
6. **Review exit priority order**: The 9 exit mechanisms in `checkCurvePosition()` fire in code order. Ensure hard kill is checked FIRST (it is), but also ensure TP checks verify actual sellable value, not just estimated PnL.

### Key Metrics to Track
| Metric | Current | Target |
|--------|---------|--------|
| Win Rate | 20% | 28%+ (breakeven WR) |
| Profit Factor | 0.36 | >1.0 |
| Avg Loss | -57.6% | -15% (if SL works) |
| Stop Loss Avg | -79.7% | -12-15% |
| EV/trade | -0.0127◎ | >0◎ |

### Key Files
- `rossybot-v2/src/modules/pumpfun/tracker.ts` — position monitoring, all exit logic
- `rossybot-v2/src/modules/pumpfun/validation.ts` — entry curve validation
- `rossybot-v2/src/config/index.ts` — strategy parameters (lines 83-109)

---

## SILO 3: WALLETS (Discovery & Quality)

### Problem
300 active wallets but only 7 generating DEX signals. 194 "unproven" wallets consuming resources. The wallet leaderboard shows the worst wallets losing more than the best wallets make.

### Research
- 75 WS subscriptions for 300 wallets — rotation happens every 10 min (`WS_ROTATION_INTERVAL_MS`)
- Discovery runs every 15 min, last run screened 40 tokens and added 9 wallets
- Hold-time enforcement correctly demotes bad wallets (3 demoted to Tier B, 37 marked PF-only)
- But the **worst wallets are catastrophic**: `[H8qcJvzS]` = -0.78◎ on 2 trades (both -99% losses)
- Best wallet `nansen_reali`: 7 trades, 86% WR, +0.2562◎ — this one wallet is carrying the system

### Tasks
1. **Implement wallet kill switch**: If a wallet generates 3+ consecutive losses or net PnL < -0.3◎, permanently deactivate it (not just demote to Tier B). Current demotion still allows PF signals.
2. **Reduce unproven wallet count**: 194 unproven wallets are noise. Add a max-unproven cap (e.g., 50) and evict oldest unproven wallets when new ones are discovered.
3. **Wallet concentration analysis**: `nansen_reali` is the only consistently profitable wallet. Research: what makes this wallet different? Copy-trade signal quality? Conviction size? Token selection?
4. **Tighten discovery filters**: Last run: 40 tokens screened, 9 wallets added. That's a 22.5% acceptance rate — are these quality additions or noise?
5. **Add wallet P&L tracking to diagnostics**: The leaderboard shows wallet performance but doesn't show how many signals each wallet generates. A wallet with 1 trade at +0.18◎ could be luck. Need signal volume * WR * avg PnL.
6. **Review PF-only wallet list**: 37 wallets marked pump.fun only. Are these actually useful for PF signals? If their PF WR is also bad, remove them entirely.

### Key Files
- `rossybot-v2/src/modules/nansen/wallet-discovery.ts` — discovery cycle, hold-time enforcement
- `rossybot-v2/src/modules/analysis/hold-time-analyzer.ts` — wallet scoring/demotion
- `rossybot-v2/wallets.json` — seed wallet list
- `rossybot-v2/src/index.ts` — WS rotation logic (~line 2020)

---

## SILO 4: PORTFOLIO (Capital & Position Management)

### Problem
Balance: 0.0114 SOL. Tier: MICRO. The bot has burned through capital rapidly. Position sizing at 0.0041 SOL (30% × 120% multiplier) means each trade is tiny but cumulative losses add up.

### Research
- Tier history shows rapid cycling: MICRO → SMALL at 3◎, then back to MICRO repeatedly. Capital is being injected then burned.
- 41.42◎ deployed across 540 trades = avg 0.0767◎ per trade. With -6.88◎ net, that's -16.6% return on deployed capital.
- Max 2 pump.fun positions (config `maxPositions: 2`), but shadow mode overrides to 20 concurrent.
- Position size: `positionSizePct: 0.10` (10% in shadow) × `positionSizeMultiplier: 1.20` = 12% per position.
- Fees: only 0.0025◎ total (0.0% drag) — fees are not the problem.

### Tasks
1. **Capital preservation mode**: At 0.0114 SOL, the bot should reduce position sizing further or pause entirely. Current minPositionSol is 0.003 — almost at the floor.
2. **Add drawdown circuit breaker**: If net PnL drops below -X% of peak capital in a rolling window, pause trading for N hours. Current `dailyLossLimitPct: 0.30` (30%) isn't enough when the overall strategy is -EV.
3. **Track capital efficiency**: Add a metric for SOL returned per SOL deployed. Currently -16.6% — need to surface this in diagnostics.
4. **Review shadow mode position limits**: Shadow mode allows 20 concurrent positions. If the bot is actually executing (not just simulating), this amplifies losses. Verify `shadowMode: true` means no real trades.
5. **Tier transition tracking**: The bot keeps bouncing MICRO → SMALL → MICRO. Add hysteresis to tier transitions (e.g., require capital to be 20% above tier threshold for N minutes before promoting).

### Key Files
- `rossybot-v2/src/config/index.ts` — tier configs (lines 147-303), shadow mode overrides (lines 350-363)
- `rossybot-v2/src/modules/capital/` — capital management (if exists)
- `rossybot-v2/src/index.ts` — `capitalManager.resetDaily()`, tier history

---

## SILO 5: TELEGRAM (Notifications & UX)

### Problem
Message spam — the same HOLD-TIME ENFORCEMENT and DEMOTION messages fire every 15 minutes with identical content. The diagnostics dump is massive (this one is 500+ lines).

### Research
- Hold-time callback in `index.ts:1357-1375` sends messages unconditionally every discovery cycle
- Exit reason breakdown has 100+ unique exit types in diagnostics — information overload
- No message throttling or deduplication

### Tasks
1. **Deduplicate hold-time messages**: Cache the previous wallet list. Only send a Telegram message if wallets were added/removed. Output a diff: "+2 wallets added to PF-only, -1 removed".
2. **Compress exit reason reporting**: Group rare exit types (1-2 trades) into "Other exits: 45t, -0.82◎" instead of listing 80+ individual lines.
3. **Add summary-only mode**: Option for a condensed diagnostics message (key metrics only: WR, PF, net PnL, open positions, capital, top 3 / bottom 3 exits). Keep the full dump available via `/diagnostics full`.
4. **Rate-limit skip messages**: "SKIP · Low conviction" messages fire frequently. Batch these into a periodic summary: "12 signals skipped in last hour (8 low conviction, 3 MCAP, 1 safety)".
5. **Add actionable alerts only**: Distinguish between informational messages and alerts that need human attention (e.g., "balance critically low", "3 consecutive restarts", "WS in fallback mode").

### Key Files
- `rossybot-v2/src/index.ts` — Telegram message sending, hold-time callback
- `rossybot-v2/src/modules/telegram/` — Telegram bot module
- Diagnostics formatting in `index.ts` (the startup message generation)

---

## SILO 6: MARKET ANALYZER (Signal Funnel & Validation)

### Problem
1151 signals detected → 240 entered (21% pass rate). Top rejections: MCAP:648, NO_DEX_DATA:159, SAFETY:73, MOMENTUM:30. The funnel rejects 79% but the 21% that pass still lose money.

### Research
- **MCAP rejection (648/911 = 71% of rejections)**: `mcapMin: 10_000` in shadow mode. These tokens have market cap data but fall outside range — likely too low even for $10K minimum.
- **NO_DEX_DATA (159)**: DexScreener returns no pair info. These are brand new tokens not yet indexed. For pump.fun curve scalps, DEX data shouldn't be required — the trade happens on the bonding curve, not DEX.
- **SAFETY (73)**: Catch-all for validation failures (rugcheck, honeypot detection).
- **MOMENTUM (30)**: Price change outside -70% to +1000% range or volume too low.
- The 240 trades that passed still have 20% WR — the funnel isn't filtering quality, just obvious junk.

### Tasks
1. **Reconsider NO_DEX_DATA rejection for pump.fun**: 159 tokens rejected because DexScreener has no data. Pump.fun curve trades don't need DEX data — the bonding curve IS the market. Bypassing this gate for pump.fun signals could add 159 potential trades. Research: were any of these NO_DEX_DATA tokens actually good trades?
2. **Add post-hoc signal analysis**: For each rejected signal, track what would have happened (did the token moon after rejection?). This reveals missed opportunities and validates the funnel.
3. **Tighten funnel for profitability, not volume**: The funnel passes 240 trades at 20% WR. A tighter funnel passing 50 trades at 40% WR would be more profitable. Consider:
   - Increase `minConvictionSol` from 1.25 to 2.0 SOL (filter spray wallets)
   - Add multi-wallet confluence as a hard requirement (not just a bonus)
   - Require curve velocity > 1.0 SOL/min (currently 0.5)
4. **Analyze MCAP distribution of rejections**: Are the 648 MCAP rejections all sub-$10K, or are some above $15M? If most are sub-$10K, the filter is working. If many are high-mcap, the bot is missing established tokens.
5. **Add signal quality scoring**: Beyond pass/fail, score each signal 0-100. Track correlation between score and trade outcome. Use this to weight position sizing (higher score = bigger position).

### Key Files
- `rossybot-v2/src/modules/validation/gate.ts` — validation pipeline
- `rossybot-v2/src/modules/analysis/` — market analysis
- `rossybot-v2/src/modules/pumpfun/validation.ts` — pump.fun specific validation
- `rossybot-v2/src/config/index.ts` — threshold configs

---

## Priority Order

| Priority | Silo | Impact | Effort |
|----------|------|--------|--------|
| **P0** | Strategy — verify SL fix deployed | Biggest single leak (-5.53◎) | Low |
| **P0** | Strategy — fix Curve TP false positives | -0.9◎+ from phantom TPs | Medium |
| **P1** | Infrastructure — fix crash/restart | Stability, lost signals during restart | Medium |
| **P1** | Wallets — kill worst performers | Stop bleeding from -99% wallet trades | Low |
| **P2** | Market Analyzer — tighten funnel | Fewer but better trades | Medium |
| **P2** | Portfolio — capital preservation | Prevent complete depletion | Low |
| **P3** | Telegram — reduce spam | Quality of life, focus attention | Low |
