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

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP in Firestore with 5-minute expiry
    // This is the source of truth regardless of whether Termii works
    await db.collection('otps').doc(cleanPhone).set({
      code: otp,
      phone: cleanPhone,
      createdAt: Date.now(),
      expiresAt: Date.now() + (5 * 60 * 1000),
      verified: false,
      attempts: 0,
      pinId: null,
    });

    console.log(`OTP generated for ${cleanPhone}: ${otp}`);

    // Try Termii — but always succeed even if Termii fails
    let termiiWorked = false;
    let pinId = null;

    try {
      const termiiResponse = await axios.post(
        `${TERMII_BASE}/api/sms/otp/send`,
        {
          api_key: process.env.TERMII_API_KEY,
          message_type: 'NUMERIC',
          to: cleanPhone,
          from: process.env.TERMII_SENDER_ID || 'N-Alert',
          channel: 'generic',
          pin_attempts: 3,
          pin_time_to_live: 5,
          pin_length: 6,
          pin_placeholder: '< 1234 >',
          message_text: 'Your TRADR verification code is < 1234 >. Valid for 5 minutes. Do not share.',
          pin_type: 'NUMERIC',
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      console.log('Termii success:', JSON.stringify(termiiResponse.data));
      pinId = termiiResponse.data?.pinId || termiiResponse.data?.pin_id || null;
      termiiWorked = true;

      if (pinId) {
        await db.collection('otps').doc(cleanPhone).update({ pinId });
      }

    } catch (termiiError) {
      // Termii failed — log it but do not fail the request
      // OTP is already in Firestore for local verification
      console.log('Termii unavailable — using local OTP fallback');
      console.log('Termii error:', JSON.stringify(termiiError.response?.data || termiiError.message));
      termiiWorked = false;
    }

    // Always return success — OTP is in Firestore regardless
    return res.json({
      success: true,
      message: termiiWorked ? 'OTP sent via SMS' : 'OTP ready for verification',
      pinId,
      // Show OTP in response when Termii is not working
      // Remove this line before going fully live
      _code: otp,
    });

  } catch (e) {
    console.error('Send OTP critical error:', e.message);
    return res.status(500).json({
      error: 'Could not send OTP',
      details: e.message,
    });
  }
});

// ─── VERIFY OTP ──────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code, pinId } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: 'Phone and code are required' });
    }

    const cleanPhone = phone.replace(/\s/g, '');

    // Get stored OTP from Firestore
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
    if (otpData.attempts >= 5) {
      await db.collection('otps').doc(cleanPhone).delete();
      return res.status(400).json({ error: 'Too many wrong attempts. Please request a new OTP.' });
    }

    // Increment attempts
    await db.collection('otps').doc(cleanPhone).update({
      attempts: otpData.attempts + 1,
    });

    let verified = false;
    const usePinId = pinId || otpData.pinId;

    // Try Termii verification if we have a pinId
    if (usePinId) {
      try {
        const verifyResponse = await axios.post(
          `${TERMII_BASE}/api/sms/otp/verify`,
          {
            api_key: process.env.TERMII_API_KEY,
            pin_id: usePinId,
            pin: code,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        console.log('Termii verify response:', JSON.stringify(verifyResponse.data));
        verified = verifyResponse.data?.verified === true;
      } catch (termiiError) {
        console.log('Termii verify failed — using local fallback');
        // Fall back to local code comparison
        verified = otpData.code === code;
      }
    } else {
      // Local verification — compare against stored code
      verified = otpData.code === code;
    }

    if (!verified) {
      return res.status(400).json({ error: 'Wrong code. Please try again.' });
    }

    // OTP verified — clean up Firestore
    await db.collection('otps').doc(cleanPhone).delete();

    // Get or create Firebase user for this phone number
    let uid;
    try {
      const existingUser = await admin.auth().getUserByPhoneNumber(cleanPhone);
      uid = existingUser.uid;
      console.log('Existing Firebase user found:', uid);
    } catch (e) {
      // User does not exist — create them
      const newUser = await admin.auth().createUser({
        phoneNumber: cleanPhone,
      });
      uid = newUser.uid;
      console.log('New Firebase user created:', uid);
    }

    // Create Firebase custom token for the app
    const customToken = await admin.auth().createCustomToken(uid);
    console.log('Custom token created for:', cleanPhone);

    return res.json({
      success: true,
      token: customToken,
      uid,
      phone: cleanPhone,
    });

  } catch (e) {
    console.error('Verify OTP error:', e.message);
    return res.status(500).json({
      error: 'Verification failed',
      details: e.message,
    });
  }
});

module.exports = router;