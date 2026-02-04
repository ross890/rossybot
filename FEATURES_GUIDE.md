# Rossybot Features Guide

A simple guide for getting started with Rossybot - your Solana memecoin trading assistant.

---

## What is Rossybot?

Rossybot is a Telegram bot that scans the Solana blockchain for memecoin trading opportunities. It tracks smart wallets, analyses on-chain data, and sends you alerts when it finds promising setups.

---

## Core Features

### 1. Signal Alerts
When Rossybot finds a potential trade, you get a Telegram message with:
- **Token name** and contract address
- **Score** (0-100) - higher is better
- **Confidence level** - HIGH, MEDIUM, or LOW
- **Risk rating** - 1-5 scale
- **Market data** - market cap, volume, holders, liquidity
- **Entry zone** and **profit targets**

You can choose to BUY or SKIP each signal.

### 2. KOL Wallet Tracking
Rossybot monitors known profitable traders (Key Opinion Leaders) and alerts you when they buy something. It also detects their side wallets automatically.

### 3. Smart Money Detection
Automatically discovers and tracks high-performing wallets based on their trading history.

### 4. Scam Protection
Every token goes through safety checks:
- Rug pull risk analysis
- Insider/bundle detection
- Dev wallet behaviour monitoring
- Liquidity lock verification

---

## Main Commands

| Command | What it does |
|---------|--------------|
| `/help` | Show all commands |
| `/status` | Check bot health |
| `/wallet` | View your balance |
| `/positions` | See open positions with P&L |
| `/stats` | Trading performance (last 30 days) |
| `/history` | View last 15 trades |

### Trading Settings

| Command | What it does |
|---------|--------------|
| `/settings` | View current config |
| `/set_max_trade <SOL>` | Set max SOL per trade (0.01-100) |
| `/set_slippage <percent>` | Set slippage tolerance (1-50%) |
| `/toggle_autobuys` | Toggle auto-buying on/off |
| `/toggle_autosells` | Toggle auto take-profit/stop-loss |

### Position Management

| Command | What it does |
|---------|--------------|
| `/close <token>` | Close a specific position |
| `/close_all` | Emergency close everything |
| `/pause` | Stop all trading |
| `/resume` | Resume trading |

### Token Blacklist

| Command | What it does |
|---------|--------------|
| `/blacklist` | View blacklisted tokens |
| `/blacklist <token>` | Add token to blacklist |
| `/unblacklist <token>` | Remove from blacklist |

### Withdrawals

| Command | What it does |
|---------|--------------|
| `/withdraw <amount> <address>` | Withdraw SOL to your wallet |

---

## Trading Strategies

### Early Token Strategy
- Scans tokens 5 mins to 90 mins old
- Catches opportunities at launch
- Higher risk, higher reward
- 20-second scan cycles

### Mature Token Strategy
- Tracks tokens 21+ days old
- More stable, proven survivors
- Detects breakouts and accumulation
- 5-minute scan cycles

---

## Signal Types Explained

| Type | What it means |
|------|---------------|
| **KOL_CONFIRMED** | A tracked KOL wallet just bought this |
| **DISCOVERY** | Found via on-chain metrics (no KOL activity) |
| **KOL_VALIDATION** | Token discovered first, then KOL bought |
| **WATCH** | Worth monitoring, not yet a full buy signal |

---

## Position Sizing

The bot automatically sizes positions based on conviction:

| Conviction | Max Position |
|------------|--------------|
| ULTRA (3+ KOLs buying) | 3% |
| HIGH (2 KOLs buying) | 2.5% |
| Score 90+ | 2% |
| Standard | 1-2% |

---

## Risk Controls

Built-in protections:
- **Stop losses** set automatically (typically -30%)
- **Take profit targets**: TP1 at +50%, TP2 at +150%
- **Time decay stops** - exits stale positions
- **Max portfolio allocation** to memecoins: 20%
- **Rate limiting** - prevents over-trading

---

## Daily Digest

Every day at 9 AM Sydney time, you get a summary:
- Yesterday's trading activity
- Win rate and P&L
- Closed positions breakdown
- Performance trends

---

## Quick Setup Checklist

1. Get the bot token from Ross
2. Fund your bot wallet with SOL
3. Set your max trade size: `/set_max_trade 0.1`
4. Set your slippage: `/set_slippage 15`
5. Check status: `/status`
6. Wait for signals!

---

## Tips for New Users

- **Start small** - use 0.05-0.1 SOL max trades while learning
- **Watch the scores** - focus on signals with 75+ scores
- **Check confidence** - HIGH confidence signals are safer bets
- **Don't FOMO** - if you miss a signal, another will come
- **Use the blacklist** - if a token burned you, blacklist it
- **Check /stats regularly** - know your win rate

---

## Need Help?

- Use `/help` for the full command list
- Check `/status` if something seems off
- Ask Ross if you're stuck

Happy trading! Remember: only trade what you can afford to lose.
