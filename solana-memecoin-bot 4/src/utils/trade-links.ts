// ===========================================
// UTILITY: TRADE LINKS (Feature 6)
// One-Click Trade Links for Telegram
// ===========================================

// ============ LINK GENERATORS ============

/**
 * Generate Jupiter swap link
 */
export function getJupiterLink(tokenMint: string): string {
  return `https://jup.ag/swap/SOL-${tokenMint}`;
}

/**
 * Generate Raydium swap link
 */
export function getRaydiumLink(tokenMint: string): string {
  return `https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${tokenMint}`;
}

/**
 * Generate DexScreener link
 */
export function getDexScreenerLink(tokenMint: string): string {
  return `https://dexscreener.com/solana/${tokenMint}`;
}

/**
 * Generate RugCheck link
 */
export function getRugCheckLink(tokenMint: string): string {
  return `https://rugcheck.xyz/tokens/${tokenMint}`;
}

/**
 * Generate Birdeye link
 */
export function getBirdeyeLink(tokenMint: string): string {
  return `https://birdeye.so/token/${tokenMint}?chain=solana`;
}

/**
 * Generate Solscan token link
 */
export function getSolscanTokenLink(tokenMint: string): string {
  return `https://solscan.io/token/${tokenMint}`;
}

/**
 * Generate Solscan account link
 */
export function getSolscanAccountLink(walletAddress: string): string {
  return `https://solscan.io/account/${walletAddress}`;
}

/**
 * Generate Pump.fun link
 */
export function getPumpfunLink(tokenMint: string): string {
  return `https://pump.fun/${tokenMint}`;
}

/**
 * Generate Photon link (popular Solana trading terminal)
 */
export function getPhotonLink(tokenMint: string): string {
  return `https://photon-sol.tinyastro.io/en/lp/${tokenMint}`;
}

/**
 * Generate BullX link
 */
export function getBullXLink(tokenMint: string): string {
  return `https://bullx.io/terminal?chainId=1399811149&address=${tokenMint}`;
}

// ============ LINK COLLECTIONS ============

export interface TradeLinks {
  jupiter: string;
  raydium: string;
  dexscreener: string;
  rugcheck: string;
  birdeye: string;
  solscan: string;
  pumpfun: string;
  photon: string;
  bullx: string;
}

/**
 * Get all trade links for a token
 */
export function getAllTradeLinks(tokenMint: string): TradeLinks {
  return {
    jupiter: getJupiterLink(tokenMint),
    raydium: getRaydiumLink(tokenMint),
    dexscreener: getDexScreenerLink(tokenMint),
    rugcheck: getRugCheckLink(tokenMint),
    birdeye: getBirdeyeLink(tokenMint),
    solscan: getSolscanTokenLink(tokenMint),
    pumpfun: getPumpfunLink(tokenMint),
    photon: getPhotonLink(tokenMint),
    bullx: getBullXLink(tokenMint),
  };
}

// ============ TELEGRAF INLINE KEYBOARD HELPERS ============

export interface InlineButton {
  text: string;
  url: string;
}

/**
 * Get inline keyboard buttons for Telegram
 * Returns array of button rows
 */
export function getInlineKeyboardButtons(tokenMint: string): InlineButton[][] {
  const links = getAllTradeLinks(tokenMint);

  return [
    // Row 1: Trading links
    [
      { text: 'Jupiter', url: links.jupiter },
      { text: 'Raydium', url: links.raydium },
      { text: 'Photon', url: links.photon },
    ],
    // Row 2: Analysis links
    [
      { text: 'DexScreener', url: links.dexscreener },
      { text: 'Birdeye', url: links.birdeye },
      { text: 'RugCheck', url: links.rugcheck },
    ],
    // Row 3: Explorer
    [
      { text: 'Solscan', url: links.solscan },
    ],
  ];
}

/**
 * Format links as markdown text (fallback for non-button display)
 */
export function formatLinksAsMarkdown(tokenMint: string): string {
  const links = getAllTradeLinks(tokenMint);

  return [
    `[Jupiter](${links.jupiter})`,
    `[Raydium](${links.raydium})`,
    `[DexScreener](${links.dexscreener})`,
    `[RugCheck](${links.rugcheck})`,
    `[Birdeye](${links.birdeye})`,
  ].join(' | ');
}

/**
 * Create Telegram inline_keyboard array compatible with node-telegram-bot-api
 */
export function createTelegramInlineKeyboard(tokenMint: string): { inline_keyboard: Array<Array<{ text: string; url: string }>> } {
  return {
    inline_keyboard: getInlineKeyboardButtons(tokenMint),
  };
}

export default {
  getJupiterLink,
  getRaydiumLink,
  getDexScreenerLink,
  getRugCheckLink,
  getBirdeyeLink,
  getSolscanTokenLink,
  getSolscanAccountLink,
  getPumpfunLink,
  getPhotonLink,
  getBullXLink,
  getAllTradeLinks,
  getInlineKeyboardButtons,
  formatLinksAsMarkdown,
  createTelegramInlineKeyboard,
};
