const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const ZEEH_BASE = 'https://api.zeeh.africa/v1';
const ZEEH_KEY = process.env.ZEEH_API_KEY;

async function zeehPost(path, body) {
  const res = await fetch(`${ZEEH_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ZEEH_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Zeeh request failed');
  return data;
}

// POST /bureau/verify-bvn
router.post('/verify-bvn', async (req, res) => {
  const { userId, bvn, firstName, lastName, dob } = req.body;
  if (!userId || !bvn) return res.status(400).json({ error: 'userId and bvn required' });

  try {
    const result = await zeehPost('/identity/bvn', { bvn, firstName, lastName, dob });

    const db = admin.firestore();
    await db.collection('traders').doc(userId).set({
      bvn: bvn.substring(0, 3) + '****' + bvn.substring(7), // masked
      bvnVerified: true,
      bvnVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      bvnData: {
        name: result.data?.fullName || `${result.data?.firstName} ${result.data?.lastName}`,
        phone: result.data?.phone,
        gender: result.data?.gender,
      },
    }, { merge: true });

    res.json({ success: true, name: result.data?.fullName });
  } catch (e) {
    console.error('[bureau] BVN verify error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// POST /bureau/credit-check
router.post('/credit-check', async (req, res) => {
  const { userId, bvn } = req.body;
  if (!userId || !bvn) return res.status(400).json({ error: 'userId and bvn required' });

  try {
    const result = await zeehPost('/credit/basic', { bvn });

    const creditData = {
      totalLoans: result.data?.totalLoans || 0,
      activeLoans: result.data?.activeLoans || 0,
      overdueLoans: result.data?.overdueLoans || 0,
      creditScore: result.data?.creditScore || null,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const db = admin.firestore();
    await db.collection('traders').doc(userId).set({ creditData }, { merge: true });

    res.json({ success: true, creditData });
  } catch (e) {
    console.error('[bureau] Credit check error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// GET /bureau/status/:userId
router.get('/status/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const db = admin.firestore();
    const doc = await db.collection('traders').doc(userId).get();
    if (!doc.exists) return res.json({ bvnVerified: false });
    const data = doc.data();
    res.json({
      bvnVerified: data.bvnVerified || false,
      bvnMasked: data.bvn || null,
      bvnName: data.bvnData?.name || null,
      creditData: data.creditData || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
