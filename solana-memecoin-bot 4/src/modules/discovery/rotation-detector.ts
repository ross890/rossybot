// ===========================================
// MODULE: SMART MONEY ROTATION DETECTOR
// Tracks sell→buy pairs across monitored wallets to detect
// coordinated rotation from one token into another.
// ===========================================

import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';

// ============ TYPES ============

export interface RotationSignal {
  targetToken: string;         // Token being rotated INTO
  sourceTokens: string[];      // Tokens being sold
  walletCount: number;         // Number of independent wallets rotating
  totalSolDeployed: number;    // Total SOL flowing into target
  wallets: RotationEntry[];    // Individual rotation entries
  detectedAt: Date;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  score: number;               // 0-100
}

interface RotationEntry {
  walletAddress: string;
  walletLabel: string | null;
  soldToken: string;
  soldTicker: string | null;
  soldSol: number;
  boughtToken: string;
  boughtSol: number;
  timeBetweenMs: number;       // Time between sell and buy
}

// ============ CONSTANTS ============

// Maximum time between sell and buy to count as a rotation
const MAX_ROTATION_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

// Minimum wallets rotating into same token to generate signal
const MIN_WALLETS_FOR_SIGNAL = 2;

// How far back to scan for sell→buy pairs
const SCAN_WINDOW_HOURS = 48;

// Minimum SOL in the sell leg to count (ignore dust)
const MIN_SELL_SOL = 0.5;

// Cache rotation signals to avoid re-alerting
const SIGNAL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// ============ ROTATION DETECTOR CLASS ============

class RotationDetector {
  private recentSignals: Map<string, number> = new Map(); // tokenAddress → lastSignalTime

  /**
   * Scan alpha wallet trades for rotation patterns.
   * Returns tokens that multiple wallets are rotating into.
   */
  async detectRotations(): Promise<RotationSignal[]> {
    try {
      // Pull all alpha wallet trades from last 48h
      const result = await pool.query(`
        SELECT
          t.wallet_address,
          w.label AS wallet_label,
          t.token_address,
          t.token_ticker,
          t.trade_type,
          t.sol_amount,
          t.timestamp,
          t.tx_signature
        FROM alpha_wallet_trades t
        JOIN alpha_wallets w ON w.address = t.wallet_address
        WHERE t.timestamp > NOW() - INTERVAL '${SCAN_WINDOW_HOURS} hours'
          AND w.status IN ('ACTIVE', 'TRUSTED')
          AND t.sol_amount >= ${MIN_SELL_SOL}
        ORDER BY t.wallet_address, t.timestamp ASC
      `);

      if (result.rows.length === 0) return [];

      // Group trades by wallet, find sell→buy pairs
      const rotations = this.findRotationPairs(result.rows);

      // Group by target token
      const byTarget = new Map<string, RotationEntry[]>();
      for (const rotation of rotations) {
        const existing = byTarget.get(rotation.boughtToken) || [];
        existing.push(rotation);
        byTarget.set(rotation.boughtToken, existing);
      }

      // Build signals for tokens with multiple wallets rotating in
      const signals: RotationSignal[] = [];
      for (const [targetToken, entries] of byTarget) {
        // Count unique wallets
        const uniqueWallets = new Set(entries.map(e => e.walletAddress));
        if (uniqueWallets.size < MIN_WALLETS_FOR_SIGNAL) continue;

        // Check cooldown
        const lastSignal = this.recentSignals.get(targetToken);
        if (lastSignal && Date.now() - lastSignal < SIGNAL_COOLDOWN_MS) continue;

        const totalSol = entries.reduce((sum, e) => sum + e.boughtSol, 0);
        const sourceTokens = [...new Set(entries.map(e => e.soldToken))];

        const confidence = uniqueWallets.size >= 4 ? 'HIGH' as const :
                          uniqueWallets.size >= 3 ? 'MEDIUM' as const : 'LOW' as const;

        const score = Math.min(100, Math.round(
          uniqueWallets.size * 20 +        // More wallets = stronger signal
          Math.min(30, totalSol * 3) +      // More SOL = stronger conviction
          sourceTokens.length * 5            // Diverse exits = broader rotation
        ));

        signals.push({
          targetToken,
          sourceTokens,
          walletCount: uniqueWallets.size,
          totalSolDeployed: totalSol,
          wallets: entries,
          detectedAt: new Date(),
          confidence,
          score,
        });

        this.recentSignals.set(targetToken, Date.now());
      }

      // Cleanup old cooldowns
      const now = Date.now();
      for (const [token, ts] of this.recentSignals) {
        if (now - ts > SIGNAL_COOLDOWN_MS * 2) this.recentSignals.delete(token);
      }

      if (signals.length > 0) {
        logger.info({ rotationSignals: signals.length }, 'Rotation signals detected');
      }

      return signals.sort((a, b) => b.score - a.score);
    } catch (error) {
      logger.error({ error }, 'Rotation detector scan failed');
      return [];
    }
  }

  /**
   * Find sell→buy pairs within the rotation window for each wallet.
   */
  private findRotationPairs(trades: any[]): RotationEntry[] {
    const pairs: RotationEntry[] = [];

    // Group by wallet
    const byWallet = new Map<string, any[]>();
    for (const trade of trades) {
      const existing = byWallet.get(trade.wallet_address) || [];
      existing.push(trade);
      byWallet.set(trade.wallet_address, existing);
    }

    for (const [walletAddress, walletTrades] of byWallet) {
      const sells = walletTrades.filter((t: any) => t.trade_type === 'SELL');
      const buys = walletTrades.filter((t: any) => t.trade_type === 'BUY');

      // For each buy, find the closest preceding sell (different token)
      for (const buy of buys) {
        const buyTime = new Date(buy.timestamp).getTime();

        let bestSell: any = null;
        let bestTimeDiff = Infinity;

        for (const sell of sells) {
          if (sell.token_address === buy.token_address) continue; // Same token = not a rotation
          const sellTime = new Date(sell.timestamp).getTime();
          const timeDiff = buyTime - sellTime;

          // Sell must be before buy, within window
          if (timeDiff > 0 && timeDiff < MAX_ROTATION_WINDOW_MS && timeDiff < bestTimeDiff) {
            bestSell = sell;
            bestTimeDiff = timeDiff;
          }
        }

        if (bestSell) {
          pairs.push({
            walletAddress,
            walletLabel: buy.wallet_label,
            soldToken: bestSell.token_address,
            soldTicker: bestSell.token_ticker,
            soldSol: parseFloat(bestSell.sol_amount),
            boughtToken: buy.token_address,
            boughtSol: parseFloat(buy.sol_amount),
            timeBetweenMs: bestTimeDiff,
          });
        }
      }
    }

    return pairs;
  }

  /**
   * Check if a specific token has rotation activity.
   * Used by the signal pipeline to add rotation context to existing signals.
   */
  async getRotationContext(tokenAddress: string): Promise<RotationSignal | null> {
    const signals = await this.detectRotations();
    return signals.find(s => s.targetToken === tokenAddress) || null;
  }
}

export const rotationDetector = new RotationDetector();
