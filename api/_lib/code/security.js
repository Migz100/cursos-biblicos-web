const crypto = require('node:crypto');
const { CmsError, namespaceFromEnv } = require('../cms/core');
const { parseCookies } = require('../cms/security');

const EDITOR_SESSION_MS = 365 * 24 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function safeEqualHex(actual, expected) {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function requireSecret(value, envName, code, message) {
  const expected = String(process.env[envName] || '').trim();
  if (!expected) throw new Error(`${envName} is not configured`);
  const actual = sha256(value || '');
  if (!safeEqualHex(actual, expected)) throw new CmsError(403, code, message);
}

function editorCookieName() {
  return process.env.VERCEL ? '__Host-cb_editor' : 'cb_editor';
}

function editorSigningKey() {
  const relaySecret = String(process.env.CODE_RELAY_SECRET || '');
  const editorHash = String(process.env.CODE_EDITOR_KEY_HASH || '');
  if (relaySecret.length < 32 || !/^[a-f0-9]{64}$/i.test(editorHash)) throw new Error('Editor session secrets are not configured');
  return crypto.createHash('sha256').update(`editor-session:${relaySecret}:${editorHash}`, 'utf8').digest();
}

function newEditorSessionToken(now = Date.now()) {
  const editorHash = String(process.env.CODE_EDITOR_KEY_HASH || '');
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: now + EDITOR_SESSION_MS, key: editorHash.slice(0, 16) }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', editorSigningKey()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyEditorSessionToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 800) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return false;
  const expected = crypto.createHmac('sha256', editorSigningKey()).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const editorHash = String(process.env.CODE_EDITOR_KEY_HASH || '');
    return decoded.v === 1 && Number.isFinite(decoded.exp) && decoded.exp > now && decoded.key === editorHash.slice(0, 16);
  } catch { return false; }
}

function editorSessionCookie(token) {
  const secure = process.env.VERCEL ? '; Secure' : '';
  return `${editorCookieName()}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(EDITOR_SESSION_MS / 1000)}${secure}`;
}

function requirePairingKey(req) {
  requireSecret(req.headers['x-code-pairing'], 'CODE_EDITOR_KEY_HASH', 'EDITOR_ACCESS_DENIED', 'Este dispositivo no tiene acceso al editor.');
}

function requireEditor(req) {
  const token = parseCookies(req.headers.cookie)[editorCookieName()] || '';
  if (!verifyEditorSessionToken(token)) throw new CmsError(403, 'EDITOR_ACCESS_DENIED', 'Este dispositivo no tiene acceso al editor.');
}

function requireHost(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{32,})$/);
  requireSecret(match?.[1], 'CODE_HOST_TOKEN_HASH', 'HOST_ACCESS_DENIED', 'El equipo de edición no tiene acceso.');
}

function relayKey() {
  const secret = String(process.env.CODE_RELAY_SECRET || '');
  if (secret.length < 32) throw new Error('CODE_RELAY_SECRET is not configured');
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function seal(value, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', relayKey(), iv);
  cipher.setAAD(Buffer.from(`cursos-biblicos:${namespaceFromEnv()}:${purpose}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: ciphertext.toString('base64url')
  });
}

function open(payload, purpose) {
  let envelope;
  try { envelope = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch {
    throw new Error('Invalid encrypted relay record');
  }
  if (!envelope || envelope.v !== 1) throw new Error('Invalid encrypted relay record');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', relayKey(), Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(Buffer.from(`cursos-biblicos:${namespaceFromEnv()}:${purpose}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64url')),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('Unable to decrypt relay record');
  }
}

function requireUuid(value, label = 'identificador') {
  const text = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new CmsError(400, 'INVALID_ID', `El ${label} no es válido.`);
  }
  return text.toLowerCase();
}

module.exports = {
  editorSessionCookie,
  newEditorSessionToken,
  open,
  requireEditor,
  requireHost,
  requirePairingKey,
  requireUuid,
  seal,
  sha256,
  verifyEditorSessionToken
};
