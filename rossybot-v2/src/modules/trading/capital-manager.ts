import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { config, getTierForCapital, getTierConfig, SEED_WALLETS } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { query } from '../../db/database.js';
import { CapitalTier, WalletTrustTier, type TierConfig } from '../../types/index.js';

export class CapitalManager {
  private connection: Connection;
  private walletPubkey: PublicKey;
  private currentCapitalSol = 0;
  private currentTier: CapitalTier = CapitalTier.MICRO;
  private dailyStartingCapital = 0;
  private dailyLossSol = 0;

  constructor(walletPublicKey: string) {
    this.connection = new Connection(config.helius.rpcUrl);
    this.walletPubkey = new PublicKey(walletPublicKey);
  }

  get capital(): number {
    return this.currentCapitalSol;
  }

  get tier(): CapitalTier {
    return this.currentTier;
  }

  get tierConfig(): TierConfig {
    return getTierConfig(this.currentTier);
  }

  get dailyLossLimitReached(): boolean {
    return this.dailyLossSol >= this.dailyStartingCapital * config.dailyLossLimitPct;
  }

  async initialize(): Promise<void> {
    await this.refreshBalance();
    this.dailyStartingCapital = this.currentCapitalSol;
    logger.info({
      capital: this.currentCapitalSol,
      tier: this.currentTier,
    }, 'Capital manager initialized');
  }

  async refreshBalance(): Promise<void> {
    try {
      const balance = await this.connection.getBalance(this.walletPubkey);
      const newCapital = balance / LAMPORTS_PER_SOL;
      const newTier = getTierForCapital(newCapital);

      if (newTier !== this.currentTier) {
        await this.logTierChange(this.currentTier, newTier, newCapital);
        logger.info({
          oldTier: this.currentTier,
          newTier,
          capital: newCapital,
        }, 'Capital tier changed');
      }

      this.currentCapitalSol = newCapital;
      this.currentTier = newTier;
    } catch (err) {
      logger.error({ err }, 'Failed to refresh balance');
    }
  }

  getPositionSize(): number {
    const cfg = this.tierConfig;
    const raw = this.currentCapitalSol * cfg.positionSizePct;
    return Math.max(raw, cfg.minPositionSol);
  }

  /** Max total exposure as % of capital (standard + pump.fun combined) */
  private static readonly MAX_TOTAL_EXPOSURE_PCT = 0.80; // 80% — leave 20% for fees, slippage, safety

  canOpenPosition(currentOpenPositions: number, currentExposureSol = 0): boolean {
    if (this.dailyLossLimitReached) return false;
    if (currentOpenPositions >= this.tierConfig.maxPositions) return false;
    const posSize = this.getPositionSize();
    if (posSize < this.tierConfig.minPositionSol) return false;
    // Hard exposure cap: don't open if total deployed would exceed 80% of capital
    if (this.currentCapitalSol > 0) {
      const projectedExposure = (currentExposureSol + posSize) / this.currentCapitalSol;
      if (projectedExposure > CapitalManager.MAX_TOTAL_EXPOSURE_PCT) {
        logger.info({
          currentExposure: (currentExposureSol / this.currentCapitalSol * 100).toFixed(0) + '%',
          projectedExposure: (projectedExposure * 100).toFixed(0) + '%',
          cap: (CapitalManager.MAX_TOTAL_EXPOSURE_PCT * 100).toFixed(0) + '%',
        }, 'Position blocked — exposure cap reached');
        return false;
      }
    }
    return true;
  }

  recordLoss(lossSol: number): void {
    this.dailyLossSol += Math.abs(lossSol);
  }

  resetDaily(): void {
    this.dailyStartingCapital = this.currentCapitalSol;
    this.dailyLossSol = 0;
  }

  getWalletsForTier(): typeof SEED_WALLETS {
    return SEED_WALLETS.filter((w) => {
      const tierOrder = [CapitalTier.MICRO, CapitalTier.SMALL, CapitalTier.MEDIUM, CapitalTier.FULL];
      return tierOrder.indexOf(w.minTier) <= tierOrder.indexOf(this.currentTier);
    });
  }

  /** Get position size adjusted for wallet trust tier.
   *  UNPROVEN = 0 (shadow only), PROBATIONARY = 30%, PROVEN = 100% */
  getPositionSizeForTrustTier(trustTier: WalletTrustTier): number {
    const base = this.getPositionSize();
    const multiplier = trustTier === WalletTrustTier.PROVEN
      ? config.walletTrust.provenSizeMultiplier
      : trustTier === WalletTrustTier.PROBATIONARY
        ? config.walletTrust.probationarySizeMultiplier
        : config.walletTrust.unprovenSizeMultiplier;

    if (multiplier === 0) return 0; // Shadow only
    return Math.max(base * multiplier, this.tierConfig.minPositionSol);
  }

  /** Calculate position size with confluence multipliers (MEDIUM+ only) */
  getPositionSizeWithConfluence(multipliers: number[]): number {
    if (this.currentTier === CapitalTier.MICRO || this.currentTier === CapitalTier.SMALL) {
      return this.getPositionSize();
    }

    const baseSol = this.currentCapitalSol * this.tierConfig.positionSizePct;
    const totalMultiplier = Math.min(
      multipliers.reduce((acc, m) => acc * m, 1),
      3.0, // Cap at 3x
    );
    const sized = baseSol * totalMultiplier;
    const maxAllowed = this.currentCapitalSol * 0.25; // Never >25%
    return Math.max(Math.min(sized, maxAllowed), this.tierConfig.minPositionSol);
  }

  private async logTierChange(oldTier: CapitalTier, newTier: CapitalTier, capital: number): Promise<void> {
    try {
      await query(
        `INSERT INTO capital_tier_changes (old_tier, new_tier, capital_at_change) VALUES ($1, $2, $3)`,
        [oldTier, newTier, capital],
      );
    } catch (err) {
      logger.error({ err }, 'Failed to log tier change');
    }
  }

  getStatus() {
    return {
      capitalSol: this.currentCapitalSol,
      tier: this.currentTier,
      dailyStarting: this.dailyStartingCapital,
      dailyLoss: this.dailyLossSol,
      dailyLossLimit: this.dailyStartingCapital * config.dailyLossLimitPct,
      dailyLimitReached: this.dailyLossLimitReached,
      positionSize: this.getPositionSize(),
      maxPositions: this.tierConfig.maxPositions,
      walletsMonitored: this.tierConfig.walletsMonitored,
    };
  }
}
