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

// POST /mfb/push
// Sends a push notification to a trader via Expo Push API.
// Body: { traderId, title, body, data? }
router.post('/push', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required' });
  }
  if (!admin.apps.length) {
    return res.status(503).json({ error: 'Firebase not initialised' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { traderId, title, body, data = {} } = req.body;
  if (!traderId || !title || !body) {
    return res.status(400).json({ error: 'traderId, title, and body are required' });
  }

  const traderSnap = await admin.firestore().collection('traders').doc(traderId).get().catch(() => null);
  if (!traderSnap?.exists) {
    return res.status(404).json({ error: 'Trader not found' });
  }

  const pushToken = traderSnap.data().pushToken;
  if (!pushToken) {
    return res.json({ success: true, skipped: true, reason: 'no_push_token' });
  }

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: pushToken, title, body, data, sound: 'default' }),
    });
    const result = await response.json();
    res.json({ success: true, result });
  } catch (e) {
    console.error('[mfb] Push send failed:', e.message);
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
