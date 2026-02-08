// ===========================================
// MODULE: PUMP.FUN DEV SIGNAL GENERATION
// Generates and formats signals for tracked dev launches
// ===========================================

import { logger } from '../../utils/logger.js';
import type { PumpfunDev, DevSignal, DevSignalPriority } from '../../types/index.js';

// ============ SIGNAL PRIORITY ============

/**
 * Determine signal priority based on dev stats
 * HIGH: success rate > 30% AND best peak MC > $500K
 * MEDIUM: meets basic qualification criteria
 */
export function calculateDevSignalPriority(dev: PumpfunDev): DevSignalPriority {
  if (dev.successRate > 0.30 && dev.bestPeakMc > 500_000) {
    return 'HIGH';
  }
  return 'MEDIUM';
}

// ============ TIME FORMATTING ============

function formatTimeAgo(date: Date | null): string {
  if (!date) return 'Unknown';

  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

// ============ MC FORMATTING ============

function formatMarketCap(mc: number): string {
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(1)}M`;
  if (mc >= 1_000) return `$${(mc / 1_000).toFixed(0)}K`;
  return `$${mc.toFixed(0)}`;
}

// ============ SIGNAL CREATION ============

/**
 * Create a DevSignal from a dev record and token info
 */
export function createDevSignal(
  dev: PumpfunDev,
  tokenMint: string,
  tokenName: string,
  tokenSymbol: string,
  platform: string = 'pumpfun',
  bondingCurveProgress?: number,
): DevSignal {
  const priority = calculateDevSignalPriority(dev);
  const rugRate = dev.totalLaunches > 0 ? dev.rugCount / dev.totalLaunches : 0;

  const signal: DevSignal = {
    type: 'DEV_SIGNAL',
    priority,
    dev: {
      walletAddress: dev.walletAddress,
      alias: dev.alias,
      totalLaunches: dev.totalLaunches,
      successRate: dev.successRate,
      bestPeakMc: dev.bestPeakMc,
      avgPeakMc: dev.avgPeakMc,
      rugRate,
      lastLaunchAge: formatTimeAgo(dev.lastLaunchAt),
    },
    token: {
      mint: tokenMint,
      name: tokenName,
      symbol: tokenSymbol,
      platform,
      launchedAt: new Date(),
      bondingCurveProgress,
    },
    timestamp: new Date(),
  };

  logger.debug({
    devWallet: dev.walletAddress,
    tokenMint,
    priority,
    successRate: dev.successRate,
  }, 'Dev signal created');

  return signal;
}

// ============ TELEGRAM FORMATTING ============

/**
 * Format a DevSignal for Telegram delivery
 * Visually distinct from KOL and Discovery signals
 */
export function formatDevSignalTelegram(signal: DevSignal): string {
  const { dev, token } = signal;
  const priorityEmoji = signal.priority === 'HIGH' ? '🔴' : '🟡';
  const successPct = (dev.successRate * 100).toFixed(1);
  const rugPct = (dev.rugRate * 100).toFixed(0);
  const devAlias = dev.alias ? ` (${dev.alias})` : '';
  const mintShort = token.mint.slice(0, 6) + '...' + token.mint.slice(-4);
  const devWalletShort = dev.walletAddress.slice(0, 6) + '...' + dev.walletAddress.slice(-4);

  const platformDisplay = token.platform === 'pumpfun' ? 'Pump.fun'
    : token.platform === 'raydium_launchlab' ? 'Raydium LaunchLab'
    : token.platform;

  let msg = '';
  msg += `*🏗️ ROSSYBOT DEV SIGNAL*\n\n`;
  msg += `*Token:* \`$${token.symbol}\` (${mintShort})\n`;
  msg += `*Platform:* ${platformDisplay}\n`;
  msg += `*Launched:* Just now\n\n`;

  msg += `*👷 DEV PROFILE*\n`;
  msg += `├─ Wallet: \`${devWalletShort}\`${devAlias}\n`;
  msg += `├─ Total Launches: ${dev.totalLaunches}\n`;
  msg += `├─ Hit $200K+: ${Math.round(dev.successRate * dev.totalLaunches)} (${successPct}%)\n`;
  msg += `├─ Best Launch: ${formatMarketCap(dev.bestPeakMc)} peak MC\n`;
  msg += `├─ Avg Peak MC: ${formatMarketCap(dev.avgPeakMc)}\n`;
  msg += `├─ Rug Rate: ${rugPct}%\n`;
  msg += `└─ Last Launch: ${dev.lastLaunchAge}\n\n`;

  msg += `*⚡ SIGNAL PRIORITY:* ${priorityEmoji} ${signal.priority}\n\n`;

  msg += `*🔗 Links*\n`;
  msg += `├─ [Pump.fun](https://pump.fun/${token.mint})\n`;
  msg += `├─ [Solscan Token](https://solscan.io/token/${token.mint})\n`;
  msg += `├─ [Dev Wallet](https://solscan.io/account/${dev.walletAddress})\n`;
  msg += `├─ [DexScreener](https://dexscreener.com/solana/${token.mint})\n`;
  msg += `└─ [GMGN](https://gmgn.ai/sol/token/${token.mint})`;

  return msg;
}

/**
 * Format a KOL validation follow-up for a dev-launched token
 */
export function formatDevKolValidation(
  tokenMint: string,
  tokenSymbol: string,
  kolHandle: string,
): string {
  const mintShort = tokenMint.slice(0, 6) + '...' + tokenMint.slice(-4);

  let msg = '';
  msg += `*🔄 DEV TOKEN KOL VALIDATION*\n\n`;
  msg += `Token: \`$${tokenSymbol}\` (${mintShort})\n`;
  msg += `KOL: @${kolHandle} confirmed buy\n\n`;
  msg += `_Dev-launched token now has KOL backing — high conviction signal_`;

  return msg;
}
