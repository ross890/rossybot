// ===========================================
// MACRO TELEGRAM ALERT FORMATTER
// ===========================================
// Formats macro signals for Telegram display
// Completely separate from memecoin alerts

import {
  MacroGannSignal,
  MacroBias,
  BiasStrength,
  MacroAction,
  MarketRegime,
  GannAnalysis,
  CycleSignificance,
} from '../types.js';

/**
 * Macro Telegram Formatter
 *
 * Creates formatted Telegram messages for macro signals.
 * Uses Markdown formatting compatible with Telegram's parse_mode: 'Markdown'
 */
export class MacroTelegramFormatter {
  /**
   * Format a complete macro signal for Telegram
   */
  formatSignal(signal: MacroGannSignal): string {
    const lines: string[] = [];

    // Header
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('📊 *MACRO GANN SIGNAL*');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');

    // Main signal info
    lines.push(`⚡ *BIAS:* ${this.formatBias(signal.bias, signal.biasStrength)}`);
    lines.push(`📍 *ACTION:* ${this.formatAction(signal.action)}`);
    lines.push(`🎚️ *LEVERAGE:* ${signal.leverage.suggested}x suggested (${signal.leverage.maximum}x max)`);
    lines.push('');

    // Gann Analysis section
    lines.push('━━━ Gann Analysis ━━━');
    lines.push(`📐 *Angle:* ${this.formatAngle(signal.gann)}`);
    lines.push(`📍 *Sq9 Support:* ${this.formatPriceLevels(signal.keyLevels.support)}`);
    lines.push(`📍 *Sq9 Resistance:* ${this.formatPriceLevels(signal.keyLevels.resistance)}`);
    lines.push(`⏰ *Cycles:* ${this.formatCycles(signal.gann.activeCycles)}`);

    if (signal.gann.confluence) {
      lines.push(`⚠️ *CONFLUENCE DETECTED*`);
    }
    lines.push('');

    // Derivatives section
    lines.push('━━━ Derivatives (Binance) ━━━');
    lines.push(`💵 *Funding:* ${(signal.derivatives.fundingRate * 100).toFixed(4)}%`);
    lines.push(`📊 *Open Interest:* ${this.formatLargeNumber(signal.derivatives.openInterest)} (${signal.derivatives.oiChange24h >= 0 ? '+' : ''}${signal.derivatives.oiChange24h.toFixed(1)}% 24h)`);
    lines.push(`💥 *Liquidations:* ${this.formatLargeNumber(signal.derivatives.liquidations24h.total)} (24h)`);
    lines.push(`   └─ Longs: ${this.formatLargeNumber(signal.derivatives.liquidations24h.long)} | Shorts: ${this.formatLargeNumber(signal.derivatives.liquidations24h.short)}`);
    lines.push('');

    // Order Book section
    if (signal.orderBook.bidAskImbalance !== 0) {
      lines.push('━━━ Order Book ━━━');
      lines.push(`📗 *Top Bid:* $${this.formatNumber(signal.orderBook.topBidWall.price)} (${this.formatLargeNumber(signal.orderBook.topBidWall.size)})`);
      lines.push(`📕 *Top Ask:* $${this.formatNumber(signal.orderBook.topAskWall.price)} (${this.formatLargeNumber(signal.orderBook.topAskWall.size)})`);
      lines.push(`⚖️ *Imbalance:* ${(signal.orderBook.bidAskImbalance * 100).toFixed(0)}% (${signal.orderBook.bidAskImbalance > 0 ? 'buyers' : 'sellers'})`);
      lines.push('');
    }

    // Sentiment section
    lines.push('━━━ Sentiment ━━━');
    lines.push(`${this.getSentimentEmoji(signal.sentiment.fearGreedIndex)} *Fear & Greed:* ${signal.sentiment.fearGreedIndex} (${signal.sentiment.fearGreedClassification})`);
    if (signal.sentiment.socialScore > 0) {
      lines.push(`📱 *Social Score:* ${signal.sentiment.socialScore}/100`);
    }
    lines.push('');

    // Whale Activity section
    if (signal.whaleActivity.recentLargeTransfers > 0) {
      lines.push('━━━ Whale Activity ━━━');
      lines.push(`🐋 *Large Txns:* ${signal.whaleActivity.recentLargeTransfers} (24h)`);
      lines.push(`📈 *Flow Bias:* ${signal.whaleActivity.exchangeFlowBias}`);
      lines.push('');
    }

    // Price info
    lines.push('━━━ Prices ━━━');
    lines.push(`₿ *BTC:* $${this.formatNumber(signal.btcPrice)}`);
    lines.push(`◎ *SOL:* $${this.formatNumber(signal.solPrice)}`);
    lines.push(`📊 *SOL/BTC:* ${signal.solBtcRatio.toFixed(6)}`);
    lines.push('');

    // Summary
    lines.push('━━━ Signal Logic ━━━');
    lines.push(this.wrapText(signal.summary, 35));
    lines.push('');

    // Regime
    lines.push(`📉 *REGIME:* ${signal.regime}`);
    lines.push(`🎯 *CONFIDENCE:* ${signal.confidence}%`);
    lines.push('');

    // Leverage reasoning
    if (signal.leverage.reasoning) {
      lines.push('━━━ Leverage Reasoning ━━━');
      lines.push(this.wrapText(signal.leverage.reasoning, 35));
      lines.push('');
    }

    // Footer
    lines.push('⚠️ *INFORMATIONAL ONLY*');
    lines.push('_Does not affect memecoin signals_');
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return lines.join('\n');
  }

  /**
   * Format bias with emoji
   */
  private formatBias(bias: MacroBias, strength: BiasStrength): string {
    let emoji = '';
    switch (bias) {
      case MacroBias.LONG:
        emoji = '🟢';
        break;
      case MacroBias.SHORT:
        emoji = '🔴';
        break;
      case MacroBias.NEUTRAL:
        emoji = '⚪';
        break;
    }

    return `${emoji} ${bias} (${strength})`;
  }

  /**
   * Format action for display
   */
  private formatAction(action: MacroAction): string {
    const actionMap: Record<MacroAction, string> = {
      [MacroAction.OPEN_LONG]: '📈 OPEN LONG',
      [MacroAction.OPEN_SHORT]: '📉 OPEN SHORT',
      [MacroAction.CLOSE_LONG]: '🔒 CLOSE LONG',
      [MacroAction.CLOSE_SHORT]: '🔒 CLOSE SHORT',
      [MacroAction.ADD_LONG]: '➕ ADD LONG',
      [MacroAction.ADD_SHORT]: '➕ ADD SHORT',
      [MacroAction.REDUCE_LONG]: '➖ REDUCE LONG',
      [MacroAction.REDUCE_SHORT]: '➖ REDUCE SHORT',
      [MacroAction.HOLD]: '⏸️ HOLD',
      [MacroAction.FLAT]: '⏹️ FLAT',
    };

    return actionMap[action] || action;
  }

  /**
   * Format Gann angle
   */
  private formatAngle(gann: GannAnalysis): string {
    const direction = gann.currentAngle.direction === 'UP' ? '↗️' : '↘️';
    const strength = gann.currentAngle.trendStrength.replace('_', ' ');
    return `${gann.currentAngle.closestGannAngle} (${gann.currentAngle.currentAngle.toFixed(1)}°) ${direction} ${strength}`;
  }

  /**
   * Format price levels
   */
  private formatPriceLevels(levels: number[]): string {
    if (levels.length === 0) return 'N/A';
    return levels
      .slice(0, 3)
      .map((l) => `$${this.formatNumber(l)}`)
      .join(' / ');
  }

  /**
   * Format active cycles
   */
  private formatCycles(cycles: { cycleLength: number; barsRemaining: number; significance: CycleSignificance }[]): string {
    const highSigCycles = cycles.filter((c) => c.significance === CycleSignificance.HIGH);

    if (highSigCycles.length === 0) {
      return 'No imminent high-significance cycles';
    }

    const cycle = highSigCycles[0];
    return `${cycle.cycleLength}-bar cycle due in ${cycle.barsRemaining} bars`;
  }

  /**
   * Get sentiment emoji
   */
  private getSentimentEmoji(value: number): string {
    if (value <= 20) return '😱';
    if (value <= 40) return '😰';
    if (value <= 60) return '😐';
    if (value <= 80) return '😊';
    return '🤑';
  }

  /**
   * Format large numbers (billions, millions)
   */
  private formatLargeNumber(num: number): string {
    if (num >= 1_000_000_000) {
      return `$${(num / 1_000_000_000).toFixed(2)}B`;
    }
    if (num >= 1_000_000) {
      return `$${(num / 1_000_000).toFixed(2)}M`;
    }
    if (num >= 1_000) {
      return `$${(num / 1_000).toFixed(2)}K`;
    }
    return `$${num.toFixed(2)}`;
  }

  /**
   * Format number for display
   */
  private formatNumber(num: number): string {
    if (num >= 10000) {
      return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
    if (num >= 100) {
      return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    if (num >= 1) {
      return num.toFixed(2);
    }
    return num.toFixed(4);
  }

  /**
   * Wrap text to fit Telegram display
   */
  private wrapText(text: string, maxCharsPerLine: number): string {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 > maxCharsPerLine) {
        lines.push(currentLine.trim());
        currentLine = word;
      } else {
        currentLine += ' ' + word;
      }
    }

    if (currentLine.trim()) {
      lines.push(currentLine.trim());
    }

    return lines.join('\n');
  }

  /**
   * Format a short status update
   */
  formatStatusUpdate(signal: MacroGannSignal): string {
    const biasEmoji = signal.bias === MacroBias.LONG ? '🟢' :
      signal.bias === MacroBias.SHORT ? '🔴' : '⚪';

    return [
      `${biasEmoji} *Macro Update*`,
      `Bias: ${signal.bias} | Action: ${signal.action}`,
      `BTC: $${this.formatNumber(signal.btcPrice)} | F&G: ${signal.sentiment.fearGreedIndex}`,
      `Leverage: ${signal.leverage.suggested}x`,
    ].join('\n');
  }

  /**
   * Format metrics-only update
   */
  formatMetricsUpdate(signal: MacroGannSignal): string {
    return [
      '📊 *Macro Metrics*',
      '',
      `₿ BTC: $${this.formatNumber(signal.btcPrice)}`,
      `◎ SOL: $${this.formatNumber(signal.solPrice)}`,
      `💵 Funding: ${(signal.derivatives.fundingRate * 100).toFixed(4)}%`,
      `📊 OI Change: ${signal.derivatives.oiChange24h >= 0 ? '+' : ''}${signal.derivatives.oiChange24h.toFixed(1)}%`,
      `${this.getSentimentEmoji(signal.sentiment.fearGreedIndex)} Fear & Greed: ${signal.sentiment.fearGreedIndex}`,
      `📐 Gann Angle: ${signal.gann.currentAngle.closestGannAngle}`,
    ].join('\n');
  }

  /**
   * Format Gann levels for /macro levels command
   */
  formatLevels(signal: MacroGannSignal): string {
    const lines = [
      '📐 *Gann Levels (BTC)*',
      '',
      '*Support:*',
    ];

    for (const level of signal.keyLevels.support) {
      const distance = ((signal.btcPrice - level) / level * 100).toFixed(1);
      lines.push(`  └─ $${this.formatNumber(level)} (${distance}% away)`);
    }

    lines.push('');
    lines.push('*Resistance:*');

    for (const level of signal.keyLevels.resistance) {
      const distance = ((level - signal.btcPrice) / signal.btcPrice * 100).toFixed(1);
      lines.push(`  └─ $${this.formatNumber(level)} (+${distance}%)`);
    }

    return lines.join('\n');
  }

  /**
   * Format cycles for /macro cycles command
   */
  formatCyclesDetail(signal: MacroGannSignal): string {
    const lines = [
      '⏰ *Active Gann Cycles*',
      '',
    ];

    if (signal.gann.activeCycles.length === 0) {
      lines.push('No significant cycles in the next 30 days.');
      return lines.join('\n');
    }

    for (const cycle of signal.gann.activeCycles.slice(0, 10)) {
      const sigEmoji = cycle.significance === CycleSignificance.HIGH ? '🔴' :
        cycle.significance === CycleSignificance.MEDIUM ? '🟡' : '⚪';

      lines.push(`${sigEmoji} *${cycle.cycleLength}-bar cycle*`);
      lines.push(`   Due: ${cycle.expectedDate.toISOString().slice(0, 10)}`);
      lines.push(`   Bars remaining: ${cycle.barsRemaining}`);
      lines.push(`   From: ${cycle.fromPivot}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}

// Export singleton instance
export const macroTelegramFormatter = new MacroTelegramFormatter();
