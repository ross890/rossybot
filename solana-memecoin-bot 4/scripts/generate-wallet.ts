// ===========================================
// WALLET GENERATOR
// Creates a new Solana wallet for the bot
// ===========================================

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Generate new keypair
const keypair = Keypair.generate();

console.log('═══════════════════════════════════════════════════════');
console.log('  NEW BOT WALLET GENERATED');
console.log('═══════════════════════════════════════════════════════\n');

console.log('PUBLIC ADDRESS (safe to share):');
console.log(`  ${keypair.publicKey.toBase58()}\n`);

console.log('PRIVATE KEY (keep secret!):');
console.log('  Base58 format (recommended for .env):');
console.log(`  ${bs58.encode(keypair.secretKey)}\n`);

console.log('  JSON array format (alternative):');
console.log(`  [${keypair.secretKey.toString()}]\n`);

console.log('═══════════════════════════════════════════════════════');
console.log('NEXT STEPS:');
console.log('═══════════════════════════════════════════════════════');
console.log('1. Copy the PUBLIC ADDRESS above');
console.log('2. Send SOL to it (start with 5 SOL as planned)');
console.log('3. Add the Base58 PRIVATE KEY to your .env file:');
console.log('   BOT_WALLET_PRIVATE_KEY=<paste_base58_key_here>');
console.log('');
console.log('⚠️  SECURITY WARNING:');
console.log('   - NEVER share your private key');
console.log('   - NEVER commit .env to git');
console.log('   - Only fund with what you can afford to lose');
console.log('═══════════════════════════════════════════════════════\n');
