# Optimize Wallet List — Implementation Plan

## Executive Summary

After analyzing the full codebase, I've identified **7 optimization areas** across performance, strategy, and data structure improvements. The core issue: wallet list management has grown organically with overlapping cleanup/scoring logic, sequential RPC calls, redundant DB queries, and tier configs that don't scale coherently (MICRO has 50 WS slots but SMALL has 5).

---

## 1. Fix Tier Wallet Count Inversion (MICRO=50 > SMALL=5)

**Problem:** `walletsMonitored` is inverted — MICRO tier gets 50 WS slots while SMALL gets only 5. This means a bot with 0.5 SOL monitors 10x more wallets than one with 5 SOL. The MICRO=50 was likely set for shadow-mode testing but leaked into live config.

**File:** `src/config/index.ts` (lines 114-226)

**Changes:**
```
MICRO:  50 → 15  (small capital = fewer but higher-quality signals)
SMALL:   5 → 15  (match MICRO, broader coverage)
MEDIUM: 10 → 20  (moderate expansion)
FULL:   20 → 30  (max coverage for big capital)
```

**Rationale:** More capital = more positions = need more signal sources. Current config throttles SMALL tier to 5 wallets, missing signals. Shadow mode already overrides `maxPositions` to 20 — it should also override `walletsMonitored` separately.

---

## 2. Cache `getActiveWallets()` Results

**Problem:** `getActiveWallets()` runs a heavy SQL scoring query (12+ CASE expressions, full table scan with ORDER BY) and is called:
- On startup
- Every 10min (WS rotation)
- Every new wallet discovery callback
- Every wallet reactivation

**File:** `src/modules/nansen/wallet-discovery.ts` (line 726)

**Changes:**
- Add a `private cachedRankedWallets: { addresses: string[]; fetchedAt: number } | null` field
- Cache results for 5 minutes (half the rotation interval)
- Invalidate cache on wallet add/remove/deactivate operations
- Add `invalidateWalletCache()` public method for external callers

**Impact:** Eliminates redundant DB queries during bursty wallet operations (startup runs seed + purge + enforce + cleanup + getActive in sequence).

---

## 3. Convert `walletAddresses` from Array to Set-Backed Structure

**Problem:** `walletAddresses: string[]` in `index.ts` uses:
- `filter()` for removal — O(n) per eviction
- `push()` for addition — O(1) but duplicates possible
- `includes()` implicit in various checks — O(n)
- Passed to `wsManager.connect()` which needs array

**File:** `src/index.ts` (line 90)

**Changes:**
- Create a `WalletSlotManager` class that wraps a `Set<string>` + maintains an ordered array
- Methods: `add(addr)`, `remove(addr)`, `has(addr)`, `toArray()`, `size`, `replace(old, new)`
- Use internally everywhere `this.walletAddresses` is referenced
- The `toArray()` call is only needed when passing to `wsManager.connect()`

**Impact:** O(1) lookups and removals. Prevents duplicate subscriptions (currently possible if PumpPortal alpha + discovery both add same wallet).

---

## 4. Batch RPC Calls in `enforceTradeActivity()`

**Problem:** `enforceTradeActivity()` makes sequential `getSignaturesForAddress` RPC calls for every active wallet — one at a time with 100ms delays every 10 wallets. With 50+ wallets this takes 5+ seconds blocking startup.

**File:** `src/modules/nansen/wallet-discovery.ts` (lines 499-588)

**Changes:**
- Batch wallets into groups of 10
- Use `Promise.allSettled()` per batch (parallel within batch, sequential between batches)
- Reduce inter-batch delay from 1000ms to 200ms
- Skip already-known-active wallets more aggressively (cache `last_active_at` in memory)

**Before:** 50 wallets × (100ms RPC + 100ms delay) = ~10s
**After:** 50 wallets / 10 per batch × (100ms RPC parallel + 200ms delay) = ~1.2s

---

## 5. Consolidate Overlapping Cleanup Queries in `autoCleanup()`

**Problem:** `autoCleanup()` runs 5 separate UPDATE queries that scan the same table:
1. Stale wallets (no trade data)
2. Slow holders (median >12h)
3. Proven losers (<40% WR)
4. Low alpha score (<15)
5. Excess wallet cap

Each does a full scan of `alpha_wallets WHERE active = TRUE`.

**File:** `src/modules/nansen/wallet-discovery.ts` (lines 619-721)

**Changes:**
- Combine queries 1-4 into a single UPDATE with compound OR conditions
- Return deactivation reasons via a CASE expression in the RETURNING clause
- Keep query 5 (cap enforcement) separate since it depends on the result of 1-4

**Before:** 5 DB round-trips
**After:** 2 DB round-trips (combined cleanup + cap enforcement)

---

## 6. Improve WS Rotation Signal Tracking

**Problem:** WS rotation (`rotateWsSlots()`) only tracks signal *count* per wallet. A wallet producing many low-quality signals (all failing validation) keeps its slot while a wallet producing one great signal gets evicted.

**File:** `src/index.ts` (lines 1694-1763)

**Changes:**
- Track `wsSignalQuality: Map<string, { count: number; passed: number; totalScore: number }>` instead of just count
- Weight by signal score: `quality = passed * 2 + (totalScore / count)`
- Eviction threshold: quality < 1.0 (at least one passed signal OR several high-scoring attempts)
- Wire signal scoring results back to rotation tracker in `handleSignal()` callback

**Impact:** Keeps wallets that produce actionable signals, evicts wallets that only produce noise.

---

## 7. Add Recency Decay to Wallet Ranking Score

**Problem:** The ranking query in `getActiveWallets()` uses `our_win_rate` and `our_avg_pnl_percent` which are all-time metrics. A wallet that was profitable 3 months ago but has been losing recently still ranks high.

**File:** `src/modules/nansen/wallet-discovery.ts` (lines 729-791)

**Changes:**
- Add a `last_signal_at` timestamp column (updated whenever a wallet produces a signal)
- Add recency decay to the scoring formula:
  ```sql
  -- Recency decay: reduce score for wallets with no recent signals
  - CASE
      WHEN last_signal_at IS NULL THEN 10
      WHEN last_signal_at < NOW() - INTERVAL '7 days' THEN 15
      WHEN last_signal_at < NOW() - INTERVAL '3 days' THEN 5
      ELSE 0
    END
  ```
- This stacks with the existing `last_active_at` bonus (which measures on-chain activity, not signal production for us)

---

## Implementation Order

1. **Fix tier wallet counts** (5 min, config-only change, immediate impact)
2. **Cache getActiveWallets()** (30 min, reduces DB load)
3. **Batch RPC calls** (30 min, faster startup)
4. **Consolidate cleanup queries** (20 min, reduces DB load)
5. **WalletSlotManager class** (45 min, cleaner code + O(1) ops)
6. **WS rotation signal quality** (30 min, better slot allocation)
7. **Recency decay scoring** (20 min, better wallet ranking)

---

## Files Modified

| File | Changes |
|------|---------|
| `src/config/index.ts` | Tier walletsMonitored values |
| `src/modules/nansen/wallet-discovery.ts` | Cache, batched RPC, consolidated cleanup, recency decay |
| `src/index.ts` | WalletSlotManager, signal quality tracking |
| `src/db/database.ts` | Migration for `last_signal_at` column (if needed) |

## Risk Assessment

- **Low risk:** Items 1-5 are internal optimizations, no behavioral change
- **Medium risk:** Items 6-7 change wallet selection logic, could affect signal coverage
- **Mitigation:** All scoring changes are additive (new penalties), existing weights unchanged
- **Rollback:** All changes are config/code only, no schema migrations required (except optional `last_signal_at`)
