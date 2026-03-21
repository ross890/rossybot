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
- Telegram commands were cleaned down to 16 pump.fun-focused commands
- Skip notifications (bad wallet, low conviction, stampede, curve range) are logged to file, not sent to Telegram
