const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanEvent, validateJobInput } = require('../api/_lib/code/validation');
const CLIENT_ID = '01900000-0000-7000-8000-000000000010';

test('plain-language coding jobs are bounded and normalized', () => {
  const job = validateJobInput({ clientId: CLIENT_ID, action: 'prompt', mode: 'edit', provider: 'auto', prompt: '  Cambia el color\r\npor favor.  ' });
  assert.equal(job.prompt, 'Cambia el color\npor favor.');
  assert.equal(job.action, 'prompt');
  assert.match(job.id, /^[0-9a-f-]{36}$/);
  assert.throws(() => validateJobInput({ clientId: CLIENT_ID, action: 'prompt', prompt: '' }), error => error.code === 'INVALID_PROMPT');
  assert.throws(() => validateJobInput({ clientId: CLIENT_ID, action: 'delete-everything', prompt: 'x' }), error => error.code === 'INVALID_ACTION');
  assert.throws(() => validateJobInput({ clientId: CLIENT_ID, action: 'prompt', provider: 'unknown', prompt: 'x' }), error => error.code === 'INVALID_PROVIDER');
});

test('host events have safe sequence values and bounded content', () => {
  const event = cleanEvent({ seq: 2, type: 'status', text: 'Trabajando', meta: { provider: 'Codex' } });
  assert.equal(event.seq, 2);
  assert.equal(event.type, 'status');
  assert.equal(event.text, 'Trabajando');
  assert.equal(event.meta.provider, 'Codex');
  assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.throws(() => cleanEvent({ seq: 0, type: 'status', text: 'x' }), error => error.code === 'INVALID_EVENT');
  assert.throws(() => cleanEvent({ seq: 1, type: 'html', text: '<script>' }), error => error.code === 'INVALID_EVENT');
});
