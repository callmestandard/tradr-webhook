'use strict';

const crypto   = require('crypto');
const archiver = require('archiver');
const PDFDocument = require('pdfkit');
const admin = require('../firebaseAdmin');

const EXPORT_SECRET = process.env.EXPORT_SECRET || process.env.WHATSAPP_VERIFY_TOKEN || 'tradr_export_secret';
const TOKEN_TTL_MS  = 24 * 60 * 60 * 1000; // 24 hours

// ── Signed token (HMAC-SHA256) ──────────────────────────────────────────────

function createSignedToken(traderId, type = 'csv') {
  const payload = JSON.stringify({ traderId, type, exp: Date.now() + TOKEN_TTL_MS });
  const b64     = Buffer.from(payload).toString('base64url');
  const sig     = crypto.createHmac('sha256', EXPORT_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifySignedToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', EXPORT_SECRET).update(b64).digest('base64url');
  let sigOk;
  try { sigOk = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return null; }
  if (!sigOk) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(b64, 'base64url').toString()); }
  catch { return null; }

  if (Date.now() > payload.exp) return null;
  return payload;
}

// ── CSV helpers ──────────────────────────────────────────────────────────────

function toCSVRow(fields) {
  return fields.map(f => {
    const s = String(f == null ? '' : f);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

function buildTransactionCSV(docs) {
  const header = toCSVRow(['id','type','amount_ngn','description','source','verification_tier','date']);
  const rows = docs.map(d => {
    const ts = d.createdAt ? new Date(d.createdAt).toISOString() : '';
    return toCSVRow([
      d.id || d._id || '',
      d.type || '',
      d.amount || 0,
      d.description || d.narration || '',
      d.source || '',
      d.verification?.tier || '',
      ts,
    ]);
  });
  return [header, ...rows].join('\n');
}

function buildContactsCSV(docs) {
  const header = toCSVRow(['name','phone','total_owed_ngn','due_date','created_at']);
  const rows = docs.map(d => toCSVRow([
    d.name || '',
    '', // never export phone numbers in file
    d.totalOwed || 0,
    d.dueDate ? new Date(d.dueDate).toISOString() : '',
    d.createdAt ? new Date(d.createdAt).toISOString() : '',
  ]));
  return [header, ...rows].join('\n');
}

function buildRepaymentsCSV(docs) {
  const header = toCSVRow(['repayment_number','amount_ngn','due_date','status','paid_at']);
  const rows = docs.map(d => toCSVRow([
    d.repaymentNumber || '',
    d.amount || 0,
    d.dueDate ? new Date(d.dueDate).toISOString() : '',
    d.status || '',
    d.paidAt ? new Date(d.paidAt).toISOString() : '',
  ]));
  return [header, ...rows].join('\n');
}

// ── generateCSVExport ────────────────────────────────────────────────────────

async function generateCSVExport(traderId) {
  const db = admin.firestore();

  const [txSnap, contactSnap, loanSnap] = await Promise.all([
    db.collection(`traders/${traderId}/transactions`).orderBy('createdAt', 'desc').get().catch(() => ({ docs: [] })),
    db.collection('contacts').where('userId', '==', traderId).get().catch(() => ({ docs: [] })),
    db.collection('loanApplications').where('userId', '==', traderId).limit(1).get().catch(() => ({ docs: [] })),
  ]);

  // Repayments (if a loan exists)
  let repaymentDocs = [];
  if (!loanSnap.empty) {
    const appId = loanSnap.docs[0].id;
    const repSnap = await db.collection(`loan_repayments/${appId}/schedule`).get().catch(() => ({ docs: [] }));
    repaymentDocs = repSnap.docs.map(d => d.data());
  }

  const txCSV      = buildTransactionCSV(txSnap.docs.map(d => d.data()));
  const contactCSV = buildContactsCSV(contactSnap.docs.map(d => d.data()));
  const repayCSV   = buildRepaymentsCSV(repaymentDocs);

  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('data',    c => chunks.push(c));
    archive.on('end',     () => resolve(Buffer.concat(chunks)));
    archive.on('error',   reject);

    archive.append(txCSV,      { name: 'transactions.csv' });
    archive.append(contactCSV, { name: 'contacts.csv' });
    archive.append(repayCSV,   { name: 'repayments.csv' });
    archive.append(
      `Exported from TRADR on ${new Date().toISOString()}\nTrader ID: ${traderId}\n` +
      `This file contains your business data. Keep it safe.\n`,
      { name: 'README.txt' }
    );
    archive.finalize();
  });
}

// ── generatePDFStatement ─────────────────────────────────────────────────────

const BRAND = { navy: '#0A1628', blue: '#1B4FDB', green: '#16A34A', gold: '#D97706', bg: '#F4F6F9' };

function fmtNGN(n) { return '₦' + (n || 0).toLocaleString('en-NG'); }

function monthLabel(date) {
  return date.toLocaleString('en-NG', { month: 'long', year: 'numeric' });
}

async function generatePDFStatement(traderId, periodMonths = 3) {
  const db     = admin.firestore();
  const trader = await db.collection('traders').doc(traderId).get().catch(() => null);
  const name   = trader?.data()?.businessName || 'Business';

  const cutoff = Date.now() - periodMonths * 30 * 86400000;
  const txSnap = await db.collection(`traders/${traderId}/transactions`)
    .where('createdAt', '>=', cutoff)
    .orderBy('createdAt', 'asc')
    .get().catch(() => ({ docs: [] }));

  const txs = txSnap.docs.map(d => d.data());

  // Group by month
  const months = {};
  for (const tx of txs) {
    const d = new Date(tx.createdAt || Date.now());
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!months[key]) months[key] = { label: monthLabel(d), revenue: 0, expenses: 0 };
    if (tx.type === 'sale')    months[key].revenue  += tx.amount || 0;
    if (tx.type === 'expense') months[key].expenses += tx.amount || 0;
  }

  const rows = Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => ({
    ...v,
    profit: v.revenue - v.expenses,
  }));

  // Debtor summary
  const contactSnap = await db.collection('contacts')
    .where('userId', '==', traderId).get().catch(() => ({ docs: [] }));
  const debtors = contactSnap.docs.map(d => d.data()).filter(c => c.totalOwed > 0);
  const totalOwed = debtors.reduce((s, c) => s + c.totalOwed, 0);

  // Score
  const scoreVal = trader?.data()?.tradrScore || 0;
  const scoreTier = trader?.data()?.tier || 'Building';

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header bar
    doc.rect(0, 0, doc.page.width, 70).fill(BRAND.navy);
    doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold')
      .text('TRADR', 50, 22);
    doc.fontSize(10).font('Helvetica')
      .text('Business Financial Statement', 50, 44);
    doc.text(new Date().toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }),
      0, 44, { align: 'right', width: doc.page.width - 50 });

    // Business name + period
    doc.fillColor(BRAND.navy).fontSize(16).font('Helvetica-Bold')
      .text(name, 50, 90);
    doc.fillColor('#6B7280').fontSize(10).font('Helvetica')
      .text(`Last ${periodMonths} months · Generated by TRADR`, 50, 112);

    // Score badge
    const scoreColor = scoreVal >= 700 ? BRAND.green : scoreVal >= 500 ? BRAND.blue : scoreVal >= 300 ? BRAND.gold : '#9CA3AF';
    doc.roundedRect(doc.page.width - 160, 88, 110, 40, 6).fill(scoreColor);
    doc.fillColor('#FFFFFF').fontSize(20).font('Helvetica-Bold')
      .text(`${scoreVal}`, doc.page.width - 160, 95, { width: 110, align: 'center' });
    doc.fontSize(8).font('Helvetica')
      .text(`TRADR Score · ${scoreTier}`, doc.page.width - 160, 118, { width: 110, align: 'center' });

    // Monthly table
    let y = 150;
    doc.fillColor(BRAND.navy).fontSize(12).font('Helvetica-Bold').text('Monthly Summary', 50, y);
    y += 20;

    // Table header
    const cols = [50, 200, 310, 400, 490];
    doc.rect(50, y, doc.page.width - 100, 22).fill('#F3F4F6');
    doc.fillColor('#374151').fontSize(9).font('Helvetica-Bold');
    doc.text('Month',    cols[0], y + 6);
    doc.text('Revenue',  cols[1], y + 6);
    doc.text('Expenses', cols[2], y + 6);
    doc.text('Profit',   cols[3], y + 6);
    y += 22;

    for (const row of rows) {
      const profitColor = row.profit >= 0 ? BRAND.green : '#DC2626';
      doc.fillColor('#111827').fontSize(9).font('Helvetica');
      doc.text(row.label,           cols[0], y + 5, { width: 140 });
      doc.text(fmtNGN(row.revenue), cols[1], y + 5, { width: 100 });
      doc.text(fmtNGN(row.expenses),cols[2], y + 5, { width: 100 });
      doc.fillColor(profitColor)
        .text(fmtNGN(row.profit),   cols[3], y + 5, { width: 100 });
      y += 20;
      doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
    }

    // Totals row
    y += 4;
    const totRev  = rows.reduce((s, r) => s + r.revenue, 0);
    const totExp  = rows.reduce((s, r) => s + r.expenses, 0);
    const totProf = totRev - totExp;
    doc.rect(50, y, doc.page.width - 100, 22).fill('#EEF2FF');
    doc.fillColor(BRAND.navy).fontSize(9).font('Helvetica-Bold');
    doc.text('Total',           cols[0], y + 6);
    doc.text(fmtNGN(totRev),    cols[1], y + 6);
    doc.text(fmtNGN(totExp),    cols[2], y + 6);
    doc.fillColor(totProf >= 0 ? BRAND.green : '#DC2626')
      .text(fmtNGN(totProf),    cols[3], y + 6);
    y += 30;

    // Debtor summary
    doc.fillColor(BRAND.navy).fontSize(12).font('Helvetica-Bold').text('Outstanding Receivables', 50, y);
    y += 18;
    if (debtors.length === 0) {
      doc.fillColor('#6B7280').fontSize(9).font('Helvetica').text('No outstanding debts.', 50, y);
      y += 18;
    } else {
      doc.fillColor('#374151').fontSize(9).font('Helvetica')
        .text(`${debtors.length} customer${debtors.length > 1 ? 's' : ''} owe a total of ${fmtNGN(totalOwed)}.`, 50, y);
      y += 18;
    }

    // Footer
    const footerY = doc.page.height - 50;
    doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
    doc.fillColor('#9CA3AF').fontSize(8).font('Helvetica')
      .text('Generated by TRADR — tradr-landing-iota.vercel.app', 50, footerY + 8, { align: 'center', width: doc.page.width - 100 });
    doc.text('This statement is based on records entered by the trader. TRADR does not guarantee accuracy.',
      50, footerY + 20, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  });
}

module.exports = { createSignedToken, verifySignedToken, generateCSVExport, generatePDFStatement };
