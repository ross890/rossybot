import { logger } from '../../utils/logger.js';
import { query, getMany, getOne } from '../../db/database.js';
import { CapitalTier, SignalType, ValidationResult, SignalAction, DetectionSource, type ParsedSignal, type TierConfig } from '../../types/index.js';
import { validateToken } from '../validation/gate.js';

interface PendingBuy {
  tokenMint: string;
  wallets: Map<string, { signal: ParsedSignal; detectedAt: number }>;
  firstDetectedAt: number;
}

export class EntryEngine {
  private pendingBuys: Map<string, PendingBuy> = new Map();
  private processedTokens: Set<string> = new Set(); // Dedup: don't re-enter same token
  private onSignalValid: ((signal: ValidatedSignal) => Promise<void>) | null = null;

  constructor() {
    // Clean up expired pending buys every 60 seconds
    setInterval(() => this.cleanupExpired(), 60_000);
  }

  setSignalCallback(cb: (signal: ValidatedSignal) => Promise<void>): void {
    this.onSignalValid = cb;
  }

  /**
   * Process a new buy signal detected from Helius.
   * Accumulates wallet confluence and fires when criteria met.
   */
  async processBuySignal(signal: ParsedSignal, tierCfg: TierConfig): Promise<void> {
    if (signal.type !== SignalType.BUY) return;

    const mint = signal.tokenMint;

    // Dedup: skip tokens we've already entered
    if (this.processedTokens.has(mint)) return;

    // Get or create pending buy tracker
    let pending = this.pendingBuys.get(mint);
    if (!pending) {
      pending = {
        tokenMint: mint,
        wallets: new Map(),
        firstDetectedAt: Date.now(),
      };
      this.pendingBuys.set(mint, pending);
    }

    // Add this wallet's signal
    pending.wallets.set(signal.walletAddress, {
      signal,
      detectedAt: Date.now(),
    });

    logger.info({
      token: mint.slice(0, 8),
      wallet: signal.walletAddress.slice(0, 8),
      walletCount: pending.wallets.size,
      required: tierCfg.walletConfluenceRequired,
    }, 'Buy signal accumulated');

    // Check confluence requirement
    const confluenceOk = this.checkConfluence(pending, tierCfg);
    if (!confluenceOk) return;

    // Confluence met — validate token
    logger.info({
      token: mint.slice(0, 8),
      wallets: Array.from(pending.wallets.keys()).map((w) => w.slice(0, 8)),
    }, 'Wallet confluence met — running validation');

    const validation = await validateToken(mint, tierCfg);

    const walletAddresses = Array.from(pending.wallets.keys());
    const firstSignal = Array.from(pending.wallets.values())[0].signal;

    // Log signal event
    const signalAction = validation.passed ? SignalAction.EXECUTED : SignalAction.SKIPPED_VALIDATION;
    const validationResult = validation.passed ? ValidationResult.PASSED : (validation.failReason || ValidationResult.FAILED_SAFETY);

    await this.logSignalEvent(
      mint,
      validation.dexData?.baseToken?.symbol || null,
      walletAddresses,
      firstSignal.detectionSource,
      validationResult,
      validation as unknown as Record<string, unknown>,
      tierCfg.tier,
      signalAction,
    );

    if (!validation.passed) {
      logger.info({
        token: mint.slice(0, 8),
        reason: validation.failReason,
      }, 'Signal skipped — validation failed');
      this.pendingBuys.delete(mint);
      return;
    }

    // Mark as processed to prevent re-entry
    this.processedTokens.add(mint);
    this.pendingBuys.delete(mint);

    // Fire callback with validated signal
    if (this.onSignalValid) {
      await this.onSignalValid({
        tokenMint: mint,
        tokenSymbol: validation.dexData?.baseToken?.symbol || null,
        walletAddresses,
        walletCount: walletAddresses.length,
        firstSignal,
        validation,
        tierConfig: tierCfg,
        detectedAt: new Date(pending.firstDetectedAt),
      });
    }
  }

  private checkConfluence(pending: PendingBuy, tierCfg: TierConfig): boolean {
    const windowMs = tierCfg.confluenceWindow * 60 * 1000;
    const now = Date.now();

    // Filter to wallets within the confluence window
    let walletsInWindow = 0;
    for (const [, entry] of pending.wallets) {
      if (now - entry.detectedAt <= windowMs) {
        walletsInWindow++;
      }
    }

    // Special case for FULL tier: any single wallet
    if (tierCfg.tier === CapitalTier.FULL) {
      return walletsInWindow >= 1;
    }

    // Special case for MEDIUM: 1 Tier A wallet OR 2+ any
    if (tierCfg.tier === CapitalTier.MEDIUM) {
      // Check if any wallet in window is Tier A
      // (would need to look up wallet tier from DB — simplified here)
      return walletsInWindow >= tierCfg.walletConfluenceRequired;
    }

    return walletsInWindow >= tierCfg.walletConfluenceRequired;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 60 minutes max pending time

    for (const [mint, pending] of this.pendingBuys) {
      if (now - pending.firstDetectedAt > maxAge) {
        this.pendingBuys.delete(mint);
      }
    }

    // Clean processed tokens older than 48 hours
    // (Simplified — in production would track timestamps)
    if (this.processedTokens.size > 1000) {
      this.processedTokens.clear();
    }
  }

  private async logSignalEvent(
    tokenAddress: string,
    tokenSymbol: string | null,
    walletAddresses: string[],
    detectionSource: DetectionSource,
    validationResult: ValidationResult,
    validationDetails: Record<string, unknown>,
    capitalTier: CapitalTier,
    actionTaken: SignalAction,
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO signal_events (token_address, token_symbol, wallet_addresses, wallet_count, detection_source, validation_result, validation_details, capital_tier, action_taken)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tokenAddress,
          tokenSymbol,
          walletAddresses,
          walletAddresses.length,
          detectionSource,
          validationResult,
          JSON.stringify(validationDetails),
          capitalTier,
          actionTaken,
        ],
      );
    } catch (err) {
      logger.error({ err }, 'Failed to log signal event');
    }
  }

  /** Get pending buy status for debugging */
  getPendingBuys(): Array<{ token: string; wallets: number; ageMs: number }> {
    return Array.from(this.pendingBuys.entries()).map(([mint, p]) => ({
      token: mint.slice(0, 8),
      wallets: p.wallets.size,
      ageMs: Date.now() - p.firstDetectedAt,
    }));
  }
}

export interface ValidatedSignal {
  tokenMint: string;
  tokenSymbol: string | null;
  walletAddresses: string[];
  walletCount: number;
  firstSignal: ParsedSignal;
  validation: import('../../types/index.js').FullValidationResult;
  tierConfig: TierConfig;
  detectedAt: Date;
}
