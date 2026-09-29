const params = new URLSearchParams(location.search);
const courseId = params.get('c') || '';
const lessonId = params.get('l') || '';
const statusElement = document.getElementById('status');
const frame = document.getElementById('presentationFrame');
const fallback = document.getElementById('fallback');
const transcript = document.getElementById('presentationTranscript');
const transcriptButton = document.getElementById('openTranscript');
const transcriptSlides = document.getElementById('transcriptSlides');
let presentation = null;
let loadTimer = null;
let transcriptReturnFocus = null;
let verseModal = null;
let verseReturnFocus = null;

function focusableWithin(container) {
  return [...container.querySelectorAll('button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && element.getClientRects().length);
}

function closeTranscript() {
  if (transcript.hidden) return;
  transcript.hidden = true;
  transcriptButton.setAttribute('aria-expanded', 'false');
  const target = transcriptReturnFocus;
  transcriptReturnFocus = null;
  if (target?.isConnected) target.focus();
}

function openTranscript() {
  if (transcriptButton.hidden) return;
  transcriptReturnFocus = document.activeElement;
  transcript.hidden = false;
  transcriptButton.setAttribute('aria-expanded', 'true');
  document.getElementById('closeTranscript').focus();
}

function closeVersePopup() {
  if (!verseModal || verseModal.hidden) return;
  verseModal.hidden = true;
  const target = verseReturnFocus;
  verseReturnFocus = null;
  if (target?.isConnected) target.focus();
}

function ensureVerseModal() {
  if (verseModal) return verseModal;
  const modal = document.createElement('div');
  modal.className = 'verseModal';
  modal.hidden = true;
  const card = document.createElement('div');
  card.className = 'verseCard';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'presentationVerseTitle');
  const title = document.createElement('h2');
  title.className = 'verseTitle';
  title.id = 'presentationVerseTitle';
  const body = document.createElement('div');
  body.className = 'verseText';
  body.id = 'presentationVerseText';
  body.setAttribute('aria-live', 'polite');
  const version = document.createElement('p');
  version.className = 'verseVersion';
  version.textContent = 'Reina-Valera 1960';
  const actions = document.createElement('div');
  actions.className = 'verseActions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'wBtn';
  copy.textContent = 'Copiar';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'wBtn primaryTool';
  close.textContent = 'Cerrar';
  actions.append(copy, close);
  card.append(title, body, version, actions);
  modal.appendChild(card);
  document.body.appendChild(modal);
  modal.addEventListener('click', event => { if (event.target === modal) closeVersePopup(); });
  close.addEventListener('click', closeVersePopup);
  copy.addEventListener('click', () => {
    const text = title.textContent + '\n' + body.innerText + '\nReina-Valera 1960';
    navigator.clipboard?.writeText(text).then(() => {
      copy.textContent = 'Copiado';
      setTimeout(() => { copy.textContent = 'Copiar'; }, 1600);
    }).catch(() => {});
  });
  modal._closeButton = close;
  verseModal = modal;
  return modal;
}

async function openVersePopup(reference, trigger = document.activeElement) {
  const modal = ensureVerseModal();
  const title = modal.querySelector('.verseTitle');
  const body = modal.querySelector('.verseText');
  title.textContent = BibleVerses.formatReference(reference);
  body.textContent = 'Buscando el texto...';
  verseReturnFocus = trigger;
  modal.hidden = false;
  modal._closeButton.focus();
  const blocks = await BibleVerses.resolveReference(reference, 'assets/bible/rvr1960/');
  body.replaceChildren();
  let any = false;
  for (const block of blocks) {
    if (blocks.length > 1) {
      const heading = document.createElement('h3');
      heading.className = 'verseBlockTitle';
      heading.textContent = block.heading;
      body.appendChild(heading);
    }
    for (const line of block.lines) {
      if (!line.text) continue;
      any = true;
      const paragraph = document.createElement('p');
      const number = document.createElement('sup');
      number.textContent = String(line.verse);
      paragraph.append(number, document.createTextNode(' ' + line.text));
      body.appendChild(paragraph);
    }
  }
  if (!any) body.textContent = 'No encontramos ese texto en la Biblia incluida.';
}

async function renderTranscript(accessibility) {
  if (accessibility?.status !== 'available' || !Array.isArray(accessibility.slides) || !accessibility.slides.length) return;
  const bookIds = [...new Set(accessibility.slides.flatMap(slide => slide.references || []).map(reference => reference.bookId))];
  const books = new Map(await Promise.all(bookIds.map(id => BibleVerses.fetchBook(id).then(data => [id, data]))));
  transcriptSlides.replaceChildren();
  let referenceCount = 0;
  for (const slide of accessibility.slides) {
    const details = document.createElement('details');
    details.className = 'slideTranscript';
    const summary = document.createElement('summary');
    const body = document.createElement('div');
    body.className = 'slideTranscriptBody';
    const text = document.createElement('p');
    text.className = 'slideTranscriptText';
    text.textContent = slide.text || '';
    if (!slide.text) text.classList.add('slideTranscriptEmpty');
    if (!slide.text) text.textContent = 'Sin texto extra\u00edble.';
    body.appendChild(text);
    const validReferences = (slide.references || []).filter(reference => BibleVerses.referenceIsValid(reference, books.get(reference.bookId)));
    summary.textContent = 'Diapositiva ' + slide.number + (validReferences.length ? ' - ' + validReferences.length + (validReferences.length === 1 ? ' cita' : ' citas') : '');
    if (validReferences.length) {
      const references = document.createElement('div');
      references.className = 'slideReferences';
      references.setAttribute('aria-label', 'Citas b\u00edblicas de la diapositiva ' + slide.number);
      for (const reference of validReferences) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'slideVerseButton';
        button.textContent = reference.label || BibleVerses.formatReference(reference);
        button.setAttribute('aria-label', 'Leer ' + button.textContent + ' en la Biblia Reina-Valera 1960');
        button.addEventListener('click', event => openVersePopup(reference, event.currentTarget));
        references.appendChild(button);
      }
      body.appendChild(references);
      referenceCount += validReferences.length;
    }
    details.append(summary, body);
    transcriptSlides.appendChild(details);
  }
  document.getElementById('transcriptSummary').textContent = accessibility.slides.length + ' diapositivas; ' + referenceCount + ' citas b\u00edblicas enlazadas.';
  transcriptButton.hidden = false;
}

document.addEventListener('keydown', event => {
  const activeDialog = verseModal && !verseModal.hidden ? verseModal : (!transcript.hidden ? transcript : null);
  if (!activeDialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (activeDialog === verseModal) closeVersePopup();
    else closeTranscript();
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = focusableWithin(activeDialog);
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

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
  await renderTranscript(presentation.accessibility);
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
transcriptButton.addEventListener('click', openTranscript);
document.getElementById('closeTranscript').addEventListener('click', closeTranscript);
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
