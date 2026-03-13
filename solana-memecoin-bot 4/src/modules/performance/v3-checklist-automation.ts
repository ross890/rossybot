// ===========================================
// MODULE: V3 CHECKLIST AUTOMATION
// Automated measurement and Telegram reporting of all
// go/no-go milestones for the Rossyboy V3 overhaul.
//
// Runs on a cron schedule, evaluates every data quality
// gate, and sends structured milestone updates via Telegram.
// ===========================================

import { CronJob } from 'cron';
import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { kellySizer, KellyReport } from '../trading/kellySizer.js';

// ============ TYPES ============

export type GateStatus = 'PASS' | 'FAIL' | 'PENDING' | 'WARNING';

export interface GateResult {
  name: string;
  status: GateStatus;
  value: string;          // human-readable measured value
  threshold: string;      // human-readable target
  detail?: string;        // optional extra context
}

export interface PhaseResult {
  phase: string;
  title: string;
  status: GateStatus;     // worst gate status in this phase
  gates: GateResult[];
  summary: string;
}

export interface ChecklistReport {
  timestamp: Date;
  overallStatus: GateStatus;
  phases: PhaseResult[];
  recommendation: string;
  daysOfData: number;
  totalCompletedSignals: number;
}

// ============ CONFIGURATION ============

const CHECKLIST_CONFIG = {
  // Data accumulation thresholds
  MIN_SIGNALS_KELLY_ACTIVATE: 30,
  MIN_SIGNALS_FULL_CONFIDENCE: 100,
  MIN_DAYS_ROLLING_WINDOW: 14,

  // Data quality gate thresholds (Week 2-3 checkpoint)
  MIN_EV_PER_SIGNAL_PERCENT: 10,
  MIN_SORTINO_RATIO: 1.0,
  MIN_WIN_RATE_PERCENT: 20,
  MIN_PULLBACK_IMPROVEMENT_PERCENT: 0, // pullback >= immediate entry EV
  CIRCUIT_BREAKER_CLEAR_DAYS: 7,

  // Shadow trader tolerance
  SHADOW_TRADER_PL_TOLERANCE_PERCENT: 10,
  SHADOW_TRADER_MIN_DAYS: 14,

  // Ramp schedule thresholds
  RAMP_WEEK5_PERCENT: 10,   // 10% of quarter-Kelly
  RAMP_WEEK6_PERCENT: 25,
  RAMP_WEEK7_PERCENT: 50,
  RAMP_WEEK8_PERCENT: 100,

  // Lookback for canonical data
  CANONICAL_LOOKBACK_DAYS: 30,

  // Cron schedule: run every 6 hours at minutes 0
  CRON_SCHEDULE: '0 */6 * * *',
  TIMEZONE: 'Australia/Sydney',
} as const;

// ============ V3 CHECKLIST AUTOMATION CLASS ============

export class V3ChecklistAutomation {
  private cronJob: CronJob | null = null;
  private sendReport: ((message: string) => Promise<void>) | null = null;
  private lastReport: ChecklistReport | null = null;
  private lastReportHash: string = '';

  /**
   * Initialize with Telegram callback
   */
  initialize(sendReportCallback: (message: string) => Promise<void>): void {
    this.sendReport = sendReportCallback;
    logger.info('V3 Checklist Automation initialized');
  }

  /**
   * Start the cron schedule
   */
  start(): void {
    if (this.cronJob) {
      this.cronJob.stop();
    }

    this.cronJob = new CronJob(
      CHECKLIST_CONFIG.CRON_SCHEDULE,
      async () => {
        try {
          await this.runAndReport();
        } catch (error) {
          logger.error({ error }, 'V3 checklist cron failed');
        }
      },
      null,
      true,
      CHECKLIST_CONFIG.TIMEZONE,
    );

    logger.info({
      schedule: CHECKLIST_CONFIG.CRON_SCHEDULE,
      timezone: CHECKLIST_CONFIG.TIMEZONE,
    }, 'V3 Checklist cron started');

    // Run immediately on start
    this.runAndReport().catch(err =>
      logger.error({ err }, 'V3 checklist initial run failed'),
    );
  }

  /**
   * Stop the cron
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  /**
   * Run all checks and send Telegram report if status changed
   */
  async runAndReport(): Promise<void> {
    const report = await this.evaluate();
    this.lastReport = report;

    const message = this.formatTelegramReport(report);
    const hash = this.hashReport(report);

    // Always send on first run or if status changed
    if (hash !== this.lastReportHash) {
      this.lastReportHash = hash;
      if (this.sendReport) {
        await this.sendReport(message);
        logger.info({ overallStatus: report.overallStatus }, 'V3 checklist report sent');
      }
    } else {
      logger.debug('V3 checklist: no status change, skipping notification');
    }
  }

  /**
   * Force send a report regardless of change detection
   */
  async forceReport(): Promise<string> {
    const report = await this.evaluate();
    this.lastReport = report;

    const message = this.formatTelegramReport(report);
    if (this.sendReport) {
      await this.sendReport(message);
    }
    return message;
  }

  /**
   * Get the last evaluated report (for programmatic access)
   */
  getLastReport(): ChecklistReport | null {
    return this.lastReport;
  }

  // ============ EVALUATION ENGINE ============

  /**
   * Run all milestone checks and produce a full ChecklistReport
   */
  async evaluate(): Promise<ChecklistReport> {
    const [
      phase0,
      phase1,
      phase2,
      phase3,
      phase4,
    ] = await Promise.all([
      this.evaluatePhase0_DataAccumulation(),
      this.evaluatePhase1_KellyEdge(),
      this.evaluatePhase2_DataQualityGates(),
      this.evaluatePhase3_ShadowTrader(),
      this.evaluatePhase4_RampReadiness(),
    ]);

    const phases = [phase0, phase1, phase2, phase3, phase4];

    // Overall status: worst across all phases
    const overallStatus = this.worstStatus(phases.map(p => p.status));

    // Basic data metrics
    const dataMetrics = await this.getDataMetrics();

    // Build recommendation
    const recommendation = this.buildRecommendation(phases, dataMetrics);

    return {
      timestamp: new Date(),
      overallStatus,
      phases,
      recommendation,
      daysOfData: dataMetrics.daysOfData,
      totalCompletedSignals: dataMetrics.completedSignals,
    };
  }

  // ============ PHASE 0: DATA ACCUMULATION ============

  private async evaluatePhase0_DataAccumulation(): Promise<PhaseResult> {
    const metrics = await this.getDataMetrics();
    const gates: GateResult[] = [];

    // Gate: minimum 30 completed signals for Kelly activation
    gates.push({
      name: 'Minimum signals (Kelly activate)',
      status: metrics.completedSignals >= CHECKLIST_CONFIG.MIN_SIGNALS_KELLY_ACTIVATE ? 'PASS' : 'FAIL',
      value: `${metrics.completedSignals}`,
      threshold: `≥ ${CHECKLIST_CONFIG.MIN_SIGNALS_KELLY_ACTIVATE}`,
      detail: metrics.completedSignals < CHECKLIST_CONFIG.MIN_SIGNALS_KELLY_ACTIVATE
        ? `Need ${CHECKLIST_CONFIG.MIN_SIGNALS_KELLY_ACTIVATE - metrics.completedSignals} more`
        : undefined,
    });

    // Gate: 100 signals for full confidence
    gates.push({
      name: 'Full confidence signals',
      status: metrics.completedSignals >= CHECKLIST_CONFIG.MIN_SIGNALS_FULL_CONFIDENCE ? 'PASS'
        : metrics.completedSignals >= CHECKLIST_CONFIG.MIN_SIGNALS_KELLY_ACTIVATE ? 'WARNING' : 'FAIL',
      value: `${metrics.completedSignals}`,
      threshold: `≥ ${CHECKLIST_CONFIG.MIN_SIGNALS_FULL_CONFIDENCE}`,
    });

    // Gate: 14-day rolling window
    gates.push({
      name: '14-day rolling window',
      status: metrics.daysOfData >= CHECKLIST_CONFIG.MIN_DAYS_ROLLING_WINDOW ? 'PASS' : 'FAIL',
      value: `${metrics.daysOfData.toFixed(1)} days`,
      threshold: `≥ ${CHECKLIST_CONFIG.MIN_DAYS_ROLLING_WINDOW} days`,
      detail: metrics.daysOfData < CHECKLIST_CONFIG.MIN_DAYS_ROLLING_WINDOW
        ? `${(CHECKLIST_CONFIG.MIN_DAYS_ROLLING_WINDOW - metrics.daysOfData).toFixed(1)} days remaining`
        : undefined,
    });

    // Gate: signals per day rate
    const signalsPerDay = metrics.daysOfData > 0
      ? metrics.completedSignals / metrics.daysOfData : 0;
    gates.push({
      name: 'Signal throughput',
      status: signalsPerDay >= 10 ? 'PASS' : signalsPerDay >= 5 ? 'WARNING' : 'FAIL',
      value: `${signalsPerDay.toFixed(1)}/day`,
      threshold: '≥ 10/day target',
    });

    const phaseStatus = this.worstStatus(gates.map(g => g.status));

    return {
      phase: '0',
      title: 'Data Accumulation',
      status: phaseStatus,
      gates,
      summary: phaseStatus === 'PASS'
        ? `${metrics.completedSignals} signals over ${metrics.daysOfData.toFixed(0)} days — sufficient`
        : `Accumulating: ${metrics.completedSignals}/${CHECKLIST_CONFIG.MIN_SIGNALS_FULL_CONFIDENCE} signals, ${metrics.daysOfData.toFixed(1)}/${CHECKLIST_CONFIG.MIN_DAYS_ROLLING_WINDOW} days`,
    };
  }

  // ============ PHASE 1: KELLY EDGE ============

  private async evaluatePhase1_KellyEdge(): Promise<PhaseResult> {
    const gates: GateResult[] = [];

    let kellyReport: KellyReport;
    try {
      kellySizer.invalidateCache(); // Force fresh calculation
      kellyReport = await kellySizer.calculateKellyReport();
    } catch {
      return {
        phase: '1',
        title: 'Kelly Edge Detection',
        status: 'FAIL',
        gates: [{
          name: 'Kelly calculation',
          status: 'FAIL',
          value: 'ERROR',
          threshold: 'Compute Kelly report',
          detail: 'Failed to calculate Kelly report from DB',
        }],
        summary: 'Kelly calculation failed — check database',
      };
    }

    const overall = kellyReport.overall;

    // Gate: f* > 0 for overall
    gates.push({
      name: 'Overall Kelly edge (f* > 0)',
      status: overall.hasEdge ? 'PASS' : 'FAIL',
      value: `f* = ${(overall.fullKelly * 100).toFixed(2)}%`,
      threshold: 'f* > 0',
      detail: overall.hasEdge
        ? `Quarter-Kelly: ${overall.quarterKelly.toFixed(3)}`
        : 'No demonstrated edge — auto-trading should NOT be enabled',
    });

    // Gate: at least one signal type has edge
    const typesWithEdge = Object.entries(kellyReport.perSignalType)
      .filter(([_, params]) => params.hasEdge && params.signalCount >= 20);
    gates.push({
      name: 'Signal type with edge',
      status: typesWithEdge.length > 0 ? 'PASS' : 'FAIL',
      value: typesWithEdge.length > 0
        ? typesWithEdge.map(([t, p]) => `${t}: f*=${(p.fullKelly * 100).toFixed(1)}%`).join(', ')
        : 'None',
      threshold: '≥ 1 signal type with f* > 0 and n ≥ 20',
    });

    // Gate: confidence level
    gates.push({
      name: 'Kelly confidence level',
      status: overall.confidenceMultiplier >= 1.0 ? 'PASS'
        : overall.confidenceMultiplier >= 0.5 ? 'WARNING' : 'FAIL',
      value: `${(overall.confidenceMultiplier * 100).toFixed(0)}% (${overall.signalCount} signals)`,
      threshold: '100% (≥ 100 signals)',
    });

    const phaseStatus = this.worstStatus(gates.map(g => g.status));

    return {
      phase: '1',
      title: 'Kelly Edge Detection',
      status: phaseStatus,
      gates,
      summary: phaseStatus === 'PASS'
        ? `Edge confirmed: f*=${(overall.fullKelly * 100).toFixed(1)}%, ${typesWithEdge.length} type(s) positive`
        : overall.hasEdge
          ? `Partial edge: f*=${(overall.fullKelly * 100).toFixed(1)}% but low confidence`
          : 'No edge detected — investigate signal quality',
    };
  }

  // ============ PHASE 2: DATA QUALITY GATES ============

  private async evaluatePhase2_DataQualityGates(): Promise<PhaseResult> {
    const gates: GateResult[] = [];
    const metrics = await this.getPerformanceMetrics();

    // Gate: EV per signal > +10%
    gates.push({
      name: 'EV per signal > +10%',
      status: metrics.evPerSignal >= CHECKLIST_CONFIG.MIN_EV_PER_SIGNAL_PERCENT ? 'PASS'
        : metrics.evPerSignal >= 5 ? 'WARNING' : 'FAIL',
      value: `${metrics.evPerSignal.toFixed(1)}%`,
      threshold: `≥ ${CHECKLIST_CONFIG.MIN_EV_PER_SIGNAL_PERCENT}%`,
      detail: metrics.evPerSignal < CHECKLIST_CONFIG.MIN_EV_PER_SIGNAL_PERCENT
        ? 'Edge too thin — slippage and gas will eat into it'
        : 'Sufficient margin for real-world friction',
    });

    // Gate: Sortino > 1.0
    gates.push({
      name: 'Sortino ratio > 1.0',
      status: metrics.sortinoRatio >= CHECKLIST_CONFIG.MIN_SORTINO_RATIO ? 'PASS'
        : metrics.sortinoRatio >= 0.5 ? 'WARNING' : 'FAIL',
      value: `${metrics.sortinoRatio.toFixed(2)}`,
      threshold: `≥ ${CHECKLIST_CONFIG.MIN_SORTINO_RATIO}`,
      detail: metrics.sortinoRatio < CHECKLIST_CONFIG.MIN_SORTINO_RATIO
        ? 'Returns too volatile relative to downside risk'
        : undefined,
    });

    // Gate: Win rate > 20%
    gates.push({
      name: 'Win rate > 20%',
      status: metrics.winRatePercent >= CHECKLIST_CONFIG.MIN_WIN_RATE_PERCENT ? 'PASS'
        : metrics.winRatePercent >= 15 ? 'WARNING' : 'FAIL',
      value: `${metrics.winRatePercent.toFixed(1)}%`,
      threshold: `≥ ${CHECKLIST_CONFIG.MIN_WIN_RATE_PERCENT}%`,
      detail: metrics.winRatePercent < CHECKLIST_CONFIG.MIN_WIN_RATE_PERCENT
        ? 'Too many consecutive losses — circuit breakers will fire repeatedly'
        : undefined,
    });

    // Gate: Pullback entries vs immediate
    gates.push({
      name: 'Pullback vs immediate entry EV',
      status: metrics.pullbackEvDelta === null ? 'PENDING'
        : metrics.pullbackEvDelta >= CHECKLIST_CONFIG.MIN_PULLBACK_IMPROVEMENT_PERCENT ? 'PASS'
        : metrics.pullbackEvDelta >= -5 ? 'WARNING' : 'FAIL',
      value: metrics.pullbackEvDelta !== null
        ? `${metrics.pullbackEvDelta >= 0 ? '+' : ''}${metrics.pullbackEvDelta.toFixed(1)}% delta`
        : 'No data',
      threshold: 'Pullback EV ≥ immediate EV',
      detail: metrics.pullbackEvDelta !== null && metrics.pullbackEvDelta < 0
        ? 'Pullback waiting may be adding latency — consider disabling'
        : undefined,
    });

    // Gate: No circuit breaker events in last 7 days
    const cbStatus = await this.getCircuitBreakerStatus();
    gates.push({
      name: `No circuit breakers in ${CHECKLIST_CONFIG.CIRCUIT_BREAKER_CLEAR_DAYS}d`,
      status: cbStatus.clearDays >= CHECKLIST_CONFIG.CIRCUIT_BREAKER_CLEAR_DAYS ? 'PASS'
        : cbStatus.clearDays >= 3 ? 'WARNING' : 'FAIL',
      value: `${cbStatus.clearDays} clear days`,
      threshold: `≥ ${CHECKLIST_CONFIG.CIRCUIT_BREAKER_CLEAR_DAYS} days`,
      detail: cbStatus.lastEvent
        ? `Last event: ${cbStatus.lastEvent}`
        : 'No events recorded',
    });

    // Gate: Source-level EV — no source dragging average below 0
    const sourceGate = await this.getSourceEVStatus();
    gates.push({
      name: 'No toxic discovery sources',
      status: sourceGate.toxicSources.length === 0 ? 'PASS'
        : sourceGate.toxicSources.length <= 1 ? 'WARNING' : 'FAIL',
      value: sourceGate.toxicSources.length === 0
        ? 'All sources positive or neutral'
        : `${sourceGate.toxicSources.join(', ')} negative EV`,
      threshold: 'No source with EV < -10% and n > 20',
    });

    const phaseStatus = this.worstStatus(gates.map(g => g.status));

    return {
      phase: '2',
      title: 'Data Quality Gates (Go/No-Go)',
      status: phaseStatus,
      gates,
      summary: phaseStatus === 'PASS'
        ? `All quality gates PASS — EV ${metrics.evPerSignal.toFixed(0)}%, WR ${metrics.winRatePercent.toFixed(0)}%, Sortino ${metrics.sortinoRatio.toFixed(1)}`
        : `${gates.filter(g => g.status === 'FAIL').length} gate(s) failing`,
    };
  }

  // ============ PHASE 3: SHADOW TRADER ============

  private async evaluatePhase3_ShadowTrader(): Promise<PhaseResult> {
    const gates: GateResult[] = [];
    const shadowStatus = await this.getShadowTraderStatus();

    // Gate: shadow trader running
    gates.push({
      name: 'Shadow trader operational',
      status: shadowStatus.isRunning ? 'PASS' : 'PENDING',
      value: shadowStatus.isRunning ? `Running ${shadowStatus.daysSinceStart.toFixed(0)} days` : 'Not started',
      threshold: 'Shadow trader logging decisions',
    });

    // Gate: 14 consecutive bug-free days
    gates.push({
      name: `${CHECKLIST_CONFIG.SHADOW_TRADER_MIN_DAYS}d bug-free operation`,
      status: shadowStatus.bugFreeDays >= CHECKLIST_CONFIG.SHADOW_TRADER_MIN_DAYS ? 'PASS'
        : shadowStatus.bugFreeDays >= 7 ? 'WARNING'
        : shadowStatus.isRunning ? 'FAIL' : 'PENDING',
      value: shadowStatus.isRunning ? `${shadowStatus.bugFreeDays} days` : 'N/A',
      threshold: `≥ ${CHECKLIST_CONFIG.SHADOW_TRADER_MIN_DAYS} days`,
    });

    // Gate: P&L tracks within 10% of performance tracker
    gates.push({
      name: `P&L divergence < ${CHECKLIST_CONFIG.SHADOW_TRADER_PL_TOLERANCE_PERCENT}%`,
      status: shadowStatus.plDivergencePercent === null ? 'PENDING'
        : Math.abs(shadowStatus.plDivergencePercent) <= CHECKLIST_CONFIG.SHADOW_TRADER_PL_TOLERANCE_PERCENT ? 'PASS'
        : Math.abs(shadowStatus.plDivergencePercent) <= 20 ? 'WARNING' : 'FAIL',
      value: shadowStatus.plDivergencePercent !== null
        ? `${shadowStatus.plDivergencePercent.toFixed(1)}% divergence`
        : 'No data',
      threshold: `≤ ${CHECKLIST_CONFIG.SHADOW_TRADER_PL_TOLERANCE_PERCENT}% divergence`,
      detail: shadowStatus.plDivergencePercent !== null
        && Math.abs(shadowStatus.plDivergencePercent) > CHECKLIST_CONFIG.SHADOW_TRADER_PL_TOLERANCE_PERCENT
        ? 'Execution gap — likely slippage or timing differences'
        : undefined,
    });

    const phaseStatus = this.worstStatus(gates.map(g => g.status));

    return {
      phase: '3',
      title: 'Shadow Trader Validation',
      status: phaseStatus,
      gates,
      summary: phaseStatus === 'PASS'
        ? `Shadow trader validated: ${shadowStatus.bugFreeDays}d clean, ${shadowStatus.plDivergencePercent?.toFixed(1)}% divergence`
        : shadowStatus.isRunning
          ? `Shadow running ${shadowStatus.daysSinceStart.toFixed(0)}d — awaiting validation`
          : 'Shadow trader not yet started',
    };
  }

  // ============ PHASE 4: RAMP READINESS ============

  private async evaluatePhase4_RampReadiness(): Promise<PhaseResult> {
    const gates: GateResult[] = [];

    // Check if phases 0-2 all pass (prerequisite)
    const [phase0, phase1, phase2] = await Promise.all([
      this.evaluatePhase0_DataAccumulation(),
      this.evaluatePhase1_KellyEdge(),
      this.evaluatePhase2_DataQualityGates(),
    ]);

    const prerequisitesMet = phase0.status === 'PASS'
      && phase1.status === 'PASS'
      && phase2.status === 'PASS';

    gates.push({
      name: 'All data quality prerequisites',
      status: prerequisitesMet ? 'PASS' : 'FAIL',
      value: prerequisitesMet ? 'All phases 0-2 PASS' : 'Prerequisites not met',
      threshold: 'Phases 0, 1, 2 all PASS',
    });

    // Gate: Manual top-10 / bottom-10 review
    const manualReview = await this.getManualReviewStatus();
    gates.push({
      name: 'Manual top/bottom 10 signal review',
      status: manualReview.completed ? 'PASS' : 'PENDING',
      value: manualReview.completed ? `Reviewed ${manualReview.reviewedAt?.toISOString().slice(0, 10)}` : 'Not yet reviewed',
      threshold: 'Manual review of top-10 and bottom-10 signals',
      detail: 'Verify scoring makes sense — top signals should be quality, bottom should be garbage',
    });

    // Gate: Current ramp stage
    const rampStage = await this.getCurrentRampStage();
    gates.push({
      name: 'Ramp stage',
      status: rampStage.stage === 'FULL' ? 'PASS'
        : rampStage.stage !== 'NOT_STARTED' ? 'WARNING' : 'PENDING',
      value: rampStage.label,
      threshold: 'Full quarter-Kelly sizing',
    });

    const phaseStatus = this.worstStatus(gates.map(g => g.status));

    return {
      phase: '4',
      title: 'Go-Live Ramp Readiness',
      status: phaseStatus,
      gates,
      summary: phaseStatus === 'PASS'
        ? 'System ready for full autonomous operation'
        : prerequisitesMet
          ? `Prerequisites met — ${rampStage.label}`
          : 'Waiting on data quality gates',
    };
  }

  // ============ DATA FETCHERS ============

  private async getDataMetrics(): Promise<{
    completedSignals: number;
    pendingSignals: number;
    daysOfData: number;
    oldestSignal: Date | null;
  }> {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')) as completed,
          COUNT(*) FILTER (WHERE final_outcome IS NULL OR final_outcome = 'PENDING') as pending,
          MIN(signal_time) as oldest,
          MAX(signal_time) as newest
        FROM signal_performance
        WHERE signal_time > NOW() - INTERVAL '${CHECKLIST_CONFIG.CANONICAL_LOOKBACK_DAYS} days'
      `);

      const row = result.rows[0];
      const completed = parseInt(row.completed) || 0;
      const oldest = row.oldest ? new Date(row.oldest) : null;
      const newest = row.newest ? new Date(row.newest) : null;

      const daysOfData = oldest && newest
        ? (newest.getTime() - oldest.getTime()) / (1000 * 60 * 60 * 24)
        : 0;

      return {
        completedSignals: completed,
        pendingSignals: parseInt(row.pending) || 0,
        daysOfData,
        oldestSignal: oldest,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to fetch data metrics');
      return { completedSignals: 0, pendingSignals: 0, daysOfData: 0, oldestSignal: null };
    }
  }

  private async getPerformanceMetrics(): Promise<{
    evPerSignal: number;
    sortinoRatio: number;
    winRatePercent: number;
    avgWinReturn: number;
    avgLossReturn: number;
    pullbackEvDelta: number | null;
  }> {
    try {
      // EV, win rate, and return stats
      const result = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')) as total,
          COUNT(*) FILTER (WHERE final_outcome IN ('WIN', 'EXPIRED_PROFIT')) as wins,
          COUNT(*) FILTER (WHERE final_outcome = 'LOSS') as losses,
          AVG(CASE WHEN final_outcome IN ('WIN', 'EXPIRED_PROFIT')
              THEN COALESCE(realized_return, final_return) END) as avg_win,
          AVG(CASE WHEN final_outcome = 'LOSS'
              THEN COALESCE(realized_return, final_return) END) as avg_loss,
          AVG(COALESCE(realized_return, final_return)) as avg_return,
          STDDEV(CASE WHEN COALESCE(realized_return, final_return) < 0
              THEN COALESCE(realized_return, final_return) END) as downside_stddev
        FROM signal_performance
        WHERE signal_time > NOW() - INTERVAL '${CHECKLIST_CONFIG.CANONICAL_LOOKBACK_DAYS} days'
          AND final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')
      `);

      const row = result.rows[0];
      const total = parseInt(row.total) || 0;
      const wins = parseInt(row.wins) || 0;
      const avgReturn = parseFloat(row.avg_return) || 0;
      const avgWinReturn = parseFloat(row.avg_win) || 0;
      const avgLossReturn = parseFloat(row.avg_loss) || 0;
      const downsideStddev = parseFloat(row.downside_stddev) || 1;

      const winRate = total > 0 ? (wins / total) * 100 : 0;

      // EV = avgReturn (already the expected value per signal)
      const evPerSignal = avgReturn;

      // Sortino = mean excess return / downside deviation
      // Using 0% as risk-free rate for memecoin trading
      const sortinoRatio = downsideStddev > 0 ? avgReturn / downsideStddev : 0;

      // Pullback vs immediate entry comparison
      let pullbackEvDelta: number | null = null;
      try {
        const pullbackResult = await pool.query(`
          SELECT
            AVG(CASE WHEN entry_type = 'PULLBACK' THEN COALESCE(realized_return, final_return) END) as pullback_ev,
            AVG(CASE WHEN entry_type = 'IMMEDIATE' OR entry_type IS NULL THEN COALESCE(realized_return, final_return) END) as immediate_ev,
            COUNT(*) FILTER (WHERE entry_type = 'PULLBACK') as pullback_count
          FROM signal_performance
          WHERE signal_time > NOW() - INTERVAL '${CHECKLIST_CONFIG.CANONICAL_LOOKBACK_DAYS} days'
            AND final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')
        `);

        const pbRow = pullbackResult.rows[0];
        const pullbackCount = parseInt(pbRow.pullback_count) || 0;

        if (pullbackCount >= 10) {
          const pullbackEv = parseFloat(pbRow.pullback_ev) || 0;
          const immediateEv = parseFloat(pbRow.immediate_ev) || 0;
          pullbackEvDelta = pullbackEv - immediateEv;
        }
      } catch {
        // entry_type column may not exist yet — that's OK
        pullbackEvDelta = null;
      }

      return {
        evPerSignal,
        sortinoRatio,
        winRatePercent: winRate,
        avgWinReturn,
        avgLossReturn,
        pullbackEvDelta,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to fetch performance metrics');
      return {
        evPerSignal: 0,
        sortinoRatio: 0,
        winRatePercent: 0,
        avgWinReturn: 0,
        avgLossReturn: 0,
        pullbackEvDelta: null,
      };
    }
  }

  private async getCircuitBreakerStatus(): Promise<{
    clearDays: number;
    lastEvent: string | null;
  }> {
    try {
      // Check portfolio_events table for circuit breaker events
      const result = await pool.query(`
        SELECT event_type, created_at, detail
        FROM portfolio_events
        WHERE event_type LIKE '%HALT%' OR event_type LIKE '%BREAKER%'
        ORDER BY created_at DESC
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return { clearDays: 999, lastEvent: null };
      }

      const lastEventTime = new Date(result.rows[0].created_at);
      const clearDays = (Date.now() - lastEventTime.getTime()) / (1000 * 60 * 60 * 24);

      return {
        clearDays: Math.floor(clearDays),
        lastEvent: `${result.rows[0].event_type} at ${lastEventTime.toISOString().slice(0, 10)}`,
      };
    } catch {
      // Table may not exist — assume clear
      return { clearDays: 999, lastEvent: null };
    }
  }

  private async getSourceEVStatus(): Promise<{
    toxicSources: string[];
    sourceBreakdown: Array<{ source: string; ev: number; count: number }>;
  }> {
    try {
      const result = await pool.query(`
        SELECT
          COALESCE(discovery_source, signal_type, 'UNKNOWN') as source,
          COUNT(*) as count,
          AVG(COALESCE(realized_return, final_return)) as avg_ev
        FROM signal_performance
        WHERE signal_time > NOW() - INTERVAL '14 days'
          AND final_outcome IN ('WIN', 'LOSS', 'EXPIRED_PROFIT')
        GROUP BY COALESCE(discovery_source, signal_type, 'UNKNOWN')
        HAVING COUNT(*) >= 10
        ORDER BY avg_ev ASC
      `);

      const breakdown = result.rows.map((row: { source: string; avg_ev: string; count: string }) => ({
        source: row.source,
        ev: parseFloat(row.avg_ev) || 0,
        count: parseInt(row.count) || 0,
      }));

      const toxicSources = breakdown
        .filter((s: { ev: number; count: number }) => s.ev < -10 && s.count >= 20)
        .map((s: { source: string }) => s.source);

      return { toxicSources, sourceBreakdown: breakdown };
    } catch {
      return { toxicSources: [], sourceBreakdown: [] };
    }
  }

  private async getShadowTraderStatus(): Promise<{
    isRunning: boolean;
    daysSinceStart: number;
    bugFreeDays: number;
    plDivergencePercent: number | null;
  }> {
    try {
      // Check for shadow_trades table existence and data
      const result = await pool.query(`
        SELECT
          MIN(created_at) as first_trade,
          MAX(created_at) as last_trade,
          COUNT(*) as total_trades,
          COUNT(*) FILTER (WHERE error IS NOT NULL) as error_count,
          MAX(CASE WHEN error IS NOT NULL THEN created_at END) as last_error
        FROM shadow_trades
      `);

      const row = result.rows[0];
      const totalTrades = parseInt(row.total_trades) || 0;

      if (totalTrades === 0) {
        return { isRunning: false, daysSinceStart: 0, bugFreeDays: 0, plDivergencePercent: null };
      }

      const firstTrade = new Date(row.first_trade);
      const lastTrade = new Date(row.last_trade);
      const lastError = row.last_error ? new Date(row.last_error) : null;

      const daysSinceStart = (Date.now() - firstTrade.getTime()) / (1000 * 60 * 60 * 24);
      const isRunning = (Date.now() - lastTrade.getTime()) < 24 * 60 * 60 * 1000; // Active in last 24h

      // Bug-free days = days since last error, or total days if no errors
      const bugFreeDays = lastError
        ? (Date.now() - lastError.getTime()) / (1000 * 60 * 60 * 24)
        : daysSinceStart;

      // P&L divergence: compare shadow EV vs tracker EV
      let plDivergencePercent: number | null = null;
      try {
        const plResult = await pool.query(`
          SELECT
            AVG(shadow_return) as shadow_avg,
            AVG(tracker_return) as tracker_avg
          FROM shadow_trades
          WHERE created_at > NOW() - INTERVAL '14 days'
            AND shadow_return IS NOT NULL
            AND tracker_return IS NOT NULL
        `);

        if (plResult.rows[0]?.shadow_avg && plResult.rows[0]?.tracker_avg) {
          const shadowEv = parseFloat(plResult.rows[0].shadow_avg);
          const trackerEv = parseFloat(plResult.rows[0].tracker_avg);
          plDivergencePercent = shadowEv - trackerEv;
        }
      } catch {
        // columns may not exist
      }

      return { isRunning, daysSinceStart, bugFreeDays: Math.floor(bugFreeDays), plDivergencePercent };
    } catch {
      // shadow_trades table doesn't exist yet — that's expected
      return { isRunning: false, daysSinceStart: 0, bugFreeDays: 0, plDivergencePercent: null };
    }
  }

  private async getManualReviewStatus(): Promise<{
    completed: boolean;
    reviewedAt: Date | null;
  }> {
    try {
      const result = await pool.query(`
        SELECT reviewed_at FROM v3_manual_reviews
        WHERE review_type = 'TOP_BOTTOM_10'
        ORDER BY reviewed_at DESC LIMIT 1
      `);

      if (result.rows.length > 0) {
        return { completed: true, reviewedAt: new Date(result.rows[0].reviewed_at) };
      }
      return { completed: false, reviewedAt: null };
    } catch {
      // Table doesn't exist yet — that's fine
      return { completed: false, reviewedAt: null };
    }
  }

  private async getCurrentRampStage(): Promise<{
    stage: 'NOT_STARTED' | 'WEEK5_10PCT' | 'WEEK6_25PCT' | 'WEEK7_50PCT' | 'FULL';
    label: string;
    sizingPercent: number;
  }> {
    try {
      const result = await pool.query(`
        SELECT ramp_stage, started_at FROM v3_ramp_status
        ORDER BY started_at DESC LIMIT 1
      `);

      if (result.rows.length === 0) {
        return { stage: 'NOT_STARTED', label: 'Not started', sizingPercent: 0 };
      }

      const stage = result.rows[0].ramp_stage;
      const labels: Record<string, { label: string; pct: number }> = {
        'WEEK5_10PCT': { label: 'Week 5: 10% quarter-Kelly', pct: 10 },
        'WEEK6_25PCT': { label: 'Week 6: 25% quarter-Kelly', pct: 25 },
        'WEEK7_50PCT': { label: 'Week 7: 50% quarter-Kelly', pct: 50 },
        'FULL': { label: 'Full quarter-Kelly', pct: 100 },
      };

      const info = labels[stage] || { label: stage, pct: 0 };
      return { stage, label: info.label, sizingPercent: info.pct };
    } catch {
      return { stage: 'NOT_STARTED', label: 'Not started', sizingPercent: 0 };
    }
  }

  // ============ FORMATTERS ============

  private formatTelegramReport(report: ChecklistReport): string {
    const statusEmoji: Record<GateStatus, string> = {
      PASS: '✅',
      FAIL: '❌',
      PENDING: '⏳',
      WARNING: '⚠️',
    };

    const lines: string[] = [];

    // Header
    lines.push(`📋 *V3 CHECKLIST — ${statusEmoji[report.overallStatus]} ${report.overallStatus}*`);
    lines.push(`${report.daysOfData.toFixed(0)}d data | ${report.totalCompletedSignals} signals | ${report.timestamp.toISOString().slice(0, 16)}Z`);
    lines.push('');

    // Each phase
    for (const phase of report.phases) {
      lines.push(`*Phase ${phase.phase}: ${phase.title}* ${statusEmoji[phase.status]}`);

      for (const gate of phase.gates) {
        const icon = statusEmoji[gate.status];
        lines.push(`  ${icon} ${gate.name}`);
        lines.push(`     ${gate.value} (need: ${gate.threshold})`);
        if (gate.detail && gate.status !== 'PASS') {
          lines.push(`     _${gate.detail}_`);
        }
      }

      lines.push(`  └ ${phase.summary}`);
      lines.push('');
    }

    // Recommendation
    lines.push('*RECOMMENDATION:*');
    lines.push(report.recommendation);

    return lines.join('\n');
  }

  private buildRecommendation(phases: PhaseResult[], dataMetrics: { daysOfData: number; completedSignals: number }): string {
    const failingPhases = phases.filter(p => p.status === 'FAIL');
    const pendingPhases = phases.filter(p => p.status === 'PENDING');

    if (failingPhases.length === 0 && pendingPhases.length === 0) {
      return '🟢 All gates PASS — system is clear for go-live ramp.';
    }

    if (failingPhases.some(p => p.phase === '0')) {
      const remaining = CHECKLIST_CONFIG.MIN_SIGNALS_FULL_CONFIDENCE - dataMetrics.completedSignals;
      const daysRemaining = CHECKLIST_CONFIG.MIN_DAYS_ROLLING_WINDOW - dataMetrics.daysOfData;
      return `🔴 Still accumulating data. Need ~${Math.max(remaining, 0)} more signals and ${Math.max(daysRemaining, 0).toFixed(0)} more days. Continue running pipeline.`;
    }

    if (failingPhases.some(p => p.phase === '1')) {
      return '🔴 Kelly says NO EDGE. Do not enable auto-trading. Investigate: are stops too wide? Is a source dragging EV negative? Check source-level breakdown.';
    }

    if (failingPhases.some(p => p.phase === '2')) {
      const failedGates = phases.find(p => p.phase === '2')!.gates.filter(g => g.status === 'FAIL');
      return `🟡 Data quality gates failing: ${failedGates.map(g => g.name).join(', ')}. Fix before proceeding to shadow trader validation.`;
    }

    if (failingPhases.some(p => p.phase === '3') || pendingPhases.some(p => p.phase === '3')) {
      return '🟡 Shadow trader needs more runtime or has P&L divergence. Continue shadow mode — do not trade real money yet.';
    }

    return '🟡 Close to ready — check remaining pending/warning items.';
  }

  // ============ UTILITIES ============

  private worstStatus(statuses: GateStatus[]): GateStatus {
    if (statuses.includes('FAIL')) return 'FAIL';
    if (statuses.includes('PENDING')) return 'PENDING';
    if (statuses.includes('WARNING')) return 'WARNING';
    return 'PASS';
  }

  private hashReport(report: ChecklistReport): string {
    // Hash based on phase statuses + gate statuses to detect changes
    return report.phases
      .map(p => `${p.phase}:${p.status}:${p.gates.map(g => g.status).join('')}`)
      .join('|');
  }
}

// ============ SINGLETON EXPORT ============

export const v3ChecklistAutomation = new V3ChecklistAutomation();
export default v3ChecklistAutomation;
