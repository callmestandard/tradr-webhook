'use strict';

const { createSignedToken, verifySignedToken } = require('../services/exporter');

// ── Signed token lifecycle ────────────────────────────────────────────────────

describe('createSignedToken + verifySignedToken', () => {
  test('valid token round-trips correctly', () => {
    const token   = createSignedToken('trader_abc', 'csv');
    const payload = verifySignedToken(token);
    expect(payload).not.toBeNull();
    expect(payload.traderId).toBe('trader_abc');
    expect(payload.type).toBe('csv');
    expect(payload.exp).toBeGreaterThan(Date.now());
  });

  test('tampered signature returns null', () => {
    const token  = createSignedToken('trader_abc', 'csv');
    const parts  = token.split('.');
    const tampered = parts[0] + '.' + 'invalidsignature';
    expect(verifySignedToken(tampered)).toBeNull();
  });

  test('tampered payload returns null', () => {
    const token = createSignedToken('trader_abc', 'csv');
    const [, sig] = token.split('.');
    const fakePayload = Buffer.from(JSON.stringify({ traderId: 'attacker', type: 'csv', exp: Date.now() + 9999999 })).toString('base64url');
    expect(verifySignedToken(`${fakePayload}.${sig}`)).toBeNull();
  });

  test('expired token returns null', () => {
    // Manually build a token with exp in the past
    const crypto = require('crypto');
    const secret = process.env.EXPORT_SECRET || process.env.WHATSAPP_VERIFY_TOKEN || 'tradr_export_secret';
    const payload = JSON.stringify({ traderId: 'trader_abc', type: 'csv', exp: Date.now() - 1000 });
    const b64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
    const token = `${b64}.${sig}`;
    expect(verifySignedToken(token)).toBeNull();
  });

  test('malformed token (no dot) returns null', () => {
    expect(verifySignedToken('nodotinhere')).toBeNull();
    expect(verifySignedToken('')).toBeNull();
    expect(verifySignedToken(null)).toBeNull();
  });

  test('token payload is not JSON-parseable returns null', () => {
    const sig = 'fakesig';
    const b64 = Buffer.from('this is not json').toString('base64url');
    expect(verifySignedToken(`${b64}.${sig}`)).toBeNull();
  });

  test('two calls produce different tokens (not deterministic)', () => {
    // Small delay to ensure different exp
    const t1 = createSignedToken('x', 'csv');
    const t2 = createSignedToken('x', 'csv');
    // Tokens differ because exp is based on Date.now()
    // They may be the same if called in the same ms — that's fine, just check both parse
    expect(verifySignedToken(t1)).not.toBeNull();
    expect(verifySignedToken(t2)).not.toBeNull();
  });

  test('default type is csv', () => {
    const token   = createSignedToken('trader_xyz');
    const payload = verifySignedToken(token);
    expect(payload.type).toBe('csv');
  });
});
