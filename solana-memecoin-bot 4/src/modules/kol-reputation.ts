// ===========================================
// KOL REPUTATION SYSTEM
// Tracks KOL performance and assigns trust tiers
// Used by Early Quality track for validation
// ===========================================

import { pool } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { KolReputation, KolReputationTier } from '../types/index.js';

// ============ CONSTANTS ============

// Tier thresholds based on win rate
const TIER_THRESHOLDS = {
  S_TIER: 50,    // 50%+ win rate
  A_TIER: 40,    // 40%+ win rate
  B_TIER: 30,    // 30%+ win rate
  MIN_PICKS: 30, // Minimum picks to be considered "proven"
};

// Top KOLs from KOLscan (seeded data)
// These are verified profitable traders from the leaderboard
const KOLSCAN_SEED_DATA: Omit<KolReputation, 'kolId' | 'lastUpdated'>[] = [
  {
    handle: 'Cented',
    tier: KolReputationTier.S_TIER,
    totalPicks: 198,
    wins: 135,
    losses: 63,
    winRate: 68.2,
    avgReturn: 124,
    profitSol: 245.46,
    lastPickAt: null,
    source: 'KOLSCAN',
  },
  {
    handle: 'clukz',
    tier: KolReputationTier.S_TIER,
    totalPicks: 17,
    wins: 13,
    losses: 4,
    winRate: 76.5,
    avgReturn: 156,
    profitSol: 103.01,
    lastPickAt: null,
    source: 'KOLSCAN',
  },
  {
    handle: 'Jijo',
    tier: KolReputationTier.S_TIER,
    totalPicks: 62,
    wins: 39,
    losses: 23,
    winRate: 62.9,
    avgReturn: 89,
    profitSol: 89.55,
    lastPickAt: null,
    source: 'KOLSCAN',
  },
  {
    handle: 'Cupsey',
    tier: KolReputationTier.S_TIER,
    totalPicks: 330,
    wins: 182,
    losses: 148,
    winRate: 55.2,
    avgReturn: 45,
    profitSol: 82.41,
    lastPickAt: null,
    source: 'KOLSCAN',
  },
  {
    handle: 'Ramset',
    tier: KolReputationTier.S_TIER,
    totalPicks: 34,
    wins: 18,
    losses: 16,
    winRate: 52.9,
    avgReturn: 67,
    profitSol: 65.92,
    lastPickAt: null,
    source: 'KOLSCAN',
  },
  {
    handle: 'Smokez',
    tier: KolReputationTier.S_TIER,
    totalPicks: 15,
    wins: 8,
    losses: 7,
    winRate: 53.3,
    avgReturn: 112,
    profitSol: 65.78,
    lastPickAt: null,
    source: 'KOLSCAN',
  },
  {
    handle: 'Insyder',
    tier: KolReputationTier.A_TIER,
    totalPicks: 37,
    wins: 14,
    losses: 23,
    winRate: 37.8,
    avgReturn: 78,
    profitSol: 49.33,
    lastPickAt: null,
    source: 'KOLSCAN',
  },
];

// ============ KOL REPUTATION MANAGER ============

export class KolReputationManager {
  private reputationCache: Map<string, KolReputation> = new Map();
  private lastCacheRefresh: Date = new Date(0);
  private readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  async initialize(): Promise<void> {
    logger.info('Initializing KOL reputation system...');

    await this.createTables();
    await this.seedKolscanData();
    await this.refreshCache();

    logger.info({
      kolCount: this.reputationCache.size,
      sTierCount: this.getKolsByTier(KolReputationTier.S_TIER).length,
      aTierCount: this.getKolsByTier(KolReputationTier.A_TIER).length,
    }, 'KOL reputation system initialized');
  }

  // ============ TIER CHECKING ============

  /**
   * Check if a KOL handle is S-tier or A-tier (trusted for Early Quality)
   */
  async isHighTierKol(handle: string): Promise<{
    isTrusted: boolean;
    tier: KolReputationTier;
    reputation: KolReputation | null;
  }> {
    await this.ensureCacheValid();

    const normalizedHandle = this.normalizeHandle(handle);
    const reputation = this.reputationCache.get(normalizedHandle);

    if (!reputation) {
      return {
        isTrusted: false,
        tier: KolReputationTier.UNPROVEN,
        reputation: null
      };
    }

    const isTrusted = reputation.tier === KolReputationTier.S_TIER ||
                      reputation.tier === KolReputationTier.A_TIER;

    return { isTrusted, tier: reputation.tier, reputation };
  }

  /**
   * Get all KOLs of a specific tier
   */
  getKolsByTier(tier: KolReputationTier): KolReputation[] {
    return Array.from(this.reputationCache.values())
      .filter(r => r.tier === tier);
  }

  /**
   * Get reputation for a specific KOL
   */
  async getReputation(handle: string): Promise<KolReputation | null> {
    await this.ensureCacheValid();
    return this.reputationCache.get(this.normalizeHandle(handle)) || null;
  }

  // ============ REPUTATION TRACKING ============

  /**
   * Record a KOL pick (token mention) and its outcome
   * Called when we track a signal tied to a KOL
   */
  async recordPick(
    handle: string,
    tokenAddress: string,
    outcome: 'WIN' | 'LOSS' | 'PENDING',
    returnPercent?: number
  ): Promise<void> {
    const normalizedHandle = this.normalizeHandle(handle);

    try {
      // Insert or update pick record
      await pool.query(`
        INSERT INTO kol_picks (
          handle, token_address, outcome, return_percent, created_at
        ) VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (handle, token_address) DO UPDATE SET
          outcome = EXCLUDED.outcome,
          return_percent = EXCLUDED.return_percent,
          updated_at = NOW()
      `, [normalizedHandle, tokenAddress, outcome, returnPercent || 0]);

      // Recalculate reputation if outcome is final
      if (outcome !== 'PENDING') {
        await this.recalculateReputation(normalizedHandle);
      }

      logger.debug({
        handle: normalizedHandle,
        tokenAddress,
        outcome,
        returnPercent,
      }, 'KOL pick recorded');
    } catch (error) {
      logger.error({ error, handle }, 'Failed to record KOL pick');
    }
  }

  /**
   * Update pending picks with final outcomes
   * Called periodically to finalize pick results
   */
  async finalizePendingPicks(
    updates: Array<{ handle: string; tokenAddress: string; outcome: 'WIN' | 'LOSS'; returnPercent: number }>
  ): Promise<void> {
    for (const update of updates) {
      await this.recordPick(update.handle, update.tokenAddress, update.outcome, update.returnPercent);
    }
  }

  // ============ REPUTATION CALCULATION ============

  /**
   * Recalculate reputation tier for a KOL based on their picks
   */
  private async recalculateReputation(handle: string): Promise<void> {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE outcome = 'WIN') as wins,
          COUNT(*) FILTER (WHERE outcome = 'LOSS') as losses,
          COUNT(*) as total_picks,
          AVG(return_percent) FILTER (WHERE outcome IN ('WIN', 'LOSS')) as avg_return
        FROM kol_picks
        WHERE handle = $1 AND outcome IN ('WIN', 'LOSS')
      `, [handle]);

      const stats = result.rows[0];
      const wins = parseInt(stats.wins) || 0;
      const losses = parseInt(stats.losses) || 0;
      const totalPicks = wins + losses;
      const avgReturn = parseFloat(stats.avg_return) || 0;

      // Calculate win rate
      const winRate = totalPicks > 0 ? (wins / totalPicks) * 100 : 0;

      // Determine tier
      let tier: KolReputationTier;
      if (totalPicks < TIER_THRESHOLDS.MIN_PICKS) {
        tier = KolReputationTier.UNPROVEN;
      } else if (winRate >= TIER_THRESHOLDS.S_TIER) {
        tier = KolReputationTier.S_TIER;
      } else if (winRate >= TIER_THRESHOLDS.A_TIER) {
        tier = KolReputationTier.A_TIER;
      } else if (winRate >= TIER_THRESHOLDS.B_TIER) {
        tier = KolReputationTier.B_TIER;
      } else {
        tier = KolReputationTier.UNPROVEN;
      }

      // Update reputation record
      await pool.query(`
        INSERT INTO kol_reputation (
          handle, tier, total_picks, wins, losses, win_rate, avg_return,
          profit_sol, source, last_updated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'TRACKED', NOW())
        ON CONFLICT (handle) DO UPDATE SET
          tier = EXCLUDED.tier,
          total_picks = EXCLUDED.total_picks,
          wins = EXCLUDED.wins,
          losses = EXCLUDED.losses,
          win_rate = EXCLUDED.win_rate,
          avg_return = EXCLUDED.avg_return,
          source = CASE WHEN kol_reputation.source = 'KOLSCAN' THEN 'KOLSCAN' ELSE 'TRACKED' END,
          last_updated = NOW()
      `, [handle, tier, totalPicks, wins, losses, winRate, avgReturn]);

      // Update cache
      const existing = this.reputationCache.get(handle);
      if (existing) {
        existing.tier = tier;
        existing.totalPicks = totalPicks;
        existing.wins = wins;
        existing.losses = losses;
        existing.winRate = winRate;
        existing.avgReturn = avgReturn;
        existing.lastUpdated = new Date();
      }

      logger.info({
        handle,
        tier,
        winRate: winRate.toFixed(1),
        totalPicks,
      }, 'KOL reputation recalculated');
    } catch (error) {
      logger.error({ error, handle }, 'Failed to recalculate KOL reputation');
    }
  }

  // ============ DATABASE SETUP ============

  private async createTables(): Promise<void> {
    try {
      // KOL reputation table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kol_reputation (
          handle VARCHAR(255) PRIMARY KEY,
          tier VARCHAR(50) NOT NULL,
          total_picks INTEGER DEFAULT 0,
          wins INTEGER DEFAULT 0,
          losses INTEGER DEFAULT 0,
          win_rate DECIMAL(5,2) DEFAULT 0,
          avg_return DECIMAL(10,2) DEFAULT 0,
          profit_sol DECIMAL(12,4) DEFAULT 0,
          source VARCHAR(50) DEFAULT 'TRACKED',
          last_pick_at TIMESTAMP,
          last_updated TIMESTAMP DEFAULT NOW()
        )
      `);

      // KOL picks tracking table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kol_picks (
          id SERIAL PRIMARY KEY,
          handle VARCHAR(255) NOT NULL,
          token_address VARCHAR(255) NOT NULL,
          outcome VARCHAR(50) DEFAULT 'PENDING',
          return_percent DECIMAL(10,2) DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(handle, token_address)
        )
      `);

      // Index for efficient lookups
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kol_picks_handle ON kol_picks(handle)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kol_reputation_tier ON kol_reputation(tier)
      `);

      logger.debug('KOL reputation tables created');
    } catch (error) {
      logger.error({ error }, 'Failed to create KOL reputation tables');
      throw error;
    }
  }

  private async seedKolscanData(): Promise<void> {
    try {
      for (const kol of KOLSCAN_SEED_DATA) {
        await pool.query(`
          INSERT INTO kol_reputation (
            handle, tier, total_picks, wins, losses, win_rate, avg_return,
            profit_sol, source, last_updated
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
          ON CONFLICT (handle) DO UPDATE SET
            profit_sol = GREATEST(kol_reputation.profit_sol, EXCLUDED.profit_sol),
            last_updated = NOW()
          WHERE kol_reputation.source = 'KOLSCAN'
        `, [
          this.normalizeHandle(kol.handle),
          kol.tier,
          kol.totalPicks,
          kol.wins,
          kol.losses,
          kol.winRate,
          kol.avgReturn,
          kol.profitSol,
          kol.source,
        ]);
      }

      logger.info({ count: KOLSCAN_SEED_DATA.length }, 'KOLscan seed data loaded');
    } catch (error) {
      logger.error({ error }, 'Failed to seed KOLscan data');
    }
  }

  // ============ CACHE MANAGEMENT ============

  private async refreshCache(): Promise<void> {
    try {
      const result = await pool.query(`
        SELECT handle, tier, total_picks, wins, losses, win_rate,
               avg_return, profit_sol, source, last_pick_at, last_updated
        FROM kol_reputation
      `);

      this.reputationCache.clear();

      for (const row of result.rows) {
        const reputation: KolReputation = {
          kolId: row.handle, // Using handle as ID for simplicity
          handle: row.handle,
          tier: row.tier as KolReputationTier,
          totalPicks: parseInt(row.total_picks) || 0,
          wins: parseInt(row.wins) || 0,
          losses: parseInt(row.losses) || 0,
          winRate: parseFloat(row.win_rate) || 0,
          avgReturn: parseFloat(row.avg_return) || 0,
          profitSol: parseFloat(row.profit_sol) || 0,
          lastPickAt: row.last_pick_at ? new Date(row.last_pick_at) : null,
          lastUpdated: new Date(row.last_updated),
          source: row.source,
        };

        this.reputationCache.set(row.handle, reputation);
      }

      this.lastCacheRefresh = new Date();
      logger.debug({ cacheSize: this.reputationCache.size }, 'KOL reputation cache refreshed');
    } catch (error) {
      logger.error({ error }, 'Failed to refresh KOL reputation cache');
    }
  }

  private async ensureCacheValid(): Promise<void> {
    const cacheAge = Date.now() - this.lastCacheRefresh.getTime();
    if (cacheAge > this.CACHE_TTL_MS) {
      await this.refreshCache();
    }
  }

  private normalizeHandle(handle: string): string {
    // Remove @ prefix if present, lowercase
    return handle.replace(/^@/, '').toLowerCase().trim();
  }

  // ============ STATS ============

  /**
   * Get summary statistics for the reputation system
   */
  async getStats(): Promise<{
    totalKols: number;
    sTierCount: number;
    aTierCount: number;
    bTierCount: number;
    unprovenCount: number;
    totalPicks: number;
    avgWinRate: number;
  }> {
    await this.ensureCacheValid();

    const kols = Array.from(this.reputationCache.values());
    const sTier = kols.filter(k => k.tier === KolReputationTier.S_TIER);
    const aTier = kols.filter(k => k.tier === KolReputationTier.A_TIER);
    const bTier = kols.filter(k => k.tier === KolReputationTier.B_TIER);
    const unproven = kols.filter(k => k.tier === KolReputationTier.UNPROVEN);

    const totalPicks = kols.reduce((sum, k) => sum + k.totalPicks, 0);
    const avgWinRate = kols.length > 0
      ? kols.reduce((sum, k) => sum + k.winRate, 0) / kols.length
      : 0;

    return {
      totalKols: kols.length,
      sTierCount: sTier.length,
      aTierCount: aTier.length,
      bTierCount: bTier.length,
      unprovenCount: unproven.length,
      totalPicks,
      avgWinRate,
    };
  }
}

// ============ SINGLETON EXPORT ============

export const kolReputationManager = new KolReputationManager();

export default {
  KolReputationManager,
  kolReputationManager,
  TIER_THRESHOLDS,
};
