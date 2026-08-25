const { CmsError } = require('./core');

const PRESENTATION_TYPES = new Set(['ppt', 'pptx', 'ppsx']);
const PUBLIC_BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;

function trustedBlobUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new CmsError(400, 'UNTRUSTED_PRESENTATION', 'La presentación no tiene una dirección válida.');
  }
  if (
    parsed.protocol !== 'https:' ||
    !PUBLIC_BLOB_HOST.test(parsed.hostname) ||
    parsed.username ||
    parsed.password
  ) {
    throw new CmsError(400, 'UNTRUSTED_PRESENTATION', 'La presentación no pertenece al catálogo público.');
  }
  parsed.hash = '';
  return parsed.href;
}

function officeViewerUrl(assetUrl) {
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(assetUrl)}`;
}

function catalogAssetUrl(value, pathname) {
  const trusted = trustedBlobUrl(value);
  let actualPath;
  try {
    actualPath = decodeURIComponent(new URL(trusted).pathname).replace(/^\/+/, '');
  } catch {
    throw new CmsError(400, 'UNTRUSTED_PRESENTATION', 'La presentación no pertenece al catálogo público.');
  }
  if (actualPath !== pathname) {
    throw new CmsError(400, 'UNTRUSTED_PRESENTATION', 'La presentación no pertenece al catálogo público.');
  }
  return trusted;
}

function resolvePresentationLesson(manifest, courseId, lessonId, expectedNamespace) {
  if (typeof courseId !== 'string' || typeof lessonId !== 'string' || courseId.length > 100 || lessonId.length > 100) {
    throw new CmsError(400, 'INVALID_PRESENTATION', 'La presentación solicitada no es válida.');
  }
  const course = manifest.courses.find(item => item.id === courseId);
  if (!course) throw new CmsError(404, 'COURSE_NOT_FOUND', 'El curso no existe.');
  const lesson = course.lessons.find(item => item.id === lessonId);
  if (!lesson) throw new CmsError(404, 'LESSON_NOT_FOUND', 'La lección no existe.');
  if (!PRESENTATION_TYPES.has(lesson.type)) {
    throw new CmsError(400, 'NOT_A_PRESENTATION', 'Esta lección no es una presentación de PowerPoint.');
  }
  if (
    typeof expectedNamespace !== 'string' ||
    !expectedNamespace ||
    !lesson.managed ||
    typeof lesson.pathname !== 'string' ||
    !lesson.pathname.startsWith(`${expectedNamespace}/assets/`)
  ) {
    throw new CmsError(400, 'UNTRUSTED_PRESENTATION', 'La presentación no pertenece a este catálogo.');
  }
  const assetUrl = catalogAssetUrl(lesson.url, lesson.pathname);
  const downloadUrl = catalogAssetUrl(lesson.downloadUrl || lesson.url, lesson.pathname);
  return {
    course: { id: course.id, name: course.name },
    lesson: {
      id: lesson.id,
      title: lesson.title,
      type: lesson.type,
      originalName: lesson.originalName,
      downloadUrl
    },
    viewerUrl: officeViewerUrl(assetUrl)
  };
}

module.exports = {
  PRESENTATION_TYPES,
  catalogAssetUrl,
  officeViewerUrl,
  resolvePresentationLesson,
  trustedBlobUrl
};
