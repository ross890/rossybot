# Solana Memecoin Trading Intelligence System

A comprehensive memecoin trading bot for Solana that tracks KOL (Key Opinion Leader) wallet activity and sends buy signals via Telegram.

## ⚠️ Risk Disclaimer

**This software is for educational and research purposes only.**

- Memecoin trading carries extreme risk of total capital loss
- Past KOL performance does not guarantee future results
- The 25% daily return target mentioned in requirements is not realistic
- Always conduct your own research (DYOR)
- Never invest more than you can afford to lose completely

## Features

- **KOL Wallet Tracking**: Monitor main wallets and detect side wallets
- **Scam Filtering**: Multi-stage filtering pipeline to avoid rugs
- **Scoring Engine**: Multi-factor scoring with transparent weightings
- **Telegram Alerts**: Real-time buy signals via rossybot
- **Rate Limiting**: Prevents alert fatigue
- **Position Management**: Entry/exit recommendations with risk parameters

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    SIGNAL GENERATOR                         │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ On-Chain │  │   KOL    │  │   Scam   │  │ Scoring  │    │
│  │   Data   │  │ Tracker  │  │  Filter  │  │  Engine  │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       │             │             │             │           │
│       └─────────────┴─────────────┴─────────────┘           │
│                           │                                 │
│                    ┌──────▼──────┐                          │
│                    │  Telegram   │                          │
│                    │    Bot      │                          │
│                    └─────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Node.js >= 18.0.0
- PostgreSQL >= 14
- Redis >= 6
- API Keys:
  - Helius (Solana RPC)
  - Birdeye
  - Twitter API v2
  - Telegram Bot Token

## Quick Start

### 1. Clone and Install

```bash
cd solana-memecoin-bot
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your API keys:

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/memecoin_bot

# Redis
REDIS_URL=redis://localhost:6379

# Solana RPC (Helius)
HELIUS_API_KEY=your_key_here
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Birdeye
BIRDEYE_API_KEY=your_key_here

# Twitter
TWITTER_BEARER_TOKEN=your_token_here

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

### 3. Create Telegram Bot

1. Message @BotFather on Telegram
2. Send `/newbot` and follow prompts
3. Name it "rossybot" (or your preferred name)
4. Save the bot token to `.env`
5. Message your bot with `/start`
6. Get your chat_id by visiting:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
7. Save chat_id to `.env`

### 4. Setup Database

```bash
# Create database
createdb memecoin_bot

# Run migrations
npm run db:migrate

# Seed example KOLs (edit with real data first!)
npm run db:seed
```

### 5. Add KOL Wallets

Edit `scripts/seed-kols.ts` with actual KOL handles and wallet addresses:

```typescript
const SEED_KOLS = [
  {
    handle: 'actual_kol_handle',
    followerCount: 150000,
    tier: KolTier.TIER_1,
    mainWallets: [
      'ACTUAL_VERIFIED_WALLET_ADDRESS_HERE'
    ],
  },
  // Add more KOLs...
];
```

### 6. Build and Run

```bash
# Build
npm run build

# Start
npm start

# Or development mode with hot reload
npm run dev
```

## Configuration

### Trading Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MAX_MEMECOIN_PORTFOLIO_PERCENT` | 20 | Max portfolio allocation to memecoins |
| `DEFAULT_POSITION_SIZE_PERCENT` | 2 | Default position size per trade |
| `MAX_SIGNALS_PER_HOUR` | 5 | Rate limit per hour |
| `MAX_SIGNALS_PER_DAY` | 20 | Rate limit per day |
| `MIN_SCORE_BUY_SIGNAL` | 70 | Minimum score for buy signal |

### Screening Thresholds

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MIN_MARKET_CAP` | 50,000 | Minimum market cap (USD) |
| `MAX_MARKET_CAP` | 10,000,000 | Maximum market cap (USD) |
| `MIN_24H_VOLUME` | 20,000 | Minimum 24h volume (USD) |
| `MIN_HOLDER_COUNT` | 100 | Minimum holder count |
| `MAX_TOP10_CONCENTRATION` | 50 | Maximum top 10 holder % |
| `MIN_LIQUIDITY_POOL` | 10,000 | Minimum LP size (USD) |
| `MIN_TOKEN_AGE_MINUTES` | 30 | Minimum token age |

## Signal Format

Every signal includes:

```
🎯 ROSSYBOT BUY SIGNAL

Token: $TICKER (address...)
Chain: Solana

📊 SIGNAL METRICS
├─ Composite Score: 82/100
├─ Confidence: HIGH
├─ Risk Level: 2/5
└─ Signal Type: KOL_CONFIRMED

👛 KOL WALLET ACTIVITY
├─ Status: ✅ CONFIRMED BUY DETECTED
├─ KOL: @handle
├─ Wallet Type: MAIN WALLET / SIDE WALLET
├─ Attribution: [Details for side wallets]
└─ KOL Historical Accuracy: 67% (34 trades)

📈 ON-CHAIN DATA
[Token metrics]

⚡ SUGGESTED ACTION
├─ Entry Zone: $X - $Y
├─ Position Size: 2% of portfolio
├─ Stop Loss: -30%
├─ Take Profit 1: +50%
└─ Take Profit 2: +150%
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize bot |
| `/status` | Portfolio summary |
| `/positions` | Open positions |
| `/help` | Show help |

## Project Structure

```
solana-memecoin-bot/
├── src/
│   ├── config/          # Configuration loading
│   ├── modules/
│   │   ├── onchain.ts       # Helius/Birdeye integration
│   │   ├── kol-tracker.ts   # KOL wallet monitoring
│   │   ├── scam-filter.ts   # Scam detection pipeline
│   │   ├── scoring.ts       # Multi-factor scoring
│   │   ├── telegram.ts      # Telegram bot
│   │   └── signal-generator.ts  # Main loop
│   ├── types/           # TypeScript types
│   ├── utils/
│   │   ├── database.ts  # PostgreSQL operations
│   │   └── logger.ts    # Pino logger
│   └── index.ts         # Entry point
├── scripts/
│   ├── migrate.ts       # Database migrations
│   └── seed-kols.ts     # KOL data seeding
├── .env.example         # Environment template
├── package.json
└── tsconfig.json
```

## API Costs (Estimated Monthly)

| Service | Tier | Cost |
|---------|------|------|
| Helius | Standard | ~$200 |
| Birdeye | Pro | ~$100 |
| Twitter API | Basic | ~$100 |
| Telegram | Free | $0 |
| **Total** | | ~$400/month |

## Adding Side Wallet Detection

The system can detect KOL side wallets via:

1. **Funding Cluster**: Wallets funded from main wallet
2. **Behavioural Match**: Correlated trading patterns
3. **Temporal Correlation**: Trades before public calls

Run side wallet detection manually:

```typescript
import { sideWalletDetector } from './modules/kol-tracker.js';

const candidates = await sideWalletDetector.detectSideWallets(
  kolId,
  ['main_wallet_address']
);
```

## Extending the System

### Adding New Data Sources

1. Create client in `src/modules/onchain.ts`
2. Export fetch functions
3. Integrate into scoring engine

### Adding New Scam Checks

1. Add check function in `src/modules/scam-filter.ts`
2. Add to filtering pipeline
3. Define thresholds

### Customizing Scoring

Edit weights in `src/modules/scoring.ts`:

```typescript
const FACTOR_WEIGHTS = {
  onChainHealth: 0.20,
  socialMomentum: 0.15,
  kolConvictionMain: 0.25,
  kolConvictionSide: 0.15,
  scamRiskInverse: 0.25,
};
```

## Monitoring

The bot logs all activity via Pino:

```bash
# View logs in development
npm run dev

# Production logs
npm start 2>&1 | tee bot.log
```

Recommended monitoring:
- Set up log aggregation (e.g., Datadog, ELK)
- Monitor API error rates
- Track signal performance

## Troubleshooting

### Bot not sending messages
1. Check `TELEGRAM_BOT_TOKEN` is correct
2. Verify `TELEGRAM_CHAT_ID` is your chat
3. Make sure you messaged `/start` to the bot

### No signals generated
1. Verify KOL wallets are in database
2. Check Helius/Birdeye API keys
3. Review logs for errors

### Rate limiting issues
1. Upgrade API tiers if needed
2. Increase polling intervals
3. Check Redis connection

## License

MIT License - See LICENSE file

## Contributing

1. Fork the repository
2. Create feature branch
3. Submit pull request

---

**Built for educational purposes. Trade responsibly.**
