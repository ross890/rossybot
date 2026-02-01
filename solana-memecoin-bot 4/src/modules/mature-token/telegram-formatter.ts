// ===========================================
// MATURE TOKEN TELEGRAM FORMATTER
// Telegram message formatting for mature token signals
// ===========================================

import TelegramBot from 'node-telegram-bot-api';
import { appConfig } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { createTelegramInlineKeyboard, formatLinksAsMarkdown } from '../../utils/trade-links.js';
import {
  MatureTokenSignal,
  MatureTokenExitSignal,
  MatureTokenWatchlist,
  MatureSignalType,
  AccumulationPattern,
  VolumeTrend,
  ExitRecommendation,
} from './types.js';

// ============ CLASS ============

export class MatureTokenTelegramFormatter {
  private bot: TelegramBot | null = null;
  private chatId: string;

  constructor() {
    this.chatId = appConfig.telegramChatId;
  }

  /**
   * Initialize with existing bot instance
   */
  initialize(bot: TelegramBot): void {
    this.bot = bot;
  }

  /**
   * Send mature token buy signal
   */
  async sendMatureTokenSignal(signal: MatureTokenSignal): Promise<boolean> {
    if (!this.bot) {
      logger.warn('Bot not initialized - cannot send mature token signal');
      return false;
    }

    try {
      const message = this.formatBuySignal(signal);
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: createTelegramInlineKeyboard(signal.tokenAddress),
      });

      logger.info({
        tokenAddress: signal.tokenAddress,
        ticker: signal.tokenTicker,
        signalType: signal.signalType,
        score: signal.score.compositeScore,
      }, 'Mature token signal sent');

      return true;
    } catch (error) {
      logger.error({ error, tokenAddress: signal.tokenAddress }, 'Failed to send mature token signal');
      return false;
    }
  }

  /**
   * Send exit signal
   */
  async sendExitSignal(signal: MatureTokenExitSignal): Promise<boolean> {
    if (!this.bot) {
      logger.warn('Bot not initialized - cannot send exit signal');
      return false;
    }

    try {
      const message = this.formatExitSignal(signal);
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: createTelegramInlineKeyboard(signal.tokenAddress),
      });

      return true;
    } catch (error) {
      logger.error({ error }, 'Failed to send exit signal');
      return false;
    }
  }

  /**
   * Send watchlist alert
   */
  async sendWatchlistAlert(item: MatureTokenWatchlist): Promise<boolean> {
    if (!this.bot) {
      logger.warn('Bot not initialized - cannot send watchlist alert');
      return false;
    }

    try {
      const message = this.formatWatchlistAlert(item);
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });

      return true;
    } catch (error) {
      logger.error({ error }, 'Failed to send watchlist alert');
      return false;
    }
  }

  /**
   * Format buy signal message
   */
  private formatBuySignal(signal: MatureTokenSignal): string {
    const { score, accumulationMetrics, breakoutMetrics, holderDynamics, smartMoneyMetrics, kolReentryMetrics, volumeProfile } = signal;

    // Signal type emoji and label
    const signalTypeInfo = this.getSignalTypeInfo(signal.signalType);

    // Build the message with clear visual hierarchy
    let msg = `\n`;
    msg += `═══════════════════════════════\n`;
    msg += `${signalTypeInfo.emoji}  *MATURE TOKEN SIGNAL*\n`;
    msg += `    ${signalTypeInfo.label} · Score: *${score.compositeScore}/100*\n`;
    msg += `═══════════════════════════════\n\n`;

    // Token info
    msg += `*Token:* \`$${signal.tokenTicker}\`\n`;
    msg += `*Address:* \`${signal.tokenAddress}\`\n`;
    msg += `*Chain:* Solana\n\n`;

    msg += `───────────────────────────────\n`;

    // Signal Overview
    msg += `📊 *SIGNAL OVERVIEW*\n`;
    msg += `├─ Signal Type: *${signalTypeInfo.label}*\n`;
    msg += `├─ Composite Score: *${score.compositeScore}/100*\n`;
    msg += `├─ Confidence: *${score.confidence}*\n`;
    msg += `├─ Risk Level: *${signal.riskLevel}/5*\n`;
    msg += `└─ Token Age: *${signal.tokenAgeDays}d ${signal.tokenAgeHours % 24}h*\n\n`;

    msg += `───────────────────────────────\n`;

    // Accumulation Analysis
    msg += `📈 *ACCUMULATION ANALYSIS*\n`;
    msg += `├─ Pattern: *${this.getPatternLabel(accumulationMetrics.pattern)}*\n`;
    msg += `├─ Consolidation: ${accumulationMetrics.consolidationDays} days\n`;
    msg += `├─ Distance from ATH: -${accumulationMetrics.distanceFromATH.toFixed(0)}%\n`;
    msg += `├─ Volume Trend: ${this.getVolumeTrendEmoji(volumeProfile.volumeTrend7d)} ${volumeProfile.volumeTrend7d}\n`;
    msg += `├─ Buy/Sell Ratio: ${accumulationMetrics.buyVolumeRatio.toFixed(1)}:1\n`;
    msg += `└─ Accumulation Score: *${accumulationMetrics.accumulationScore}/100*\n\n`;

    msg += `───────────────────────────────\n`;

    // Smart Money Activity
    msg += `🧠 *SMART MONEY ACTIVITY*\n`;
    msg += `├─ Whale Accumulation: ${smartMoneyMetrics.whaleAccumulation} whales adding\n`;
    msg += `├─ Smart Money Inflow: $${this.formatNumber(smartMoneyMetrics.smartMoneyInflow24h)} (24h)\n`;
    msg += `├─ Smart Wallet Holdings: ${smartMoneyMetrics.topTraderHoldings.toFixed(1)}%\n`;
    msg += `├─ Exchange Net Flow: ${smartMoneyMetrics.exchangeNetFlow > 0 ? '📥 INFLOW' : '📤 OUTFLOW'}\n`;
    msg += `└─ Smart Money Score: *${smartMoneyMetrics.smartMoneyScore}/100*\n\n`;

    msg += `───────────────────────────────\n`;

    // KOL Activity
    const kolStatus = kolReentryMetrics.kolBuys24h > 0 ? '🟢 ACTIVE' : kolReentryMetrics.kolBuys7d > 0 ? '🟡 WATCHING' : '⚪ NONE';
    msg += `👑 *KOL ACTIVITY*\n`;
    msg += `├─ Status: ${kolStatus}\n`;
    msg += `├─ KOLs Holding: ${kolReentryMetrics.tier1KolCount + kolReentryMetrics.tier2KolCount + kolReentryMetrics.tier3KolCount}`;
    msg += ` (T1:${kolReentryMetrics.tier1KolCount} T2:${kolReentryMetrics.tier2KolCount} T3:${kolReentryMetrics.tier3KolCount})\n`;
    msg += `├─ Recent Buys: ${kolReentryMetrics.kolBuys24h} in 24h / ${kolReentryMetrics.kolBuys7d} in 7d\n`;
    msg += `├─ Avg Entry vs Current: ${this.formatPercent(kolReentryMetrics.currentVsKolEntry - 1)}\n`;
    msg += `├─ KOL Conviction: ${kolReentryMetrics.kolConvictionScore >= 50 ? 'HIGH' : kolReentryMetrics.kolConvictionScore >= 30 ? 'MEDIUM' : 'LOW'}\n`;
    msg += `└─ KOL Score: *${kolReentryMetrics.kolActivityScore}/100*\n\n`;

    msg += `───────────────────────────────\n`;

    // Holder Dynamics
    msg += `👥 *HOLDER DYNAMICS*\n`;
    msg += `├─ Total Holders: ${this.formatNumber(signal.holderCount)} (${holderDynamics.holderGrowth24h >= 0 ? '+' : ''}${holderDynamics.holderGrowth24h.toFixed(1)}% 24h)\n`;
    msg += `├─ Buyer/Seller Ratio: ${holderDynamics.buyerSellerRatio.toFixed(1)}:1 (24h)\n`;
    msg += `├─ Diamond Hands: ${(holderDynamics.diamondHandsRatio * 100).toFixed(0)}% (>7d holders)\n`;
    msg += `├─ Top 10 Concentration: ${signal.top10Concentration.toFixed(1)}%\n`;
    msg += `├─ Quality Wallets: ${(holderDynamics.qualityWalletRatio * 100).toFixed(0)}%\n`;
    msg += `└─ Holder Score: *${holderDynamics.holderDynamicsScore}/100*\n\n`;

    msg += `───────────────────────────────\n`;

    // On-Chain Data
    msg += `📉 *ON-CHAIN DATA*\n`;
    msg += `├─ Price: $${this.formatPrice(signal.currentPrice)}\n`;
    msg += `├─ Market Cap: $${this.formatNumber(signal.marketCap)}\n`;
    msg += `├─ 24h Volume: $${this.formatNumber(signal.volume24h)} (${breakoutMetrics.volumeExpansion.toFixed(1)}x avg)\n`;
    msg += `├─ Liquidity: $${this.formatNumber(signal.liquidity)} (${((signal.liquidity / signal.marketCap) * 100).toFixed(1)}% of mcap)\n`;
    msg += `├─ Volume Authenticity: ${volumeProfile.volumeAuthenticityScore}%\n`;
    msg += `└─ LP Status: ${signal.score.contractSafetyScore >= 70 ? '🔒 LOCKED' : '🔓 UNLOCKED'}\n\n`;

    msg += `───────────────────────────────\n`;

    // Safety Check
    const safetyEmoji = score.contractSafetyScore >= 70 ? '🟢' : score.contractSafetyScore >= 50 ? '🟡' : '🔴';
    msg += `🛡️ *SAFETY CHECK*\n`;
    msg += `├─ Contract: ${safetyEmoji} ${score.contractSafetyScore >= 70 ? 'SAFE' : score.contractSafetyScore >= 50 ? 'CAUTION' : 'RISK'}\n`;
    msg += `├─ Insider Risk: ${score.bundleRiskScore >= 70 ? 'LOW' : score.bundleRiskScore >= 50 ? 'MEDIUM' : 'HIGH'}\n`;
    msg += `└─ Safety Score: *${score.contractSafetyScore}/100*\n\n`;

    // Bullish/Bearish signals
    if (score.bullishSignals.length > 0) {
      msg += `✅ *Bullish:* ${score.bullishSignals.slice(0, 4).join(', ')}\n`;
    }
    if (score.bearishSignals.length > 0) {
      msg += `⚠️ *Bearish:* ${score.bearishSignals.slice(0, 3).join(', ')}\n`;
    }
    if (score.warnings.length > 0) {
      msg += `🚨 *Warnings:* ${score.warnings.slice(0, 3).join(', ')}\n`;
    }

    msg += `\n${'━'.repeat(24)}\n\n`;

    // Trade Setup
    msg += `⚡ *TRADE SETUP*\n\n`;
    msg += `📍 Entry Zone: $${this.formatPrice(signal.entryZone.low)} - $${this.formatPrice(signal.entryZone.high)}\n`;
    msg += `📊 Position Size: *${signal.positionSizePercent}%* of portfolio\n\n`;

    msg += `🎯 *Take Profits:*\n`;
    msg += `├─ TP1 (50%): $${this.formatPrice(signal.takeProfit1.price)} (+50%) → Sell 33%\n`;
    msg += `├─ TP2 (100%): $${this.formatPrice(signal.takeProfit2.price)} (+100%) → Sell 33%\n`;
    msg += `└─ TP3 (200%): $${this.formatPrice(signal.takeProfit3.price)} (+200%) → Sell 34%\n\n`;

    msg += `🛑 Stop Loss: $${this.formatPrice(signal.stopLoss.price)} (-${signal.stopLoss.percent}%)\n`;
    msg += `📈 Trailing Stop: -15% from highs (after TP1)\n`;
    msg += `⏱️ Max Hold: ${signal.maxHoldDays} days\n\n`;

    msg += `───────────────────────────────\n`;

    // Quick Links
    msg += `🔗 *Quick Links:*\n`;
    msg += formatLinksAsMarkdown(signal.tokenAddress);
    msg += `\n\n`;

    // Footer
    msg += `⏱️ _${signal.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;
    msg += `🔵 *Mature Token Signal* - Tokens 24hrs+\n\n`;
    msg += `⚠️ _DYOR. Not financial advice. Mature tokens have lower rug risk but can still lose value rapidly._\n`;
    msg += `═══════════════════════════════\n`;

    return msg;
  }

  /**
   * Format exit signal message
   */
  private formatExitSignal(signal: MatureTokenExitSignal): string {
    const urgencyEmoji = signal.urgency === 'HIGH' ? '🔴' : signal.urgency === 'MEDIUM' ? '🟡' : '🟢';
    const pnlEmoji = signal.pnlPercent >= 0 ? '🟢' : '🔴';

    // Build the message with clear visual hierarchy
    let msg = `\n`;
    msg += `═══════════════════════════════\n`;
    msg += `🔴  *MATURE TOKEN EXIT SIGNAL*\n`;
    msg += `    ${urgencyEmoji} ${signal.urgency} · ${this.getExitActionLabel(signal.recommendation)}\n`;
    msg += `═══════════════════════════════\n\n`;

    msg += `*Token:* \`$${signal.tokenTicker}\`\n`;
    msg += `*Address:* \`${signal.tokenAddress}\`\n\n`;

    msg += `───────────────────────────────\n`;

    msg += `⚠️ *EXIT RECOMMENDATION*\n`;
    msg += `├─ Action: *${this.getExitActionLabel(signal.recommendation)}*\n`;
    msg += `├─ Urgency: ${urgencyEmoji} *${signal.urgency}*\n`;
    msg += `└─ Reason: ${signal.reason}\n\n`;

    msg += `───────────────────────────────\n`;

    msg += `📊 *POSITION STATUS*\n`;
    msg += `├─ Entry Price: $${this.formatPrice(signal.entryPrice)}\n`;
    msg += `├─ Current Price: $${this.formatPrice(signal.currentPrice)}\n`;
    msg += `├─ P&L: ${pnlEmoji} ${signal.pnlPercent >= 0 ? '+' : ''}${signal.pnlPercent.toFixed(1)}%\n`;
    msg += `├─ Hold Time: ${Math.floor(signal.holdTimeHours / 24)}d ${Math.floor(signal.holdTimeHours % 24)}h\n`;
    msg += `└─ Original Signal: ${signal.originalSignalType}\n\n`;

    msg += `───────────────────────────────\n`;

    msg += `🚨 *EXIT TRIGGERS:*\n`;
    for (const trigger of signal.triggers) {
      msg += `• ${trigger}\n`;
    }
    msg += `\n`;

    msg += `───────────────────────────────\n`;
    // Quick exit links
    msg += `💱 *Quick Exit:*\n`;
    msg += `[Jupiter](https://jup.ag/swap/${signal.tokenAddress}-SOL) | `;
    msg += `[Raydium](https://raydium.io/swap/?inputMint=${signal.tokenAddress})\n\n`;

    msg += `⏱️ _${signal.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;
    msg += `═══════════════════════════════\n`;

    return msg;
  }

  /**
   * Format watchlist alert
   */
  private formatWatchlistAlert(item: MatureTokenWatchlist): string {
    // Build the message with clear visual hierarchy
    let msg = `\n`;
    msg += `═══════════════════════════════\n`;
    msg += `👁️  *MATURE TOKEN WATCHLIST*\n`;
    msg += `    Score: ${item.currentScore}/100 · Target: ${item.targetScore}\n`;
    msg += `═══════════════════════════════\n\n`;

    msg += `*Token:* \`$${item.tokenTicker}\`\n`;
    msg += `*Added to:* Mature Token Watchlist\n\n`;

    msg += `───────────────────────────────\n`;

    msg += `📊 *WATCH REASON*\n`;
    msg += `├─ Score: ${item.currentScore}/100 (Below buy threshold)\n`;
    msg += `├─ Status: Approaching Breakout\n`;
    msg += `├─ Missing: Score needs to reach ${item.targetScore}\n`;
    msg += `└─ Conditions: ${item.targetConditions.slice(0, 2).join(', ')}\n\n`;

    msg += `───────────────────────────────\n`;

    msg += `📈 *KEY LEVELS TO WATCH*\n`;
    msg += `├─ Resistance: $${this.formatPrice(item.resistanceLevel)}\n`;
    msg += `├─ Support: $${this.formatPrice(item.supportLevel)}\n`;
    msg += `├─ Breakout Target: $${this.formatPrice(item.breakoutTarget)}\n`;
    msg += `└─ Volume Trigger: $${this.formatNumber(item.volumeTrigger)}\n\n`;

    msg += `───────────────────────────────\n`;

    msg += `🔔 _You'll be notified when conditions are met._\n\n`;

    msg += `⏱️ _${item.addedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC_\n`;
    msg += `═══════════════════════════════\n`;

    return msg;
  }

  // ============ HELPERS ============

  private getSignalTypeInfo(type: MatureSignalType): { emoji: string; label: string } {
    switch (type) {
      case MatureSignalType.ACCUMULATION_BREAKOUT:
        return { emoji: '📊', label: 'ACCUMULATION BREAKOUT' };
      case MatureSignalType.SMART_MONEY_ACCUMULATION:
        return { emoji: '🧠', label: 'SMART MONEY ACCUMULATION' };
      case MatureSignalType.KOL_REENTRY:
        return { emoji: '👑', label: 'KOL REENTRY' };
      case MatureSignalType.KOL_FIRST_BUY:
        return { emoji: '🎯', label: 'KOL FIRST BUY' };
      case MatureSignalType.MULTI_KOL_CONVICTION:
        return { emoji: '🔥', label: 'MULTI-KOL CONVICTION' };
      case MatureSignalType.VOLUME_BREAKOUT:
        return { emoji: '📈', label: 'VOLUME BREAKOUT' };
      case MatureSignalType.HOLDER_SURGE:
        return { emoji: '👥', label: 'HOLDER SURGE' };
      case MatureSignalType.NARRATIVE_CATALYST:
        return { emoji: '🐦', label: 'NARRATIVE CATALYST' };
      default:
        return { emoji: '🔵', label: 'MATURE TOKEN' };
    }
  }

  private getPatternLabel(pattern: AccumulationPattern): string {
    switch (pattern) {
      case AccumulationPattern.WYCKOFF_SPRING: return 'WYCKOFF SPRING';
      case AccumulationPattern.RANGE_BREAK: return 'RANGE BREAK';
      case AccumulationPattern.ASCENDING_TRIANGLE: return 'ASCENDING TRIANGLE';
      case AccumulationPattern.DOUBLE_BOTTOM: return 'DOUBLE BOTTOM';
      case AccumulationPattern.CONSOLIDATION: return 'CONSOLIDATION';
      default: return 'NONE';
    }
  }

  private getVolumeTrendEmoji(trend: VolumeTrend): string {
    switch (trend) {
      case VolumeTrend.INCREASING: return '📈';
      case VolumeTrend.STABLE: return '➡️';
      case VolumeTrend.DECLINING: return '📉';
      default: return '➡️';
    }
  }

  private getExitActionLabel(recommendation: ExitRecommendation): string {
    switch (recommendation) {
      case ExitRecommendation.FULL_EXIT: return 'FULL EXIT (100%)';
      case ExitRecommendation.PARTIAL_EXIT_75: return 'PARTIAL EXIT (75%)';
      case ExitRecommendation.PARTIAL_EXIT_50: return 'PARTIAL EXIT (50%)';
      case ExitRecommendation.PARTIAL_EXIT_25: return 'PARTIAL EXIT (25%)';
      case ExitRecommendation.MOVE_STOP: return 'TIGHTEN STOP LOSS';
      case ExitRecommendation.HOLD: return 'CONTINUE HOLDING';
      default: return 'REVIEW POSITION';
    }
  }

  private formatNumber(num: number): string {
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
    return num.toFixed(2);
  }

  private formatPrice(price: number): string {
    if (price >= 1) return price.toFixed(4);
    if (price >= 0.0001) return price.toFixed(6);
    return price.toExponential(4);
  }

  private formatPercent(value: number): string {
    const percent = value * 100;
    return `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
  }
}

// ============ EXPORTS ============

export const matureTokenTelegram = new MatureTokenTelegramFormatter();

export default {
  MatureTokenTelegramFormatter,
  matureTokenTelegram,
};
