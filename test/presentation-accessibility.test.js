const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { strToU8, zipSync } = require('fflate');
const { extractPresentationAccessibility } = require('../api/_lib/cms/presentation-accessibility');

function deck(entries = {}) {
  const presentation = `<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="9" r:id="rSecond"/><p:sldId id="3" r:id="rFirst"/></p:sldIdLst></p:presentation>`;
  const relationships = `<?xml version="1.0"?><Relationships><Relationship Id="rFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rSecond" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`;
  const slideOne = `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Juan 3:16</a:t></a:r></a:p><a:p><a:r><a:t>Texto uno</a:t></a:r></a:p></p:sld>`;
  const slideTwo = `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>2 S. Pedro 3:7,10</a:t></a:r></a:p><a:p><a:r><a:t>Texto &amp; dos</a:t></a:r></a:p></p:sld>`;
  const files = {
    'ppt/presentation.xml': strToU8(presentation),
    'ppt/_rels/presentation.xml.rels': strToU8(relationships),
    'ppt/slides/slide1.xml': strToU8(slideOne),
    'ppt/slides/slide2.xml': strToU8(slideTwo),
    'ppt/media/ignored.bin': new Uint8Array([1, 2, 3]),
    ...entries
  };
  return zipSync(files);
}

test('presentation accessibility follows logical slide order and preserves extracted wording', () => {
  const result = extractPresentationAccessibility(deck());
  assert.equal(result.status, 'available');
  assert.equal(result.slideCount, 2);
  assert.equal(result.referenceCount, 2);
  assert.deepEqual(result.slides.map(slide => slide.sourcePart), ['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml']);
  assert.equal(result.slides[0].text, '2 S. Pedro 3:7,10\nTexto & dos');
  assert.equal(result.slides[0].references[0].bookId, '61-2-pedro');
  assert.equal(result.slides[1].references[0].label, 'Juan 3:16');
});

test('presentation accessibility rejects non-zip and missing relationship structure', () => {
  assert.throws(() => extractPresentationAccessibility(new Uint8Array([1, 2, 3, 4])), /INVALID_PRESENTATION_ZIP/);
  const incomplete = zipSync({ 'ppt/presentation.xml': strToU8('<p:presentation/>') });
  assert.throws(() => extractPresentationAccessibility(incomplete), /PRESENTATION_STRUCTURE_MISSING/);
});

test('the web viewer exposes slide text and keyboard-safe Bible links without replacing the deck', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'presentacion.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'presentation.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(html, /id="openTranscript"[\s\S]*?aria-controls="presentationTranscript"/);
  assert.ok(html.indexOf('verses.js') < html.indexOf('presentation.js'));
  assert.match(client, /BibleVerses\.referenceIsValid/);
  assert.match(client, /button\.addEventListener\('click', event => openVersePopup\(reference, event\.currentTarget\)\)/);
  assert.match(client, /if \(event\.key === 'Escape'\)/);
  assert.match(client, /if \(target\?\.isConnected\) target\.focus\(\)/);
  assert.match(styles, /\.slideVerseButton \{[\s\S]*?min-height: 44px/);
});
