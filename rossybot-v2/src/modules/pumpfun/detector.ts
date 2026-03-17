import axios from 'axios';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const PUMP_FUN_PROGRAM = config.pumpFun.programId;

/**
 * Check if a transaction interacts with the pump.fun bonding curve program.
 * Returns the bonding curve account address if found.
 */
export function detectPumpFunInteraction(
  accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean }>,
): string | null {
  // The pump.fun program ID must appear in the account keys
  const programIdx = accountKeys.findIndex((k) => k.pubkey === PUMP_FUN_PROGRAM);
  if (programIdx === -1) return null;

  // The bonding curve account is typically the first writable non-signer after the program
  // In pump.fun buy transactions: [user, bondingCurve, ..., program]
  // Find the first writable non-signer that isn't the program itself
  for (const key of accountKeys) {
    if (key.pubkey === PUMP_FUN_PROGRAM) continue;
    if (key.writable && !key.signer) {
      return key.pubkey; // bonding curve account
    }
  }

  return 'unknown';
}

/**
 * Fetch bonding curve state from RPC.
 * Returns SOL balance (proxy for curve progress) and creation slot.
 */
export async function fetchCurveState(
  bondingCurveAddress: string,
): Promise<{ solBalance: number; exists: boolean } | null> {
  try {
    const resp = await axios.post(config.helius.rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [bondingCurveAddress, { encoding: 'base64' }],
    }, { timeout: 5000 });

    const accountInfo = resp.data?.result?.value;
    if (!accountInfo) return { solBalance: 0, exists: false };

    const solBalance = (accountInfo.lamports || 0) / 1e9;
    return { solBalance, exists: true };
  } catch (err) {
    logger.error({ err, curve: bondingCurveAddress.slice(0, 8) }, 'Failed to fetch curve state');
    return null;
  }
}

/**
 * Check if a token has graduated from pump.fun's bonding curve to a DEX.
 * Since March 2025, pump.fun migrates graduated tokens to PumpSwap (their own AMM)
 * instead of Raydium. We check for both PumpSwap and Raydium pairs on DexScreener.
 */
export async function checkGraduation(tokenMint: string): Promise<{
  graduated: boolean;
  dexPairAddress?: string;
}> {
  try {
    const resp = await axios.get(
      `${config.dexScreener.baseUrl}/tokens/${tokenMint}`,
      { timeout: 5000 },
    );

    const pairs = resp.data?.pairs || [];

    // Check PumpSwap first (current default), then Raydium (legacy)
    const dexPair = pairs.find((p: { dexId: string }) =>
      p.dexId === 'pumpswap' || p.dexId === 'pump_swap' || p.dexId === 'pumpfun',
    ) || pairs.find((p: { dexId: string }) =>
      p.dexId === 'raydium',
    );

    if (dexPair) {
      return { graduated: true, dexPairAddress: dexPair.pairAddress };
    }

    return { graduated: false };
  } catch {
    return { graduated: false };
  }
}

/**
 * Estimate bonding curve fill percentage.
 * Pump.fun curves graduate at ~85 SOL in the bonding curve.
 */
export function estimateCurveFillPct(solBalance: number): number {
  const GRADUATION_THRESHOLD_SOL = 85;
  return Math.min(solBalance / GRADUATION_THRESHOLD_SOL, 1.0);
}
