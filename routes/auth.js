const express = require('express');
const router = express.Router();
const axios = require('axios');
const admin = require('../firebaseAdmin');

const db = admin.firestore();
const OTP_EXPIRY_MS = 10 * 60 * 1000;

async function sendSms(to, message) {
  const apiKey   = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME;
  const senderId = process.env.AT_SENDER_ID || '';

  if (!apiKey || !username) throw new Error('Africa\'s Talking credentials not configured');

  const params = new URLSearchParams();
  params.append('username', username);
  params.append('to', to);
  params.append('message', message);
  if (senderId) params.append('from', senderId);

  const { data } = await axios.post(
    'https://api.africastalking.com/version1/messaging',
    params.toString(),
    {
      headers: {
        apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      timeout: 10000,
    }
  );

  const recipient = data?.SMSMessageData?.Recipients?.[0];
  if (!recipient || recipient.status !== 'Success') {
    throw new Error(recipient?.status || 'SMS delivery failed');
  }
}

// ─── SEND OTP ────────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    const cleanPhone = phone.replace(/\s/g, '');
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await db.collection('otps').doc(cleanPhone).set({
      code: otp,
      phone: cleanPhone,
      createdAt: Date.now(),
      expiresAt: Date.now() + OTP_EXPIRY_MS,
      attempts: 0,
    });

    try {
      await sendSms(
        cleanPhone,
        `TRADR: Your verification code is ${otp}. Expires in 10 minutes. Do not share this code.`
      );
      console.log(`OTP sent via Africa's Talking to ${cleanPhone}`);
    } catch (smsError) {
      console.error('SMS send failed:', smsError.response?.data || smsError.message);
      return res.status(502).json({ error: 'Could not send SMS. Please try again shortly.' });
    }

    return res.json({ success: true });

  } catch (e) {
    console.error('Send OTP error:', e.message);
    return res.status(500).json({ error: 'Could not send OTP', details: e.message });
  }
});

// ─── VERIFY OTP ──────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: 'Phone and code are required' });
    }

    const cleanPhone = phone.replace(/\s/g, '');
    const otpDoc = await db.collection('otps').doc(cleanPhone).get();

    if (!otpDoc.exists) {
      return res.status(400).json({ error: 'No OTP found. Please request a new one.' });
    }

    const otpData = otpDoc.data();

    if (Date.now() > otpData.expiresAt) {
      await db.collection('otps').doc(cleanPhone).delete();
      return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    }

    if (otpData.attempts >= 5) {
      await db.collection('otps').doc(cleanPhone).delete();
      return res.status(400).json({ error: 'Too many wrong attempts. Please request a new code.' });
    }

    await db.collection('otps').doc(cleanPhone).update({ attempts: otpData.attempts + 1 });

    if (otpData.code !== code) {
      return res.status(400).json({ error: 'Wrong code. Please try again.' });
    }

    await db.collection('otps').doc(cleanPhone).delete();

    let uid;
    try {
      const existing = await admin.auth().getUserByPhoneNumber(cleanPhone);
      uid = existing.uid;
    } catch {
      const created = await admin.auth().createUser({ phoneNumber: cleanPhone });
      uid = created.uid;
    }

    const customToken = await admin.auth().createCustomToken(uid);

    return res.json({ success: true, token: customToken, uid, phone: cleanPhone });

  } catch (e) {
    console.error('Verify OTP error:', e.message);
    return res.status(500).json({ error: 'Verification failed', details: e.message });
  }
});

module.exports = router;
