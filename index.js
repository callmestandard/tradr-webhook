require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const monoRoutes = require('./routes/mono');
const authRoutes = require('./routes/auth');
const { router: agentRouter, runNightlyAgent, sendMorningMessages } = require('./routes/agent');
const whatsappRoutes = require('./routes/whatsapp');
const assistantRoutes = require('./routes/assistant');
const debtAgentRoutes = require('./routes/debtAgent');
const bureauRoutes = require('./routes/bureau');
const accountRoutes = require('./routes/account');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'TRADR server running', timestamp: new Date().toISOString() });
});

// Routes
app.use('/mono', monoRoutes);
app.use('/auth', authRoutes);
app.use('/agent', agentRouter);
app.use('/whatsapp', whatsappRoutes);
app.use('/assistant', assistantRoutes);
app.use('/debt', debtAgentRoutes);
app.use('/bureau', bureauRoutes);
app.use('/account', accountRoutes);

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
});
