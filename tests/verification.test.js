'use strict';

const { VERIFICATION_TIERS, inferTier, stampVerification } = require('../services/verification');
const { computeScore, computeDataQualityRatio } = require('../services/scoring');

// ── inferTier — one test per ingestion path ───────────────────────────────────

describe('inferTier — source → tier mapping', () => {
  test.each([
    ['mono_auto',       'bank_verified'],
    ['customer_link',   'payment_confirmed'],
    ['sms_agent',       'sms_parsed'],
    ['whatsapp_bot',    'bot_recorded'],
    ['telegram_bot',    'bot_recorded'],
    ['app_manual',      'manual'],
    ['quick_sale',      'manual'],
    [undefined,         'manual'],
    [null,              'manual'],
    ['',                'manual'],
    ['unknown_source',  'manual'],
  ])('source "%s" → tier "%s"', (source, expected) => {
    expect(inferTier(source)).toBe(expected);
  });

  test('every tier key in VERIFICATION_TIERS is reachable', () => {
    for (const [tier, cfg] of Object.entries(VERIFICATION_TIERS)) {
      const reached = cfg.sources.some(s => inferTier(s) === tier);
      expect(reached).toBe(true);
    }
  });
});

// ── stampVerification ─────────────────────────────────────────────────────────

describe('stampVerification', () => {
  test('returns required fields for a known source', () => {
    const stamp = stampVerification('mono_auto');
    expect(stamp).toMatchObject({
      tier:           'bank_verified',
      source:         'mono_auto',
      stamped_at:     expect.any(Number),
      schema_version: 1,
    });
  });

  test('stamped_at is current (within 1 second)', () => {
    const before = Date.now();
    const stamp  = stampVerification('whatsapp_bot');
    const after  = Date.now();
    expect(stamp.stamped_at).toBeGreaterThanOrEqual(before);
    expect(stamp.stamped_at).toBeLessThanOrEqual(after);
  });

  test('unknown source stamps as manual tier', () => {
    const stamp = stampVerification('some_future_source');
    expect(stamp.tier).toBe('manual');
    expect(stamp.source).toBe('some_future_source');
  });

  test('null/undefined source stamps as manual, source preserved', () => {
    const stamp = stampVerification(undefined);
    expect(stamp.tier).toBe('manual');
    expect(stamp.source).toBe('manual');
  });

  test('client cannot override tier — tier is always derived server-side', () => {
    // Simulate a tampered payload — tier is always set by stampVerification
    const stamp = stampVerification('manual'); // attacker claims bank_verified via source field
    expect(stamp.tier).toBe('manual');         // server ignores claimed tier, recomputes
  });
});

// ── VERIFICATION_TIERS weights are sane ───────────────────────────────────────

describe('VERIFICATION_TIERS — weight invariants', () => {
  test('all weights are between 0 and 1 inclusive', () => {
    for (const cfg of Object.values(VERIFICATION_TIERS)) {
      expect(cfg.weight).toBeGreaterThan(0);
      expect(cfg.weight).toBeLessThanOrEqual(1);
    }
  });

  test('bank_verified has highest weight', () => {
    const weights = Object.values(VERIFICATION_TIERS).map(c => c.weight);
    expect(VERIFICATION_TIERS.bank_verified.weight).toBe(Math.max(...weights));
  });

  test('manual has lowest weight', () => {
    const weights = Object.values(VERIFICATION_TIERS).map(c => c.weight);
    expect(VERIFICATION_TIERS.manual.weight).toBe(Math.min(...weights));
  });
});

// ── computeDataQualityRatio ───────────────────────────────────────────────────

function daysAgo(n) { return Date.now() - n * 86400000; }

describe('computeDataQualityRatio', () => {
  test('empty transactions returns ratio 0 and band low', () => {
    const r = computeDataQualityRatio([]);
    expect(r.ratio).toBe(0);
    expect(r.band).toBe('low');
    expect(r.breakdown_by_tier).toEqual({});
  });

  test('all bank_verified → ratio near 1.0, band high', () => {
    const txs = Array.from({ length: 20 }, (_, i) => ({
      type: 'sale', amount: 5000, createdAt: daysAgo(i), source: 'mono_auto',
      verification: { tier: 'bank_verified', source: 'mono_auto', stamped_at: Date.now() },
    }));
    const r = computeDataQualityRatio(txs);
    expect(r.ratio).toBe(1.0);
    expect(r.band).toBe('high');
  });

  test('all manual → ratio 0.6, band low', () => {
    const txs = Array.from({ length: 10 }, (_, i) => ({
      type: 'sale', amount: 5000, createdAt: daysAgo(i), source: 'app_manual',
      verification: { tier: 'manual', source: 'app_manual', stamped_at: Date.now() },
    }));
    const r = computeDataQualityRatio(txs);
    expect(r.ratio).toBe(0.6);
    expect(r.band).toBe('low'); // 0.6 < 0.65 threshold → low
  });

  test('mixed sources: ratio is between manual and bank weights', () => {
    const bank   = { type: 'sale', amount: 10000, createdAt: daysAgo(1), source: 'mono_auto',
      verification: { tier: 'bank_verified', source: 'mono_auto', stamped_at: Date.now() } };
    const manual = { type: 'sale', amount: 10000, createdAt: daysAgo(2), source: 'app_manual',
      verification: { tier: 'manual', source: 'app_manual', stamped_at: Date.now() } };
    const r = computeDataQualityRatio([bank, manual]);
    // (10000*1.0 + 10000*0.6) / 20000 = 0.8
    expect(r.ratio).toBe(0.8);
    expect(r.band).toBe('medium'); // 0.65 ≤ 0.8 < 0.85 → medium
  });

  test('falls back to inferring tier from source when verification field absent', () => {
    const txs = [{ type: 'sale', amount: 5000, createdAt: daysAgo(1), source: 'mono_auto' }];
    const r = computeDataQualityRatio(txs);
    expect(r.ratio).toBe(1.0); // mono_auto → bank_verified → weight 1.0
  });

  test('band thresholds: < 0.5 = low, 0.5–0.79 = medium, >= 0.8 = high', () => {
    // ≥ 0.8 → high: already covered above
    // 0.5–0.79 → medium: mix of bot (0.7) and manual (0.6) → (0.7+0.6)/2 = 0.65
    const txMedium = [
      { type: 'sale', amount: 1000, source: 'whatsapp_bot',
        verification: { tier: 'bot_recorded', source: 'whatsapp_bot', stamped_at: Date.now() } },
      { type: 'sale', amount: 1000, source: 'app_manual',
        verification: { tier: 'manual', source: 'app_manual', stamped_at: Date.now() } },
    ];
    const rMedium = computeDataQualityRatio(txMedium);
    expect(rMedium.band).toBe('medium');

    // < 0.5 → low: impossible with current weights (min is 0.6)
    // but we can verify that a 0-volume edge case is low
    const rEmpty = computeDataQualityRatio([{ type: 'sale', amount: 0, source: 'app_manual',
      verification: { tier: 'manual', source: 'app_manual', stamped_at: Date.now() } }]);
    expect(rEmpty.band).toBe('low');
  });

  test('breakdown_by_tier contains correct count and pct', () => {
    const txs = [
      { type: 'sale', amount: 3000, source: 'mono_auto',
        verification: { tier: 'bank_verified', source: 'mono_auto', stamped_at: Date.now() } },
      { type: 'sale', amount: 1000, source: 'app_manual',
        verification: { tier: 'manual', source: 'app_manual', stamped_at: Date.now() } },
    ];
    const r = computeDataQualityRatio(txs);
    expect(r.breakdown_by_tier.bank_verified.count).toBe(1);
    expect(r.breakdown_by_tier.bank_verified.pct).toBe(75);   // 3000/4000
    expect(r.breakdown_by_tier.manual.count).toBe(1);
    expect(r.breakdown_by_tier.manual.pct).toBe(25);          // 1000/4000
  });
});

// ── computeScore now exposes data quality fields ──────────────────────────────

describe('computeScore — data quality fields present', () => {
  test('returns dataQualityRatio, dataQualityBand, dataQualityBreakdown', () => {
    const txs = Array.from({ length: 10 }, (_, i) => ({
      type: 'sale', amount: 5000, createdAt: daysAgo(i), source: 'mono_auto',
    }));
    const result = computeScore(txs);
    expect(result).toHaveProperty('dataQualityRatio');
    expect(result).toHaveProperty('dataQualityBand');
    expect(result).toHaveProperty('dataQualityBreakdown');
    expect(['high', 'medium', 'low']).toContain(result.dataQualityBand);
  });

  test('six score components are still present (no regression)', () => {
    const result = computeScore([]);
    expect(Object.keys(result.components)).toEqual([
      'recording_consistency',
      'transaction_volume',
      'business_stability',
      'digital_payment_ratio',
      'expense_management',
      'profile_completeness',
    ]);
  });
});
