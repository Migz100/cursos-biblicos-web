const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'leer.html'), 'utf8');
const reader = fs.readFileSync(path.join(root, 'reader.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

function sourceFunction(name) {
  const start = reader.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const open = reader.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < reader.length; index += 1) {
    if (reader[index] === '{') depth += 1;
    else if (reader[index] === '}') {
      depth -= 1;
      if (!depth) return reader.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

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
  assert.match(reader, /fieldsForPage\([\s\S]*?metric\.extraRotation,[\s\S]*?canonicalViewport,[\s\S]*?canonicalCanvas/);
});

test('answer controls reject stale catalogs and preserve native AcroForm checkboxes', () => {
  assert.match(reader, /catalogPageCount !== pdfDoc\.numPages/);
  assert.match(reader, /kind: annotation\.fieldType === 'Btn' \? 'check' : 'widget',[\s\S]*?native: true/);
  assert.match(reader, /fields\.filter\(field => field\.native \|\| !overlapsPrintedText\(field, rects\)\)/);
  assert.match(reader, /hasPrintedText \? detectedCanvasFields\(canonicalCanvas\) : \[\]/);
  assert.match(reader, /renderCanonicalFieldCanvas\(page, canonicalRotation\)/);
});

test('every rendered page exposes text and safe PDF annotations to assistive technology', () => {
  assert.match(reader, /createAccessiblePageText\(element, canvas, textContent, pageNumber\)/);
  assert.match(reader, /canvas\.setAttribute\('aria-describedby', description\.id\)/);
  assert.match(reader, /page\.getAnnotations\(\{ intent: 'display' \}\)/);
  assert.match(reader, /\['http:', 'https:'\]\.includes\(url\.protocol\)/);
  assert.match(reader, /control\.rel = 'noopener noreferrer'/);
  assert.match(html, /id="downloadOriginal"/);
});

test('reader controls are large, keyboard visible, and remember the chosen zoom', () => {
  assert.match(styles, /\.navBtn \{[\s\S]*?min-height: 44px/);
  assert.match(styles, /\.wBtn \{[\s\S]*?min-height: 44px/);
  assert.match(styles, /:focus-visible[\s\S]*?outline: 3px solid var\(--focus\)/);
  assert.match(styles, /\.answerField \{[\s\S]*?border: 2px solid var\(--focus\)/);
  assert.match(styles, /\.answerField:focus \{ outline: 3px solid var\(--focus\)/);
  assert.match(styles, /\.answerCheck::before \{[\s\S]*?border: 2px solid var\(--focus\)/);
  assert.match(reader, /const ZOOM_KEY = 'cursosBiblicosReaderZoom_v2'/);
  assert.match(reader, /localStorage\.setItem\(ZOOM_KEY, String\(zoomFactor\)\)/);
  assert.match(reader, /zoomValue'\)\.textContent = `\$\{Math\.round\(zoomFactor \* 100\)\}%`/);
  assert.match(reader, /area\.dataset\.allowHorizontalScroll = String\(zoomFactor > 1\)/);
  assert.match(styles, /\.pdfArea\[data-allow-horizontal-scroll="false"\] \{ overflow-x: hidden; \}/);
  assert.match(reader, /function minimumTargetGeometry\(geometry, viewport, minimumPixels = 44\)/);
  assert.match(html, /<h1 class="title" id="title">/);
});

test('catalog Bible links are validated against bundled RVR1960 before rendering', () => {
  assert.match(reader, /BibleVerses\.referenceIsValid\(match, bookData\.get\(match\.bookId\)\)/);
  assert.match(reader, /pageElement\.dataset\.invalidVerseCount = String\(rejected\)/);
});

test('the current PDF page can be rotated without changing source content or other pages', () => {
  assert.match(html, /id="rotatePage"/);
  assert.match(reader, /pageRotations\[key\] = \(Number\(pageRotations\[key\] \|\| 0\) \+ 90\) % 360/);
  assert.match(reader, /page\.getViewport\(\{ scale: metric\.scale, rotation: metric\.rotation \}\)/);
  assert.match(reader, /rotateGeometry\(field, extraRotation\)/);
  assert.match(reader, /createVerseLayer\(element, viewport, pageNumber, textContent, metric\.extraRotation\)/);
  const context = {};
  vm.runInNewContext(`${sourceFunction('rotateGeometry')}\n${sourceFunction('mergeFields')}\n${sourceFunction('overlapsPrintedText')}\n${sourceFunction('filterAndRotateFields')}\nthis.rotateGeometry = rotateGeometry; this.mergeFields = mergeFields; this.filterAndRotateFields = filterAndRotateFields;`, context);
  const rotated = context.rotateGeometry({ x: 0.1, y: 0.2, w: 0.3, h: 0.1, kind: 'line' }, 90);
  assert.equal(rotated.h, 0.3);
  assert.equal(context.mergeFields([rotated])[0].h, 0.3);
  assert.equal(context.mergeFields([{ x: 0.1, y: 0.2, w: 0.3, h: 0.5, kind: 'line' }])[0].h, 0.25);
  assert.equal(context.mergeFields([{ x: 0.1, y: 0.2, w: 0.3, h: 0.5, kind: 'widget', native: true }])[0].h, 0.5);

  const canonicalFields = [
    { id: 'covered', x: 0.1, y: 0.1, w: 0.2, h: 0.08, kind: 'line' },
    { id: 'clear', x: 0.5, y: 0.5, w: 0.2, h: 0.08, kind: 'line' },
    { id: 'native', x: 0.12, y: 0.11, w: 0.04, h: 0.04, kind: 'check', native: true }
  ];
  const printed = [{ x0: 0.11, y0: 0.11, x1: 0.18, y1: 0.15 }];
  const idsAt = degrees => context.filterAndRotateFields(canonicalFields, printed, degrees).map(field => field.id).sort();
  assert.deepEqual(Array.from(idsAt(0)), ['clear', 'native']);
  assert.deepEqual(Array.from(idsAt(90)), ['clear', 'native']);
});

test('Bible dialog traps focus, closes with Escape, and restores the triggering reference', () => {
  assert.match(reader, /verseReturnFocus = document\.activeElement/);
  assert.match(reader, /if \(event\.key === 'Escape'\)/);
  assert.match(reader, /if \(event\.key !== 'Tab'\) return/);
  assert.match(reader, /if \(target\?\.isConnected\) target\.focus\(\)/);
});
