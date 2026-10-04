const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { applyContentRevisions, CONTENT_REVISION_VERSION } = require('../api/_lib/cms/content-revisions');
const { courseCoverEtag } = require('../api/_lib/cms/course-covers');

const origin = 'https://s0anajbi1aoffqbv.public.blob.vercel-storage.com';
const revised = `${origin}/revisions-20260926-salvacion`;
const originalLesson = `${origin}/la-fe-de-jesus-v2/Leccion%2007-WDj950nBdSkHchQxIWopEwmjQR6WTw.pdf`;
const originalCourseZip = `${origin}/zips/la-fe-de-jesus-pdf-v2-DPMiim56x6AHXL9kL70RoanqNcLDaY.zip`;
const originalPptZip = `${origin}/zips/la-fe-de-jesus-ppt-LPBj4PmBn0VD4wvGLu7EliGareM63a.zip`;
const originalCatalogZip = `${origin}/todos/cursos-biblicos-todos-v3-U903kzUWNQvcMirvxw5xMYG8waXDop.zip`;

function fixture() {
  const lesson = { id: '13-07', legacyNumber: '07', title: 'La salvación', type: 'pdf', url: originalLesson,
    downloadUrl: `${originalLesson}?download=1`, originalName: 'La Fe de Jesús (PowerPoint) - Lección 7.pdf', managed: false };
  return {
    revision: 'manifest-before', zip: originalCatalogZip, zipKind: 'starter',
    courses: [
      { id: '13', name: 'La Fe de Jesús (PowerPoint)', zip: originalCourseZip, pptZip: originalPptZip, zipKind: 'starter',
        lessons: [lesson, { ...lesson, id: '13-08', title: 'Otra lección' }] },
      { id: '14', name: 'Otro curso', zip: originalCourseZip, pptZip: originalPptZip, lessons: [{ ...lesson }] },
    ],
  };
}

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

function courseById(manifest, id) {
  return manifest.courses.find(course => course.id === id);
}

test('content revision changes only the targeted PDF and original archives without mutating the manifest', () => {
  const original = freeze(fixture());
  const before = structuredClone(original);
  const result = applyContentRevisions(original);
  assert.deepEqual(original, before);
  assert.equal(result.zip, undefined);
  assert.equal(courseById(result, '13').zip, `${origin}/revisions-20260927-la-fe/la-fe-de-jesus-pdf.zip`);
  assert.equal(courseById(result, '13').pptZip, `${origin}/revisions-20260927-la-fe/la-fe-de-jesus-ppt.zip`);
  assert.equal(courseById(result, '13').pptZipKind, 'current');
  assert.deepEqual(courseById(result, '13').lessons[0], {
    ...before.courses[0].lessons[0], url: `${revised}/leccion-07.pdf`, downloadUrl: `${revised}/leccion-07.pdf?download=1`,
  });
  assert.deepEqual(courseById(result, '13').lessons[1], before.courses[0].lessons[1]);
  assert.deepEqual(courseById(result, '14'), courseById(before, '14'));
  assert.equal(result.revision, before.revision);
  assert.equal(result.zipKind, undefined);
});

test('future CMS lesson replacements and changed lesson identities remain authoritative', () => {
  for (const replacement of [
    { url: 'https://files.example/new-cms-lesson.pdf', downloadUrl: 'https://files.example/new-cms-lesson.pdf?download=1' },
    { url: `${originalLesson}?updated=1` },
    { id: 'cms-new-lesson-id' },
  ]) {
    const manifest = fixture();
    Object.assign(manifest.courses[0].lessons[0], replacement);
    assert.deepEqual(courseById(applyContentRevisions(manifest), '13').lessons[0], manifest.courses[0].lessons[0]);
  }
});

test('each archive replacement requires its exact original URL and never adds missing archives', () => {
  for (const value of [undefined, null, 'https://files.example/new-cms-archive.zip']) {
    for (const target of ['pdf', 'ppt']) {
      const manifest = fixture();
      if (target === 'pdf') manifest.courses[0].zip = value;
      if (target === 'ppt') manifest.courses[0].pptZip = value;
      const result = applyContentRevisions(manifest);
      assert.equal(result.zip, undefined);
      assert.equal(courseById(result, '13').zip, target === 'pdf' ? value : `${origin}/revisions-20260927-la-fe/la-fe-de-jesus-pdf.zip`);
      assert.equal(courseById(result, '13').pptZip, target === 'ppt' ? value : `${origin}/revisions-20260927-la-fe/la-fe-de-jesus-ppt.zip`);
    }
  }
  const manifest = fixture();
  delete manifest.zip;
  delete manifest.courses[0].zip;
  delete manifest.courses[0].pptZip;
  const result = applyContentRevisions(manifest);
  assert.equal(Object.hasOwn(result, 'zip'), false);
  assert.equal(Object.hasOwn(courseById(result, '13'), 'zip'), false);
  assert.equal(Object.hasOwn(courseById(result, '13'), 'pptZip'), false);
});

function loadModule(relativePath, overrides) {
  const filename = path.join(__dirname, '..', relativePath);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name), module, URL,
  }, { filename });
  return module.exports;
}

const { filterSharedManifest, shareTokenFromRequest } = loadModule('api/_lib/cms/shares.js', {
  '@vercel/blob': {}, './storage': { namespace: () => 'test' },
});

async function requestCatalog(manifest, selection) {
  let beforeRestriction;
  const handler = loadModule('api/catalog.js', {
    './_lib/cms/storage': { loadManifest: async () => manifest },
    './_lib/cms/shares': {
      shareTokenFromRequest,
      restrictManifest: async (req, input) => {
        beforeRestriction = input;
        return selection ? filterSharedManifest(input, { selection }) : input;
      },
    },
  });
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ method: 'GET', url: selection ? `/api/catalog?s=${'ab'.repeat(32)}` : '/api/catalog', query: {} }, res);
  return { ...res, beforeRestriction };
}

test('public catalog versions the content ETag while retaining the cover version', async () => {
  const result = await requestCatalog(freeze(fixture()));
  assert.equal(result.code, 200);
  assert.equal(courseById(result.body, '13').lessons[0].url, `${revised}/leccion-07.pdf`);
  assert.notEqual(result.headers.ETag, courseCoverEtag('manifest-before'));
  assert.equal(result.headers.ETag, courseCoverEtag(`manifest-before-${CONTENT_REVISION_VERSION}`));
  assert.match(result.headers.ETag, /course-covers-v1/);
});

test('catalog applies content revisions before sharing restrictions and does not expose full archives', async () => {
  const original = freeze(fixture());
  const result = await requestCatalog(original, [{ courseId: '13', lessonIds: ['13-07'] }]);
  assert.equal(result.code, 200);
  assert.equal(courseById(result.beforeRestriction, '13').lessons[0].url, `${revised}/leccion-07.pdf`);
  assert.equal(courseById(result.beforeRestriction, '13').zip, `${origin}/revisions-20260927-la-fe/la-fe-de-jesus-pdf.zip`);
  assert.equal(result.body.courses.length, 1);
  assert.equal(result.body.courses[0].lessons.length, 1);
  assert.equal(result.body.courses[0].lessons[0].id, '13-07');
  assert.equal(result.body.courses[0].lessons[0].url, `${revised}/leccion-07.pdf`);
  assert.equal(result.body.courses[0].lessons[0].downloadUrl, `${revised}/leccion-07.pdf?download=1`);
  assert.equal(Object.hasOwn(result.body, 'zip'), false);
  assert.equal(Object.hasOwn(result.body.courses[0], 'zip'), false);
  assert.equal(Object.hasOwn(result.body.courses[0], 'pptZip'), false);
  assert.match(result.headers['Cache-Control'], /no-store/);
  assert.equal(result.headers.ETag, undefined);
  assert.equal(original.courses[0].lessons[0].url, originalLesson);
});

test('La Fe de Jesús lessons 1, 4, 6, 8 and 10 open the corrected same-origin PDFs', () => {
  const lessons = {
    '13-01': 'Leccion%2001-00qk3wEIQyab3IwBwKk8o9W3FqW1nC.pdf',
    '13-04': 'Leccion%2004-kYKINirKnAgTyVm1aG8DXAce1KA3Y7.pdf',
    '13-06': 'Leccion%2006-q31jTw4h5UaML2adD7bUnBqszJadS7.pdf',
    '13-08': 'Leccion%2008-CuTqluyNrNlRusQSBNEjMo4JqSOrLg.pdf',
    '13-10': 'Leccion%2010-yY2f7T6kyeXHr7YiQFm3ZCI0Y42Ea4.pdf',
  };
  const manifest = fixture();
  manifest.courses[0].lessons = Object.entries(lessons).map(([id, file]) => ({
    id, title: id, type: 'pdf', url: `${origin}/la-fe-de-jesus-v2/${file}`, downloadUrl: `${origin}/la-fe-de-jesus-v2/${file}?download=1`,
  }));
  const fields = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'answer-fields.json'), 'utf8')).documents;
  for (const lesson of courseById(applyContentRevisions(manifest), '13').lessons) {
    const url = `/assets/revisions/la-fe-de-jesus/leccion-${lesson.id.slice(3)}.pdf`;
    assert.equal(lesson.url, url);
    assert.equal(lesson.downloadUrl, url);
    assert.ok(fs.existsSync(path.join(__dirname, '..', url)));
    assert.equal(fields[`13|${lesson.id}`].url, url);
  }
  assert.deepEqual(courseById(applyContentRevisions(fixture()), '14'), courseById(fixture(), '14'));
});
