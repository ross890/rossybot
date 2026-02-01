// ===========================================
// SOCIAL METRICS ANALYZER
// Comprehensive social signal analysis for token evaluation
// Calculates velocity, sentiment, engagement, and authenticity
// ===========================================

import { logger } from '../../utils/logger.js';
import { twitterClient, Tweet, TwitterUser, SearchResult } from './twitter-client.js';
import { SocialMetrics, KolMention } from '../../types/index.js';

// ============ TYPES ============

export interface DetailedSocialMetrics extends SocialMetrics {
  // Extended metrics
  mentionCount1h: number;
  mentionCount24h: number;
  velocityTrend: 'ACCELERATING' | 'STABLE' | 'DECELERATING';

  // Engagement details
  totalEngagement: number;
  avgEngagementPerTweet: number;
  engagementTrend: 'INCREASING' | 'STABLE' | 'DECREASING';
  viralTweetCount: number;  // Tweets with >100 engagements

  // Account analysis
  avgFollowerCount: number;
  verifiedMentionCount: number;
  suspiciousAccountRatio: number;
  newAccountRatio: number;  // Accounts < 30 days old

  // Sentiment breakdown
  positiveMentions: number;
  negativeMentions: number;
  neutralMentions: number;
  sentimentConfidence: number;

  // KOL analysis
  kolHandles: string[];
  kolTotalFollowers: number;
  kolSentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH';

  // Timing
  peakMentionHour: number;
  isCurrentlyTrending: boolean;

  // Raw data
  recentTweets: Tweet[];
  analyzedAt: Date;
}

export interface SocialScore {
  total: number;  // 0-100
  breakdown: {
    velocity: number;       // 0-25: Mention acceleration
    engagement: number;     // 0-25: Quality of engagement
    authenticity: number;   // 0-25: Account quality
    sentiment: number;      // 0-25: Positive sentiment
  };
  signals: string[];
  warnings: string[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

interface SentimentResult {
  score: number;  // -1 to 1
  positive: number;
  negative: number;
  neutral: number;
  confidence: number;
}

// ============ CONSTANTS ============

// Known crypto KOLs on Twitter (would be expanded in production)
const KNOWN_KOLS = new Map<string, { tier: 'S' | 'A' | 'B' | 'C'; minFollowers: number }>([
  // Tier S - Major influencers (>500k followers)
  ['ansaboricua', { tier: 'S', minFollowers: 500000 }],
  ['blloxxberg', { tier: 'S', minFollowers: 500000 }],
  ['cryptowendyo', { tier: 'S', minFollowers: 300000 }],
  ['girlgone_crypto', { tier: 'S', minFollowers: 300000 }],
  ['moonoverlord', { tier: 'S', minFollowers: 400000 }],
  ['cryptogems555', { tier: 'S', minFollowers: 300000 }],

  // Tier A - Large influencers (100k-500k)
  ['deaboricua', { tier: 'A', minFollowers: 100000 }],
  ['cryptowizardd', { tier: 'A', minFollowers: 150000 }],
  ['solanalegend', { tier: 'A', minFollowers: 100000 }],
  ['0xsun', { tier: 'A', minFollowers: 200000 }],
  ['degenspartan', { tier: 'A', minFollowers: 150000 }],

  // Tier B - Mid influencers (30k-100k)
  ['solanashuffle', { tier: 'B', minFollowers: 50000 }],
  ['soldegen', { tier: 'B', minFollowers: 40000 }],
  ['memecoinmaxi', { tier: 'B', minFollowers: 30000 }],
  ['0xsleuth', { tier: 'B', minFollowers: 35000 }],

  // Tier C - Micro influencers (10k-30k)
  ['solanahunter', { tier: 'C', minFollowers: 15000 }],
  ['pumpfunalpha', { tier: 'C', minFollowers: 10000 }],
]);

// Sentiment keywords (weighted)
const SENTIMENT_KEYWORDS = {
  bullish: [
    { word: 'moon', weight: 0.8 },
    { word: '100x', weight: 0.9 },
    { word: 'gem', weight: 0.7 },
    { word: 'bullish', weight: 0.9 },
    { word: 'pump', weight: 0.6 },
    { word: 'buy', weight: 0.5 },
    { word: 'ape', weight: 0.7 },
    { word: 'send it', weight: 0.8 },
    { word: 'lfg', weight: 0.8 },
    { word: 'alpha', weight: 0.7 },
    { word: 'early', weight: 0.6 },
    { word: 'degen', weight: 0.5 },
    { word: 'fire', weight: 0.6 },
    { word: 'rocket', weight: 0.7 },
    { word: 'lambo', weight: 0.6 },
    { word: 'wagmi', weight: 0.7 },
    { word: 'generational', weight: 0.9 },
  ],
  bearish: [
    { word: 'scam', weight: -0.9 },
    { word: 'rug', weight: -1.0 },
    { word: 'dump', weight: -0.8 },
    { word: 'sell', weight: -0.5 },
    { word: 'avoid', weight: -0.7 },
    { word: 'ponzi', weight: -0.9 },
    { word: 'honeypot', weight: -1.0 },
    { word: 'fake', weight: -0.8 },
    { word: 'dead', weight: -0.7 },
    { word: 'ngmi', weight: -0.6 },
    { word: 'rekt', weight: -0.7 },
    { word: 'exit scam', weight: -1.0 },
    { word: 'insider', weight: -0.6 },
    { word: 'bundled', weight: -0.7 },
    { word: 'dev sold', weight: -0.9 },
  ],
};

// Thresholds for scoring
const THRESHOLDS = {
  // Velocity (mentions per hour)
  EXCELLENT_VELOCITY: 50,
  GOOD_VELOCITY: 20,
  MIN_VELOCITY: 5,

  // Engagement per tweet
  EXCELLENT_ENGAGEMENT: 100,
  GOOD_ENGAGEMENT: 30,
  MIN_ENGAGEMENT: 5,

  // Account quality
  MIN_FOLLOWER_AVG: 500,
  SUSPICIOUS_ACCOUNT_MAX_RATIO: 0.5,

  // Viral threshold
  VIRAL_ENGAGEMENT: 100,

  // KOL impact
  KOL_S_MULTIPLIER: 2.0,
  KOL_A_MULTIPLIER: 1.5,
  KOL_B_MULTIPLIER: 1.2,
  KOL_C_MULTIPLIER: 1.1,
} as const;

// ============ SOCIAL ANALYZER CLASS ============

export class SocialAnalyzer {
  private metricsCache: Map<string, { data: DetailedSocialMetrics; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 2 * 60 * 1000; // 2 minute cache

  /**
   * Initialize the analyzer (ensures Twitter client is ready)
   */
  async initialize(): Promise<boolean> {
    return twitterClient.initialize();
  }

  /**
   * Get comprehensive social metrics for a token
   */
  async analyzeToken(
    tokenAddress: string,
    ticker: string,
    tokenName?: string
  ): Promise<DetailedSocialMetrics | null> {
    // Check cache
    const cacheKey = `${tokenAddress}:${ticker}`;
    const cached = this.metricsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      // Fetch tweets for different time windows in parallel
      const [tweets1h, tweets24h] = await Promise.all([
        twitterClient.searchTokenMentions(ticker, tokenName, tokenAddress, {
          maxResults: 100,
          hoursBack: 1,
        }),
        twitterClient.searchTokenMentions(ticker, tokenName, tokenAddress, {
          maxResults: 100,
          hoursBack: 24,
        }),
      ]);

      if (!tweets24h || tweets24h.tweets.length === 0) {
        // No social presence - return empty metrics
        return this.buildEmptyMetrics(ticker);
      }

      // Get unique author IDs for user analysis
      const authorIds = [...new Set(tweets24h.tweets.map(t => t.authorId))];
      const users = await twitterClient.getUsersByIds(authorIds.slice(0, 100));

      // Calculate all metrics
      const metrics = await this.calculateMetrics(
        tweets1h?.tweets || [],
        tweets24h.tweets,
        users,
        ticker
      );

      // Cache the result
      this.metricsCache.set(cacheKey, { data: metrics, timestamp: Date.now() });

      logger.debug({
        ticker,
        mentionCount1h: metrics.mentionCount1h,
        mentionVelocity: metrics.mentionVelocity1h,
        sentiment: metrics.sentimentPolarity,
        kolMentions: metrics.kolMentions.length,
      }, 'Social metrics analyzed');

      return metrics;
    } catch (error) {
      logger.error({ error, ticker }, 'Failed to analyze social metrics');
      return this.buildEmptyMetrics(ticker);
    }
  }

  /**
   * Calculate social score from metrics
   */
  calculateScore(metrics: DetailedSocialMetrics): SocialScore {
    const breakdown = {
      velocity: this.scoreVelocity(metrics),
      engagement: this.scoreEngagement(metrics),
      authenticity: this.scoreAuthenticity(metrics),
      sentiment: this.scoreSentiment(metrics),
    };

    const total = breakdown.velocity + breakdown.engagement +
                  breakdown.authenticity + breakdown.sentiment;

    const { signals, warnings } = this.detectPatterns(metrics);
    const confidence = this.determineConfidence(metrics, warnings);

    return {
      total: Math.round(total),
      breakdown,
      signals,
      warnings,
      confidence,
    };
  }

  /**
   * Get simplified SocialMetrics for backward compatibility
   */
  async getSocialMetrics(
    tokenAddress: string,
    ticker: string,
    tokenName?: string
  ): Promise<SocialMetrics> {
    const detailed = await this.analyzeToken(tokenAddress, ticker, tokenName);

    if (!detailed) {
      return this.buildEmptySocialMetrics();
    }

    return {
      mentionVelocity1h: detailed.mentionVelocity1h,
      engagementQuality: detailed.engagementQuality,
      accountAuthenticity: detailed.accountAuthenticity,
      sentimentPolarity: detailed.sentimentPolarity,
      kolMentionDetected: detailed.kolMentionDetected,
      kolMentions: detailed.kolMentions,
      narrativeFit: detailed.narrativeFit,
    };
  }

  // ============ METRIC CALCULATIONS ============

  private async calculateMetrics(
    tweets1h: Tweet[],
    tweets24h: Tweet[],
    users: Map<string, TwitterUser>,
    ticker: string
  ): Promise<DetailedSocialMetrics> {
    // Attach user data to tweets
    for (const tweet of tweets24h) {
      tweet.author = users.get(tweet.authorId);
    }
    for (const tweet of tweets1h) {
      tweet.author = users.get(tweet.authorId);
    }

    // Calculate velocity
    const mentionCount1h = tweets1h.length;
    const mentionCount24h = tweets24h.length;
    const mentionVelocity1h = mentionCount1h; // mentions per hour
    const velocityTrend = this.calculateVelocityTrend(tweets24h);

    // Calculate engagement
    const { totalEngagement, avgEngagement, engagementTrend, viralCount } =
      this.calculateEngagementMetrics(tweets24h);
    const engagementQuality = this.calculateEngagementQuality(tweets24h, users);

    // Calculate account authenticity
    const { authenticity, avgFollowers, verifiedCount, suspiciousRatio, newAccountRatio } =
      this.calculateAccountMetrics(tweets24h, users);

    // Calculate sentiment
    const sentiment = this.analyzeSentiment(tweets24h);

    // Detect KOL mentions
    const { kolMentions, kolHandles, kolFollowers, kolSentiment } =
      this.detectKolMentions(tweets24h, users);

    // Detect narrative
    const narrativeFit = this.detectNarrative(tweets24h, ticker);

    // Calculate peak hour
    const peakHour = this.findPeakMentionHour(tweets24h);

    // Is currently trending (high recent activity)
    const isCurrentlyTrending = mentionVelocity1h > THRESHOLDS.GOOD_VELOCITY &&
                                velocityTrend === 'ACCELERATING';

    return {
      // Core SocialMetrics fields
      mentionVelocity1h,
      engagementQuality,
      accountAuthenticity: authenticity,
      sentimentPolarity: sentiment.score,
      kolMentionDetected: kolMentions.length > 0,
      kolMentions,
      narrativeFit,

      // Extended fields
      mentionCount1h,
      mentionCount24h,
      velocityTrend,

      totalEngagement,
      avgEngagementPerTweet: avgEngagement,
      engagementTrend,
      viralTweetCount: viralCount,

      avgFollowerCount: avgFollowers,
      verifiedMentionCount: verifiedCount,
      suspiciousAccountRatio: suspiciousRatio,
      newAccountRatio,

      positiveMentions: sentiment.positive,
      negativeMentions: sentiment.negative,
      neutralMentions: sentiment.neutral,
      sentimentConfidence: sentiment.confidence,

      kolHandles,
      kolTotalFollowers: kolFollowers,
      kolSentiment,

      peakMentionHour: peakHour,
      isCurrentlyTrending,

      recentTweets: tweets1h.slice(0, 10),
      analyzedAt: new Date(),
    };
  }

  private calculateVelocityTrend(tweets: Tweet[]): 'ACCELERATING' | 'STABLE' | 'DECELERATING' {
    if (tweets.length < 5) return 'STABLE';

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    const lastHour = tweets.filter(t => t.createdAt.getTime() > oneHourAgo).length;
    const previousHour = tweets.filter(t =>
      t.createdAt.getTime() > twoHoursAgo && t.createdAt.getTime() <= oneHourAgo
    ).length;

    if (previousHour === 0) {
      return lastHour > 0 ? 'ACCELERATING' : 'STABLE';
    }

    const ratio = lastHour / previousHour;
    if (ratio > 1.5) return 'ACCELERATING';
    if (ratio < 0.5) return 'DECELERATING';
    return 'STABLE';
  }

  private calculateEngagementMetrics(tweets: Tweet[]): {
    totalEngagement: number;
    avgEngagement: number;
    engagementTrend: 'INCREASING' | 'STABLE' | 'DECREASING';
    viralCount: number;
  } {
    if (tweets.length === 0) {
      return { totalEngagement: 0, avgEngagement: 0, engagementTrend: 'STABLE', viralCount: 0 };
    }

    let totalEngagement = 0;
    let viralCount = 0;

    for (const tweet of tweets) {
      const engagement = tweet.metrics.likes + tweet.metrics.retweets +
                         tweet.metrics.replies + tweet.metrics.quotes;
      totalEngagement += engagement;
      if (engagement >= THRESHOLDS.VIRAL_ENGAGEMENT) {
        viralCount++;
      }
    }

    const avgEngagement = totalEngagement / tweets.length;

    // Calculate trend (compare recent vs older engagement)
    const midpoint = Math.floor(tweets.length / 2);
    const recentTweets = tweets.slice(0, midpoint);
    const olderTweets = tweets.slice(midpoint);

    const recentAvg = recentTweets.reduce((sum, t) =>
      sum + t.metrics.likes + t.metrics.retweets, 0) / (recentTweets.length || 1);
    const olderAvg = olderTweets.reduce((sum, t) =>
      sum + t.metrics.likes + t.metrics.retweets, 0) / (olderTweets.length || 1);

    let engagementTrend: 'INCREASING' | 'STABLE' | 'DECREASING' = 'STABLE';
    if (olderAvg > 0) {
      const ratio = recentAvg / olderAvg;
      if (ratio > 1.3) engagementTrend = 'INCREASING';
      else if (ratio < 0.7) engagementTrend = 'DECREASING';
    }

    return { totalEngagement, avgEngagement, engagementTrend, viralCount };
  }

  private calculateEngagementQuality(tweets: Tweet[], users: Map<string, TwitterUser>): number {
    if (tweets.length === 0) return 0.5;

    let qualitySum = 0;
    let weightSum = 0;

    for (const tweet of tweets) {
      const author = tweet.author || users.get(tweet.authorId);
      if (!author) continue;

      const engagement = tweet.metrics.likes + tweet.metrics.retweets;
      const followerRatio = author.followerCount > 0
        ? engagement / author.followerCount
        : 0;

      // Healthy engagement rate is 1-5% of followers
      let quality = 0.5;
      if (followerRatio > 0.05) quality = 0.9;  // Viral
      else if (followerRatio > 0.02) quality = 0.8;  // Excellent
      else if (followerRatio > 0.01) quality = 0.7;  // Good
      else if (followerRatio > 0.005) quality = 0.6;  // Average
      else if (followerRatio > 0.001) quality = 0.4;  // Low
      else quality = 0.2;  // Very low (possibly botted)

      // Weight by follower count (bigger accounts matter more)
      const weight = Math.log10(Math.max(author.followerCount, 100));
      qualitySum += quality * weight;
      weightSum += weight;
    }

    return weightSum > 0 ? qualitySum / weightSum : 0.5;
  }

  private calculateAccountMetrics(tweets: Tweet[], users: Map<string, TwitterUser>): {
    authenticity: number;
    avgFollowers: number;
    verifiedCount: number;
    suspiciousRatio: number;
    newAccountRatio: number;
  } {
    if (tweets.length === 0) {
      return { authenticity: 0.5, avgFollowers: 0, verifiedCount: 0, suspiciousRatio: 0, newAccountRatio: 0 };
    }

    let totalFollowers = 0;
    let verifiedCount = 0;
    let suspiciousCount = 0;
    let newAccountCount = 0;
    let analyzedCount = 0;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    for (const tweet of tweets) {
      const author = tweet.author || users.get(tweet.authorId);
      if (!author) continue;

      analyzedCount++;
      totalFollowers += author.followerCount;

      if (author.verified) verifiedCount++;
      if (author.createdAt > thirtyDaysAgo) newAccountCount++;

      // Suspicious account indicators
      const isSuspicious = this.isAccountSuspicious(author);
      if (isSuspicious) suspiciousCount++;
    }

    const avgFollowers = analyzedCount > 0 ? totalFollowers / analyzedCount : 0;
    const suspiciousRatio = analyzedCount > 0 ? suspiciousCount / analyzedCount : 0;
    const newAccountRatio = analyzedCount > 0 ? newAccountCount / analyzedCount : 0;

    // Calculate authenticity score (0-1)
    let authenticity = 0.5;

    // Boost for average followers
    if (avgFollowers > 10000) authenticity += 0.2;
    else if (avgFollowers > 1000) authenticity += 0.1;
    else if (avgFollowers < 100) authenticity -= 0.1;

    // Boost for verified accounts
    if (verifiedCount > 0) authenticity += Math.min(0.2, verifiedCount * 0.05);

    // Penalty for suspicious accounts
    authenticity -= suspiciousRatio * 0.3;

    // Penalty for new accounts
    authenticity -= newAccountRatio * 0.2;

    authenticity = Math.max(0, Math.min(1, authenticity));

    return { authenticity, avgFollowers, verifiedCount, suspiciousRatio, newAccountRatio };
  }

  private isAccountSuspicious(user: TwitterUser): boolean {
    // Low followers with high tweet count (spam pattern)
    if (user.followerCount < 50 && user.tweetCount > 1000) return true;

    // Very low follower/following ratio (bot pattern)
    if (user.followingCount > 0) {
      const ratio = user.followerCount / user.followingCount;
      if (ratio < 0.01 && user.followingCount > 500) return true;
    }

    // Default profile (no description, new account)
    const isNew = new Date().getTime() - user.createdAt.getTime() < 30 * 24 * 60 * 60 * 1000;
    if (isNew && !user.description && user.followerCount < 10) return true;

    // Generic username patterns (crypto_user_12345)
    if (/^[a-z]+_?(user|crypto|sol|degen)_?\d{3,}$/i.test(user.username)) return true;

    return false;
  }

  private analyzeSentiment(tweets: Tweet[]): SentimentResult {
    if (tweets.length === 0) {
      return { score: 0, positive: 0, negative: 0, neutral: 0, confidence: 0 };
    }

    let positiveCount = 0;
    let negativeCount = 0;
    let neutralCount = 0;
    let totalScore = 0;
    let totalWeight = 0;

    for (const tweet of tweets) {
      const text = tweet.text.toLowerCase();
      let tweetScore = 0;
      let matchCount = 0;

      // Check bullish keywords
      for (const { word, weight } of SENTIMENT_KEYWORDS.bullish) {
        if (text.includes(word)) {
          tweetScore += weight;
          matchCount++;
        }
      }

      // Check bearish keywords
      for (const { word, weight } of SENTIMENT_KEYWORDS.bearish) {
        if (text.includes(word)) {
          tweetScore += weight; // weight is already negative
          matchCount++;
        }
      }

      // Normalize tweet score
      if (matchCount > 0) {
        tweetScore = tweetScore / matchCount;
      }

      // Weight by engagement
      const engagement = tweet.metrics.likes + tweet.metrics.retweets + 1;
      const weight = Math.log10(engagement + 1);

      totalScore += tweetScore * weight;
      totalWeight += weight;

      // Categorize
      if (tweetScore > 0.2) positiveCount++;
      else if (tweetScore < -0.2) negativeCount++;
      else neutralCount++;
    }

    const score = totalWeight > 0 ? totalScore / totalWeight : 0;
    const confidence = tweets.length > 20 ? 0.8 : tweets.length > 10 ? 0.6 : 0.4;

    return {
      score: Math.max(-1, Math.min(1, score)),
      positive: positiveCount,
      negative: negativeCount,
      neutral: neutralCount,
      confidence,
    };
  }

  private detectKolMentions(tweets: Tweet[], users: Map<string, TwitterUser>): {
    kolMentions: KolMention[];
    kolHandles: string[];
    kolFollowers: number;
    kolSentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  } {
    const kolMentions: KolMention[] = [];
    const kolHandles: string[] = [];
    let kolFollowers = 0;
    let bullishKols = 0;
    let bearishKols = 0;

    for (const tweet of tweets) {
      const author = tweet.author || users.get(tweet.authorId);
      if (!author) continue;

      const username = author.username.toLowerCase();
      const kolInfo = KNOWN_KOLS.get(username);

      if (kolInfo && author.followerCount >= kolInfo.minFollowers) {
        kolMentions.push({
          handle: author.username,
          tier: kolInfo.tier,
          followers: author.followerCount,
        });
        kolHandles.push(author.username);
        kolFollowers += author.followerCount;

        // Check KOL sentiment
        const text = tweet.text.toLowerCase();
        const isBullish = SENTIMENT_KEYWORDS.bullish.some(k => text.includes(k.word));
        const isBearish = SENTIMENT_KEYWORDS.bearish.some(k => text.includes(k.word));

        if (isBullish && !isBearish) bullishKols++;
        else if (isBearish && !isBullish) bearishKols++;
      }
    }

    let kolSentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH' = 'NEUTRAL';
    if (bullishKols > bearishKols) kolSentiment = 'BULLISH';
    else if (bearishKols > bullishKols) kolSentiment = 'BEARISH';

    return { kolMentions, kolHandles, kolFollowers, kolSentiment };
  }

  private detectNarrative(tweets: Tweet[], ticker: string): string | null {
    const narrativeKeywords = {
      'AI / Agents': ['ai', 'agent', 'gpt', 'llm', 'neural', 'intelligence', 'bot'],
      'Political': ['trump', 'biden', 'maga', 'politics', 'election', 'vote'],
      'Classic Meme': ['pepe', 'doge', 'shib', 'wojak', 'chad', 'meme'],
      'Animal': ['cat', 'dog', 'frog', 'monkey', 'ape', 'bird', 'fish'],
      'Gaming': ['game', 'play', 'nft', 'metaverse', 'virtual'],
      'DeFi': ['defi', 'yield', 'stake', 'farm', 'liquidity', 'swap'],
    };

    const allText = tweets.map(t => t.text.toLowerCase()).join(' ') + ' ' + ticker.toLowerCase();

    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const [narrative, keywords] of Object.entries(narrativeKeywords)) {
      let score = 0;
      for (const keyword of keywords) {
        const matches = (allText.match(new RegExp(keyword, 'g')) || []).length;
        score += matches;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = narrative;
      }
    }

    return bestScore >= 3 ? bestMatch : null;
  }

  private findPeakMentionHour(tweets: Tweet[]): number {
    const hourCounts = new Array(24).fill(0);

    for (const tweet of tweets) {
      const hour = tweet.createdAt.getHours();
      hourCounts[hour]++;
    }

    let peakHour = 0;
    let peakCount = 0;
    for (let i = 0; i < 24; i++) {
      if (hourCounts[i] > peakCount) {
        peakCount = hourCounts[i];
        peakHour = i;
      }
    }

    return peakHour;
  }

  // ============ SCORING FUNCTIONS ============

  private scoreVelocity(metrics: DetailedSocialMetrics): number {
    let score = 0;
    const maxScore = 25;

    // Mention velocity scoring (0-15)
    if (metrics.mentionVelocity1h >= THRESHOLDS.EXCELLENT_VELOCITY) {
      score += 15;
    } else if (metrics.mentionVelocity1h >= THRESHOLDS.GOOD_VELOCITY) {
      score += 12;
    } else if (metrics.mentionVelocity1h >= THRESHOLDS.MIN_VELOCITY) {
      score += 8;
    } else if (metrics.mentionVelocity1h >= 1) {
      score += 4;
    }

    // Velocity trend bonus (0-10)
    if (metrics.velocityTrend === 'ACCELERATING') {
      score += 10;
    } else if (metrics.velocityTrend === 'STABLE' && metrics.mentionVelocity1h >= THRESHOLDS.MIN_VELOCITY) {
      score += 5;
    }
    // DECELERATING = no bonus

    return Math.min(maxScore, score);
  }

  private scoreEngagement(metrics: DetailedSocialMetrics): number {
    let score = 0;
    const maxScore = 25;

    // Engagement quality (0-15)
    if (metrics.engagementQuality >= 0.8) {
      score += 15;
    } else if (metrics.engagementQuality >= 0.6) {
      score += 11;
    } else if (metrics.engagementQuality >= 0.4) {
      score += 7;
    } else if (metrics.engagementQuality >= 0.2) {
      score += 3;
    }

    // Viral tweets bonus (0-5)
    if (metrics.viralTweetCount >= 5) {
      score += 5;
    } else if (metrics.viralTweetCount >= 2) {
      score += 3;
    } else if (metrics.viralTweetCount >= 1) {
      score += 1;
    }

    // Engagement trend bonus (0-5)
    if (metrics.engagementTrend === 'INCREASING') {
      score += 5;
    } else if (metrics.engagementTrend === 'STABLE') {
      score += 2;
    }

    return Math.min(maxScore, score);
  }

  private scoreAuthenticity(metrics: DetailedSocialMetrics): number {
    let score = 0;
    const maxScore = 25;

    // Account authenticity (0-15)
    if (metrics.accountAuthenticity >= 0.8) {
      score += 15;
    } else if (metrics.accountAuthenticity >= 0.6) {
      score += 11;
    } else if (metrics.accountAuthenticity >= 0.4) {
      score += 7;
    } else if (metrics.accountAuthenticity >= 0.2) {
      score += 3;
    }

    // Verified accounts bonus (0-5)
    if (metrics.verifiedMentionCount >= 3) {
      score += 5;
    } else if (metrics.verifiedMentionCount >= 1) {
      score += 3;
    }

    // KOL presence bonus (0-5)
    if (metrics.kolMentionDetected) {
      const kolCount = metrics.kolMentions.length;
      if (kolCount >= 3) score += 5;
      else if (kolCount >= 2) score += 4;
      else score += 3;
    }

    return Math.min(maxScore, score);
  }

  private scoreSentiment(metrics: DetailedSocialMetrics): number {
    let score = 0;
    const maxScore = 25;

    // Base sentiment score (0-15)
    // sentimentPolarity ranges from -1 to 1
    const normalizedSentiment = (metrics.sentimentPolarity + 1) / 2; // 0 to 1
    score += Math.round(normalizedSentiment * 15);

    // Sentiment confidence bonus (0-5)
    if (metrics.sentimentConfidence >= 0.8) {
      score += 5;
    } else if (metrics.sentimentConfidence >= 0.6) {
      score += 3;
    } else if (metrics.sentimentConfidence >= 0.4) {
      score += 1;
    }

    // KOL sentiment bonus (0-5)
    if (metrics.kolMentionDetected) {
      if (metrics.kolSentiment === 'BULLISH') {
        score += 5;
      } else if (metrics.kolSentiment === 'NEUTRAL') {
        score += 2;
      }
      // BEARISH = no bonus
    }

    return Math.min(maxScore, score);
  }

  // ============ PATTERN DETECTION ============

  private detectPatterns(metrics: DetailedSocialMetrics): { signals: string[]; warnings: string[] } {
    const signals: string[] = [];
    const warnings: string[] = [];

    // Positive signals
    if (metrics.velocityTrend === 'ACCELERATING' && metrics.mentionVelocity1h >= THRESHOLDS.GOOD_VELOCITY) {
      signals.push('VIRAL_MOMENTUM');
    }
    if (metrics.viralTweetCount >= 3) {
      signals.push('MULTIPLE_VIRAL_TWEETS');
    }
    if (metrics.kolMentionDetected && metrics.kolSentiment === 'BULLISH') {
      signals.push('KOL_BULLISH');
    }
    if (metrics.sentimentPolarity > 0.5 && metrics.sentimentConfidence >= 0.6) {
      signals.push('STRONG_POSITIVE_SENTIMENT');
    }
    if (metrics.engagementQuality >= 0.8) {
      signals.push('HIGH_QUALITY_ENGAGEMENT');
    }
    if (metrics.verifiedMentionCount >= 2) {
      signals.push('VERIFIED_ACCOUNTS_ACTIVE');
    }
    if (metrics.isCurrentlyTrending) {
      signals.push('CURRENTLY_TRENDING');
    }

    // Warning flags
    if (metrics.suspiciousAccountRatio > THRESHOLDS.SUSPICIOUS_ACCOUNT_MAX_RATIO) {
      warnings.push('HIGH_BOT_ACTIVITY');
    }
    if (metrics.newAccountRatio > 0.5) {
      warnings.push('MANY_NEW_ACCOUNTS');
    }
    if (metrics.velocityTrend === 'DECELERATING' && metrics.mentionCount24h > 50) {
      warnings.push('DECLINING_INTEREST');
    }
    if (metrics.sentimentPolarity < -0.3) {
      warnings.push('NEGATIVE_SENTIMENT');
    }
    if (metrics.kolMentionDetected && metrics.kolSentiment === 'BEARISH') {
      warnings.push('KOL_BEARISH');
    }
    if (metrics.engagementQuality < 0.3 && metrics.mentionCount24h > 20) {
      warnings.push('LOW_QUALITY_ENGAGEMENT');
    }

    return { signals, warnings };
  }

  private determineConfidence(metrics: DetailedSocialMetrics, warnings: string[]): 'HIGH' | 'MEDIUM' | 'LOW' {
    // Critical warnings reduce confidence
    if (warnings.includes('HIGH_BOT_ACTIVITY') || warnings.includes('NEGATIVE_SENTIMENT')) {
      return 'LOW';
    }

    // Multiple warnings reduce confidence
    if (warnings.length >= 3) return 'LOW';
    if (warnings.length >= 2) return 'MEDIUM';

    // Low data quality
    if (metrics.mentionCount24h < 5) return 'LOW';
    if (metrics.mentionCount24h < 20) return 'MEDIUM';

    // Good data and few warnings = high confidence
    return 'HIGH';
  }

  // ============ UTILITY METHODS ============

  private buildEmptyMetrics(ticker?: string): DetailedSocialMetrics {
    return {
      mentionVelocity1h: 0,
      engagementQuality: 0.5,
      accountAuthenticity: 0.5,
      sentimentPolarity: 0,
      kolMentionDetected: false,
      kolMentions: [],
      narrativeFit: null,

      mentionCount1h: 0,
      mentionCount24h: 0,
      velocityTrend: 'STABLE',

      totalEngagement: 0,
      avgEngagementPerTweet: 0,
      engagementTrend: 'STABLE',
      viralTweetCount: 0,

      avgFollowerCount: 0,
      verifiedMentionCount: 0,
      suspiciousAccountRatio: 0,
      newAccountRatio: 0,

      positiveMentions: 0,
      negativeMentions: 0,
      neutralMentions: 0,
      sentimentConfidence: 0,

      kolHandles: [],
      kolTotalFollowers: 0,
      kolSentiment: 'NEUTRAL',

      peakMentionHour: 0,
      isCurrentlyTrending: false,

      recentTweets: [],
      analyzedAt: new Date(),
    };
  }

  private buildEmptySocialMetrics(): SocialMetrics {
    return {
      mentionVelocity1h: 0,
      engagementQuality: 0.5,
      accountAuthenticity: 0.5,
      sentimentPolarity: 0,
      kolMentionDetected: false,
      kolMentions: [],
      narrativeFit: null,
    };
  }

  /**
   * Clear the metrics cache
   */
  clearCache(): void {
    this.metricsCache.clear();
  }

  /**
   * Add a KOL to the tracking list
   */
  addKol(username: string, tier: 'S' | 'A' | 'B' | 'C', minFollowers: number): void {
    KNOWN_KOLS.set(username.toLowerCase(), { tier, minFollowers });
  }

  /**
   * Get list of tracked KOLs
   */
  getTrackedKols(): string[] {
    return Array.from(KNOWN_KOLS.keys());
  }
}

// ============ EXPORTS ============

export const socialAnalyzer = new SocialAnalyzer();

export default {
  SocialAnalyzer,
  socialAnalyzer,
};
