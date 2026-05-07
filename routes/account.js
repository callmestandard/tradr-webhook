const express = require('express');
const router = express.Router();
const admin = require('../firebaseAdmin');

// POST /account/delete
// Body: { userId }
router.post('/delete', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const db = admin.firestore();
    const batch = db.batch();

    const collections = [
      'traders', 'businesses', 'mono_accounts',
      'bureau_checks', 'loan_waitlist', 'nightly_runs',
    ];

    for (const col of collections) {
      const ref = db.collection(col).doc(userId);
      batch.delete(ref);
    }

    // Delete loan applications where userId matches
    const loanApps = await db.collection('loanApplications')
      .where('userId', '==', userId).get();
    loanApps.forEach(doc => batch.delete(doc.ref));

    await batch.commit();

    // Delete Firebase Auth user
    try {
      await admin.auth().deleteUser(userId);
    } catch (authErr) {
      // User may already be deleted or anonymous — not fatal
      console.warn('[account] Auth delete warning:', authErr.code);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[account] Delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
