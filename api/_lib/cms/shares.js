const crypto = require('node:crypto');
const { BlobNotFoundError, head, put } = require('@vercel/blob');
const { CmsError } = require('./core');
const { namespace } = require('./storage');

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const PUBLIC_ORIGIN = 'https://cursosbiblicos.app';

function invalidSelection() {
  return new CmsError(400, 'INVALID_SHARE_SELECTION', 'Selecciona al menos una lección válida para compartir.');
}

function canonicalSelection(selection) {
  if (!Array.isArray(selection) || !selection.length || selection.length > 30) throw invalidSelection();
  const courses = new Set();
  let total = 0;
  const result = selection.map(entry => {
    if (!entry || typeof entry.courseId !== 'string' || !ID_PATTERN.test(entry.courseId) || courses.has(entry.courseId)) throw invalidSelection();
    if (!Array.isArray(entry.lessonIds) || !entry.lessonIds.length || entry.lessonIds.length > 60) throw invalidSelection();
    courses.add(entry.courseId);
    const lessons = new Set();
    for (const id of entry.lessonIds) {
      if (typeof id !== 'string' || !ID_PATTERN.test(id) || lessons.has(id)) throw invalidSelection();
      lessons.add(id);
    }
    total += lessons.size;
    if (total > 500) throw invalidSelection();
    return { courseId: entry.courseId, lessonIds: [...lessons].sort() };
  });
  return result.sort((a, b) => a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1 : 0);
}

function validateToken(value) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new CmsError(400, 'INVALID_SHARE', 'El enlace compartido no es válido.');
  }
  return value;
}

function shareTokenFromRequest(req) {
  const values = new URL(req.url || '/', PUBLIC_ORIGIN).searchParams.getAll('s');
  if (values.length > 1) validateToken(null);
  if (Object.prototype.hasOwnProperty.call(req.query || {}, 's')) {
    const token = validateToken(req.query.s);
    if (values.length && values[0] !== token) validateToken(null);
    return token;
  }
  return values.length ? validateToken(values[0]) : null;
}

function recordId(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

async function readShare(id, allowMissing = false) {
  validateToken(id);
  const pathname = `${namespace()}/shares/${id}.json`;
  let blob;
  try {
    blob = await head(pathname);
  } catch (error) {
    if (!(error instanceof BlobNotFoundError)) throw error;
    if (allowMissing) return null;
    throw new CmsError(404, 'SHARE_NOT_FOUND', 'El enlace compartido ya no está disponible.');
  }
  if (blob.pathname !== pathname) throw new CmsError(410, 'INVALID_SHARE_RECORD', 'El enlace compartido ya no está disponible.');
  const response = await fetch(blob.url, { cache: 'no-store' });
  if (!response.ok) throw new CmsError(404, 'SHARE_NOT_FOUND', 'El enlace compartido ya no está disponible.');
  let record;
  try {
    record = await response.json();
    const canonical = { schemaVersion: 1, selection: canonicalSelection(record?.selection) };
    if (record?.schemaVersion !== 1 || JSON.stringify(record) !== JSON.stringify(canonical) || recordId(canonical) !== id) throw invalidSelection();
  } catch {
    throw new CmsError(410, 'INVALID_SHARE_RECORD', 'El enlace compartido ya no está disponible.');
  }
  return record;
}

function assertCurrentSelection(manifest, selection) {
  for (const entry of selection) {
    const course = manifest.courses.find(item => item.id === entry.courseId);
    if (!course || entry.lessonIds.some(id => !course.lessons.some(lesson => lesson.id === id))) {
      throw new CmsError(404, 'SHARE_SELECTION_NOT_FOUND', 'Una lección seleccionada ya no está disponible. Recarga el catálogo.');
    }
  }
}

async function createShare(manifest, input) {
  const selection = canonicalSelection(input?.selection);
  assertCurrentSelection(manifest, selection);
  if (input.parentToken !== undefined) {
    const parent = await readShare(input.parentToken);
    for (const entry of selection) {
      const allowed = parent.selection.find(item => item.courseId === entry.courseId);
      if (!allowed || entry.lessonIds.some(id => !allowed.lessonIds.includes(id))) {
        throw new CmsError(403, 'SHARE_SELECTION_DENIED', 'Solo puedes compartir lecciones incluidas en este enlace.');
      }
    }
  }
  const record = { schemaVersion: 1, selection };
  const id = recordId(record);
  if (!await readShare(id, true)) {
    try {
      await put(`${namespace()}/shares/${id}.json`, JSON.stringify(record), {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: 'application/json',
        cacheControlMaxAge: 31536000
      });
    } catch (error) {
      if (!await readShare(id, true)) throw error;
    }
  }
  return {
    id,
    url: `${PUBLIC_ORIGIN}/index.html?s=${id}`,
    lessonCount: selection.reduce((sum, entry) => sum + entry.lessonIds.length, 0),
    courseCount: selection.length
  };
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

function filterSharedManifest(manifest, record) {
  const courses = [];
  for (const course of manifest.courses) {
    const selected = record.selection.find(entry => entry.courseId === course.id);
    if (!selected) continue;
    const lessons = course.lessons.map((lesson, index) => ({ ...lesson, lessonNumber: index + 1 }))
      .filter(lesson => selected.lessonIds.includes(lesson.id)).map(lesson => pick(lesson, [
      'id', 'legacyNumber', 'lessonNumber', 'title', 'type', 'url', 'downloadUrl', 'originalName', 'pathname', 'size', 'managed',
      'sha256', 'contentHash', 'contentCharacters', 'conversionStatus', 'sourceType', 'sourceUrl',
      'sourceDownloadUrl', 'sourceOriginalName', 'sourcePathname', 'sourceSize', 'sourceSha256'
    ]));
    if (!lessons.length) continue;
    courses.push({ ...pick(course, ['id', 'name', 'short', 'color', 'section', 'source', 'managed', 'coverUrl']), lessons });
  }
  if (!courses.length) throw new CmsError(410, 'SHARE_UNAVAILABLE', 'Las lecciones de este enlace ya no están disponibles.');
  return {
    ...pick(manifest, ['schemaVersion', 'revision', 'createdAt', 'updatedAt', 'appName', 'appSubtitle']),
    courses
  };
}

async function restrictManifest(req, manifest) {
  const id = shareTokenFromRequest(req);
  return id ? filterSharedManifest(manifest, await readShare(id)) : manifest;
}

module.exports = { canonicalSelection, createShare, filterSharedManifest, readShare, restrictManifest, shareTokenFromRequest };
