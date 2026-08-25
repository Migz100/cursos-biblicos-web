const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStarterManifest } = require('../api/_lib/cms/core');
const {
  LESSON_TITLES,
  SOURCE_IDS,
  assertReplacementResult,
  assertSourceIndexIds,
  buildReplacementAction,
  driveIdFromUrl,
  parseTopRowDriveIds
} = require('../scripts/fe-de-jesus-source');

test('the one-page source index is parsed left to right and exposes the bad duplicate', () => {
  const annotations = SOURCE_IDS.map((id, index) => ({
    url: `https://drive.google.com/file/d/${id}/view?usp=sharing`,
    rect: [100 + index * 20, 431 + (index % 2), 116 + index * 20, 447]
  }));
  annotations.push({ url: 'https://drive.google.com/file/d/lower-row/view', rect: [100, 410, 116, 426] });
  const ids = parseTopRowDriveIds(annotations.reverse());
  assert.deepEqual(ids, SOURCE_IDS);
  assert.equal(assertSourceIndexIds(ids), true);
  assert.equal(ids[12], ids[13]);
  assert.equal(driveIdFromUrl('https://attacker.invalid/file/d/test/view'), null);
});

test('the replacement plan contains 20 titled lessons and requires validated tokens', () => {
  const tokens = LESSON_TITLES.map((_, index) => `token-${index + 1}`);
  const action = buildReplacementAction('revision-one', tokens);
  assert.equal(action.type, 'course.replaceLessons');
  assert.equal(action.lessons.length, 20);
  assert.equal(action.lessons[13].title, 'La Muerte');
  assert.throws(() => buildReplacementAction('revision-one', tokens.slice(1)), /exactly 20/);
});

test('replacement verification rejects changes outside Fe de Jesús', () => {
  const before = buildStarterManifest();
  const after = structuredClone(before);
  after.courses[0].lessons = after.courses[0].lessons.map((lesson, index) => ({
    ...lesson,
    title: LESSON_TITLES[index],
    type: 'pdf',
    managed: true,
    pathname: `cms/preview/test/assets/${index + 1}.pdf`
  }));
  assert.equal(assertReplacementResult(before, after), true);
  const changedOtherCourse = structuredClone(after);
  changedOtherCourse.courses[1].name = 'Nombre cambiado';
  assert.throws(() => assertReplacementResult(before, changedOtherCourse), /other than Fe de Jesús/);
});
