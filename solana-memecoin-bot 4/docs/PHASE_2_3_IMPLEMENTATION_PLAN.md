# Phase 2 & 3 Implementation Plan

## Executive Summary

Based on analysis of the existing codebase, we have **strong foundations** for both phases:
- **Twitter API**: Fully implemented with OAuth, rate limiting, and caching
- **KOL Analytics**: Production-ready tier system with performance tracking
- **Wallet Monitoring**: Framework exists for side wallet detection
- **APIs**: Helius, Birdeye (WebSocket), DexScreener all configured

---

## PHASE 2: Social Intelligence (This Week)

### 2.1 Twitter Velocity Scanner

**Goal**: Detect tokens with rapidly accelerating Twitter mentions before they pump.

**File**: `src/modules/discovery/twitter-velocity-scanner.ts`

**Implementation Approach**:
```
┌─────────────────────────────────────────────────────────────┐
│                 TWITTER VELOCITY SCANNER                     │
├─────────────────────────────────────────────────────────────┤
│  1. Scan Twitter every 5 minutes for token mentions          │
│  2. Track mention velocity (mentions per hour)               │
│  3. Detect acceleration (current hour vs previous 6h avg)    │
│  4. Extract token addresses from tweets (CA patterns)        │
│  5. Feed high-velocity tokens to discovery engine            │
└─────────────────────────────────────────────────────────────┘
```

**Key Metrics to Track**:
- `mentionsPerHour`: Current hourly rate
- `velocityAcceleration`: (current hour / avg of last 6h)
- `engagementRate`: (retweets + likes + replies) / mentions
- `uniqueAccounts`: Deduplicated account mentions (anti-spam)
- `avgAccountQuality`: Based on age, followers, verified status

**Thresholds for Signals**:
| Metric | WATCH | BUY Signal |
|--------|-------|------------|
| Velocity Acceleration | >2x | >5x |
| Unique Mentions/Hour | >20 | >50 |
| Engagement Rate | >10 | >25 |
| Avg Account Quality | >40 | >60 |

**Integration with Existing Code**:
- Use `TwitterClient.searchRecentTweets()` from `src/modules/social/twitter-client.ts`
- Use `SocialAnalyzer.analyzeSocialMetrics()` for sentiment/quality
- Feed addresses to `DiscoveryEngine.getAllDiscoveredTokens()`

**Rate Limit Considerations**:
- Twitter API: 180-300 requests per 15-minute window
- Strategy: Batch searches, prioritize trending tickers, cache 1-5 minutes
- Fallback: If rate limited, rely on KOL mentions (fewer but higher quality)

---

### 2.2 KOL Twitter Feed Monitor

**Goal**: Real-time monitoring of KOL tweets for early token mentions.

**File**: `src/modules/discovery/kol-feed-monitor.ts`

**Implementation Approach**:
```
┌─────────────────────────────────────────────────────────────┐
│                  KOL FEED MONITOR                            │
├─────────────────────────────────────────────────────────────┤
│  1. Maintain list of tracked KOL Twitter handles             │
│  2. Poll recent tweets every 2-3 minutes (rate limit aware)  │
│  3. Parse tweets for token addresses/tickers                 │
│  4. Cross-reference with KOL tier from kol-analytics         │
│  5. Weight signals by KOL performance history                │
└─────────────────────────────────────────────────────────────┘
```

**Existing KOL Data** (from `scripts/seed-kols.ts`):
- **Tier S**: blknoiz06 (Ansem), MustStopMurad, JADAWGS, Pain
- **Tier A**: degenspartan, 0xsun, CryptoGodJohn
- **Tier B+**: Extended list of 50+ tracked KOLs

**Token Extraction Patterns**:
```typescript
// Contract address patterns
const CA_PATTERN = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// Ticker patterns
const TICKER_PATTERN = /\$([A-Z]{2,10})/g;

// Dexscreener links
const DEX_LINK_PATTERN = /dexscreener\.com\/solana\/([a-zA-Z0-9]+)/g;
```

**Signal Weighting by KOL Tier**:
| KOL Tier | Signal Weight | Min Hold Time Check |
|----------|---------------|---------------------|
| S-Tier | 1.5x | Yes (>1h avg) |
| A-Tier | 1.3x | Yes (>1h avg) |
| B-Tier | 1.1x | Yes (>30m avg) |
| Unproven | 1.0x | No |

**Integration**:
- Link to `kolAnalytics.getKolStats(kolId)` for performance data
- Link to `kolAnalytics.getSignalWeightMultiplier(stats)` for weighting
- Store mention timestamps in `kol_twitter_mentions` table (new)

---

### 2.3 Social + On-Chain Cross-Reference

**Goal**: Correlate social buzz with on-chain activity for higher-confidence signals.

**File**: `src/modules/discovery/social-onchain-correlator.ts`

**Implementation Approach**:
```
┌─────────────────────────────────────────────────────────────┐
│              SOCIAL + ON-CHAIN CORRELATOR                    │
├─────────────────────────────────────────────────────────────┤
│  Social Signal                    On-Chain Signal            │
│  ─────────────                    ───────────────            │
│  • Twitter velocity spike    +    • Volume anomaly          │
│  • KOL mention              +    • KOL wallet buy           │
│  • Sentiment shift          +    • Holder growth            │
│                                                              │
│  → Combined signals = HIGHER CONVICTION                      │
└─────────────────────────────────────────────────────────────┘
```

**Correlation Types**:

1. **KOL Tweet + KOL Buy** (Highest Signal):
   - KOL mentions token on Twitter
   - Same KOL's wallet buys within 30 minutes
   - **Conviction Boost**: +30 points

2. **Social Velocity + Volume Spike**:
   - Twitter mentions accelerating >3x
   - Volume anomaly detected (>5x normal)
   - **Conviction Boost**: +20 points

3. **Multiple KOL Mentions + Holder Growth**:
   - 3+ KOLs mention same token within 1 hour
   - Holder growth >50/hour
   - **Conviction Boost**: +25 points

4. **Sentiment Shift + Price Action**:
   - Sentiment flips from neutral to bullish
   - Price up >20% in same window
   - **Conviction Boost**: +15 points

**Data Structure**:
```typescript
interface CorrelatedSignal {
  tokenAddress: string;
  socialSignals: {
    twitterVelocity: number;
    kolMentions: KolMention[];
    sentimentScore: number;
    engagementRate: number;
  };
  onChainSignals: {
    volumeAnomaly: VolumeAnomaly | null;
    holderGrowth: HolderGrowthSignal | null;
    kolWalletBuys: KolWalletActivity[];
  };
  correlationScore: number;      // 0-100
  correlationType: CorrelationType[];
  timestamp: number;
}
```

---

### Phase 2 Database Schema Additions

```sql
-- KOL Twitter Mentions
CREATE TABLE kol_twitter_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kol_id UUID REFERENCES kols(id),
  twitter_handle VARCHAR(50),
  tweet_id VARCHAR(30) NOT NULL,
  token_address VARCHAR(64),
  ticker VARCHAR(20),
  tweet_text TEXT,
  engagement_count INTEGER,
  mentioned_at TIMESTAMP NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Twitter Velocity Tracking
CREATE TABLE twitter_velocity_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address VARCHAR(64) NOT NULL,
  ticker VARCHAR(20),
  hour_bucket TIMESTAMP NOT NULL,
  mention_count INTEGER,
  unique_accounts INTEGER,
  total_engagement INTEGER,
  avg_account_quality DECIMAL(5, 2),
  velocity_acceleration DECIMAL(5, 2),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(token_address, hour_bucket)
);

-- Correlated Signals
CREATE TABLE correlated_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address VARCHAR(64) NOT NULL,
  correlation_type VARCHAR(50)[],
  social_score INTEGER,
  onchain_score INTEGER,
  correlation_score INTEGER,
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

### Phase 2 File Structure

```
src/modules/discovery/
├── index.ts                          # Updated: Add social scanners
├── volume-anomaly-scanner.ts         # Existing
├── holder-growth-scanner.ts          # Existing
├── narrative-scanner.ts              # Existing
├── twitter-velocity-scanner.ts       # NEW: Twitter velocity detection
├── kol-feed-monitor.ts               # NEW: KOL tweet monitoring
└── social-onchain-correlator.ts      # NEW: Cross-reference signals
```

---

### Phase 2 Timeline (5 Days)

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Twitter Velocity Scanner | Basic velocity tracking + address extraction |
| 2 | KOL Feed Monitor | Poll KOL tweets, extract tokens |
| 3 | Integration Testing | Verify rate limits, caching, error handling |
| 4 | Social-OnChain Correlator | Combine signals with conviction scoring |
| 5 | Discovery Engine Integration | Feed to signal generator, test end-to-end |

---

## PHASE 3: Smart Money Tracking (Next Week)

### 3.1 Identifying Top-Performing Wallets

**Goal**: Build a knowledge base of wallets with consistently profitable trading patterns.

**File**: `src/modules/smart-money/wallet-profiler.ts`

**How to Identify Smart Money Wallets**:

```
┌─────────────────────────────────────────────────────────────┐
│            SMART MONEY WALLET IDENTIFICATION                 │
├─────────────────────────────────────────────────────────────┤
│  SOURCE 1: KOL Known Wallets (Already Have)                  │
│  ─────────────────────────────────────────                   │
│  • Main wallets from seed data (HIGH confidence)             │
│  • Side wallets from detection system (MEDIUM confidence)    │
│                                                              │
│  SOURCE 2: Historical Win Rate Analysis (Build)              │
│  ──────────────────────────────────────────────              │
│  • Scan top gainers over past 30 days                       │
│  • Identify wallets that bought early (<5% of peak MCap)    │
│  • Track their subsequent trades for win rate               │
│  • Promote to "Smart Money" if win rate >40%                │
│                                                              │
│  SOURCE 3: Token Launch Analysis (Build)                     │
│  ─────────────────────────────────────────                   │
│  • Monitor pump.fun graduates (>$100K MCap)                 │
│  • Find wallets that bought in first 100 holders            │
│  • Track their historical accuracy                          │
└─────────────────────────────────────────────────────────────┘
```

**Wallet Profiling Metrics**:
```typescript
interface WalletProfile {
  address: string;
  category: 'KOL' | 'SMART_MONEY' | 'DEV' | 'WHALE' | 'UNKNOWN';

  // Performance metrics
  totalTrades: number;
  winRate: number;              // Trades with >0% ROI
  avgROI: number;               // Average return per trade
  bestTrade: { token: string; roi: number };

  // Timing metrics
  avgEntryTiming: number;       // How early (% from launch)
  avgHoldTime: number;          // Hours held
  exitTiming: 'EARLY' | 'PEAK' | 'LATE' | 'HODL';

  // Activity metrics
  tradesLast7d: number;
  tradesLast30d: number;
  lastActiveAt: Date;

  // Classification
  confidenceScore: number;      // 0-100
  discoveryMethod: 'KNOWN_KOL' | 'WIN_RATE_ANALYSIS' | 'EARLY_BUYER' | 'FUNDING_TRACE';
}
```

**Win Rate Analysis Algorithm**:
```typescript
async function analyzeWalletWinRate(address: string): Promise<WalletProfile> {
  // 1. Get last 100 token trades for this wallet
  const trades = await heliusClient.getRecentTransactions(address, 100);

  // 2. For each token trade, determine outcome
  const outcomes = await Promise.all(
    trades.map(async (trade) => {
      const entryPrice = trade.priceAtBuy;
      const peakPrice = await getTokenPeakPrice(trade.tokenAddress, trade.timestamp);
      const currentPrice = await getTokenCurrentPrice(trade.tokenAddress);

      return {
        token: trade.tokenAddress,
        entryPrice,
        peakPrice,
        exitPrice: trade.sellPrice || currentPrice,
        roi: ((trade.sellPrice || currentPrice) - entryPrice) / entryPrice,
        maxPotentialROI: (peakPrice - entryPrice) / entryPrice,
        timing: calculateEntryTiming(trade),
      };
    })
  );

  // 3. Calculate aggregate metrics
  const wins = outcomes.filter(o => o.roi > 0).length;
  const winRate = wins / outcomes.length;
  const avgROI = outcomes.reduce((sum, o) => sum + o.roi, 0) / outcomes.length;

  return buildProfile(address, outcomes, winRate, avgROI);
}
```

**Minimum Thresholds for "Smart Money" Classification**:
| Metric | Threshold |
|--------|-----------|
| Win Rate | >40% |
| Total Trades | >20 |
| Avg ROI | >50% |
| Last Active | Within 7 days |
| Avg Entry Timing | <10% from launch MCap |

---

### 3.2 Real-Time Smart Money Alerts

**Goal**: Alert when profiled smart money wallets enter new positions.

**File**: `src/modules/smart-money/wallet-monitor.ts`

**Implementation Approach**:
```
┌─────────────────────────────────────────────────────────────┐
│              REAL-TIME WALLET MONITORING                     │
├─────────────────────────────────────────────────────────────┤
│  Option A: Helius Webhook (RECOMMENDED)                      │
│  ───────────────────────────────────────                     │
│  • Register webhooks for each smart money wallet            │
│  • Receive push notifications on new transactions           │
│  • Latency: <1 second                                       │
│  • Cost: Helius plan dependent                              │
│                                                              │
│  Option B: Polling (FALLBACK)                                │
│  ─────────────────────────────                               │
│  • Poll each wallet every 30 seconds                        │
│  • Compare transaction list to cached version               │
│  • Latency: 30 seconds average                              │
│  • Cost: Higher API usage                                   │
└─────────────────────────────────────────────────────────────┘
```

**Helius Webhook Setup**:
```typescript
// src/modules/smart-money/helius-webhook.ts
import { Helius } from 'helius-sdk';

const helius = new Helius(config.HELIUS_API_KEY);

async function registerWalletWebhook(walletAddress: string): Promise<void> {
  await helius.createWebhook({
    webhookURL: `${config.WEBHOOK_BASE_URL}/smart-money/alert`,
    accountAddresses: [walletAddress],
    transactionTypes: ['SWAP', 'TRANSFER'],
    webhookType: 'enhanced',
  });
}

// Express endpoint to receive webhooks
app.post('/smart-money/alert', async (req, res) => {
  const { transactions } = req.body;

  for (const tx of transactions) {
    if (isTokenBuy(tx)) {
      await processSmartMoneyBuy(tx);
    }
  }

  res.sendStatus(200);
});
```

**Alert Processing Flow**:
```
Webhook Received → Parse Transaction → Is Token Buy?
                                           ↓ Yes
                         Get Wallet Profile → Calculate Signal Weight
                                           ↓
                         Create Conviction Signal → Feed to Signal Generator
```

**Signal Weight by Wallet Category**:
| Category | Base Weight | Confidence Multiplier |
|----------|-------------|----------------------|
| KOL (S-Tier) | 1.5x | × confidence score |
| KOL (A-Tier) | 1.3x | × confidence score |
| Smart Money | 1.4x | × confidence score |
| Early Buyer | 1.2x | × confidence score |
| Dev Wallet | 0.5x (caution) | - |

---

### 3.3 Developer Wallet Behavior Tracking

**Goal**: Monitor dev wallets for early warning signs (dumps, large sells, suspicious transfers).

**File**: `src/modules/smart-money/dev-wallet-tracker.ts`

**Dev Wallet Identification Methods**:

1. **From Token Metadata**:
   - Parse token creation transaction
   - First wallet to receive minted tokens = likely dev
   - Check if wallet was funded recently (fresh wallet = higher rug risk)

2. **From Holder Distribution**:
   - Wallet holding >5% of supply at launch
   - Wallet that deployed the token contract

3. **From DexScreener Paid Status**:
   - If token has paid DexScreener, trace payment wallet
   - May link to dev or marketing wallet

**Suspicious Behaviors to Track**:
```typescript
interface DevWalletAlert {
  type:
    | 'LARGE_SELL'           // >5% of holdings sold
    | 'SUPPLY_DUMP'          // >10% of total supply moved
    | 'FRESH_WALLET_FUND'    // Funded within 24h of token creation
    | 'MULTIPLE_TOKENS'      // Created 3+ tokens recently (serial rugger)
    | 'LIQUIDITY_REMOVAL'    // LP tokens removed
    | 'SUSPICIOUS_TRANSFER'; // Large transfer to exchange deposit address

  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  tokenAddress: string;
  devWallet: string;
  details: string;
  timestamp: Date;
}
```

**Alert Thresholds**:
| Behavior | Threshold | Severity | Action |
|----------|-----------|----------|--------|
| Large Sell | >5% of dev holdings | MEDIUM | Flag position |
| Supply Dump | >10% of total supply | HIGH | Consider exit |
| Fresh Wallet | Funded <24h before launch | LOW | Informational |
| Serial Creator | 3+ tokens in 7 days | HIGH | Block buys |
| LP Removal | Any amount | CRITICAL | Immediate exit |

**Integration with Positions**:
```typescript
// In position management, add dev wallet monitoring
async function monitorPositionRisk(position: Position): Promise<void> {
  const devWallet = await getDevWallet(position.tokenAddress);

  if (devWallet) {
    devWalletTracker.subscribe(devWallet, position.tokenAddress, {
      onAlert: (alert) => {
        if (alert.severity === 'CRITICAL') {
          // Trigger emergency exit
          await emergencyExit(position);
        } else if (alert.severity === 'HIGH') {
          // Move stop loss to break-even
          await tightenStopLoss(position);
        }
      }
    });
  }
}
```

---

### Phase 3 Database Schema Additions

```sql
-- Smart Money Wallet Profiles
CREATE TABLE smart_money_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address VARCHAR(64) UNIQUE NOT NULL,
  category VARCHAR(20) NOT NULL,  -- KOL, SMART_MONEY, DEV, WHALE

  -- Performance
  total_trades INTEGER DEFAULT 0,
  win_rate DECIMAL(5, 4),
  avg_roi DECIMAL(10, 4),
  best_trade_token VARCHAR(64),
  best_trade_roi DECIMAL(10, 2),

  -- Timing
  avg_entry_timing DECIMAL(5, 2),
  avg_hold_time_hours DECIMAL(10, 2),

  -- Activity
  trades_last_7d INTEGER DEFAULT 0,
  trades_last_30d INTEGER DEFAULT 0,
  last_active_at TIMESTAMP,

  -- Classification
  confidence_score INTEGER,
  discovery_method VARCHAR(50),
  notes TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Wallet Activity Log
CREATE TABLE wallet_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address VARCHAR(64) NOT NULL,
  token_address VARCHAR(64) NOT NULL,
  action VARCHAR(20) NOT NULL,  -- BUY, SELL, TRANSFER
  amount DECIMAL(20, 8),
  sol_value DECIMAL(20, 8),
  usd_value DECIMAL(20, 2),
  transaction_signature VARCHAR(128),
  timestamp TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_wallet_activity_wallet ON wallet_activity_log(wallet_address);
CREATE INDEX idx_wallet_activity_token ON wallet_activity_log(token_address);
CREATE INDEX idx_wallet_activity_timestamp ON wallet_activity_log(timestamp DESC);

-- Dev Wallet Tracking
CREATE TABLE dev_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address VARCHAR(64) NOT NULL,
  wallet_address VARCHAR(64) NOT NULL,
  identification_method VARCHAR(50),  -- CREATOR, LARGE_HOLDER, METADATA
  initial_supply_percent DECIMAL(5, 2),
  current_supply_percent DECIMAL(5, 2),
  wallet_age_at_launch_hours INTEGER,
  previous_tokens_created INTEGER DEFAULT 0,
  risk_score INTEGER,  -- 0-100
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(token_address, wallet_address)
);

-- Dev Wallet Alerts
CREATE TABLE dev_wallet_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address VARCHAR(64) NOT NULL,
  dev_wallet VARCHAR(64) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  details TEXT,
  transaction_signature VARCHAR(128),
  alerted_at TIMESTAMP NOT NULL,
  acknowledged BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_dev_alerts_token ON dev_wallet_alerts(token_address);
CREATE INDEX idx_dev_alerts_severity ON dev_wallet_alerts(severity);
```

---

### Phase 3 File Structure

```
src/modules/smart-money/
├── index.ts                    # Unified smart money engine
├── wallet-profiler.ts          # Profile wallets, calculate win rates
├── wallet-monitor.ts           # Real-time monitoring (webhook/polling)
├── helius-webhook.ts           # Helius webhook integration
├── dev-wallet-tracker.ts       # Dev wallet behavior monitoring
└── types.ts                    # Shared types and interfaces
```

---

### Phase 3 Timeline (7 Days)

| Day | Task | Deliverable |
|-----|------|-------------|
| 1 | Database Schema | Create tables, indexes |
| 2 | Wallet Profiler | Win rate analysis algorithm |
| 3 | Wallet Profiler | Historical data backfill |
| 4 | Wallet Monitor | Helius webhook setup |
| 5 | Wallet Monitor | Polling fallback + alerting |
| 6 | Dev Wallet Tracker | Identification + behavior monitoring |
| 7 | Integration | Connect to signal generator, test end-to-end |

---

## Integration Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SIGNAL GENERATOR                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  PHASE 1: Token Discovery        PHASE 2: Social Intel    PHASE 3: $$$  │
│  ─────────────────────────       ────────────────────     ────────────  │
│  • Volume Anomaly Scanner   +    • Twitter Velocity   +   • Smart $     │
│  • Holder Growth Scanner    +    • KOL Feed Monitor   +   • Dev Track   │
│  • Narrative Scanner        +    • Social Correlator  +   • Webhook     │
│                                                                          │
│                    ↓                    ↓                    ↓           │
│              ┌─────────────────────────────────────────────────┐        │
│              │           DISCOVERY ENGINE                       │        │
│              │   getAllDiscoveredTokens() → Candidate Pool      │        │
│              └─────────────────────────────────────────────────┘        │
│                                     ↓                                    │
│              ┌─────────────────────────────────────────────────┐        │
│              │           CONVICTION SCORING                     │        │
│              │   Base Score + Social Boost + Smart Money Boost  │        │
│              └─────────────────────────────────────────────────┘        │
│                                     ↓                                    │
│              ┌─────────────────────────────────────────────────┐        │
│              │           SIGNAL OUTPUT                          │        │
│              │   PROVEN_RUNNER or EARLY_QUALITY track           │        │
│              └─────────────────────────────────────────────────┘        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Risk Considerations

### Twitter API Risks
- **Rate Limits**: 180-300 requests per 15-minute window
- **Mitigation**: Aggressive caching, prioritize KOL feeds over general search
- **Cost**: May need Twitter API Pro ($100/mo) for higher limits

### Helius Webhook Costs
- **Free Tier**: 10 webhooks
- **Paid Tier**: $49/mo for 100 webhooks, $199/mo for unlimited
- **Mitigation**: Start with top 10 smart money wallets, expand based on ROI

### False Positives
- **Twitter Velocity**: Bots can inflate mention counts
- **Mitigation**: Account quality scoring, unique account filtering
- **Smart Money**: Wallets can have lucky streaks
- **Mitigation**: Require 20+ trades, 30-day window, confidence decay

### Dev Wallet Tracking
- **False Alerts**: Not all large sells are rugs
- **Mitigation**: Severity levels, confirmation windows, % thresholds

---

## Success Metrics

### Phase 2 KPIs
- **Twitter Signal Accuracy**: >30% of velocity signals lead to >50% gains
- **KOL Mention Lead Time**: Average 15 minutes before price pump
- **Correlation Boost**: Correlated signals 20% more accurate than single-source

### Phase 3 KPIs
- **Smart Money Identification**: 50+ profiled wallets with >40% win rate
- **Alert Latency**: <5 seconds from on-chain activity to signal
- **Dev Alert Accuracy**: <10% false positive rate on HIGH/CRITICAL alerts

---

## Next Steps

1. **User Review**: Confirm priorities and approach
2. **Phase 2 Day 1**: Begin Twitter Velocity Scanner implementation
3. **API Audit**: Verify Twitter API tier and Helius plan capabilities
4. **Database Migration**: Run schema additions before coding begins

---

*Document created: 2026-02-02*
*Architecture: Multi-source discovery with social + smart money layers*
