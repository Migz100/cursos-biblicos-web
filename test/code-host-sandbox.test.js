const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const hostSource = fs.readFileSync(path.join(root, 'scripts', 'code-host.mjs'), 'utf8').replace(/\r\n/g, '\n');
const setupSource = fs.readFileSync(path.join(root, 'scripts', 'setup-code-host.mjs'), 'utf8').replace(/\r\n/g, '\n');
const editorHtml = fs.readFileSync(path.join(root, 'edit', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

test('public editor providers run with a non-escalating Codex sandbox', () => {
  const runner = hostSource.match(/async function runCodex[\s\S]*?\n}\n\nasync function runKimi/);
  assert.ok(runner);
  assert.match(runner[0], /--ignore-user-config/);
  assert.match(runner[0], /mode === 'plan' \? 'read-only' : 'workspace-write'/);
  assert.match(runner[0], /approval_policy="never"/);
  assert.doesNotMatch(runner[0], /--approve-for-me|dangerously-bypass/);
});

test('providers without a verified host filesystem sandbox stay unavailable', () => {
  assert.match(hostSource, /provider\('kimi', 'Kimi', false, 'Desactivado:/);
  assert.match(hostSource, /provider\('claude', 'Claude', false, 'Desactivado:/);
  assert.match(hostSource, /CODE_PROVIDER_ORDER \|\| 'codex,local'/);
  assert.match(setupSource, /CODE_PROVIDER_ORDER=codex,local/);
  assert.match(editorHtml, /<option value="kimi" disabled>Kimi \(sin aislamiento\)<\/option>/);
});
