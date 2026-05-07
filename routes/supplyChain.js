const express = require('express');
const router = express.Router();
const admin = require('../firebaseAdmin');

function getDb() {
  if (!admin.apps.length) throw new Error('Firebase not initialised');
  return admin.firestore();
}

function fmt(n) { return '₦' + (n || 0).toLocaleString('en-NG'); }

function getCreditMultiplier(score) {
  if (score >= 700) return 1.5;
  if (score >= 500) return 1.0;
  if (score >= 300) return 0.5;
  return 0;
}

async function getLatestTraderFeatures(db, userId) {
  const mlSnap = await db.collection('ml_features').doc(userId)
    .collection('daily')
    .orderBy('date', 'desc')
    .limit(1)
    .get();

  if (!mlSnap.empty) {
    const data = mlSnap.docs[0].data();
    return {
      tradrScore: data.tradrScore || 0,
      monthlyRevenue: data.features?.monthlyRevenue || 0,
    };
  }

  const traderSnap = await db.collection('traders').doc(userId).get();
  if (!traderSnap.exists) return null;
  const trader = traderSnap.data();
  return {
    tradrScore: trader.tradrScore || 0,
    monthlyRevenue: 0,
  };
}

// POST /supply/assess-trader
router.post('/assess-trader', async (req, res) => {
  const { userId, requestedGoodsValue, supplierName } = req.body;
  if (!userId || !requestedGoodsValue) {
    return res.status(400).json({ error: 'userId and requestedGoodsValue are required' });
  }

  try {
    const db = getDb();
    const features = await getLatestTraderFeatures(db, userId);
    if (!features) return res.status(404).json({ error: 'Trader not found' });

    const { tradrScore, monthlyRevenue } = features;
    const multiplier = getCreditMultiplier(tradrScore);

    if (multiplier === 0) {
      return res.json({
        eligible: false,
        tradrScore,
        reason: 'Score below 300 — trader not yet eligible for supply chain financing',
        minimumScore: 300,
      });
    }

    const creditLimit = Math.round(monthlyRevenue * multiplier);
    const requested = Number(requestedGoodsValue);
    const recommendation = requested <= creditLimit ? 'APPROVE' : 'REDUCE';

    res.json({
      eligible: true,
      tradrScore,
      creditLimit,
      requestedAmount: requested,
      recommendation,
      repaymentWindow: '30 days',
      guaranteeId: `TRADR-SCF-${Date.now()}-${userId.slice(0, 8)}`,
      conditions: [
        'Trader must record all sales in TRADR during the repayment period',
        'Auto-deduction of 15% of daily sales toward repayment',
        `Credit limit based on ${Math.round(multiplier * 100)}% of monthly revenue of ${fmt(monthlyRevenue)}`,
      ],
    });
  } catch (e) {
    console.error('[supply] Assess error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /supply/create-guarantee
router.post('/create-guarantee', async (req, res) => {
  const { userId, supplierName, goodsValue, goodsDescription } = req.body;
  if (!userId || !supplierName || !goodsValue) {
    return res.status(400).json({ error: 'userId, supplierName, and goodsValue are required' });
  }

  try {
    const db = getDb();
    const features = await getLatestTraderFeatures(db, userId);
    if (!features) return res.status(404).json({ error: 'Trader not found' });

    const { tradrScore } = features;
    const guaranteeId = `TRADR-SCF-${Date.now()}-${userId.slice(0, 8)}`;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);

    await db.collection('scf_records').doc(guaranteeId).set({
      guaranteeId,
      userId,
      supplierName,
      goodsValue: Number(goodsValue),
      goodsDescription: goodsDescription || '',
      status: 'active',
      createdAt: Date.now(),
      dueDate: dueDate.getTime(),
      repaidAmount: 0,
      autoDeductRate: 0.15,
      tradrScore,
    });

    res.json({
      success: true,
      guaranteeId,
      dueDate: dueDate.toISOString(),
      message: `Guarantee created for ${supplierName}. Share guaranteeId with supplier for reference.`,
    });
  } catch (e) {
    console.error('[supply] Create guarantee error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /supply/record-repayment
router.post('/record-repayment', async (req, res) => {
  const { guaranteeId, amount } = req.body;
  if (!guaranteeId || !amount) {
    return res.status(400).json({ error: 'guaranteeId and amount are required' });
  }

  try {
    const db = getDb();
    const ref = db.collection('scf_records').doc(guaranteeId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Guarantee not found' });

    const record = snap.data();
    const newRepaid = (record.repaidAmount || 0) + Number(amount);
    const fullyRepaid = newRepaid >= record.goodsValue;

    await ref.update({
      repaidAmount: newRepaid,
      status: fullyRepaid ? 'repaid' : 'active',
      lastRepaymentAt: Date.now(),
      ...(fullyRepaid ? { repaidAt: Date.now() } : {}),
    });

    if (fullyRepaid) {
      const today = new Date().toISOString().split('T')[0];
      await db.collection('ml_features').doc(record.userId)
        .collection('daily').doc(today)
        .set({ scfOutcome: 'repaid' }, { merge: true });
      console.log(`[supply] SCF ${guaranteeId} fully repaid`);
    }

    res.json({
      success: true,
      guaranteeId,
      repaidAmount: newRepaid,
      remaining: Math.max(0, record.goodsValue - newRepaid),
      status: fullyRepaid ? 'repaid' : 'active',
    });
  } catch (e) {
    console.error('[supply] Record repayment error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /supply/trader-credit-profile/:userId
router.get('/trader-credit-profile/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const db = getDb();
    const features = await getLatestTraderFeatures(db, userId);
    if (!features) return res.status(404).json({ error: 'Trader not found' });

    const { tradrScore, monthlyRevenue } = features;
    const creditLimit = Math.round(monthlyRevenue * getCreditMultiplier(tradrScore));

    const activeSnap = await db.collection('scf_records')
      .where('userId', '==', userId)
      .where('status', '==', 'active')
      .get();

    const repaidSnap = await db.collection('scf_records')
      .where('userId', '==', userId)
      .where('status', '==', 'repaid')
      .get();

    const activeGuarantees = activeSnap.docs.map(d => d.data());
    const repaidHistory = repaidSnap.docs.map(d => d.data());

    const onTimeRepayments = repaidHistory.filter(r => (r.repaidAt || 0) <= (r.dueDate || Infinity)).length;
    const totalRepaid = repaidHistory.length;
    const reliabilityRate = totalRepaid > 0 ? onTimeRepayments / totalRepaid : null;

    const reliabilityRating =
      reliabilityRate === null ? 'no_history' :
      reliabilityRate >= 0.9 ? 'excellent' :
      reliabilityRate >= 0.75 ? 'good' :
      reliabilityRate >= 0.5 ? 'fair' : 'poor';

    res.json({
      userId,
      creditScore: tradrScore,
      creditLimit,
      monthlyRevenue,
      activeGuarantees,
      repaymentHistory: repaidHistory,
      reliabilityRating,
      totalGuaranteesRepaid: totalRepaid,
    });
  } catch (e) {
    console.error('[supply] Credit profile error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
