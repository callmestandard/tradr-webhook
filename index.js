require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { stampVerification } = require('./services/verification');

const monoRoutes = require('./routes/mono');
const authRoutes = require('./routes/auth');
const { router: agentRouter, runNightlyAgent, sendMorningMessages } = require('./routes/agent');
const whatsappRoutes = require('./routes/whatsapp');
const telegramRoutes = require('./routes/telegram');
const assistantRoutes = require('./routes/assistant');
const debtAgentRoutes = require('./routes/debtAgent');
const bureauRoutes = require('./routes/bureau');
const accountRoutes = require('./routes/account');
const mfbRoutes = require('./routes/mfb');
const supplyChainRoutes = require('./routes/supplyChain');
const creditApiV1 = require('./routes/api/v1');
const exportRoutes = require('./routes/export');
const passportRoutes = require('./routes/passports');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'TRADR server running', timestamp: new Date().toISOString() });
});

// Tradr Link payment landing page
app.get('/pay/:slug', (req, res) => {
  const { slug } = req.params;
  const businessName = slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pay ${businessName} — TRADR</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,-apple-system,sans-serif;background:#0A1628;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px}
    @media(min-height:760px) and (min-width:480px){body{align-items:center}}
    @media(max-width:400px){body{padding:24px 14px}}
    .card{background:#111827;border-radius:24px;padding:36px 24px;max-width:420px;width:100%;text-align:center}
    @media(max-width:400px){.card{padding:28px 18px;border-radius:18px}}
    .logo{color:#1B4FDB;font-size:13px;font-weight:800;letter-spacing:3px;text-transform:uppercase;margin-bottom:24px}
    h1{color:#fff;font-size:26px;font-weight:700;margin-bottom:8px;word-break:break-word}
    .sub{color:#6B7280;font-size:14px;margin-bottom:28px}
    .steps{background:#0A1628;border-radius:16px;padding:20px;text-align:left;margin-bottom:24px}
    .step{display:flex;gap:14px;align-items:flex-start;margin-bottom:14px}
    .step:last-child{margin-bottom:0}
    .num{background:#1B4FDB;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;margin-top:2px}
    .step-text{color:#9CA3AF;font-size:14px;line-height:1.6;padding-top:2px}
    .step-text strong{color:#fff}
    .divider{height:1px;background:#1A2A42;margin:24px 0}
    .confirm-title{color:#fff;font-size:16px;font-weight:700;margin-bottom:6px}
    .confirm-sub{color:#6B7280;font-size:13px;margin-bottom:20px}
    .input-wrap{position:relative;margin-bottom:14px;text-align:left}
    .currency{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:#9CA3AF;font-size:16px;font-weight:600}
    input{width:100%;background:#0A1628;border:1.5px solid #1A2A42;border-radius:12px;padding:14px 16px 14px 36px;color:#fff;font-size:20px;font-weight:700;outline:none;-webkit-appearance:none}
    input:focus{border-color:#1B4FDB}
    input::placeholder{color:#374151}
    .desc-input{width:100%;background:#0A1628;border:1.5px solid #1A2A42;border-radius:12px;padding:12px 16px;color:#fff;font-size:14px;outline:none;resize:none}
    .desc-input::placeholder{color:#374151}
    .desc-input:focus{border-color:#1B4FDB}
    .btn{width:100%;background:#1B4FDB;color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;margin-top:6px;transition:opacity .15s}
    .btn:hover{opacity:.9}
    .btn:disabled{background:#374151;cursor:not-allowed}
    .success{display:none;background:#052e16;border-radius:16px;padding:24px;margin-top:20px}
    .success-emoji{font-size:40px;margin-bottom:12px}
    .success-text{color:#4ade80;font-size:16px;font-weight:700;margin-bottom:6px}
    .success-sub{color:#6B7280;font-size:13px}
    .note{background:#0D1F38;border-radius:12px;padding:14px;color:#4A5A75;font-size:12px;line-height:1.8;border:1px solid #1A2A42;margin-top:20px}
    .badge{color:#1B4FDB;font-weight:700}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">TRADR</div>
    <h1>${businessName}</h1>
    <p class="sub">is ready to receive your payment</p>

    <div class="steps">
      <div class="step">
        <div class="num">1</div>
        <div class="step-text">Transfer money to <strong>${businessName}</strong>'s bank account as normal</div>
      </div>
      <div class="step">
        <div class="num">2</div>
        <div class="step-text">Come back here and tap <strong>I've paid</strong> to confirm</div>
      </div>
    </div>

    <div class="divider"></div>

    <div id="form-section">
      <p class="confirm-title">I've made the transfer</p>
      <p class="confirm-sub">Enter the amount you sent so ${businessName} can record it automatically</p>

      <div class="input-wrap">
        <span class="currency">₦</span>
        <input id="amount" type="number" placeholder="0" min="1" inputmode="numeric" />
      </div>
      <textarea id="description" class="desc-input" rows="2" placeholder="What is this payment for? (optional)"></textarea>
      <button class="btn" id="submit-btn" onclick="confirmPayment()">I've Paid →</button>
    </div>

    <div class="success" id="success-section">
      <div class="success-emoji">✅</div>
      <div class="success-text">Payment confirmed!</div>
      <div class="success-sub">${businessName} has been notified. Thank you!</div>
    </div>

    <div class="note">
      <span class="badge">TRADR</span> helps Nigerian traders build a verified financial identity. Every digital payment builds their business credit score and gets them closer to a business loan.
    </div>

    <div style="margin-top:20px;padding:14px;background:#060E1A;border-radius:12px;text-align:center">
      <p style="color:#4A5A75;font-size:12px;margin-bottom:8px">Powered by <strong style="color:#1B4FDB">TRADR</strong></p>
      <p style="color:#6B7280;font-size:11px;line-height:1.7">Record your sales every day, build your business credit score, and unlock a loan — no collateral needed.</p>
      <a href="https://tradr-landing-iota.vercel.app" style="display:inline-block;margin-top:12px;background:#1B4FDB;color:#fff;text-decoration:none;border-radius:8px;padding:8px 18px;font-size:12px;font-weight:700">Get TRADR Free →</a>
    </div>
  </div>

  <script>
    async function confirmPayment() {
      const amountEl = document.getElementById('amount');
      const descEl = document.getElementById('description');
      const btn = document.getElementById('submit-btn');
      const amount = parseFloat(amountEl.value);

      if (!amount || amount <= 0) {
        amountEl.focus();
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Sending...';

      try {
        const res = await fetch('/pay/${slug}/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount, description: descEl.value.trim() }),
        });
        if (!res.ok) throw new Error('Failed');
        document.getElementById('form-section').style.display = 'none';
        document.getElementById('success-section').style.display = 'block';
      } catch {
        btn.disabled = false;
        btn.textContent = "I've Paid →";
        alert('Something went wrong. Please try again.');
      }
    }
  </script>
</body>
</html>`);
});

// Customer payment confirmation
app.post('/pay/:slug/confirm', async (req, res) => {
  const { slug } = req.params;
  const { amount, description } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const admin = require('./firebaseAdmin');
    if (!admin.apps.length) return res.status(503).json({ error: 'Server not ready' });

    const db = admin.firestore();

    // Look up trader from slug registry
    const linkDoc = await db.collection('tradr_links').doc(slug).get();
    if (!linkDoc.exists) return res.status(404).json({ error: 'Link not found' });

    const { userId, businessName } = linkDoc.data();

    // Save as pending transaction — app auto-approves customer_link source
    await db.collection('pending_transactions').add({
      userId,
      amount: Number(amount),
      description: description || `Customer payment via TRADR Link`,
      type: 'sale',
      source: 'customer_link',
      verification: stampVerification('customer_link'),
      status: 'pending',
      slug,
      createdAt: Date.now(),
    });

    // FCM push to trader
    const tokenDoc = await db.collection('user_fcm_tokens').doc(userId).get();
    const fcmToken = tokenDoc.exists ? tokenDoc.data()?.token : null;
    if (fcmToken) {
      const fmtAmount = '₦' + Number(amount).toLocaleString('en-NG');
      admin.messaging().send({
        token: fcmToken,
        notification: {
          title: '💰 Payment confirmed',
          body: `A customer just confirmed ${fmtAmount} via your TRADR Link.`,
        },
        data: { type: 'customer_link', slug },
      }).catch(() => {});
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[tradr-link] Confirm error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Credit API v1 — partner-key-gated, separate trust domain from Firebase-auth app routes
app.use('/api/v1', creditApiV1);

// Data export — signed-token gated, no login required
app.use('/export', exportRoutes);

// Passport verification — fully public, intentionally unauthenticated
app.use('/', passportRoutes);

// Routes
app.use('/mono', monoRoutes);
app.use('/auth', authRoutes);
app.use('/agent', agentRouter);
app.use('/whatsapp', whatsappRoutes);
app.use('/telegram', telegramRoutes);
app.use('/assistant', assistantRoutes);
app.use('/debt', debtAgentRoutes);
app.use('/bureau', bureauRoutes);
app.use('/account', accountRoutes);
app.use('/mfb', mfbRoutes);
app.use('/supply', supplyChainRoutes);

// Cron endpoints — called by Vercel Cron (vercel.json) on schedule
// /cron/nightly  → 0 23 * * * UTC  (midnight Lagos, UTC+1)
// /cron/morning  → 30 5 * * * UTC  (6:30am Lagos, UTC+1)
app.get('/cron/nightly', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }
  try {
    await runNightlyAgent();
    res.json({ ok: true });
  } catch (e) {
    console.error('[cron] Nightly agent failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/cron/morning', async (req, res) => {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }
  try {
    await sendMorningMessages();
    res.json({ ok: true });
  } catch (e) {
    console.error('[cron] Morning messages failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Export for Vercel serverless; listen only when run directly (local dev)
if (require.main === module) {
  const { startLoanDecisionListener } = require('./utils/loanNotifier');
  app.listen(PORT, () => {
    console.log(`TRADR server listening on port ${PORT}`);
    startLoanDecisionListener();
  });
}

module.exports = app;
