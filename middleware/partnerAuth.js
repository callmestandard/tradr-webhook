'use strict';

const crypto = require('crypto');
const admin = require('../firebaseAdmin');

// Sliding-window rate limiter — in-memory, per partner.
// Resets on server restart; good enough for initial launch.
const _rateLimitWindows = new Map(); // Map<partnerId, number[]>

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function checkRateLimit(partnerId, limitPerMin) {
  const now = Date.now();
  const cutoff = now - 60_000;
  const recent = (_rateLimitWindows.get(partnerId) || []).filter(t => t > cutoff);
  if (recent.length >= limitPerMin) {
    _rateLimitWindows.set(partnerId, recent);
    return false; // over limit
  }
  recent.push(now);
  _rateLimitWindows.set(partnerId, recent);
  return true; // allowed
}

async function partnerAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: { code: 'missing_credentials', message: 'Authorization: Bearer <api-key> required' },
    });
  }

  const rawKey = authHeader.slice(7).trim();
  if (!rawKey) {
    return res.status(401).json({
      error: { code: 'missing_credentials', message: 'API key is empty' },
    });
  }

  const hashed = hashKey(rawKey);
  const db = admin.firestore();

  let snap;
  try {
    snap = await db.collection('partners').where('hashedApiKey', '==', hashed).limit(1).get();
  } catch (e) {
    console.error('[partnerAuth] Firestore error:', e.message);
    return res.status(503).json({
      error: { code: 'service_unavailable', message: 'Could not verify credentials' },
    });
  }

  if (snap.empty) {
    return res.status(401).json({
      error: { code: 'invalid_api_key', message: 'Invalid API key' },
    });
  }

  const partnerDoc = snap.docs[0];
  const partner = { id: partnerDoc.id, ...partnerDoc.data() };

  if (partner.status !== 'active') {
    return res.status(401).json({
      error: { code: 'partner_suspended', message: 'Partner account is suspended' },
    });
  }

  const rateLimit = partner.rateLimit || 60;
  if (!checkRateLimit(partner.id, rateLimit)) {
    return res.status(429).json({
      error: { code: 'rate_limit_exceeded', message: `Rate limit: ${rateLimit} requests/minute` },
    });
  }

  req.partner = partner;
  next();
}

module.exports = { partnerAuth };
