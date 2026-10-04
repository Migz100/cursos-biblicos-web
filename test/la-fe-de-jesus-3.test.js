const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { applyContentRevisions } = require('../api/_lib/cms/content-revisions');
const { LA_FE_DE_JESUS_3 } = require('../api/_lib/cms/la-fe-de-jesus-3');

const root = path.join(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('La Fe de Jesús 3 is added once, after the existing courses, without changing them', () => {
  const manifest = { revision: 'r', courses: [{ id: '1', name: 'Fe de Jesús', lessons: [] }] };
  const revised = applyContentRevisions(manifest);
  assert.deepEqual(revised.courses.map(course => course.id), ['1', 'la-fe-de-jesus-3']);
  assert.deepEqual(revised.courses[0], manifest.courses[0]);
  assert.equal(manifest.courses.length, 1);
  const again = applyContentRevisions(revised);
  assert.equal(again.courses.filter(course => course.id === 'la-fe-de-jesus-3').length, 1);
  revised.courses[1].lessons[0].title = 'changed';
  assert.notEqual(LA_FE_DE_JESUS_3.lessons[0].title, 'changed');
});

test('La Fe de Jesús 3 lists 20 readable PDF lessons that keep the source file for download', () => {
  const course = LA_FE_DE_JESUS_3;
  assert.equal(course.name, 'La Fe de Jesús 3');
  assert.equal(course.section, 'cursos');
  assert.ok(fs.existsSync(path.join(root, course.coverUrl)));
  assert.equal(course.lessons.length, 20);
  course.lessons.forEach((lesson, index) => {
    const number = String(index + 1).padStart(2, '0');
    assert.equal(lesson.id, `lf3-${number}`);
    assert.equal(lesson.legacyNumber, number);
    assert.equal(lesson.type, 'pdf');
    assert.match(lesson.url, new RegExp(`/la-fe-de-jesus-3/leccion-${number}\\.pdf$`));
    assert.equal(lesson.downloadUrl, `${lesson.originalUrl}?download=1`);
    assert.match(lesson.originalUrl, new RegExp(`/la-fe-de-jesus-3/original/leccion-${number}\\.pdf$`));
  });
});

test('every La Fe de Jesús 3 lesson has answer fields and verse buttons for both pages', () => {
  const answers = readJson('assets/answer-fields.json').documents;
  const verses = readJson('assets/verse-fields.json').documents;
  for (const lesson of LA_FE_DE_JESUS_3.lessons) {
    const key = `la-fe-de-jesus-3|${lesson.id}`;
    for (const catalog of [answers, verses]) {
      assert.equal(catalog[key].url, lesson.url, key);
      assert.deepEqual(Object.keys(catalog[key].pages), ['1', '2'], key);
    }
    const front = answers[key].pages['1'];
    assert.ok(front.filter(field => field.kind === 'line').length >= 6, `${key}: answer lines`);
    assert.equal(front.filter(field => field.kind === 'radio' && field.group === 'calificacion').length, 3, `${key}: grade`);
    assert.equal(front.filter(field => field.kind === 'check').length, 1, `${key}: acepto`);
    assert.equal(front.filter(field => field.kind === 'box').length, 3, `${key}: fecha`);
    assert.equal(new Set(front.map(field => field.id)).size, front.length, `${key}: stable ids`);
    assert.ok(verses[key].pages['1'].length >= 8, `${key}: verse buttons`);
  }
  assert.equal(answers['la-fe-de-jesus-3|lf3-20'].pages['2'].length, 3, 'Nombre, Fecha and Instructor(a) on the decision card');
});
