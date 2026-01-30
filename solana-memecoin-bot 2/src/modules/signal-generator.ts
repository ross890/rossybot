// ===========================================
// SIGNAL GENERATION ENGINE
// ===========================================

import { appConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { Database } from '../utils/database.js';
import {
  getTokenMetrics,
  calculateVolumeAuthenticity,
  birdeyeClient,
} from './onchain.js';
import { scamFilter, quickScamCheck } from './scam-filter.js';
import { kolWalletMonitor } from './kol-tracker.js';
import { scoringEngine } from './scoring.js';
import { telegramBot } from './telegram.js';
import type {
  TokenMetrics,
  SocialMetrics,
  BuySignal,
  SignalType,
  KolWalletActivity,
} from '../types/index.js';

// ============ CONFIGURATION ============

const SCAN_INTERVAL_MS = 60 * 1000; // 1 minute
const KOL_ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// ============ SIGNAL GENERATOR CLASS ============

export class SignalGenerator {
  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;
  
  /**
   * Initialize the signal generator
   */
  async initialize(): Promise<void> {
    logger.info('Initializing signal generator...');
    
    // Initialize KOL wallet monitor
    await kolWalletMonitor.initialize();
    
    // Initialize Telegram bot
    await telegramBot.initialize();
    
    logger.info('Signal generator initialized');
  }
  
  /**
   * Start the main scanning loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Signal generator already running');
      return;
    }
    
    this.isRunning = true;
    logger.info('Starting signal generation loop');
    
    // Run immediately, then on interval
    this.runScanCycle();
    this.scanTimer = setInterval(() => this.runScanCycle(), SCAN_INTERVAL_MS);
  }
  
  /**
   * Stop the scanning loop
   */
  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    
    logger.info('Signal generator stopped');
  }
  
  /**
   * Run a single scan cycle
   */
  private async runScanCycle(): Promise<void> {
    try {
      logger.debug('Starting scan cycle');
      
      // Step 1: Get candidate tokens (new listings + active tokens)
      const candidates = await this.getCandidateTokens();
      logger.debug({ count: candidates.length }, 'Found candidate tokens');
      
      // Step 2: Quick pre-filter (contract checks)
      const preFiltered: string[] = [];
      for (const address of candidates) {
        const quickCheck = await quickScamCheck(address);
        if (quickCheck.pass) {
          preFiltered.push(address);
        }
      }
      logger.debug({ count: preFiltered.length }, 'Tokens passed quick filter');
      
      // Step 3: Check for KOL activity on each token
      for (const tokenAddress of preFiltered) {
        try {
          await this.evaluateToken(tokenAddress);
        } catch (error) {
          logger.error({ error, tokenAddress }, 'Error evaluating token');
        }
      }
      
      logger.debug('Scan cycle complete');
    } catch (error) {
      logger.error({ error }, 'Error in scan cycle');
    }
  }
  
  /**
   * Get candidate tokens to evaluate
   */
  private async getCandidateTokens(): Promise<string[]> {
    const candidates: Set<string> = new Set();
    
    try {
      // Get new listings from Birdeye
      const newListings = await birdeyeClient.getNewListings(50);
      
      for (const listing of newListings) {
        if (listing.address) {
          candidates.add(listing.address);
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to get new listings');
    }
    
    // Also check tokens that KOLs have recently interacted with
    // This would require additional tracking infrastructure
    
    return Array.from(candidates);
  }
  
  /**
   * Fully evaluate a single token
   */
  private async evaluateToken(tokenAddress: string): Promise<void> {
    // Check if we already have an open position
    if (await Database.hasOpenPosition(tokenAddress)) {
      logger.debug({ tokenAddress }, 'Already have open position - skipping');
      return;
    }
    
    // Get KOL activity for this token
    const kolActivities = await kolWalletMonitor.getKolActivityForToken(
      tokenAddress,
      KOL_ACTIVITY_WINDOW_MS
    );
    
    if (kolActivities.length === 0) {
      // No KOL activity - skip (we only signal on confirmed KOL buys)
      return;
    }
    
    logger.info({ tokenAddress, kolCount: kolActivities.length }, 'KOL activity detected');
    
    // Get comprehensive token data
    const metrics = await getTokenMetrics(tokenAddress);
    if (!metrics) {
      logger.debug({ tokenAddress }, 'Could not get token metrics');
      return;
    }
    
    // Check if token meets minimum screening criteria
    if (!this.meetsScreeningCriteria(metrics)) {
      logger.debug({ tokenAddress, metrics }, 'Token does not meet screening criteria');
      return;
    }
    
    // Run full scam filter
    const scamResult = await scamFilter.filterToken(tokenAddress);
    if (scamResult.result === 'REJECT') {
      logger.info({ tokenAddress, flags: scamResult.flags }, 'Token rejected by scam filter');
      return;
    }
    
    // Get social metrics (simplified - would need Twitter API integration)
    const socialMetrics = await this.getSocialMetrics(tokenAddress, metrics);
    
    // Get volume authenticity
    const volumeAuthenticity = await calculateVolumeAuthenticity(tokenAddress);
    
    // Calculate score
    const score = scoringEngine.calculateScore(
      tokenAddress,
      metrics,
      socialMetrics,
      volumeAuthenticity,
      scamResult,
      kolActivities
    );
    
    // Check if meets buy requirements
    const buyCheck = scoringEngine.meetsBuyRequirements(score, kolActivities);
    
    if (!buyCheck.meets) {
      logger.debug({ tokenAddress, reason: buyCheck.reason }, 'Token does not meet buy requirements');
      return;
    }
    
    // Generate and send buy signal
    const signal = this.buildBuySignal(
      tokenAddress,
      metrics,
      socialMetrics,
      volumeAuthenticity,
      scamResult,
      score,
      kolActivities[0] // Primary KOL activity
    );
    
    await telegramBot.sendBuySignal(signal);
  }
  
  /**
   * Check if token meets minimum screening criteria
   */
  private meetsScreeningCriteria(metrics: TokenMetrics): boolean {
    const cfg = appConfig.screening;
    
    if (metrics.marketCap < cfg.minMarketCap || metrics.marketCap > cfg.maxMarketCap) {
      return false;
    }
    
    if (metrics.volume24h < cfg.min24hVolume) {
      return false;
    }
    
    if (metrics.volumeMarketCapRatio < cfg.minVolumeMarketCapRatio) {
      return false;
    }
    
    if (metrics.holderCount < cfg.minHolderCount) {
      return false;
    }
    
    if (metrics.top10Concentration > cfg.maxTop10Concentration) {
      return false;
    }
    
    if (metrics.liquidityPool < cfg.minLiquidityPool) {
      return false;
    }
    
    if (metrics.tokenAge < cfg.minTokenAgeMinutes) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Get social metrics (simplified implementation)
   */
  private async getSocialMetrics(
    _tokenAddress: string,
    metrics: TokenMetrics
  ): Promise<SocialMetrics> {
    // This would integrate with Twitter API in production
    // For now, return placeholder data
    return {
      mentionVelocity1h: 0,
      engagementQuality: 0.5,
      accountAuthenticity: 0.7,
      sentimentPolarity: 0.2,
      kolMentionDetected: false,
      kolMentions: [],
      narrativeFit: this.detectNarrative(metrics),
    };
  }
  
  /**
   * Detect narrative theme from token name/ticker
   */
  private detectNarrative(metrics: TokenMetrics): string | null {
    const name = (metrics.name + ' ' + metrics.ticker).toLowerCase();
    
    if (name.includes('ai') || name.includes('agent') || name.includes('gpt')) {
      return 'AI / Agents';
    }
    if (name.includes('trump') || name.includes('maga') || name.includes('biden')) {
      return 'Political';
    }
    if (name.includes('pepe') || name.includes('doge') || name.includes('shib')) {
      return 'Classic Meme';
    }
    if (name.includes('cat') || name.includes('dog') || name.includes('frog')) {
      return 'Animal';
    }
    
    return null;
  }
  
  /**
   * Build the complete buy signal object
   */
  private buildBuySignal(
    tokenAddress: string,
    metrics: TokenMetrics,
    socialMetrics: SocialMetrics,
    volumeAuthenticity: any,
    scamResult: any,
    score: any,
    primaryKolActivity: KolWalletActivity
  ): BuySignal {
    const price = metrics.price;
    
    // Calculate position size based on score and flags
    let positionSize = appConfig.trading.defaultPositionSizePercent;
    if (score.compositeScore >= 90) positionSize *= 1.5;
    else if (score.compositeScore >= 80) positionSize *= 1.25;
    if (score.flags.includes('LOW_LIQUIDITY')) positionSize *= 0.5;
    if (score.flags.includes('NEW_TOKEN')) positionSize *= 0.75;
    if (score.flags.includes('SIDE_ONLY')) positionSize *= 0.75;
    positionSize = Math.min(positionSize, 3); // Cap at 3%
    
    return {
      id: `sig_${Date.now()}_${tokenAddress.slice(0, 8)}`,
      tokenAddress,
      tokenTicker: metrics.ticker,
      tokenName: metrics.name,
      
      score,
      tokenMetrics: metrics,
      socialMetrics,
      volumeAuthenticity,
      scamFilter: scamResult,
      
      kolActivity: primaryKolActivity,
      
      entryZone: {
        low: price * 0.95,
        high: price * 1.05,
      },
      positionSizePercent: Math.round(positionSize * 10) / 10,
      stopLoss: {
        price: price * 0.7,
        percent: 30,
      },
      takeProfit1: {
        price: price * 1.5,
        percent: 50,
      },
      takeProfit2: {
        price: price * 2.5,
        percent: 150,
      },
      timeLimitHours: 72,
      
      generatedAt: new Date(),
      signalType: SignalType.BUY,
    };
  }
}

// ============ EXPORTS ============

export const signalGenerator = new SignalGenerator();

export default {
  SignalGenerator,
  signalGenerator,
};
