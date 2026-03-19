import axios from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { GraduationPatterns } from './pattern-analyzer.js';
import type { WalletConfluenceResult } from './wallet-confluence.js';
import type { GraduatedToken } from './graduated-fetcher.js';

const TG_API = `https://api.telegram.org/bot${config.telegram.botToken}`;
const CHAT_ID = config.telegram.chatId;

/**
 * Generate and send the daily market analysis report to Telegram.
 */
export async function sendDailyReport(params: {
  analysisDate: string;
  totalGraduated: number;
  tokensAnalyzed: number;
  patterns: GraduationPatterns;
  topConfluenceWallets: WalletConfluenceResult[];
  alphaOverlap: {
    totalUniqueEarlyBuyers: number;
    knownAlphaCount: number;
    knownAlphaPct: number;
    topAlphaWallets: Array<{ address: string; label: string; tokensBought: number }>;
  };
  profitability: {
    profitRate: number;
    avgWinPct: number;
    avgLossPct: number;
    bestToken: GraduatedToken | null;
    worstToken: GraduatedToken | null;
  };
  mcapSegments: Array<{ range: string; count: number; avgPriceChangeH24: number; profitRate: number }>;
  newDiscoveries: number;
  durationSeconds: number;
}): Promise<void> {
  const {
    analysisDate, totalGraduated, tokensAnalyzed, patterns,
    topConfluenceWallets, alphaOverlap, profitability,
    mcapSegments, newDiscoveries, durationSeconds,
  } = params;

  // Build report sections
  const sections: string[] = [];

  // Header
  sections.push(
    `<b>PUMP.FUN MARKET ANALYSIS</b>`,
    `<b>Date:</b> ${analysisDate}`,
    `<b>Duration:</b> ${formatDuration(durationSeconds)}`,
    ``,
  );

  // Overview
  sections.push(
    `<b>GRADUATED TOKENS</b>`,
    `Total graduated (24h): <b>${totalGraduated}</b>`,
    `Analyzed: <b>${tokensAnalyzed}</b>`,
    `Median MCap: <b>$${formatNum(patterns.medianMcapUsd)}</b>`,
    `Avg Liquidity: <b>$${formatNum(patterns.medianLiquidityUsd)}</b>`,
    `Avg Volume: <b>$${formatNum(patterns.avgVolumeUsd)}</b>`,
    `Avg Buy/Sell Ratio: <b>${patterns.avgBuySellRatio.toFixed(2)}</b>`,
    ``,
  );

  // Post-graduation performance
  sections.push(
    `<b>POST-GRAD PERFORMANCE</b>`,
    `+1h: ${formatPct(patterns.avgPriceChangeH1)} (${patterns.pctPositiveH1.toFixed(0)}% green)`,
    `+6h: ${formatPct(patterns.avgPriceChangeH6)}`,
    `+24h: ${formatPct(patterns.avgPriceChangeH24)} (${patterns.pctPositiveH24.toFixed(0)}% green)`,
    ``,
  );

  // Profitability (if we entered at graduation)
  sections.push(
    `<b>BACKTEST: ENTRY AT GRADUATION</b>`,
    `Win rate (>+20% in 24h): <b>${(profitability.profitRate * 100).toFixed(0)}%</b>`,
    `Avg win: <b>+${profitability.avgWinPct.toFixed(0)}%</b>`,
    `Avg loss: <b>${profitability.avgLossPct.toFixed(0)}%</b>`,
  );
  if (profitability.bestToken) {
    sections.push(`Best: ${profitability.bestToken.symbol} (${formatPct(profitability.bestToken.priceChangeH24)})`);
  }
  if (profitability.worstToken) {
    sections.push(`Worst: ${profitability.worstToken.symbol} (${formatPct(profitability.worstToken.priceChangeH24)})`);
  }
  sections.push(``);

  // MCap segments
  sections.push(`<b>MCAP SEGMENT ANALYSIS</b>`);
  for (const seg of mcapSegments.filter((s) => s.count > 0)) {
    sections.push(
      `${seg.range}: ${seg.count} tokens, avg ${formatPct(seg.avgPriceChangeH24)}, ${(seg.profitRate * 100).toFixed(0)}% WR`,
    );
  }
  sections.push(``);

  // Alpha overlap
  sections.push(
    `<b>ALPHA WALLET OVERLAP</b>`,
    `Unique early buyers: <b>${alphaOverlap.totalUniqueEarlyBuyers}</b>`,
    `Known alpha wallets: <b>${alphaOverlap.knownAlphaCount}</b> (${(alphaOverlap.knownAlphaPct * 100).toFixed(1)}%)`,
  );
  if (alphaOverlap.topAlphaWallets.length > 0) {
    sections.push(`Top alpha activity:`);
    for (const w of alphaOverlap.topAlphaWallets.slice(0, 5)) {
      sections.push(`  ${w.label}: ${w.tokensBought} grads`);
    }
  }
  sections.push(``);

  // Top confluence wallets (the edge)
  sections.push(
    `<b>TOP CONFLUENCE WALLETS (NEW EDGE)</b>`,
    `New high-confluence discoveries: <b>${newDiscoveries}</b>`,
  );
  const newWallets = topConfluenceWallets.filter((w) => !w.isTrackedAlpha).slice(0, 10);
  if (newWallets.length > 0) {
    for (const w of newWallets) {
      sections.push(
        `  <code>${w.walletAddress.slice(0, 8)}...</code> ` +
        `Score: ${w.confluenceScore.toFixed(0)} | ` +
        `${w.graduatedTokensBought} grads | ` +
        `${w.avgBuyTimeBeforeGradMins.toFixed(0)}min early`,
      );
    }
  } else {
    sections.push(`  No new wallets above threshold today`);
  }
  sections.push(``);

  // Timing patterns
  const topHours = Object.entries(patterns.graduationHourDistribution)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([h, c]) => `${h}:00 UTC (${c})`);
  sections.push(
    `<b>TIMING PATTERNS</b>`,
    `Peak hours: ${topHours.join(', ')}`,
    `Avg early buyers/token: ${patterns.avgEarlyBuyersPerToken.toFixed(1)}`,
    `Avg SOL/buyer: ${patterns.avgSolPerEarlyBuyer.toFixed(2)}`,
  );
  if (patterns.commonWords.length > 0) {
    const top5Words = patterns.commonWords.slice(0, 5).map((w) => `${w.word}(${w.count})`);
    sections.push(`Common words: ${top5Words.join(', ')}`);
  }
  sections.push(``);

  // Risk
  sections.push(
    `<b>RISK METRICS</b>`,
    `Rug pulls (>-90%): ${patterns.rugPullIndicators}/${tokensAnalyzed}`,
    `Healthy grads (>-50%): ${patterns.healthyGraduations}/${tokensAnalyzed}`,
    `Buy-dominant tokens: ${patterns.tokensWithBuyDominance}`,
    `Sell-dominant tokens: ${patterns.tokensWithSellDominance}`,
  );

  const message = sections.join('\n');

  // Send to Telegram (split if too long)
  await sendTelegramMessage(message);
}

async function sendTelegramMessage(text: string): Promise<void> {
  // Telegram max message length is 4096 chars
  const MAX_LEN = 4000;

  if (text.length <= MAX_LEN) {
    await sendOneMessage(text);
    return;
  }

  // Split at double newlines
  const parts: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > MAX_LEN) {
      if (current) parts.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) parts.push(current);

  for (let i = 0; i < parts.length; i++) {
    const header = parts.length > 1 ? `(${i + 1}/${parts.length})\n` : '';
    await sendOneMessage(header + parts[i]);
    if (i < parts.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function sendOneMessage(text: string): Promise<void> {
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 10_000 });
  } catch (err) {
    logger.error({ err }, 'Failed to send Telegram report');
  }
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function formatPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}
