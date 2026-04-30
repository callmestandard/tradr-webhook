const express = require('express');
const admin = require('../firebaseAdmin');
const { sendWhatsAppMessage, sendDebtReminder } = require('../utils/whatsapp');

const router = express.Router();

function fmt(n) {
  return '₦' + (n || 0).toLocaleString('en-NG');
}

function calcScore(transactions, contacts) {
  const now = Date.now();

  // Consistency (30 pts)
  const last30Days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    return d.getTime();
  });
  const daysWithActivity = last30Days.filter(dayStart =>
    transactions.some(t => t.createdAt >= dayStart && t.createdAt < dayStart + 86400000)
  ).length;
  const consistencyScore = Math.round((daysWithActivity / 30) * 30);

  // Volume vs benchmark (25 pts)
  const startOfMonth = new Date();
  startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
  const monthSales = transactions
    .filter(t => t.type === 'sale' && t.createdAt >= startOfMonth.getTime())
    .reduce((s, t) => s + t.amount, 0);
  const BENCHMARK = 150000;
  const volumeScore = Math.round(Math.min(monthSales / BENCHMARK, 1) * 25);

  // Stability — income variance (20 pts)
  const weeklyTotals = [];
  for (let i = 0; i < 4; i++) {
    const start = now - (i + 1) * 7 * 86400000;
    const end = now - i * 7 * 86400000;
    weeklyTotals.push(
      transactions.filter(t => t.type === 'sale' && t.createdAt >= start && t.createdAt < end)
        .reduce((s, t) => s + t.amount, 0)
    );
  }
  const mean = weeklyTotals.reduce((a, b) => a + b, 0) / weeklyTotals.length;
  const variance = weeklyTotals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / weeklyTotals.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  const stabilityScore = cv <= 0.2 ? 20 : cv <= 0.4 ? 16 : cv <= 0.6 ? 11 : cv <= 0.8 ? 6 : 2;

  // Digital ratio (15 pts)
  const recentSales = transactions.filter(t => t.type === 'sale' && t.createdAt >= now - 30 * 86400000);
  const digitalSales = recentSales.filter(t => t.source === 'sms_auto' || t.paymentMethod === 'transfer');
  const digitalScore = recentSales.length > 0
    ? Math.round((digitalSales.length / recentSales.length) * 15) : 5;

  // Expense management (5 pts)
  const recentRevenue = recentSales.reduce((s, t) => s + t.amount, 0);
  const recentExpenses = transactions
    .filter(t => t.type === 'expense' && t.createdAt >= now - 30 * 86400000)
    .reduce((s, t) => s + t.amount, 0);
  const expenseScore = recentRevenue > 0
    ? (recentExpenses / recentRevenue <= 0.4 ? 5 : recentExpenses / recentRevenue <= 0.7 ? 3 : 1) : 2;

  // Profile completeness (5 pts) — just give 5 since they went through onboarding
  const profileScore = 5;

  const rawTotal = consistencyScore + volumeScore + stabilityScore + digitalScore + expenseScore + profileScore;
  const cappedRaw = Math.min(rawTotal, 100);
  const publicScore = Math.round(cappedRaw * 8.5);

  const firstTx = transactions.length > 0 ? Math.min(...transactions.map(t => t.createdAt)) : null;
  const totalDaysRecording = firstTx ? Math.floor((now - firstTx) / 86400000) : 0;

  return { publicScore, totalDaysRecording, daysWithActivity };
}

function getTier(score) {
  if (score >= 700) return 'Trusted';
  if (score >= 500) return 'Established';
  if (score >= 300) return 'Growing';
  return 'Building';
}

function calculateStreak(transactions) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let streak = 0;
  let dayStart = today.getTime();
  while (true) {
    const hasActivity = transactions.some(
      t => t.createdAt >= dayStart && t.createdAt < dayStart + 86400000
    );
    if (!hasActivity) break;
    streak++;
    dayStart -= 86400000;
  }
  return streak;
}

function buildMorningMessage(trader, { publicScore, tier, totalDaysRecording, transactions, contacts, isSunday, monthSales, monthExpenses }) {
  const name = trader.businessName || 'Trader';
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = days[new Date().getDay()];

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const ySales = transactions
    .filter(t => t.type === 'sale' && t.createdAt >= yesterday.getTime() && t.createdAt < yesterday.getTime() + 86400000)
    .reduce((s, t) => s + t.amount, 0);

  const streak = calculateStreak(transactions);
  const debtors = contacts.filter(c => c.totalOwed > 0);
  const totalOwed = debtors.reduce((s, c) => s + (c.totalOwed || 0), 0);
  const isLoanReady = publicScore >= 500 && totalDaysRecording >= 60;

  const greetings = {
    Monday: 'New week, fresh start 💪',
    Tuesday: "You're on a roll 🔥",
    Wednesday: 'Halfway through — keep pushing 💰',
    Thursday: 'Almost the weekend — make it count 📈',
    Friday: 'Finish strong this week 🏁',
    Saturday: 'Market day hustle 🛍️',
    Sunday: 'Rest day blessings 🙏',
  };

  let msg = `Good morning, ${name}! ${greetings[dayName] || ''}\n\n`;

  if (ySales > 0) {
    msg += `📊 Yesterday: ${fmt(ySales)} recorded\n`;
  } else {
    msg += `📊 No sales yesterday — today is a new chance\n`;
  }

  if (streak > 1) msg += `🔥 ${streak}-day streak — don't break it!\n`;

  msg += `⭐ TRADR Score: ${publicScore}/850 (${tier})\n`;

  if (isLoanReady) {
    msg += `🏦 You qualify for a business loan! Reply YES to apply.\n`;
  } else if (publicScore >= 400) {
    msg += `🏦 ${500 - publicScore} more points until loan access\n`;
  }

  if (debtors.length > 0) {
    msg += `👥 ${debtors.length} ${debtors.length === 1 ? 'person owes' : 'people owe'} you ${fmt(totalOwed)}\n`;
  }

  if (isSunday) {
    const profit = monthSales - monthExpenses;
    msg += `\n📅 This month: ${fmt(monthSales)} sales, ${fmt(profit)} profit`;
  }

  msg += `\n\nStay sharp. Every sale counts. — TRADR`;
  return msg;
}

async function runNightlyAgent() {
  if (!admin.apps.length) {
    console.log('[agent] Firebase not initialised — skipping nightly run');
    return;
  }

  const db = admin.firestore();
  const today = new Date().toISOString().split('T')[0];
  const isSunday = new Date().getDay() === 0;

  const tradersSnap = await db.collection('traders').get();
  if (tradersSnap.empty) {
    console.log('[agent] No traders found');
    return;
  }

  let processed = 0;

  for (const doc of tradersSnap.docs) {
    const userId = doc.id;
    const trader = doc.data();
    if (!trader.active) continue;

    try {
      // Pull transactions and contacts
      const txSnap = await db.collection(`traders/${userId}/transactions`)
        .where('createdAt', '>=', Date.now() - 90 * 86400000)
        .get();
      const contactsSnap = await db.collection(`traders/${userId}/contacts`).get();

      const transactions = txSnap.docs.map(d => d.data());
      const contacts = contactsSnap.docs.map(d => d.data());

      // Calculate score
      const { publicScore, totalDaysRecording, daysWithActivity } = calcScore(transactions, contacts);
      const tier = getTier(publicScore);

      // Get previous score
      const prevRunSnap = await db.collection(`nightly_runs/${userId}`)
        .orderBy('timestamp', 'desc').limit(1).get();
      const prevScore = prevRunSnap.empty ? 0 : (prevRunSnap.docs[0].data().score || 0);
      const scoreChange = publicScore - prevScore;

      // Detect events
      const events = [];
      if (publicScore >= 300 && prevScore < 300) events.push('LOAN_READY');
      if (scoreChange <= -20) events.push('SCORE_DROP');
      if (daysWithActivity === 0) events.push('STREAK_BROKEN');

      // Save nightly run record
      await db.doc(`nightly_runs/${userId}/${today}`).set({
        score: publicScore,
        scoreChange,
        tier,
        events,
        totalDaysRecording,
        timestamp: Date.now(),
      });

      // Update trader score
      await db.doc(`traders/${userId}`).update({ tradrScore: publicScore, tier, lastUpdated: Date.now() });

      // Queue morning message for 6:30am send
      const whatsappNumber = trader.whatsappNumber;
      if (whatsappNumber) {
        const monthStart = new Date();
        monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
        const monthSales = transactions
          .filter(t => t.type === 'sale' && t.createdAt >= monthStart.getTime())
          .reduce((s, t) => s + t.amount, 0);
        const monthExpenses = transactions
          .filter(t => t.type === 'expense' && t.createdAt >= monthStart.getTime())
          .reduce((s, t) => s + t.amount, 0);
        const message = buildMorningMessage(trader, {
          publicScore, tier, totalDaysRecording, transactions, contacts,
          isSunday, monthSales, monthExpenses,
        });
        await db.doc(`morning_queue/${userId}`).set({
          message, whatsappNumber, userId, queuedAt: Date.now(),
        });
      }

      // Debt reminders — language-aware
      const language = trader.reminderLanguage || 'pidgin';
      const debtors = contacts.filter(c => c.totalOwed > 0 && c.phone && c.dueDate);
      for (const debtor of debtors) {
        const daysUntilDue = Math.floor((debtor.dueDate - Date.now()) / 86400000);
        if (daysUntilDue === 3 || daysUntilDue === 0 || daysUntilDue === -1) {
          try {
            await sendDebtReminder({
              debtorPhone: debtor.phone,
              debtorName: debtor.name,
              amount: debtor.totalOwed,
              traderName: trader.businessName || 'your creditor',
              daysSinceDue: daysUntilDue < 0 ? Math.abs(daysUntilDue) : 0,
              language,
            });
          } catch (e) {}
        }
      }

      processed++;
    } catch (e) {
      console.error(`[agent] Error processing trader ${userId}:`, e.message);
    }
  }

  console.log(`[agent] Nightly run complete — ${processed} traders processed`);
  return { processed, date: today };
}

async function sendMorningMessages() {
  if (!admin.apps.length) return;
  const db = admin.firestore();
  const snap = await db.collection('morning_queue').get();
  if (snap.empty) { console.log('[agent] Morning queue empty'); return; }

  let sent = 0;
  for (const doc of snap.docs) {
    const { message, whatsappNumber } = doc.data();
    if (!message || !whatsappNumber) { await doc.ref.delete(); continue; }
    try {
      await sendWhatsAppMessage(whatsappNumber, message);
      sent++;
    } catch (e) {
      console.error(`[agent] Morning message failed for ${doc.id}:`, e.message);
    }
    await doc.ref.delete();
  }
  console.log(`[agent] Morning messages sent: ${sent}`);
}

// POST /agent/nightly-run — triggered by cron or manually
router.post('/nightly-run', async (req, res) => {
  const secret = req.headers['x-agent-secret'];
  if (secret !== process.env.AGENT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await runNightlyAgent();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /agent/status/:userId
router.get('/status/:userId', async (req, res) => {
  if (!admin.apps.length) return res.json({ agentActive: false });

  const { userId } = req.params;
  const db = admin.firestore();
  try {
    const trader = (await db.doc(`traders/${userId}`).get()).data() || {};
    const runsSnap = await db.collection(`nightly_runs/${userId}`)
      .orderBy('timestamp', 'desc').limit(1).get();
    const lastRun = runsSnap.empty ? null : runsSnap.docs[0].data();

    // Count auto-recorded transactions this month
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const autoSnap = await db.collection(`traders/${userId}/transactions`)
      .where('source', '==', 'sms_auto')
      .where('createdAt', '>=', monthStart.getTime())
      .get();
    const autoRecords = autoSnap.docs.length;
    const autoAmount = autoSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);

    res.json({
      agentActive: trader.agentActivated || false,
      bankConnected: !!trader.monoAccountId,
      whatsappNumber: trader.whatsappNumber || null,
      lastNightlyRun: lastRun?.timestamp || null,
      lastScoreUpdate: trader.lastUpdated || null,
      automatedRecordsThisMonth: autoRecords,
      moneyAutoRecorded: autoAmount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, runNightlyAgent, sendMorningMessages };
