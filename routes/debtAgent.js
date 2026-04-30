const express = require('express');
const { sendDebtReminder } = require('../utils/whatsapp');

const router = express.Router();

// POST /debt/send-reminder — sends WhatsApp to debtor in trader's chosen language
router.post('/send-reminder', async (req, res) => {
  const { debtorPhone, debtorName, amount, traderName, daysSinceDue = 0, language = 'pidgin' } = req.body;

  if (!debtorPhone || !debtorName || !amount || !traderName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await sendDebtReminder({ debtorPhone, debtorName, amount, traderName, daysSinceDue, language });
    res.json({ success: true, message: 'Reminder sent' });
  } catch (e) {
    console.error('[debtAgent] WhatsApp send failed:', e.message);
    res.status(500).json({ error: 'Could not send reminder', detail: e.message });
  }
});

module.exports = router;
