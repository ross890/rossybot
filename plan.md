# ROSSYBOT EDGE IMPROVEMENT PLAN

## Priority Tiers

Grouped by expected impact on win rate / EV. Each item is a concrete code change.

---

## TIER 1: HIGH IMPACT — Direct Edge Gains (Do First)

### 1. Integrate Market Regime Detection Into Signal Generator
**Gap:** `bonding-monitor.ts` already has `getMarketRegime()` (BULL/CAUTION/BEAR/ROTATION with position multipliers) but it's **never called** from signal generation.
**Fix:** Wire regime into signal generator — adjust position sizing and threshold strictness based on regime. BEAR → tighten thresholds + smaller positions. BULL → allow more signals.
**Files:** `signal-generator.ts`, import from `pumpfun/bonding-monitor.ts`
**Effort:** Small — wiring existing code

### 2. Align The 3 Exit/Target Systems
**Gap:** Three misaligned systems operate simultaneously:
- Position manager: category-based (TP1 +100% to +400%, TP2 +250% to +1500%)
- Signal Telegram display: fixed +50%/+150% TP, -30% SL
- Performance tracker: +100%/-40% WIN/LOSS classification

The Telegram targets show +50% TP1 but position manager won't sell until +100% to +400%. The performance tracker classifies differently than both. This means the learning system is optimizing for different outcomes than what the position manager actually trades.
**Fix:**
- Update signal Telegram display to show the ACTUAL position manager targets for the signal's category
- Align performance tracker WIN/LOSS thresholds with position manager TP/SL levels (or at least make them configurable per category)
**Files:** `signal-generator.ts` (telegram formatting), `signal-performance-tracker.ts` (outcome classification)
**Effort:** Medium

### 3. Optimize for EV Instead of Win Rate
**Gap:** Optimizer targets 30% win rate, but a 20% win rate with 5x avg winners beats a 40% win rate with 1.5x avg winners. The system doesn't track or optimize for EV.
**Fix:** Add EV calculation to performance tracker and daily optimizer. Change optimization target from pure win rate to `EV = (winRate × avgWinReturn) - ((1-winRate) × avgLossReturn)`. Threshold adjustments should maximize EV, not win rate.
**Files:** `daily-auto-optimizer.ts`, `threshold-optimizer.ts`, `signal-performance-tracker.ts`
**Effort:** Medium

### 4. Add Max Concurrent Positions Limit
**Gap:** No portfolio-level position limit. Could have 30 open positions at once, concentrating risk. Signal generator only checks if already holding THAT token, not total exposure.
**Fix:** Add `MAX_CONCURRENT_POSITIONS` config (e.g., 8-10). Check open positions count before generating new signals. If at limit, only allow signals scoring in top 10% (quality over quantity).
**Files:** `signal-generator.ts`, `config/index.ts`
**Effort:** Small

### 5. Wire Rotation Detection Into Scoring
**Gap:** `rotation-detector.ts` exists and is called for enrichment but the rotation signal **doesn't affect the score**. When 3+ alpha wallets are rotating into a token, that's a strong signal being wasted.
**Fix:** Add rotation bonus to composite score (similar to surge bonus). 2 wallets = +5, 3+ wallets = +10, high SOL volume = additional +5.
**Files:** `signal-generator.ts` (where enrichment is applied)
**Effort:** Small

---

## TIER 2: MEDIUM IMPACT — Reduce Losses & Sharpen Signals

### 6. ATH Entry Gate (Not Just Warning)
**Gap:** ATH detection warns but still sends signal. Buying at ATH is a known loss pattern.
**Fix:** In production mode, if token is near ATH (>+25% in 1h for new tokens), either block the signal or auto-adjust entry zone to the suggested pullback price. Add "WAIT_FOR_PULLBACK" signal type that re-evaluates after price drops.
**Files:** `signal-generator.ts` (ATH detection section)
**Effort:** Medium

### 7. Continuous Holder Count Scoring (Remove Step Function)
**Gap:** Holder scoring jumps 5→12→20→28→35→40 at arbitrary thresholds. A token with 99 holders gets 20 points while 100 gets 40 — a 100% scoring jump for 1 holder difference.
**Fix:** Replace with continuous function: `points = min(40, round(40 × log(holders/10) / log(100/10)))` or similar log curve. Smooth transition from 10 holders (0 pts) to 300+ holders (40 pts).
**Files:** `onchain-scoring.ts` (market structure scoring section)
**Effort:** Small

### 8. Slippage-Aware Position Sizing
**Gap:** Position sizing ignores execution cost. On a $2K liquidity pool, a $50 trade might have 5-10% slippage, eating into edge.
**Fix:** Estimate slippage from liquidity: `estimatedSlippage = positionSize / (liquidity × 2)`. If slippage > 3%, reduce position. If > 8%, skip or minimum size only.
**Files:** `trading/trade-executor.ts` (calculatePositionSize)
**Effort:** Small

### 9. Remove or Invert Momentum Weight
**Gap:** Momentum is -0.04 correlated — actively anti-predictive. 5% weight is small but still adds noise and can push borderline tokens the wrong way.
**Fix:** Option A: Set weight to 0% and redistribute (safety 32.5%, market structure 37.5%, bundle 25%, timing 5%). Option B: Invert — use LOW momentum as a positive signal (early entry before crowd). Track both approaches in performance data.
**Files:** `onchain-scoring.ts` (weight constants)
**Effort:** Small

### 10. Social Bonus Correlation Check
**Gap:** Social bonus adds up to +25 points — enough to push a 33-point token to 58 (above threshold). Unknown if social presence actually predicts micro-cap wins.
**Fix:** Add `has_social_profiles` boolean to performance tracking. After 2 weeks of data, run correlation analysis. If not predictive, cap bonus at +10 or remove.
**Files:** `signal-performance-tracker.ts` (add field), `signal-generator.ts` (record it)
**Effort:** Small

---

## TIER 3: LEARNING SYSTEM IMPROVEMENTS

### 11. Add Holdout Validation Set
**Gap:** Optimizer could overfit to last 7 days. No way to detect if threshold changes actually improve performance or just fit noise.
**Fix:** Split signals 80/20 — optimizer trains on 80%, validates on 20%. Only apply changes if improvement shows on both sets. Use signal_id modulo for deterministic split.
**Files:** `threshold-optimizer.ts`, `daily-auto-optimizer.ts`
**Effort:** Medium

### 12. Faster Regime Adaptation
**Gap:** Daily optimizer caps changes at 5% per cycle. In a market crash, it takes 10+ days to meaningfully tighten.
**Fix:** Add "emergency adaptation" — if win rate drops below 15% over 48h sample (min 20 signals), allow 15% threshold change in a single cycle. Log as emergency adjustment.
**Files:** `daily-auto-optimizer.ts`
**Effort:** Small

### 13. Track Interaction Effects
**Gap:** Factor analysis looks at each metric independently. Doesn't capture "high holders + low liquidity = good" vs "low holders + low liquidity = bad".
**Fix:** Add 2-factor interaction analysis to the daily report. For the top 3 predictive factors, compute win rates for each quadrant (high/high, high/low, low/high, low/low). Report to Telegram so you can see patterns.
**Files:** `daily-auto-optimizer.ts` (factor analysis section)
**Effort:** Medium

### 14. Close the 48h→72h Tracking Gap
**Gap:** Signals have 72h time limit but tracking stops at 48h. 24 hours of untracked performance data.
**Fix:** Extend tracking to 72h to match signal time limit. Or reduce signal time limit to 48h to match tracking.
**Files:** `signal-performance-tracker.ts` (MAX_TRACKING_HOURS constant)
**Effort:** Trivial

---

## TIER 4: FUTURE CONSIDERATIONS (Research First)

### 15. Multivariate Threshold Optimization
Replace simple win/loss averages with logistic regression on all factors simultaneously. Would capture interaction effects and non-linear relationships. Requires more data (500+ signals minimum).

### 16. Cross-Token Flow Detection
Monitor when large holders of Token A start buying Token B. Indicates narrative rotation. Would need Helius webhook or frequent holder polling — API cost consideration.

### 17. Narrative/Sentiment Layer
Add Twitter/Telegram monitoring for trending tickers. Would catch narrative-driven pumps before on-chain metrics react. Requires new API integration (Twitter API or scraping service).

### 18. A/B Testing Framework
Run two threshold sets simultaneously — send both signals but only trade one. Compare performance after N signals. Would require shadow signal tracking infrastructure.

---

## IMPLEMENTATION ORDER

**Phase 1 (immediate — wire existing code):**
1, 4, 5, 9, 14 → Small changes, use what already exists

**Phase 2 (this week — medium changes):**
2, 3, 7, 8, 10, 12 → Direct edge improvements

**Phase 3 (next week — learning system):**
6, 11, 13 → Better adaptation

**Phase 4 (research/future):**
15-18 → Need more data or new infrastructure
