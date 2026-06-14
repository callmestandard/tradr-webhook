'use strict';

jest.mock('../firebaseAdmin', () => ({
  apps: [{}],
  firestore: jest.fn(),
}));

const adminMock = require('../firebaseAdmin');
const { getGrowthFooter, withGrowthFooter, logGrowthTouch } = require('../services/growthFooter');

// ── getGrowthFooter ───────────────────────────────────────────────────────────

describe('getGrowthFooter', () => {
  test('returns non-empty string for all supported locales', () => {
    for (const lang of ['en', 'pcm', 'yo']) {
      const footer = getGrowthFooter(lang);
      expect(typeof footer).toBe('string');
      expect(footer.length).toBeGreaterThan(10);
    }
  });

  test('falls back to English for unknown language code', () => {
    const en      = getGrowthFooter('en');
    const unknown = getGrowthFooter('de');
    expect(unknown).toBe(en);
    expect(getGrowthFooter(null)).toBe(en);
    expect(getGrowthFooter(undefined)).toBe(en);
  });

  test('all locales contain the landing URL', () => {
    for (const lang of ['en', 'pcm', 'yo']) {
      expect(getGrowthFooter(lang)).toContain('tradr-landing-iota.vercel.app');
    }
  });

  test('locales are distinct strings', () => {
    const footers = ['en', 'pcm', 'yo'].map(getGrowthFooter);
    const unique = new Set(footers);
    expect(unique.size).toBe(3);
  });
});

// ── withGrowthFooter ──────────────────────────────────────────────────────────

describe('withGrowthFooter', () => {
  test('appends footer to a message', () => {
    const msg    = 'Hello trader';
    const result = withGrowthFooter(msg);
    expect(result).toContain(msg);
    expect(result).toContain(getGrowthFooter('en'));
    expect(result.indexOf(msg)).toBeLessThan(result.indexOf(getGrowthFooter('en')));
  });

  test('uses specified locale', () => {
    const pcm = withGrowthFooter('Hello', 'pcm');
    expect(pcm).toContain(getGrowthFooter('pcm'));
  });

  test('empty message returns as-is without crashing', () => {
    expect(withGrowthFooter('')).toBe('');
    expect(withGrowthFooter(null)).toBeNull();
  });
});

// ── Footer MUST NOT appear on protected message surfaces ─────────────────────
// These tests verify the architectural rule that loan/consent messages stay clean.
// They test the message construction code paths — not the individual footer helper.

describe('footer absent from protected surfaces', () => {
  test('withGrowthFooter is never called with loan approval message content', () => {
    // The loan decision messages are built in utils/loanNotifier.js
    // and sent directly via sendWhatsAppMessage (not through withGrowthFooter).
    // This test verifies the loanNotifier module does not import growthFooter.
    const fs = require('fs');
    const loanNotifierSrc = fs.readFileSync(
      require('path').join(__dirname, '../utils/loanNotifier.js'),
      'utf8'
    );
    expect(loanNotifierSrc).not.toContain('growthFooter');
    expect(loanNotifierSrc).not.toContain('withGrowthFooter');
  });

  test('consent request messages in traders.js do not include growthFooter', () => {
    const fs = require('fs');
    const tradersSrc = fs.readFileSync(
      require('path').join(__dirname, '../routes/api/v1/traders.js'),
      'utf8'
    );
    expect(tradersSrc).not.toContain('growthFooter');
    expect(tradersSrc).not.toContain('withGrowthFooter');
  });

  test('mfb.js push/notify endpoints do not include growthFooter', () => {
    const fs = require('fs');
    const mfbSrc = fs.readFileSync(
      require('path').join(__dirname, '../routes/mfb.js'),
      'utf8'
    );
    expect(mfbSrc).not.toContain('growthFooter');
  });
});

// ── logGrowthTouch ────────────────────────────────────────────────────────────

describe('logGrowthTouch', () => {
  test('writes to growth_touches collection with correct shape', async () => {
    const addFn = jest.fn().mockResolvedValue({});
    adminMock.firestore.mockReturnValue({
      collection: jest.fn(col => {
        if (col === 'growth_touches') return { add: addFn };
        return {};
      }),
    });

    await logGrowthTouch('debt_reminder', 'trader_abc');

    expect(addFn).toHaveBeenCalledWith(expect.objectContaining({
      surface:        'debt_reminder',
      trader_id:      'trader_abc',
      timestamp:      expect.any(Number),
      country:        'NG',
      currency:       'NGN',
      timezone:       'Africa/Lagos',
      schema_version: 1,
    }));
  });

  test('does not throw when Firestore is unavailable', async () => {
    adminMock.firestore.mockReturnValue({
      collection: jest.fn(() => ({ add: jest.fn().mockRejectedValue(new Error('offline')) })),
    });
    await expect(logGrowthTouch('whatsapp_receipt', 'trader_xyz')).resolves.toBeUndefined();
  });

  test('accepts null traderId (anonymous surfaces)', async () => {
    const addFn = jest.fn().mockResolvedValue({});
    adminMock.firestore.mockReturnValue({
      collection: jest.fn(() => ({ add: addFn })),
    });

    await logGrowthTouch('tradrlink_page', null);
    expect(addFn).toHaveBeenCalledWith(expect.objectContaining({ trader_id: null }));
  });
});
