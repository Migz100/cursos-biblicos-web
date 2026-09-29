const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertUniqueContent, auditManifest, catalogRecords } = require('../api/_lib/cms/content-audit');
const knownContent = require('../api/_lib/cms/known-content.json');

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

test('a stale known-content size cannot lend its fingerprint to current catalog bytes', () => {
  const known = knownContent.documents.find(record => record.courseId === '1' && record.lessonId === '1-13');
  assert.ok(known);
  const value = {
    courses: [{
      id: known.courseId,
      name: known.courseName,
      coverUrl: null,
      lessons: [{
        id: known.lessonId,
        title: known.title,
        originalName: known.originalName,
        type: known.type,
        url: known.url,
        size: known.size + 1,
        managed: true
      }]
    }]
  };

  const [record] = catalogRecords(value);
  assert.equal(record.sha256, null);
  assert.equal(record.contentHash, null);
  assert.equal(record.fingerprintIssue.reason, 'baseline-size-mismatch');
  assert.doesNotThrow(() => assertUniqueContent(value, {
    type: 'lesson.add',
    title: 'Archivo con la huella vieja',
    asset: { sha256: known.sha256, contentHash: known.contentHash }
  }));

  const report = auditManifest(value);
  assert.equal(report.summary.fingerprinted, 0);
  assert.equal(report.fingerprintIssues.length, 1);
  assert.equal(report.healthy, false);
});

test('a size-compatible URL baseline remains available for duplicate detection', () => {
  const known = knownContent.documents.find(record => record.courseId === '1' && record.lessonId === '1-13');
  const value = {
    courses: [{
      id: known.courseId,
      name: known.courseName,
      coverUrl: null,
      lessons: [{
        id: known.lessonId,
        title: known.title,
        originalName: known.originalName,
        type: known.type,
        url: `${known.url}?download=1`,
        size: known.size,
        managed: true
      }]
    }]
  };

  assert.equal(catalogRecords(value)[0].sha256, known.sha256);
  assert.throws(() => assertUniqueContent(value, {
    type: 'lesson.add',
    title: 'Copia',
    asset: { sha256: known.sha256 }
  }), error => error.code === 'DUPLICATE_FILE');
  assert.equal(auditManifest(value).healthy, true);
});

test('catalog analysis fingerprints downloaded catalog URLs, not similarly numbered local files', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'analyze-course-content.py'), 'utf8').replace(/\r\n/g, '\n');
  const resolver = script.match(/def resolve_lesson_path[\s\S]*?\n\n/);
  assert.ok(resolver);
  assert.match(resolver[0], /download\(lesson\["url"\]/);
  assert.doesNotMatch(resolver[0], /source_root|local_course_folders|candidate/);
});
