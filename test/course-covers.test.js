const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_COURSE_COVERS,
  applyDefaultCourseCovers,
  courseCoverEtag,
} = require('../api/_lib/cms/course-covers');

test('all thirteen starter courses have an existing optimized cover asset', () => {
  assert.equal(Object.keys(DEFAULT_COURSE_COVERS).length, 13);
  for (let id = 1; id <= 13; id += 1) {
    const coverUrl = DEFAULT_COURSE_COVERS[String(id)];
    assert.match(coverUrl, /^\/assets\/course-covers\/[a-z0-9-]+\.webp$/);
    assert.equal(fs.existsSync(path.join(__dirname, '..', coverUrl)), true, `missing ${coverUrl}`);
  }
});

test('default covers fill blank starter covers without mutating the stored manifest', () => {
  const manifest = {
    revision: 'manifest-1',
    courses: [
      { id: '1', name: 'Fe de Jesús', coverUrl: null },
      { id: 'visitor', name: 'Visitante', coverUrl: null },
    ],
  };
  const catalog = applyDefaultCourseCovers(manifest);
  assert.equal(catalog.courses[0].coverUrl, DEFAULT_COURSE_COVERS['1']);
  assert.equal(catalog.courses[1].coverUrl, null);
  assert.equal(manifest.courses[0].coverUrl, null);
  assert.notEqual(catalog.courses[0], manifest.courses[0]);
});

test('administrator-uploaded covers always override bundled artwork', () => {
  const catalog = applyDefaultCourseCovers({
    courses: [{ id: '3', coverUrl: 'https://example.test/custom-cover.webp' }],
  });
  assert.equal(catalog.courses[0].coverUrl, 'https://example.test/custom-cover.webp');
});

test('cover release changes the catalog etag without changing the stored revision', () => {
  assert.equal(courseCoverEtag('manifest-1'), '"manifest-1-course-covers-v1"');
});
