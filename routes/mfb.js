const express = require('express');
const router = express.Router();
const admin = require('../firebaseAdmin');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { notifyLoanDecision } = require('../utils/loanNotifier');

// POST /mfb/notify
// Called by the MFB dashboard to send WhatsApp messages after loan decisions.
// Requires a valid Firebase ID token (from the logged-in MFB user).
router.post('/notify', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  if (!admin.apps.length) {
    return res.status(503).json({ error: 'Firebase not initialised on server' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' });
  }

  try {
    await sendWhatsAppMessage(to, message);
    res.json({ success: true });
  } catch (e) {
    console.error('[mfb] WhatsApp send failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /mfb/loan-decision
// Manual trigger — use if the server was sleeping when status was updated in Firestore.
// Body: { applicationId }
// Requires Bearer token from a logged-in MFB/admin user.
router.post('/loan-decision', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { applicationId } = req.body;
  if (!applicationId) return res.status(400).json({ error: 'applicationId required' });

  try {
    const result = await notifyLoanDecision(applicationId);
    res.json(result);
  } catch (e) {
    console.error('[mfb] loan-decision manual trigger failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
