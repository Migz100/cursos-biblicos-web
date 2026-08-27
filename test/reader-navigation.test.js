const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'leer.html'), 'utf8');
const reader = fs.readFileSync(path.join(root, 'reader.js'), 'utf8');

test('multi-page lessons expose continuous scrolling and persistent page controls', () => {
  assert.ok(html.indexOf('class="pdfNav"') < html.indexOf('id="pdfBox"'));
  assert.match(html, /Desliza hacia abajo para ver todas las páginas/);
  assert.match(reader, /Array\.from\(\{ length: pdfDoc\.numPages \}/);
  assert.match(reader, /new IntersectionObserver/);
  assert.match(reader, /addEventListener\('scroll', scheduleCurrentPageUpdate/);
  assert.match(reader, /scrollToPage\(pageNum \+ 1\)/);
});

test('answer fields stay tied to their PDF page in the continuous reader', () => {
  assert.match(reader, /fieldId\(pageNumber, field\)/);
  assert.match(reader, /answerState\.fields\[id\] = \{ page: pageNumber/);
  assert.match(reader, /fieldsForPage\(page, viewport, canvas, pageNumber\)/);
});
