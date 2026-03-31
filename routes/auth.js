// tradr-server/routes/auth.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const admin = require('../firebaseAdmin');

const db = admin.firestore();

function cleanPhoneKey(phone) {
  return String(phone).replace(/\s/g, '');
}

/** E.164 for Firebase (+234…); digits-only for Termii (234…). */
function normalizePhone(phone) {
  const raw = cleanPhoneKey(phone);
  const digits = raw.replace(/\D/g, '');
  let n = digits;
  if (n.startsWith('0')) n = '234' + n.slice(1);
  if (!n.startsWith('234')) n = '234' + n;
  return { phoneE164: `+${n}`, termiiTo: n };
}

async function sendTermiiOTP(phone, code) {
  const payload = {
    to: phone,
    sms: `Your TRADR verification code is ${code}. It expires in 5 minutes. Do not share this with anyone.`,
    type: "plain",
    channel: "generic",
    api_key: process.env.TERMII_API_KEY,
  };

  const response = await axios.post(
    "https://v3.api.termii.com/api/sms/send",
    payload,
    { headers: { "Content-Type": "application/json" } }
  );

  return response.data;
}

async function sendOtpHandler(req, res) {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    if (!process.env.TERMII_API_KEY) {
      console.error('TERMII_API_KEY is not set');
      return res.status(503).json({
        error: 'SMS is not configured',
        details: 'Set TERMII_API_KEY on the server.',
      });
    }

    const { phoneE164, termiiTo } = normalizePhone(phone);
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    console.log('Sending OTP to (Termii):', termiiTo);

    await sendTermiiOTP(termiiTo, code);

    await db.collection('otps').doc(phoneE164).set({
      phone: phoneE164,
      code,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000,
      verified: false,
      attempts: 0,
    });

    return res.json({
      success: true,
      message: 'OTP sent successfully',
      pinId: null,
    });
  } catch (e) {
    console.error('Send OTP error:', JSON.stringify(e.response?.data || e.message));
    return res.status(500).json({
      error: 'Could not send OTP',
      details: e.response?.data || e.message,
    });
  }
}

router.post('/send-otp', sendOtpHandler);

router.post('/resend-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    await db.collection('otps').doc(cleanPhoneKey(phone)).delete().catch(() => {});
    return sendOtpHandler(req, res);
  } catch (e) {
    return res.status(500).json({ error: 'Could not resend OTP' });
  }
});

// ─── VERIFY OTP ──────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Phone and code are required' });

    const { phoneE164 } = normalizePhone(phone);

    const otpDoc = await db.collection('otps').doc(phoneE164).get();
    if (!otpDoc.exists) {
      return res.status(400).json({ error: 'No OTP found. Please request a new one.' });
    }

    const otpData = otpDoc.data();

    if (Date.now() > otpData.expiresAt) {
      await db.collection('otps').doc(phoneE164).delete();
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    if (otpData.attempts >= 3) {
      await db.collection('otps').doc(phoneE164).delete();
      return res.status(400).json({ error: 'Too many wrong attempts. Please request a new OTP.' });
    }

    await db.collection('otps').doc(phoneE164).update({ attempts: otpData.attempts + 1 });

    const verified = String(otpData.code) === String(code).trim();

    if (!verified) {
      return res.status(400).json({ error: 'Wrong code. Please try again.' });
    }

    await db.collection('otps').doc(phoneE164).delete();

    let uid;
    try {
      const existingUser = await admin.auth().getUserByPhoneNumber(phoneE164);
      uid = existingUser.uid;
      console.log('Existing user found:', uid);
    } catch (e) {
      const newUser = await admin.auth().createUser({ phoneNumber: phoneE164 });
      uid = newUser.uid;
      console.log('New user created:', uid);
    }

    const customToken = await admin.auth().createCustomToken(uid);

    return res.json({
      success: true,
      token: customToken,
      uid,
      phone: phoneE164,
    });
  } catch (e) {
    console.error('Verify OTP error:', e.message);
    return res.status(500).json({ error: 'Verification failed', details: e.message });
  }
});

module.exports = router;
