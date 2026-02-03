// ===========================================
// MATURE TOKEN MODULE - EXPORTS
// Established Token Strategy v2
// ===========================================

// Types and Configuration
export * from './types.js';

// Re-export key types for convenience
export {
  TokenTier,
  TIER_CONFIG,
  TAKE_PROFIT_CONFIG,
  POSITION_CONFIG,
  getTokenTier,
  getStopLossForTier,
  getPositionSize,
} from './types.js';

// Analyzers
export { accumulationDetector, AccumulationDetector } from './accumulation-detector.js';
export { breakoutAnalyzer, BreakoutAnalyzer } from './breakout-analyzer.js';
export { holderDynamicsAnalyzer, HolderDynamicsAnalyzer } from './holder-dynamics.js';
export { volumeProfileAnalyzer, VolumeProfileAnalyzer } from './volume-profile.js';
export { smartMoneyTracker, SmartMoneyTracker } from './smart-money-tracker.js';
export { kolReentryDetector, KolReentryDetector } from './kol-reentry-detector.js';

// Scorer
export { matureTokenScorer, MatureTokenScorer } from './mature-token-scorer.js';

// Scanner
export { matureTokenScanner, MatureTokenScanner } from './mature-token-scanner.js';

// Telegram
export { matureTokenTelegram, MatureTokenTelegramFormatter } from './telegram-formatter.js';
