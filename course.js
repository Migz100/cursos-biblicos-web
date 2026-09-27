const t = (es, en) => globalThis.CourseUI?.t(es, en) || es;
const languageUpdates = [];
function localize(update) {
  languageUpdates.push(update);
  update();
}
window.addEventListener('course-language-change', () => languageUpdates.forEach(update => update()));

const pageParams = new URLSearchParams(location.search);
const courseId = document.body?.dataset?.courseId || pageParams.get('c') || '1';
const sharedView = pageParams.has('s');
const shareId = pageParams.getAll('s').length === 1 ? pageParams.get('s') : '';
const back = document.querySelector('nav .back');
back.href = sharedView ? `/index.html?s=${encodeURIComponent(shareId || '')}` : '/';

localize(() => {
  back.textContent = sharedView ? t('Selección', 'Selection') : t('Inicio', 'Home');
  document.getElementById('shareCourse').textContent = sharedView ? t('Compartir selección', 'Share selection') : t('Compartir curso', 'Share course');
});

if (sharedView) {
  document.getElementById('sharedNotice').hidden = false;
}

function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] }) && navigator.share) return navigator.share({ files: [file], title: name });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return Promise.resolve();
}

async function downloadUrl(url, name, button) {
  if (button.dataset.busy) return;
  button.dataset.busy = '1';
  const label = button.textContent;
  button.textContent = t('Preparando...', 'Preparing...');
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    await saveFile(await response.blob(), name);
  } catch (error) {
    if (error?.name !== 'AbortError') window.open(url, '_blank', 'noopener');
  } finally {
    button.textContent = label;
    delete button.dataset.busy;
    languageUpdates.forEach(update => update());
  }
}

function lessonRow(course, lesson, index) {
  const lessonNumber = sharedView && Number.isInteger(lesson.lessonNumber) && lesson.lessonNumber > 0 ? lesson.lessonNumber : index + 1;
  const lessonLabel = () => sharedView ? t(`Lección ${lessonNumber}`, `Lecture ${lessonNumber}`) : lesson.title;
  const row = document.createElement('div');
  row.className = 'row';
  const isPresentation = ['ppt', 'pptx', 'ppsx'].includes(lesson.type);
  const companion = window.LessonCompanions?.get(course.id, lesson);
  const readable = lesson.type === 'pdf' || Boolean(companion);
  const open = document.createElement('a');
  open.className = 'rowMain';
  open.href = readable
    ? `/leer.html?c=${encodeURIComponent(course.id)}&l=${encodeURIComponent(sharedView ? lesson.id : lesson.legacyNumber || lesson.id)}`
    : isPresentation
      ? `/presentacion.html?c=${encodeURIComponent(course.id)}&l=${encodeURIComponent(lesson.id)}`
      : lesson.downloadUrl || lesson.url;
  if (sharedView && (readable || isPresentation)) open.href += `&s=${encodeURIComponent(shareId || '')}`;
  if (!readable && !isPresentation) open.target = '_blank';

  const number = document.createElement('div');
  number.className = 'num';
  number.textContent = String(lessonNumber);
  const label = document.createElement('div');
  label.className = 'label';
  localize(() => { label.textContent = lessonLabel(); });
  const kind = document.createElement('span');
  kind.className = 'fileKind';
  kind.textContent = companion ? 'PDF + PPTX' : lesson.sourceType === 'pages'
    ? 'PDF + PAGES'
    : lesson.type === 'pages'
      ? 'PAGES'
      : lesson.type.toUpperCase();
  if (lesson.type === 'pages') {
    row.classList.add('needsPdf');
    localize(() => { open.title = t('Toca para abrir el archivo en Pages.', 'Tap to open this file in Pages.'); });
  }
  const button = document.createElement('button');
  button.className = 'dlRow';
  button.type = 'button';
  localize(() => {
    button.title = t('Descargar lección', 'Download lesson');
    button.setAttribute('aria-label', t(`Descargar ${lessonLabel()}`, `Download ${lessonLabel()}`));
    button.textContent = button.dataset.busy ? t('Preparando...', 'Preparing...') : t('Bajar', 'Download');
  });
  button.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    downloadUrl(lesson.downloadUrl || lesson.url, lesson.originalName || `${lesson.title}.${lesson.type}`, button);
  };
  open.append(number, label, kind);
  row.append(open, button);
  if (readable || isPresentation) {
    const share = document.createElement('button');
    share.className = 'dlRow shareRow';
    share.type = 'button';
    localize(() => {
      share.title = t('Compartir solo esta lección', 'Share only this lesson');
      share.setAttribute('aria-label', t(`Compartir ${lessonLabel()}`, `Share ${lessonLabel()}`));
      share.textContent = t('Compartir', 'Share');
    });
    share.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      window.CourseShare.shareSelection({
        selection: [{ courseId: course.id, lessonIds: [lesson.id] }],
        title: lessonLabel(),
        text: `${lessonLabel()} · ${course.name}`
      });
    };
    row.appendChild(share);
  }
  return row;
}

async function load() {
  const response = await fetch(sharedView ? `/api/catalog?s=${encodeURIComponent(shareId || '')}` : '/api/catalog');
  if (!response.ok) throw new Error('catalog');
  const data = await response.json();
  const course = data.courses.find(item => item.id === courseId);
  if (!course) {
    if (sharedView) throw new Error('shared course unavailable');
    location.href = '/';
    return;
  }
  document.title = `${course.name}: curso bíblico en español | Cursos Bíblicos`;
  document.getElementById('title').textContent = course.name;
  document.getElementById('courseTitle').textContent = course.name;
  localize(() => {
    const summary = document.getElementById('courseSummary');
    if (summary) summary.textContent = t(`Estudia ${course.name} en español con ${course.lessons.length} ${course.lessons.length === 1 ? 'lección' : 'lecciones'}. Lee los materiales en línea, descarga los archivos y comparte las lecciones que elijas.`, `Study ${course.name} in Spanish with ${course.lessons.length} ${course.lessons.length === 1 ? 'lesson' : 'lessons'}. Read online, download the materials and share the lessons you choose.`);
  });
  const shareButton = document.getElementById('shareCourse');
  shareButton.disabled = !course.lessons.length;
  shareButton.onclick = () => window.CourseShare.shareSelection({
    selection: [{ courseId: course.id, lessonIds: course.lessons.map(lesson => lesson.id) }],
    title: course.name,
    text: course.name
  });
  if (course.coverUrl) {
    const cover = document.getElementById('courseCover');
    cover.style.backgroundImage = `linear-gradient(90deg, rgba(255,255,255,0.06), rgba(255,255,255,0.06)), url("${course.coverUrl}")`;
    localize(() => cover.setAttribute('aria-label', t(`Portada de ${course.name}`, `Cover for ${course.name}`)));
    cover.hidden = false;
  }
  const download = document.getElementById('dlCourse');
  const archiveUrl = course.pptZip || course.zip;
  const currentArchive = course.pptZip ? course.pptZipKind === 'current' : course.zipKind === 'current';
  if (archiveUrl && !sharedView) {
    download.href = archiveUrl;
    localize(() => {
      download.textContent = download.dataset.busy ? t('Preparando...', 'Preparing...') : course.pptZip
        ? t('Descargar curso (PowerPoint)', 'Download course (PowerPoint)')
        : currentArchive
          ? t('Descargar curso (ZIP)', 'Download course (ZIP)')
          : t('Descargar versión inicial (ZIP)', 'Download initial version (ZIP)');
    });
    download.hidden = false;
    if (!currentArchive) document.getElementById('courseArchiveNote').hidden = false;
    download.onclick = event => {
      event.preventDefault();
      downloadUrl(archiveUrl, `${course.name}.zip`, download);
    };
  }
  const list = document.getElementById('list');
  list.replaceChildren();
  course.lessons.forEach((lesson, index) => list.appendChild(lessonRow(course, lesson, index)));
  if (!course.lessons.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    localize(() => { empty.textContent = t('Este curso todavía no tiene lecciones.', 'This course does not have any lessons yet.'); });
    list.appendChild(empty);
  }
}

load().catch(() => {
  const list = document.getElementById('list');
  localize(() => {
    list.textContent = sharedView
      ? t('Este curso no está incluido en el enlace compartido o ya no está disponible.', 'This course is not included in the shared link or is no longer available.')
      : t('No se pudo cargar el curso. Intenta recargar la página.', 'The course could not load. Try reloading the page.');
  });
});
