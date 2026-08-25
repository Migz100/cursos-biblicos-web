const courseId = new URLSearchParams(location.search).get('c') || '1';

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
  button.textContent = 'Preparando...';
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    await saveFile(await response.blob(), name);
  } catch (error) {
    if (error?.name !== 'AbortError') window.open(url, '_blank', 'noopener');
  } finally {
    button.textContent = label;
    delete button.dataset.busy;
  }
}

function lessonRow(course, lesson, index) {
  const row = document.createElement('a');
  row.className = 'row';
  row.href = lesson.type === 'pdf'
    ? `leer.html?c=${encodeURIComponent(course.id)}&l=${encodeURIComponent(lesson.legacyNumber || lesson.id)}`
    : lesson.downloadUrl || lesson.url;
  if (lesson.type !== 'pdf') row.target = '_blank';

  const number = document.createElement('div');
  number.className = 'num';
  number.textContent = String(index + 1);
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = lesson.title;
  const kind = document.createElement('span');
  kind.className = 'fileKind';
  kind.textContent = lesson.type.toUpperCase();
  const button = document.createElement('button');
  button.className = 'dlRow';
  button.type = 'button';
  button.title = 'Descargar lección';
  button.setAttribute('aria-label', `Descargar ${lesson.title}`);
  button.textContent = '↓';
  button.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    downloadUrl(lesson.downloadUrl || lesson.url, lesson.originalName || `${lesson.title}.${lesson.type}`, button);
  };
  const chevron = document.createElement('span');
  chevron.className = 'chevText';
  chevron.textContent = '›';
  row.append(number, label, kind, button, chevron);
  if (lesson.type !== 'pdf') {
    row.onclick = event => {
      if (event.target === button) return;
      event.preventDefault();
      downloadUrl(lesson.downloadUrl || lesson.url, lesson.originalName || `${lesson.title}.${lesson.type}`, button);
    };
  }
  return row;
}

async function load() {
  const response = await fetch('/api/catalog');
  if (!response.ok) throw new Error('catalog');
  const data = await response.json();
  const course = data.courses.find(item => item.id === courseId);
  if (!course) { location.href = 'index.html'; return; }
  document.title = `${course.name} · Cursos Bíblicos`;
  document.getElementById('title').textContent = course.name;
  if (course.coverUrl) {
    const cover = document.getElementById('courseCover');
    cover.style.backgroundImage = `linear-gradient(90deg, rgba(255,255,255,0.06), rgba(255,255,255,0.06)), url("${course.coverUrl}")`;
    cover.setAttribute('aria-label', `Portada de ${course.name}`);
    cover.hidden = false;
  }
  const download = document.getElementById('dlCourse');
  if (course.zip) {
    download.textContent = course.zipKind === 'current' ? 'Descargar curso (ZIP)' : 'Descargar versión inicial (ZIP)';
    download.hidden = false;
    if (course.zipKind !== 'current') document.getElementById('courseArchiveNote').hidden = false;
    download.onclick = event => {
      event.preventDefault();
      downloadUrl(course.zip, `${course.name}.zip`, download);
    };
  }
  const originals = document.getElementById('dlPpt');
  if (course.pptZip) {
    originals.hidden = false;
    originals.onclick = event => {
      event.preventDefault();
      downloadUrl(course.pptZip, `${course.name} - originales.zip`, originals);
    };
  }
  const list = document.getElementById('list');
  course.lessons.forEach((lesson, index) => list.appendChild(lessonRow(course, lesson, index)));
  if (!course.lessons.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Este curso todavía no tiene lecciones.';
    list.appendChild(empty);
  }
}

load().catch(() => {
  const list = document.getElementById('list');
  list.textContent = 'No se pudo cargar el curso. Intenta recargar la página.';
});
