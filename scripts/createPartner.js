#!/usr/bin/env node
'use strict';

// Usage: node scripts/createPartner.js <partner-name> [rate-limit-per-min] [--internal]
// Generates a 64-char hex API key, stores the SHA-256 hash in Firestore, and
// prints the raw key ONCE. Store it securely — it cannot be recovered.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const crypto = require('crypto');
const admin = require('../firebaseAdmin');

const args = process.argv.slice(2);
if (!args.length || args[0].startsWith('--')) {
  console.error('Usage: node scripts/createPartner.js <partner-name> [rate-limit-per-min] [--internal]');
  process.exit(1);
}

const name = args[0];
const rateLimitArg = args.find(a => !a.startsWith('--') && a !== name);
const rateLimit = rateLimitArg ? parseInt(rateLimitArg, 10) : 60;
const isInternal = args.includes('--internal');

if (isNaN(rateLimit) || rateLimit < 1) {
  console.error('Rate limit must be a positive integer');
  process.exit(1);
}

async function main() {
  if (!admin.apps.length) {
    console.error('Firebase Admin not initialised — check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in .env');
    process.exit(1);
  }

  const rawKey = crypto.randomBytes(32).toString('hex'); // 64-char hex
  const hashedApiKey = crypto.createHash('sha256').update(rawKey).digest('hex');

  const db = admin.firestore();
  const docRef = await db.collection('partners').add({
    name,
    hashedApiKey,
    status: 'active',
    rateLimit,
    internal: isInternal,
    createdAt: Date.now(),
  });

  console.log('\nPartner created successfully.');
  console.log('─'.repeat(50));
  console.log(`  Partner ID  : ${docRef.id}`);
  console.log(`  Name        : ${name}`);
  console.log(`  Rate limit  : ${rateLimit} calls/min`);
  console.log(`  Internal    : ${isInternal}`);
  console.log('─'.repeat(50));
  console.log('\n  RAW API KEY (shown ONCE — store securely):');
  console.log(`\n  ${rawKey}\n`);

  if (isInternal) {
    console.log('  This partner is marked internal and will bypass the trader consent gate.\n');
  }

  process.exit(0);
}

main().catch(e => {
  console.error('Failed to create partner:', e.message);
  process.exit(1);
});
