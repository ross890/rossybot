# Rossy Bot - Claude Code Context

## Session Focus
This workspace is dedicated to **Telegram-related development** for Rossy Bot.

## Telegram Development Workflow
- Before starting Telegram work, read the latest Telegram-related documentation on the `main` branch
- After completing Telegram work, update relevant documentation to reflect changes made
- Key Telegram files are in the bot's command/notification layer

## Project Overview
- Rossy Bot is a Solana trading bot with Telegram as its primary UI
- Strategy focus: pump.fun token trading
- Telegram commands: 21 pump.fun-focused commands (including /diagnostics)
- Skip notifications (bad wallet, low conviction, stampede, curve range) are logged to file, not sent to Telegram

## Recent Changes (22 March 2026 — Telegram Silo)
- Hold-time enforcement messages deduplicated (only sends when wallet list changes, shows diff)
- Exit reason reporting compressed (rare types ≤2 trades grouped into "Other")
- Startup diagnostics condensed to ~15 line summary; full dump via `/diagnostics` command
- Slots-full messages batched with skip count
- Dead `sendSignalSkippedAlert` method removed
- Actionable alerts added: 🚨 for low balance (<0.1 SOL) and 5+ consecutive losses
- Last remaining skip notification (low alpha) removed from Telegram
