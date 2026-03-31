// tradr-server/routes/auth.js
// Handles OTP via Termii + Firebase custom token creation

const express = require('express');
const router = express.Router();
const axios = require('axios');
const admin = require('../firebaseAdmin');

const db = admin.firestore();

// ─── SEND OTP ────────────────────────────────────────────
// POST /auth/send-otp
// Body: { phone: "+2348012345678" }
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Clean the phone number
    const cleanPhone = phone.replace(/\s/g, '');

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP in Firestore with 5-minute expiry
    await db.collection('otps').doc(cleanPhone).set({
      code: otp,
      phone: cleanPhone,
      createdAt: Date.now(),
      expiresAt: Date.now() + (5 * 60 * 1000), // 5 minutes
      verified: false,
      attempts: 0,
    });

    // Send OTP via Termii
    const termiiResponse = await axios.post(
      'https://v3.api.termii.com/api/sms/otp/send',
      {
        api_key: process.env.TERMII_API_KEY,
        message_type: 'NUMERIC',
        to: cleanPhone,
        from: process.env.TERMII_SENDER_ID || 'TRADR',
        channel: 'dnd', // DND route — guaranteed delivery on Nigerian numbers
        pin_attempts: 3,
        pin_time_to_live: 5,
        pin_length: 6,
        pin_placeholder: '< 1234 >',
        message_text: 'Your TRADR verification code is < 1234 >. It expires in 5 minutes. Do not share this code with anyone.',
        pin_type: 'NUMERIC',
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Termii response:', termiiResponse.data);

    // Store Termii's pin_id for verification
    if (termiiResponse.data.pinId) {
      await db.collection('otps').doc(cleanPhone).update({
        pinId: termiiResponse.data.pinId,
      });
    }

    return res.json({
      success: true,
      message: 'OTP sent successfully',
      // Return pinId to app for verification
      pinId: termiiResponse.data.pinId,
    });

  } catch (e) {
    console.error('Send OTP error:', e.response?.data || e.message);
    return res.status(500).json({
      error: 'Could not send OTP',
      details: e.response?.data || e.message,
    });
  }
});

// ─── VERIFY OTP ──────────────────────────────────────────
// POST /auth/verify-otp
// Body: { phone: "+2348012345678", code: "123456", pinId: "xxx" }
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
    if (otpData.attempts >= 3) {
      await db.collection('otps').doc(cleanPhone).delete();
      return res.status(400).json({ error: 'Too many attempts. Please request a new OTP.' });
    }

    // Increment attempts
    await db.collection('otps').doc(cleanPhone).update({
      attempts: otpData.attempts + 1,
    });

    // Verify via Termii if pinId exists
    if (pinId || otpData.pinId) {
      try {
        const verifyResponse = await axios.post(
          'https://v3.api.termii.com/api/sms/otp/verify',
          {
            api_key: process.env.TERMII_API_KEY,
            pin_id: pinId || otpData.pinId,
            pin: code,
          },
          { headers: { 'Content-Type': 'application/json' } }
        );

        console.log('Termii verify response:', verifyResponse.data);

        if (verifyResponse.data.verified !== true) {
          return res.status(400).json({ error: 'Wrong code. Please try again.' });
        }
      } catch (termiiError) {
        console.error('Termii verify error:', termiiError.response?.data);
        // Fall back to local verification if Termii fails
        if (otpData.code !== code) {
          return res.status(400).json({ error: 'Wrong code. Please try again.' });
        }
      }
    } else {
      // Local verification fallback
      if (otpData.code !== code) {
        return res.status(400).json({ error: 'Wrong code. Please try again.' });
      }
    }

    // OTP is valid — clean up
    await db.collection('otps').doc(cleanPhone).delete();

    // Create or get Firebase user for this phone number
    let uid;
    try {
      // Check if user already exists
      const existingUser = await admin.auth().getUserByPhoneNumber(cleanPhone);
      uid = existingUser.uid;
    } catch (e) {
      // User doesn't exist — create them
      const newUser = await admin.auth().createUser({
        phoneNumber: cleanPhone,
      });
      uid = newUser.uid;
    }

    // Create a Firebase custom token
    const customToken = await admin.auth().createCustomToken(uid, {
      phone: cleanPhone,
    });

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

// ─── RESEND OTP ──────────────────────────────────────────
// POST /auth/resend-otp
// Body: { phone: "+2348012345678" }
router.post('/resend-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    const cleanPhone = phone.replace(/\s/g, '');

    // Delete existing OTP
    await db.collection('otps').doc(cleanPhone).delete();

    // Forward to send-otp logic
    req.body.phone = cleanPhone;
    return router.handle(
      { ...req, url: '/send-otp', method: 'POST' },
      res,
      () => {}
    );
  } catch (e) {
    return res.status(500).json({ error: 'Could not resend OTP' });
  }
});

module.exports = router;