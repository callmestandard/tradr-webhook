'use strict';

const express = require('express');
const router  = express.Router();
const admin   = require('../firebaseAdmin');
const { verifySignedToken, generateCSVExport } = require('../services/exporter');

// GET /export/:token
// Validates a 24h HMAC-signed token and streams the trader's zip to the browser.
// No auth required — the signed token is the auth.
router.get('/:token', async (req, res) => {
  const payload = verifySignedToken(req.params.token);
  if (!payload) {
    return res.status(410).send('This download link has expired or is invalid. Request a new one by sending EXPORT to the TRADR bot.');
  }

  const { traderId, type } = payload;

  // Audit log — non-fatal
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  try {
    const db = admin.firestore();
    await db.collection('exports_audit').add({
      trader_id:      traderId,
      type,
      requested_via:  'download_link',
      downloaded_at:  Date.now(),
      ip:             ip.replace(/\d+$/, 'xxx'), // partial IP only — no full PII
      country:        'NG',
      currency:       'NGN',
      timezone:       'Africa/Lagos',
      schema_version: 1,
    });
  } catch (e) {
    console.warn('[export] Audit log failed (non-fatal):', e.message);
  }

  try {
    const zipBuffer = await generateCSVExport(traderId);
    const filename  = `tradr-export-${Date.now()}.zip`; // no traderId in filename
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (e) {
    console.error('[export] ZIP generation failed:', e.message);
    res.status(500).send('Export failed. Please try again or contact support.');
  }
});

module.exports = router;
