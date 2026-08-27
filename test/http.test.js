const test = require('node:test');
const assert = require('node:assert/strict');
const { readJson } = require('../api/_lib/cms/http');

test('pre-parsed JSON still obeys the route byte limit', async () => {
  assert.deepEqual(await readJson({ body: { ok: true } }, 32), { ok: true });
  await assert.rejects(() => readJson({ body: { value: 'x'.repeat(100) } }, 32), error => error.code === 'BODY_TOO_LARGE');
});

test('pre-parsed strings and buffers are parsed and limited', async () => {
  assert.deepEqual(await readJson({ body: '{"ok":true}' }, 32), { ok: true });
  assert.deepEqual(await readJson({ body: Buffer.from('{"ok":true}') }, 32), { ok: true });
  await assert.rejects(() => readJson({ body: Buffer.from('x'.repeat(40)) }, 32), error => error.code === 'BODY_TOO_LARGE');
});
