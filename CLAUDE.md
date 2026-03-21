# Rossybot — Claude Code Context

## Session Focus: Wallets & Discovery

This chat is dedicated to **wallet-related builds** for Rossybot v2.

## Key Reference Document

Before starting any wallet/discovery work, always:
1. Read `docs/UPDATE-2026-03-21.md` on the main branch (or the latest dated update file in `docs/`)
2. Section 1 (Wallets & Discovery) is the most relevant for this silo
3. Update the document when completing wallet/discovery work to keep it current

## Architecture Notes

- Rossybot v2 is a Solana memecoin copy-trading bot using Helius WebSocket + Nansen intelligence
- Wallet trust tier system (UNPROVEN/PROBATIONARY/PROVEN) controls per-signal routing between shadow and live trackers
- Both shadow and live trackers run concurrently — shadow collects data, live deploys capital behind proven wallets
- Key files for wallet work:
  - `rossybot-v2/src/types/index.ts` — WalletTrustTier enum, AlphaWallet interface
  - `rossybot-v2/src/config/index.ts` — Trust tier thresholds, capital tier configs
  - `rossybot-v2/src/modules/signals/signal-scorer.ts` — getWalletTrustTier(), scoring logic
  - `rossybot-v2/src/modules/nansen/wallet-discovery.ts` — Discovery pipelines
  - `rossybot-v2/src/modules/trading/capital-manager.ts` — Trust-tier-aware position sizing
  - `rossybot-v2/src/modules/positions/shadow-tracker.ts` — Shadow stat tracking for tier graduation
  - `rossybot-v2/src/index.ts` — Signal routing based on trust tier
