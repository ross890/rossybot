// ===========================================
// MODULE: PERFORMANCE TRACKING INDEX
// Stripped: ai-query-interface and deployment-logs-reader REMOVED (unused bloat)
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
  PerformanceLogger,
  performanceLogger,
  SignalLogData,
  TradeLogData,
  ScanCycleData,
} from './performance-logger.js';

export {
  V3ChecklistAutomation,
  v3ChecklistAutomation,
} from './v3-checklist-automation.js';
