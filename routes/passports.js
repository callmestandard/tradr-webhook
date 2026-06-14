'use strict';

const express = require('express');
const router  = express.Router();
const admin   = require('../firebaseAdmin');
const { getPassportState } = require('../services/passport');

const PARTNER_INTEREST_FORM = 'https://tradr-landing-iota.vercel.app/#lenders';

// ── Public verify page — GET /verify/:passportId ─────────────────────────────
// Intentionally unauthenticated. This is the point: lenders open this on their phone.
router.get('/verify/:passportId', async (req, res) => {
  const { passportId } = req.params;

  // Basic format guard — pp_ prefix + 20 hex chars
  if (!/^pp_[0-9a-f]{20}$/.test(passportId)) {
    return res.status(400).send(verifyPage({ state: 'not_found' }));
  }

  const { state, data } = await getPassportState(passportId).catch(() => ({ state: 'not_found', data: null }));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(verifyPage({ state, data }));
});

// ── Partner interest CTA — POST /verify/partner-interest ─────────────────────
router.post('/verify/partner-interest', async (req, res) => {
  const { name, organization, email, phone } = req.body || {};
  if (!name || !organization) {
    return res.status(400).json({ error: 'name and organization are required' });
  }

  try {
    const db = admin.firestore();
    await db.collection('partner_leads').add({
      name,
      organization,
      email:          email || null,
      phone:          phone || null,
      source:         'passport_verify_page',
      created_at:     Date.now(),
      country:        'NG',
      schema_version: 1,
    });

    // Notify via WhatsApp admin if configured
    const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER;
    if (adminPhone) {
      const { sendWhatsAppMessage } = require('../utils/whatsapp');
      sendWhatsAppMessage(adminPhone,
        `🏦 *New Partner Lead*\n\n${name} from ${organization}\n${email || ''} ${phone || ''}\n\nSource: Passport verify page`
      ).catch(() => {});
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[passports] Partner lead error:', e.message);
    res.status(500).json({ error: 'Could not save your interest. Please email us directly.' });
  }
});

// ── HTML renderer ─────────────────────────────────────────────────────────────

function verifyPage({ state, data }) {
  const isValid   = state === 'valid';
  const isExpired = state === 'expired';
  const isRevoked = state === 'revoked';

  let statusEmoji, statusTitle, statusSub, statusColor;

  if (isValid) {
    statusEmoji  = '✅';
    statusTitle  = 'VERIFIED';
    statusSub    = 'This passport is valid and has not been tampered with.';
    statusColor  = '#16A34A';
  } else if (isExpired) {
    statusEmoji  = '⏰';
    statusTitle  = 'EXPIRED';
    statusSub    = 'This passport is no longer valid. The trader can generate a new one.';
    statusColor  = '#D97706';
  } else if (isRevoked) {
    statusEmoji  = '❌';
    statusTitle  = 'REVOKED';
    statusSub    = 'This passport has been revoked and is no longer valid.';
    statusColor  = '#DC2626';
  } else {
    statusEmoji  = '🔍';
    statusTitle  = 'NOT FOUND';
    statusSub    = 'This passport ID does not exist in the TRADR system.';
    statusColor  = '#6B7280';
  }

  const issuedStr  = data?.issued_at
    ? new Date(data.issued_at).toLocaleDateString('en-NG',  { day: 'numeric', month: 'long', year: 'numeric' })
    : '—';
  const expiresStr = data?.expires_at
    ? new Date(data.expires_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—';

  const dataSection = (isValid || isExpired) && data ? `
    <div class="passport-card">
      <div class="biz-name">${escHtml(data.business_name || 'Business')}</div>
      <div class="tier-badge" style="background:${tierBg(data.tier)};color:${tierFg(data.tier)}">${escHtml(data.tier || '')}</div>

      <div class="fields">
        <div class="field">
          <span class="field-label">TRADR SCORE</span>
          <span class="field-value" style="color:${tierFg(data.tier)}">${data.score || 0} / 850</span>
        </div>
        <div class="field">
          <span class="field-label">REVENUE RANGE</span>
          <span class="field-value">${escHtml(data.revenue_band || '—')}</span>
        </div>
        <div class="field">
          <span class="field-label">MONTHS ON RECORD</span>
          <span class="field-value">${data.months_recording || 0} months</span>
        </div>
        <div class="field">
          <span class="field-label">ACTIVE DAYS (LAST 30)</span>
          <span class="field-value">${data.active_days_30 || 0} days</span>
        </div>
        <div class="field">
          <span class="field-label">DATA VERIFICATION</span>
          <span class="field-value">${dqBandDisplay(data.dq_band)}</span>
        </div>
        <div class="field">
          <span class="field-label">BVN STATUS</span>
          <span class="field-value" style="color:${data.bvn_verified ? '#16A34A' : '#9CA3AF'}">${data.bvn_verified ? '✓ Verified' : 'Not verified'}</span>
        </div>
      </div>

      <div class="dates">
        <span>Issued: ${issuedStr}</span>
        <span>Valid until: ${expiresStr}</span>
      </div>
      <div class="passport-id">${escHtml(data.passport_id || '')}</div>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TRADR Passport Verification</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,-apple-system,sans-serif;background:#0A1628;min-height:100vh;padding:24px 16px 48px;color:#fff}
    .wrap{max-width:420px;margin:0 auto}
    .logo{color:#1B4FDB;font-size:12px;font-weight:800;letter-spacing:3px;text-transform:uppercase;margin-bottom:24px}
    .status-badge{text-align:center;padding:28px 20px;border-radius:16px;background:#111827;margin-bottom:20px;border:2px solid ${statusColor}}
    .status-emoji{font-size:48px;margin-bottom:12px}
    .status-title{font-size:22px;font-weight:800;color:${statusColor};letter-spacing:2px;margin-bottom:8px}
    .status-sub{color:#6B7280;font-size:13px;line-height:1.6}
    .passport-card{background:#111827;border-radius:16px;padding:20px;margin-bottom:20px}
    .biz-name{font-size:18px;font-weight:700;margin-bottom:8px}
    .tier-badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:1px;margin-bottom:16px}
    .fields{display:grid;gap:12px;margin-bottom:16px}
    .field{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:10px;border-bottom:1px solid #1A2A42}
    .field:last-child{border-bottom:none}
    .field-label{color:#6B7280;font-size:10px;letter-spacing:1px;text-transform:uppercase}
    .field-value{font-size:14px;font-weight:600;text-align:right;max-width:60%}
    .dates{display:flex;justify-content:space-between;color:#4A5A75;font-size:11px;margin-top:12px;padding-top:12px;border-top:1px solid #1A2A42}
    .passport-id{color:#1A2A42;font-size:9px;margin-top:8px;text-align:center;font-family:monospace}
    .lender-cta{background:#0D1F38;border-radius:16px;padding:20px;margin-bottom:20px;border:1px solid #1A2A42}
    .lender-title{font-size:14px;font-weight:700;margin-bottom:6px}
    .lender-sub{color:#6B7280;font-size:12px;line-height:1.6;margin-bottom:16px}
    .cta-btn{display:block;width:100%;background:#1B4FDB;color:#fff;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:700;text-decoration:none;text-align:center;cursor:pointer}
    .tradr-note{color:#374151;font-size:11px;line-height:1.7;text-align:center}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">TRADR</div>

    <div class="status-badge">
      <div class="status-emoji">${statusEmoji}</div>
      <div class="status-title">${statusTitle}</div>
      <div class="status-sub">${statusSub}</div>
    </div>

    ${dataSection}

    <div class="lender-cta">
      <div class="lender-title">🏦 For lenders and financial institutions</div>
      <div class="lender-sub">Assess traders programmatically — verify income, consistency, and credit readiness via the TRADR Credit API.</div>
      <a class="cta-btn" href="${PARTNER_INTEREST_FORM}">Become a TRADR Partner →</a>
    </div>

    <p class="tradr-note">
      TRADR builds verified financial identity for Nigerian traders.<br>
      Revenue shown as a band. Exact figures not disclosed.<br>
      This page is public — no personal data is exposed.
    </p>
  </div>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function tierBg(tier) {
  const m = { Building: '#1A1A2E', Growing: '#2A1F0A', Established: '#0D1A3A', Trusted: '#0A2A14' };
  return m[tier] || '#1A1A2E';
}

function tierFg(tier) {
  const m = { Building: '#9CA3AF', Growing: '#D97706', Established: '#1B4FDB', Trusted: '#16A34A' };
  return m[tier] || '#9CA3AF';
}

function dqBandDisplay(band) {
  if (band === 'high')   return '🟢 High';
  if (band === 'medium') return '🟡 Medium';
  return '🔴 Low';
}

module.exports = router;
