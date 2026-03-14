// ===========================================
// NANSEN TOKEN FLOW ENRICHMENT — INTEGRATION 3
// Enriches token scoring with Nansen smart money flow data
// Async parallel enrichment during signal evaluation
// ===========================================

import { logger } from '../utils/logger.js';
import { nansenClient } from './nansenClient.js';

// ============ TYPES ============

export interface NansenFlowData {
  smartTraderNetFlow: number;
  smartTraderWalletCount: number;
  whaleNetFlow: number;
  whaleWalletCount: number;
  freshWalletNetFlow: number;
  freshWalletCount: number;
  exchangeNetFlow: number; // negative = accumulating off exchange (bullish)
}

interface NansenFlowResponse {
  data?: Array<{
    smart_trader_net_flow_usd?: number;
    smart_trader_wallet_count?: number;
    whale_net_flow_usd?: number;
    whale_wallet_count?: number;
    fresh_wallets_net_flow_usd?: number;
    fresh_wallets_wallet_count?: number;
    exchange_net_flow_usd?: number;
  }>;
}

// ============ ENRICHMENT FUNCTIONS ============

/**
 * Fetch Nansen flow intelligence for a token
 * Returns null if unavailable (graceful degradation)
 */
export async function enrichWithNansenFlows(tokenAddress: string): Promise<NansenFlowData | null> {
  if (!nansenClient.isConfigured()) return null;

  try {
    const flowData = await nansenClient.post<NansenFlowResponse>(
      '/tgm/flow-intelligence',
      {
        chain: 'solana',
        token_address: tokenAddress,
        timeframe: '24h',
      },
      1, // 1 credit
    );

    if (!flowData?.data?.[0]) return null;

    const flow = flowData.data[0];

    return {
      smartTraderNetFlow: flow.smart_trader_net_flow_usd || 0,
      smartTraderWalletCount: flow.smart_trader_wallet_count || 0,
      whaleNetFlow: flow.whale_net_flow_usd || 0,
      whaleWalletCount: flow.whale_wallet_count || 0,
      freshWalletNetFlow: flow.fresh_wallets_net_flow_usd || 0,
      freshWalletCount: flow.fresh_wallets_wallet_count || 0,
      exchangeNetFlow: flow.exchange_net_flow_usd || 0,
    };
  } catch (error) {
    logger.debug({ error, token: tokenAddress.slice(0, 8) }, 'NansenFlowEnrichment: Error fetching flow data');
    return null;
  }
}

/**
 * Calculate scoring bonus from Nansen flow data
 * Clamped to ±15 points
 */
export function calculateNansenFlowBonus(flowData: NansenFlowData | null): number {
  if (!flowData) return 0;

  let bonus = 0;

  // Smart trader inflow is the strongest signal
  if (flowData.smartTraderNetFlow > 0 && flowData.smartTraderWalletCount >= 3) {
    bonus += 10; // 3+ smart traders buying = high conviction
  } else if (flowData.smartTraderNetFlow > 0 && flowData.smartTraderWalletCount >= 1) {
    bonus += 5; // at least 1 smart trader buying
  }

  // Whale accumulation
  if (flowData.whaleNetFlow > 0 && flowData.whaleWalletCount >= 1) {
    bonus += 5;
  }

  // Exchange outflow (tokens leaving exchanges = accumulation, bullish)
  if (flowData.exchangeNetFlow < -1000) {
    bonus += 3;
  }

  // NEGATIVE SIGNALS

  // Smart money selling
  if (flowData.smartTraderNetFlow < 0 && flowData.smartTraderWalletCount >= 2) {
    bonus -= 10; // multiple smart traders exiting = bail
  }

  // Exchange inflow (tokens moving TO exchanges = distribution, bearish)
  if (flowData.exchangeNetFlow > 5000) {
    bonus -= 5;
  }

  // Excessive fresh wallets with no smart money (likely fake/sybil)
  if (flowData.freshWalletCount > 50 && flowData.smartTraderWalletCount === 0) {
    bonus -= 5;
  }

  return Math.max(-15, Math.min(15, bonus));
}

/**
 * Fetch flow data with a timeout for use in parallel scoring
 * Returns null if timeout or error
 */
export async function enrichWithTimeout(tokenAddress: string, timeoutMs: number = 5000): Promise<NansenFlowData | null> {
  try {
    const result = await Promise.race([
      enrichWithNansenFlows(tokenAddress),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return result;
  } catch {
    return null;
  }
}

export default {
  enrichWithNansenFlows,
  calculateNansenFlowBonus,
  enrichWithTimeout,
};
