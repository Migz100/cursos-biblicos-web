const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CmsError,
  applyMutation,
  assertRevision,
  buildStarterManifest,
  fileInfo,
  manifestReferencesPath,
  namespaceFromEnv,
  totalLessons
} = require('../api/_lib/cms/core');

function asset(name = 'leccion.pdf') {
  return {
    validated: true,
    type: 'pdf',
    url: `https://example.test/${name}`,
    downloadUrl: `https://example.test/${name}?download=1`,
    originalName: name,
    pathname: `cms/preview/test/assets/${name}`,
    size: 100,
    managed: true
  };
}

test('starter manifest preserves every bundled course and lesson', () => {
  const manifest = buildStarterManifest();
  assert.equal(manifest.courses.length, 13);
  assert.equal(totalLessons(manifest), 185);
  assert.equal(manifest.courses[12].name, 'La Fe de Jesús (PowerPoint)');
  assert.equal(manifest.courses[12].lessons[0].title, 'Cómo es Dios');
  assert.equal(manifest.courses[0].lessons[0].managed, false);
});

test('file metadata accepts only bounded supported lesson formats', () => {
  assert.equal(fileInfo('01 La fe.pptx', '', 1024).extension, 'pptx');
  assert.equal(fileInfo('Clase.PDF', 'application/pdf', 50).contentType, 'application/pdf');
  assert.throws(() => fileInfo('virus.exe', '', 20), error => error.code === 'INVALID_FILE_TYPE');
  assert.throws(() => fileInfo('grande.pdf', 'application/pdf', 26 * 1024 * 1024), error => error.code === 'INVALID_FILE_SIZE');
  assert.throws(() => fileInfo('falso.pdf', 'image/png', 20), error => error.code === 'INVALID_FILE_TYPE');
});

test('course removal is confirmed, soft, and reversible', () => {
  const original = buildStarterManifest();
  assert.throws(
    () => applyMutation(original, { type: 'course.remove', courseId: '1', confirmText: 'otro' }),
    error => error.code === 'CONFIRMATION_REQUIRED'
  );
  const removed = applyMutation(original, { type: 'course.remove', courseId: '1', confirmText: 'Fe de Jesús' });
  assert.equal(removed.manifest.courses.length, 12);
  assert.equal(removed.manifest.trash[0].item.lessons.length, 20);
  assert.equal(original.courses.length, 13);
  const restored = applyMutation(removed.manifest, { type: 'course.restore', trashId: removed.undoTrashId });
  assert.equal(restored.manifest.courses[0].name, 'Fe de Jesús');
  assert.equal(restored.manifest.trash.length, 0);
});

test('course and lesson edits preserve ordering and replacement recovery', () => {
  let manifest = applyMutation(buildStarterManifest(), {
    type: 'course.add', name: 'Curso Temporal', short: 'CT', color: '#123456', section: 'cursos'
  }).manifest;
  const course = manifest.courses.at(-1);
  manifest = applyMutation(manifest, { type: 'lesson.add', courseId: course.id, title: 'Primera', asset: asset('one.pdf') }).manifest;
  manifest = applyMutation(manifest, { type: 'lesson.add', courseId: course.id, title: 'Segunda', asset: asset('two.pdf') }).manifest;
  const current = manifest.courses.find(item => item.id === course.id);
  const second = current.lessons[1];
  manifest = applyMutation(manifest, { type: 'lesson.move', courseId: course.id, lessonId: second.id, toIndex: 0 }).manifest;
  assert.equal(manifest.courses.find(item => item.id === course.id).lessons[0].title, 'Segunda');
  manifest = applyMutation(manifest, { type: 'lesson.replace', courseId: course.id, lessonId: second.id, asset: asset('replacement.pdf') }).manifest;
  const replacementTrash = manifest.trash.find(item => item.kind === 'replaced_asset');
  assert.equal(replacementTrash.item.originalName, 'two.pdf');
  manifest = applyMutation(manifest, { type: 'asset.restore', trashId: replacementTrash.id }).manifest;
  assert.equal(manifest.courses.find(item => item.id === course.id).lessons[0].originalName, 'two.pdf');
});

test('whole-course import creates all lessons atomically', () => {
  const original = buildStarterManifest();
  const result = applyMutation(original, {
    type: 'course.add',
    name: 'Importado',
    short: 'IM',
    color: '#334455',
    section: 'lafe',
    lessons: [
      { title: 'Uno', asset: asset('uno.pptx') },
      { title: 'Dos', asset: asset('dos.pptx') }
    ]
  });
  assert.equal(result.manifest.courses.at(-1).lessons.length, 2);
  assert.equal(original.courses.length, 13);
});

test('whole-course lesson replacement is atomic and preserves every other course', () => {
  const original = buildStarterManifest();
  const untouched = JSON.stringify(original.courses.slice(1));
  const result = applyMutation(original, {
    type: 'course.replaceLessons',
    courseId: '1',
    confirmText: 'Fe de Jesús',
    lessons: [
      { title: 'Primera nueva', asset: asset('nueva-uno.pdf') },
      { title: 'Segunda nueva', asset: asset('nueva-dos.pdf') }
    ]
  });
  const course = result.manifest.courses[0];
  assert.equal(course.name, 'Fe de Jesús');
  assert.deepEqual(course.lessons.map(item => item.title), ['Primera nueva', 'Segunda nueva']);
  assert.equal(course.lessons[0].id, original.courses[0].lessons[0].id);
  assert.equal(course.lessons[0].legacyNumber, original.courses[0].lessons[0].legacyNumber);
  assert.equal(JSON.stringify(result.manifest.courses.slice(1)), untouched);
  assert.equal(result.manifest.trash.length, 0);
  assert.equal(original.courses[0].lessons.length, 20);
  assert.throws(() => applyMutation(original, {
    type: 'course.replaceLessons', courseId: '1', confirmText: 'otro', lessons: [{ title: 'Uno', asset: asset() }]
  }), error => error.code === 'CONFIRMATION_REQUIRED');
});

test('lesson removal cannot affect unrelated lessons or assets', () => {
  const original = buildStarterManifest();
  const course = original.courses[0];
  const target = course.lessons[0];
  const unrelatedUrl = course.lessons[1].url;
  const result = applyMutation(original, {
    type: 'lesson.remove', courseId: course.id, lessonId: target.id, confirmText: target.title
  });
  const changedCourse = result.manifest.courses[0];
  assert.equal(changedCourse.lessons.length, course.lessons.length - 1);
  assert.equal(changedCourse.lessons[0].url, unrelatedUrl);
  assert.equal(result.manifest.trash[0].item.url, target.url);
});

test('asset cleanup sees active and trashed references but not unrelated paths', () => {
  const original = buildStarterManifest();
  let manifest = applyMutation(original, {
    type: 'course.add', name: 'Temporal', short: 'TMP', color: '#123456', section: 'cursos',
    lessons: [{ title: 'Uno', asset: asset('cleanup.pdf') }]
  }).manifest;
  const course = manifest.courses.at(-1);
  assert.equal(manifestReferencesPath(manifest, course.lessons[0].pathname), true);
  manifest = applyMutation(manifest, { type: 'course.remove', courseId: course.id, confirmText: course.name }).manifest;
  assert.equal(manifestReferencesPath(manifest, course.lessons[0].pathname), true);
  assert.equal(manifestReferencesPath(manifest, 'cms/preview/test/assets/unrelated.pdf'), false);
});

test('revision conflicts are explicit', () => {
  assert.doesNotThrow(() => assertRevision('r1', 'r1'));
  assert.throws(() => assertRevision('r2', 'r1'), error => error instanceof CmsError && error.status === 409);
});

test('preview and production namespaces never overlap', () => {
  const production = namespaceFromEnv({ VERCEL_ENV: 'production' });
  const previewA = namespaceFromEnv({ VERCEL_ENV: 'preview', VERCEL_DEPLOYMENT_ID: 'dpl_A' });
  const previewB = namespaceFromEnv({ VERCEL_ENV: 'preview', VERCEL_DEPLOYMENT_ID: 'dpl_B' });
  assert.equal(production, 'cms/production');
  assert.notEqual(previewA, previewB);
  assert.equal(previewA.startsWith('cms/preview/'), true);
});
