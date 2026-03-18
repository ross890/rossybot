import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const PUMP_FUN_PROGRAM = config.pumpFun.programId;
const PUMP_FUN_PROGRAM_KEY = new PublicKey(PUMP_FUN_PROGRAM);

/**
 * Derive the bonding curve PDA for a pump.fun token.
 * This is deterministic and always correct, unlike heuristic account-key parsing.
 */
export function deriveBondingCurveAddress(tokenMint: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(tokenMint).toBuffer()],
    PUMP_FUN_PROGRAM_KEY,
  );
  return pda.toBase58();
}

/**
 * Check if a transaction interacts with the pump.fun bonding curve program.
 * Returns the bonding curve account address if found.
 */
export function detectPumpFunInteraction(
  accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean }>,
  tokenMint?: string,
): string | null {
  // The pump.fun program ID must appear in the account keys
  const programIdx = accountKeys.findIndex((k) => k.pubkey === PUMP_FUN_PROGRAM);
  if (programIdx === -1) return null;

  // If we know the token mint, derive the exact PDA (100% reliable)
  if (tokenMint) {
    try {
      return deriveBondingCurveAddress(tokenMint);
    } catch {
      // Fall through to heuristic
    }
  }

  // Fallback heuristic: first writable non-signer that isn't a known program
  const KNOWN_PROGRAMS = new Set([
    PUMP_FUN_PROGRAM,
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // Token Program
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
    '11111111111111111111111111111111',                 // System Program
    'SysvarRent111111111111111111111111111111111',      // Rent
    'So11111111111111111111111111111111111111112',      // Wrapped SOL
  ]);

  for (const key of accountKeys) {
    if (KNOWN_PROGRAMS.has(key.pubkey)) continue;
    if (key.writable && !key.signer) {
      return key.pubkey;
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
 *
 * IMPORTANT: DexScreener lists bonding curve pairs as dexId='pumpfun' — these are NOT
 * graduated tokens. Only 'pumpswap'/'pump_swap' (post-graduation AMM) and 'raydium'
 * (legacy migration) indicate actual graduation.
 */
export async function checkGraduation(tokenMint: string, currentCurveFillPct?: number): Promise<{
  graduated: boolean;
  dexPairAddress?: string;
}> {
  try {
    const resp = await axios.get(
      `${config.dexScreener.baseUrl}/tokens/${tokenMint}`,
      { timeout: 5000 },
    );

    const pairs = resp.data?.pairs || [];

    // Only PumpSwap (post-graduation AMM) and Raydium (legacy) indicate real graduation.
    // 'pumpfun' dexId = bonding curve pair, NOT graduated.
    const dexPair = pairs.find((p: { dexId: string }) =>
      p.dexId === 'pumpswap' || p.dexId === 'pump_swap',
    ) || pairs.find((p: { dexId: string }) =>
      p.dexId === 'raydium',
    );

    if (dexPair) {
      // Safety net: if we know the curve is far from full, DexScreener is stale/wrong
      if (currentCurveFillPct !== undefined && currentCurveFillPct < 0.70) {
        logger.warn({
          token: tokenMint.slice(0, 8),
          dexId: dexPair.dexId,
          curveFill: `${(currentCurveFillPct * 100).toFixed(0)}%`,
        }, 'DexScreener says graduated but curve fill too low — ignoring false graduation');
        return { graduated: false };
      }
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
