// ===========================================
// MODULE: BONDING CURVE VELOCITY TRACKER
// Measures the RATE of bonding curve progress to identify
// tokens accelerating towards migration vs. stalling out.
// ===========================================

import { logger } from '../../utils/logger.js';
import { bondingCurveMonitor } from '../pumpfun/bonding-monitor.js';

// ============ TYPES ============

export interface BondingVelocity {
  tokenAddress: string;
  currentProgress: number;           // Current bonding curve %
  velocityPerMinute: number;         // % progress per minute
  accelerating: boolean;             // Is velocity increasing?
  timeToMigrationMinutes: number | null;  // Estimated time to 100%
  dataPoints: number;                // How many snapshots we have
  score: number;                     // 0-100 velocity quality score
  tier: 'ROCKET' | 'FAST' | 'STEADY' | 'STALLING' | 'UNKNOWN';
}

interface ProgressSnapshot {
  progress: number;
  timestamp: number;
}

// ============ CONSTANTS ============

// Minimum bonding progress to care about (below this = too early, 90% die)
const MIN_PROGRESS_THRESHOLD = 20;

// Snapshot interval (how often we record progress)
const SNAPSHOT_INTERVAL_MS = 60 * 1000; // 1 minute

// Max snapshots to keep per token
const MAX_SNAPSHOTS = 30; // 30 minutes of history

// Velocity tiers (% per minute)
const VELOCITY_TIERS = {
  ROCKET: 3.0,    // 3%+ per minute = rocket, will migrate in ~30min
  FAST: 1.0,      // 1-3% per minute = strong momentum
  STEADY: 0.3,    // 0.3-1% per minute = healthy but slow
  STALLING: 0,    // Below 0.3% = losing momentum
};

// ============ BONDING VELOCITY CLASS ============

class BondingVelocityTracker {
  // Token → array of progress snapshots
  private snapshots: Map<string, ProgressSnapshot[]> = new Map();
  private lastSnapshotTime: Map<string, number> = new Map();

  /**
   * Record a progress snapshot for a token.
   * Call this periodically (every scan cycle) for tracked pump.fun tokens.
   */
  async recordProgress(tokenAddress: string): Promise<void> {
    // Rate limit snapshots
    const lastTime = this.lastSnapshotTime.get(tokenAddress) || 0;
    if (Date.now() - lastTime < SNAPSHOT_INTERVAL_MS) return;

    try {
      const status = await bondingCurveMonitor.getBondingCurveStatus(tokenAddress);
      if (!status || status.isMigrated) return;

      const existing = this.snapshots.get(tokenAddress) || [];
      existing.push({
        progress: status.bondingProgress,
        timestamp: Date.now(),
      });

      // Keep only recent snapshots
      if (existing.length > MAX_SNAPSHOTS) {
        existing.splice(0, existing.length - MAX_SNAPSHOTS);
      }

      this.snapshots.set(tokenAddress, existing);
      this.lastSnapshotTime.set(tokenAddress, Date.now());
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Failed to record bonding progress');
    }
  }

  /**
   * Get velocity analysis for a token.
   */
  async getVelocity(tokenAddress: string): Promise<BondingVelocity> {
    // Try to get fresh data first
    await this.recordProgress(tokenAddress);

    const points = this.snapshots.get(tokenAddress);

    if (!points || points.length < 2) {
      // Only one data point - try to get current status for a basic result
      try {
        const status = await bondingCurveMonitor.getBondingCurveStatus(tokenAddress);
        return {
          tokenAddress,
          currentProgress: status?.bondingProgress || 0,
          velocityPerMinute: 0,
          accelerating: false,
          timeToMigrationMinutes: null,
          dataPoints: points?.length || 0,
          score: 0,
          tier: 'UNKNOWN',
        };
      } catch {
        return this.emptyResult(tokenAddress);
      }
    }

    const latest = points[points.length - 1];
    const oldest = points[0];

    // Calculate overall velocity
    const totalTimeMinutes = (latest.timestamp - oldest.timestamp) / 60_000;
    const totalProgress = latest.progress - oldest.progress;
    const velocity = totalTimeMinutes > 0 ? totalProgress / totalTimeMinutes : 0;

    // Calculate acceleration (compare recent velocity to older velocity)
    let accelerating = false;
    if (points.length >= 4) {
      const midpoint = Math.floor(points.length / 2);
      const firstHalfTime = (points[midpoint].timestamp - points[0].timestamp) / 60_000;
      const firstHalfProgress = points[midpoint].progress - points[0].progress;
      const firstHalfVelocity = firstHalfTime > 0 ? firstHalfProgress / firstHalfTime : 0;

      const secondHalfTime = (latest.timestamp - points[midpoint].timestamp) / 60_000;
      const secondHalfProgress = latest.progress - points[midpoint].progress;
      const secondHalfVelocity = secondHalfTime > 0 ? secondHalfProgress / secondHalfTime : 0;

      accelerating = secondHalfVelocity > firstHalfVelocity * 1.1; // 10% faster = accelerating
    }

    // Estimate time to migration
    const remaining = 100 - latest.progress;
    const timeToMigration = velocity > 0.01 ? remaining / velocity : null;

    // Determine tier
    const tier = velocity >= VELOCITY_TIERS.ROCKET ? 'ROCKET' as const :
                 velocity >= VELOCITY_TIERS.FAST ? 'FAST' as const :
                 velocity >= VELOCITY_TIERS.STEADY ? 'STEADY' as const : 'STALLING' as const;

    // Score based on velocity + acceleration + progress level
    const score = this.calculateScore(velocity, accelerating, latest.progress, points.length);

    return {
      tokenAddress,
      currentProgress: latest.progress,
      velocityPerMinute: Math.round(velocity * 100) / 100,
      accelerating,
      timeToMigrationMinutes: timeToMigration ? Math.round(timeToMigration) : null,
      dataPoints: points.length,
      score,
      tier,
    };
  }

  private calculateScore(
    velocity: number,
    accelerating: boolean,
    progress: number,
    dataPoints: number
  ): number {
    let score = 0;

    // Velocity component (0-50)
    if (velocity >= VELOCITY_TIERS.ROCKET) score += 50;
    else if (velocity >= VELOCITY_TIERS.FAST) score += 35;
    else if (velocity >= VELOCITY_TIERS.STEADY) score += 20;
    else score += 5;

    // Acceleration bonus (0-15)
    if (accelerating) score += 15;

    // Progress level bonus (higher progress + velocity = more likely to migrate)
    if (progress >= 50 && velocity >= VELOCITY_TIERS.STEADY) score += 20;
    else if (progress >= 30) score += 10;
    else if (progress >= MIN_PROGRESS_THRESHOLD) score += 5;

    // Data confidence (more snapshots = more reliable)
    if (dataPoints >= 10) score += 10;
    else if (dataPoints >= 5) score += 5;

    return Math.min(100, score);
  }

  /**
   * Check if a token is a pump.fun token and has interesting velocity.
   * Quick check for the signal pipeline.
   */
  async hasInterestingVelocity(tokenAddress: string): Promise<boolean> {
    const velocity = await this.getVelocity(tokenAddress);
    return velocity.currentProgress >= MIN_PROGRESS_THRESHOLD &&
           velocity.tier !== 'STALLING' &&
           velocity.tier !== 'UNKNOWN';
  }

  /**
   * Cleanup old tracking data for tokens no longer being monitored.
   */
  cleanup(): void {
    const cutoff = Date.now() - MAX_SNAPSHOTS * SNAPSHOT_INTERVAL_MS * 2;
    for (const [token, points] of this.snapshots) {
      if (points.length === 0 || points[points.length - 1].timestamp < cutoff) {
        this.snapshots.delete(token);
        this.lastSnapshotTime.delete(token);
      }
    }
  }

  private emptyResult(tokenAddress: string): BondingVelocity {
    return {
      tokenAddress,
      currentProgress: 0,
      velocityPerMinute: 0,
      accelerating: false,
      timeToMigrationMinutes: null,
      dataPoints: 0,
      score: 0,
      tier: 'UNKNOWN',
    };
  }
}

export const bondingVelocityTracker = new BondingVelocityTracker();
