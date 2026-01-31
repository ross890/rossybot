#!/usr/bin/env node

/**
 * Test Telegram Signal Script
 * Run this to verify Telegram bot can send messages to your chat
 */

import { config } from 'dotenv';
config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  process.exit(1);
}

console.log('\n🔄 Testing Telegram signal send...\n');

// Test message formatted like a real signal
const testMessage = `🧪 *ROSSYBOT TEST SIGNAL*

*Status:* ✅ Bot is connected and working!

📊 *TEST METRICS*
├─ Composite Score: *85/100*
├─ Confidence: *HIGH*
├─ Risk Level: *2/5*
└─ Signal Type: TEST

👛 *SYSTEMS CHECK*
├─ Database: ✅
├─ Telegram: ✅
├─ WebSocket: ✅
├─ DexScreener: ✅
└─ Token Boosts: ✅

⚡ *NOTE*
This is a test message to verify the Telegram alert system is working correctly.

⏱️ _Test sent: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC_`;

async function sendTestSignal() {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: testMessage,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      }
    );

    const data = await response.json();

    if (data.ok) {
      console.log('✅ Test signal sent successfully!');
      console.log(`   Message ID: ${data.result.message_id}`);
      console.log(`   Chat ID: ${data.result.chat.id}`);
      console.log('\n📱 Check your Telegram - you should see the test message.');
    } else {
      console.error('❌ Failed to send:', data.description);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

sendTestSignal();
