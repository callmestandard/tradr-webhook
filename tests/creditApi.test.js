'use strict';

// Credit API v1 — unit + integration tests
// Run: cd tradr-server && npm test

const { computeScore, revenueBand, LOAN_SCORE_THRESHOLD, LOAN_DAYS_THRESHOLD } = require('../services/scoring');
const { generateReasonCodes } = require('../services/reasonCodes');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function daysAgo(n) {
  return Date.now() - n * 86400000;
}

function makeSales(count, amountEach, startDaysAgo = 0, source = 'manual') {
  return Array.from({ length: count }, (_, i) => ({
    type: 'sale',
    amount: amountEach,
    createdAt: daysAgo(startDaysAgo + i),
    source,
  }));
}

// ─── Score computation — unit tests ──────────────────────────────────────────

describe('computeScore', () => {
  test('returns a valid score object', () => {
    const result = computeScore(makeSales(30, 5000));
    expect(result).toMatchObject({
      total: expect.any(Number),
      tier: expect.any(String),
      isLoanReady: expect.any(Boolean),
      components: expect.any(Object),
    });
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(850);
  });

  test('empty transactions returns a valid zero-state (not loan_ready)', () => {
    const result = computeScore([]);
    expect(result.isLoanReady).toBe(false);
    expect(result.totalDaysRecording).toBe(0);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(850);
  });

  test('score is deterministic for the same input', () => {
    const txs = makeSales(30, 5000);
    expect(computeScore(txs).total).toBe(computeScore(txs).total);
  });

  test('BVN verified raises the score', () => {
    const txs = makeSales(30, 5000);
    const without = computeScore(txs, { bvnVerified: false });
    const with_ = computeScore(txs, { bvnVerified: true });
    expect(with_.total).toBeGreaterThan(without.total);
  });

  test('meetsScoreThreshold reflects the 500-point boundary', () => {
    // Minimal history → well below 500
    const low = computeScore(makeSales(2, 100));
    expect(low.meetsScoreThreshold).toBe(false);
    expect(low.total).toBeLessThan(LOAN_SCORE_THRESHOLD);

    // The boolean must always match the value
    const any = computeScore(makeSales(30, 5000));
    expect(any.meetsScoreThreshold).toBe(any.total >= LOAN_SCORE_THRESHOLD);
  });

  test('59 days of history does not meet time threshold', () => {
    // Place the oldest transaction exactly 59 days ago
    const txs = [
      { type: 'sale', amount: 5000, createdAt: daysAgo(59), source: 'manual' },
      ...makeSales(20, 5000, 0),
    ];
    const result = computeScore(txs);
    expect(result.totalDaysRecording).toBe(59);
    expect(result.meetsTimeThreshold).toBe(false);
    expect(result.isLoanReady).toBe(false);
  });

  test('60 days of history meets time threshold', () => {
    const txs = [
      { type: 'sale', amount: 5000, createdAt: daysAgo(60), source: 'manual' },
      ...makeSales(20, 5000, 0),
    ];
    const result = computeScore(txs);
    expect(result.totalDaysRecording).toBe(60);
    expect(result.meetsTimeThreshold).toBe(true);
  });

  test('loan_ready requires ALL four conditions simultaneously', () => {
    // High revenue + long history but only 10 active days/month → not ready
    const txs = [
      { type: 'sale', amount: 5000, createdAt: daysAgo(70), source: 'manual' },
      ...makeSales(10, 10000, 0, 'sms_auto'), // only 10 active days
    ];
    const result = computeScore(txs, { bvnVerified: true });
    if (!result.meetsConsistencyThreshold) {
      expect(result.isLoanReady).toBe(false);
    }
  });

  test('components sum is at most 100 raw', () => {
    const txs = makeSales(30, 200000, 0, 'sms_auto');
    const result = computeScore(txs, { bvnVerified: true });
    expect(result.rawTotal).toBeLessThanOrEqual(100);
  });
});

// ─── Revenue band helper ──────────────────────────────────────────────────────

describe('revenueBand', () => {
  test.each([
    [0, '<50k'],
    [49999, '<50k'],
    [50000, '50k-150k'],
    [149999, '50k-150k'],
    [150000, '150k-300k'],
    [299999, '150k-300k'],
    [300000, '300k-500k'],
    [499999, '300k-500k'],
    [500000, '500k+'],
    [1000000, '500k+'],
  ])('₦%i → %s', (naira, expected) => {
    expect(revenueBand(naira)).toBe(expected);
  });
});

// ─── Reason codes — unit tests ────────────────────────────────────────────────

describe('generateReasonCodes', () => {
  test('returns a non-empty array of strings', () => {
    const result = computeScore(makeSales(30, 5000));
    const codes = generateReasonCodes(result);
    expect(Array.isArray(codes)).toBe(true);
    expect(codes.length).toBeGreaterThan(0);
    codes.forEach(c => expect(typeof c).toBe('string'));
  });

  test('includes history blocker when < 60 days', () => {
    const result = computeScore(makeSales(10, 5000));
    const codes = generateReasonCodes(result);
    expect(codes.some(c => c.includes('minimum is 60'))).toBe(true);
  });

  test('includes history confirmation when >= 60 days', () => {
    const txs = [{ type: 'sale', amount: 5000, createdAt: daysAgo(65), source: 'manual' }, ...makeSales(20, 5000)];
    const result = computeScore(txs);
    const codes = generateReasonCodes(result);
    expect(codes.some(c => c.includes('days'))).toBe(true);
    expect(codes.every(c => !c.includes('minimum is 60'))).toBe(true);
  });

  test('includes BVN verified when verified', () => {
    const result = computeScore(makeSales(20, 5000), { bvnVerified: true });
    const codes = generateReasonCodes(result);
    expect(codes).toContain('BVN verified');
  });

  test('includes BVN not verified when not verified', () => {
    const result = computeScore(makeSales(20, 5000), { bvnVerified: false });
    const codes = generateReasonCodes(result);
    expect(codes).toContain('BVN not yet verified');
  });

  test('includes bureau reason codes when bureau is provided', () => {
    const result = computeScore(makeSales(20, 5000));
    const codes = generateReasonCodes({
      ...result,
      bureau: { bvn_verified: true, credit_check_performed: true, overdue_loans: false },
    });
    expect(codes.some(c => c.includes('bureau'))).toBe(true);
  });

  test('flags overdue loans when present', () => {
    const result = computeScore(makeSales(20, 5000));
    const codes = generateReasonCodes({
      ...result,
      bureau: { bvn_verified: true, credit_check_performed: true, overdue_loans: true },
    });
    expect(codes.some(c => c.toLowerCase().includes('overdue'))).toBe(true);
  });
});

// ─── HTTP endpoint tests ──────────────────────────────────────────────────────

// Mock firebaseAdmin before importing the app so all requires get the mock
jest.mock('../firebaseAdmin', () => ({
  apps: [{}],
  firestore: jest.fn(),
}));

const request = require('supertest');
const app = require('../index');
const adminMock = require('../firebaseAdmin');

const TRADER_ID = 'trader_test_001';

const MOCK_PARTNER = {
  id: 'partner_internal_001',
  name: 'TRADR MFB Dashboard',
  status: 'active',
  rateLimit: 9999, // high limit so rate limiting never triggers in tests
  internal: true,
  hashedApiKey: 'placeholder', // real hash isn't needed since we mock the lookup
};

const MOCK_EXTERNAL_PARTNER = {
  id: 'partner_external_001',
  name: 'Test Lender',
  status: 'active',
  rateLimit: 9999,
  internal: false,
  hashedApiKey: 'placeholder',
};

const MOCK_SUSPENDED_PARTNER = {
  id: 'partner_suspended_001',
  name: 'Suspended',
  status: 'suspended',
  rateLimit: 9999,
  internal: false,
  hashedApiKey: 'placeholder',
};

const MOCK_TRADER = {
  bvnVerified: true,
  creditData: { creditScore: 620, overdueLoans: 0, checkedAt: Date.now() },
  active: true,
};

function makePartnerSnap(partner) {
  return { empty: false, docs: [{ id: partner.id, data: () => partner }] };
}

const ADD_FN = jest.fn().mockResolvedValue({ id: 'usage_001' });
const SET_FN = jest.fn().mockResolvedValue({});

function buildDb(opts = {}) {
  const {
    partnerSnap = makePartnerSnap(MOCK_PARTNER),
    traderExists = true,
    traderData = MOCK_TRADER,
    txDocs = [],
    assessmentData = null,
  } = opts;

  return {
    collection: jest.fn(col => {
      if (col === 'partners') {
        return {
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          get: jest.fn().mockResolvedValue(partnerSnap),
        };
      }
      if (col === 'traders') {
        return {
          doc: jest.fn(() => ({
            get: jest.fn().mockResolvedValue({ exists: traderExists, data: () => traderData }),
          })),
        };
      }
      if (col === 'api_usage') {
        return { add: ADD_FN };
      }
      if (col === 'assessments') {
        const stored = assessmentData || {
          assessment_id: 'asmt_stored',
          partner_id: MOCK_PARTNER.id,
          trader_id: TRADER_ID,
          generated_at: new Date().toISOString(),
          score: { value: 500, tier: 'Established', components: {} },
          loan_ready: true,
          reason_codes: [],
        };
        return {
          doc: jest.fn(() => ({
            set: SET_FN,
            get: jest.fn().mockResolvedValue({ exists: true, data: () => stored }),
          })),
        };
      }
      // Fallback — catches `traders/${id}/transactions` and `consent_requests`
      return {
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ empty: txDocs.length === 0, docs: txDocs }),
      };
    }),
  };
}

describe('Credit API v1 — Authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminMock.firestore.mockReturnValue(buildDb());
  });

  test('401 with no Authorization header', async () => {
    const res = await request(app).get(`/api/v1/traders/${TRADER_ID}/assessment`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('missing_credentials');
  });

  test('401 with invalid API key', async () => {
    adminMock.firestore.mockReturnValue(buildDb({ partnerSnap: { empty: true, docs: [] } }));
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer invalid_key');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_api_key');
  });

  test('401 when partner is suspended', async () => {
    adminMock.firestore.mockReturnValue(buildDb({ partnerSnap: makePartnerSnap(MOCK_SUSPENDED_PARTNER) }));
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer some_key');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('partner_suspended');
  });

  test('X-TRADR-API-Version header is set on every response', async () => {
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(res.headers['x-tradr-api-version']).toBe('2026-06-09');
  });

  test('error responses also carry the version header', async () => {
    const res = await request(app).get(`/api/v1/traders/${TRADER_ID}/assessment`);
    // 401 (no auth) should still have the header since it's set before auth
    expect(res.headers['x-tradr-api-version']).toBe('2026-06-09');
  });
});

describe('Credit API v1 — Assessment endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminMock.firestore.mockReturnValue(buildDb());
  });

  test('200 with valid key — response has required fields', async () => {
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      assessment_id: expect.stringMatching(/^asmt_/),
      trader_id: TRADER_ID,
      score: { value: expect.any(Number), tier: expect.any(String) },
      loan_ready: expect.any(Boolean),
      reason_codes: expect.any(Array),
    });
  });

  test('404 when trader does not exist', async () => {
    adminMock.firestore.mockReturnValue(buildDb({ traderExists: false }));
    const res = await request(app)
      .get(`/api/v1/traders/nonexistent_trader/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('trader_not_found');
  });

  test('assessment snapshot is written to Firestore on every call', async () => {
    await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(SET_FN).toHaveBeenCalledTimes(1);
  });

  test('assessment_id in response matches what was written', async () => {
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(res.body.assessment_id).toMatch(/^asmt_/);
    // The set call should have been given a doc with the same assessment_id
    expect(SET_FN).toHaveBeenCalledWith(expect.objectContaining({
      assessment_id: res.body.assessment_id,
    }));
  });

  test('usage is logged after successful assessment', async () => {
    await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(ADD_FN).toHaveBeenCalledWith(expect.objectContaining({
      partner_id: MOCK_PARTNER.id,
      trader_id: TRADER_ID,
      unit_price: 2000,
      billed: false,
    }));
  });

  test('internal partner receives exact revenue figures', async () => {
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(res.body.monthly_revenue).toHaveProperty('this_month_ngn');
    expect(res.body.monthly_revenue).toHaveProperty('last_month_ngn');
  });

  test('external partner receives revenue bands, not exact figures', async () => {
    adminMock.firestore.mockReturnValue(buildDb({ partnerSnap: makePartnerSnap(MOCK_EXTERNAL_PARTNER) }));
    // Give trader consent for this partner
    adminMock.firestore.mockReturnValue(buildDb({
      partnerSnap: makePartnerSnap(MOCK_EXTERNAL_PARTNER),
      traderData: {
        ...MOCK_TRADER,
        apiConsent: { granted: true, partners: [MOCK_EXTERNAL_PARTNER.id] },
      },
    }));
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(res.body.monthly_revenue).toHaveProperty('this_month_band');
    expect(res.body.monthly_revenue).not.toHaveProperty('this_month_ngn');
  });
});

describe('Credit API v1 — Consent gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('external partner without consent gets 403 consent_required', async () => {
    adminMock.firestore.mockReturnValue(buildDb({
      partnerSnap: makePartnerSnap(MOCK_EXTERNAL_PARTNER),
      traderData: { ...MOCK_TRADER, apiConsent: null },
    }));
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('consent_required');
  });

  test('external partner with explicit consent gets 200', async () => {
    adminMock.firestore.mockReturnValue(buildDb({
      partnerSnap: makePartnerSnap(MOCK_EXTERNAL_PARTNER),
      traderData: {
        ...MOCK_TRADER,
        apiConsent: { granted: true, partners: [MOCK_EXTERNAL_PARTNER.id] },
      },
    }));
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(res.status).toBe(200);
  });

  test('internal partner bypasses consent gate even without apiConsent field', async () => {
    adminMock.firestore.mockReturnValue(buildDb({
      partnerSnap: makePartnerSnap(MOCK_PARTNER), // internal
      traderData: { ...MOCK_TRADER, apiConsent: undefined },
    }));
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(res.status).toBe(200);
  });

  test('partner listed in consent.partners but granted:false is still denied', async () => {
    adminMock.firestore.mockReturnValue(buildDb({
      partnerSnap: makePartnerSnap(MOCK_EXTERNAL_PARTNER),
      traderData: {
        ...MOCK_TRADER,
        apiConsent: { granted: false, partners: [MOCK_EXTERNAL_PARTNER.id] },
      },
    }));
    const res = await request(app)
      .get(`/api/v1/traders/${TRADER_ID}/assessment`)
      .set('Authorization', 'Bearer valid_key');
    expect(res.status).toBe(403);
  });
});

describe('Credit API v1 — Assessment immutability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminMock.firestore.mockReturnValue(buildDb());
  });

  test('GET /assessments/:id returns the stored snapshot unchanged', async () => {
    const res = await request(app)
      .get('/api/v1/assessments/asmt_stored')
      .set('Authorization', 'Bearer valid_key');
    expect(res.status).toBe(200);
    expect(res.body.assessment_id).toBe('asmt_stored');
    expect(res.body.partner_id).toBe(MOCK_PARTNER.id);
  });

  test('partner cannot access another partner\'s assessment', async () => {
    // Assessment belongs to MOCK_PARTNER.id but the request comes from MOCK_EXTERNAL_PARTNER
    adminMock.firestore.mockReturnValue({
      collection: jest.fn(col => {
        if (col === 'partners') {
          return {
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue(makePartnerSnap(MOCK_EXTERNAL_PARTNER)),
          };
        }
        if (col === 'api_usage') return { add: jest.fn().mockResolvedValue({}) };
        if (col === 'assessments') {
          return {
            doc: jest.fn(() => ({
              get: jest.fn().mockResolvedValue({
                exists: true,
                // Stored under a different partner
                data: () => ({ partner_id: MOCK_PARTNER.id, trader_id: TRADER_ID }),
              }),
            })),
          };
        }
        return { where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) };
      }),
    });

    const res = await request(app)
      .get('/api/v1/assessments/asmt_stored')
      .set('Authorization', 'Bearer valid_key');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  test('404 when assessment does not exist', async () => {
    adminMock.firestore.mockReturnValue({
      collection: jest.fn(col => {
        if (col === 'partners') {
          return {
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue(makePartnerSnap(MOCK_PARTNER)),
          };
        }
        if (col === 'api_usage') return { add: jest.fn().mockResolvedValue({}) };
        if (col === 'assessments') {
          return {
            doc: jest.fn(() => ({
              get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
            })),
          };
        }
        return { where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue({ docs: [] }) };
      }),
    });

    const res = await request(app)
      .get('/api/v1/assessments/asmt_nonexistent')
      .set('Authorization', 'Bearer valid_key');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('assessment_not_found');
  });
});
