import axios from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { DetectionSource } from '../../types/index.js';
import type { TransactionParser } from './transaction-parser.js';

export class FallbackPoller {
  private parser: TransactionParser;
  private wallets: Set<string>;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastSignatures: Map<string, string> = new Map();
  private active = false;

  constructor(parser: TransactionParser, wallets: string[]) {
    this.parser = parser;
    this.wallets = new Set(wallets);
  }

  updateWallets(addresses: string[]): void {
    this.wallets = new Set(addresses);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    logger.warn('Fallback RPC poller ACTIVATED');

    this.pollInterval = setInterval(() => this.poll(), config.helius.fallbackPollIntervalMs);
    // Immediate first poll
    this.poll();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    logger.info('Fallback RPC poller STOPPED');
  }

  private async poll(): Promise<void> {
    for (const wallet of this.wallets) {
      try {
        const resp = await axios.post(config.helius.rpcUrl, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [wallet, { limit: 5 }],
        });

        const signatures = resp.data?.result || [];
        const lastKnown = this.lastSignatures.get(wallet);

        for (const sig of signatures) {
          if (sig.signature === lastKnown) break;

          // Fetch full transaction
          const txResp = await axios.post(config.helius.rpcUrl, {
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [sig.signature, {
              encoding: 'jsonParsed',
              maxSupportedTransactionVersion: 0,
            }],
          });

          if (txResp.data?.result) {
            const result = {
              signature: sig.signature,
              slot: sig.slot,
              transaction: txResp.data.result,
            };
            await this.parser.parse(result, DetectionSource.HELIUS_RPC_FALLBACK);
          }
        }

        if (signatures.length > 0) {
          this.lastSignatures.set(wallet, signatures[0].signature);
        }
      } catch (err) {
        logger.error({ err, wallet: wallet.slice(0, 8) }, 'Fallback poll error');
      }
    }
  }
}
