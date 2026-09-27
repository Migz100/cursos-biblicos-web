const t = (es, en) => globalThis.CourseUI?.t(es, en) || es;
const params = new URLSearchParams(location.search);
const sharedMode = params.has('s');
const shareId = params.getAll('s').length === 1 ? params.get('s') : '';
const courseId = params.get('c') || '';
const lessonId = params.get('l') || '';
const statusElement = document.getElementById('status');
const frame = document.getElementById('presentationFrame');
const fallback = document.getElementById('fallback');
let presentation = null;
let errorMessage = null;
let unavailableMessage = null;

function scopedUrl(path, values = {}) {
  const query = new URLSearchParams(values);
  if (sharedMode) query.set('s', shareId);
  return `${path}${query.toString() ? `?${query}` : ''}`;
}

function refreshLanguage() {
  const button = document.getElementById('download');
  button.textContent = button.dataset.busy ? t('Preparando...', 'Preparing...') : t('Descargar', 'Download');
  document.getElementById('back').textContent = sharedMode && !presentation ? t('Selección', 'Selection') : t('Curso', 'Course');
  if (unavailableMessage) {
    document.title = t('No disponible', 'Unavailable');
    document.getElementById('title').textContent = t('Presentación no disponible', 'Presentation unavailable');
  } else if (!presentation) {
    document.title = t('Presentación', 'Presentation');
    document.getElementById('title').textContent = t('Cargando presentación...', 'Loading presentation...');
  }
  if (errorMessage) {
    fallback.querySelector('strong').textContent = t(...errorMessage.message);
    fallback.querySelector('span').textContent = t(...errorMessage.detail);
  }
}

function showUnavailable(message = ['La presentación solicitada no está disponible.', 'The requested presentation is unavailable.']) {
  presentation = null;
  unavailableMessage = message;
  document.getElementById('download').disabled = true;
  document.getElementById('shareLesson').disabled = true;
  if (sharedMode) document.getElementById('back').href = scopedUrl('index.html');
  showError(message, sharedMode
    ? ['Vuelve a la selección compartida para elegir otro archivo.', 'Return to the shared selection to choose another file.']
    : ['Vuelve al curso para elegir otro archivo.', 'Return to the course to choose another file.']);
}

function showError(message, detail = ['Puedes descargar el archivo original para verlo completo.', 'You can download the original file to view it in full.']) {
  errorMessage = { message, detail };
  frame.hidden = true;
  statusElement.hidden = true;
  fallback.hidden = false;
  refreshLanguage();
}

async function downloadPresentation() {
  const button = document.getElementById('download');
  if (!presentation || button.dataset.busy) return;
  button.dataset.busy = '1';
  button.textContent = t('Preparando...', 'Preparing...');
  try {
    const response = await fetch(presentation.lesson.downloadUrl);
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    const file = new File([blob], presentation.lesson.originalName || `${presentation.lesson.title}.${presentation.lesson.type}`, { type: blob.type });
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: presentation.lesson.title });
    } else {
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
    }
  } catch (error) {
    if (error?.name !== 'AbortError') window.open(presentation.lesson.downloadUrl, '_blank', 'noopener');
  } finally {
    delete button.dataset.busy;
    refreshLanguage();
  }
}

async function load() {
  if (!courseId || !lessonId) {
    showUnavailable();
    return;
  }
  const response = await fetch(scopedUrl('/api/presentation', { c: courseId, l: lessonId }), { cache: 'no-store' });
  if (!response.ok) {
    showUnavailable();
    return;
  }
  presentation = await response.json();
  if (window.LessonCompanions?.get(presentation.course.id, presentation.lesson)) {
    const query = { c: presentation.course.id, l: presentation.lesson.id };
    if (!sharedMode && params.get('solo') === '1') query.solo = '1';
    location.replace(scopedUrl('leer.html', query));
    return;
  }
  document.title = `${presentation.lesson.title} · ${presentation.course.name}`;
  document.getElementById('title').textContent = presentation.lesson.title;
  document.getElementById('back').href = scopedUrl('curso.html', { c: presentation.course.id });
  document.getElementById('back').textContent = t('Curso', 'Course');
  document.getElementById('download').disabled = false;
  const shareButton = document.getElementById('shareLesson');
  shareButton.onclick = () => window.CourseShare.shareSelection({
    selection: [{ courseId: presentation.course.id, lessonIds: [presentation.lesson.id] }],
    title: presentation.lesson.title,
    text: `${presentation.lesson.title} · ${presentation.course.name}`
  });
  shareButton.disabled = false;
  showError(
    ['Vista previa desactivada para proteger el contenido.', 'Preview disabled to preserve the complete content.'],
    ['El visor en línea puede ocultar texto de estas presentaciones. Descarga el archivo original para verlo completo.', 'The online viewer may hide text in these presentations. Download the original file to view it in full.']
  );
}

document.getElementById('download').onclick = downloadPresentation;
if (sharedMode) {
  document.getElementById('back').href = scopedUrl('index.html');
  document.getElementById('back').textContent = t('Selección', 'Selection');
} else {
  document.getElementById('back').href = 'index.html';
}

window.addEventListener('course-language-change', refreshLanguage);
refreshLanguage();
load().catch(() => showUnavailable(['No se pudo cargar la presentación.', 'The presentation could not load.']));
