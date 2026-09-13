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
