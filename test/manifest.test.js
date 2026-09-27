const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('../api/manifest');

function request(url) {
  const result = { headers: {} };
  const res = {
    setHeader(key, value) { result.headers[key] = value; },
    status(value) { result.status = value; return this; },
    json(value) { result.body = value; },
    send(value) { result.body = JSON.parse(value); }
  };
  handler({ url, method: 'GET' }, res);
  return result;
}

test('installing a shared collection always launches its same selection', () => {
  const token = 'a'.repeat(64);
  const result = request(`/api/manifest?s=${token}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.start_url, `/index.html?s=${token}`);
  assert.equal(result.body.id, result.body.start_url);
  assert.equal(result.body.display, 'standalone');
  assert.equal(result.headers['Content-Type'], 'application/manifest+json; charset=utf-8');
});

test('invalid selection manifests never fall back to the full catalog', () => {
  for (const query of ['s=', 's=bad', `s=${'a'.repeat(64)}&s=${'b'.repeat(64)}`, 's=https://example.com']) {
    const result = request(`/api/manifest?${query}`);
    assert.equal(result.status, 400);
    assert.equal(result.body.start_url, undefined);
  }
});

test('the catalog manifest references valid install icons', () => {
  const result = request('/api/manifest');
  assert.equal(result.body.start_url, '/');
  for (const icon of result.body.icons) {
    const data = fs.readFileSync(path.join(__dirname, '..', icon.src));
    assert.equal(data.toString('hex', 0, 8), '89504e470d0a1a0a');
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(data.readUInt32BE(16), size);
    assert.equal(data.readUInt32BE(20), size);
  }
});
