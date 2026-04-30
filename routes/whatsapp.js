const express = require('express');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const admin = require('../firebaseAdmin');

const router = express.Router();

// GET /whatsapp/webhook — Meta verification challenge
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[whatsapp] Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST /whatsapp/webhook — incoming messages
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always acknowledge immediately

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const from = msg.from; // Phone number
    const text = (msg.text?.body || '').trim().toUpperCase();

    if (!from) return;

    const db = admin.apps.length ? admin.firestore() : null;
    let userId = null;

    if (db) {
      // Look up trader by WhatsApp number
      const snap = await db.collection('traders')
        .where('whatsappNumber', '==', from)
        .limit(1).get();
      if (!snap.empty) userId = snap.docs[0].id;
    }

    // Handle commands
    if (text === 'YES') {
      await sendWhatsAppMessage(from,
        'Excellent! Your loan application has been noted. Our team will contact you within 24 hours. — TRADR'
      );
      if (userId && db) {
        await db.collection('loan_waitlist').doc(userId).set({
          userId, phone: from, source: 'whatsapp', timestamp: Date.now(),
        });
      }
    } else if (text === 'SCORE') {
      if (userId && db) {
        const trader = (await db.doc(`traders/${userId}`).get()).data() || {};
        await sendWhatsAppMessage(from,
          `Your TRADR Score: ${trader.tradrScore || 0}/850 (${trader.tier || 'Building'})\n\nRecord more sales to grow your score. — TRADR`
        );
      } else {
        await sendWhatsAppMessage(from, 'Open the TRADR app to see your full score. — TRADR');
      }
    } else if (text === 'STOP') {
      if (userId && db) {
        await db.doc(`traders/${userId}`).update({ whatsappOptOut: true });
      }
      await sendWhatsAppMessage(from, 'You have been unsubscribed from TRADR messages. Reply START to resubscribe. — TRADR');
    } else if (text === 'START') {
      if (userId && db) {
        await db.doc(`traders/${userId}`).update({ whatsappOptOut: false });
      }
      await sendWhatsAppMessage(from, 'Welcome back! You will now receive TRADR updates. — TRADR');
    } else if (text === 'HELP') {
      await sendWhatsAppMessage(from,
        'TRADR Commands:\n\nSCORE — See your TRADR Score\nYES — Apply for a loan\nSTOP — Stop messages\nHELP — This menu\n\nOr just ask me anything about your business. — TRADR'
      );
    } else {
      // Forward to AI assistant
      if (userId) {
        await forwardToAssistant(from, msg.text?.body || '', userId);
      } else {
        await sendWhatsAppMessage(from,
          'Hello! Download TRADR to start building your business financial identity. — TRADR'
        );
      }
    }
  } catch (e) {
    console.error('[whatsapp] Webhook error:', e.message);
  }
});

async function forwardToAssistant(phone, message, userId) {
  try {
    const serverUrl = process.env.SERVER_URL || 'http://localhost:3000';
    const fetch = require('node-fetch');
    await fetch(`${serverUrl}/assistant/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message, userId }),
    });
  } catch (e) {
    await sendWhatsAppMessage(phone, 'I am having a little trouble right now. Please open the TRADR app. — TRADR');
  }
}

module.exports = router;
