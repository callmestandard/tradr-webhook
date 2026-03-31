const express = require('express');
const axios = require('axios');
const admin = require('../firebaseAdmin');

const router = express.Router();

const MONO_API = 'https://api.withmono.com/v2';

function getDb() {
  if (!admin.apps.length) {
    throw new Error('Firebase Admin is not initialised. Check FIREBASE_* env vars.');
  }
  return admin.firestore();
}

function verifyWebhookSecret(req) {
  const expected = process.env.MONO_WEBHOOK_SECRET;
  if (!expected) return false;
  const header = req.headers['mono-webhook-secret'];
  if (header == null || header === '') return false;
  return String(header).trim() === String(expected).trim();
}

function normalizeTransactionList(body) {
  const d = body && body.data;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.transactions)) return d.transactions;
  if (Array.isArray(d.data)) return d.data;
  return [];
}

async function fetchMonoTransactions(accountId) {
  const key = process.env.MONO_SECRET_KEY;
  if (!key) throw new Error('MONO_SECRET_KEY is not set');

  const { data } = await axios.get(`${MONO_API}/accounts/${accountId}/transactions`, {
    headers: {
      'mono-sec-key': key,
      accept: 'application/json',
    },
    params: { limit: 30 },
  });

  return normalizeTransactionList(data);
}

async function fetchAccountBankName(accountId) {
  const key = process.env.MONO_SECRET_KEY;
  if (!key) return '';
  try {
    const { data } = await axios.get(`${MONO_API}/accounts/${accountId}`, {
      headers: {
        'mono-sec-key': key,
        accept: 'application/json',
      },
    });
    const acc = data && (data.data || data);
    return acc?.institution?.name || acc?.account?.institution?.name || '';
  } catch {
    return '';
  }
}

async function monoTransactionExists(db, monoTransactionId) {
  const snap = await db
    .collection('pending_transactions')
    .where('monoTransactionId', '==', monoTransactionId)
    .limit(1)
    .get();
  return !snap.empty;
}

async function sendFcmToUser(userId, title, body, dataPayload = {}) {
  if (!admin.apps.length || !admin.messaging) return;

  let token;
  const tokenDoc = await getDb().collection('user_fcm_tokens').doc(userId).get();
  if (tokenDoc.exists) token = tokenDoc.data()?.token;

  if (!token) {
    const monoDoc = await getDb()
      .collection('mono_accounts')
      .where('userId', '==', userId)
      .limit(1)
      .get();
    if (!monoDoc.empty) token = monoDoc.docs[0].data()?.fcmToken;
  }

  if (!token) return;

  const data = {};
  Object.entries(dataPayload).forEach(([k, v]) => {
    data[k] = String(v);
  });

  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data,
    });
  } catch (e) {
    console.error('FCM send skipped:', e.message);
  }
}

async function processAccountUpdatedWebhook(payload) {
  if (!admin.apps.length) return;

  const event = payload?.event;
  if (event !== 'mono.events.account_updated') return;

  const account = payload?.data?.account;
  const accountId = account?._id != null ? String(account._id) : '';
  if (!accountId) return;

  const db = getDb();
  const accountSnap = await db.collection('mono_accounts').doc(accountId).get();
  if (!accountSnap.exists) {
    return;
  }

  const userId = accountSnap.data()?.userId;
  if (!userId) return;

  const bankName =
    account?.institution?.name || accountSnap.data()?.bankName || '';

  const transactions = await fetchMonoTransactions(accountId);

  for (const tx of transactions) {
    const type = (tx.type || '').toLowerCase();
    if (type !== 'credit') continue;

    const monoTransactionId = String(tx.id || tx._id || '');
    if (!monoTransactionId) continue;

    if (await monoTransactionExists(db, monoTransactionId)) continue;

    const amountNaira = (tx.amount || 0) / 100;

    await db.collection('pending_transactions').add({
      userId,
      amount: amountNaira,
      date: tx.date || new Date().toISOString(),
      narration: tx.narration || '',
      type: 'credit',
      source: 'mono_auto',
      status: 'pending',
      bankName: bankName || '',
      createdAt: Date.now(),
      monoTransactionId,
    });

    await sendFcmToUser(
      userId,
      'Money in',
      `₦${amountNaira.toLocaleString('en-NG')} received. Open TRADR to review.`,
      { type: 'mono_pending', monoTransactionId }
    );
  }
}

router.post('/webhook', async (req, res) => {
  if (!verifyWebhookSecret(req)) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  res.status(200).json({ received: true });

  try {
    await processAccountUpdatedWebhook(req.body);
  } catch (err) {
    console.error('Mono webhook processing error:', err.message);
  }
});

router.post('/exchange-token', async (req, res) => {
  try {
    const { code, userId, fcmToken } = req.body || {};
    if (!code || !userId) {
      return res.status(400).json({ error: 'code and userId are required' });
    }

    const key = process.env.MONO_SECRET_KEY;
    if (!key) {
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const { data } = await axios.post(
      `${MONO_API}/accounts/auth`,
      { code },
      {
        headers: {
          'Content-Type': 'application/json',
          accept: 'application/json',
          'mono-sec-key': key,
        },
      }
    );

    const accountId =
      data?.id || data?.data?.id || data?.data?._id || data?.account_id;

    if (!accountId) {
      return res.status(502).json({ error: 'Could not read account from Mono' });
    }

    if (!admin.apps.length) {
      return res.status(500).json({ error: 'Firebase Admin not configured' });
    }

    const db = getDb();
    await db
      .collection('mono_accounts')
      .doc(String(accountId))
      .set(
        {
          userId: String(userId),
          accountId: String(accountId),
          updatedAt: Date.now(),
          ...(fcmToken ? { fcmToken: String(fcmToken) } : {}),
        },
        { merge: true }
      );

    return res.json({ success: true, accountId: String(accountId) });
  } catch (err) {
    const msg =
      err.response?.data?.message || err.message || 'Exchange failed';
    return res.status(400).json({ error: msg });
  }
});

router.get('/transactions/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const list = await fetchMonoTransactions(accountId);
    let bankName = await fetchAccountBankName(accountId);
    if (!bankName && list.length && list[0].bank_name) {
      bankName = list[0].bank_name;
    }

    const transactions = list.map((t) => ({
      id: t.id || t._id,
      amount: (t.amount || 0) / 100,
      date: t.date,
      narration: t.narration,
      type: t.type,
      bankName: bankName || '',
    }));

    return res.json({ transactions });
  } catch (err) {
    console.error('Mono transactions error:', err.message);
    return res.status(500).json({ error: 'Could not load transactions' });
  }
});

module.exports = router;
