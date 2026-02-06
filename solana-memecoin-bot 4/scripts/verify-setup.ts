#!/usr/bin/env node

/**
 * Setup Verification Script
 * Run this to check your configuration before starting the bot
 */

import { config } from 'dotenv';
config();

const REQUIRED_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'HELIUS_API_KEY',
  'HELIUS_RPC_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
];

const OPTIONAL_VARS = [
  'TWITTER_BEARER_TOKEN',
];

console.log('\n' + '='.repeat(50));
console.log('SOLANA MEMECOIN BOT - SETUP VERIFICATION');
console.log('='.repeat(50) + '\n');

// Check required variables
console.log('📋 Checking required environment variables...\n');

let allRequired = true;
for (const varName of REQUIRED_VARS) {
  const value = process.env[varName];
  if (value && value.length > 0) {
    const masked = value.length > 10 
      ? value.slice(0, 4) + '...' + value.slice(-4)
      : '****';
    console.log(`  ✅ ${varName}: ${masked}`);
  } else {
    console.log(`  ❌ ${varName}: NOT SET`);
    allRequired = false;
  }
}

console.log('\n📋 Checking optional environment variables...\n');

for (const varName of OPTIONAL_VARS) {
  const value = process.env[varName];
  if (value && value.length > 0) {
    console.log(`  ✅ ${varName}: Set`);
  } else {
    console.log(`  ⚠️  ${varName}: Not set (optional)`);
  }
}

// Test database connection
console.log('\n📋 Testing database connection...\n');

try {
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  
  const client = await pool.connect();
  const result = await client.query('SELECT NOW()');
  client.release();
  await pool.end();
  
  console.log(`  ✅ PostgreSQL connected: ${result.rows[0].now}`);
} catch (error) {
  console.log(`  ❌ PostgreSQL failed: ${error.message}`);
  allRequired = false;
}

// Test Telegram bot
console.log('\n📋 Testing Telegram bot...\n');

try {
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`
  );
  const data = await response.json();
  
  if (data.ok) {
    console.log(`  ✅ Telegram bot: @${data.result.username}`);
  } else {
    console.log(`  ❌ Telegram bot: ${data.description}`);
    allRequired = false;
  }
} catch (error) {
  console.log(`  ❌ Telegram test failed: ${error.message}`);
  allRequired = false;
}

// Summary
console.log('\n' + '='.repeat(50));
if (allRequired) {
  console.log('✅ All checks passed! You can start the bot with:');
  console.log('   npm run build && npm start');
} else {
  console.log('❌ Some checks failed. Please fix the issues above.');
  console.log('   See README.md for setup instructions.');
}
console.log('='.repeat(50) + '\n');

process.exit(allRequired ? 0 : 1);
