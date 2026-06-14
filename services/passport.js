'use strict';

const crypto      = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode      = require('qrcode');
const admin       = require('../firebaseAdmin');
const { computeScore, revenueBand } = require('./scoring');

const SERVER_URL    = process.env.SERVER_URL || 'https://tradr-webhook.onrender.com';
const MAX_PER_DAY   = 3;
const TTL_MS        = 30 * 24 * 60 * 60 * 1000; // 30 days

const BRAND = {
  navy:  '#0A1628',
  blue:  '#1B4FDB',
  green: '#16A34A',
  gold:  '#D97706',
  bg:    '#F4F6F9',
};

const TIER_COLORS = {
  Building:    '#9CA3AF',
  Growing:     '#D97706',
  Established: '#1B4FDB',
  Trusted:     '#16A34A',
};

function tierColor(tier) {
  return TIER_COLORS[tier] || BRAND.blue;
}

function revenueBandLabel(naira) {
  if (naira < 50000)   return '< ₦50k / month';
  if (naira < 150000)  return '₦50k – ₦150k / month';
  if (naira < 300000)  return '₦150k – ₦300k / month';
  if (naira < 500000)  return '₦300k – ₦500k / month';
  return '₦500k+ / month';
}

function dqBandLabel(band) {
  if (band === 'high')   return 'High (80%+ verified)';
  if (band === 'medium') return 'Medium (50–80% verified)';
  return 'Low (< 50% verified)';
}

// ── Rate limit check ─────────────────────────────────────────────────────────

async function checkRateLimit(db, traderId) {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const snap = await db.collection('passports')
    .where('trader_id', '==', traderId)
    .where('issued_at', '>=', dayStart.getTime())
    .get().catch(() => ({ size: 0 }));

  return snap.size >= MAX_PER_DAY;
}

// ── PDF generation ───────────────────────────────────────────────────────────

async function buildPassportPDF({ passportId, businessName, score, tier, monthsRecording,
  activeDays30, revenueBandStr, bvnVerified, dqBand, issuedAt, expiresAt }) {
  const verifyUrl = `${SERVER_URL}/verify/${passportId}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 100, margin: 1 });
  const qrBuffer  = Buffer.from(qrDataUrl.split(',')[1], 'base64');

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: [400, 580], margin: 0 });
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = 400;

    // Background
    doc.rect(0, 0, W, 580).fill(BRAND.navy);

    // Top band
    doc.rect(0, 0, W, 80).fill('#0D1F38');

    // TRADR wordmark
    doc.fillColor(BRAND.blue).fontSize(11).font('Helvetica-Bold')
      .text('TRADR', 24, 18);
    doc.fillColor('#9CA3AF').fontSize(8).font('Helvetica')
      .text('CREDIT PASSPORT', 24, 33);

    // Passport ID (top right, small)
    doc.fillColor('#4A5A75').fontSize(7).font('Helvetica')
      .text(passportId, 0, 20, { align: 'right', width: W - 24 });

    // Business name
    doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold')
      .text(businessName, 24, 90, { width: W - 48 });

    // Score circle (right side)
    const tColor = tierColor(tier);
    const cx = W - 70;
    const cy = 130;
    doc.circle(cx, cy, 46).fill(tColor);
    doc.fillColor('#FFFFFF').fontSize(26).font('Helvetica-Bold')
      .text(String(score), cx - 46, cy - 18, { width: 92, align: 'center' });
    doc.fontSize(7).font('Helvetica')
      .text('TRADR SCORE', cx - 46, cy + 12, { width: 92, align: 'center' });
    doc.fillColor('#E5E7EB').fontSize(9).font('Helvetica-Bold')
      .text(tier.toUpperCase(), cx - 46, cy + 24, { width: 92, align: 'center' });

    // Divider
    doc.moveTo(24, 175).lineTo(W - 24, 175).strokeColor('#1A2A42').lineWidth(1).stroke();

    // Data fields
    const fields = [
      { label: 'REVENUE RANGE',        value: revenueBandStr },
      { label: 'MONTHS ON RECORD',      value: `${monthsRecording} month${monthsRecording !== 1 ? 's' : ''}` },
      { label: 'ACTIVE DAYS (LAST 30)', value: `${activeDays30} days` },
      { label: 'DATA VERIFICATION',     value: dqBandLabel(dqBand) },
      { label: 'BVN STATUS',            value: bvnVerified ? '✓ Verified' : 'Not verified' },
    ];

    let fy = 188;
    for (const field of fields) {
      doc.fillColor('#4A5A75').fontSize(7).font('Helvetica')
        .text(field.label, 24, fy);
      doc.fillColor('#E5E7EB').fontSize(10).font('Helvetica-Bold')
        .text(field.value, 24, fy + 10, { width: W - 48 - 110 });
      fy += 34;
    }

    // QR code (bottom right of fields area)
    doc.image(qrBuffer, W - 110, 188, { width: 88, height: 88 });
    doc.fillColor('#4A5A75').fontSize(7).font('Helvetica')
      .text('Scan to verify', W - 110, 280, { width: 88, align: 'center' });

    // Validity strip
    const issuedStr  = new Date(issuedAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
    const expiresStr = new Date(expiresAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
    doc.rect(0, 490, W, 1).fill('#1A2A42');
    doc.fillColor('#6B7280').fontSize(8).font('Helvetica')
      .text(`Issued: ${issuedStr}`, 24, 500);
    doc.fillColor('#6B7280').fontSize(8).font('Helvetica')
      .text(`Valid until: ${expiresStr}`, 0, 500, { align: 'right', width: W - 24 });

    // Footer
    doc.rect(0, 520, W, 60).fill('#060E1A');
    doc.fillColor('#4A5A75').fontSize(8).font('Helvetica')
      .text('Issued by TRADR · tradr-landing-iota.vercel.app', 0, 535, { align: 'center', width: W });
    doc.fillColor('#1A2A42').fontSize(7)
      .text('This passport is a snapshot of recorded business data. Revenue shown as band. Exact figures not disclosed.', 24, 550, { width: W - 48, align: 'center' });

    doc.end();
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

async function generatePassport(traderId) {
  const db = admin.firestore();

  if (await checkRateLimit(db, traderId)) {
    return { rateLimited: true };
  }

  const [traderDoc, txSnap] = await Promise.all([
    db.collection('traders').doc(traderId).get(),
    db.collection(`traders/${traderId}/transactions`)
      .where('createdAt', '>=', Date.now() - 90 * 86400000)
      .get().catch(() => ({ docs: [] })),
  ]);

  const trader = traderDoc.exists ? traderDoc.data() : {};
  const txs    = txSnap.docs.map(d => d.data());

  const score  = computeScore(txs, { bvnVerified: trader.bvnVerified === true });
  const now    = Date.now();

  const firstTxSnap = await db.collection(`traders/${traderId}/transactions`)
    .orderBy('createdAt', 'asc').limit(1).get().catch(() => ({ docs: [] }));
  const firstTxAt   = firstTxSnap.docs[0]?.data()?.createdAt || now;
  const monthsRecording = Math.max(1, Math.floor((now - firstTxAt) / (30 * 86400000)));

  const passportId = 'pp_' + crypto.randomBytes(10).toString('hex');
  const issuedAt   = now;
  const expiresAt  = now + TTL_MS;

  const businessName  = trader.businessName || 'Trader';
  const revBandStr    = revenueBandLabel(Math.max(score.thisMonthSales || 0, score.lastMonthSales || 0));

  // Snapshot stored in Firestore — immutable, never updated
  const snapshot = {
    passport_id:     passportId,
    trader_id:       traderId,
    issued_at:       issuedAt,
    expires_at:      expiresAt,
    revoked:         false,
    business_name:   businessName,
    score:           score.total,
    tier:            score.tier,
    months_recording: monthsRecording,
    active_days_30:  score.daysWithActivity,
    revenue_band:    revBandStr,
    bvn_verified:    trader.bvnVerified === true,
    dq_band:         score.dataQualityBand,
    country:         'NG',
    currency:        'NGN',
    timezone:        'Africa/Lagos',
    schema_version:  1,
  };

  await db.collection('passports').doc(passportId).set(snapshot);

  const pdfBuffer = await buildPassportPDF({
    passportId,
    businessName,
    score:         score.total,
    tier:          score.tier,
    monthsRecording,
    activeDays30:  score.daysWithActivity,
    revenueBandStr: revBandStr,
    bvnVerified:   trader.bvnVerified === true,
    dqBand:        score.dataQualityBand,
    issuedAt,
    expiresAt,
  });

  return { passportId, pdfBuffer, rateLimited: false };
}

async function revokePassport(passportId) {
  const db = admin.firestore();
  await db.collection('passports').doc(passportId).update({ revoked: true });
}

async function getPassportState(passportId) {
  const db  = admin.firestore();
  const doc = await db.collection('passports').doc(passportId).get();
  if (!doc.exists) return { state: 'not_found', data: null };

  const data = doc.data();
  if (data.revoked)             return { state: 'revoked',  data };
  if (Date.now() > data.expires_at) return { state: 'expired',  data };
  return { state: 'valid', data };
}

module.exports = { generatePassport, revokePassport, getPassportState };
