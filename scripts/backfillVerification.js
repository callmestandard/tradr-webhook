'use strict';

/**
 * One-off backfill: stamps verification field on all existing transactions
 * that pre-date the verification system.
 *
 * Run from tradr-server root:
 *   node scripts/backfillVerification.js
 *
 * Safe to re-run — skips any doc that already has a verification field.
 *
 * NOTE: Telegram transactions recorded before this deploy have source='whatsapp_bot'
 * (bug in telegram.js). They will be stamped as 'bot_recorded' — the correct tier —
 * but the source field will read 'whatsapp_bot'. This is acceptable; tier is authoritative.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const admin = require('../firebaseAdmin');
const { inferTier } = require('../services/verification');

const BATCH_SIZE = 499;

async function commitBatch(db, updates) {
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const { ref, data } of updates.slice(i, i + BATCH_SIZE)) {
      batch.update(ref, data);
    }
    await batch.commit();
  }
}

async function run() {
  if (!admin.apps.length) {
    console.error('Firebase Admin not initialised. Check .env for FIREBASE_* vars.');
    process.exit(1);
  }

  const db = admin.firestore();
  const stamp = { stamped_at: Date.now(), schema_version: 1 };
  let updated = 0;
  let skipped = 0;

  // ── 1. pending_transactions (top-level collection) ──
  console.log('Scanning pending_transactions...');
  const pendingSnap = await db.collection('pending_transactions').get();
  const pendingUpdates = [];

  for (const doc of pendingSnap.docs) {
    const data = doc.data();
    if (data.verification) { skipped++; continue; }
    const source = data.source || 'manual';
    pendingUpdates.push({
      ref: doc.ref,
      data: { verification: { tier: inferTier(source), source, ...stamp } },
    });
    updated++;
  }

  await commitBatch(db, pendingUpdates);
  console.log(`  pending_transactions: ${pendingUpdates.length} updated`);

  // ── 2. traders/*/transactions (subcollections) ──
  console.log('Scanning trader transaction subcollections...');
  const tradersSnap = await db.collection('traders').get();
  let traderCount = 0;

  for (const traderDoc of tradersSnap.docs) {
    const txSnap = await db.collection(`traders/${traderDoc.id}/transactions`).get();
    if (txSnap.empty) continue;

    const txUpdates = [];
    for (const doc of txSnap.docs) {
      const data = doc.data();
      if (data.verification) { skipped++; continue; }
      const source = data.source || 'manual';
      txUpdates.push({
        ref: doc.ref,
        data: { verification: { tier: inferTier(source), source, ...stamp } },
      });
      updated++;
    }

    await commitBatch(db, txUpdates);
    traderCount++;
    if (traderCount % 50 === 0) {
      console.log(`  processed ${traderCount}/${tradersSnap.size} traders...`);
    }
  }

  console.log(`\nDone.`);
  console.log(`  Updated : ${updated}`);
  console.log(`  Skipped (already stamped): ${skipped}`);
  process.exit(0);
}

run().catch(e => {
  console.error('Backfill failed:', e.message);
  process.exit(1);
});
