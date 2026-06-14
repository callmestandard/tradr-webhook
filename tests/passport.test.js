'use strict';

// Mock Firebase Admin before any require() that loads it
jest.mock('../firebaseAdmin', () => ({
  apps: [{}],
  firestore: jest.fn(),
}));

const adminMock = require('../firebaseAdmin');

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = Date.now();
const TTL = 30 * 24 * 60 * 60 * 1000;

function makePassportDoc({ revoked = false, issuedOffset = 0, expiredOffset = 0 } = {}) {
  const issued_at  = NOW - issuedOffset;
  const expires_at = expiredOffset ? NOW - expiredOffset : NOW + TTL;
  return {
    passport_id:      'pp_abc123def456789abcde',
    trader_id:        'trader_test',
    issued_at,
    expires_at,
    revoked,
    business_name:    'Test Trader',
    score:            520,
    tier:             'Established',
    months_recording: 4,
    active_days_30:   18,
    revenue_band:     '₦50k – ₦150k / month',
    bvn_verified:     false,
    dq_band:          'medium',
    schema_version:   1,
  };
}

function buildDb({ passportDoc = null, passportExists = true, passportCount = 0, updateFn = jest.fn() } = {}) {
  const doc = passportDoc || makePassportDoc();
  return {
    collection: jest.fn(col => {
      if (col === 'passports') {
        return {
          doc: jest.fn(() => ({
            get: jest.fn().mockResolvedValue({
              exists: passportExists,
              data: () => (passportExists ? doc : null),
            }),
            set: jest.fn().mockResolvedValue({}),
            update: updateFn,
          })),
          where: jest.fn().mockReturnThis(),
          get: jest.fn().mockResolvedValue({ size: passportCount }),
        };
      }
      // traders collection + subcollections
      return {
        doc: jest.fn(() => ({
          get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({ businessName: 'Test Trader', bvnVerified: false, tier: 'Established', tradrScore: 520 }),
          }),
        })),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ docs: [] }),
      };
    }),
  };
}

// ── getPassportState ──────────────────────────────────────────────────────────

describe('getPassportState', () => {
  const { getPassportState } = require('../services/passport');

  beforeEach(() => jest.clearAllMocks());

  test('returns valid for an active, non-revoked passport', async () => {
    adminMock.firestore.mockReturnValue(buildDb());
    const { state, data } = await getPassportState('pp_abc123def456789abcde');
    expect(state).toBe('valid');
    expect(data.score).toBe(520);
  });

  test('returns revoked when revoked:true', async () => {
    adminMock.firestore.mockReturnValue(buildDb({ passportDoc: makePassportDoc({ revoked: true }) }));
    const { state } = await getPassportState('pp_abc123def456789abcde');
    expect(state).toBe('revoked');
  });

  test('returns expired when expires_at is in the past', async () => {
    adminMock.firestore.mockReturnValue(buildDb({
      passportDoc: makePassportDoc({ expiredOffset: 1000 }), // expired 1 second ago
    }));
    const { state } = await getPassportState('pp_abc123def456789abcde');
    expect(state).toBe('expired');
  });

  test('returns not_found when document does not exist', async () => {
    adminMock.firestore.mockReturnValue(buildDb({ passportExists: false }));
    const { state, data } = await getPassportState('pp_nonexistent');
    expect(state).toBe('not_found');
    expect(data).toBeNull();
  });

  test('revoked takes precedence over expiry', async () => {
    adminMock.firestore.mockReturnValue(buildDb({
      passportDoc: makePassportDoc({ revoked: true, expiredOffset: 1000 }),
    }));
    const { state } = await getPassportState('pp_abc123def456789abcde');
    expect(state).toBe('revoked');
  });
});

// ── Passport immutability — generatePassport always creates a new doc ─────────

describe('generatePassport — immutability', () => {
  test('each call writes a new document with a new passport_id', async () => {
    const setFns = [];

    // Override buildDb to capture set() calls and their passport_id arguments
    adminMock.firestore.mockImplementation(() => {
      const setFn = jest.fn().mockResolvedValue({});
      setFns.push(setFn);
      return {
        collection: jest.fn(col => {
          if (col === 'passports') {
            return {
              doc: jest.fn(() => ({ set: setFn })),
              where: jest.fn().mockReturnThis(),
              get: jest.fn().mockResolvedValue({ size: 0 }),
            };
          }
          return {
            doc: jest.fn(() => ({
              get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ businessName: 'Test' }) }),
            })),
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({ docs: [] }),
          };
        }),
      };
    });

    const { generatePassport } = require('../services/passport');
    const r1 = await generatePassport('trader_123');
    const r2 = await generatePassport('trader_123');

    expect(r1.rateLimited).toBe(false);
    expect(r2.rateLimited).toBe(false);
    expect(r1.passportId).not.toBe(r2.passportId);
    expect(r1.passportId).toMatch(/^pp_[0-9a-f]{20}$/);
    expect(r2.passportId).toMatch(/^pp_[0-9a-f]{20}$/);
    expect(r1.pdfBuffer).toBeInstanceOf(Buffer);
    expect(r1.pdfBuffer.length).toBeGreaterThan(100);
  });
});

// ── Rate limit ────────────────────────────────────────────────────────────────

describe('generatePassport — rate limit', () => {
  test('returns rateLimited:true when 3 passports already generated today', async () => {
    adminMock.firestore.mockReturnValue(buildDb({ passportCount: 3 }));
    const { generatePassport } = require('../services/passport');
    const result = await generatePassport('trader_123');
    expect(result.rateLimited).toBe(true);
    expect(result.passportId).toBeUndefined();
  });

  test('allows generation when count is below limit', async () => {
    adminMock.firestore.mockImplementation(() => {
      const setFn = jest.fn().mockResolvedValue({});
      return {
        collection: jest.fn(col => {
          if (col === 'passports') {
            return {
              doc: jest.fn(() => ({ set: setFn })),
              where: jest.fn().mockReturnThis(),
              get: jest.fn().mockResolvedValue({ size: 2 }), // 2 of 3 used
            };
          }
          return {
            doc: jest.fn(() => ({
              get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ businessName: 'Test' }) }),
            })),
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({ docs: [] }),
          };
        }),
      };
    });

    const { generatePassport } = require('../services/passport');
    const result = await generatePassport('trader_456');
    expect(result.rateLimited).toBe(false);
  });
});

// ── revokePassport ────────────────────────────────────────────────────────────

describe('revokePassport', () => {
  test('calls update with revoked:true on the correct doc', async () => {
    const updateFn = jest.fn().mockResolvedValue({});
    adminMock.firestore.mockReturnValue(buildDb({ updateFn }));

    const { revokePassport } = require('../services/passport');
    await revokePassport('pp_abc123def456789abcde');

    expect(updateFn).toHaveBeenCalledWith({ revoked: true });
  });
});

// ── Verify page — no PII ──────────────────────────────────────────────────────

describe('GET /verify/:passportId — HTML responses', () => {
  const request = require('supertest');
  const app     = require('../index');

  beforeEach(() => jest.clearAllMocks());

  test('valid passport returns 200 with VERIFIED', async () => {
    adminMock.firestore.mockReturnValue(buildDb());
    const res = await request(app).get('/verify/pp_abc123def456789abcde');
    expect(res.status).toBe(200);
    expect(res.text).toContain('VERIFIED');
  });

  test('expired passport returns 200 with EXPIRED', async () => {
    adminMock.firestore.mockReturnValue(buildDb({
      passportDoc: makePassportDoc({ expiredOffset: 1000 }),
    }));
    const res = await request(app).get('/verify/pp_abc123def456789abcde');
    expect(res.status).toBe(200);
    expect(res.text).toContain('EXPIRED');
  });

  test('revoked passport shows REVOKED state', async () => {
    adminMock.firestore.mockReturnValue(buildDb({
      passportDoc: makePassportDoc({ revoked: true }),
    }));
    const res = await request(app).get('/verify/pp_abc123def456789abcde');
    expect(res.status).toBe(200);
    expect(res.text).toContain('REVOKED');
  });

  test('unknown passport_id format returns 400', async () => {
    const res = await request(app).get('/verify/not-a-valid-id');
    expect(res.status).toBe(400);
  });

  test('page does not expose phone numbers or exact revenue', async () => {
    adminMock.firestore.mockReturnValue(buildDb());
    const res = await request(app).get('/verify/pp_abc123def456789abcde');
    // No phone number patterns
    expect(res.text).not.toMatch(/\+?234\d{10}/);
    // No exact naira amounts — only bands
    expect(res.text).not.toMatch(/₦\d{4,}/);
  });

  test('page contains lender CTA', async () => {
    adminMock.firestore.mockReturnValue(buildDb());
    const res = await request(app).get('/verify/pp_abc123def456789abcde');
    expect(res.text).toContain('TRADR Credit API');
  });
});
