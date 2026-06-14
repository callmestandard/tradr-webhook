const express = require('express');
const { sendTelegramMessage } = require('../utils/telegram');
const { stampVerification } = require('../services/verification');
const admin = require('../firebaseAdmin');

const router = express.Router();

// In-memory set of chat IDs currently in "awaiting phone number" state
const awaitingPhone = new Set();

function fmt(n) {
  return '₦' + (n || 0).toLocaleString('en-NG');
}

function parseTraderMessage(raw) {
  const text = raw.trim();
  const lower = text.toLowerCase();

  const pureNum = text.replace(/[,₦\s]/g, '');
  if (/^\d+(\.\d{1,2})?$/.test(pureNum)) {
    return { type: 'sale', amount: parseFloat(pureNum), description: 'Sale' };
  }

  const numMatch = text.match(/[\d,]+(?:\.\d{1,2})?/);
  if (!numMatch) return null;
  const amount = parseFloat(numMatch[0].replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0 || amount > 50000000) return null;

  const isExpense = /^(expense|spent|spend|bought|buy|exp\b|paid|cost|restock|buying|transport|fuel|rent|salary)/i.test(lower);
  const type = isExpense ? 'expense' : 'sale';

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
  return { todaySales, todayExpenses, net: todaySales - todayExpenses };
}

async function recordBotTransaction(userId, db, { type, amount, description }) {
  const txId = `tg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tx = {
    id: txId,
    userId,
    type,
    amount,
    description,
    source: 'telegram_bot',
    verification: stampVerification('telegram_bot'),
    createdAt: Date.now(),
    status: 'pending',
  };
  await db.collection('pending_transactions').doc(txId).set(tx);
  await db.collection(`traders/${userId}/transactions`).doc(txId).set(tx);
  return tx;
}

// POST /telegram/webhook
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always ack immediately

  try {
    const message = req.body?.message;
    if (!message) return;

    const chatId = message.chat?.id;
    const rawText = (message.text || '').trim();
    if (!chatId || !rawText) return;

    const upper = rawText.toUpperCase().trim();
    const db = admin.apps.length ? admin.firestore() : null;

    // ── LOOK UP TRADER BY TELEGRAM CHAT ID ──
    let userId = null;
    let traderData = null;

    if (db) {
      const snap = await db.collection('traders')
        .where('telegramChatId', '==', String(chatId))
        .limit(1)
        .get();
      if (!snap.empty) {
        userId = snap.docs[0].id;
        traderData = snap.docs[0].data();
      }
    }

    // ── ACCOUNT LINKING ──
    // Unlinked user in "awaiting phone" state → try to match phone number
    if (!userId && awaitingPhone.has(chatId)) {
      const digits = rawText.replace(/\D/g, '');
      let intlNum = digits;
      if (intlNum.startsWith('0')) intlNum = '234' + intlNum.slice(1);

      if (db && intlNum.length >= 12) {
        const snap = await db.collection('traders')
          .where('whatsappNumber', '==', intlNum)
          .limit(1)
          .get();

        if (!snap.empty) {
          userId = snap.docs[0].id;
          traderData = snap.docs[0].data();
          await db.doc(`traders/${userId}`).update({ telegramChatId: String(chatId) });
          awaitingPhone.delete(chatId);
          const name = traderData.businessName ? `, ${traderData.businessName}` : '';
          await sendTelegramMessage(chatId,
            `✅ *Linked!* Your TRADR account is connected${name}.\n\nSend me a number like *5000* to record your first sale, or type *HELP* to see all commands. — TRADR`
          );
          return;
        } else {
          await sendTelegramMessage(chatId,
            `I couldn't find a TRADR account with that number. Make sure you've saved your number in the TRADR app under Settings.\n\nTry again or type *HELP*. — TRADR`
          );
          return;
        }
      }
    }

    // Unlinked user — start linking or show /start message
    if (!userId) {
      if (rawText.startsWith('/start') || upper === 'START' || upper === 'LINK') {
        awaitingPhone.add(chatId);
        await sendTelegramMessage(chatId,
          `👋 Welcome to *TRADR Bot*!\n\nTo link your account, send me the phone number you used to sign up in the TRADR app.\n\nExample: *08012345678*\n\n— TRADR`
        );
      } else {
        await sendTelegramMessage(chatId,
          `👋 I'm the *TRADR Bot*.\n\nTo get started, type /start and I'll link your TRADR account. Then you can:\n\n• Send *5000* to record a ₦5,000 sale\n• Send *TODAY* to see your daily numbers\n• Ask me anything about your business\n\n— TRADR`
        );
      }
      return;
    }

    // ── COMMANDS FOR LINKED USERS ──

    if (upper === 'SCORE' || upper === 'MY SCORE') {
      await sendTelegramMessage(chatId,
        `📊 *TRADR Score: ${traderData.tradrScore || 0}/850*\nTier: ${traderData.tier || 'Building'}\n\nRecord every day to grow your score and qualify for a business loan. — TRADR`
      );
      return;
    }

    if (['TODAY', 'BALANCE', 'SALES', 'HOW MUCH'].includes(upper)) {
      const stats = await getTodayStats(userId, db);
      const body = stats.todaySales === 0
        ? `No sales recorded today yet. Send me a number to record your first sale!`
        : `💰 Sales: ${fmt(stats.todaySales)}\n💸 Expenses: ${fmt(stats.todayExpenses)}\n📈 Profit: ${fmt(stats.net)}`;
      await sendTelegramMessage(chatId, `*Today so far* 📊\n\n${body}\n\n— TRADR`);
      return;
    }

    if (upper === 'WEEK' || upper === 'THIS WEEK') {
      const weekStart = Date.now() - 7 * 86400000;
      const txSnap = await db.collection(`traders/${userId}/transactions`)
        .where('createdAt', '>=', weekStart)
        .get().catch(() => ({ docs: [] }));
      const txs = txSnap.docs.map(d => d.data());
      const wSales = txs.filter(t => t.type === 'sale').reduce((s, t) => s + t.amount, 0);
      const wExp = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
      await sendTelegramMessage(chatId,
        `📅 *This week*\n\nSales: ${fmt(wSales)}\nExpenses: ${fmt(wExp)}\nProfit: ${fmt(wSales - wExp)}\n\n— TRADR`
      );
      return;
    }

    if (upper === 'STOP') {
      await db.doc(`traders/${userId}`).update({ telegramOptOut: true });
      await sendTelegramMessage(chatId, 'You have been unsubscribed. Type START to resubscribe. — TRADR');
      return;
    }

    if (upper === 'START' || upper === 'LINK') {
      await db.doc(`traders/${userId}`).update({ telegramOptOut: false });
      const name = traderData?.businessName ? `, ${traderData.businessName}` : '';
      await sendTelegramMessage(chatId,
        `Welcome back${name}! 👋 You will now receive TRADR updates.\n\nSend a number like *5000* to record a sale. — TRADR`
      );
      return;
    }

    if (upper === 'HELP' || upper === 'COMMANDS' || upper === '?') {
      await sendTelegramMessage(chatId,
        `*TRADR Bot* 💬\n\n*Record a sale:*\n5000\nsold rice 5000\nsale ankara 8,500\n\n*Record expense:*\nexpense transport 800\nspent 5000 stock\nbought restock 20000\n\n*Check numbers:*\nTODAY — today's sales\nWEEK — this week\nSCORE — your TRADR Score\nHELP — this menu\n\n*Ask anything:*\n"what is my best selling product?"\n"how much profit did I make this month?"\n\n— TRADR`
      );
      return;
    }

    // ── SALE / EXPENSE RECORDING ──
    const parsed = parseTraderMessage(rawText);
    if (parsed) {
      await recordBotTransaction(userId, db, parsed);
      const stats = await getTodayStats(userId, db);
      const verb = parsed.type === 'sale' ? '💰 Sale' : '💸 Expense';
      const descLine = (parsed.description !== 'Sale' && parsed.description !== 'Expense')
        ? `\n${parsed.description}` : '';
      await sendTelegramMessage(chatId,
        `✅ *${verb} recorded — ${fmt(parsed.amount)}*${descLine}\n\n📊 Today: ${fmt(stats.todaySales)} in • ${fmt(stats.todayExpenses)} out\n📈 Profit: ${fmt(stats.net)}\n\nOpen TRADR app to see full breakdown. — TRADR`
      );
      return;
    }

    // ── FORWARD TO CLAUDE AI ASSISTANT ──
    try {
      const fetch = require('node-fetch');
      const serverUrl = process.env.SERVER_URL || 'http://localhost:3000';
      const aiRes = await fetch(`${serverUrl}/assistant/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: `tg_${chatId}`, message: rawText, userId }),
      });
      const aiData = await aiRes.json();
      if (aiData?.reply) {
        await sendTelegramMessage(chatId, aiData.reply);
      }
    } catch (e) {
      await sendTelegramMessage(chatId, 'I am having trouble right now. Open the TRADR app for help. — TRADR').catch(() => {});
    }

  } catch (e) {
    console.error('[telegram] Webhook error:', e.message);
  }
});

module.exports = router;
