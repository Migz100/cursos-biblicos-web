const { CmsError } = require('./core');
const knownContent = require('./known-content.json');

function cleanUrl(value) {
  try {
    const url = new URL(value, 'https://local.invalid');
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || '').split('?')[0];
  }
}

function lessonLabel(record) {
  return `“${record.title}” en ${record.courseName}`;
}

function knownRecord(course, lesson) {
  const url = cleanUrl(lesson.url);
  return knownContent.documents.find(record =>
    String(record.courseId) === String(course.id) &&
    String(record.lessonId) === String(lesson.id) &&
    cleanUrl(record.url) === url
  );
}

function catalogRecords(manifest) {
  return manifest.courses.flatMap(course => course.lessons.map(lesson => {
    const known = knownRecord(course, lesson) || {};
    return {
      courseId: course.id,
      courseName: course.name,
      lessonId: lesson.id,
      title: lesson.title,
      type: lesson.type,
      url: lesson.url,
      sha256: lesson.sha256 || known.sha256 || null,
      contentHash: lesson.contentHash || known.contentHash || null,
      contentCharacters: lesson.contentCharacters || known.contentCharacters || 0,
      pages: known.pages || null,
      originalName: lesson.originalName,
      conversionStatus: lesson.conversionStatus || null,
      sourceType: lesson.sourceType || null
    };
  }));
}

function incomingRecords(action) {
  if (action.type === 'lesson.add' || action.type === 'lesson.replace') {
    return action.asset ? [{ title: action.title || 'Archivo nuevo', ...action.asset }] : [];
  }
  if (action.type === 'course.add' || action.type === 'course.replaceLessons') {
    return (action.lessons || []).map(item => ({ title: item.title, ...item.asset }));
  }
  return [];
}

function assertUniqueContent(manifest, action) {
  const incoming = incomingRecords(action);
  if (!incoming.length) return;
  let existing = catalogRecords(manifest);
  if (action.type === 'lesson.replace') {
    existing = existing.filter(record => !(String(record.courseId) === String(action.courseId) && String(record.lessonId) === String(action.lessonId)));
  }
  if (action.type === 'course.replaceLessons') {
    existing = existing.filter(record => String(record.courseId) !== String(action.courseId));
  }
  const checked = [...existing];
  for (const asset of incoming) {
    const duplicate = checked.find(record =>
      (asset.sha256 && record.sha256 === asset.sha256) ||
      (asset.contentHash && record.contentHash === asset.contentHash)
    );
    if (duplicate) {
      const exact = asset.sha256 && duplicate.sha256 === asset.sha256;
      throw new CmsError(
        409,
        exact ? 'DUPLICATE_FILE' : 'DUPLICATE_CONTENT',
        exact
          ? `Ese mismo archivo ya existe como ${lessonLabel(duplicate)}.`
          : `Este archivo tiene el mismo contenido que ${lessonLabel(duplicate)}.`
      );
    }
    checked.push({
      courseName: action.name || 'el curso nuevo',
      title: asset.title || 'Archivo nuevo',
      sha256: asset.sha256 || null,
      contentHash: asset.contentHash || null
    });
  }
}

function numericOrder(lesson) {
  const values = [lesson.legacyNumber, lesson.originalName, lesson.title];
  for (const value of values) {
    const match = String(value || '').match(/(?:^|lecci[oó]n\s*)(\d{1,3})(?:\D|$)/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function duplicateGroups(records, field, kind) {
  const groups = new Map();
  for (const record of records) {
    if (!record[field]) continue;
    const list = groups.get(record[field]) || [];
    list.push(record);
    groups.set(record[field], list);
  }
  return [...groups.values()]
    .filter(items => items.length > 1)
    .map(items => ({ kind, lessons: items.map(item => ({
      courseId: item.courseId,
      courseName: item.courseName,
      lessonId: item.lessonId,
      title: item.title
    })) }));
}

function auditManifest(manifest) {
  const records = catalogRecords(manifest);
  const exact = duplicateGroups(records, 'sha256', 'exact');
  const exactKeys = new Set(exact.flatMap(group => group.lessons.map(item => `${item.courseId}|${item.lessonId}`)));
  const content = duplicateGroups(records, 'contentHash', 'content')
    .filter(group => !group.lessons.every(item => exactKeys.has(`${item.courseId}|${item.lessonId}`)));
  const ordering = [];
  for (const course of manifest.courses) {
    const numbered = course.lessons.map((lesson, index) => ({ lesson, index, number: numericOrder(lesson) }));
    const comparable = numbered.filter(item => item.number !== null);
    if (comparable.length < 2) continue;
    const sorted = [...comparable].sort((a, b) => a.number - b.number || a.index - b.index);
    const wrong = comparable.some((item, index) => item.lesson.id !== sorted[index].lesson.id);
    if (wrong) {
      ordering.push({
        courseId: course.id,
        courseName: course.name,
        current: comparable.map(item => item.number),
        suggested: sorted.map(item => item.number),
        suggestedLessonIds: [
          ...sorted.map(item => item.lesson.id),
          ...numbered.filter(item => item.number === null).map(item => item.lesson.id)
        ]
      });
    }
  }
  const pagesPending = records.filter(record => record.type === 'pages' || record.conversionStatus === 'needs-pdf');
  const fingerprinted = records.filter(record => record.sha256).length;
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      courses: manifest.courses.length,
      lessons: records.length,
      pdfs: records.filter(record => record.type === 'pdf').length,
      presentations: records.filter(record => ['ppt', 'pptx', 'ppsx'].includes(record.type)).length,
      pagesFiles: records.filter(record => record.type === 'pages' || record.sourceType === 'pages').length,
      fingerprinted,
      covers: manifest.courses.filter(course => course.coverUrl).length
    },
    duplicates: [...exact, ...content],
    ordering,
    pagesPending: pagesPending.map(record => ({
      courseId: record.courseId,
      courseName: record.courseName,
      lessonId: record.lessonId,
      title: record.title
    })),
    healthy: exact.length === 0 && content.length === 0 && ordering.length === 0 && pagesPending.length === 0,
    baselineGeneratedAt: knownContent.generatedAt
  };
}

module.exports = { assertUniqueContent, auditManifest, catalogRecords, numericOrder };
