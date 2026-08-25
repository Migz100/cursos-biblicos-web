const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_COURSES = 30;
const MAX_LESSONS_PER_COURSE = 60;
const MAX_TOTAL_LESSONS = 500;
const MAX_TRASH = 100;
const MAX_HISTORY = 60;

const FILE_TYPES = Object.freeze({
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow'
});

class CmsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cleanText(value, max, field = 'texto') {
  if (typeof value !== 'string') throw new CmsError(400, 'INVALID_TEXT', `${field} no es válido.`);
  const text = value
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > max) throw new CmsError(400, 'INVALID_TEXT', `${field} no es válido.`);
  return text;
}

function cleanShort(value) {
  const text = cleanText(value, 5, 'Las iniciales').toLocaleUpperCase('es');
  if (!/^[\p{L}\p{N}]{1,5}$/u.test(text)) {
    throw new CmsError(400, 'INVALID_SHORT', 'Las iniciales solo pueden tener letras o números.');
  }
  return text;
}

function cleanColor(value) {
  const color = String(value || '').toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(color)) throw new CmsError(400, 'INVALID_COLOR', 'El color no es válido.');
  return color;
}

function cleanSection(value) {
  if (value !== 'cursos' && value !== 'lafe') {
    throw new CmsError(400, 'INVALID_SECTION', 'La sección no es válida.');
  }
  return value;
}

function fileInfo(filename, declaredType, declaredSize) {
  if (typeof filename !== 'string') throw new CmsError(400, 'INVALID_FILE', 'El archivo no es válido.');
  const base = path.basename(filename.normalize('NFC')).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  const match = base.match(/\.([A-Za-z0-9]+)$/);
  const extension = match ? match[1].toLowerCase() : '';
  const contentType = FILE_TYPES[extension];
  const size = Number(declaredSize);
  if (!contentType) throw new CmsError(400, 'INVALID_FILE_TYPE', 'Solo se aceptan archivos PDF, PPT, PPTX o PPSX.');
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
    throw new CmsError(400, 'INVALID_FILE_SIZE', 'El archivo debe pesar 25 MB o menos.');
  }
  if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== contentType) {
    throw new CmsError(400, 'INVALID_FILE_TYPE', 'El tipo del archivo no coincide con su extensión.');
  }
  const stem = base.slice(0, -(extension.length + 1));
  const safeStem = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'leccion';
  return {
    extension,
    contentType,
    size,
    originalName: cleanText(base, 140, 'El nombre del archivo'),
    safeName: `${safeStem}.${extension}`,
    suggestedTitle: cleanText(stem.replace(/^\s*\d+[\s._-]*/, ''), 100, 'El título')
  };
}

function namespaceFromEnv(env = process.env) {
  if (env.CMS_NAMESPACE_OVERRIDE) {
    const override = String(env.CMS_NAMESPACE_OVERRIDE).replace(/[^A-Za-z0-9._/-]/g, '').replace(/^\/+|\/+$/g, '');
    if (!override || override.includes('..')) throw new Error('Invalid CMS_NAMESPACE_OVERRIDE');
    return override;
  }
  if (env.VERCEL_ENV === 'production') return 'cms/production';
  if (env.VERCEL_ENV === 'preview') {
    const deployment = String(env.VERCEL_DEPLOYMENT_ID || env.VERCEL_URL || 'preview')
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '-')
      .slice(0, 120);
    return `cms/preview/${deployment}`;
  }
  return 'cms/development/local';
}

function buildStarterManifest(root) {
  const data = root
    ? JSON.parse(fs.readFileSync(path.join(root, 'data.json'), 'utf8'))
    : require('../../../data.json');
  const files = root
    ? JSON.parse(fs.readFileSync(path.join(root, 'pdfs.json'), 'utf8'))
    : require('../../../pdfs.json');
  const courses = data.courses.map(course => {
    const keys = Object.keys(files)
      .filter(key => key.startsWith(`${course.id}-`))
      .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
    const lessons = keys.map((key, index) => {
      const number = key.split('-')[1];
      return {
        id: key,
        legacyNumber: number,
        title: course.titles?.[index] || `Lección ${Number(number)}`,
        type: 'pdf',
        url: files[key],
        downloadUrl: `${files[key]}?download=1`,
        originalName: `${course.name} - Lección ${Number(number)}.pdf`,
        pathname: null,
        size: null,
        managed: false
      };
    });
    return {
      id: String(course.id),
      name: course.name,
      short: course.short,
      color: course.color,
      section: course.section || 'cursos',
      source: 'starter',
      managed: false,
      coverUrl: null,
      zip: course.zip || null,
      zipKind: course.zip ? 'starter' : null,
      pptZip: course.pptZip || null,
      lessons
    };
  });
  return {
    schemaVersion: 1,
    revision: 'starter-bundled-v1',
    createdAt: null,
    updatedAt: null,
    change: { type: 'starter', label: 'Catálogo original' },
    appName: data.appName,
    appSubtitle: data.appSubtitle,
    zip: data.zip || null,
    zipKind: data.zip ? 'starter' : null,
    courses,
    trash: []
  };
}

function totalLessons(manifest) {
  return manifest.courses.reduce((sum, course) => sum + course.lessons.length, 0);
}

function manifestReferencesPath(value, pathname) {
  if (!value || typeof value !== 'object') return false;
  if (value.pathname === pathname) return true;
  return Object.values(value).some(item => manifestReferencesPath(item, pathname));
}

function assertRevision(current, provided) {
  if (provided !== current) {
    throw new CmsError(409, 'REVISION_CONFLICT', 'Otra persona cambió el catálogo. Recarga la página para continuar.');
  }
}

function findCourse(manifest, id) {
  const course = manifest.courses.find(item => item.id === String(id));
  if (!course) throw new CmsError(404, 'COURSE_NOT_FOUND', 'El curso ya no existe.');
  return course;
}

function findLesson(course, id) {
  const lesson = course.lessons.find(item => item.id === String(id));
  if (!lesson) throw new CmsError(404, 'LESSON_NOT_FOUND', 'La lección ya no existe.');
  return lesson;
}

function moveItem(items, id, toIndex) {
  const from = items.findIndex(item => item.id === String(id));
  const target = Number(toIndex);
  if (from < 0 || !Number.isInteger(target) || target < 0 || target >= items.length) {
    throw new CmsError(400, 'INVALID_ORDER', 'El nuevo orden no es válido.');
  }
  const [item] = items.splice(from, 1);
  items.splice(target, 0, item);
}

function addTrash(manifest, entry) {
  if (manifest.trash.length >= MAX_TRASH) {
    throw new CmsError(409, 'TRASH_FULL', 'La papelera está llena. Restaura algo antes de quitar más contenido.');
  }
  manifest.trash.unshift({ id: `t_${crypto.randomUUID()}`, deletedAt: new Date().toISOString(), ...entry });
  return manifest.trash[0];
}

function requireAsset(asset) {
  if (!asset || typeof asset !== 'object' || !asset.validated) {
    throw new CmsError(400, 'INVALID_ASSET', 'El archivo no fue validado.');
  }
  if (!FILE_TYPES[asset.type] || !asset.url || !asset.downloadUrl || !asset.pathname) {
    throw new CmsError(400, 'INVALID_ASSET', 'El archivo no fue validado.');
  }
  return {
    type: asset.type,
    url: asset.url,
    downloadUrl: asset.downloadUrl,
    originalName: cleanText(asset.originalName, 140, 'El nombre del archivo'),
    pathname: asset.pathname,
    size: Number(asset.size),
    managed: true
  };
}

function applyMutation(input, action) {
  const manifest = structuredClone(input);
  let label = '';
  let undoTrashId = null;

  switch (action.type) {
    case 'course.add': {
      if (manifest.courses.length >= MAX_COURSES) throw new CmsError(409, 'COURSE_LIMIT', 'Ya se alcanzó el límite de cursos.');
      const requestedLessons = Array.isArray(action.lessons) ? action.lessons : [];
      if (requestedLessons.length > MAX_LESSONS_PER_COURSE || totalLessons(manifest) + requestedLessons.length > MAX_TOTAL_LESSONS) {
        throw new CmsError(409, 'LESSON_LIMIT', 'Ya se alcanzó el límite de lecciones.');
      }
      const name = cleanText(action.name, 80, 'El nombre del curso');
      const builtInCover = action.coverKey === 'lafe2' && name === 'La Fe de Jesús 2'
        ? '/assets/la-fe-de-jesus-2-cover.png'
        : null;
      const course = {
        id: `c_${crypto.randomUUID()}`,
        name,
        short: cleanShort(action.short),
        color: cleanColor(action.color),
        section: cleanSection(action.section),
        source: 'visitor',
        managed: true,
        coverUrl: builtInCover,
        zip: null,
        zipKind: null,
        pptZip: null,
        lessons: requestedLessons.map(item => ({
          id: `l_${crypto.randomUUID()}`,
          legacyNumber: null,
          title: cleanText(item.title, 100, 'El título de la lección'),
          ...requireAsset(item.asset)
        }))
      };
      manifest.courses.push(course);
      label = `Curso agregado: ${course.name}`;
      break;
    }
    case 'course.update': {
      const course = findCourse(manifest, action.courseId);
      course.name = cleanText(action.name, 80, 'El nombre del curso');
      course.short = cleanShort(action.short);
      course.color = cleanColor(action.color);
      course.section = cleanSection(action.section);
      label = `Curso editado: ${course.name}`;
      break;
    }
    case 'course.move': {
      const course = findCourse(manifest, action.courseId);
      moveItem(manifest.courses, course.id, action.toIndex);
      label = `Curso reordenado: ${course.name}`;
      break;
    }
    case 'course.replaceLessons': {
      const course = findCourse(manifest, action.courseId);
      if (action.confirmText !== course.name) {
        throw new CmsError(400, 'CONFIRMATION_REQUIRED', 'Escribe el nombre exacto del curso para reemplazar sus lecciones.');
      }
      const requestedLessons = Array.isArray(action.lessons) ? action.lessons : [];
      const nextTotal = totalLessons(manifest) - course.lessons.length + requestedLessons.length;
      if (!requestedLessons.length || requestedLessons.length > MAX_LESSONS_PER_COURSE || nextTotal > MAX_TOTAL_LESSONS) {
        throw new CmsError(409, 'LESSON_LIMIT', 'La cantidad de lecciones no es válida.');
      }
      const previousLessons = course.lessons;
      course.lessons = requestedLessons.map((item, index) => ({
        id: previousLessons[index]?.id || `l_${crypto.randomUUID()}`,
        legacyNumber: previousLessons[index]?.legacyNumber || null,
        title: cleanText(item.title, 100, 'El título de la lección'),
        ...requireAsset(item.asset)
      }));
      label = `Lecciones reemplazadas en ${course.name}`;
      break;
    }
    case 'course.remove': {
      const index = manifest.courses.findIndex(item => item.id === String(action.courseId));
      if (index < 0) throw new CmsError(404, 'COURSE_NOT_FOUND', 'El curso ya no existe.');
      const course = manifest.courses[index];
      if (action.confirmText !== course.name) throw new CmsError(400, 'CONFIRMATION_REQUIRED', 'Escribe el nombre exacto del curso para quitarlo.');
      manifest.courses.splice(index, 1);
      const trash = addTrash(manifest, { kind: 'course', index, item: course });
      undoTrashId = trash.id;
      label = `Curso enviado a la papelera: ${course.name}`;
      break;
    }
    case 'course.restore': {
      const trashIndex = manifest.trash.findIndex(item => item.id === String(action.trashId) && item.kind === 'course');
      if (trashIndex < 0) throw new CmsError(404, 'TRASH_NOT_FOUND', 'Ese curso ya no está en la papelera.');
      if (manifest.courses.length >= MAX_COURSES) throw new CmsError(409, 'COURSE_LIMIT', 'No hay espacio para restaurar este curso.');
      const entry = manifest.trash[trashIndex];
      if (totalLessons(manifest) + entry.item.lessons.length > MAX_TOTAL_LESSONS) {
        throw new CmsError(409, 'LESSON_LIMIT', 'No hay espacio para restaurar todas las lecciones de este curso.');
      }
      manifest.trash.splice(trashIndex, 1);
      const index = Math.max(0, Math.min(entry.index, manifest.courses.length));
      manifest.courses.splice(index, 0, entry.item);
      label = `Curso restaurado: ${entry.item.name}`;
      break;
    }
    case 'lesson.add': {
      const course = findCourse(manifest, action.courseId);
      if (course.lessons.length >= MAX_LESSONS_PER_COURSE || totalLessons(manifest) >= MAX_TOTAL_LESSONS) {
        throw new CmsError(409, 'LESSON_LIMIT', 'Ya se alcanzó el límite de lecciones.');
      }
      const asset = requireAsset(action.asset);
      const lesson = {
        id: `l_${crypto.randomUUID()}`,
        legacyNumber: null,
        title: cleanText(action.title, 100, 'El título de la lección'),
        ...asset
      };
      course.lessons.push(lesson);
      label = `Lección agregada en ${course.name}: ${lesson.title}`;
      break;
    }
    case 'lesson.rename': {
      const course = findCourse(manifest, action.courseId);
      const lesson = findLesson(course, action.lessonId);
      lesson.title = cleanText(action.title, 100, 'El título de la lección');
      label = `Lección renombrada en ${course.name}: ${lesson.title}`;
      break;
    }
    case 'lesson.move': {
      const course = findCourse(manifest, action.courseId);
      const lesson = findLesson(course, action.lessonId);
      moveItem(course.lessons, lesson.id, action.toIndex);
      label = `Lección reordenada en ${course.name}: ${lesson.title}`;
      break;
    }
    case 'lesson.replace': {
      const course = findCourse(manifest, action.courseId);
      const lesson = findLesson(course, action.lessonId);
      const previous = structuredClone(lesson);
      Object.assign(lesson, requireAsset(action.asset));
      addTrash(manifest, { kind: 'replaced_asset', courseId: course.id, lessonId: lesson.id, item: previous });
      label = `Archivo reemplazado en ${course.name}: ${lesson.title}`;
      break;
    }
    case 'lesson.remove': {
      const course = findCourse(manifest, action.courseId);
      const index = course.lessons.findIndex(item => item.id === String(action.lessonId));
      if (index < 0) throw new CmsError(404, 'LESSON_NOT_FOUND', 'La lección ya no existe.');
      const lesson = course.lessons[index];
      if (action.confirmText !== lesson.title) throw new CmsError(400, 'CONFIRMATION_REQUIRED', 'Escribe el título exacto de la lección para quitarla.');
      course.lessons.splice(index, 1);
      const trash = addTrash(manifest, { kind: 'lesson', courseId: course.id, index, item: lesson });
      undoTrashId = trash.id;
      label = `Lección enviada a la papelera: ${lesson.title}`;
      break;
    }
    case 'lesson.restore': {
      const trashIndex = manifest.trash.findIndex(item => item.id === String(action.trashId) && item.kind === 'lesson');
      if (trashIndex < 0) throw new CmsError(404, 'TRASH_NOT_FOUND', 'Esa lección ya no está en la papelera.');
      const entry = manifest.trash[trashIndex];
      const course = findCourse(manifest, entry.courseId);
      if (course.lessons.length >= MAX_LESSONS_PER_COURSE || totalLessons(manifest) >= MAX_TOTAL_LESSONS) {
        throw new CmsError(409, 'LESSON_LIMIT', 'No hay espacio para restaurar esta lección.');
      }
      manifest.trash.splice(trashIndex, 1);
      const index = Math.max(0, Math.min(entry.index, course.lessons.length));
      course.lessons.splice(index, 0, entry.item);
      label = `Lección restaurada en ${course.name}: ${entry.item.title}`;
      break;
    }
    case 'asset.restore': {
      const trashIndex = manifest.trash.findIndex(item => item.id === String(action.trashId) && item.kind === 'replaced_asset');
      if (trashIndex < 0) throw new CmsError(404, 'TRASH_NOT_FOUND', 'Ese archivo ya no está en la papelera.');
      const entry = manifest.trash[trashIndex];
      const course = findCourse(manifest, entry.courseId);
      const lesson = findLesson(course, entry.lessonId);
      const current = structuredClone(lesson);
      Object.assign(lesson, entry.item);
      manifest.trash.splice(trashIndex, 1);
      addTrash(manifest, { kind: 'replaced_asset', courseId: course.id, lessonId: lesson.id, item: current });
      label = `Archivo anterior restaurado: ${lesson.title}`;
      break;
    }
    default:
      throw new CmsError(400, 'INVALID_ACTION', 'La acción no es válida.');
  }

  return { manifest, label, undoTrashId };
}

module.exports = {
  CmsError,
  FILE_TYPES,
  MAX_FILE_BYTES,
  MAX_HISTORY,
  assertRevision,
  applyMutation,
  buildStarterManifest,
  cleanText,
  fileInfo,
  manifestReferencesPath,
  namespaceFromEnv,
  totalLessons
};
