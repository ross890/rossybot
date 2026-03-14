// ===========================================
// ALPHA WALLET ENGINE — WALLET GRADUATION
// Shadow-tracks candidate wallets, graduates or purges based on observed performance
// ===========================================

import { logger } from '../utils/logger.js';
import { Database } from '../utils/database.js';
import { walletEngine, EngineWallet } from './walletEngine.js';
import { WALLET_ENGINE_CONFIG } from '../config/walletEngine.js';
import { heliusClient, dexScreenerClient } from '../modules/onchain.js';
import { appConfig } from '../config/index.js';

// ============ CONSTANTS ============

const POLL_INTERVAL_MS = WALLET_ENGINE_CONFIG.CANDIDATE_POLL_INTERVAL_MINUTES * 60 * 1000;
const OBSERVATION_TRACK_MS = WALLET_ENGINE_CONFIG.OBSERVATION_TRACK_HOURS * 60 * 60 * 1000;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Track last known signature per wallet to detect new transactions
const lastKnownSignatures = new Map<string, string>();

// ============ GRADUATION CLASS ============

export class WalletGraduation {
  private pollTimer: NodeJS.Timeout | null = null;
  private observationTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private isCheckingObservations = false;

  /**
   * Start candidate monitoring and observation tracking
   */
  start(): void {
    logger.info({
      pollInterval: `${WALLET_ENGINE_CONFIG.CANDIDATE_POLL_INTERVAL_MINUTES}m`,
    }, 'WalletGraduation: Starting candidate monitoring');

    // Poll candidates for new transactions
    this.pollTimer = setInterval(() => this.pollCandidates(), POLL_INTERVAL_MS);

    // Check observation outcomes every 10 minutes
    this.observationTimer = setInterval(() => this.checkObservationOutcomes(), 10 * 60 * 1000);

    // Initial polls after short delay
    setTimeout(() => this.pollCandidates(), 60_000);
    setTimeout(() => this.checkObservationOutcomes(), 120_000);
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.observationTimer) { clearInterval(this.observationTimer); this.observationTimer = null; }
    logger.info('WalletGraduation: Stopped');
  }

  /**
   * Poll all candidate wallets for new buy transactions
   */
  private async pollCandidates(): Promise<void> {
    if (this.isPolling || appConfig.heliusDisabled) return;
    this.isPolling = true;

    try {
      const candidates = await walletEngine.getCandidates();
      const pollInterval = candidates.length > 100 ? 10 : 5; // Increase interval if >100 candidates

      logger.debug({ count: candidates.length }, 'WalletGraduation: Polling candidates');

      for (const candidate of candidates) {
        try {
          await this.pollCandidateWallet(candidate);
        } catch (error) {
          logger.debug({ error, wallet: candidate.walletAddress.slice(0, 8) }, 'WalletGraduation: Error polling candidate');
        }
      }

      // Check for graduations/purges after polling
      await this.evaluateCandidates(candidates);
    } catch (error) {
      logger.error({ error }, 'WalletGraduation: Error in poll cycle');
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Poll a single candidate wallet for new buy transactions
   */
  private async pollCandidateWallet(candidate: EngineWallet): Promise<void> {
    // Get recent transactions
    const txs = await heliusClient.getEnhancedTransactions(candidate.walletAddress, 5);
    if (txs.length === 0) return;

    const lastKnown = lastKnownSignatures.get(candidate.walletAddress);
    const newTxs = lastKnown
      ? txs.filter((tx: any) => tx.signature !== lastKnown)
      : txs.slice(0, 3); // First poll — take last 3

    if (txs.length > 0) {
      lastKnownSignatures.set(candidate.walletAddress, txs[0].signature);
    }

    for (const tx of newTxs) {
      try {
        const buyInfo = this.parseEnhancedBuy(tx, candidate.walletAddress);
        if (!buyInfo) continue;

        // Get token mcap from DexScreener
        const tokenPairs = await dexScreenerClient.getTokenPairs(buyInfo.tokenAddress);
        const topPair = tokenPairs[0];
        const mcap = topPair?.fdv || 0;

        // Record observation
        await walletEngine.recordObservation(candidate.id, {
          tokenAddress: buyInfo.tokenAddress,
          tokenName: topPair?.baseToken?.symbol || undefined,
          buyPrice: buyInfo.price,
          buyMcap: mcap,
          buyTime: new Date(tx.timestamp * 1000),
        });

        logger.debug({
          wallet: candidate.walletAddress.slice(0, 8),
          token: buyInfo.tokenAddress.slice(0, 8),
          mcap,
        }, 'WalletGraduation: New observation recorded');
      } catch (error) {
        logger.debug({ error }, 'WalletGraduation: Error processing transaction');
      }
    }
  }

  /**
   * Parse enhanced transaction for buy signal
   */
  private parseEnhancedBuy(tx: any, walletAddress: string): { tokenAddress: string; price: number; solAmount: number } | null {
    try {
      const tokenTransfers = tx.tokenTransfers || [];
      const nativeTransfers = tx.nativeTransfers || [];

      // Token coming in (not WSOL)
      const tokenIn = tokenTransfers.filter(
        (t: any) => t.toUserAccount === walletAddress && t.mint !== WSOL_MINT
      );
      if (tokenIn.length === 0) return null;

      // SOL going out
      let solOut = 0;
      for (const nt of nativeTransfers) {
        if (nt.fromUserAccount === walletAddress) solOut += (nt.amount || 0) / 1e9;
      }
      // WSOL going out
      const wsolOut = tokenTransfers.filter(
        (t: any) => t.fromUserAccount === walletAddress && t.mint === WSOL_MINT
      );
      for (const w of wsolOut) solOut += (w.tokenAmount || 0);

      if (solOut < 0.01) return null;

      const tokenAmount = tokenIn[0].tokenAmount || 0;
      if (tokenAmount <= 0) return null;

      return {
        tokenAddress: tokenIn[0].mint,
        price: solOut / tokenAmount,
        solAmount: solOut,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check pending observations for completion (48h tracking window)
   */
  private async checkObservationOutcomes(): Promise<void> {
    if (this.isCheckingObservations) return;
    this.isCheckingObservations = true;

    try {
      const pending = await walletEngine.getPendingObservations();
      const now = Date.now();

      for (const obs of pending) {
        try {
          const buyTime = new Date(obs.buy_time).getTime();
          const elapsed = now - buyTime;

          // Get current price
          const tokenPairs = await dexScreenerClient.getTokenPairs(obs.token_address);
          const currentPair = tokenPairs[0];
          const currentPrice = currentPair?.priceUsd ? parseFloat(currentPair.priceUsd) : 0;

          if (currentPrice > 0 && obs.buy_price > 0) {
            const peakPrice = Math.max(parseFloat(obs.peak_price || '0'), currentPrice);
            await walletEngine.updateObservationPeak(obs.id, peakPrice);

            // Check if 48h window expired
            if (elapsed >= OBSERVATION_TRACK_MS) {
              const returnPct = ((currentPrice - parseFloat(obs.buy_price)) / parseFloat(obs.buy_price)) * 100;
              const holdMinutes = elapsed / (60 * 1000);
              const outcome = returnPct > 0 ? 'WIN' : 'LOSS';

              await walletEngine.completeObservation(obs.id, {
                peakPrice,
                exitPrice: currentPrice,
                returnPct,
                holdTimeMinutes: holdMinutes,
                outcome: outcome as 'WIN' | 'LOSS',
              });

              // Recalculate candidate stats
              await walletEngine.recalculateCandidateStats(obs.wallet_id);

              logger.debug({
                wallet: obs.wallet_address?.slice(0, 8),
                token: obs.token_address.slice(0, 8),
                returnPct: returnPct.toFixed(1),
                outcome,
              }, 'WalletGraduation: Observation completed');
            }
          }
        } catch (error) {
          logger.debug({ error, obsId: obs.id }, 'WalletGraduation: Error checking observation');
        }
      }
    } catch (error) {
      logger.error({ error }, 'WalletGraduation: Error checking observation outcomes');
    } finally {
      this.isCheckingObservations = false;
    }
  }

  /**
   * Evaluate candidates for graduation or purging
   */
  private async evaluateCandidates(candidates: EngineWallet[]): Promise<void> {
    for (const candidate of candidates) {
      try {
        const decision = this.checkGraduation(candidate);

        switch (decision) {
          case 'GRADUATE': {
            const initialWeight = this.calculateInitialWeight(candidate);
            await walletEngine.graduateWallet(
              candidate.id,
              `Graduated: ${candidate.observedTrades} trades, ${(candidate.observedWinRate * 100).toFixed(1)}% WR, ${candidate.observedEv.toFixed(1)}% EV`,
              initialWeight,
            );
            break;
          }

          case 'PURGE':
            await walletEngine.purgeWallet(
              candidate.id,
              candidate.observedTrades < WALLET_ENGINE_CONFIG.MIN_OBSERVED_TRADES
                ? `Inactive: ${candidate.observedTrades} trades in ${WALLET_ENGINE_CONFIG.CANDIDATE_MAX_AGE_DAYS} days`
                : `Negative EV: ${candidate.observedEv.toFixed(1)}% after ${candidate.observedTrades} trades`
            );
            break;

          case 'KEEP_OBSERVING':
          default:
            break;
        }
      } catch (error) {
        logger.debug({ error, wallet: candidate.walletAddress.slice(0, 8) }, 'WalletGraduation: Error evaluating candidate');
      }
    }
  }

  /**
   * Check if candidate should graduate, keep observing, or be purged
   */
  checkGraduation(candidate: EngineWallet): 'GRADUATE' | 'KEEP_OBSERVING' | 'PURGE' {
    const cfg = WALLET_ENGINE_CONFIG;

    // Fast-track: multiple winner scan appearances
    if (candidate.winnerScanAppearances >= cfg.FAST_TRACK_WINNER_SCANS) {
      return 'GRADUATE';
    }

    // NANSEN FAST-TRACK PATH
    // Nansen-sourced candidates with proven PnL history get reduced observation requirement
    const isNansenSource = candidate.source === 'NANSEN_PNL_LEADERBOARD' || candidate.source === 'NANSEN_WINNER_SCAN';
    if (isNansenSource && candidate.fastTrackEligible) {
      if (candidate.observedTrades >= 5) { // reduced from MIN_OBSERVED_TRADES (10)
        if (candidate.observedEv > -10) { // more lenient — allow slightly negative
          // Nansen already proved this wallet. 5 observed trades is a sanity check.
          return 'GRADUATE';
        }
        if (candidate.observedTrades >= 15 && candidate.observedEv <= -10) {
          return 'PURGE'; // Nansen data was stale or wallet changed strategy
        }
      }
      return 'KEEP_OBSERVING';
    }

    // STANDARD PATH (non-Nansen candidates: on-chain scanner, co-trader, GMGN, manual)
    if (candidate.observedTrades >= cfg.MIN_OBSERVED_TRADES) {
      if (candidate.observedEv > cfg.MIN_OBSERVED_EV &&
          candidate.observedWinRate >= cfg.MIN_OBSERVED_WIN_RATE &&
          (candidate.observedAvgMcap <= cfg.MAX_OBSERVED_AVG_MCAP || candidate.observedAvgMcap === 0) &&
          (candidate.observedAvgHoldMin >= cfg.MIN_OBSERVED_AVG_HOLD_MINUTES || candidate.observedAvgHoldMin === 0)) {
        return 'GRADUATE';
      }

      // 30+ trades and still negative — purge
      if (candidate.observedTrades >= cfg.MAX_OBSERVED_TRADES_FOR_PURGE && candidate.observedEv <= 0) {
        return 'PURGE';
      }
    }

    // Check age — purge if inactive for too long
    const daysSinceAdded = (Date.now() - new Date(candidate.addedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceAdded > cfg.CANDIDATE_MAX_AGE_DAYS && candidate.observedTrades < cfg.MIN_OBSERVED_TRADES) {
      return 'PURGE';
    }

    return 'KEEP_OBSERVING';
  }

  /**
   * Calculate initial weight for a graduating wallet based on Nansen data
   * Nansen-sourced wallets get data-informed starting weights
   */
  calculateInitialWeight(candidate: EngineWallet): number {
    const isNansenSource = candidate.source === 'NANSEN_PNL_LEADERBOARD' || candidate.source === 'NANSEN_WINNER_SCAN';
    if (!isNansenSource) return 1.0; // default

    const winRate = candidate.nansenWinRate || 0;
    const pnl = candidate.nansenPnl30d || 0;

    if (winRate >= 0.40 && pnl >= 2000) {
      return 1.3; // strong Nansen track record
    }
    if (winRate >= 0.30 && pnl >= 500) {
      return 1.1; // decent Nansen track record
    }
    return 1.0;
  }
}

// Singleton export
export const walletGraduation = new WalletGraduation();

export default walletGraduation;
