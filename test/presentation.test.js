const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePresentationLesson, trustedBlobUrl } = require('../api/_lib/cms/presentation');

function manifest(url, type = 'pptx', pathname = 'cms/preview/test/assets/lesson.pptx') {
  return {
    courses: [{
      id: 'course-one',
      name: 'Curso',
      lessons: [{
        id: 'lesson-one',
        title: 'Presentación',
        type,
        url,
        downloadUrl: `${url}?download=1`,
        originalName: `presentacion.${type}`,
        pathname,
        managed: true
      }]
    }]
  };
}

test('presentation downloads come only from a catalog-owned public Blob asset and preview fails closed', () => {
  const asset = 'https://store.public.blob.vercel-storage.com/cms/preview/test/assets/lesson.pptx';
  const result = resolvePresentationLesson(manifest(asset), 'course-one', 'lesson-one', 'cms/preview/test');
  assert.equal(result.lesson.id, 'lesson-one');
  assert.equal(result.lesson.downloadUrl, `${asset}?download=1`);
  assert.equal(result.viewerAvailable, false);
  assert.equal('viewerUrl' in result, false);
});

test('forged, missing, and non-PowerPoint viewer requests are rejected', () => {
  const trusted = 'https://store.public.blob.vercel-storage.com/cms/production/assets/lesson.pptx';
  assert.throws(() => resolvePresentationLesson(manifest('https://attacker.invalid/lesson.pptx'), 'course-one', 'lesson-one', 'cms/preview/test'), error => error.code === 'UNTRUSTED_PRESENTATION');
  assert.throws(() => resolvePresentationLesson(manifest(trusted), 'course-one', 'missing', 'cms/production'), error => error.code === 'LESSON_NOT_FOUND');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, 'pdf', 'cms/production/assets/lesson.pptx'), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'NOT_A_PRESENTATION');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, 'pptx', 'cms/preview/test/assets/lesson.pptx'), 'course-one', 'lesson-one', 'cms/preview/test'), error => error.code === 'UNTRUSTED_PRESENTATION');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, 'pptx', 'cms/production/assets/other.pptx'), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'UNTRUSTED_PRESENTATION');
  const unmanaged = manifest(trusted, 'pptx', 'cms/production/assets/lesson.pptx');
  unmanaged.courses[0].lessons[0].managed = false;
  assert.throws(() => resolvePresentationLesson(unmanaged, 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'UNTRUSTED_PRESENTATION');
  assert.throws(() => trustedBlobUrl('https://store.public.blob.vercel-storage.com.attacker.invalid/lesson.pptx'), error => error.code === 'UNTRUSTED_PRESENTATION');
});

test('CSP allows required upload origins and blocks presentation frames', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const csp = config.headers.flatMap(rule => rule.headers || []).find(header => header.key === 'Content-Security-Policy').value;
  assert.match(csp, /connect-src [^;]*https:\/\/vercel\.com(?:[ ;])/);
  assert.match(csp, /frame-src 'none';/);
  assert.doesNotMatch(csp, /connect-src [^;]*https:\/\/\*(?:[ ;])/);
  assert.doesNotMatch(csp, /frame-src [^;]*https:\/\/\*(?:[ ;])/);
});
