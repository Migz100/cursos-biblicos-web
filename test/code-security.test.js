const test = require('node:test');
const assert = require('node:assert/strict');
const {
  editorSessionCookie,
  newEditorSessionToken,
  open,
  requireEditor,
  requireHost,
  requirePairingKey,
  seal,
  sha256,
  verifyEditorSessionToken
} = require('../api/_lib/code/security');

const editorKey = 'editor-test-key-with-more-than-thirty-two-characters';
const hostKey = 'host-test-key-with-more-than-thirty-two-characters';
process.env.CODE_EDITOR_KEY_HASH = sha256(editorKey);
process.env.CODE_HOST_TOKEN_HASH = sha256(hostKey);
process.env.CODE_RELAY_SECRET = 'test-relay-secret-with-at-least-thirty-two-characters';
process.env.CMS_NAMESPACE_OVERRIDE = 'test/code-security';

test('editor access is open to every device (Miguel decision 2026-08-27)', () => {
  assert.doesNotThrow(() => requirePairingKey({ headers: {} }));
  assert.doesNotThrow(() => requireEditor({ headers: {} }));
  assert.doesNotThrow(() => requireEditor({ headers: { cookie: 'cb_editor=bad' } }));
  const token = newEditorSessionToken();
  assert.equal(verifyEditorSessionToken(token), true);
  assert.match(editorSessionCookie(token), /HttpOnly/);
  assert.match(editorSessionCookie(token), /SameSite=Strict/);
});

test('host access uses only the server-side token hash', () => {
  assert.doesNotThrow(() => requireHost({ headers: { authorization: `Bearer ${hostKey}` } }));
  assert.throws(() => requireHost({ headers: { authorization: 'Bearer wrong-token-that-is-long-enough-for-format' } }), error => error.code === 'HOST_ACCESS_DENIED');
});

test('relay records are authenticated ciphertext tied to purpose and environment', () => {
  const value = { prompt: 'Cambia el título', private: true };
  const encrypted = seal(value, 'job:test');
  assert.equal(encrypted.includes(value.prompt), false);
  assert.deepEqual(open(encrypted, 'job:test'), value);
  assert.throws(() => open(encrypted, 'event:test:1'));
  process.env.CMS_NAMESPACE_OVERRIDE = 'test/other-environment';
  assert.throws(() => open(encrypted, 'job:test'));
  process.env.CMS_NAMESPACE_OVERRIDE = 'test/code-security';
  const envelope = JSON.parse(encrypted);
  envelope.data = `${envelope.data.slice(0, -1)}${envelope.data.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => open(JSON.stringify(envelope), 'job:test'));
});
