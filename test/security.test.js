const test = require('node:test');
const assert = require('node:assert/strict');
const {
  csrfCookie,
  existingCsrfToken,
  newCsrfToken,
  requireCsrf,
  requireSameOrigin,
  signEnvelope,
  verifyEnvelope
} = require('../api/_lib/cms/security');

process.env.CMS_SIGNING_SECRET = 'test-only-signing-key-with-enough-entropy';

function request(overrides = {}) {
  return {
    headers: {
      host: 'preview.example.test',
      'x-forwarded-proto': 'https',
      origin: 'https://preview.example.test',
      'sec-fetch-site': 'same-origin',
      ...overrides
    },
    socket: { remoteAddress: '127.0.0.1' }
  };
}

test('same-origin and CSRF checks accept a matching editing session', () => {
  const token = newCsrfToken();
  const req = request({ cookie: `cb_csrf=${token}`, 'x-csrf-token': token });
  assert.doesNotThrow(() => requireCsrf(req));
  assert.match(csrfCookie(token), /HttpOnly/);
  assert.match(csrfCookie(token), /SameSite=Strict/);
});

test('an existing valid CSRF cookie is reused across tabs', () => {
  const token = newCsrfToken();
  assert.equal(existingCsrfToken(request({ cookie: `other=value; cb_csrf=${token}` })), token);
  assert.equal(existingCsrfToken(request({ cookie: 'cb_csrf=too-short' })), null);
});

test('cross-site, missing-origin, and mismatched CSRF requests are denied', () => {
  assert.throws(() => requireSameOrigin(request({ origin: 'https://evil.example' })), error => error.status === 403);
  assert.throws(() => requireSameOrigin(request({ origin: '' })), error => error.status === 403);
  const token = newCsrfToken();
  assert.throws(
    () => requireCsrf(request({ cookie: `cb_csrf=${token}`, 'x-csrf-token': newCsrfToken() })),
    error => error.status === 403
  );
});

test('signed upload receipts reject tampering and expiration', () => {
  const token = signEnvelope('asset', { pathname: 'safe/path' }, 1000);
  assert.deepEqual(verifyEnvelope(token, 'asset'), { pathname: 'safe/path' });
  assert.throws(() => verifyEnvelope(`${token}x`, 'asset'), error => error.code === 'INVALID_RECEIPT');
  const expired = signEnvelope('asset', { pathname: 'safe/path' }, -1);
  assert.throws(() => verifyEnvelope(expired, 'asset'), error => error.code === 'EXPIRED_RECEIPT');
});
