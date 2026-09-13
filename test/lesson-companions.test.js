const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'lesson-companions.js'), 'utf8'), context);
const course = 'c_ce795f91-5ff0-4270-9cc2-d7ef4f930933';
const lesson = {
  id: 'l_9f57406e-8c41-4bd9-a0a2-6cfa381e7ec1',
  url: 'https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/cms/production/assets/d8c999bb-d978-445e-a941-54ebfd004e1b-29-el-milenio.pptx'
};

test('El Milenio opens its reading copy while retaining its exact original presentation URL', () => {
  const original = { ...lesson };
  const companion = context.window.LessonCompanions.get(course, lesson);
  assert.equal(companion.pdfUrl, '/assets/companions/el-milenio.pdf');
  assert.deepEqual(lesson, original);
  assert.equal(fs.readFileSync(path.join(root, companion.pdfUrl)).subarray(0, 5).toString(), '%PDF-');
  assert.equal(context.window.LessonCompanions.get(course, { id: lesson.id, downloadUrl: lesson.url + '?download=1' }).pdfUrl, companion.pdfUrl);
});

test('the reading copy cannot replace another lesson or a later uploaded source', () => {
  const get = context.window.LessonCompanions.get;
  assert.equal(get('1', lesson), null);
  assert.equal(get(course, { ...lesson, id: 'another-lesson' }), null);
  assert.equal(get(course, { ...lesson, url: 'https://example.com/changed.pptx' }), null);
  assert.equal(get(course, undefined), null);
});

test('the companion has exactly one stable writable blank on slide three', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'assets/answer-fields.json')));
  const document = catalog.documents[`${course}|${lesson.id}`];
  assert.equal(document.url, lesson.url);
  assert.equal(Object.keys(document.pages).length, 16);
  assert.equal(Object.values(document.pages).flat().length, 1);
  assert.equal(document.pages['3'][0].id, 'printed-apocalipsis-10-1-2');
  assert.equal(document.pages['3'][0].color, '#FFFFFF');
  assert.equal(document.pages['3'][0].verified, true);
});


test('all thirty presentation lessons have complete reading copies and preserve original downloads', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'assets/answer-fields.json')));
  const documents = Object.entries(catalog.documents).filter(([key]) => key.startsWith(`${course}|`));
  assert.equal(documents.length, 30, 'Every offered presentation must be readable in the app');
  const paths = new Set();
  let totalPages = 0;
  for (const [key, document] of documents) {
    const source = { id: key.split('|')[1], url: document.url };
    const original = { ...source };
    const companion = context.window.LessonCompanions.get(course, source);
    assert.ok(companion, `Missing reading copy: ${source.id}`);
    assert.deepEqual(source, original, 'The original presentation remains downloadable');
    assert.equal(fs.readFileSync(path.join(root, companion.pdfUrl)).subarray(0, 5).toString(), '%PDF-');
    assert.equal(context.window.LessonCompanions.get(course, { ...source, url: source.url + '.replaced' }), null);
    paths.add(companion.pdfUrl);
    totalPages += Object.keys(document.pages).length;
    if (source.id !== lesson.id) assert.equal(Object.values(document.pages).flat().length, 0, 'Already printed answers must stay readable');
  }
  assert.equal(paths.size, 30, 'Each lesson keeps its own source content');
  assert.equal(totalPages, 570, 'Reading copies include the six source-hidden slides');
});
