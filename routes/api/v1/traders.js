'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const admin = require('../../../firebaseAdmin');
const { computeScore, revenueBand } = require('../../../services/scoring');
const { generateReasonCodes } = require('../../../services/reasonCodes');

// GET /api/v1/traders/:traderId/assessment
router.get('/:traderId/assessment', async (req, res) => {
  const { traderId } = req.params;
  const partner = req.partner;
  const db = admin.firestore();

  // Fetch trader document
  let traderDoc;
  try {
    traderDoc = await db.collection('traders').doc(traderId).get();
  } catch (e) {
    console.error('[credit-api] Trader fetch error:', e.message);
    return res.status(503).json({
      error: { code: 'service_unavailable', message: 'Could not fetch trader data' },
    });
  }

  if (!traderDoc.exists) {
    return res.status(404).json({
      error: { code: 'trader_not_found', message: 'Trader not found' },
    });
  }

  const trader = traderDoc.data();

  // Consent gate — internal dashboard partners bypass this check.
  if (!partner.internal) {
    const consent = trader.apiConsent;
    const alreadyGranted =
      consent?.granted === true &&
      Array.isArray(consent.partners) &&
      consent.partners.includes(partner.id);

    if (!alreadyGranted) {
      // Check for an active pending request to avoid spamming the trader
      const existingSnap = await db.collection('consent_requests')
        .where('trader_id', '==', traderId)
        .where('partner_id', '==', partner.id)
        .where('status', '==', 'pending')
        .limit(1)
        .get()
        .catch(() => ({ empty: true }));

      if (!existingSnap.empty) {
        const existing = existingSnap.docs[0].data();
        if (existing.expires_at > Date.now()) {
          return res.status(202).json({
            status: 'consent_pending',
            poll_url: `/api/v1/traders/${traderId}/consent-status?partner_id=${partner.id}`,
            message: 'Consent request already sent to trader. Waiting for response.',
            expires_at: new Date(existing.expires_at).toISOString(),
          });
        }
      }

      if (!trader.whatsappNumber) {
        return res.status(403).json({
          error: { code: 'consent_required', message: 'Trader has not granted access and cannot be reached via WhatsApp' },
        });
      }

      const requestId = 'cr_' + crypto.randomBytes(8).toString('hex');
      const requestedAt = Date.now();
      const expiresAt = requestedAt + 24 * 3600 * 1000;

      await db.collection('consent_requests').doc(requestId).set({
        id: requestId,
        trader_id: traderId,
        partner_id: partner.id,
        partner_name: partner.name,
        status: 'pending',
        requested_at: requestedAt,
        expires_at: expiresAt,
        responded_at: null,
      });

      const { sendWhatsAppMessage } = require('../../../utils/whatsapp');
      const consentMsg =
        `🔐 *TRADR Data Request*\n\n` +
        `*${partner.name}* wants to view your TRADR business profile to check your loan eligibility.\n\n` +
        `They will see:\n• Your TRADR Score\n• Your revenue range\n• Your recording consistency\n\n` +
        `Reply *YES TRADR* to allow or *NO TRADR* to decline.\n\n` +
        `This request expires in 24 hours. — TRADR`;

      await sendWhatsAppMessage(trader.whatsappNumber, consentMsg).catch(e => {
        console.error('[credit-api] Consent WhatsApp send failed:', e.message);
      });

      return res.status(202).json({
        status: 'consent_pending',
        poll_url: `/api/v1/traders/${traderId}/consent-status?partner_id=${partner.id}`,
        message: 'Consent request sent to trader via WhatsApp.',
        expires_at: new Date(expiresAt).toISOString(),
      });
    }
  }

  // Fetch transactions — 90-day window covers all scoring algorithm windows
  let transactions = [];
  try {
    const txSnap = await db
      .collection(`traders/${traderId}/transactions`)
      .where('createdAt', '>=', Date.now() - 90 * 86400000)
      .get();
    transactions = txSnap.docs.map(d => d.data());
  } catch (e) {
    console.error('[credit-api] Transaction fetch error:', e.message);
    return res.status(503).json({
      error: { code: 'service_unavailable', message: 'Could not fetch transaction data' },
    });
  }

  const bvnVerified = trader.bvnVerified === true;
  const scoreResult = computeScore(transactions, { bvnVerified });

  // Bureau status — read cached values only, never trigger a new bureau call
  const bureauStatus = {
    bvn_verified: bvnVerified,
    credit_check_performed: !!(trader.creditData?.checkedAt),
    overdue_loans: (trader.creditData?.overdueLoans || 0) > 0,
    ...(partner.internal && trader.creditData?.creditScore != null
      ? { bureau_score: trader.creditData.creditScore }
      : {}),
  };

  const reasonCodes = generateReasonCodes({ ...scoreResult, bureau: bureauStatus });

  const assessmentId = 'asmt_' + crypto.randomBytes(8).toString('hex');
  const generatedAt = new Date().toISOString();

  // Revenue: exact figures for internal partner, bands for external lenders
  const monthlyRevenue = partner.internal
    ? { this_month_ngn: scoreResult.thisMonthSales, last_month_ngn: scoreResult.lastMonthSales }
    : {
        this_month_band: revenueBand(scoreResult.thisMonthSales),
        last_month_band: revenueBand(scoreResult.lastMonthSales),
      };

  const payload = {
    assessment_id: assessmentId,
    trader_id: traderId,
    partner_id: partner.id,
    generated_at: generatedAt,
    score: {
      value: scoreResult.total,
      tier: scoreResult.tier,
      components: scoreResult.components,
    },
    loan_ready: scoreResult.isLoanReady,
    loan_ready_conditions: {
      score_met: scoreResult.meetsScoreThreshold,
      history_met: scoreResult.meetsTimeThreshold,
      consistency_met: scoreResult.meetsConsistencyThreshold,
      volume_met: scoreResult.meetsVolumeThreshold,
    },
    days_recording: scoreResult.totalDaysRecording,
    active_days_last_30: scoreResult.daysWithActivity,
    monthly_revenue: monthlyRevenue,
    bureau: bureauStatus,
    data_verification: {
      ratio:            scoreResult.dataQualityRatio,
      band:             scoreResult.dataQualityBand,
      breakdown_by_tier: scoreResult.dataQualityBreakdown,
    },
    reason_codes: reasonCodes,
  };

  // Immutable assessment snapshot — written once, never updated or deleted
  try {
    await db.collection('assessments').doc(assessmentId).set({
      ...payload,
      timestamp: Date.now(),
    });
  } catch (e) {
    console.error('[credit-api] Assessment write error:', e.message);
    // Non-fatal: return result even if the audit snapshot fails
  }

  // Metered usage log
  try {
    await db.collection('api_usage').add({
      partner_id: partner.id,
      endpoint: 'GET /api/v1/traders/:traderId/assessment',
      trader_id: traderId,
      assessment_id: assessmentId,
      timestamp: Date.now(),
      unit_price: 2000,
      currency: 'NGN',
      billed: false,
    });
  } catch (e) {
    console.error('[credit-api] Usage log error:', e.message);
  }

  res.json(payload);
});

// GET /api/v1/traders/:traderId/consent-status?partner_id=X
router.get('/:traderId/consent-status', async (req, res) => {
  const { traderId } = req.params;
  const { partner_id } = req.query;
  const partner = req.partner;
  const db = admin.firestore();

  if (partner_id && partner_id !== partner.id) {
    return res.status(403).json({
      error: { code: 'forbidden', message: 'Cannot query consent status for another partner' },
    });
  }

  let traderDoc;
  try {
    traderDoc = await db.collection('traders').doc(traderId).get();
  } catch (e) {
    return res.status(503).json({ error: { code: 'service_unavailable', message: 'Could not fetch trader data' } });
  }

  if (!traderDoc.exists) {
    return res.status(404).json({ error: { code: 'trader_not_found', message: 'Trader not found' } });
  }

  const consent = traderDoc.data().apiConsent;
  if (consent?.granted === true && Array.isArray(consent.partners) && consent.partners.includes(partner.id)) {
    return res.json({ status: 'granted', trader_id: traderId, partner_id: partner.id });
  }

  // Look up the most recent consent request
  let snap;
  try {
    snap = await db.collection('consent_requests')
      .where('trader_id', '==', traderId)
      .where('partner_id', '==', partner.id)
      .get();
  } catch (e) {
    return res.status(503).json({ error: { code: 'service_unavailable', message: 'Could not fetch consent request' } });
  }

  if (snap.empty) {
    return res.status(404).json({
      error: { code: 'no_request', message: 'No consent request found. Call the assessment endpoint to initiate.' },
    });
  }

  const latest = snap.docs
    .map(d => d.data())
    .sort((a, b) => b.requested_at - a.requested_at)[0];

  const status = latest.status === 'pending' && latest.expires_at < Date.now()
    ? 'expired'
    : latest.status;

  return res.json({
    status,
    trader_id: traderId,
    partner_id: partner.id,
    requested_at: new Date(latest.requested_at).toISOString(),
    expires_at: new Date(latest.expires_at).toISOString(),
    ...(latest.responded_at ? { responded_at: new Date(latest.responded_at).toISOString() } : {}),
  });
});

module.exports = router;
