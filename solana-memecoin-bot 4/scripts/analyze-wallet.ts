// ===========================================
// WALLET ANALYSIS SCRIPT
// Deep analysis of profitable memecoin trading wallets
// ===========================================

import axios from 'axios';
import { config } from 'dotenv';

config();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
// Use public Solana RPC as fallback if no Helius key
const SOLANA_RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

// Target wallet for analysis
const TARGET_WALLET = process.argv[2] || 'AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51';

// Known token addresses to skip (SOL, USDC, etc.)
const SKIP_TOKENS = new Set([
  'So11111111111111111111111111111111111111112',  // Wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

interface Trade {
  signature: string;
  timestamp: Date;
  tokenAddress: string;
  tokenSymbol: string;
  type: 'BUY' | 'SELL';
  solAmount: number;
  tokenAmount: number;
  pricePerToken: number;
}

interface TokenPosition {
  tokenAddress: string;
  tokenSymbol: string;
  buys: Trade[];
  sells: Trade[];
  totalSolSpent: number;
  totalSolReceived: number;
  netPnL: number;
  roi: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  holdTimeHours: number;
  isOpen: boolean;
}

interface WalletAnalysis {
  address: string;
  totalTrades: number;
  totalBuys: number;
  totalSells: number;
  uniqueTokens: number;
  totalSolSpent: number;
  totalSolReceived: number;
  netPnL: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgWinROI: number;
  avgLossROI: number;
  avgHoldTimeHours: number;
  positions: TokenPosition[];
  tradingPatterns: TradingPatterns;
}

interface TradingPatterns {
  avgPositionSizeSOL: number;
  preferredEntryMarketCap: string;
  avgTradesPerToken: number;
  mostActiveHours: number[];
  quickFlipRatio: number;  // % of trades held < 1 hour
  mediumHoldRatio: number; // % held 1-24 hours
  longHoldRatio: number;   // % held > 24 hours
  tokenSelectionCriteria: string[];
}

class WalletAnalyzer {
  private client: axios.AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: SOLANA_RPC_URL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`Using RPC: ${HELIUS_API_KEY ? 'Helius' : 'Public Solana RPC'}`);
  }

  async getTransactionSignatures(address: string, limit = 1000): Promise<any[]> {
    console.log(`\nFetching transaction signatures for ${address}...`);

    const allSignatures: any[] = [];
    let lastSignature: string | undefined;

    while (allSignatures.length < limit) {
      const params: any = { limit: Math.min(100, limit - allSignatures.length) };
      if (lastSignature) {
        params.before = lastSignature;
      }

      const response = await this.client.post('', {
        jsonrpc: '2.0',
        id: 'sigs',
        method: 'getSignaturesForAddress',
        params: [address, params],
      });

      const signatures = response.data.result || [];
      if (signatures.length === 0) break;

      allSignatures.push(...signatures);
      lastSignature = signatures[signatures.length - 1].signature;

      console.log(`  Fetched ${allSignatures.length} signatures...`);

      // Rate limiting
      await this.sleep(200);
    }

    return allSignatures;
  }

  async getTransactionDetails(signature: string): Promise<any> {
    try {
      const response = await this.client.post('', {
        jsonrpc: '2.0',
        id: 'tx',
        method: 'getTransaction',
        params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      });
      return response.data.result;
    } catch (error) {
      return null;
    }
  }

  parseSwapFromTransaction(tx: any, walletAddress: string): Trade | null {
    if (!tx || !tx.meta) return null;

    try {
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      const accountKeys = tx.transaction?.message?.accountKeys || [];

      // Find wallet index
      const walletIndex = accountKeys.findIndex((k: any) =>
        (typeof k === 'string' ? k : k.pubkey) === walletAddress
      );
      if (walletIndex < 0) return null;

      // Calculate SOL change
      const preSol = (tx.meta.preBalances?.[walletIndex] || 0) / 1e9;
      const postSol = (tx.meta.postBalances?.[walletIndex] || 0) / 1e9;
      const solChange = postSol - preSol;

      // Find token changes for this wallet
      for (const postBalance of postBalances) {
        if (postBalance.owner !== walletAddress) continue;
        if (SKIP_TOKENS.has(postBalance.mint)) continue;

        const preBalance = preBalances.find(
          (pb: any) => pb.mint === postBalance.mint && pb.owner === walletAddress
        );

        const preBal = preBalance?.uiTokenAmount?.uiAmount || 0;
        const postBal = postBalance.uiTokenAmount?.uiAmount || 0;
        const tokenChange = postBal - preBal;

        if (Math.abs(tokenChange) < 0.0001) continue;

        // Determine trade type
        const isBuy = tokenChange > 0 && solChange < -0.001;
        const isSell = tokenChange < 0 && solChange > 0.001;

        if (!isBuy && !isSell) continue;

        const solAmount = Math.abs(solChange);
        const tokenAmount = Math.abs(tokenChange);

        // Skip dust trades
        if (solAmount < 0.01) continue;

        return {
          signature: tx.transaction.signatures[0],
          timestamp: new Date(tx.blockTime * 1000),
          tokenAddress: postBalance.mint,
          tokenSymbol: 'UNKNOWN', // Will be enriched later
          type: isBuy ? 'BUY' : 'SELL',
          solAmount,
          tokenAmount,
          pricePerToken: solAmount / tokenAmount,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  async getTokenMetadata(address: string): Promise<{ symbol: string; name: string } | null> {
    try {
      // Try DexScreener first (free, no API key)
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
        timeout: 5000,
      });
      const pairs = response.data.pairs?.filter((p: any) => p.chainId === 'solana') || [];
      if (pairs.length > 0) {
        return {
          symbol: pairs[0].baseToken?.symbol || 'UNKNOWN',
          name: pairs[0].baseToken?.name || 'Unknown Token',
        };
      }
    } catch (error) {
      // Ignore
    }
    return null;
  }

  async analyzeWallet(address: string): Promise<WalletAnalysis> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`ANALYZING WALLET: ${address}`);
    console.log(`${'='.repeat(60)}\n`);

    // Step 1: Get all transaction signatures
    const signatures = await this.getTransactionSignatures(address, 500);
    console.log(`\nFound ${signatures.length} transactions to analyze`);

    // Step 2: Parse each transaction for swap data
    const trades: Trade[] = [];
    const tokenMetadataCache = new Map<string, { symbol: string; name: string }>();

    console.log('\nParsing transactions for swap data...');
    let processed = 0;

    for (const sig of signatures) {
      const tx = await this.getTransactionDetails(sig.signature);
      if (tx) {
        const trade = this.parseSwapFromTransaction(tx, address);
        if (trade) {
          trades.push(trade);

          // Cache token metadata lookup
          if (!tokenMetadataCache.has(trade.tokenAddress)) {
            const metadata = await this.getTokenMetadata(trade.tokenAddress);
            if (metadata) {
              tokenMetadataCache.set(trade.tokenAddress, metadata);
            }
          }

          // Enrich trade with symbol
          const cached = tokenMetadataCache.get(trade.tokenAddress);
          if (cached) {
            trade.tokenSymbol = cached.symbol;
          }
        }
      }

      processed++;
      if (processed % 50 === 0) {
        console.log(`  Processed ${processed}/${signatures.length} transactions, found ${trades.length} trades...`);
      }

      // Rate limiting
      await this.sleep(100);
    }

    console.log(`\nFound ${trades.length} total trades across ${tokenMetadataCache.size} unique tokens`);

    // Step 3: Group trades by token to calculate positions
    const positionMap = new Map<string, TokenPosition>();

    for (const trade of trades) {
      if (!positionMap.has(trade.tokenAddress)) {
        positionMap.set(trade.tokenAddress, {
          tokenAddress: trade.tokenAddress,
          tokenSymbol: trade.tokenSymbol,
          buys: [],
          sells: [],
          totalSolSpent: 0,
          totalSolReceived: 0,
          netPnL: 0,
          roi: 0,
          avgBuyPrice: 0,
          avgSellPrice: 0,
          holdTimeHours: 0,
          isOpen: false,
        });
      }

      const position = positionMap.get(trade.tokenAddress)!;

      if (trade.type === 'BUY') {
        position.buys.push(trade);
        position.totalSolSpent += trade.solAmount;
      } else {
        position.sells.push(trade);
        position.totalSolReceived += trade.solAmount;
      }
    }

    // Step 4: Calculate PnL and ROI for each position
    const positions: TokenPosition[] = [];
    let totalWins = 0;
    let totalLosses = 0;
    let totalWinROI = 0;
    let totalLossROI = 0;
    let totalHoldTime = 0;
    let closedPositions = 0;

    for (const [_addr, position] of positionMap) {
      // Calculate averages
      if (position.buys.length > 0) {
        position.avgBuyPrice = position.totalSolSpent / position.buys.reduce((sum, b) => sum + b.tokenAmount, 0);
      }
      if (position.sells.length > 0) {
        position.avgSellPrice = position.totalSolReceived / position.sells.reduce((sum, s) => sum + s.tokenAmount, 0);
      }

      // Calculate PnL
      position.netPnL = position.totalSolReceived - position.totalSolSpent;
      position.roi = position.totalSolSpent > 0
        ? ((position.totalSolReceived - position.totalSolSpent) / position.totalSolSpent) * 100
        : 0;

      // Check if position is closed
      const totalBought = position.buys.reduce((sum, b) => sum + b.tokenAmount, 0);
      const totalSold = position.sells.reduce((sum, s) => sum + s.tokenAmount, 0);
      position.isOpen = totalSold < totalBought * 0.9; // Consider closed if 90%+ sold

      // Calculate hold time (for closed positions)
      if (!position.isOpen && position.buys.length > 0 && position.sells.length > 0) {
        const firstBuy = position.buys.reduce((min, b) => b.timestamp < min.timestamp ? b : min);
        const lastSell = position.sells.reduce((max, s) => s.timestamp > max.timestamp ? s : max);
        position.holdTimeHours = (lastSell.timestamp.getTime() - firstBuy.timestamp.getTime()) / (1000 * 60 * 60);
        totalHoldTime += position.holdTimeHours;
        closedPositions++;
      }

      // Count wins/losses for closed positions
      if (!position.isOpen) {
        if (position.roi > 0) {
          totalWins++;
          totalWinROI += position.roi;
        } else {
          totalLosses++;
          totalLossROI += position.roi;
        }
      }

      positions.push(position);
    }

    // Sort by PnL descending
    positions.sort((a, b) => b.netPnL - a.netPnL);

    // Step 5: Calculate trading patterns
    const buyTrades = trades.filter(t => t.type === 'BUY');
    const hourCounts = new Array(24).fill(0);
    for (const trade of trades) {
      hourCounts[trade.timestamp.getHours()]++;
    }

    // Find most active hours
    const mostActiveHours = hourCounts
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map(h => h.hour);

    // Calculate hold time distribution
    const closedPositionsWithTime = positions.filter(p => !p.isOpen && p.holdTimeHours > 0);
    const quickFlips = closedPositionsWithTime.filter(p => p.holdTimeHours < 1).length;
    const mediumHolds = closedPositionsWithTime.filter(p => p.holdTimeHours >= 1 && p.holdTimeHours < 24).length;
    const longHolds = closedPositionsWithTime.filter(p => p.holdTimeHours >= 24).length;
    const totalClosed = closedPositionsWithTime.length || 1;

    const tradingPatterns: TradingPatterns = {
      avgPositionSizeSOL: buyTrades.length > 0
        ? buyTrades.reduce((sum, t) => sum + t.solAmount, 0) / buyTrades.length
        : 0,
      preferredEntryMarketCap: 'Unknown', // Would need additional API calls
      avgTradesPerToken: positions.length > 0 ? trades.length / positions.length : 0,
      mostActiveHours,
      quickFlipRatio: (quickFlips / totalClosed) * 100,
      mediumHoldRatio: (mediumHolds / totalClosed) * 100,
      longHoldRatio: (longHolds / totalClosed) * 100,
      tokenSelectionCriteria: [],
    };

    // Build analysis
    const analysis: WalletAnalysis = {
      address,
      totalTrades: trades.length,
      totalBuys: trades.filter(t => t.type === 'BUY').length,
      totalSells: trades.filter(t => t.type === 'SELL').length,
      uniqueTokens: positions.length,
      totalSolSpent: positions.reduce((sum, p) => sum + p.totalSolSpent, 0),
      totalSolReceived: positions.reduce((sum, p) => sum + p.totalSolReceived, 0),
      netPnL: positions.reduce((sum, p) => sum + p.netPnL, 0),
      winCount: totalWins,
      lossCount: totalLosses,
      winRate: (totalWins + totalLosses) > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0,
      avgWinROI: totalWins > 0 ? totalWinROI / totalWins : 0,
      avgLossROI: totalLosses > 0 ? totalLossROI / totalLosses : 0,
      avgHoldTimeHours: closedPositions > 0 ? totalHoldTime / closedPositions : 0,
      positions,
      tradingPatterns,
    };

    return analysis;
  }

  printAnalysis(analysis: WalletAnalysis): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log('WALLET ANALYSIS RESULTS');
    console.log(`${'='.repeat(60)}\n`);

    console.log(`Address: ${analysis.address}`);
    console.log(`\n--- TRADING SUMMARY ---`);
    console.log(`Total Trades: ${analysis.totalTrades} (${analysis.totalBuys} buys, ${analysis.totalSells} sells)`);
    console.log(`Unique Tokens Traded: ${analysis.uniqueTokens}`);
    console.log(`Total SOL Spent: ${analysis.totalSolSpent.toFixed(2)} SOL`);
    console.log(`Total SOL Received: ${analysis.totalSolReceived.toFixed(2)} SOL`);
    console.log(`Net PnL: ${analysis.netPnL.toFixed(2)} SOL (${analysis.netPnL >= 0 ? '+' : ''}${((analysis.netPnL / analysis.totalSolSpent) * 100).toFixed(1)}%)`);

    console.log(`\n--- WIN/LOSS STATS ---`);
    console.log(`Wins: ${analysis.winCount} | Losses: ${analysis.lossCount}`);
    console.log(`Win Rate: ${analysis.winRate.toFixed(1)}%`);
    console.log(`Avg Win ROI: +${analysis.avgWinROI.toFixed(1)}%`);
    console.log(`Avg Loss ROI: ${analysis.avgLossROI.toFixed(1)}%`);
    console.log(`Avg Hold Time: ${analysis.avgHoldTimeHours.toFixed(1)} hours`);

    console.log(`\n--- TRADING PATTERNS ---`);
    console.log(`Avg Position Size: ${analysis.tradingPatterns.avgPositionSizeSOL.toFixed(2)} SOL`);
    console.log(`Avg Trades Per Token: ${analysis.tradingPatterns.avgTradesPerToken.toFixed(1)}`);
    console.log(`Most Active Hours (UTC): ${analysis.tradingPatterns.mostActiveHours.join(', ')}`);
    console.log(`\nHold Time Distribution:`);
    console.log(`  Quick Flips (<1h): ${analysis.tradingPatterns.quickFlipRatio.toFixed(1)}%`);
    console.log(`  Medium Holds (1-24h): ${analysis.tradingPatterns.mediumHoldRatio.toFixed(1)}%`);
    console.log(`  Long Holds (>24h): ${analysis.tradingPatterns.longHoldRatio.toFixed(1)}%`);

    console.log(`\n--- TOP 10 WINNING POSITIONS ---`);
    const winners = analysis.positions.filter(p => p.netPnL > 0 && !p.isOpen).slice(0, 10);
    for (const pos of winners) {
      console.log(`  ${pos.tokenSymbol.padEnd(12)} | PnL: +${pos.netPnL.toFixed(2)} SOL | ROI: +${pos.roi.toFixed(0)}% | Hold: ${pos.holdTimeHours.toFixed(1)}h`);
    }

    console.log(`\n--- TOP 5 LOSING POSITIONS ---`);
    const losers = analysis.positions.filter(p => p.netPnL < 0 && !p.isOpen).slice(-5).reverse();
    for (const pos of losers) {
      console.log(`  ${pos.tokenSymbol.padEnd(12)} | PnL: ${pos.netPnL.toFixed(2)} SOL | ROI: ${pos.roi.toFixed(0)}% | Hold: ${pos.holdTimeHours.toFixed(1)}h`);
    }

    console.log(`\n--- OPEN POSITIONS ---`);
    const openPositions = analysis.positions.filter(p => p.isOpen);
    console.log(`Total Open: ${openPositions.length}`);
    for (const pos of openPositions.slice(0, 5)) {
      console.log(`  ${pos.tokenSymbol.padEnd(12)} | Invested: ${pos.totalSolSpent.toFixed(2)} SOL`);
    }

    // Key insights
    console.log(`\n${'='.repeat(60)}`);
    console.log('KEY INSIGHTS & STRATEGY PATTERNS');
    console.log(`${'='.repeat(60)}`);

    if (analysis.winRate > 60) {
      console.log(`\n[HIGH WIN RATE] This wallet has an exceptional ${analysis.winRate.toFixed(1)}% win rate`);
    }

    if (analysis.tradingPatterns.quickFlipRatio > 50) {
      console.log(`\n[QUICK FLIPPER] ${analysis.tradingPatterns.quickFlipRatio.toFixed(0)}% of trades are quick flips (<1h)`);
      console.log('  -> This suggests momentum/scalping strategy, entering on early pump signals');
    }

    if (analysis.tradingPatterns.avgPositionSizeSOL > 5) {
      console.log(`\n[LARGE POSITIONS] Avg position size of ${analysis.tradingPatterns.avgPositionSizeSOL.toFixed(2)} SOL`);
      console.log('  -> High conviction trader, likely doing thorough research');
    } else if (analysis.tradingPatterns.avgPositionSizeSOL < 1) {
      console.log(`\n[SMALL POSITIONS] Avg position size of ${analysis.tradingPatterns.avgPositionSizeSOL.toFixed(2)} SOL`);
      console.log('  -> Risk-managed approach, spreading across many opportunities');
    }

    if (analysis.avgWinROI > 200) {
      console.log(`\n[HIGH RETURNS] Avg winning trade returns +${analysis.avgWinROI.toFixed(0)}%`);
      console.log('  -> Likely entering very early (first minutes) or identifying strong narratives');
    }

    console.log(`\n`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution
async function main() {
  console.log('\n=== MEMECOIN WALLET ANALYZER ===\n');

  if (!HELIUS_API_KEY) {
    console.log('WARNING: HELIUS_API_KEY not set - using public Solana RPC (slower, rate limited)');
  }

  const analyzer = new WalletAnalyzer();

  try {
    const analysis = await analyzer.analyzeWallet(TARGET_WALLET);
    analyzer.printAnalysis(analysis);

    // Output JSON for further processing
    console.log('\n--- RAW DATA (JSON) ---');
    console.log(JSON.stringify({
      address: analysis.address,
      summary: {
        totalTrades: analysis.totalTrades,
        uniqueTokens: analysis.uniqueTokens,
        netPnL: analysis.netPnL,
        winRate: analysis.winRate,
        avgHoldTimeHours: analysis.avgHoldTimeHours,
      },
      patterns: analysis.tradingPatterns,
      topWinners: analysis.positions.filter(p => !p.isOpen && p.netPnL > 0).slice(0, 5).map(p => ({
        token: p.tokenSymbol,
        address: p.tokenAddress,
        pnl: p.netPnL,
        roi: p.roi,
        holdHours: p.holdTimeHours,
      })),
    }, null, 2));

  } catch (error) {
    console.error('Analysis failed:', error);
    process.exit(1);
  }
}

main();
