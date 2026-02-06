// ===========================================
// MODULE: PERFORMANCE TRACKING INDEX
// Exports all performance tracking components
// ===========================================

export {
  SignalPerformanceTracker,
  signalPerformanceTracker,
  SignalRecord,
  PerformanceSnapshot,
  SignalPerformance,
  PerformanceStats,
} from './signal-performance-tracker.js';

export {
  ThresholdOptimizer,
  thresholdOptimizer,
  ThresholdRecommendation,
  OptimizationResult,
  ThresholdSet,
} from './threshold-optimizer.js';

export {
  DailyReportGenerator,
  dailyReportGenerator,
  DailyReport,
} from './daily-report.js';

export {
  DailyAutoOptimizer,
  dailyAutoOptimizer,
} from './daily-auto-optimizer.js';

export {
  DeploymentLogsReader,
  deploymentLogsReader,
  DeploymentLog,
  PerformanceMetric,
  SystemHealthSnapshot,
  TradeOutcomeAnalysis,
  LogQuery,
  LogSummary,
  PerformanceSummary,
  WinLossAnalysis,
  LogSeverity,
  LogCategory,
} from './deployment-logs-reader.js';

export {
  PerformanceLogger,
  performanceLogger,
  SignalLogData,
  TradeLogData,
  ScanCycleData,
} from './performance-logger.js';

export {
  AIQueryInterface,
  aiQueryInterface,
  BotPerformanceReport,
  QuickStatus,
} from './ai-query-interface.js';
