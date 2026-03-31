// tradr-server/routes/auth.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const admin = require('../firebaseAdmin');

const db = admin.firestore();
const TERMII_BASE = 'https://v3.api.termii.com';

// ─── SEND OTP ────────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    const cleanPhone = phone.replace(/\s/g, '');

    // Generate 6-digit OTP as fallback
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP in Firestore with 5-minute expiry
    await db.collection('otps').doc(cleanPhone).set({
      code: otp,
      phone: cleanPhone,
      createdAt: Date.now(),
      expiresAt: Date.now() + (5 * 60 * 1000),
      verified: false,
      attempts: 0,
    });

    // Send via Termii — correct endpoint and payload
    const termiiPayload = {
      api_key: process.env.TERMII_API_KEY,
      message_type: 'NUMERIC',
      to: cleanPhone,
      from: process.env.TERMII_SENDER_ID || 'N-Alert',
      channel: 'dnd',
      pin_attempts: 3,
      pin_time_to_live: 5,
      pin_length: 6,
      pin_placeholder: '< 1234 >',
      message_text: 'Your TRADR verification code is < 1234 >. Valid for 5 minutes. Do not share.',
      pin_type: 'NUMERIC',
    };

    console.log('Sending OTP to:', cleanPhone);
    console.log('Using sender:', termiiPayload.from);

    const termiiResponse = await axios.post(
      `${TERMII_BASE}/api/sms/otp/send`,
      termiiPayload,
      { headers: { 'Content-Type': 'application/json' } }
    );

    console.log('Termii response:', JSON.stringify(termiiResponse.data));

    // Store pinId if Termii returns one
    const pinId = termiiResponse.data?.pinId || termiiResponse.data?.pin_id || null;
    if (pinId) {
      await db.collection('otps').doc(cleanPhone).update({ pinId });
    }

    return res.json({
      success: true,
      message: 'OTP sent successfully',
      pinId,
    });

  } catch (e) {
    console.error('Send OTP error:', JSON.stringify(e.response?.data || e.message));
    return res.status(500).json({
      error: 'Could not send OTP',
      details: e.response?.data || e.message,
    });
  }
});

// ─── VERIFY OTP ──────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code, pinId } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Phone and code are required' });

    const cleanPhone = phone.replace(/\s/g, '');

    // Get stored OTP
    const otpDoc = await db.collection('otps').doc(cleanPhone).get();
    if (!otpDoc.exists) {
      return res.status(400).json({ error: 'No OTP found. Please request a new one.' });
    }

    const otpData = otpDoc.data();

    // Check expiry
    if (Date.now() > otpData.expiresAt) {
      await db.collection('otps').doc(cleanPhone).delete();
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    // Check attempts
    if (otpData.attempts >= 3) {
      await db.collection('otps').doc(cleanPhone).delete();
      return res.status(400).json({ error: 'Too many wrong attempts. Please request a new OTP.' });
    }

    // Increment attempts
    await db.collection('otps').doc(cleanPhone).update({ attempts: otpData.attempts + 1 });

    // Try Termii verification first
    const usePinId = pinId || otpData.pinId;
    let verified = false;

    if (usePinId) {
      try {
        const verifyResponse = await axios.post(
          `${TERMII_BASE}/api/sms/otp/verify`,
          {
            api_key: process.env.TERMII_API_KEY,
            pin_id: usePinId,
            pin: code,
          },
          { headers: { 'Content-Type': 'application/json' } }
        );
        console.log('Termii verify:', JSON.stringify(verifyResponse.data));
        verified = verifyResponse.data?.verified === true;
      } catch (termiiError) {
        console.error('Termii verify error:', termiiError.response?.data);
        // Fall back to local code check
        verified = otpData.code === code;
      }
    } else {
      // Local verification only
      verified = otpData.code === code;
    }

    if (!verified) {
      return res.status(400).json({ error: 'Wrong code. Please try again.' });
    }

    // Clean up used OTP
    await db.collection('otps').doc(cleanPhone).delete();

    // Get or create Firebase user
    let uid;
    try {
      const existingUser = await admin.auth().getUserByPhoneNumber(cleanPhone);
      uid = existingUser.uid;
      console.log('Existing user found:', uid);
    } catch (e) {
      const newUser = await admin.auth().createUser({ phoneNumber: cleanPhone });
      uid = newUser.uid;
      console.log('New user created:', uid);
    }

    // Create Firebase custom token
    const customToken = await admin.auth().createCustomToken(uid);

    return res.json({
      success: true,
      token: customToken,
      uid,
      phone: cleanPhone,
    });

  } catch (e) {
    console.error('Verify OTP error:', e.message);
    return res.status(500).json({ error: 'Verification failed', details: e.message });
  }
});

// ─── RESEND OTP ──────────────────────────────────────────
router.post('/resend-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });

    // Delete existing OTP
    await db.collection('otps').doc(phone.replace(/\s/g, '')).delete();

    // Reuse send-otp logic by making internal call
    const sendReq = { body: { phone } };
    const sendRes = {
      json: (data) => res.json(data),
      status: (code) => ({ json: (data) => res.status(code).json(data) }),
    };

    // Manually call send-otp handler
    req.body = { phone };
    return router.handle(req, res, () => {});
  } catch (e) {
    return res.status(500).json({ error: 'Could not resend OTP' });
  }
});

module.exports = router;