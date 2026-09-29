const { CmsError } = require('./core');

const PRESENTATION_TYPES = new Set(['ppt', 'pptx', 'ppsx']);
const PUBLIC_BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_PRESENTATION_PAGES = 500;

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

function requireManagedAsset(asset, expectedNamespace, type, code = 'UNTRUSTED_PRESENTATION') {
  if (
    !asset ||
    typeof asset !== 'object' ||
    asset.type !== type ||
    asset.managed !== true ||
    typeof asset.pathname !== 'string' ||
    !asset.pathname.startsWith(`${expectedNamespace}/assets/`)
  ) {
    throw new CmsError(400, code, 'La presentación no pertenece a este catálogo.');
  }
  try {
    return {
      url: catalogAssetUrl(asset.url, asset.pathname),
      downloadUrl: catalogAssetUrl(asset.downloadUrl || asset.url, asset.pathname)
    };
  } catch (error) {
    if (code === 'UNTRUSTED_PRESENTATION') throw error;
    throw new CmsError(400, code, 'La presentación no tiene un PDF validado dentro de este catálogo.');
  }
}

function validatedDerivedPdf(lesson, expectedNamespace) {
  const pdf = lesson.derivedPdf;
  const pageCount = Number(pdf?.pageCount);
  const sourceSlideCount = Number(pdf?.sourceSlideCount);
  const size = Number(pdf?.size);
  if (
    !pdf ||
    pdf.validationStatus !== 'passed' ||
    pdf.generator !== 'libreoffice-offline' ||
    !SHA256.test(String(lesson.sha256 || '')) ||
    !SHA256.test(String(pdf.sourceSha256 || '')) ||
    !SHA256.test(String(pdf.sha256 || '')) ||
    lesson.sha256.toLowerCase() !== pdf.sourceSha256.toLowerCase() ||
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    pageCount > MAX_PRESENTATION_PAGES ||
    sourceSlideCount !== pageCount ||
    !Number.isSafeInteger(size) ||
    size < 1
  ) {
    throw new CmsError(409, 'PRESENTATION_PDF_NOT_VALIDATED', 'Esta presentación todavía no tiene un PDF validado.');
  }
  const urls = requireManagedAsset(pdf, expectedNamespace, 'pdf', 'PRESENTATION_PDF_NOT_VALIDATED');
  return { ...pdf, ...urls, pageCount, sourceSlideCount, size };
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
  if (typeof expectedNamespace !== 'string' || !expectedNamespace) {
    throw new CmsError(400, 'UNTRUSTED_PRESENTATION', 'La presentación no pertenece a este catálogo.');
  }
  const original = requireManagedAsset(lesson, expectedNamespace, lesson.type);
  const pdf = validatedDerivedPdf(lesson, expectedNamespace);
  return {
    course: { id: course.id, name: course.name },
    lesson: {
      id: lesson.id,
      title: lesson.title,
      type: lesson.type,
      originalName: lesson.originalName,
      downloadUrl: original.downloadUrl
    },
    pdfUrl: pdf.url,
    pageCount: pdf.pageCount
  };
}

module.exports = {
  MAX_PRESENTATION_PAGES,
  PRESENTATION_TYPES,
  catalogAssetUrl,
  resolvePresentationLesson,
  trustedBlobUrl,
  validatedDerivedPdf
};
