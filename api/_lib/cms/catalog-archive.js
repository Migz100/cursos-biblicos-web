const { createHash } = require('node:crypto');

const ORIGINAL_CATALOG_ZIP = 'https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/todos/cursos-biblicos-todos-v3-U903kzUWNQvcMirvxw5xMYG8waXDop.zip';

function originalSources(lesson) {
  const candidates = [
    ...['sourceUrl', 'originalUrl', 'originalDownloadUrl', 'sourceDownloadUrl'].map(field => [field, lesson[field]]),
    ...['source', 'original'].map(field => [field, lesson[field]?.url || lesson[field]?.downloadUrl]),
  ];
  return candidates.flatMap(([field, url]) => {
    try {
      return typeof url === 'string' && new URL(url).protocol === 'https:' ? [{ field, url }] : [];
    } catch (_) {
      return [];
    }
  });
}

function catalogFingerprint(manifest) {
  const courses = (manifest.courses || []).map(course => ({
    id: course.id,
    name: course.name,
    pptZip: course.pptZip || null,
    lessons: (course.lessons || []).map(lesson => ({
      id: lesson.id,
      title: lesson.title,
      url: lesson.url,
      type: lesson.type,
      originalSources: originalSources(lesson),
    })),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  return createHash('sha256').update(JSON.stringify(courses)).digest('hex');
}

function applyCatalogArchive(manifest, archive) {
  if (manifest.zip !== ORIGINAL_CATALOG_ZIP) return manifest;
  if (archive?.fingerprint === catalogFingerprint(manifest)) {
    return { ...manifest, zip: archive.url, zipKind: 'current' };
  }
  const { zip, zipKind, ...withoutArchive } = manifest;
  return withoutArchive;
}

module.exports = { catalogFingerprint, applyCatalogArchive };
