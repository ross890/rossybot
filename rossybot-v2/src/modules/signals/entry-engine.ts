import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { query, getMany, getOne } from '../../db/database.js';
import { config } from '../../config/index.js';
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
  private onSignalValidated: ((signal: ValidatedSignal & { passed: boolean; failReason: string | null }, validation: import('../../types/index.js').FullValidationResult) => Promise<void>) | null = null;
  private allTrackedWallets: Set<string> = new Set(); // All wallets in DB (subscribed + unsubscribed)

  constructor() {
    // Clean up expired pending buys every 60 seconds
    setInterval(() => this.cleanupExpired(), 60_000);
  }

  /** Update the full set of tracked wallets (including unsubscribed ones) */
  updateAllTrackedWallets(wallets: string[]): void {
    this.allTrackedWallets = new Set(wallets);
  }

  setSignalCallback(cb: (signal: ValidatedSignal) => Promise<void>): void {
    this.onSignalValid = cb;
  }

  setSignalLogCallback(cb: (signal: ValidatedSignal & { passed: boolean; failReason: string | null }, validation: import('../../types/index.js').FullValidationResult) => Promise<void>): void {
    this.onSignalValidated = cb;
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

    const effectiveConfluence = config.shadowMode ? 1 : tierCfg.walletConfluenceRequired;
    logger.info({
      token: mint.slice(0, 8),
      wallet: signal.walletAddress.slice(0, 8),
      walletCount: pending.wallets.size,
      required: effectiveConfluence,
      shadowOverride: config.shadowMode,
    }, 'Buy signal accumulated');

    // Check on-chain confluence from unsubscribed tracked wallets
    if (pending.wallets.size < tierCfg.walletConfluenceRequired) {
      const onChainHolders = await this.checkUnsubscribedWalletHolders(mint, pending);
      if (onChainHolders.length > 0) {
        logger.info({
          token: mint.slice(0, 8),
          onChainWallets: onChainHolders.map((w) => w.slice(0, 8)),
        }, 'On-chain confluence found from unsubscribed wallets');
      }
    }

    // Check confluence requirement
    const confluenceOk = this.checkConfluence(pending, tierCfg);
    if (!confluenceOk) return;

    // Confluence met — mark as processed immediately to prevent duplicate validation
    // (concurrent processBuySignal calls can race past the dedup check at the top)
    this.processedTokens.add(mint);

    // Confluence met — validate token
    logger.info({
      token: mint.slice(0, 8),
      wallets: Array.from(pending.wallets.keys()).map((w) => w.slice(0, 8)),
    }, 'Wallet confluence met — running validation');

    const validation = await validateToken(mint, tierCfg);

    const walletAddresses = Array.from(pending.wallets.keys());
    const walletSignals = Array.from(pending.wallets.values());
    const firstSignal = walletSignals[0].signal;
    const alphaSolSpent = walletSignals.reduce((sum, ws) => sum + Math.abs(ws.signal.solDelta), 0);

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

    // Fire signal log callback only for passed signals
    if (this.onSignalValidated && validation.passed) {
      try {
        await this.onSignalValidated({
          tokenMint: mint,
          tokenSymbol: validation.dexData?.baseToken?.symbol || null,
          walletAddresses,
          walletCount: walletAddresses.length,
          firstSignal,
          alphaSolSpent,
          validation,
          tierConfig: tierCfg,
          detectedAt: new Date(pending.firstDetectedAt),
          passed: validation.passed,
          failReason: validation.failReason,
        }, validation);
      } catch (err) {
        logger.error({ err }, 'Error in signal log callback');
      }
    }

    if (!validation.passed) {
      // Find the specific check that failed and log its reason
      const failedCheck = validation.failReason === 'FAILED_SAFETY' ? validation.safety
        : validation.failReason === 'FAILED_LIQUIDITY' ? validation.liquidity
        : validation.failReason === 'FAILED_MOMENTUM' ? validation.momentum
        : validation.failReason === 'FAILED_MCAP' ? validation.mcap
        : validation.failReason === 'FAILED_AGE' ? validation.age
        : null;
      logger.info({
        token: mint.slice(0, 8),
        reason: validation.failReason,
        detail: failedCheck?.reason || 'unknown',
        mcap: validation.dexData?.marketCap || validation.dexData?.fdv,
        liquidity: validation.dexData?.liquidity?.usd,
        momentum24h: validation.dexData?.priceChange?.h24,
      }, `Signal skipped — ${validation.failReason}: ${failedCheck?.reason || 'unknown'}`);
      // Keep in processedTokens — don't allow re-entry with different wallet combos
      this.pendingBuys.delete(mint);
      return;
    }

    this.pendingBuys.delete(mint);

    // Fire callback with validated signal
    if (this.onSignalValid) {
      await this.onSignalValid({
        tokenMint: mint,
        tokenSymbol: validation.dexData?.baseToken?.symbol || null,
        walletAddresses,
        walletCount: walletAddresses.length,
        firstSignal,
        alphaSolSpent,
        validation,
        tierConfig: tierCfg,
        detectedAt: new Date(pending.firstDetectedAt),
      });
    }
  }

  /**
   * Check if any unsubscribed tracked wallets hold the token.
   * Uses Helius RPC getTokenAccounts to check holdings without needing WebSocket.
   * Returns wallet addresses that hold the token and adds them as synthetic signals.
   */
  private async checkUnsubscribedWalletHolders(
    tokenMint: string,
    pending: PendingBuy,
  ): Promise<string[]> {
    const unsubscribed = Array.from(this.allTrackedWallets)
      .filter((w) => !pending.wallets.has(w));

    if (unsubscribed.length === 0) return [];

    const holders: string[] = [];

    // Batch check: for each unsubscribed wallet, check if they hold this token
    // Use getTokenAccountsByOwner RPC — 1 call per wallet but lightweight
    const checkPromises = unsubscribed.slice(0, 12).map(async (wallet) => {
      try {
        const resp = await axios.post(config.helius.rpcUrl, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [
            wallet,
            { mint: tokenMint },
            { encoding: 'jsonParsed' },
          ],
        }, { timeout: 5000 });

        const accounts = resp.data?.result?.value || [];
        if (accounts.length > 0) {
          const amount = accounts[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
          if (amount > 0) {
            holders.push(wallet);
            // Add as synthetic signal (detected via on-chain check, not WebSocket)
            pending.wallets.set(wallet, {
              signal: {
                walletAddress: wallet,
                txSignature: 'on-chain-check',
                blockTime: Math.floor(Date.now() / 1000),
                type: SignalType.BUY,
                tokenMint,
                tokenAmount: amount,
                solDelta: 0,
                detectedAt: new Date(),
                detectionLagMs: 0,
                detectionSource: DetectionSource.HELIUS_RPC_FALLBACK,
              },
              detectedAt: Date.now(),
            });
          }
        }
      } catch {
        // Silent — RPC check is best-effort
      }
    });

    await Promise.all(checkPromises);
    return holders;
  }

  private checkConfluence(pending: PendingBuy, tierCfg: TierConfig): boolean {
    const windowMs = tierCfg.confluenceWindow * 60 * 1000;
    const now = Date.now();

    // Shadow mode: single wallet triggers — no real capital at risk
    if (config.shadowMode) {
      for (const [, entry] of pending.wallets) {
        if (now - entry.detectedAt <= windowMs) return true;
      }
      return false;
    }

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

  /**
   * Allow a previously processed token to be re-evaluated.
   * Called when a position closes and re-entry conditions are met.
   */
  allowReentry(tokenMint: string): void {
    this.processedTokens.delete(tokenMint);
    this.pendingBuys.delete(tokenMint); // Clear any stale pending state
    logger.info({ token: tokenMint.slice(0, 8) }, 'Token cleared for re-entry — removed from processedTokens');
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
  /** Total SOL spent by alpha wallets on this token (sum of all accumulated signals) */
  alphaSolSpent: number;
  validation: import('../../types/index.js').FullValidationResult;
  tierConfig: TierConfig;
  detectedAt: Date;
}
