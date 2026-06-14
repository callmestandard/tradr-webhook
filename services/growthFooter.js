'use strict';

const admin = require('../firebaseAdmin');

const LANDING_URL = 'tradr-landing-iota.vercel.app';

// Locales — add new languages here, not inline in call sites
const LOCALES = {
  en:  `Sent via TRADR — record your sales, build your credit. ${LANDING_URL}`,
  pcm: `Na TRADR send am — record your sales, build your credit. ${LANDING_URL}`,
  yo:  `Nípa TRADR ni a rán — ṣe àkọsílẹ̀ ọjà rẹ, kọ́ ìgbẹ́kẹ̀lé rẹ. ${LANDING_URL}`,
};

/**
 * Returns a one-line growth footer for the given language code.
 * Falls back to English for unsupported codes.
 */
function getGrowthFooter(lang) {
  return LOCALES[lang] || LOCALES.en;
}

/**
 * Append a growth footer to an outbound message string.
 * Safe to call — does nothing if message is already empty.
 */
function withGrowthFooter(message, lang = 'en') {
  if (!message) return message;
  return `${message}\n\n${getGrowthFooter(lang)}`;
}

/**
 * Log a growth touch event for analytics.
 * Non-fatal — failure never blocks the outbound message.
 */
async function logGrowthTouch(surface, traderId) {
  try {
    const db = admin.apps.length ? admin.firestore() : null;
    if (!db) return;
    await db.collection('growth_touches').add({
      surface,
      trader_id:      traderId || null,
      timestamp:      Date.now(),
      country:        'NG',
      currency:       'NGN',
      timezone:       'Africa/Lagos',
      schema_version: 1,
    });
  } catch (e) {
    // silent — analytics must never block messaging
  }
}

module.exports = { getGrowthFooter, withGrowthFooter, logGrowthTouch };
