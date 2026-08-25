const params = new URLSearchParams(location.search);
const courseId = params.get('c') || '';
const lessonId = params.get('l') || '';
const statusElement = document.getElementById('status');
const frame = document.getElementById('presentationFrame');
const fallback = document.getElementById('fallback');
let presentation = null;
let loadTimer = null;

function showError(message) {
  clearTimeout(loadTimer);
  frame.hidden = true;
  statusElement.hidden = true;
  fallback.querySelector('strong').textContent = message;
  fallback.hidden = false;
}

async function downloadPresentation() {
  const button = document.getElementById('download');
  if (!presentation || button.dataset.busy) return;
  button.dataset.busy = '1';
  button.textContent = 'Preparando...';
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
    button.textContent = 'Descargar';
    delete button.dataset.busy;
  }
}

async function load() {
  if (!courseId || !lessonId) {
    showError('La presentación solicitada no está disponible.');
    return;
  }
  const response = await fetch(`/api/presentation?c=${encodeURIComponent(courseId)}&l=${encodeURIComponent(lessonId)}`, { cache: 'no-store' });
  if (!response.ok) {
    showError('La presentación solicitada no está disponible.');
    return;
  }
  presentation = await response.json();
  document.title = `${presentation.lesson.title} · ${presentation.course.name}`;
  document.getElementById('title').textContent = presentation.lesson.title;
  document.getElementById('back').href = `curso.html?c=${encodeURIComponent(presentation.course.id)}`;
  const openViewer = document.getElementById('openViewer');
  openViewer.href = presentation.viewerUrl;
  openViewer.hidden = false;
  document.getElementById('download').disabled = false;
  frame.onload = () => {
    clearTimeout(loadTimer);
    statusElement.hidden = true;
    fallback.hidden = true;
    frame.hidden = false;
  };
  frame.src = presentation.viewerUrl;
  loadTimer = setTimeout(() => {
    fallback.hidden = false;
  }, 20000);
}

document.getElementById('download').onclick = downloadPresentation;
document.getElementById('fullScreen').onclick = async () => {
  if (!presentation) return;
  const stage = document.getElementById('stage');
  if (stage.requestFullscreen) {
    await stage.requestFullscreen().catch(() => window.open(presentation.viewerUrl, '_blank', 'noopener'));
  } else {
    window.open(presentation.viewerUrl, '_blank', 'noopener');
  }
};

load().catch(() => showError('No se pudo cargar la presentación.'));
