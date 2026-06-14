const axios = require('axios');
const { withGrowthFooter, logGrowthTouch } = require('../services/growthFooter');

const WA_API = 'https://graph.facebook.com/v18.0';

async function sendWhatsAppMessage(to, message) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneId || !token) throw new Error('WhatsApp credentials not configured');

  const response = await axios.post(
    `${WA_API}/${phoneId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data;
}

async function sendWhatsAppTemplate(to, templateName, params) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneId || !token) throw new Error('WhatsApp credentials not configured');

  const response = await axios.post(
    `${WA_API}/${phoneId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components: params,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data;
}

async function sendDebtReminder({
  debtorPhone,
  debtorName,
  amount,
  traderName,
  daysSinceDue,
  language = 'pidgin',
}) {
  const amountStr = '₦' + Number(amount).toLocaleString('en-NG');
  let message;

  if (language === 'yoruba') {
    if (daysSinceDue <= 0) {
      message = `Ẹ káàárọ̀ ${debtorName}.\n\nE jọ̀ọ́ ranti pé o jẹ ${traderName} ní ${amountStr}.\n\nOwó yẹ kó sàn lónìí.\n\nẸ dupe. — TRADR`;
    } else if (daysSinceDue <= 3) {
      message = `Ẹ káàárọ̀ ${debtorName}.\n\nE jọ̀ọ́, o jẹ ${traderName} ní ${amountStr}.\nỌjọ́ ìsanwó ti kọjá.\n\nAbẹ̀ jẹ tò sàn bí o bá ti lè.\n\nẸ dupe. — TRADR`;
    } else {
      message = `${debtorName},\n\nO jẹ ${traderName} ní ${amountStr} tí kò tí i sàn.\nỌjọ́ ${daysSinceDue} ti kọjá.\n\nE jọ̀ọ́ kan sí ${traderName} lónìí.\n\n— TRADR`;
    }
  } else if (language === 'pidgin') {
    if (daysSinceDue <= 0) {
      message = `Hello ${debtorName}! 👋\n\nE joo, no forget say you still dey owe ${traderName} the sum of ${amountStr}.\n\nToday na the payment day o.\n\nAbeg pay when you get chance. Thank you! 🙏\n\n— TRADR (on behalf of ${traderName})`;
    } else if (daysSinceDue <= 3) {
      message = `Hello ${debtorName},\n\nYou don owe ${traderName} ${amountStr} reach ${daysSinceDue} day${daysSinceDue > 1 ? 's' : ''} now.\n\nAbeg try sort am out today if you fit.\n\n${traderName} dey count on you. 🙏\n\n— TRADR`;
    } else {
      message = `${debtorName},\n\n${traderName} send us message say you still owe ${amountStr} wey don pass ${daysSinceDue} days.\n\nAbeg contact ${traderName} today make una sort am out.\n\nThank you.\n\n— TRADR Financial`;
    }
  } else {
    if (daysSinceDue <= 0) {
      message = `Hello ${debtorName},\n\nThis is a friendly reminder that you owe ${traderName} the sum of ${amountStr}.\n\nPayment is due today. Kindly settle at your earliest convenience.\n\nThank you.\n— TRADR (on behalf of ${traderName})`;
    } else {
      message = `Hello ${debtorName},\n\nYou owe ${traderName} the sum of ${amountStr}. This payment is ${daysSinceDue} day${daysSinceDue > 1 ? 's' : ''} overdue.\n\nKindly make payment as soon as possible.\n\nThank you.\n— TRADR`;
    }
  }

  const withFooter = withGrowthFooter(message, language);
  logGrowthTouch('debt_reminder', null).catch(() => {});
  return sendWhatsAppMessage(debtorPhone, withFooter);
}

/**
 * Upload a buffer as a WhatsApp media document, then send it to a number.
 * Uses the Meta Graph API media upload + document message flow.
 */
async function sendWhatsAppDocument(to, buffer, filename, caption) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token   = process.env.WHATSAPP_TOKEN;
  if (!phoneId || !token) throw new Error('WhatsApp credentials not configured');

  // Step 1 — upload the buffer to the Media API
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: 'application/pdf' });
  form.append('messaging_product', 'whatsapp');

  const uploadRes = await axios.post(
    `${WA_API}/${phoneId}/media`,
    form,
    { headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` } }
  );
  const mediaId = uploadRes.data?.id;
  if (!mediaId) throw new Error('Media upload failed — no media_id returned');

  // Step 2 — send document message referencing the uploaded media
  const response = await axios.post(
    `${WA_API}/${phoneId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { id: mediaId, filename, caption: caption || '' },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return response.data;
}

module.exports = { sendWhatsAppMessage, sendWhatsAppTemplate, sendDebtReminder, sendWhatsAppDocument };
