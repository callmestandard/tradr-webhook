'use strict';

const VERIFICATION_TIERS = {
  bank_verified:     { weight: 1.0,  sources: ['mono_auto'] },
  payment_confirmed: { weight: 0.95, sources: ['customer_link'] },
  sms_parsed:        { weight: 0.9,  sources: ['sms_agent'] },
  bot_recorded:      { weight: 0.7,  sources: ['whatsapp_bot', 'telegram_bot'] },
  manual:            { weight: 0.6,  sources: ['app_manual', 'quick_sale'] },
};

function inferTier(source) {
  if (!source) return 'manual';
  for (const [tier, cfg] of Object.entries(VERIFICATION_TIERS)) {
    if (cfg.sources.includes(source)) return tier;
  }
  return 'manual';
}

/**
 * Returns the verification stamp to embed in every new transaction write.
 * Server assigns tier based on ingestion path — client-supplied tier is never trusted.
 */
function stampVerification(ingestedFrom) {
  return {
    tier:           inferTier(ingestedFrom),
    source:         ingestedFrom || 'manual',
    stamped_at:     Date.now(),
    schema_version: 1,
  };
}

module.exports = { VERIFICATION_TIERS, inferTier, stampVerification };
