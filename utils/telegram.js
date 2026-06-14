const fetch    = require('node-fetch');
const FormData = require('form-data');

const TG_API = 'https://api.telegram.org';

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

  await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

async function sendTelegramDocument(chatId, buffer, filename, caption = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', buffer, { filename, contentType: 'application/pdf' });
  if (caption) form.append('caption', caption);

  await fetch(`${TG_API}/bot${token}/sendDocument`, { method: 'POST', body: form });
}

module.exports = { sendTelegramMessage, sendTelegramDocument };
