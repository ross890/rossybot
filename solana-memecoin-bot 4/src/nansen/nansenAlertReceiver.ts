// ===========================================
// NANSEN SMART ALERT WEBHOOK RECEIVER — INTEGRATION 4
// Receives real-time smart money buy notifications via webhook
// Feeds tokens into discovery pipeline + wallets into wallet engine
// ===========================================

import { logger } from '../utils/logger.js';
import { walletEngine } from '../wallets/walletEngine.js';

// ============ TYPES ============

export interface NansenAlertPayload {
  alert_type?: string;
  chain?: string;
  token_address?: string;
  token_symbol?: string;
  wallet_address?: string;
  wallet_label?: string;
  value_usd?: number;
  timestamp?: string;
}

export interface NansenAlertResult {
  action: 'SUBMITTED' | 'SKIPPED_NON_SOLANA' | 'SKIPPED_EXISTING_ALPHA' | 'SKIPPED_INVALID' | 'ERROR';
  tokenAddress?: string;
  walletAddress?: string;
  reason?: string;
}

// Callback type for submitting tokens to discovery pipeline
type DiscoverySubmitCallback = (data: {
  tokenAddress: string;
  source: string;
  metadata: Record<string, any>;
}) => Promise<void>;

// ============ RECEIVER CLASS ============

export class NansenAlertReceiver {
  private discoveryCallback: DiscoverySubmitCallback | null = null;
  private isActiveWalletChecker: ((address: string) => Promise<boolean>) | null = null;

  /**
   * Set the callback for submitting tokens to the discovery pipeline
   */
  setDiscoveryCallback(callback: DiscoverySubmitCallback): void {
    this.discoveryCallback = callback;
  }

  /**
   * Set the callback for checking if a wallet is already active
   */
  setActiveWalletChecker(checker: (address: string) => Promise<boolean>): void {
    this.isActiveWalletChecker = checker;
  }

  /**
   * Handle incoming Nansen webhook alert
   * Called by the Express/Fastify route handler
   */
  async handleAlert(payload: NansenAlertPayload): Promise<NansenAlertResult> {
    try {
      // Validate payload
      if (!payload.token_address || !payload.wallet_address) {
        return { action: 'SKIPPED_INVALID', reason: 'Missing token or wallet address' };
      }

      // Only process Solana alerts
      if (payload.chain && payload.chain !== 'solana') {
        return { action: 'SKIPPED_NON_SOLANA', reason: `Chain: ${payload.chain}` };
      }

      const tokenAddress = payload.token_address;
      const walletAddress = payload.wallet_address;

      // Check if this is an existing alpha wallet
      if (this.isActiveWalletChecker) {
        const isActive = await this.isActiveWalletChecker(walletAddress);
        if (isActive) {
          // Existing alpha wallet — the alpha wallet monitor should catch this
          logger.debug({
            wallet: walletAddress.slice(0, 8),
            token: tokenAddress.slice(0, 8),
          }, 'NansenAlertReceiver: Existing alpha wallet, handled by monitor');
          return {
            action: 'SKIPPED_EXISTING_ALPHA',
            tokenAddress,
            walletAddress,
          };
        }
      }

      // Submit token to discovery pipeline
      if (this.discoveryCallback) {
        await this.discoveryCallback({
          tokenAddress,
          source: 'NANSEN_SMART_ALERT',
          metadata: {
            walletAddress,
            walletLabel: payload.wallet_label || null,
            transactionValue: payload.value_usd || 0,
            alertType: payload.alert_type || 'unknown',
          },
        });
      }

      // Also submit the wallet as a candidate for the wallet engine
      const result = await walletEngine.addCandidate(
        walletAddress,
        'NANSEN_SMART_ALERT',
        tokenAddress,
      );

      if (result.isNew) {
        logger.info({
          wallet: walletAddress.slice(0, 8),
          token: tokenAddress.slice(0, 8),
          label: payload.wallet_label,
          value: payload.value_usd,
        }, 'NansenAlertReceiver: New wallet candidate from smart alert');
      }

      return {
        action: 'SUBMITTED',
        tokenAddress,
        walletAddress,
      };
    } catch (error) {
      logger.error({ error }, 'NansenAlertReceiver: Error handling alert');
      return { action: 'ERROR', reason: String(error) };
    }
  }

  /**
   * Express/Fastify route handler factory
   * Returns a handler function for POST /webhooks/nansen
   */
  createRouteHandler(): (req: any, res: any) => Promise<void> {
    return async (req: any, res: any) => {
      try {
        const payload = req.body as NansenAlertPayload;
        const result = await this.handleAlert(payload);

        switch (result.action) {
          case 'SUBMITTED':
            res.status(200).json({ status: 'OK', action: 'submitted to pipeline' });
            break;
          case 'SKIPPED_NON_SOLANA':
            res.status(200).json({ status: 'OK', action: 'skipped — non-Solana' });
            break;
          case 'SKIPPED_EXISTING_ALPHA':
            res.status(200).json({ status: 'OK', action: 'skipped — existing alpha, handled by monitor' });
            break;
          case 'SKIPPED_INVALID':
            res.status(400).json({ status: 'ERROR', reason: result.reason });
            break;
          default:
            res.status(500).json({ status: 'ERROR', reason: result.reason });
        }
      } catch (error) {
        logger.error({ error }, 'NansenAlertReceiver: Route handler error');
        res.status(500).json({ status: 'ERROR', reason: 'Internal error' });
      }
    };
  }
}

// ============ SINGLETON ============

export const nansenAlertReceiver = new NansenAlertReceiver();

export default nansenAlertReceiver;
