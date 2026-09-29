const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('local audit server serves only repository assets and blocks protected paths', async () => {
  const { resolveStaticPath } = await import('../scripts/local-audit-server.mjs');
  const root = path.join(__dirname, '..');
  assert.equal(resolveStaticPath('/'), path.join(root, 'index.html'));
  assert.equal(resolveStaticPath('/styles.css'), path.join(root, 'styles.css'));
  assert.equal(resolveStaticPath('/../../.env.local'), null);
  assert.equal(resolveStaticPath('/.vercel/project.json'), null);
  assert.equal(resolveStaticPath('/work/private.txt'), null);
});

test('local audit API proxy is strictly read-only and allow-listed', async () => {
  const { apiProxyAllowed } = await import('../scripts/local-audit-server.mjs');
  assert.equal(apiProxyAllowed('/api/catalog', 'GET'), true);
  assert.equal(apiProxyAllowed('/api/presentation', 'GET'), true);
  assert.equal(apiProxyAllowed('/api/manage/history', 'GET'), true);
  assert.equal(apiProxyAllowed('/api/manage/catalog', 'GET'), false);
  assert.equal(apiProxyAllowed('/api/manage/history', 'POST'), false);
});
