const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const admin = require('../firebaseAdmin');
const { sendWhatsAppMessage } = require('../utils/whatsapp');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function fmt(n) {
  return '₦' + (n || 0).toLocaleString('en-NG');
}

async function getTraderContext(userId) {
  if (!admin.apps.length) return null;
  const db = admin.firestore();

  const trader = (await db.doc(`traders/${userId}`).get()).data() || {};
  const now = Date.now();
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const txSnap = await db.collection(`traders/${userId}/transactions`)
    .where('createdAt', '>=', now - 30 * 86400000)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  const transactions = txSnap.docs.map(d => d.data());

  const contactsSnap = await db.collection(`traders/${userId}/contacts`).get();
  const contacts = contactsSnap.docs.map(d => d.data());

  const monthSales = transactions
    .filter(t => t.type === 'sale' && t.createdAt >= monthStart.getTime())
    .reduce((s, t) => s + t.amount, 0);
  const monthExpenses = transactions
    .filter(t => t.type === 'expense' && t.createdAt >= monthStart.getTime())
    .reduce((s, t) => s + t.amount, 0);

  const debtors = contacts.filter(c => c.totalOwed > 0);
  const totalOwed = debtors.reduce((s, c) => s + (c.totalOwed || 0), 0);

  const productMap = {};
  transactions.filter(t => t.type === 'sale' && t.description).forEach(t => {
    const key = t.description;
    productMap[key] = (productMap[key] || 0) + (t.amount || 0);
  });
  const topProduct = Object.entries(productMap).sort((a, b) => b[1] - a[1])[0];

  const recentTx = transactions.slice(0, 10).map(t =>
    `${t.type === 'sale' ? '+' : '-'}${fmt(t.amount)} ${t.description || ''} (${new Date(t.createdAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })})`
  );

  return {
    businessName: trader.businessName || 'Your Business',
    businessType: trader.businessType || 'General',
    tradrScore: trader.tradrScore || 0,
    tier: trader.tier || 'Building',
    monthlyRevenueLast30: monthSales,
    monthlyExpensesLast30: monthExpenses,
    profitLast30: monthSales - monthExpenses,
    totalOwed,
    debtorCount: debtors.length,
    topSellingProduct: topProduct ? topProduct[0] : null,
    bankConnected: !!trader.monoAccountId,
    recentTransactions: recentTx,
  };
}

// POST /assistant/message
router.post('/message', async (req, res) => {
  const { phone, message, userId } = req.body;
  if (!message || !userId) return res.status(400).json({ error: 'Missing message or userId' });

  try {
    const ctx = await getTraderContext(userId);

    const systemPrompt = ctx
      ? `You are TRADR's financial assistant for Nigerian informal traders. You have access to this trader's real business data. Answer questions in simple English with a warm, friendly Nigerian tone. Never use jargon. Always use ₦ for Naira. Keep responses under 300 characters for WhatsApp readability.

Trader data:
- Business: ${ctx.businessName} (${ctx.businessType})
- TRADR Score: ${ctx.tradrScore}/850 (${ctx.tier})
- Sales last 30 days: ${fmt(ctx.monthlyRevenueLast30)}
- Expenses last 30 days: ${fmt(ctx.monthlyExpensesLast30)}
- Profit last 30 days: ${fmt(ctx.profitLast30)}
- Debtors: ${ctx.debtorCount} people owe ${fmt(ctx.totalOwed)}
- Top product: ${ctx.topSellingProduct || 'not tracked'}
- Bank connected: ${ctx.bankConnected ? 'Yes' : 'No'}
- Recent transactions: ${ctx.recentTransactions.join(', ')}

You can answer questions about their sales, profit, score, debtors, and business tips. You cannot promise loans you cannot guarantee. Keep it warm and real.`
      : `You are TRADR's financial assistant for Nigerian traders. Keep responses under 300 characters. Be warm and friendly.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    });

    const reply = response.content[0]?.text || 'I am having trouble right now. Please try again. — TRADR';

    // Send via WhatsApp if phone provided
    if (phone) {
      await sendWhatsAppMessage(phone, reply + '\n— TRADR');
    }

    res.json({ reply });
  } catch (e) {
    console.error('[assistant] Error:', e.message);
    const fallback = 'Sorry, I am having trouble right now. Open the TRADR app for help. — TRADR';
    if (phone) await sendWhatsAppMessage(phone, fallback).catch(() => {});
    res.status(500).json({ error: e.message, reply: fallback });
  }
});

module.exports = router;
