require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

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
const { startLoanDecisionListener } = require('./utils/loanNotifier');

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
    body{font-family:system-ui,-apple-system,sans-serif;background:#0A1628;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#111827;border-radius:24px;padding:40px 28px;max-width:420px;width:100%;text-align:center}
    .logo{color:#1B4FDB;font-size:13px;font-weight:800;letter-spacing:3px;text-transform:uppercase;margin-bottom:28px}
    h1{color:#fff;font-size:26px;font-weight:700;margin-bottom:8px}
    .sub{color:#6B7280;font-size:14px;margin-bottom:32px}
    .steps{background:#0A1628;border-radius:16px;padding:20px;text-align:left;margin-bottom:24px}
    .step{display:flex;gap:14px;align-items:flex-start;margin-bottom:16px}
    .step:last-child{margin-bottom:0}
    .num{background:#1B4FDB;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;margin-top:2px}
    .step-text{color:#9CA3AF;font-size:14px;line-height:1.6;padding-top:2px}
    .step-text strong{color:#fff}
    .note{background:#0D1F38;border-radius:12px;padding:16px;color:#4A5A75;font-size:12px;line-height:1.8;border:1px solid #1A2A42}
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
        <div class="step-text">Take a screenshot of your transfer receipt</div>
      </div>
      <div class="step">
        <div class="num">3</div>
        <div class="step-text">Send the screenshot to <strong>${businessName}</strong> to confirm payment</div>
      </div>
    </div>
    <div class="note">
      <span class="badge">TRADR</span> helps Nigerian traders build a verified financial identity. Every digital payment to <strong style="color:#8899CC">${businessName}</strong> helps them qualify for a business loan with no collateral required.
    </div>
  </div>
</body>
</html>`);
});

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

// Nightly agent — midnight Lagos time
cron.schedule('0 0 * * *', async () => {
  console.log('[cron] Running nightly TRADR agent...');
  try {
    await runNightlyAgent();
  } catch (e) {
    console.error('[cron] Nightly agent failed:', e.message);
  }
}, { timezone: 'Africa/Lagos' });

// Morning messages — 6:30am Lagos time
cron.schedule('30 6 * * *', async () => {
  console.log('[cron] Sending morning messages...');
  try {
    await sendMorningMessages();
  } catch (e) {
    console.error('[cron] Morning messages failed:', e.message);
  }
}, { timezone: 'Africa/Lagos' });

app.listen(PORT, () => {
  console.log(`TRADR server listening on port ${PORT}`);
  startLoanDecisionListener();
});
