const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'site.js'), 'utf8');

test('homepage uses the selected image-led study header', () => {
  assert.match(html, /class="homeHero"/);
  assert.match(html, /assets\/course-covers\/fe-de-jesus\.webp/);
  assert.match(html, /Estudia la Biblia<br>a tu ritmo/);
  assert.doesNotMatch(html, /id="sub"/);
  assert.doesNotMatch(html, /archiveNote/);
});

test('homepage keeps search and catalog download behavior', () => {
  assert.match(html, /id="search"/);
  assert.match(html, /id="dlBtn"/);
  assert.match(script, /shareDownload\(DATA\.zip/);
  assert.doesNotMatch(script, /getElementById\('archiveNote'\)/);
});
