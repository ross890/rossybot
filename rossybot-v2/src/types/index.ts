// ============================================================
// ROSSYBOT V2 — Core Type Definitions
// ============================================================

// --- Enums ---

export enum CapitalTier {
  MICRO = 'MICRO',   // <3 SOL
  SMALL = 'SMALL',   // 3-10 SOL
  MEDIUM = 'MEDIUM', // 10-50 SOL
  FULL = 'FULL',     // >50 SOL
}

export enum WalletSource {
  NANSEN_DISCOVERY = 'NANSEN_DISCOVERY',
  NANSEN_SEED = 'NANSEN_SEED',
  MANUAL = 'MANUAL',
}

export enum WalletTier {
  A = 'A',
  B = 'B',
}

export enum SignalType {
  BUY = 'BUY',
  SELL = 'SELL',
  OTHER = 'OTHER',
}

export enum DetectionSource {
  HELIUS_WS = 'HELIUS_WS',
  HELIUS_RPC_FALLBACK = 'HELIUS_RPC_FALLBACK',
  PUMPFUN_CURVE = 'PUMPFUN_CURVE',
}

export enum ValidationResult {
  PASSED = 'PASSED',
  FAILED_SAFETY = 'FAILED_SAFETY',
  FAILED_LIQUIDITY = 'FAILED_LIQUIDITY',
  FAILED_MOMENTUM = 'FAILED_MOMENTUM',
  FAILED_MCAP = 'FAILED_MCAP',
  FAILED_AGE = 'FAILED_AGE',
  FAILED_WALLET_COUNT = 'FAILED_WALLET_COUNT',
}

export enum SignalAction {
  EXECUTED = 'EXECUTED',
  SKIPPED_VALIDATION = 'SKIPPED_VALIDATION',
  SKIPPED_MAX_POSITIONS = 'SKIPPED_MAX_POSITIONS',
  SKIPPED_DAILY_LIMIT = 'SKIPPED_DAILY_LIMIT',
  SKIPPED_MIN_POSITION = 'SKIPPED_MIN_POSITION',
}

export enum PositionStatus {
  OPEN = 'OPEN',
  PARTIAL_EXIT = 'PARTIAL_EXIT',
  CLOSED = 'CLOSED',
}

export enum WsHealthEvent {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  RECONNECTING = 'RECONNECTING',
  RECONNECTED = 'RECONNECTED',
  STALE_DETECTED = 'STALE_DETECTED',
  PING_TIMEOUT = 'PING_TIMEOUT',
  SUBSCRIPTION_SENT = 'SUBSCRIPTION_SENT',
  MESSAGE_RECEIVED = 'MESSAGE_RECEIVED',
}

// --- Interfaces ---

export interface AlphaWallet {
  address: string;
  label: string;
  source: WalletSource;
  nansen_tags: string[];
  nansen_pnl_usd: number;
  nansen_roi_percent: number;
  nansen_holding_ratio: number;
  nansen_trade_count: number;
  nansen_realized_pnl: number;
  nansen_unrealized_pnl: number;
  tier: WalletTier;
  min_capital_tier: CapitalTier;
  helius_subscribed: boolean;
  active: boolean;
  discovered_at: Date;
  last_validated_at: Date;
  our_total_trades: number;
  our_win_rate: number;
  our_avg_pnl_percent: number;
  our_avg_hold_time_mins: number;
  consecutive_losses: number;
}

export interface WalletTransaction {
  id: string;
  wallet_address: string;
  tx_signature: string;
  block_time: Date;
  detected_at: Date;
  detection_lag_ms: number;
  type: SignalType;
  token_mint: string;
  token_symbol: string | null;
  amount: number;
  estimated_sol_value: number | null;
  raw_tx: Record<string, unknown>;
}

export interface SignalEvent {
  id: string;
  token_address: string;
  token_symbol: string | null;
  wallet_addresses: string[];
  wallet_count: number;
  first_detected_at: Date;
  detection_source: DetectionSource;
  validation_result: ValidationResult;
  validation_details: Record<string, unknown>;
  momentum_data: Record<string, unknown>;
  capital_tier: CapitalTier;
  action_taken: SignalAction;
  position_id: string | null;
}

export interface Position {
  id: string;
  token_address: string;
  token_symbol: string;
  entry_price: number;
  entry_sol: number;
  entry_tx: string;
  entry_time: Date;
  alpha_buy_time: Date;
  execution_lag_seconds: number;
  signal_wallet: string;
  signal_wallet_count: number;
  capital_tier_at_entry: CapitalTier;
  confluence_score: number | null;
  confluence_details: Record<string, unknown> | null;
  momentum_at_entry: Record<string, unknown>;
  status: PositionStatus;
  current_price: number;
  peak_price: number;
  pnl_sol: number;
  pnl_percent: number;
  fees_paid_sol: number;
  net_pnl_sol: number;
  exit_reason: string | null;
  partial_exits: Record<string, unknown>[];
  closed_at: Date | null;
  hold_time_mins: number | null;
  sell_retry_count: number;
}

export interface AlphaWalletExit {
  id: string;
  position_id: string;
  wallet_address: string;
  detected_at: Date;
  detection_lag_ms: number;
  sell_percentage: number;
  tx_signature: string;
  our_action: string;
  detection_source: DetectionSource;
}

export interface DailyStats {
  date: string;
  starting_capital_sol: number;
  ending_capital_sol: number;
  capital_tier: string;
  trades_entered: number;
  trades_exited: number;
  total_pnl_sol: number;
  total_fees_sol: number;
  net_pnl_sol: number;
  win_count: number;
  loss_count: number;
  avg_hold_time_mins: number;
  avg_execution_lag_secs: number;
  avg_helius_detection_lag_ms: number;
  signals_detected: number;
  signals_skipped: number;
  alpha_exits_detected: number;
  nansen_api_calls: number;
  helius_ws_uptime_percent: number;
  helius_ws_reconnects: number;
}

// --- Capital Tier Config ---

export interface TierConfig {
  tier: CapitalTier;
  maxPositions: number;
  walletsMonitored: number;
  positionSizePct: number;
  minPositionSol: number;
  profitTarget: number;
  stopLoss: number;
  hardKill: number;
  partialExitsEnabled: boolean;
  walletConfluenceRequired: number;
  confluenceWindow: number; // minutes
  timeKills: { hours: number; minPnlPct: number }[];
  hardTimeHours: number;
  mcapMin: number;
  mcapMax: number;
  liquidityMin: number;
  momentumWindow: '6h' | '24h';
  momentumMin: number;
  momentumMax: number;
  volumeMultiplierMin: number;
  tokenMaxAgeDays: number | null;
  minSignalScore: number; // minimum score (0-100) to enter a trade
}

// --- Helius Types ---

export interface HeliusTransactionNotification {
  jsonrpc: string;
  method: string;
  params: {
    subscription: number;
    result: {
      signature: string;
      slot: number;
      transaction: {
        meta: {
          err: unknown;
          fee: number;
          preBalances: number[];
          postBalances: number[];
          preTokenBalances: HeliusTokenBalance[];
          postTokenBalances: HeliusTokenBalance[];
        };
        transaction: {
          signatures: string[];
          message: {
            accountKeys: HeliusAccountKey[];
            instructions: unknown[];
          };
        };
        blockTime: number;
      };
    };
  };
}

export interface HeliusTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}

export interface HeliusAccountKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
  source?: string;
}

// --- DexScreener Types ---

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd: string;
  txns: {
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: { h1: number; h6: number; h24: number; };
  priceChange: { h1: number; h6: number; h24: number; };
  liquidity: { usd: number; base: number; quote: number };
  fdv: number;
  marketCap: number;
  pairCreatedAt: number;
}

// --- RugCheck Types ---

export interface RugCheckResult {
  mint: string;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  topHolderConcentration: number;
  lpLocked: boolean;
  score: number;
  risks: string[];
}

// --- Validation Types ---

export interface ValidationCheckResult {
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface FullValidationResult {
  passed: boolean;
  failReason: ValidationResult | null;
  safety: ValidationCheckResult;
  liquidity: ValidationCheckResult;
  momentum: ValidationCheckResult;
  mcap: ValidationCheckResult;
  age: ValidationCheckResult;
  dexData: DexScreenerPair | null;
  rugCheck: RugCheckResult | null;
  durationMs: number;
}

// --- Parsed Signal ---

export interface ParsedSignal {
  walletAddress: string;
  txSignature: string;
  blockTime: number;
  type: SignalType;
  tokenMint: string;
  tokenAmount: number;
  solDelta: number;
  detectedAt: Date;
  detectionLagMs: number;
  detectionSource: DetectionSource;
  /** True if this transaction interacts with the pump.fun bonding curve program */
  isPumpFun?: boolean;
  /** Pump.fun bonding curve metadata (only present for pump.fun transactions) */
  pumpFunData?: PumpFunSignalData;
}

// --- Pump.fun Types ---

export interface PumpFunSignalData {
  /** The bonding curve account address */
  bondingCurveAddress: string;
  /** SOL amount the wallet spent on the bonding curve */
  solSpent: number;
}

export interface PumpFunConfig {
  /** Pump.fun bonding curve program ID */
  programId: string;
  /** Position size multiplier vs standard tier size (0.3-0.5x) */
  positionSizeMultiplier: number;
  /** Time kill: close if no movement after this many minutes */
  staleTimeKillMins: number;
  /** Hard stop loss for pump.fun positions */
  stopLoss: number;
  /** Hard kill for pump.fun positions */
  hardKill: number;
  /** Profit target to sell into graduation liquidity spike */
  graduationProfitTarget: number;
  /** Percentage to sell at graduation (rest becomes standard V2 position) */
  graduationSellPct: number;
  /** Minimum SOL spent by alpha wallet to consider it a conviction buy */
  minConvictionSol: number;
  /** Minimum bonding curve velocity (SOL/min) to enter */
  minCurveVelocity: number;
  /** Max age in minutes for a pump.fun token to be eligible */
  maxTokenAgeMins: number;
  /** Max concurrent pump.fun positions */
  maxPositions: number;
  /** Slippage for bonding curve buys (higher than Jupiter) */
  slippageBps: number;
}

// --- Common position view for Telegram/UI (works with both Shadow & Live) ---

export interface PositionView {
  id: string;
  token_address: string;
  token_symbol: string | null;
  entry_price: number;
  entry_sol: number;
  entry_time: Date;
  alpha_buy_time: Date;
  status: PositionStatus;
  current_price: number;
  peak_price: number;
  pnl_percent: number;
  pnl_sol: number;
  fees_paid_sol: number;
  net_pnl_sol: number;
  exit_reason: string | null;
  closed_at: Date | null;
  hold_time_mins: number | null;
  partial_exits: Array<{ time: Date; pct: number; price: number; reason: string }>;
  signal_wallets: string[];
  capital_tier: string;
  entry_tx?: string;
}

// --- Shadow Position (Phase 1) ---

export interface ShadowPosition {
  id: string;
  token_address: string;
  token_symbol: string | null;
  entry_price: number;
  entry_time: Date;
  alpha_buy_time: Date;
  signal_wallets: string[];
  capital_tier: CapitalTier;
  simulated_entry_sol: number;
  status: PositionStatus;
  current_price: number;
  peak_price: number;
  pnl_percent: number;
  exit_reason: string | null;
  closed_at: Date | null;
  hold_time_mins: number | null;
  partial_exits: { time: Date; pct: number; price: number; reason: string }[];
}
