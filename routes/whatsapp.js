const express = require('express');
const { sendWhatsAppMessage, sendWhatsAppDocument } = require('../utils/whatsapp');
const { stampVerification } = require('../services/verification');
const { createSignedToken, generatePDFStatement } = require('../services/exporter');
const { withGrowthFooter, logGrowthTouch } = require('../services/growthFooter');
const admin = require('../firebaseAdmin');

const SERVER_URL = process.env.SERVER_URL || 'https://tradr-webhook.onrender.com';

// WhatsApp command variants per feature
const EXPORT_COMMANDS   = new Set(['EXPORT', 'SEND MY RECORDS', 'MY RECORDS', 'EXPORT DATA']);
const PASSPORT_COMMANDS = new Set(['PASSPORT', 'MY PASSPORT', 'LOAN CARD', 'CREDIT CARD', 'KAADI', 'PASSPO']);

const router = express.Router();

// GET /whatsapp/webhook — Meta verification challenge
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[whatsapp] Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

function fmt(n) {
  return '₦' + (n || 0).toLocaleString('en-NG');
}

// Parse sale/expense messages in natural language
// Handles: "5000", "sold rice 5000", "expense transport 800", "spent 2000 on stock"
function parseTraderMessage(raw) {
  const text = raw.trim();
  const lower = text.toLowerCase();

  // Pure number (with optional commas) = quick sale
  const pureNum = text.replace(/[,₦\s]/g, '');
  if (/^\d+(\.\d{1,2})?$/.test(pureNum)) {
    return { type: 'sale', amount: parseFloat(pureNum), description: 'Sale' };
  }

  // Extract the first number from the message
  const numMatch = text.match(/[\d,]+(?:\.\d{1,2})?/);
  if (!numMatch) return null;
  const amount = parseFloat(numMatch[0].replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0 || amount > 50000000) return null;

  // Determine transaction type
  const isExpense = /^(expense|spent|spend|bought|buy|exp\b|paid|cost|restock|buying|transport|fuel|rent|salary)/i.test(lower);
  const type = isExpense ? 'expense' : 'sale';

  // Extract description — remove number and leading command word
  let desc = text
    .replace(/[\d,]+(?:\.\d{1,2})?/, '')
    .replace(/^(sold?|sale|expense|spent|spend|bought|buy|exp|paid|restock|buying)\s*/i, '')
    .replace(/\b(naira|ngn|₦|on|for|of)\b/gi, '')
    .trim();

  if (!desc || desc.length < 2) {
    desc = isExpense ? 'Expense' : 'Sale';
  } else {
    desc = desc.charAt(0).toUpperCase() + desc.slice(1);
  }

  return { type, amount, description: desc };
}

async function getTodayStats(userId, db) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const txSnap = await db.collection(`traders/${userId}/transactions`)
    .where('createdAt', '>=', today.getTime())
    .get().catch(() => ({ docs: [] }));

  const txs = txSnap.docs.map(d => d.data());
  const todaySales = txs.filter(t => t.type === 'sale').reduce((s, t) => s + t.amount, 0);
  const todayExpenses = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  return { todaySales, todayExpenses, net: todaySales - todayExpenses, txCount: txs.length };
}

async function recordBotTransaction(userId, db, { type, amount, description }) {
  const txId = `wa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tx = {
    id: txId,
    userId,
    type,
    amount,
    description,
    source: 'whatsapp_bot',
    verification: stampVerification('whatsapp_bot'),
    createdAt: Date.now(),
    status: 'pending',
  };
  // pending_transactions is picked up and auto-approved by the app on next open
  await db.collection('pending_transactions').doc(txId).set(tx);
  // also write to trader's subcollection so the AI assistant can read it
  await db.collection(`traders/${userId}/transactions`).doc(txId).set(tx);
  return tx;
}

// POST /whatsapp/webhook — incoming messages
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always acknowledge immediately — Meta requires this

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const from = msg.from; // Sender's WhatsApp number (international format)
    const rawText = (msg.text?.body || '').trim();
    const upper = rawText.toUpperCase().trim();

    if (!from || !rawText) return;

    const db = admin.apps.length ? admin.firestore() : null;
    let userId = null;
    let traderData = null;

    if (db) {
      // Look up trader by WhatsApp number (stored as international format e.g. 2348012345678)
      const snap = await db.collection('traders')
        .where('whatsappNumber', '==', from)
        .limit(1)
        .get();
      if (!snap.empty) {
        userId = snap.docs[0].id;
        traderData = snap.docs[0].data();
      }
    }

    // ── SCORE ──
    if (upper === 'SCORE' || upper === 'MY SCORE') {
      if (userId && traderData) {
        await sendWhatsAppMessage(from,
          `📊 *TRADR Score: ${traderData.tradrScore || 0}/850*\nTier: ${traderData.tier || 'Building'}\n\nRecord every day to grow your score and qualify for a business loan. — TRADR`
        );
      } else {
        await sendWhatsAppMessage(from, 'Open the TRADR app to see your score. Download at tradr.app — TRADR');
      }
      return;
    }

    // ── TODAY / BALANCE ──
    if (['TODAY', 'BALANCE', 'SALES', 'HOW MUCH'].includes(upper)) {
      if (userId && db) {
        const stats = await getTodayStats(userId, db);
        const greeting = stats.todaySales === 0
          ? `No sales recorded today yet. Send me a number to record your first sale!`
          : `💰 Sales: ${fmt(stats.todaySales)}\n💸 Expenses: ${fmt(stats.todayExpenses)}\n📈 Profit: ${fmt(stats.net)}`;
        await sendWhatsAppMessage(from, `*Today so far* 📊\n\n${greeting}\n\n— TRADR`);
      } else {
        await sendWhatsAppMessage(from, 'Link your WhatsApp in the TRADR app first. — TRADR');
      }
      return;
    }

    // ── WEEK ──
    if (upper === 'WEEK' || upper === 'THIS WEEK') {
      if (userId && db) {
        const weekStart = Date.now() - 7 * 86400000;
        const txSnap = await db.collection(`traders/${userId}/transactions`)
          .where('createdAt', '>=', weekStart)
          .get().catch(() => ({ docs: [] }));
        const txs = txSnap.docs.map(d => d.data());
        const weekSales = txs.filter(t => t.type === 'sale').reduce((s, t) => s + t.amount, 0);
        const weekExpenses = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
        await sendWhatsAppMessage(from,
          `📅 *This week*\n\nSales: ${fmt(weekSales)}\nExpenses: ${fmt(weekExpenses)}\nProfit: ${fmt(weekSales - weekExpenses)}\n\n— TRADR`
        );
      }
      return;
    }

    // ── STOP / START ──
    if (upper === 'STOP') {
      if (userId && db) await db.doc(`traders/${userId}`).update({ whatsappOptOut: true });
      await sendWhatsAppMessage(from, 'You have been unsubscribed. Reply START to resubscribe. — TRADR');
      return;
    }

    if (upper === 'START') {
      if (userId && db) await db.doc(`traders/${userId}`).update({ whatsappOptOut: false });
      await sendWhatsAppMessage(from, `Welcome back${traderData?.businessName ? `, ${traderData.businessName}` : ''}! 👋 You will now receive TRADR updates.\n\nSend a number like *5000* to record your first sale. — TRADR`);
      return;
    }

    // ── HELP ──
    if (upper === 'HELP' || upper === 'COMMANDS' || upper === '?') {
      await sendWhatsAppMessage(from,
        `*TRADR Bot* 💬\n\n*Record a sale:*\n5000\nsold rice 5000\nsale ankara 8,500\n\n*Record expense:*\nexpense transport 800\nspent 5000 stock\nbought restock 20000\n\n*Check numbers:*\nTODAY — today\'s sales\nWEEK — this week\nSCORE — your TRADR Score\nHELP — this menu\n\n*Loan requests:*\nYES TRADR — allow a lender to view your profile\nNO TRADR — decline a lender request\n\n*Your records:*\nEXPORT — get your business statement + download link\nPASSPORT — get your shareable credit passport\n\n*Ask anything:*\n"what is my best selling product?"\n"how much profit did I make this month?"\n\n— TRADR`
      );
      return;
    }

    // ── YES TRADR / NO TRADR — lender data consent replies ──
    if (upper === 'YES TRADR' || upper === 'NO TRADR') {
      const approved = upper === 'YES TRADR';

      if (!userId || !db) {
        await sendWhatsAppMessage(from, 'We could not find your TRADR account. Please open the TRADR app. — TRADR');
        return;
      }

      const now = Date.now();
      const pendingSnap = await db.collection('consent_requests')
        .where('trader_id', '==', userId)
        .where('status', '==', 'pending')
        .get().catch(() => ({ empty: true, docs: [] }));

      const activePending = pendingSnap.docs.filter(d => d.data().expires_at > now);

      if (activePending.length === 0) {
        await sendWhatsAppMessage(from, 'No active data access requests found for your account. — TRADR');
        return;
      }

      const batch = db.batch();
      const partnerNames = [];
      const partnerIds = [];

      for (const reqDoc of activePending) {
        const reqData = reqDoc.data();
        partnerNames.push(reqData.partner_name);
        partnerIds.push(reqData.partner_id);
        batch.update(reqDoc.ref, { status: approved ? 'granted' : 'denied', responded_at: now });
      }

      await batch.commit();

      if (approved) {
        const traderRef = db.collection('traders').doc(userId);
        const traderSnap = await traderRef.get();
        const existing = traderSnap.data()?.apiConsent?.partners || [];
        await traderRef.update({
          'apiConsent.granted': true,
          'apiConsent.partners': [...new Set([...existing, ...partnerIds])],
          'apiConsent.lastUpdated': now,
        });
        await sendWhatsAppMessage(from,
          `✅ *Access granted!*\n\n*${partnerNames.join(', ')}* can now view your TRADR profile to check your loan eligibility.\n\nYou can revoke this any time from the TRADR app. — TRADR`
        );
      } else {
        await sendWhatsAppMessage(from,
          `❌ *Access declined.*\n\n*${partnerNames.join(', ')}* will not be able to view your TRADR profile.\n\nYou can start a new loan application any time in the TRADR app. — TRADR`
        );
      }
      return;
    }

    // ── EXPORT ──
    if (EXPORT_COMMANDS.has(upper)) {
      if (!userId) {
        await sendWhatsAppMessage(from, 'Open the TRADR app to link your account first. — TRADR');
        return;
      }
      try {
        const pdfBuffer = await generatePDFStatement(userId, 3);
        const token = createSignedToken(userId, 'csv');
        const downloadUrl = `${SERVER_URL}/export/${token}`;

        await sendWhatsAppDocument(from, pdfBuffer, 'tradr-statement.pdf',
          `📊 *Your TRADR Business Statement*\n\nThis PDF covers your last 3 months — revenue, expenses, profit, and outstanding debts.\n\nFor your full transaction history (CSV), use this link (valid 24 hours):\n${downloadUrl}\n\n— TRADR`
        );
      } catch (e) {
        console.error('[whatsapp] EXPORT error:', e.message);
        await sendWhatsAppMessage(from, 'I could not generate your export right now. Please try again in a few minutes. — TRADR');
      }
      return;
    }

    // ── PASSPORT ──
    if (PASSPORT_COMMANDS.has(upper)) {
      if (!userId) {
        await sendWhatsAppMessage(from, 'Open the TRADR app to link your account first. — TRADR');
        return;
      }
      try {
        const { generatePassport } = require('../services/passport');
        const result = await generatePassport(userId);
        if (result.rateLimited) {
          await sendWhatsAppMessage(from,
            `You have already generated 3 passports today. Try again tomorrow. — TRADR`
          );
          return;
        }
        const verifyUrl = `${SERVER_URL}/verify/${result.passportId}`;
        await sendWhatsAppDocument(from, result.pdfBuffer, 'tradr-credit-passport.pdf',
          `🪪 *Your TRADR Credit Passport*\n\nShare this with any lender or bank to show your business history — no bank statement needed.\n\nLenders can also verify it online: ${verifyUrl}\n\nThis passport is valid for 30 days. — TRADR`
        );
      } catch (e) {
        console.error('[whatsapp] PASSPORT error:', e.message);
        await sendWhatsAppMessage(from, 'I could not generate your passport right now. Try again in a few minutes. — TRADR');
      }
      return;
    }

    // ── SALE / EXPENSE RECORDING (smart parse) ──
    if (userId && db) {
      const parsed = parseTraderMessage(rawText);
      if (parsed) {
        await recordBotTransaction(userId, db, parsed);
        const stats = await getTodayStats(userId, db);
        const verb = parsed.type === 'sale' ? '💰 Sale' : '💸 Expense';
        const descLine = (parsed.description !== 'Sale' && parsed.description !== 'Expense')
          ? `\n${parsed.description}` : '';
        const receiptMsg = withGrowthFooter(
          `✅ *${verb} recorded — ${fmt(parsed.amount)}*${descLine}\n\n📊 Today: ${fmt(stats.todaySales)} in • ${fmt(stats.todayExpenses)} out\n📈 Profit: ${fmt(stats.net)}\n\nOpen TRADR app to see full breakdown. — TRADR`
        );
        await sendWhatsAppMessage(from, receiptMsg);
        logGrowthTouch('whatsapp_receipt', userId).catch(() => {});
        return;
      }
    }

    // ── UNKNOWN MESSAGE — forward to AI assistant ──
    if (userId) {
      await forwardToAssistant(from, rawText, userId);
    } else {
      await sendWhatsAppMessage(from,
        `Hello! 👋 I\'m the TRADR bot.\n\nTo use me, open the TRADR app and save your WhatsApp number in Settings.\n\nThen you can:\n• Send *5000* to record a sale\n• Send *TODAY* to see your numbers\n• Ask me anything about your business\n\nDownload TRADR: tradr.app — TRADR`
      );
    }
  } catch (e) {
    console.error('[whatsapp] Webhook error:', e.message);
  }
});

async function forwardToAssistant(phone, message, userId) {
  try {
    const fetch = require('node-fetch');
    const serverUrl = process.env.SERVER_URL || 'http://localhost:3000';
    await fetch(`${serverUrl}/assistant/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message, userId }),
    });
  } catch (e) {
    await sendWhatsAppMessage(phone, 'I am having trouble right now. Open the TRADR app for help. — TRADR').catch(() => {});
  }
}

module.exports = router;
