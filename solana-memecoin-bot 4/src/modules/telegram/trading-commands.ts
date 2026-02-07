// ===========================================
// TELEGRAM TRADING COMMANDS
// Extends the main telegram bot with trading functionality
// ===========================================

import TelegramBot, { CallbackQuery, Message } from 'node-telegram-bot-api';
import { logger } from '../../utils/logger.js';
import { pool } from '../../utils/database.js';
import { botWallet } from '../trading/wallet.js';
import { tradeExecutor, SignalCategory } from '../trading/trade-executor.js';
import { positionManager } from '../trading/position-manager.js';
import { createTelegramInlineKeyboard } from '../../utils/trade-links.js';
import { thresholdOptimizer } from '../performance/threshold-optimizer.js';

// ============ TYPES ============

export interface PendingConfirmation {
  id: string;
  signalId: string;
  tokenAddress: string;
  tokenTicker: string;
  tokenName: string;
  signalType: string;
  signalCategory: SignalCategory;
  score: number;
  currentPrice: number;
  suggestedSolAmount: number;
  expiresAt: Date;
  messageId?: number;
}

// ============ COMMAND MENU ============

export const BOT_COMMANDS: TelegramBot.BotCommand[] = [
  // Signal & Performance
  { command: 'status', description: 'Bot status & strategy info' },
  { command: 'stats', description: 'Signal performance dashboard' },
  { command: 'recent', description: 'Recent signals & outcomes' },
  { command: 'tierperf', description: 'Win rate by signal tier' },

  // Discovery & Analysis
  { command: 'funnel', description: 'Token filtering funnel stats' },
  { command: 'sources', description: 'Discovery source health' },
  { command: 'safety', description: 'Safety check: /safety <token>' },
  { command: 'thresholds', description: 'View scoring thresholds' },

  // Wallet Tracking
  { command: 'addwallet', description: 'Track wallet: /addwallet <address>' },
  { command: 'wallets', description: 'List tracked wallets' },
  { command: 'removewallet', description: 'Remove tracked wallet' },

  // System
  { command: 'pause', description: 'Pause signal scanning' },
  { command: 'resume', description: 'Resume signal scanning' },
  { command: 'help', description: 'Show all commands' },
];

// ============ TRADING COMMANDS CLASS ============

export class TradingCommands {
  private bot: TelegramBot;
  private chatId: string;
  private pendingConfirmations: Map<string, PendingConfirmation> = new Map();

  constructor(bot: TelegramBot, chatId: string) {
    this.bot = bot;
    this.chatId = chatId;
  }

  /**
   * Initialize trading commands
   */
  async initialize(): Promise<void> {
    // Set up bot commands menu
    try {
      await this.bot.setMyCommands(BOT_COMMANDS);
      logger.info('Bot command menu set up successfully');
    } catch (error) {
      logger.error({ error }, 'Failed to set bot commands');
    }

    // Register command handlers
    this.registerCommands();

    // Register callback query handler for confirmation buttons
    this.registerCallbackHandler();

    // Start confirmation expiry checker
    this.startConfirmationChecker();

    logger.info('Trading commands initialized');
  }

  /**
   * Register all command handlers
   */
  private registerCommands(): void {
    // ============ POSITION COMMANDS ============

    // /positions - View all open positions
    this.bot.onText(/\/positions/, async (msg) => {
      await this.handlePositions(msg.chat.id);
    });

    // /close <token> - Close a specific position
    this.bot.onText(/\/close\s+(\S+)/, async (msg, match) => {
      const token = match?.[1];
      if (token && token !== 'all') {
        await this.handleClosePosition(msg.chat.id, token);
      }
    });

    // /close_all - Emergency close all
    this.bot.onText(/\/close_all/, async (msg) => {
      await this.handleCloseAll(msg.chat.id);
    });

    // ============ SETTINGS COMMANDS ============

    // /settings - View settings
    this.bot.onText(/\/settings/, async (msg) => {
      await this.handleSettings(msg.chat.id);
    });

    // /set_max_trade <amount>
    this.bot.onText(/\/set_max_trade\s+(\d+\.?\d*)/, async (msg, match) => {
      const amount = parseFloat(match?.[1] || '10');
      await this.handleSetMaxTrade(msg.chat.id, amount);
    });

    // /set_slippage <percent>
    this.bot.onText(/\/set_slippage\s+(\d+)/, async (msg, match) => {
      const percent = parseInt(match?.[1] || '10');
      await this.handleSetSlippage(msg.chat.id, percent);
    });

    // /toggle_autobuys
    this.bot.onText(/\/toggle_autobuys/, async (msg) => {
      await this.handleToggleAutobuys(msg.chat.id);
    });

    // /toggle_autosells
    this.bot.onText(/\/toggle_autosells/, async (msg) => {
      await this.handleToggleAutosells(msg.chat.id);
    });

    // ============ BLACKLIST COMMANDS ============

    // /blacklist [token]
    this.bot.onText(/\/blacklist(?:\s+(\S+))?/, async (msg, match) => {
      const token = match?.[1];
      if (token) {
        await this.handleAddBlacklist(msg.chat.id, token);
      } else {
        await this.handleViewBlacklist(msg.chat.id);
      }
    });

    // /unblacklist <token>
    this.bot.onText(/\/unblacklist\s+(\S+)/, async (msg, match) => {
      const token = match?.[1];
      if (token) {
        await this.handleRemoveBlacklist(msg.chat.id, token);
      }
    });

    // ============ WALLET COMMANDS ============

    // /wallet
    this.bot.onText(/\/wallet/, async (msg) => {
      await this.handleWallet(msg.chat.id);
    });

    // /withdraw <amount> <address>
    this.bot.onText(/\/withdraw\s+(\d+\.?\d*)\s+(\S+)/, async (msg, match) => {
      const amount = parseFloat(match?.[1] || '0');
      const address = match?.[2];
      if (amount > 0 && address) {
        await this.handleWithdraw(msg.chat.id, amount, address);
      }
    });

    // ============ STATS COMMANDS ============

    // /stats
    this.bot.onText(/\/stats/, async (msg) => {
      await this.handleStats(msg.chat.id);
    });

    // /history
    this.bot.onText(/\/history/, async (msg) => {
      await this.handleHistory(msg.chat.id);
    });

    // /thresholds - View current signal thresholds
    this.bot.onText(/\/thresholds/, async (msg) => {
      await this.handleThresholds(msg.chat.id);
    });

    // /reset_thresholds - Reset to defaults
    this.bot.onText(/\/reset_thresholds/, async (msg) => {
      await this.handleResetThresholds(msg.chat.id);
    });

    // ============ SYSTEM COMMANDS ============

    // /pause
    this.bot.onText(/\/pause/, async (msg) => {
      await this.handlePause(msg.chat.id);
    });

    // /resume
    this.bot.onText(/\/resume/, async (msg) => {
      await this.handleResume(msg.chat.id);
    });
  }

  /**
   * Register callback query handler for inline buttons
   */
  private registerCallbackHandler(): void {
    this.bot.on('callback_query', async (query: CallbackQuery) => {
      if (!query.data) return;

      const [action, ...params] = query.data.split(':');

      try {
        switch (action) {
          case 'confirm_buy':
            await this.handleConfirmBuy(query, params[0]);
            break;
          case 'skip_buy':
            await this.handleSkipBuy(query, params[0]);
            break;
          case 'close_position':
            await this.handleClosePositionCallback(query, params[0]);
            break;
          default:
            // Not a trading callback, ignore
            break;
        }
      } catch (error) {
        logger.error({ error, action }, 'Callback query handler error');
        await this.bot.answerCallbackQuery(query.id, { text: 'Error processing request' });
      }
    });
  }

  // ============ COMMAND HANDLERS ============

  private async handlePositions(chatId: number): Promise<void> {
    try {
      const summary = await positionManager.getPositionSummary();

      if (summary.totalPositions === 0) {
        await this.bot.sendMessage(chatId, 'No open positions.');
        return;
      }

      let message = `*OPEN POSITIONS* (${summary.totalPositions})\n\n`;
      message += `Total P&L: ${summary.totalPnlPercent >= 0 ? '+' : ''}${summary.totalPnlPercent.toFixed(2)}%\n`;
      message += `Est. SOL: ${summary.totalPnlSol >= 0 ? '+' : ''}${summary.totalPnlSol.toFixed(4)} SOL\n\n`;

      for (const pos of summary.positions) {
        const emoji = pos.pnlPercent >= 0 ? '🟢' : '🔴';
        const pnlStr = pos.pnlPercent >= 0 ? `+${pos.pnlPercent.toFixed(1)}%` : `${pos.pnlPercent.toFixed(1)}%`;
        message += `${emoji} *${pos.tokenTicker}*: ${pnlStr} (${pos.holdTimeHours.toFixed(1)}h)\n`;
      }

      message += '\nUse `/close <ticker>` to close a position';

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ error }, 'Failed to get positions');
      await this.bot.sendMessage(chatId, 'Failed to get positions');
    }
  }

  private async handleClosePosition(chatId: number, tokenIdentifier: string): Promise<void> {
    try {
      // Find position by ticker or address
      const result = await pool.query(
        `SELECT token_address, token_ticker FROM positions
         WHERE status = 'OPEN' AND (token_ticker ILIKE $1 OR token_address = $1)`,
        [tokenIdentifier]
      );

      if (result.rows.length === 0) {
        await this.bot.sendMessage(chatId, `No open position found for: ${tokenIdentifier}`);
        return;
      }

      const { token_address, token_ticker } = result.rows[0];

      await this.bot.sendMessage(chatId, `Closing position: ${token_ticker}...`);

      const success = await positionManager.closePosition(token_address, 'MANUAL_CLOSE');

      if (success) {
        await this.bot.sendMessage(chatId, `Position closed: ${token_ticker}`);
      } else {
        await this.bot.sendMessage(chatId, `Failed to close position: ${token_ticker}`);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to close position');
      await this.bot.sendMessage(chatId, 'Failed to close position');
    }
  }

  private async handleCloseAll(chatId: number): Promise<void> {
    try {
      await this.bot.sendMessage(chatId, 'Closing all positions...');

      const result = await tradeExecutor.closeAllPositions();

      await this.bot.sendMessage(
        chatId,
        `Closed ${result.closed} positions, ${result.failed} failed`
      );
    } catch (error) {
      logger.error({ error }, 'Failed to close all positions');
      await this.bot.sendMessage(chatId, 'Failed to close all positions');
    }
  }

  private async handleSettings(chatId: number): Promise<void> {
    try {
      const settings = await pool.query('SELECT key, value FROM bot_settings ORDER BY key');

      let message = '*BOT SETTINGS*\n\n';

      if (settings.rows.length === 0) {
        message += 'No settings configured yet.\n';
      } else {
        for (const row of settings.rows) {
          const key = row.key.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase());
          message += `${key}: \`${row.value}\`\n`;
        }
      }

      message += '\n*Commands:*\n';
      message += '/set\\_max\\_trade <sol> - Max trade size\n';
      message += '/set\\_slippage <percent> - Slippage %\n';
      message += '/toggle\\_autobuys - Toggle auto-buy\n';
      message += '/toggle\\_autosells - Toggle auto-sell';

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ error }, 'Failed to get settings');
      if (String(error).includes('does not exist') || String(error).includes('bot_settings')) {
        await this.bot.sendMessage(chatId, 'Trading tables not set up. Run: npm run db:migrate:trading');
      } else {
        await this.bot.sendMessage(chatId, 'Failed to get settings');
      }
    }
  }

  private async handleSetMaxTrade(chatId: number, amount: number): Promise<void> {
    if (amount < 0.01 || amount > 100) {
      await this.bot.sendMessage(chatId, 'Max trade must be between 0.01 and 100 SOL');
      return;
    }

    try {
      await pool.query(
        `INSERT INTO bot_settings (key, value) VALUES ('max_single_trade', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [amount.toString()]
      );
      await this.bot.sendMessage(chatId, `Max trade set to: ${amount} SOL`);
    } catch (error) {
      await this.bot.sendMessage(chatId, 'Failed to update setting');
    }
  }

  private async handleSetSlippage(chatId: number, percent: number): Promise<void> {
    if (percent < 1 || percent > 50) {
      await this.bot.sendMessage(chatId, 'Slippage must be between 1% and 50%');
      return;
    }

    try {
      const bps = percent * 100;
      await pool.query(
        `INSERT INTO bot_settings (key, value) VALUES ('default_slippage', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [bps.toString()]
      );
      await this.bot.sendMessage(chatId, `Slippage set to: ${percent}%`);
    } catch (error) {
      await this.bot.sendMessage(chatId, 'Failed to update setting');
    }
  }

  private async handleToggleAutobuys(chatId: number): Promise<void> {
    try {
      const result = await pool.query(
        `UPDATE bot_settings SET value = CASE WHEN value = 'true' THEN 'false' ELSE 'true' END
         WHERE key = 'auto_buy_enabled' RETURNING value`
      );
      const newValue = result.rows[0]?.value || 'true';
      await this.bot.sendMessage(chatId, `Auto-buys: ${newValue === 'true' ? 'ENABLED' : 'DISABLED'}`);
    } catch (error) {
      await this.bot.sendMessage(chatId, 'Failed to toggle auto-buys');
    }
  }

  private async handleToggleAutosells(chatId: number): Promise<void> {
    try {
      const current = tradeExecutor.isAutoSellEnabled();
      tradeExecutor.setAutoSellEnabled(!current);
      await this.bot.sendMessage(chatId, `Auto-sells: ${!current ? 'ENABLED' : 'DISABLED'}`);
    } catch (error) {
      await this.bot.sendMessage(chatId, 'Failed to toggle auto-sells');
    }
  }

  private async handleViewBlacklist(chatId: number): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT token_address, reason, added_at FROM token_blacklist ORDER BY added_at DESC LIMIT 20`
      );

      if (result.rows.length === 0) {
        await this.bot.sendMessage(chatId, 'Blacklist is empty.');
        return;
      }

      let message = '*BLACKLISTED TOKENS*\n\n';
      for (const row of result.rows) {
        message += `\`${row.token_address.slice(0, 8)}...\`\n`;
        if (row.reason) message += `  Reason: ${row.reason}\n`;
      }

      message += '\nUse `/blacklist <address>` to add';
      message += '\nUse `/unblacklist <address>` to remove';

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      if (String(error).includes('does not exist') || String(error).includes('token_blacklist')) {
        await this.bot.sendMessage(chatId, 'Trading tables not set up. Run: npm run db:migrate:trading');
      } else {
        await this.bot.sendMessage(chatId, 'Failed to get blacklist');
      }
    }
  }

  private async handleAddBlacklist(chatId: number, tokenAddress: string): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO token_blacklist (token_address, reason, added_by)
         VALUES ($1, 'Manual blacklist', 'telegram')
         ON CONFLICT (token_address) DO NOTHING`,
        [tokenAddress]
      );
      await this.bot.sendMessage(chatId, `Added to blacklist: \`${tokenAddress.slice(0, 8)}...\``, { parse_mode: 'Markdown' });
    } catch (error) {
      await this.bot.sendMessage(chatId, 'Failed to add to blacklist');
    }
  }

  private async handleRemoveBlacklist(chatId: number, tokenAddress: string): Promise<void> {
    try {
      const result = await pool.query(
        `DELETE FROM token_blacklist WHERE token_address = $1 RETURNING token_address`,
        [tokenAddress]
      );
      if (result.rowCount && result.rowCount > 0) {
        await this.bot.sendMessage(chatId, `Removed from blacklist: \`${tokenAddress.slice(0, 8)}...\``, { parse_mode: 'Markdown' });
      } else {
        await this.bot.sendMessage(chatId, 'Token not found in blacklist');
      }
    } catch (error) {
      await this.bot.sendMessage(chatId, 'Failed to remove from blacklist');
    }
  }

  private async handleWallet(chatId: number): Promise<void> {
    try {
      if (!botWallet.isReady()) {
        await this.bot.sendMessage(chatId, 'Wallet not initialized. Set BOT_WALLET_PRIVATE_KEY in .env');
        return;
      }

      const info = await botWallet.getWalletInfo();

      let message = '*WALLET*\n\n';
      message += `Address: \`${info.address}\`\n\n`;
      message += `SOL: ${info.solBalance.sol.toFixed(4)} (~$${info.solBalance.usdValue.toFixed(2)})\n\n`;

      if (info.tokenBalances.length > 0) {
        message += '*Token Balances:*\n';
        for (const token of info.tokenBalances.slice(0, 10)) {
          message += `\`${token.mint.slice(0, 8)}...\`: ${token.balance.toFixed(2)}\n`;
        }
      }

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ error }, 'Failed to get wallet info');
      await this.bot.sendMessage(chatId, 'Failed to get wallet info');
    }
  }

  private async handleWithdraw(chatId: number, amount: number, address: string): Promise<void> {
    try {
      if (!botWallet.isReady()) {
        await this.bot.sendMessage(chatId, 'Wallet not initialized');
        return;
      }

      // Validate address (basic check)
      if (address.length < 32 || address.length > 44) {
        await this.bot.sendMessage(chatId, 'Invalid Solana address');
        return;
      }

      await this.bot.sendMessage(chatId, `Withdrawing ${amount} SOL to ${address.slice(0, 8)}...`);

      const signature = await botWallet.withdrawSol(amount, address);

      await this.bot.sendMessage(
        chatId,
        `Withdrawal complete!\nAmount: ${amount} SOL\nSignature: \`${signature}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      logger.error({ error }, 'Withdrawal failed');
      await this.bot.sendMessage(chatId, `Withdrawal failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleStats(chatId: number): Promise<void> {
    try {
      // Get trading stats
      const stats = await pool.query(`
        SELECT
          COUNT(*) as total_trades,
          COUNT(*) FILTER (WHERE trade_type = 'BUY') as buys,
          COUNT(*) FILTER (WHERE trade_type = 'SELL') as sells,
          SUM(CASE WHEN trade_type = 'BUY' THEN sol_amount ELSE 0 END) as total_spent,
          SUM(CASE WHEN trade_type = 'SELL' THEN sol_amount ELSE 0 END) as total_received
        FROM trade_history
        WHERE executed_at > NOW() - INTERVAL '30 days'
      `);

      const closedPositions = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE realized_pnl > 0) as wins,
          COUNT(*) FILTER (WHERE realized_pnl <= 0) as losses,
          SUM(realized_pnl) as total_pnl
        FROM positions
        WHERE status = 'CLOSED' AND closed_at > NOW() - INTERVAL '30 days'
      `);

      const s = stats.rows[0];
      const p = closedPositions.rows[0];

      const winRate = p.total > 0 ? (p.wins / p.total * 100).toFixed(1) : '0.0';

      let message = '*TRADING STATS (30 Days)*\n\n';
      message += `Total Trades: ${s.total_trades}\n`;
      message += `Buys: ${s.buys} | Sells: ${s.sells}\n\n`;
      message += `SOL Spent: ${parseFloat(s.total_spent || 0).toFixed(4)}\n`;
      message += `SOL Received: ${parseFloat(s.total_received || 0).toFixed(4)}\n\n`;
      message += `Closed Positions: ${p.total}\n`;
      message += `Win Rate: ${winRate}% (${p.wins}W / ${p.losses}L)\n`;
      message += `Total P&L: ${parseFloat(p.total_pnl || 0).toFixed(4)} SOL`;

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ error }, 'Failed to get stats');
      // Check if it's a missing table error
      if (String(error).includes('does not exist') || String(error).includes('trade_history')) {
        await this.bot.sendMessage(chatId, 'Trading tables not set up. Run: npm run db:migrate:trading');
      } else {
        await this.bot.sendMessage(chatId, 'Failed to get stats');
      }
    }
  }

  private async handleHistory(chatId: number): Promise<void> {
    try {
      const result = await pool.query(`
        SELECT token_ticker, trade_type, sol_amount, token_amount, reason, executed_at
        FROM trade_history
        ORDER BY executed_at DESC
        LIMIT 15
      `);

      if (result.rows.length === 0) {
        await this.bot.sendMessage(chatId, 'No trade history yet.');
        return;
      }

      let message = '*RECENT TRADES*\n\n';

      for (const row of result.rows) {
        const emoji = row.trade_type === 'BUY' ? '🟢' : '🔴';
        const time = new Date(row.executed_at).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
        message += `${emoji} ${row.trade_type} ${row.token_ticker || 'Unknown'}\n`;
        message += `   ${parseFloat(row.sol_amount).toFixed(4)} SOL\n`;
        if (row.reason) message += `   ${row.reason}\n`;
        message += `   ${time}\n\n`;
      }

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ error }, 'Failed to get history');
      if (String(error).includes('does not exist') || String(error).includes('trade_history')) {
        await this.bot.sendMessage(chatId, 'Trading tables not set up. Run: npm run db:migrate:trading');
      } else {
        await this.bot.sendMessage(chatId, 'Failed to get history');
      }
    }
  }

  private async handleThresholds(chatId: number): Promise<void> {
    try {
      const current = thresholdOptimizer.getCurrentThresholds();
      const defaults = thresholdOptimizer.getDefaultThresholds();

      let message = '*SIGNAL THRESHOLDS*\n\n';
      message += '*Current Values:*\n';
      message += `• Min Momentum Score: ${current.minMomentumScore}`;
      if (current.minMomentumScore !== defaults.minMomentumScore) {
        message += ` (default: ${defaults.minMomentumScore})`;
      }
      message += '\n';

      message += `• Min OnChain Score: ${current.minOnChainScore}`;
      if (current.minOnChainScore !== defaults.minOnChainScore) {
        message += ` (default: ${defaults.minOnChainScore})`;
      }
      message += '\n';

      message += `• Min Safety Score: ${current.minSafetyScore}`;
      if (current.minSafetyScore !== defaults.minSafetyScore) {
        message += ` (default: ${defaults.minSafetyScore})`;
      }
      message += '\n';

      message += `• Max Bundle Risk: ${current.maxBundleRiskScore}`;
      if (current.maxBundleRiskScore !== defaults.maxBundleRiskScore) {
        message += ` (default: ${defaults.maxBundleRiskScore})`;
      }
      message += '\n';

      message += `• Min Liquidity: $${current.minLiquidity.toLocaleString()}`;
      if (current.minLiquidity !== defaults.minLiquidity) {
        message += ` (default: $${defaults.minLiquidity.toLocaleString()})`;
      }
      message += '\n';

      message += `• Max Top10 Concentration: ${current.maxTop10Concentration}%`;
      if (current.maxTop10Concentration !== defaults.maxTop10Concentration) {
        message += ` (default: ${defaults.maxTop10Concentration}%)`;
      }
      message += '\n\n';

      // Check if any threshold differs from default
      const hasChanges =
        current.minMomentumScore !== defaults.minMomentumScore ||
        current.minOnChainScore !== defaults.minOnChainScore ||
        current.minSafetyScore !== defaults.minSafetyScore ||
        current.maxBundleRiskScore !== defaults.maxBundleRiskScore ||
        current.minLiquidity !== defaults.minLiquidity ||
        current.maxTop10Concentration !== defaults.maxTop10Concentration;

      if (hasChanges) {
        message += '⚠️ Thresholds have been modified from defaults.\n';
        message += 'Use `/reset_thresholds` to restore defaults.\n\n';
      } else {
        message += '✅ Using default thresholds.\n\n';
      }

      message += '_Higher min scores = stricter filtering (fewer signals)_\n';
      message += '_Lower max scores = stricter filtering (fewer signals)_';

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ error }, 'Failed to get thresholds');
      await this.bot.sendMessage(chatId, 'Failed to get thresholds');
    }
  }

  private async handleResetThresholds(chatId: number): Promise<void> {
    try {
      const defaults = await thresholdOptimizer.resetThresholds();

      let message = '✅ *THRESHOLDS RESET TO DEFAULTS*\n\n';
      message += `• Min Momentum Score: ${defaults.minMomentumScore}\n`;
      message += `• Min OnChain Score: ${defaults.minOnChainScore}\n`;
      message += `• Min Safety Score: ${defaults.minSafetyScore}\n`;
      message += `• Max Bundle Risk: ${defaults.maxBundleRiskScore}\n`;
      message += `• Min Liquidity: $${defaults.minLiquidity.toLocaleString()}\n`;
      message += `• Max Top10 Concentration: ${defaults.maxTop10Concentration}%\n\n`;
      message += '_Signal filtering restored to original settings._';

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error({ error }, 'Failed to reset thresholds');
      await this.bot.sendMessage(chatId, 'Failed to reset thresholds');
    }
  }

  private async handlePause(chatId: number): Promise<void> {
    tradeExecutor.setTradingEnabled(false);
    await this.bot.sendMessage(chatId, 'Trading PAUSED. Use /resume to continue.');
  }

  private async handleResume(chatId: number): Promise<void> {
    tradeExecutor.setTradingEnabled(true);
    await this.bot.sendMessage(chatId, 'Trading RESUMED.');
  }

  // ============ CONFIRMATION HANDLING ============

  /**
   * Send a confirmation request for a signal
   */
  async sendConfirmationRequest(confirmation: PendingConfirmation): Promise<number | undefined> {
    const timeRemaining = Math.max(0, Math.floor((confirmation.expiresAt.getTime() - Date.now()) / 1000));

    const message = this.formatConfirmationMessage(confirmation, timeRemaining);

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ BUY', callback_data: `confirm_buy:${confirmation.id}` },
          { text: '❌ SKIP', callback_data: `skip_buy:${confirmation.id}` },
        ],
      ],
    };

    try {
      const sent = await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });

      // Store the confirmation
      confirmation.messageId = sent.message_id;
      this.pendingConfirmations.set(confirmation.id, confirmation);

      // Save to database
      await pool.query(
        `INSERT INTO pending_confirmations (id, signal_id, token_address, token_ticker, token_name, signal_type, signal_category, score, current_price, suggested_sol_amount, telegram_message_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          confirmation.id,
          confirmation.signalId,
          confirmation.tokenAddress,
          confirmation.tokenTicker,
          confirmation.tokenName,
          confirmation.signalType,
          confirmation.signalCategory,
          confirmation.score,
          confirmation.currentPrice,
          confirmation.suggestedSolAmount,
          sent.message_id.toString(),
          confirmation.expiresAt,
        ]
      );

      return sent.message_id;
    } catch (error) {
      logger.error({ error }, 'Failed to send confirmation request');
      return undefined;
    }
  }

  private formatConfirmationMessage(confirmation: PendingConfirmation, timeRemaining: number): string {
    const minutes = Math.floor(timeRemaining / 60);
    const seconds = timeRemaining % 60;

    return `
*CONFIRM TRADE?*

*${confirmation.tokenName}* ($${confirmation.tokenTicker})
\`${confirmation.tokenAddress}\`

Score: ${confirmation.score}
Category: ${confirmation.signalCategory}
Price: $${confirmation.currentPrice.toFixed(8)}
Amount: ${confirmation.suggestedSolAmount.toFixed(3)} SOL

Expires in: ${minutes}:${seconds.toString().padStart(2, '0')}

Tap BUY to execute or SKIP to pass.
`.trim();
  }

  private async handleConfirmBuy(query: CallbackQuery, confirmationId: string): Promise<void> {
    const confirmation = this.pendingConfirmations.get(confirmationId);

    if (!confirmation) {
      await this.bot.answerCallbackQuery(query.id, { text: 'Confirmation expired or not found' });
      return;
    }

    if (Date.now() > confirmation.expiresAt.getTime()) {
      await this.bot.answerCallbackQuery(query.id, { text: 'Confirmation expired' });
      this.pendingConfirmations.delete(confirmationId);
      await this.updateConfirmationStatus(confirmationId, 'EXPIRED');
      return;
    }

    await this.bot.answerCallbackQuery(query.id, { text: 'Executing trade...' });

    // Execute the trade
    const result = await tradeExecutor.executeBuy({
      tokenAddress: confirmation.tokenAddress,
      tokenTicker: confirmation.tokenTicker,
      tokenName: confirmation.tokenName,
      signalId: confirmation.signalId,
      signalType: confirmation.signalType as any,
      signalCategory: confirmation.signalCategory,
      score: confirmation.score,
      currentPrice: confirmation.currentPrice,
      requestedSolAmount: confirmation.suggestedSolAmount,
    });

    // Update message
    if (query.message) {
      const statusMessage = result.success
        ? `✅ *TRADE EXECUTED*\n\nBought ${result.tokensReceived.toFixed(2)} ${confirmation.tokenTicker}\nSpent: ${result.solSpent.toFixed(4)} SOL\nSignature: \`${result.signature?.slice(0, 16)}...\``
        : `❌ *TRADE FAILED*\n\n${result.error}`;

      await this.bot.editMessageText(statusMessage, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
      });
    }

    this.pendingConfirmations.delete(confirmationId);
    await this.updateConfirmationStatus(confirmationId, 'CONFIRMED');
  }

  private async handleSkipBuy(query: CallbackQuery, confirmationId: string): Promise<void> {
    const confirmation = this.pendingConfirmations.get(confirmationId);

    await this.bot.answerCallbackQuery(query.id, { text: 'Trade skipped' });

    if (query.message) {
      await this.bot.editMessageText(
        `⏭️ *SKIPPED*\n\n${confirmation?.tokenTicker || 'Token'} - Trade skipped`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
        }
      );
    }

    this.pendingConfirmations.delete(confirmationId);
    await this.updateConfirmationStatus(confirmationId, 'SKIPPED');
  }

  private async handleClosePositionCallback(query: CallbackQuery, tokenAddress: string): Promise<void> {
    await this.bot.answerCallbackQuery(query.id, { text: 'Closing position...' });

    const success = await positionManager.closePosition(tokenAddress, 'MANUAL_CLOSE_BUTTON');

    if (query.message) {
      const message = success ? '✅ Position closed' : '❌ Failed to close position';
      await this.bot.sendMessage(query.message.chat.id, message);
    }
  }

  private async updateConfirmationStatus(id: string, status: string): Promise<void> {
    try {
      await pool.query(
        `UPDATE pending_confirmations SET status = $2, resolved_at = NOW() WHERE id = $1`,
        [id, status]
      );
    } catch (error) {
      logger.error({ error }, 'Failed to update confirmation status');
    }
  }

  /**
   * Check for expired confirmations
   */
  private startConfirmationChecker(): void {
    setInterval(async () => {
      const now = Date.now();

      for (const [id, confirmation] of this.pendingConfirmations) {
        if (now > confirmation.expiresAt.getTime()) {
          // Expire the confirmation
          if (confirmation.messageId) {
            try {
              await this.bot.editMessageText(
                `⏰ *EXPIRED*\n\n${confirmation.tokenTicker} - Confirmation timed out`,
                {
                  chat_id: parseInt(this.chatId),
                  message_id: confirmation.messageId,
                  parse_mode: 'Markdown',
                }
              );
            } catch (error) {
              // Message may already be edited
            }
          }

          this.pendingConfirmations.delete(id);
          await this.updateConfirmationStatus(id, 'EXPIRED');
        }
      }
    }, 5000); // Check every 5 seconds
  }
}

export default TradingCommands;
