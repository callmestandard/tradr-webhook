'use strict';

const express = require('express');
const router = express.Router();
const admin = require('../../../firebaseAdmin');

// GET /api/v1/assessments/:assessmentId
// Returns a stored assessment snapshot. Partners can only read their own assessments.
router.get('/:assessmentId', async (req, res) => {
  const { assessmentId } = req.params;
  const partner = req.partner;
  const db = admin.firestore();

  let doc;
  try {
    doc = await db.collection('assessments').doc(assessmentId).get();
  } catch (e) {
    console.error('[credit-api] Assessment fetch error:', e.message);
    return res.status(503).json({
      error: { code: 'service_unavailable', message: 'Could not fetch assessment' },
    });
  }

  if (!doc.exists) {
    return res.status(404).json({
      error: { code: 'assessment_not_found', message: 'Assessment not found' },
    });
  }

  const data = doc.data();

  if (data.partner_id !== partner.id) {
    return res.status(403).json({
      error: { code: 'forbidden', message: 'Access denied to this assessment' },
    });
  }

  // Track retrieval calls (zero-cost but metered for audit)
  try {
    await db.collection('api_usage').add({
      partner_id: partner.id,
      endpoint: 'GET /api/v1/assessments/:assessmentId',
      trader_id: data.trader_id,
      assessment_id: assessmentId,
      timestamp: Date.now(),
      unit_price: 0,
      currency: 'NGN',
      billed: false,
    });
  } catch (e) {
    console.error('[credit-api] Usage log error:', e.message);
  }

  res.json(data);
});

module.exports = router;
