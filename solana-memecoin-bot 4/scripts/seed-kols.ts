// ===========================================
// KOL DATABASE SEEDING SCRIPT
// Populated with researched KOL data from rossybot KOL research document
// ===========================================

import { pool } from '../src/utils/database.js';
import { Database } from '../src/utils/database.js';
import { KolTier, WalletType, LinkMethod, AttributionConfidence } from '../src/types/index.js';

// ============ RESEARCHED KOL DATA ============
// Source: KOLScan.io, GMGN.ai, ZachXBT investigations, Arkham Intelligence

interface WalletData {
  address: string;
  confidence: AttributionConfidence;
  linkMethod: LinkMethod;
  notes: string;
}

interface KolData {
  handle: string;
  displayName: string;
  followerCount: number | null;
  tier: KolTier;
  notes: string;
  mainWallets: WalletData[];
  sideWallets: WalletData[];
}

const RESEARCHED_KOLS: KolData[] = [
  // =============================================
  // TIER 1: HIGHEST SIGNAL VALUE
  // =============================================
  {
    handle: 'blknoiz06', // Ansem
    displayName: 'Ansem',
    followerCount: 500000,
    tier: KolTier.TIER_1,
    notes: 'Known as "Memecoin King". Early Solana advocate ($1.50 entry). Notable plays: WIF (520x), BONK (80x), BODEN ($540K profit). Win rate ~25% (high-frequency trading). Former amateur boxer.',
    mainWallets: [
      {
        address: 'AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm',
        confidence: AttributionConfidence.HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'Primary Solana wallet - publicly known, links to bullpen.fi/@ansem',
      },
    ],
    sideWallets: [], // To be detected via clustering
  },
  {
    handle: 'MustStopMurad', // Murad Mahmudov
    displayName: 'Murad Mahmudov',
    followerCount: 200000,
    tier: KolTier.TIER_1,
    notes: 'Princeton graduate, ex-Goldman/Glencore. Famous for "Memecoin Supercycle" speech at TOKEN2049. Focus: $5M-$200M mcap range. 11 wallets identified by ZachXBT holding ~$24M in memecoins. Top holdings: SPX6900, APU, FWOG, GIGA, POPCAT.',
    mainWallets: [
      // ZachXBT identified 11 wallets linked via deBridge - these would need to be
      // individually verified and added. The investigation linked them via funding patterns.
      // For now, use FUNDING_CLUSTER method for any identified wallets
    ],
    sideWallets: [],
  },

  // =============================================
  // TIER 2: STRONG SIGNAL, VERIFIED WALLETS
  // From KOLScan Daily Leaderboard (30 Jan 2026)
  // =============================================
  {
    handle: 'JADAWGS',
    displayName: 'JADAWGS',
    followerCount: null,
    tier: KolTier.TIER_2,
    notes: 'KOLScan #1 daily. +908 SOL ($105K) daily PNL. Win rate: 3/3 (100%)',
    mainWallets: [
      {
        address: '3H9LVHarjBoZ2YPEsgFbVD1zuERCGwfp4AeyHoHsFSEC',
        confidence: AttributionConfidence.HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'Primary wallet from KOLScan leaderboard',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'Pain',
    displayName: 'Pain',
    followerCount: null,
    tier: KolTier.TIER_2,
    notes: 'KOLScan #2 daily. +395 SOL ($46K) daily PNL. Win rate: 12/15 (80%)',
    mainWallets: [
      {
        address: 'J6TDXvarvpBdPXTaTU8eJbtso1PUCYKGkVtMKUUY8iEa',
        confidence: AttributionConfidence.HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'Primary wallet from KOLScan leaderboard',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'Loopierr',
    displayName: 'Loopierr',
    followerCount: null,
    tier: KolTier.TIER_2,
    notes: 'KOLScan #3 daily. +331 SOL ($38K) daily PNL. Win rate: 6/16 (38%)',
    mainWallets: [
      {
        address: '9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL',
        confidence: AttributionConfidence.HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'Primary wallet from KOLScan leaderboard',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'Cented',
    displayName: 'Cented',
    followerCount: null,
    tier: KolTier.TIER_2,
    notes: 'KOLScan #5 daily. +267 SOL ($31K) daily PNL. Win rate: 151/75 (67%) - very high volume trader',
    mainWallets: [
      {
        address: 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o',
        confidence: AttributionConfidence.HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'Primary wallet from KOLScan leaderboard',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'bradjae',
    displayName: 'bradjae',
    followerCount: null,
    tier: KolTier.TIER_2,
    notes: 'KOLScan #6 daily. +252 SOL ($29K) daily PNL. Win rate: 2/3 (67%)',
    mainWallets: [
      {
        address: '8Dg8J8xSeKqtBvL1nBe9waX348w5FSFjVnQaRLMpf7eV',
        confidence: AttributionConfidence.HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'Primary wallet from KOLScan leaderboard',
      },
    ],
    sideWallets: [],
  },
  {
    handle: '0xJumpman',
    displayName: '0xJumpman',
    followerCount: null,
    tier: KolTier.TIER_2,
    notes: 'KOLScan #7 daily. +191 SOL ($22K) daily PNL. Win rate: 4/2 (67%)',
    mainWallets: [
      {
        address: '8eioZubsRjFkNEFcSHKDbWa8MkpmXMBvQcfarGsLviuE',
        confidence: AttributionConfidence.HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'Primary wallet from KOLScan leaderboard',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'Ataberk',
    displayName: 'Ataberk',
    followerCount: null,
    tier: KolTier.TIER_2,
    notes: 'KOLScan #8 daily. +186 SOL ($22K) daily PNL. Win rate: 7/17 (41%)',
    mainWallets: [
      {
        address: '6hcX7fVMzeRpW3d7XhFsxYw2CuePfgSMmouZxSiNLj1U',
        confidence: AttributionConfidence.HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'Primary wallet from KOLScan leaderboard',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'Ramset',
    displayName: 'Ramset',
    followerCount: null,
    tier: KolTier.TIER_2,
    notes: 'KOLScan #9 daily. +175 SOL ($20K) daily PNL. Win rate: 17/16 (52%)',
    mainWallets: [
      {
        address: '71PCu3E4JP5RDBoY6wJteqzxkKNXLyE1byg5BTAL9UtQ',
        confidence: AttributionConfidence.HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'Primary wallet from KOLScan leaderboard',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'WaiterG',
    displayName: 'WaiterG',
    followerCount: null,
    tier: KolTier.TIER_2,
    notes: 'KOLScan #10 daily. +150 SOL ($17K) daily PNL. Win rate: 9/12 (75%)',
    mainWallets: [
      {
        address: '4cXnf2z85UiZ5cyKsPMEULq1yufAtpkatmX4j4DBZqj2',
        confidence: AttributionConfidence.HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'Primary wallet from KOLScan leaderboard',
      },
    ],
    sideWallets: [],
  },

  // =============================================
  // TIER 3: ADDITIONAL TRACKED WALLETS
  // From KOLScan extended leaderboard
  // =============================================
  {
    handle: 'ram',
    displayName: 'ram',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'KOLScan tracked wallet',
    mainWallets: [
      {
        address: '57rXqaQsvgyBKwebP2StfqQeCBjBS4jsrZFJN5aU2V9b',
        confidence: AttributionConfidence.MEDIUM_HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'From KOLScan tracking',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'decu',
    displayName: 'decu',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'KOLScan tracked wallet',
    mainWallets: [
      {
        address: '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9',
        confidence: AttributionConfidence.MEDIUM_HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'From KOLScan tracking',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'chester',
    displayName: 'chester',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'KOLScan tracked wallet',
    mainWallets: [
      {
        address: 'PMJA8UQDyWTFw2Smhyp9jGA6aTaP7jKHR7BPudrgyYN',
        confidence: AttributionConfidence.MEDIUM_HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'From KOLScan tracking',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'clukz',
    displayName: 'clukz',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'KOLScan tracked wallet',
    mainWallets: [
      {
        address: 'G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC',
        confidence: AttributionConfidence.MEDIUM_HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'From KOLScan tracking',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'ozark',
    displayName: 'ozark',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'KOLScan tracked wallet',
    mainWallets: [
      {
        address: 'DZAa55HwXgv5hStwaTEJGXZz1DhHejvpb7Yr762urXam',
        confidence: AttributionConfidence.MEDIUM_HIGH,
        linkMethod: LinkMethod.DIRECT_KNOWN,
        notes: 'From KOLScan tracking',
      },
    ],
    sideWallets: [],
  },

  // =============================================
  // ADDITIONAL HIGH-PERFORMANCE WALLETS
  // From Dune/Axiom dashboards
  // =============================================
  {
    handle: 'axiom_alpha_1',
    displayName: 'Axiom Top Performer',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Identified from Axiom performance dashboards - no Twitter attribution',
    mainWallets: [
      {
        address: '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'High-performing wallet from Axiom dashboard, no KOL attribution',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'dune_alpha_1',
    displayName: 'Dune Alpha Wallet',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Identified from Dune alpha signal dashboards - no Twitter attribution',
    mainWallets: [
      {
        address: '8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'High-performing wallet from Dune dashboard, no KOL attribution',
      },
    ],
    sideWallets: [],
  },

  // =============================================
  // DUNE SMART WALLET ANALYSIS - TOP PERFORMERS
  // Source: ChainCatcher/Bitget analysis of 1,080 smart wallets
  // Avg 63.55% win rate, $980K total profit across cohort
  // =============================================
  {
    handle: 'dune_smart_1',
    displayName: 'Dune Top Performer #1',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Dune smart wallet analysis - 100% win rate, $106K 30-day profit, highest individual score (4.85)',
    mainWallets: [
      {
        address: '6FNbu3i6vpigXMatC6SyWKibUAdJyyX8nM8WDtZCNcEz',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'Dune smart wallet analysis - 63.55% avg win rate cohort, rank #1',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'dune_smart_2',
    displayName: 'Dune Top Performer #2',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Dune smart wallet analysis - top 10 performer from 1,080 wallet cohort',
    mainWallets: [
      {
        address: '6xUL8CUfV1fzd3UQoDBs7agWNXpwyE5q56css1wHNFFU',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'Dune smart wallet analysis - 63.55% avg win rate cohort, rank #2',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'dune_smart_3',
    displayName: 'Dune Top Performer #3',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Dune smart wallet analysis - top 10 performer from 1,080 wallet cohort',
    mainWallets: [
      {
        address: '4J5rDTvRbzjuKkB4B9rvNEvDz6f1BEBzUVT5mdctKHoT',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'Dune smart wallet analysis - 63.55% avg win rate cohort, rank #3',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'dune_smart_4',
    displayName: 'Dune Top Performer #4',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Dune smart wallet analysis - top 10 performer from 1,080 wallet cohort',
    mainWallets: [
      {
        address: '9v6RGY46wf672PtpYMxCJ1nvrVTrukUDn1AjE634rvCf',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'Dune smart wallet analysis - 63.55% avg win rate cohort, rank #4',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'dune_smart_5',
    displayName: 'Dune Top Performer #5',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Dune smart wallet analysis - top 10 performer from 1,080 wallet cohort',
    mainWallets: [
      {
        address: 'GpNbukV5nggkJfsEEbKrJaZkdgYcNWCAaD91Mi4MmGQi',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'Dune smart wallet analysis - 63.55% avg win rate cohort, rank #5',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'dune_smart_6',
    displayName: 'Dune Top Performer #6',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Dune smart wallet analysis - top 10 performer from 1,080 wallet cohort',
    mainWallets: [
      {
        address: 'DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'Dune smart wallet analysis - 63.55% avg win rate cohort, rank #6',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'dune_smart_7',
    displayName: 'Dune Top Performer #7',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Dune smart wallet analysis - top 10 performer from 1,080 wallet cohort',
    mainWallets: [
      {
        address: 'FTg1gqW7vPm4kdU1LPM7JJnizbgPdRDy2PitKw6mY27j',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'Dune smart wallet analysis - 63.55% avg win rate cohort, rank #7',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'dune_smart_8',
    displayName: 'Dune Top Performer #8',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Dune smart wallet analysis - top 10 performer from 1,080 wallet cohort',
    mainWallets: [
      {
        address: '69ngexW9UkgRp5KFjLpaK9XNSCxUFmps6jYmqhK3q6m9',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'Dune smart wallet analysis - 63.55% avg win rate cohort, rank #8',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'dune_smart_9',
    displayName: 'Dune Top Performer #9',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'Dune smart wallet analysis - top 10 performer from 1,080 wallet cohort',
    mainWallets: [
      {
        address: '7XgBprwnRfFHd287pnNQj4AZ6Yb9QE5pJ6ChQ3zhsGpJ',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'Dune smart wallet analysis - 63.55% avg win rate cohort, rank #9',
      },
    ],
    sideWallets: [],
  },

  // =============================================
  // GMGN/BEINCRYPTO SMART MONEY WALLETS
  // Source: BeInCrypto "Top Smart Wallets" analysis
  // =============================================
  {
    handle: 'gmgn_sniper_1',
    displayName: 'GMGN Elite Sniper',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'GMGN highlighted sniper - known for early entries into explosive memecoins',
    mainWallets: [
      {
        address: 'H72yLkhTnoBfhBTXXaj1RBXuirm8s8G5fcVh2XpQLggM',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'GMGN/BeInCrypto smart money tracking - early entry specialist',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'smart_money_trump',
    displayName: 'TRUMP Mega Trader',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'BeInCrypto smart wallet - 49% win rate, turned $511K into $4.87M on TRUMP token',
    mainWallets: [
      {
        address: '9HCTuTPEiQvkUtLmTZvK6uch4E3pDynwJTbNw6jLhp9z',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'BeInCrypto smart money - specializes in new token launches, $4.3M profit on single trade',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'smart_money_diversified',
    displayName: 'Diversified Smart Trader',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'BeInCrypto smart wallet - 52% win rate, $1.3M realized profit, 98 tokens traded. Top trades: JELLYJELLY, GRIFFAIN',
    mainWallets: [
      {
        address: '6kbwsSY4hL6WVadLRLnWV2irkMN2AvFZVAS8McKJmAtJ',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'BeInCrypto smart money - high volume diversified trader, $100K+ on 5 different tokens',
      },
    ],
    sideWallets: [],
  },
  {
    handle: 'smart_money_volume',
    displayName: 'High Volume Smart Trader',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'BeInCrypto smart wallet - 58% win rate, $1.4M realized profit, 205 tokens traded over 90 days',
    mainWallets: [
      {
        address: '5fWkLJfoDsRAaXhPJcJY19qNtDDQ5h6q1SPzsAPRrUNG',
        confidence: AttributionConfidence.MEDIUM,
        linkMethod: LinkMethod.BEHAVIOURAL_MATCH,
        notes: 'BeInCrypto smart money - highest win rate in cohort (58%), meme coin specialist',
      },
    ],
    sideWallets: [],
  },

  // =============================================
  // PUMP.FUN ELITE - PLACEHOLDER
  // Top 293 wallets (~0.002% of all Pump.fun traders)
  // =============================================
  {
    handle: 'pumpfun_elite_1',
    displayName: 'Pump.fun Elite Placeholder',
    followerCount: null,
    tier: KolTier.TIER_3,
    notes: 'PLACEHOLDER: Top Pump.fun trader has ~$40M profits. Address needs extraction from Dune dashboard. Top 0.002% of all Pump.fun traders.',
    mainWallets: [
      // Wallet address to be added once extracted from Dune
      // The #1 Pump.fun wallet shows ~$40M in realized profits
    ],
    sideWallets: [],
  },
];

// ============ SEED FUNCTION ============

async function seedKols(): Promise<void> {
  console.log('='.repeat(60));
  console.log('ROSSYBOT KOL DATABASE SEEDING');
  console.log('Source: KOLScan, GMGN, ZachXBT, Arkham Intelligence');
  console.log('='.repeat(60));
  console.log('');
  
  let totalKols = 0;
  let totalWallets = 0;
  
  try {
    for (const kolData of RESEARCHED_KOLS) {
      console.log(`\n📊 Processing: ${kolData.displayName} (@${kolData.handle})`);
      console.log(`   Tier: ${kolData.tier}`);
      
      // Create KOL
      const kol = await Database.createKol(
        kolData.handle,
        kolData.followerCount || 0,
        kolData.tier
      );
      totalKols++;
      
      console.log(`   ✅ Created KOL with ID: ${kol.id.slice(0, 8)}...`);
      
      // Add main wallets
      for (const wallet of kolData.mainWallets) {
        await Database.createWallet(
          kol.id,
          wallet.address,
          WalletType.MAIN,
          wallet.linkMethod,
          wallet.confidence,
          wallet.notes
        );
        totalWallets++;
        console.log(`   ✅ Added MAIN wallet: ${wallet.address.slice(0, 8)}...${wallet.address.slice(-4)}`);
        console.log(`      Confidence: ${wallet.confidence}, Method: ${wallet.linkMethod}`);
      }
      
      // Add side wallets (if any pre-identified)
      for (const wallet of kolData.sideWallets) {
        await Database.createWallet(
          kol.id,
          wallet.address,
          WalletType.SIDE,
          wallet.linkMethod,
          wallet.confidence,
          wallet.notes
        );
        totalWallets++;
        console.log(`   ✅ Added SIDE wallet: ${wallet.address.slice(0, 8)}...${wallet.address.slice(-4)}`);
      }
      
      // Initialize performance record
      await Database.updateKolPerformance(kol.id);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ KOL SEEDING COMPLETE');
    console.log('='.repeat(60));
    console.log(`\n📈 Summary:`);
    console.log(`   Total KOLs added: ${totalKols}`);
    console.log(`   Total Wallets added: ${totalWallets}`);
    console.log(`   Tier 1 KOLs: ${RESEARCHED_KOLS.filter(k => k.tier === KolTier.TIER_1).length}`);
    console.log(`   Tier 2 KOLs: ${RESEARCHED_KOLS.filter(k => k.tier === KolTier.TIER_2).length}`);
    console.log(`   Tier 3 KOLs: ${RESEARCHED_KOLS.filter(k => k.tier === KolTier.TIER_3).length}`);
    
    console.log('\n📝 Notes:');
    console.log('   - Murad Mahmudov has 11 wallets identified by ZachXBT');
    console.log('     These need individual verification before adding');
    console.log('   - Side wallet detection will identify additional wallets');
    console.log('   - Run the bot to start tracking and building performance metrics');
    console.log('');
    
  } catch (error) {
    console.error('\n❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run the seeding
seedKols();
