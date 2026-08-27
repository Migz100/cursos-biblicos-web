const test = require('node:test');
const assert = require('node:assert/strict');
const { assertUniqueContent, auditManifest } = require('../api/_lib/cms/content-audit');

function manifest() {
  return {
    courses: [{
      id: 'c1',
      name: 'Curso',
      coverUrl: null,
      lessons: [
        { id: 'l2', title: 'Lección 02', originalName: '02.pdf', type: 'pdf', url: 'https://example.test/02.pdf', sha256: 'two', contentHash: 'text-two' },
        { id: 'l1', title: 'Lección 01', originalName: '01.pdf', type: 'pdf', url: 'https://example.test/01.pdf', sha256: 'one', contentHash: 'text-one' }
      ]
    }]
  };
}

test('content audit reports wrong numeric order and supports a clean reorder', () => {
  const value = manifest();
  const report = auditManifest(value);
  assert.equal(report.ordering.length, 1);
  assert.deepEqual(report.ordering[0].suggestedLessonIds, ['l1', 'l2']);
  value.courses[0].lessons.reverse();
  assert.equal(auditManifest(value).ordering.length, 0);
});

test('new lesson assets cannot duplicate bytes or normalized content', () => {
  const value = manifest();
  assert.throws(() => assertUniqueContent(value, {
    type: 'lesson.add', title: 'Copia', asset: { sha256: 'one', contentHash: 'different' }
  }), error => error.code === 'DUPLICATE_FILE');
  assert.throws(() => assertUniqueContent(value, {
    type: 'lesson.add', title: 'Copia de texto', asset: { sha256: 'different', contentHash: 'text-two' }
  }), error => error.code === 'DUPLICATE_CONTENT');
});
