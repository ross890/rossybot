// ===========================================
// ALPHA WALLET ENGINE — TELEGRAM COMMANDS
// /wallet_status, /wallet_add, /wallet_promote, /wallet_suspend,
// /wallet_reinstate, /wallet_remove, /wallet_list, /wallet_candidates
// ===========================================

import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../utils/logger.js';
import { walletEngine } from '../../wallets/walletEngine.js';
import { walletPerformanceManager } from '../../wallets/walletPerformance.js';

// Solana address regex
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Register wallet engine commands on a Telegram bot instance
 */
export function registerWalletCommands(bot: TelegramBot, chatId: string): void {
  // /wallet_status — Overview of active/candidate/suspended counts + top performers
  bot.onText(/\/wallet_status/, async (msg) => {
    if (msg.chat.id.toString() !== chatId) return;

    try {
      const report = await walletPerformanceManager.formatDailyReport();
      await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ error }, 'WalletCommands: Error in /wallet_status');
      await bot.sendMessage(chatId, 'Error fetching wallet status.');
    }
  });

  // /wallet_add {address} — Manually add wallet to candidate list
  bot.onText(/\/wallet_add\s+([1-9A-HJ-NP-Za-km-z]{32,44})/, async (msg, match) => {
    if (msg.chat.id.toString() !== chatId) return;
    const address = match?.[1];
    if (!address) {
      await bot.sendMessage(chatId, 'Usage: /wallet\\_add <solana\\_address>');
      return;
    }

    try {
      const result = await walletEngine.addCandidate(address, 'MANUAL');

      if (result.isNew) {
        await bot.sendMessage(chatId,
          `*Wallet added to candidates*\n\n` +
          `Address: \`${address.slice(0, 8)}...${address.slice(-6)}\`\n` +
          `Source: MANUAL\n` +
          `Status: CANDIDATE (shadow tracking)\n\n` +
          `_Will be observed and graduated if profitable._`,
          { parse_mode: 'Markdown' }
        );
      } else if (result.id > 0) {
        await bot.sendMessage(chatId, 'Wallet already tracked in the engine.');
      } else {
        await bot.sendMessage(chatId, 'Could not add wallet (may be on cooldown or max candidates reached).');
      }
    } catch (error) {
      logger.error({ error }, 'WalletCommands: Error in /wallet_add');
      await bot.sendMessage(chatId, 'Error adding wallet.');
    }
  });

  // /wallet_promote {address} — Force-graduate candidate to active
  bot.onText(/\/wallet_promote\s+([1-9A-HJ-NP-Za-km-z]{32,44})/, async (msg, match) => {
    if (msg.chat.id.toString() !== chatId) return;
    const address = match?.[1];
    if (!address) {
      await bot.sendMessage(chatId, 'Usage: /wallet\\_promote <solana\\_address>');
      return;
    }

    try {
      const success = await walletEngine.forcePromoteWallet(address);
      if (success) {
        await bot.sendMessage(chatId,
          `*Wallet force-graduated to ACTIVE*\n` +
          `\`${address.slice(0, 8)}...${address.slice(-6)}\`\n` +
          `Weight: 1.0x | Now generating signals.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(chatId, 'Could not promote. Wallet must be a CANDIDATE to promote.');
      }
    } catch (error) {
      logger.error({ error }, 'WalletCommands: Error in /wallet_promote');
      await bot.sendMessage(chatId, 'Error promoting wallet.');
    }
  });

  // /wallet_suspend {address} — Manually suspend active wallet
  bot.onText(/\/wallet_suspend\s+([1-9A-HJ-NP-Za-km-z]{32,44})/, async (msg, match) => {
    if (msg.chat.id.toString() !== chatId) return;
    const address = match?.[1];
    if (!address) {
      await bot.sendMessage(chatId, 'Usage: /wallet\\_suspend <solana\\_address>');
      return;
    }

    try {
      const wallet = await walletEngine.getWalletByAddress(address);
      if (!wallet) {
        await bot.sendMessage(chatId, 'Wallet not found in engine.');
        return;
      }

      await walletEngine.fullSuspendWallet(wallet.id, 'Manual suspension via Telegram');
      await bot.sendMessage(chatId,
        `*Wallet SUSPENDED*\n` +
        `\`${address.slice(0, 8)}...${address.slice(-6)}\`\n` +
        `Signals stopped. Use /wallet\\_reinstate to reactivate.`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      logger.error({ error }, 'WalletCommands: Error in /wallet_suspend');
      await bot.sendMessage(chatId, 'Error suspending wallet.');
    }
  });

  // /wallet_reinstate {address} — Reinstate suspended wallet at weight 0.75
  bot.onText(/\/wallet_reinstate\s+([1-9A-HJ-NP-Za-km-z]{32,44})/, async (msg, match) => {
    if (msg.chat.id.toString() !== chatId) return;
    const address = match?.[1];
    if (!address) {
      await bot.sendMessage(chatId, 'Usage: /wallet\\_reinstate <solana\\_address>');
      return;
    }

    try {
      const wallet = await walletEngine.getWalletByAddress(address);
      if (!wallet) {
        await bot.sendMessage(chatId, 'Wallet not found in engine.');
        return;
      }

      const success = await walletEngine.reinstateWallet(wallet.id);
      if (success) {
        await bot.sendMessage(chatId,
          `*Wallet REINSTATED*\n` +
          `\`${address.slice(0, 8)}...${address.slice(-6)}\`\n` +
          `Weight: 0.75x | Signals active.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(chatId, 'Could not reinstate. Wallet must be SUSPENDED to reinstate.');
      }
    } catch (error) {
      logger.error({ error }, 'WalletCommands: Error in /wallet_reinstate');
      await bot.sendMessage(chatId, 'Error reinstating wallet.');
    }
  });

  // /wallet_remove {address} — Permanently remove and cooldown for 60 days
  bot.onText(/\/wallet_remove\s+([1-9A-HJ-NP-Za-km-z]{32,44})/, async (msg, match) => {
    if (msg.chat.id.toString() !== chatId) return;
    const address = match?.[1];
    if (!address) {
      await bot.sendMessage(chatId, 'Usage: /wallet\\_remove <solana\\_address>');
      return;
    }

    try {
      const success = await walletEngine.manualRemoveWallet(address);
      if (success) {
        await bot.sendMessage(chatId,
          `*Wallet REMOVED*\n` +
          `\`${address.slice(0, 8)}...${address.slice(-6)}\`\n` +
          `Purged with 60-day cooldown.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(chatId, 'Wallet not found in engine.');
      }
    } catch (error) {
      logger.error({ error }, 'WalletCommands: Error in /wallet_remove');
      await bot.sendMessage(chatId, 'Error removing wallet.');
    }
  });

  // /wallet_list — List all active wallets with weights and stats
  bot.onText(/\/wallet_list/, async (msg) => {
    if (msg.chat.id.toString() !== chatId) return;

    try {
      const active = await walletEngine.getActiveWallets();

      if (active.length === 0) {
        await bot.sendMessage(chatId, 'No active engine wallets yet.');
        return;
      }

      let message = `*Active Engine Wallets (${active.length})*\n\n`;

      for (const w of active) {
        const addr = `${w.walletAddress.slice(0, 6)}...${w.walletAddress.slice(-4)}`;
        message += `\`${addr}\` w=${w.weight.toFixed(1)}x\n`;
        message += `  Source: ${w.source} | Signals: ${w.totalSignals}\n`;
        message += `  EV: ${w.signalEv >= 0 ? '+' : ''}${w.signalEv.toFixed(1)}% | WR: ${(w.signalWinRate * 100).toFixed(0)}% | Streak: ${w.currentStreak}\n\n`;
      }

      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ error }, 'WalletCommands: Error in /wallet_list');
      await bot.sendMessage(chatId, 'Error listing wallets.');
    }
  });

  // /wallet_candidates — List all candidates with observation progress
  bot.onText(/\/wallet_candidates/, async (msg) => {
    if (msg.chat.id.toString() !== chatId) return;

    try {
      const candidates = await walletEngine.getCandidates();

      if (candidates.length === 0) {
        await bot.sendMessage(chatId, 'No candidate wallets in observation.');
        return;
      }

      let message = `*Candidate Wallets (${candidates.length})*\n\n`;

      // Show top 20 by observed trades
      const sorted = [...candidates].sort((a, b) => b.observedTrades - a.observedTrades);
      const shown = sorted.slice(0, 20);

      for (const c of shown) {
        const addr = `${c.walletAddress.slice(0, 6)}...${c.walletAddress.slice(-4)}`;
        const daysSinceAdded = ((Date.now() - new Date(c.addedAt).getTime()) / (1000 * 60 * 60 * 24)).toFixed(0);
        message += `\`${addr}\` ${c.source}\n`;
        message += `  Observed: ${c.observedTrades} trades | ${daysSinceAdded}d ago\n`;
        if (c.observedTrades > 0) {
          message += `  WR: ${(c.observedWinRate * 100).toFixed(0)}% | EV: ${c.observedEv >= 0 ? '+' : ''}${c.observedEv.toFixed(1)}%\n`;
        }
        message += '\n';
      }

      if (candidates.length > 20) {
        message += `_...and ${candidates.length - 20} more_`;
      }

      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ error }, 'WalletCommands: Error in /wallet_candidates');
      await bot.sendMessage(chatId, 'Error listing candidates.');
    }
  });

  logger.info('WalletCommands: Registered wallet engine commands');
}
