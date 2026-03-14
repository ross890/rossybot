// ===========================================
// ALPHA WALLET ENGINE — CORE MODULE
// Manages the dynamic wallet list: candidates, active, suspended
// ===========================================

import { Database, pool } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { WALLET_ENGINE_CONFIG } from '../config/walletEngine.js';

// ============ TYPES ============

export interface EngineWallet {
  id: number;
  walletAddress: string;
  status: 'CANDIDATE' | 'ACTIVE' | 'PROBATION' | 'SUSPENDED' | 'PURGED';
  source: 'GMGN_LEADERBOARD' | 'ONCHAIN_WINNER_SCAN' | 'CO_TRADER' | 'MANUAL' | 'NANSEN_PNL_LEADERBOARD' | 'NANSEN_WINNER_SCAN' | 'NANSEN_SMART_ALERT';
  weight: number;
  addedAt: Date;
  graduatedAt: Date | null;
  suspendedAt: Date | null;
  probationStart: Date | null;

  // Discovery metadata
  discoveredFromToken: string | null;
  coTradeCount: number;
  winnerScanAppearances: number;

  // Observation stats
  observedTrades: number;
  observedWinRate: number;
  observedEv: number;
  observedAvgMcap: number;
  observedAvgHoldMin: number;

  // Active performance stats
  totalSignals: number;
  signalWinRate: number;
  signalEv: number;
  signalAvgWin: number;
  signalAvgLoss: number;
  signalKellyF: number;
  currentStreak: number;
  last30dEv: number;

  // Nansen data (populated for Nansen-sourced wallets)
  nansenLabel: string | null;
  nansenPnl30d: number | null;
  nansenWinRate: number | null;
  nansenTokenCount: number | null;
  nansenAvgBuySize: number | null;
  nansenLastRefreshed: Date | null;
  fastTrackEligible: boolean;

  updatedAt: Date;
}

export interface EngineObservation {
  id: number;
  walletId: number;
  tokenAddress: string;
  tokenName: string | null;
  buyPrice: number;
  buyMcap: number;
  buyTime: Date;
  peakPrice: number | null;
  exitPrice: number | null;
  returnPct: number | null;
  holdTimeMinutes: number | null;
  outcome: 'WIN' | 'LOSS' | 'PENDING';
}

// ============ CORE ENGINE CLASS ============

export class WalletEngine {
  private notifyCallback: ((message: string) => Promise<void>) | null = null;

  setNotifyCallback(callback: (message: string) => Promise<void>): void {
    this.notifyCallback = callback;
  }

  async notify(message: string): Promise<void> {
    if (this.notifyCallback) {
      try {
        await this.notifyCallback(message);
      } catch (error) {
        logger.warn({ error }, 'WalletEngine: Failed to send notification');
      }
    }
  }

  // ============ WALLET RETRIEVAL ============

  async getActiveWallets(): Promise<EngineWallet[]> {
    const rows = await Database.getActiveEngineWallets();
    return rows.map(this.mapRow);
  }

  async getCandidates(): Promise<EngineWallet[]> {
    const rows = await Database.getEngineWalletsByStatus('CANDIDATE');
    return rows.map(this.mapRow);
  }

  async getWalletByAddress(address: string): Promise<EngineWallet | null> {
    const row = await Database.getEngineWallet(address);
    return row ? this.mapRow(row) : null;
  }

  async getWalletById(id: number): Promise<EngineWallet | null> {
    const row = await Database.getEngineWalletById(id);
    return row ? this.mapRow(row) : null;
  }

  async getWalletCounts(): Promise<{ candidates: number; active: number; probation: number; suspended: number; purged: number }> {
    return Database.getEngineWalletCounts();
  }

  // ============ WALLET MANAGEMENT ============

  async addCandidate(
    walletAddress: string,
    source: string,
    discoveredFromToken?: string
  ): Promise<{ id: number; isNew: boolean }> {
    // Check cooldown
    const onCooldown = await Database.isOnCooldown(walletAddress);
    if (onCooldown) {
      logger.debug({ walletAddress }, 'WalletEngine: Wallet on cooldown, skipping');
      return { id: 0, isNew: false };
    }

    // Check max candidates
    const counts = await this.getWalletCounts();
    if (counts.candidates >= WALLET_ENGINE_CONFIG.MAX_CANDIDATES) {
      logger.debug({ count: counts.candidates }, 'WalletEngine: Max candidates reached');
      return { id: 0, isNew: false };
    }

    const result = await Database.createEngineWallet({
      walletAddress,
      source,
      discoveredFromToken,
    });

    if (result.isNew) {
      logger.info({ walletAddress: walletAddress.slice(0, 8), source }, 'WalletEngine: New candidate added');
    }

    return result;
  }

  async graduateWallet(walletId: number, reason: string, initialWeight: number = 1.0): Promise<boolean> {
    const wallet = await this.getWalletById(walletId);
    if (!wallet || wallet.status !== 'CANDIDATE') return false;

    await Database.updateEngineWalletStatus(walletId, 'ACTIVE', {
      graduated_at: new Date(),
      weight: initialWeight,
    });

    const shortAddr = `${wallet.walletAddress.slice(0, 6)}...${wallet.walletAddress.slice(-4)}`;

    logger.info({
      wallet: shortAddr,
      source: wallet.source,
      observedTrades: wallet.observedTrades,
      observedEv: wallet.observedEv,
    }, 'WalletEngine: Wallet graduated to ACTIVE');

    await this.notify(
      `*NEW ALPHA WALLET graduated:* \`${shortAddr}\`\n` +
      `Source: ${wallet.source} | Observed trades: ${wallet.observedTrades}\n` +
      `Win rate: ${(wallet.observedWinRate * 100).toFixed(1)}% | EV/trade: ${wallet.observedEv >= 0 ? '+' : ''}${wallet.observedEv.toFixed(1)}%\n` +
      `_Now generating signals for this wallet's buys._`
    );

    return true;
  }

  async purgeWallet(walletId: number, reason: string): Promise<boolean> {
    const wallet = await this.getWalletById(walletId);
    if (!wallet) return false;

    await Database.updateEngineWalletStatus(walletId, 'PURGED');
    await Database.addEngineCooldown(
      wallet.walletAddress,
      reason,
      WALLET_ENGINE_CONFIG.COOLDOWN_DAYS
    );

    const shortAddr = `${wallet.walletAddress.slice(0, 6)}...${wallet.walletAddress.slice(-4)}`;
    logger.info({ wallet: shortAddr, reason }, 'WalletEngine: Wallet purged');

    await this.notify(`Wallet purged: \`${shortAddr}\` — ${reason}`);

    return true;
  }

  async suspendWallet(walletId: number, reason: string): Promise<boolean> {
    const wallet = await this.getWalletById(walletId);
    if (!wallet || wallet.status !== 'ACTIVE') return false;

    await Database.updateEngineWalletStatus(walletId, 'PROBATION', {
      probation_start: new Date(),
      weight: WALLET_ENGINE_CONFIG.WEIGHT_MIN,
    });

    const shortAddr = `${wallet.walletAddress.slice(0, 6)}...${wallet.walletAddress.slice(-4)}`;
    logger.info({ wallet: shortAddr, reason }, 'WalletEngine: Wallet put on probation');

    await this.notify(
      `*Wallet on PROBATION:* \`${shortAddr}\`\n` +
      `Reason: ${reason}\n` +
      `Weight reduced to ${WALLET_ENGINE_CONFIG.WEIGHT_MIN}x`
    );

    return true;
  }

  async fullSuspendWallet(walletId: number, reason: string): Promise<boolean> {
    await Database.updateEngineWalletStatus(walletId, 'SUSPENDED', {
      suspended_at: new Date(),
      weight: 0,
    });

    const wallet = await this.getWalletById(walletId);
    if (wallet) {
      const shortAddr = `${wallet.walletAddress.slice(0, 6)}...${wallet.walletAddress.slice(-4)}`;
      logger.info({ wallet: shortAddr, reason }, 'WalletEngine: Wallet SUSPENDED');
      await this.notify(`*Wallet SUSPENDED:* \`${shortAddr}\` — ${reason}`);
    }

    return true;
  }

  async reinstateWallet(walletId: number): Promise<boolean> {
    const wallet = await this.getWalletById(walletId);
    if (!wallet || wallet.status !== 'SUSPENDED') return false;

    await Database.updateEngineWalletStatus(walletId, 'ACTIVE', {
      weight: 0.75,
      suspended_at: null,
      probation_start: null,
    });

    const shortAddr = `${wallet.walletAddress.slice(0, 6)}...${wallet.walletAddress.slice(-4)}`;
    logger.info({ wallet: shortAddr }, 'WalletEngine: Wallet reinstated');
    await this.notify(`*Wallet reinstated:* \`${shortAddr}\` — weight 0.75x`);

    return true;
  }

  async manualRemoveWallet(walletAddress: string): Promise<boolean> {
    const wallet = await this.getWalletByAddress(walletAddress);
    if (!wallet) return false;

    await Database.updateEngineWalletStatus(wallet.id, 'PURGED');
    await Database.addEngineCooldown(
      walletAddress,
      'Manual removal',
      WALLET_ENGINE_CONFIG.COOLDOWN_DAYS
    );

    return true;
  }

  async forcePromoteWallet(walletAddress: string): Promise<boolean> {
    const wallet = await this.getWalletByAddress(walletAddress);
    if (!wallet || wallet.status !== 'CANDIDATE') return false;

    return this.graduateWallet(wallet.id, 'Force promoted by user');
  }

  // ============ OBSERVATION TRACKING ============

  async recordObservation(walletId: number, data: {
    tokenAddress: string;
    tokenName?: string;
    buyPrice: number;
    buyMcap: number;
    buyTime: Date;
  }): Promise<number> {
    // Only track observations in the operating range
    if (data.buyMcap < WALLET_ENGINE_CONFIG.OBSERVATION_MCAP_MIN ||
        data.buyMcap > WALLET_ENGINE_CONFIG.OBSERVATION_MCAP_MAX) {
      return 0;
    }

    return Database.createEngineObservation({
      walletId,
      tokenAddress: data.tokenAddress,
      tokenName: data.tokenName,
      buyPrice: data.buyPrice,
      buyMcap: data.buyMcap,
      buyTime: data.buyTime,
    });
  }

  async getPendingObservations(): Promise<any[]> {
    return Database.getPendingObservations();
  }

  async completeObservation(observationId: number, data: {
    peakPrice: number;
    exitPrice: number;
    returnPct: number;
    holdTimeMinutes: number;
    outcome: 'WIN' | 'LOSS';
  }): Promise<void> {
    await Database.updateObservation(observationId, data);
  }

  async updateObservationPeak(observationId: number, peakPrice: number): Promise<void> {
    await Database.updateObservation(observationId, { peakPrice });
  }

  // ============ CANDIDATE STATS RECALCULATION ============

  async recalculateCandidateStats(walletId: number): Promise<void> {
    const observations = await Database.getCompletedObservationsForWallet(walletId);
    if (observations.length === 0) return;

    const wins = observations.filter((o: any) => o.outcome === 'WIN').length;
    const total = observations.length;
    const winRate = total > 0 ? wins / total : 0;
    const avgReturn = total > 0
      ? observations.reduce((sum: number, o: any) => sum + (parseFloat(o.return_pct) || 0), 0) / total
      : 0;
    const avgMcap = total > 0
      ? observations.reduce((sum: number, o: any) => sum + (parseFloat(o.buy_mcap) || 0), 0) / total
      : 0;
    const avgHold = total > 0
      ? observations.reduce((sum: number, o: any) => sum + (parseFloat(o.hold_time_minutes) || 0), 0) / total
      : 0;

    await Database.updateEngineWalletStats(walletId, {
      observed_trades: total,
      observed_win_rate: winRate,
      observed_ev: avgReturn,
      observed_avg_mcap: avgMcap,
      observed_avg_hold_min: avgHold,
    });
  }

  // ============ SIGNAL ATTRIBUTION ============

  async recordSignalResult(walletId: number, signalId: string, tokenAddress: string, realizedReturn: number, outcome: string): Promise<void> {
    await Database.recordEngineSignal({
      walletId,
      signalId,
      tokenAddress,
      realizedReturn,
      outcome,
    });
  }

  // ============ UTILS ============

  private mapRow(row: any): EngineWallet {
    return {
      id: row.id,
      walletAddress: row.wallet_address,
      status: row.status,
      source: row.source,
      weight: parseFloat(row.weight) || 1.0,
      addedAt: row.added_at,
      graduatedAt: row.graduated_at,
      suspendedAt: row.suspended_at,
      probationStart: row.probation_start,
      discoveredFromToken: row.discovered_from_token,
      coTradeCount: row.co_trade_count || 0,
      winnerScanAppearances: row.winner_scan_appearances || 0,
      observedTrades: row.observed_trades || 0,
      observedWinRate: parseFloat(row.observed_win_rate) || 0,
      observedEv: parseFloat(row.observed_ev) || 0,
      observedAvgMcap: parseFloat(row.observed_avg_mcap) || 0,
      observedAvgHoldMin: parseFloat(row.observed_avg_hold_min) || 0,
      totalSignals: row.total_signals || 0,
      signalWinRate: parseFloat(row.signal_win_rate) || 0,
      signalEv: parseFloat(row.signal_ev) || 0,
      signalAvgWin: parseFloat(row.signal_avg_win) || 0,
      signalAvgLoss: parseFloat(row.signal_avg_loss) || 0,
      signalKellyF: parseFloat(row.signal_kelly_f) || 0,
      currentStreak: row.current_streak || 0,
      last30dEv: parseFloat(row.last_30d_ev) || 0,
      // Nansen data
      nansenLabel: row.nansen_label || null,
      nansenPnl30d: row.nansen_pnl_30d ? parseFloat(row.nansen_pnl_30d) : null,
      nansenWinRate: row.nansen_win_rate ? parseFloat(row.nansen_win_rate) : null,
      nansenTokenCount: row.nansen_token_count || null,
      nansenAvgBuySize: row.nansen_avg_buy_size ? parseFloat(row.nansen_avg_buy_size) : null,
      nansenLastRefreshed: row.nansen_last_refreshed || null,
      fastTrackEligible: row.fast_track_eligible || false,
      updatedAt: row.updated_at,
    };
  }
}

// Singleton export
export const walletEngine = new WalletEngine();

export default walletEngine;
