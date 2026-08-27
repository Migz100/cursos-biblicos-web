const crypto = require('node:crypto');
const { CmsError } = require('./core');

function signingKey() {
  const key = process.env.CMS_SIGNING_SECRET || process.env.BLOB_READ_WRITE_TOKEN;
  if (!key) throw new Error('Server signing key is not configured');
  return key;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signEnvelope(kind, value, ttlMs) {
  const payload = base64url(JSON.stringify({ kind, exp: Date.now() + ttlMs, value }));
  const signature = crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyEnvelope(token, kind) {
  if (typeof token !== 'string' || token.length > 12000) throw new CmsError(400, 'INVALID_RECEIPT', 'El comprobante no es válido.');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new CmsError(400, 'INVALID_RECEIPT', 'El comprobante no es válido.');
  const expected = crypto.createHmac('sha256', signingKey()).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { actual = Buffer.alloc(0); }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new CmsError(400, 'INVALID_RECEIPT', 'El comprobante no es válido.');
  }
  let decoded;
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new CmsError(400, 'INVALID_RECEIPT', 'El comprobante no es válido.'); }
  if (decoded.kind !== kind || !Number.isFinite(decoded.exp) || decoded.exp < Date.now()) {
    throw new CmsError(400, 'EXPIRED_RECEIPT', 'El comprobante venció. Intenta subir el archivo otra vez.');
  }
  return decoded.value;
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map(item => {
    const index = item.indexOf('=');
    if (index < 0) return ['', ''];
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function csrfCookieName() {
  return process.env.VERCEL ? '__Host-cb_csrf' : 'cb_csrf';
}

function newCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function existingCsrfToken(req) {
  const token = parseCookies(req.headers.cookie)[csrfCookieName()] || '';
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function csrfCookie(token) {
  const secure = process.env.VERCEL ? '; Secure' : '';
  return `${csrfCookieName()}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${secure}`;
}

function expectedOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${protocol}://${host}`;
}

function requireSameOrigin(req) {
  const origin = String(req.headers.origin || '');
  let normalized;
  try { normalized = new URL(origin).origin; } catch { throw new CmsError(403, 'ORIGIN_REQUIRED', 'Solicitud rechazada.'); }
  if (normalized !== expectedOrigin(req)) throw new CmsError(403, 'ORIGIN_DENIED', 'Solicitud rechazada.');
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  if (fetchSite && fetchSite !== 'same-origin') throw new CmsError(403, 'ORIGIN_DENIED', 'Solicitud rechazada.');
}

function requireCsrf(req) {
  requireSameOrigin(req);
  const cookies = parseCookies(req.headers.cookie);
  const cookie = cookies[csrfCookieName()] || '';
  const header = String(req.headers['x-csrf-token'] || '');
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  if (a.length < 32 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new CmsError(403, 'CSRF_DENIED', 'La sesión de edición venció. Recarga la página.');
  }
}

function clientKey(req, scope) {
  const forwarded = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown');
  const ip = forwarded.split(',')[0].trim();
  return crypto.createHmac('sha256', signingKey()).update(`${scope}:${ip}`).digest('hex').slice(0, 32);
}

module.exports = {
  clientKey,
  csrfCookie,
  existingCsrfToken,
  newCsrfToken,
  parseCookies,
  requireCsrf,
  requireSameOrigin,
  signEnvelope,
  verifyEnvelope
};
