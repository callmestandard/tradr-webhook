const express = require('express');
const router  = express.Router();
const admin   = require('../firebaseAdmin');

const db = admin.firestore();

// POST /loan/apply
router.post('/apply', async (req, res) => {
  try {
    const {
      userId, businessName, businessType, marketLocation,
      yearsInBusiness, phone, tradrScore, avgMonthlyRevenue,
      loanAmount, loanPurpose, totalTransactions,
    } = req.body;

    if (!userId || !businessName || !loanAmount || !phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const application = {
      userId,
      businessName,
      businessType:       businessType    || 'Not specified',
      marketLocation:     marketLocation  || 'Not specified',
      yearsInBusiness:    yearsInBusiness || 'Not specified',
      phone,
      tradrScore:         tradrScore      || 0,
      avgMonthlyRevenue:  avgMonthlyRevenue || 0,
      loanAmount,
      loanPurpose:        loanPurpose     || 'Not specified',
      totalTransactions:  totalTransactions || 0,
      status:             'pending',
      submittedAt:        Date.now(),
    };

    const ref = await db.collection('loan_applications').add(application);

    console.log(`Loan application submitted: ${ref.id} — ${businessName} — ₦${loanAmount}`);

    res.json({ success: true, applicationId: ref.id });
  } catch (e) {
    console.error('Loan application error:', e.message);
    res.status(500).json({ error: 'Could not submit application. Please try again.' });
  }
});

// GET /loan/status/:userId — check if user has a pending application
router.get('/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const snap = await db.collection('loan_applications')
      .where('userId', '==', userId)
      .orderBy('submittedAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) return res.json({ hasApplication: false });

    const doc = snap.docs[0];
    res.json({ hasApplication: true, status: doc.data().status, applicationId: doc.id });
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch status.' });
  }
});

module.exports = router;
