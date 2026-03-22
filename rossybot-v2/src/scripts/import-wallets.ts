#!/usr/bin/env tsx
/**
 * Bulk import wallets into wallets.json from a simple text file.
 *
 * Usage:
 *   npx tsx src/scripts/import-wallets.ts <input-file> [--pumpfun] [--label-prefix <prefix>]
 *
 * Input file format (one wallet per line):
 *   <address>                          → auto-labeled as "<prefix>_1", "<prefix>_2", ...
 *   <address>,<label>                  → uses provided label
 *   <address>,<label>,<minTier>        → uses provided label and tier (MICRO/SMALL/MEDIUM/FULL)
 *
 * Examples:
 *   npx tsx src/scripts/import-wallets.ts pf-wallets.txt --pumpfun --label-prefix pf_highwr
 *   npx tsx src/scripts/import-wallets.ts new-wallets.txt
 *
 * Lines starting with # are ignored. Blank lines are ignored.
 * Duplicate addresses (already in wallets.json) are skipped.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WALLETS_JSON_PATH = resolve(__dirname, '../../wallets.json');

interface WalletEntry {
  address: string;
  label: string;
  minTier: string;
  pumpfunOnly?: boolean;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage: npx tsx src/scripts/import-wallets.ts <input-file> [options]

Options:
  --pumpfun              Mark all imported wallets as pumpfunOnly
  --label-prefix <str>   Prefix for auto-generated labels (default: "imported")
  --tier <tier>          Default tier: MICRO, SMALL, MEDIUM, FULL (default: MICRO)
  --dry-run              Show what would be imported without writing

Input file: one wallet per line. Optionally comma-separated: address,label,tier
Lines starting with # are comments. Blank lines are ignored.
`);
    process.exit(0);
  }

  const inputFile = args[0];
  const pumpfunOnly = args.includes('--pumpfun');
  const dryRun = args.includes('--dry-run');
  const labelPrefixIdx = args.indexOf('--label-prefix');
  const labelPrefix = labelPrefixIdx >= 0 ? args[labelPrefixIdx + 1] : 'imported';
  const tierIdx = args.indexOf('--tier');
  const defaultTier = tierIdx >= 0 ? args[tierIdx + 1] : 'MICRO';

  // Load existing wallets.json
  let existing: { wallets: WalletEntry[] };
  try {
    existing = JSON.parse(readFileSync(WALLETS_JSON_PATH, 'utf-8'));
  } catch {
    existing = { wallets: [] };
  }

  const existingAddresses = new Set(existing.wallets.map((w) => w.address));

  // Parse input file
  const inputPath = resolve(process.cwd(), inputFile);
  const lines = readFileSync(inputPath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const newWallets: WalletEntry[] = [];
  let skipped = 0;
  let autoIdx = existingAddresses.size + 1;

  for (const line of lines) {
    const parts = line.split(',').map((p) => p.trim());
    const address = parts[0];

    // Basic Solana address validation (base58, 32-44 chars)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      console.warn(`Skipping invalid address: ${address}`);
      skipped++;
      continue;
    }

    if (existingAddresses.has(address)) {
      console.log(`Duplicate, skipping: ${address}`);
      skipped++;
      continue;
    }

    const label = parts[1] || `${labelPrefix}_${autoIdx}`;
    const tier = parts[2] || defaultTier;

    const entry: WalletEntry = { address, label, minTier: tier };
    if (pumpfunOnly) entry.pumpfunOnly = true;

    newWallets.push(entry);
    existingAddresses.add(address);
    autoIdx++;
  }

  console.log(`\nParsed ${lines.length} lines from ${inputFile}`);
  console.log(`New wallets to add: ${newWallets.length}`);
  console.log(`Skipped (duplicates/invalid): ${skipped}`);
  console.log(`Total after import: ${existing.wallets.length + newWallets.length}`);

  if (dryRun) {
    console.log('\n--- DRY RUN — no changes written ---');
    for (const w of newWallets) {
      console.log(`  + ${w.address}  (${w.label}, ${w.minTier}${w.pumpfunOnly ? ', pumpfun' : ''})`);
    }
    return;
  }

  if (newWallets.length === 0) {
    console.log('Nothing to import.');
    return;
  }

  existing.wallets.push(...newWallets);
  writeFileSync(WALLETS_JSON_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\nWrote ${existing.wallets.length} wallets to wallets.json`);
}

main();
