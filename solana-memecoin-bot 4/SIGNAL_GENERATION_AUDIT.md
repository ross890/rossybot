# Signal Generation System Audit Report

**Date:** February 1, 2026
**Auditor:** Claude Code
**Scope:** Complete signal generation flow, thresholds, scoring, and ML learning

---

## Executive Summary

The signal generation system has multiple scoring engines, threshold systems, and filters working together. This audit identified **15 critical issues** where thresholds conflict, good signals are cancelled, or the ML learning module lacks sufficient training data.

---

## 1. CRITICAL ISSUES IDENTIFIED

### 1.1 Discovery Score Mismatch with On-Chain Path

**Files:** `scoring.ts:183` vs `signal-generator.ts:487`

**Problem:** The `scoring.ts` discovery score caps at 100, but the signal generator uses `onChainScoringEngine` for discovery signals (Path B), NOT `scoringEngine.calculateDiscoveryScore()`. This means the discovery weights in `scoring.ts:35-39` are **never used** for on-chain signals.

```typescript
// scoring.ts - UNUSED for on-chain path
const DISCOVERY_WEIGHTS = {
  onChainHealth: 0.35,
  socialMomentum: 0.25,
  scamRiskInverse: 0.40,
};
```

**Impact:** Two separate scoring systems exist - one unused. The on-chain scoring engine has different weights.

---

### 1.2 Conflicting Authority Requirements

**Files:** `scoring.ts:723-730` vs `token-safety-checker.ts:159-164`

**Problem:**
- `meetsDiscoveryRequirements()` in `scoring.ts:723-730` **REQUIRES** both mint and freeze authority revoked
- `token-safety-checker.ts:159-164` only blocks if **BOTH** authorities are enabled
- New tokens almost always have authorities enabled, so discovery signals would fail the scoring check

```typescript
// scoring.ts - Strict requirement (blocks most new tokens)
if (!scamFilter.contractAnalysis.mintAuthorityRevoked) {
  return { meets: false, reason: 'Mint authority not revoked' };
}

// token-safety-checker.ts - Lenient check
if (result.mintAuthorityEnabled && result.freezeAuthorityEnabled) {
  return { blocked: true, reason: 'Both mint and freeze authorities enabled' };
}
```

**Impact:** Good tokens with only one authority enabled could be blocked by discovery requirements but pass safety check.

---

### 1.3 Threshold Optimizer vs On-Chain Engine Disconnect

**Files:** `threshold-optimizer.ts:61-68` vs `onchain-scoring.ts:69-101`

**Problem:** The threshold optimizer sets dynamic thresholds, but only some are used by the on-chain engine:

| Optimizer Threshold | Value | Used in On-Chain? |
|---------------------|-------|-------------------|
| minMomentumScore | 25 | YES (signal-generator.ts:474) |
| minOnChainScore | 30 | YES (signal-generator.ts:487) |
| minSafetyScore | 40 | NO - hardcoded at 25 in onchain-scoring.ts:388 |
| maxBundleRiskScore | 60 | NO - only 'CRITICAL' checked |
| minLiquidity | 8000 | NO - uses 2000 from config |
| maxTop10Concentration | 60 | NO - uses 75 from config |

**Impact:** Threshold optimizer learns patterns but can't apply them to key safety/bundle thresholds.

---

### 1.4 Score Capping Inconsistency

**Files:** `scoring.ts:131` vs `scoring.ts:183` vs `onchain-scoring.ts:135`

**Problem:** Different score caps across modules:
- KOL signals: capped at 150 (`scoring.ts:131`)
- Discovery signals: capped at 100 (`scoring.ts:183`)
- On-chain signals: no explicit cap (but components are 0-100)

**Impact:** KOL signals can reach 150 due to bonuses, but discovery/on-chain max at 100, creating inconsistent comparisons.

---

### 1.5 ML Win Predictor Skip Threshold Too Aggressive

**File:** `signal-generator.ts:554-560`

**Problem:** Signals are filtered if `winProbability < 25 AND recommendedAction === 'SKIP'`. However, the ML predictor only has reliable data with 30+ training samples, and new deployments start with 0.

```typescript
if (prediction.recommendedAction === 'SKIP' && prediction.winProbability < 25) {
  return SignalGenerator.EVAL_RESULTS.DISCOVERY_FAILED;
}
```

**Impact:** Before ML is trained, default prediction returns 30% probability and 'WATCH' action - these pass. But once trained with limited data, it may aggressively skip good signals.

---

### 1.6 Safety Score Double-Penalization

**Files:** `token-safety-checker.ts:50-77` + `onchain-scoring.ts:129` + `scoring.ts:499-520`

**Problem:** Safety penalties apply THREE times:
1. `token-safety-checker.ts` calculates safetyScore with penalties
2. `onchain-scoring.ts:129` inverts bundle risk (redundant with safety)
3. `scoring.ts:499-520` ALSO penalizes for authorities in `calculateScamRiskInverse`

A token with mint authority enabled loses:
- -15 in safety checker
- -30 in scamRiskInverse
- Compounded in final weighted score

**Impact:** Authority-enabled tokens are triple-penalized, potentially cancelling otherwise strong signals.

---

### 1.7 Timing Score Rewards OLD Tokens Over New

**Files:** `onchain-scoring.ts:323-364` vs system goal of early detection

**Problem:** The timing score explicitly favors older tokens:
```typescript
// 4-12 hours: proven survivor, optimal window
return 100;  // Maximum score

// < 15 min: too early
return 30-50; // Low score
```

But the config sets `MIN_TOKEN_AGE_MINUTES: 5` to catch early tokens.

**Impact:** Very early tokens get timing penalty of 20-30 points, making them unlikely to generate signals even with strong momentum.

---

### 1.8 Bundle Risk Threshold Not Enforced

**File:** `signal-generator.ts:462-469`

**Problem:** Only 'CRITICAL' risk level blocks signals:
```typescript
if (onChainScore.riskLevel === 'CRITICAL') {
  return SignalGenerator.EVAL_RESULTS.BUNDLE_BLOCKED;
}
```

But the threshold optimizer sets `maxBundleRiskScore: 60` which is never checked.

**Impact:** HIGH risk tokens (50-70 bundle score) still generate signals despite optimizer recommendation.

---

### 1.9 Social Metrics Weight is Zero for On-Chain Signals

**File:** `signal-generator.ts:711`

**Problem:** On-chain signals set social momentum to 0:
```typescript
const score = {
  factors: {
    socialMomentum: 0, // Not used in on-chain signals
  }
};
```

But social data IS collected via `getSocialMetrics()` and could enhance signal quality.

**Impact:** Valuable social signals (KOL Twitter mentions, sentiment) are collected but discarded for on-chain path.

---

### 1.10 Position Size Multiplier Conflict

**Files:** `signal-generator.ts:564-572` vs `small-capital-manager.ts`

**Problem:** Position size is calculated twice with different multipliers:
1. `smallCapitalManager.calculatePositionSize()` applies signal quality multipliers
2. `prediction.positionSizeMultiplier` (0.5-1.5) is multiplied AGAIN

```typescript
const adjustedPositionSize = {
  solAmount: positionSize.solAmount * prediction.positionSizeMultiplier,
};
```

**Impact:** Position sizes can be reduced to 0.25x (0.5 * 0.5) or boosted to 2.25x (1.5 * 1.5), exceeding intended ranges.

---

### 1.11 Holder Count Used with Different Thresholds

**Files:** Multiple locations

| Location | Min Holders | Context |
|----------|-------------|---------|
| config/index.ts:52 | 20 | Screening |
| onchain-scoring.ts:93 | 20 | Market structure min |
| onchain-scoring.ts:94 | 200 | Market structure ideal |
| win-predictor.ts:419 | 50 | Loss pattern threshold |
| momentum-analyzer.ts:79 | 5 | Minimum unique buyers |

**Impact:** A token with 30 holders passes screening but triggers "Low Holders" loss pattern in ML.

---

### 1.12 Volume Requirements Inconsistent

**Files:** `config/index.ts:50` vs `momentum-analyzer.ts:209`

- Config: `MIN_24H_VOLUME: 3000`
- Momentum minimum check: `volume5m < 100` (extrapolates to ~29k/day)

**Impact:** Token can pass 24h volume check but fail momentum check, or vice versa.

---

### 1.13 Risk Level Mapping Confusion

**Files:** `onchain-scoring.ts:376-409` vs `bundle-detector.ts:377-392`

Both calculate risk levels but use different thresholds:

| Risk Level | On-Chain Score | Bundle Score |
|------------|----------------|--------------|
| CRITICAL | safety < 25 OR bundle CRITICAL | >= 70 |
| HIGH | score < 35 | >= 50 |
| MEDIUM | score 35-50 | >= 30 |
| LOW | score 50-65 | >= 15 |

**Impact:** Same token can be HIGH risk in one system and MEDIUM in another.

---

### 1.14 Screening Criteria Not Applied to KOL Path

**File:** `signal-generator.ts:343-345`

**Problem:** `meetsScreeningCriteria()` is called BEFORE the KOL/On-chain path split, so it applies to both. But KOL signals also require `meetsBuyRequirements()` which has additional constraints.

However, KOL signals DON'T check:
- Bundle risk level
- Minimum momentum score
- On-chain score thresholds

**Impact:** KOL signals can bypass on-chain quality checks that apply to discovery signals.

---

### 1.15 ML Training Data Insufficient for Pattern Discovery

**File:** `win-predictor.ts:84-85`

```typescript
const MIN_SAMPLES_FOR_PREDICTION = 30;
const MIN_PATTERN_SAMPLES = 10;
```

**Problem:** Pattern discovery requires 10 samples per pattern, but with 10 pattern templates, you need ~100 signals with outcomes to discover all patterns reliably.

**Impact:** Patterns marked as "Low Holders" winning or losing may be based on <10 samples, leading to false conclusions.

---

## 2. THRESHOLD CONFLICT MATRIX

| Component A | Component B | Conflict |
|-------------|-------------|----------|
| Config maxTop10Concentration (75%) | Optimizer maxTop10Concentration (60%) | Config wins, optimizer learned value ignored |
| Config minLiquidity ($2k) | Optimizer minLiquidity ($8k) | Optimizer 4x stricter but not applied |
| Safety MIN_THRESHOLD (30) | On-chain safety CRITICAL (25) | 5-point gap where neither applies |
| Timing optimal (4-12h) | Config minAge (5min) | System designed for early but scores punish it |
| ML SKIP threshold (25%) | Default prediction (30%) | Untrained ML passes, trained ML may reject |

---

## 3. SIGNALS BEING CANCELLED UNNECESSARILY

### 3.1 Early High-Quality Tokens (< 30 min)
- Timing score: 30-50 (out of 100)
- Safety penalties for authorities: -27
- Net result: Strong momentum token with 45-55 final score → filtered

### 3.2 Moderate Bundle Risk (30-50)
- Flagged but passes CRITICAL check
- However, loses points in bundleSafety component
- Loses points AGAIN in scamRiskInverse
- Double-counted penalty

### 3.3 Good Social Signals on On-Chain Path
- KOL Twitter mentions detected
- Social metrics collected
- Score factor set to 0
- Social edge completely lost

### 3.4 High Holder Growth, Low Absolute Count
- New token with 40 holders but growing fast
- Triggers "Low Holders" loss pattern
- Momentum score strong (70+)
- ML prediction brings down position size

---

## 4. ML LEARNING MODULE ISSUES

### 4.1 Insufficient Training Data
- Requires 30 signals minimum for prediction
- Requires 10 per pattern for discovery
- Retrains every 6 hours
- **Recommendation:** Lower thresholds initially, raise as data accumulates

### 4.2 Feature Recording Gaps
- `buySellRatio` and `uniqueBuyers` recorded as 0 for KOL signals
- ML can't learn from these features for KOL path
- **Recommendation:** Record momentum data for ALL signal types

### 4.3 Pattern Thresholds Hardcoded
- Patterns like "High Holder Growth" use fixed thresholds (>=200)
- Don't adapt to learned optimal values
- **Recommendation:** Use learned thresholds from feature analysis

### 4.4 Win/Loss Classification
- WIN: +100% take profit hit
- LOSS: -40% stop loss hit OR 48h timeout
- Timeouts classified as LOSS even if positive return
- **Recommendation:** Track actual return, not just win/loss binary

---

## 5. RECOMMENDED FIXES

### Priority 1: Critical Threshold Alignment

1. **Align timing score with early detection goal** - Reduce penalty for new tokens
2. **Apply optimizer thresholds to on-chain engine** - Currently disconnected
3. **Remove double-penalization of authorities** - Choose one penalty location
4. **Integrate social metrics into on-chain signals** - Don't discard collected data

### Priority 2: ML Learning Improvements

5. **Record momentum data for KOL signals** - Currently 0 for buySellRatio
6. **Lower initial training thresholds** - Start generating signals faster
7. **Track actual returns, not just win/loss** - Better learning signal
8. **Use learned thresholds in patterns** - Dynamic, not hardcoded

### Priority 3: Threshold Consistency

9. **Unify holder count thresholds** - One source of truth
10. **Apply optimizer's bundle risk threshold** - Currently only CRITICAL blocks
11. **Cap position size multipliers** - Prevent 0.25x or 2.25x extremes
12. **Align risk level definitions** - Same thresholds across modules

---

## 6. SPECIFIC CODE CHANGES

See implementation in the following commits for:
- `onchain-scoring.ts`: Adjusted timing scores, integrated safety thresholds
- `signal-generator.ts`: Applied optimizer thresholds, integrated social data
- `win-predictor.ts`: Enhanced feature recording, pattern thresholds
- `threshold-optimizer.ts`: Connected to on-chain engine
- `scoring.ts`: Removed duplicate authority penalties

---

## 7. TESTING RECOMMENDATIONS

After implementing fixes:

1. Run 24-hour test period with logging enabled
2. Compare signal volume before/after
3. Track which changes increased/decreased signals
4. Monitor ML training convergence
5. Validate position sizing stays within bounds (0.5x - 1.5x)

---

*End of Audit Report*
