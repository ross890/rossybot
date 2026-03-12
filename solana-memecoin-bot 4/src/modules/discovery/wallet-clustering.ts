// ===========================================
// MODULE: WALLET CLUSTERING
// Traces SOL funding sources for early buyers to detect
// coordinated wallets that share a common ancestor (bundling).
// Extends the bundle detector with real on-chain ancestry tracing.
// ===========================================

import { logger } from '../../utils/logger.js';
import { heliusClient } from '../onchain.js';

// ============ TYPES ============

export interface ClusterAnalysis {
  tokenAddress: string;
  buyersAnalyzed: number;
  clustersFound: number;           // Number of distinct wallet clusters
  largestClusterSize: number;      // Biggest cluster
  largestClusterPercent: number;   // % of analyzed buyers in largest cluster
  commonAncestors: string[];       // Shared funding source wallet addresses
  independentBuyers: number;       // Buyers with NO shared funding
  independentPercent: number;      // % of buyers that are independent
  score: number;                   // 0-100 (100 = all independent, 0 = all clustered)
  flags: string[];
}

interface FundingTrace {
  buyerAddress: string;
  fundingSources: string[];        // Wallets that sent SOL to this buyer (1-3 hops)
}

// ============ CONSTANTS ============

// How many early buyers to trace
const BUYERS_TO_TRACE = 30;

// Max hops back to trace funding (more = slower but more thorough)
const MAX_FUNDING_HOPS = 2;

// Cache funding traces
const TRACE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const TRACE_CACHE_MAX_SIZE = 1000;

// Minimum shared ancestor percentage to flag
const CLUSTER_WARNING_THRESHOLD = 30; // 30%+ of buyers sharing an ancestor = flag

// ============ WALLET CLUSTERING CLASS ============

class WalletClusteringAnalyzer {
  private traceCache: Map<string, { sources: string[]; expiry: number }> = new Map();

  /**
   * Analyze the first buyers of a token for wallet clustering.
   */
  async analyze(tokenAddress: string, earlyBuyers?: string[]): Promise<ClusterAnalysis> {
    const flags: string[] = [];

    try {
      // Get early buyers if not provided
      const buyers = earlyBuyers || await this.getEarlyBuyers(tokenAddress);

      if (buyers.length < 3) {
        return this.emptyResult(tokenAddress);
      }

      const buyersToAnalyze = buyers.slice(0, BUYERS_TO_TRACE);

      // Trace funding sources for each buyer (with caching)
      const traces: FundingTrace[] = [];
      for (const buyer of buyersToAnalyze) {
        const sources = await this.traceFundingSources(buyer);
        traces.push({ buyerAddress: buyer, fundingSources: sources });
      }

      // Find clusters: buyers that share funding sources
      const clusters = this.findClusters(traces);
      const clusterSizes = clusters.map(c => c.length);
      const largestCluster = Math.max(0, ...clusterSizes);
      const clusteredBuyerCount = clusters.reduce((sum, c) => sum + c.length, 0);
      const independentCount = buyersToAnalyze.length - clusteredBuyerCount;

      // Find the common ancestors
      const ancestorCounts = new Map<string, number>();
      for (const trace of traces) {
        for (const source of trace.fundingSources) {
          ancestorCounts.set(source, (ancestorCounts.get(source) || 0) + 1);
        }
      }

      // Ancestors that funded 2+ buyers
      const commonAncestors = Array.from(ancestorCounts.entries())
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([addr]) => addr)
        .slice(0, 5); // Top 5 ancestors

      const largestClusterPercent = buyersToAnalyze.length > 0
        ? (largestCluster / buyersToAnalyze.length) * 100
        : 0;
      const independentPercent = buyersToAnalyze.length > 0
        ? (independentCount / buyersToAnalyze.length) * 100
        : 100;

      // Build flags
      if (largestClusterPercent >= 50) flags.push(`${largestClusterPercent.toFixed(0)}% in single cluster`);
      if (commonAncestors.length >= 3) flags.push(`${commonAncestors.length} shared funding sources`);
      if (independentPercent < 40) flags.push(`Only ${independentPercent.toFixed(0)}% independent buyers`);
      if (independentPercent >= 70) flags.push(`${independentPercent.toFixed(0)}% independent — organic`);

      // Score: higher = more independent/organic
      const score = this.calculateScore(independentPercent, largestClusterPercent, clusters.length, commonAncestors.length);

      return {
        tokenAddress,
        buyersAnalyzed: buyersToAnalyze.length,
        clustersFound: clusters.length,
        largestClusterSize: largestCluster,
        largestClusterPercent,
        commonAncestors,
        independentBuyers: independentCount,
        independentPercent,
        score,
        flags,
      };
    } catch (error) {
      logger.debug({ error, tokenAddress }, 'Wallet clustering analysis failed');
      return this.emptyResult(tokenAddress);
    }
  }

  /**
   * Trace funding sources for a wallet (cached).
   * Goes back MAX_FUNDING_HOPS to find where SOL came from.
   */
  private async traceFundingSources(walletAddress: string): Promise<string[]> {
    // Check cache
    const cached = this.traceCache.get(walletAddress);
    if (cached && cached.expiry > Date.now()) {
      return cached.sources;
    }

    const sources = new Set<string>();

    try {
      // Get recent transactions for this wallet
      const txs = await heliusClient.getRecentTransactions(walletAddress, 20);
      if (!txs || txs.length === 0) {
        this.cacheTrace(walletAddress, []);
        return [];
      }

      // Look for incoming SOL transfers (native transfers to this wallet)
      for (const tx of txs) {
        if (tx.type === 'TRANSFER' || tx.type === 'SOL_TRANSFER') {
          const feePayer = tx.feePayer;
          if (feePayer && feePayer !== walletAddress) {
            sources.add(feePayer);
          }
        }

        // Also check nativeTransfers if available (Helius enhanced format)
        if (tx.nativeTransfers) {
          for (const nt of tx.nativeTransfers) {
            if (nt.toUserAccount === walletAddress && nt.fromUserAccount) {
              sources.add(nt.fromUserAccount);
            }
          }
        }
      }

      // Hop 2: For each funding source, check THEIR sources (if we have budget)
      if (MAX_FUNDING_HOPS >= 2 && sources.size > 0 && sources.size <= 5) {
        const hop1Sources = Array.from(sources).slice(0, 3); // Limit hop-2 to 3 wallets
        for (const hop1 of hop1Sources) {
          try {
            const hop2Txs = await heliusClient.getRecentTransactions(hop1, 10);
            if (hop2Txs) {
              for (const tx of hop2Txs) {
                if (tx.nativeTransfers) {
                  for (const nt of tx.nativeTransfers) {
                    if (nt.toUserAccount === hop1 && nt.fromUserAccount) {
                      sources.add(nt.fromUserAccount);
                    }
                  }
                }
              }
            }
          } catch {
            // Skip failed hop-2 traces
          }
        }
      }
    } catch (error) {
      logger.debug({ error, walletAddress: walletAddress.slice(0, 8) }, 'Funding trace failed');
    }

    const result = Array.from(sources);
    this.cacheTrace(walletAddress, result);
    return result;
  }

  /**
   * Find clusters of wallets that share funding sources.
   */
  private findClusters(traces: FundingTrace[]): string[][] {
    // Build adjacency: two buyers are connected if they share a funding source
    const connections = new Map<string, Set<string>>();

    for (let i = 0; i < traces.length; i++) {
      for (let j = i + 1; j < traces.length; j++) {
        const shared = traces[i].fundingSources.filter(s =>
          traces[j].fundingSources.includes(s)
        );
        if (shared.length > 0) {
          const connI = connections.get(traces[i].buyerAddress) || new Set();
          connI.add(traces[j].buyerAddress);
          connections.set(traces[i].buyerAddress, connI);

          const connJ = connections.get(traces[j].buyerAddress) || new Set();
          connJ.add(traces[i].buyerAddress);
          connections.set(traces[j].buyerAddress, connJ);
        }
      }
    }

    // BFS to find connected components (clusters)
    const visited = new Set<string>();
    const clusters: string[][] = [];

    for (const trace of traces) {
      const addr = trace.buyerAddress;
      if (visited.has(addr) || !connections.has(addr)) continue;

      const cluster: string[] = [];
      const queue = [addr];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        cluster.push(current);

        const neighbors = connections.get(current);
        if (neighbors) {
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) queue.push(neighbor);
          }
        }
      }

      if (cluster.length >= 2) { // Only count clusters of 2+
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  private getEarlyBuyers(tokenAddress: string): Promise<string[]> {
    return heliusClient.getRecentTransactions(tokenAddress, 50).then(txs => {
      if (!txs || txs.length === 0) return [];
      const buyers = new Set<string>();
      const sorted = txs.sort((a: any, b: any) => (a.slot || 0) - (b.slot || 0));
      for (const tx of sorted) {
        if (tx.feePayer && buyers.size < BUYERS_TO_TRACE) {
          buyers.add(tx.feePayer);
        }
      }
      return Array.from(buyers);
    }).catch(() => []);
  }

  private calculateScore(
    independentPercent: number,
    largestClusterPercent: number,
    clusterCount: number,
    ancestorCount: number
  ): number {
    let score = 50; // Start neutral

    // Independent buyer ratio (biggest factor)
    if (independentPercent >= 80) score += 30;
    else if (independentPercent >= 60) score += 15;
    else if (independentPercent < 40) score -= 25;
    else if (independentPercent < 20) score -= 40;

    // Largest cluster penalty
    if (largestClusterPercent >= 50) score -= 25;
    else if (largestClusterPercent >= 30) score -= 10;

    // Multiple clusters = more coordinated
    if (clusterCount >= 3) score -= 10;

    // Many common ancestors = systematic coordination
    if (ancestorCount >= 5) score -= 15;
    else if (ancestorCount >= 3) score -= 5;

    return Math.max(0, Math.min(100, score));
  }

  private cacheTrace(address: string, sources: string[]): void {
    if (this.traceCache.size >= TRACE_CACHE_MAX_SIZE) {
      const oldest = this.traceCache.keys().next().value;
      if (oldest) this.traceCache.delete(oldest);
    }
    this.traceCache.set(address, { sources, expiry: Date.now() + TRACE_CACHE_TTL_MS });
  }

  private emptyResult(tokenAddress: string): ClusterAnalysis {
    return {
      tokenAddress,
      buyersAnalyzed: 0,
      clustersFound: 0,
      largestClusterSize: 0,
      largestClusterPercent: 0,
      commonAncestors: [],
      independentBuyers: 0,
      independentPercent: 100, // Assume organic when no data
      score: 50,
      flags: ['No clustering data available'],
    };
  }
}

export const walletClustering = new WalletClusteringAnalyzer();
