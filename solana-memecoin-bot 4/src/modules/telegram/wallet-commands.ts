// ===========================================
// ALPHA WALLET ENGINE — TELEGRAM COMMANDS
// /wallet_status, /wallet_add, /wallet_promote, /wallet_suspend,
// /wallet_reinstate, /wallet_remove, /wallet_list, /wallet_candidates,
// /wallet_dashboard, /wallet_detail
// ===========================================

import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../utils/logger.js';
import { walletEngine } from '../../wallets/walletEngine.js';
import { walletPerformanceManager } from '../../wallets/walletPerformance.js';
import { Database } from '../../utils/database.js';

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

  // /wallet_dashboard — Rich overview of all tracked wallets across both pipelines
  bot.onText(/\/wallet_dashboard/, async (msg) => {
    if (msg.chat.id.toString() !== chatId) return;

    try {
      // Fetch both wallet pools
      const [alphaWallets, engineActive, engineCandidates] = await Promise.all([
        Database.getActiveAlphaWallets(),
        walletEngine.getActiveWallets(),
        walletEngine.getCandidates(),
      ]);

      let message = '*WALLET DASHBOARD*\n\n';

      // ── Summary counts ──
      message += '*Overview*\n';
      message += `Alpha wallets: ${alphaWallets.length} active\n`;
      message += `Engine wallets: ${engineActive.length} active, ${engineCandidates.length} candidates\n\n`;

      // ── Alpha Wallets Section ──
      if (alphaWallets.length > 0) {
        message += '*— Alpha Wallets —*\n';
        // Sort by win rate desc
        const sorted = [...alphaWallets].sort((a: any, b: any) => (b.win_rate || 0) - (a.win_rate || 0));

        for (const w of sorted.slice(0, 15)) {
          const addr = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
          const wr = ((w.win_rate || 0) * 100).toFixed(0);
          const ev = w.avg_roi != null ? (w.avg_roi >= 0 ? '+' : '') + (w.avg_roi * 100).toFixed(1) + '%' : 'n/a';
          const wt = (w.signal_weight || 0).toFixed(2);
          const label = w.label ? ` (${w.label})` : '';

          message += `\`${addr}\`${label} [${w.status}]\n`;
          message += `  Src: ${w.source || 'MANUAL'} | W: ${wt}x\n`;
          message += `  ${w.wins || 0}W/${w.losses || 0}L (${wr}% WR) | EV: ${ev}\n`;
          message += `  Trades: ${w.total_trades || 0}\n\n`;
        }

        if (alphaWallets.length > 15) {
          message += `_...+${alphaWallets.length - 15} more alpha wallets_\n\n`;
        }
      }

      // ── Engine Wallets Section ──
      if (engineActive.length > 0) {
        message += '*— Engine Wallets (Active) —*\n';
        // Sort by EV desc
        const sorted = [...engineActive].sort((a, b) => (b.signalEv || 0) - (a.signalEv || 0));

        for (const w of sorted.slice(0, 15)) {
          const addr = `${w.walletAddress.slice(0, 6)}...${w.walletAddress.slice(-4)}`;
          const wr = ((w.signalWinRate || 0) * 100).toFixed(0);
          const ev = (w.signalEv >= 0 ? '+' : '') + (w.signalEv || 0).toFixed(1) + '%';
          const nLabel = (w as any).nansenLabel ? ` (${(w as any).nansenLabel})` : '';

          message += `\`${addr}\`${nLabel}\n`;
          message += `  Src: ${w.source} | W: ${w.weight.toFixed(1)}x | Streak: ${w.currentStreak}\n`;
          message += `  Signals: ${w.totalSignals} | ${wr}% WR | EV: ${ev}\n\n`;
        }

        if (engineActive.length > 15) {
          message += `_...+${engineActive.length - 15} more engine wallets_\n\n`;
        }
      }

      // ── Source Breakdown ──
      const sourceCounts: Record<string, number> = {};
      for (const w of alphaWallets) {
        const src = w.source || 'MANUAL';
        sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      }
      for (const w of engineActive) {
        const src = w.source || 'UNKNOWN';
        sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      }

      if (Object.keys(sourceCounts).length > 0) {
        message += '*— Discovery Sources —*\n';
        for (const [src, count] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
          message += `  ${src}: ${count}\n`;
        }
        message += '\n';
      }

      message += '_Use /wallet\\_detail <address> for full breakdown_';

      // Split if too long for Telegram (4096 char limit)
      if (message.length > 4000) {
        const mid = message.lastIndexOf('\n\n', 2000);
        await bot.sendMessage(chatId, message.slice(0, mid), { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, message.slice(mid), { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      logger.error({ error }, 'WalletCommands: Error in /wallet_dashboard');
      await bot.sendMessage(chatId, 'Error fetching wallet dashboard.');
    }
  });

  // /wallet_detail {address} — Deep dive on a single wallet: trades, clusters, performance
  bot.onText(/\/wallet_detail\s+([1-9A-HJ-NP-Za-km-z]{32,44})/, async (msg, match) => {
    if (msg.chat.id.toString() !== chatId) return;
    const address = match?.[1];
    if (!address) {
      await bot.sendMessage(chatId, 'Usage: /wallet\\_detail <solana\\_address>');
      return;
    }

    try {
      const addr = `${address.slice(0, 6)}...${address.slice(-4)}`;
      let message = `*WALLET DETAIL: \`${addr}\`*\n\n`;
      let found = false;

      // ── Check Alpha Wallets ──
      const allAlpha = await Database.getAllAlphaWallets();
      const alphaWallet = allAlpha.find((w: any) => w.address === address);

      if (alphaWallet) {
        found = true;
        const w = alphaWallet;
        const wr = ((w.win_rate || 0) * 100).toFixed(0);
        const ev = w.avg_roi != null ? (w.avg_roi >= 0 ? '+' : '') + (w.avg_roi * 100).toFixed(1) + '%' : 'n/a';
        const daysSinceAdded = ((Date.now() - new Date(w.added_at).getTime()) / 86400000).toFixed(0);
        const label = w.label ? ` (${w.label})` : '';

        message += `*Alpha Wallet*${label}\n`;
        message += `Status: ${w.status} | Weight: ${(w.signal_weight || 0).toFixed(2)}x\n`;
        message += `Source: ${w.source || 'MANUAL'} | Added: ${daysSinceAdded}d ago\n`;
        message += `Suspensions: ${w.suspension_count || 0}\n\n`;

        message += `*Performance*\n`;
        message += `Total trades: ${w.total_trades || 0}\n`;
        message += `Wins: ${w.wins || 0} | Losses: ${w.losses || 0}\n`;
        message += `Win rate: ${wr}% | Avg EV: ${ev}\n\n`;

        // Recent trades
        const trades = await Database.getAlphaWalletTrades(w.id, 10);
        if (trades.length > 0) {
          message += `*Recent Trades (${trades.length})*\n`;
          let buyCount = 0, sellCount = 0;
          for (const t of trades) {
            if (t.trade_type === 'BUY') buyCount++;
            else sellCount++;
            const ticker = t.token_ticker || t.token_address?.slice(0, 6) || '???';
            const solAmt = (t.sol_amount || 0).toFixed(2);
            const roiStr = t.roi != null ? ` → ${(t.roi * 100).toFixed(0)}%` : '';
            const time = new Date(t.timestamp).toISOString().slice(5, 16).replace('T', ' ');
            message += `  ${t.trade_type} ${ticker} ${solAmt}◎${roiStr} (${time})\n`;
          }
          message += `  _Buys: ${buyCount} | Sells: ${sellCount}_\n\n`;
        }
      }

      // ── Check Engine Wallets ──
      const engineWallet = await walletEngine.getWalletByAddress(address);

      if (engineWallet) {
        found = true;
        const ew = engineWallet;
        const wr = ((ew.signalWinRate || 0) * 100).toFixed(0);
        const ev = (ew.signalEv >= 0 ? '+' : '') + (ew.signalEv || 0).toFixed(1) + '%';
        const nLabel = (ew as any).nansenLabel ? ` (${(ew as any).nansenLabel})` : '';
        const daysSinceAdded = ((Date.now() - new Date(ew.addedAt).getTime()) / 86400000).toFixed(0);

        message += `*Engine Wallet*${nLabel}\n`;
        message += `Status: ${ew.status} | Weight: ${ew.weight.toFixed(1)}x\n`;
        message += `Source: ${ew.source} | Added: ${daysSinceAdded}d ago\n`;
        message += `Streak: ${ew.currentStreak}\n\n`;

        message += `*Signal Performance*\n`;
        message += `Total signals: ${ew.totalSignals}\n`;
        message += `Win rate: ${wr}% | EV: ${ev}\n`;

        if (ew.observedTrades > 0) {
          const obsWr = ((ew.observedWinRate || 0) * 100).toFixed(0);
          const obsEv = (ew.observedEv >= 0 ? '+' : '') + (ew.observedEv || 0).toFixed(1) + '%';
          message += `Observed: ${ew.observedTrades} trades | ${obsWr}% WR | ${obsEv} EV\n`;
        }

        // Nansen metadata if available
        const nansenPnl = (ew as any).nansenPnl30d || (ew as any).nansen_pnl_30d;
        const nansenWr = (ew as any).nansenWinRate || (ew as any).nansen_win_rate;
        if (nansenPnl != null) {
          message += `\n*Nansen Data*\n`;
          message += `30d PnL: $${nansenPnl.toFixed(0)} | WR: ${((nansenWr || 0) * 100).toFixed(0)}%\n`;
          const avgBuy = (ew as any).nansenAvgBuySize || (ew as any).nansen_avg_buy_size;
          if (avgBuy) message += `Avg buy: $${avgBuy.toFixed(0)}\n`;
        }

        message += '\n';

        // Recent signals
        const signals = await Database.getEngineSignalsForWallet(ew.id, 14);
        if (signals.length > 0) {
          message += `*Recent Signals (${signals.length})*\n`;
          for (const s of signals.slice(0, 8)) {
            const token = s.token_ticker || s.token_address?.slice(0, 6) || '???';
            const outcome = s.outcome || 'PENDING';
            const roi = s.roi != null ? ` ${(s.roi * 100).toFixed(0)}%` : '';
            const time = new Date(s.created_at).toISOString().slice(5, 16).replace('T', ' ');
            message += `  ${token} [${outcome}]${roi} (${time})\n`;
          }
          message += '\n';
        }

        // Observations
        const observations = await Database.getCompletedObservationsForWallet(ew.id);
        if (observations.length > 0) {
          const obsWins = observations.filter((o: any) => o.outcome === 'WIN').length;
          const obsLosses = observations.filter((o: any) => o.outcome === 'LOSS').length;
          message += `*Observations: ${obsWins}W/${obsLosses}L (${observations.length} total)*\n\n`;
        }
      }

      // ── Cluster Data ──
      const [outgoing, incoming] = await Promise.all([
        Database.getWalletClusterDestinations(address),
        Database.getClusterSourcesForDestination(address),
      ]);

      if (outgoing.length > 0 || incoming.length > 0) {
        message += `*Cluster / Transfers*\n`;
        if (outgoing.length > 0) {
          message += `Outgoing (${outgoing.length}):\n`;
          for (const c of outgoing.slice(0, 5)) {
            const dest = `${c.destination_address.slice(0, 6)}...${c.destination_address.slice(-4)}`;
            message += `  → \`${dest}\` ×${c.transfer_count}\n`;
          }
          if (outgoing.length > 5) message += `  _...+${outgoing.length - 5} more_\n`;
        }
        if (incoming.length > 0) {
          message += `Incoming (${incoming.length}):\n`;
          for (const c of incoming.slice(0, 5)) {
            const src = `${c.source_address.slice(0, 6)}...${c.source_address.slice(-4)}`;
            const label = c.label ? ` (${c.label})` : '';
            const status = c.status ? ` [${c.status}]` : '';
            message += `  ← \`${src}\`${label}${status} ×${c.transfer_count}\n`;
          }
          if (incoming.length > 5) message += `  _...+${incoming.length - 5} more_\n`;
        }
      }

      if (!found) {
        await bot.sendMessage(chatId, `Wallet \`${addr}\` not found in either pipeline.`, { parse_mode: 'Markdown' });
        return;
      }

      // Split if too long
      if (message.length > 4000) {
        const mid = message.lastIndexOf('\n\n', 2000);
        await bot.sendMessage(chatId, message.slice(0, mid), { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, message.slice(mid), { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      logger.error({ error }, 'WalletCommands: Error in /wallet_detail');
      await bot.sendMessage(chatId, 'Error fetching wallet detail.');
    }
  });

  logger.info('WalletCommands: Registered wallet engine commands');
}
