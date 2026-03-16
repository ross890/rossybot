# Momentum Gate Rework — "Smart Dip" Logic

## Problem
- `momentumMin: 0` hard-rejects any token with negative 24h price change
- Production logs show -57%, -63%, -28%, -27% all killed at gate
- Alpha wallets buying dips is a bullish signal — current gate contradicts core thesis
- But not all dips are buys — death spirals should still be rejected

## Approach: Three-Layer Dip Classification

### Layer 1: Validation Gate (hard reject / allow)
**File: `validation/dexscreener.ts` → `checkMomentum()`**

Lower the floor from 0% to **-50%** and add death spiral detection:

- **Allow**: momentum between -50% and +300% (was 0% to 300%)
- **Hard reject "death spiral"**: ALL of these must be true:
  - h24 < -40%
  - h6 < -25%
  - h1 < -10%
  - Buy ratio < 0.35 (sells dominating — no one is accumulating)
- **Hard reject "overheated"**: h24 > 300% (unchanged)
- **Hard reject "no volume"**: volume multiplier below tier minimum (unchanged)

This means a token at -30% with buying activity passes the gate. A token at -60% in freefall with all sells doesn't.

### Layer 2: Signal Scoring (reward/penalize dips)
**File: `signals/signal-scorer.ts` → `scoreMomentum()`**

Currently gives 0 points for any h24 < 0. Rework to:

| Scenario | h24 Range | Buy Ratio | Points (of 25) |
|----------|-----------|-----------|-----------------|
| Strong pump | +50% to +120% | any | 18-22 |
| Moderate pump | +20% to +50% | any | 12-18 |
| Flat/slight up | 0% to +20% | any | 5-12 |
| Healthy pullback | -5% to 0% | > 0.45 | 8-10 |
| Dip accumulation | -25% to -5% | > 0.50 | 5-8 |
| Deep dip buy | -50% to -25% | > 0.55 | 3-5 |
| Dip with no buyers | -50% to 0% | < 0.40 | 0-2 |
| Overheated | > +200% | any | 5-10 (diminishing) |

Key: **buy ratio** = h24 buys / (h24 buys + h24 sells) from DexScreener txns data.
A high buy ratio on a dip = accumulation. Low buy ratio on a dip = capitulation.

### Layer 3: Position Sizing Adjustment
**File: `index.ts` → signal callback**

Dip entries get reduced position size as extra risk management:

- h24 >= 0%: standard tier position size (unchanged)
- h24 -10% to 0%: 85% of standard size
- h24 -25% to -10%: 70% of standard size
- h24 < -25%: 60% of standard size

This means we follow the alpha wallet into dips but with less capital at risk.

## Config Changes
**File: `config/index.ts`**

Per-tier config changes:
- All tiers: `momentumMin: -50` (was `0`)
- Shadow mode override: `momentumMin: -60` (was `0`)
- No change to `momentumMax`

## Changes to TierConfig Type
**File: `types/index.ts`**

No changes needed — `momentumMin` already accepts negative numbers.

## Summary of Changes

1. **`config/index.ts`**: Set `momentumMin: -50` for all tiers
2. **`validation/dexscreener.ts`**: Add death spiral detection using buy ratio from txns data; lower momentum floor
3. **`signals/signal-scorer.ts`**: Rework `scoreMomentum()` to give partial credit for dips with accumulation
4. **`index.ts`**: Add position size scaling based on momentum at entry

## What This Doesn't Change
- Wallet quality floor (50% WR / 25% avg PnL) — unchanged
- MCap gate — unchanged
- Liquidity gate — unchanged
- Signal score minimum — unchanged
- Exit rules — unchanged

The wallet is still the primary signal. We're just removing the gate that prevents us from following smart wallets into dips.
