import * as pdfjsLib from './vendor/pdf.min.mjs';

const params = new URLSearchParams(location.search);
const courseId = params.get('c') || '';
const lessonId = params.get('l') || '';
const requestedPage = Number(params.get('p'));
const statusElement = document.getElementById('status');
const fallback = document.getElementById('fallback');
const stage = document.getElementById('stage');
const canvasWrap = document.getElementById('canvasWrap');
const canvas = document.getElementById('presentationCanvas');
const context = canvas.getContext('2d', { alpha: false });
const pageInput = document.getElementById('pageInput');
const pageTotal = document.getElementById('pageTotal');
const previousButton = document.getElementById('prev');
const nextButton = document.getElementById('next');
const fitButton = document.getElementById('fit');
const fullScreenButton = document.getElementById('fullScreen');
const downloadLink = document.getElementById('download');

let presentation = null;
let pdfDocument = null;
let pageNumber = 1;
let renderTask = null;
let renderSequence = 0;
let fitMode = matchMedia('(max-width: 600px)').matches ? 'width' : 'page';
let resizeTimer = null;

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';

function showError(message) {
  renderTask?.cancel();
  statusElement.hidden = true;
  canvasWrap.hidden = true;
  fallback.querySelector('strong').textContent = message;
  fallback.hidden = false;
  document.documentElement.dataset.presentationStatus = 'error';
}

function updateControls() {
  const count = pdfDocument?.numPages || presentation?.pageCount || 0;
  pageInput.value = String(pageNumber);
  pageInput.max = String(count || 1);
  pageTotal.textContent = count ? `de ${count}` : 'de —';
  previousButton.disabled = !count || pageNumber <= 1;
  nextButton.disabled = !count || pageNumber >= count;
  pageInput.disabled = !count;
  fitButton.disabled = !count;
  fullScreenButton.disabled = !count;
  fitButton.textContent = fitMode === 'width' ? 'Ajustar página' : 'Ajustar ancho';
}

function availableSize() {
  const style = getComputedStyle(stage);
  return {
    width: Math.max(1, stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
    height: Math.max(1, stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
  };
}

async function renderPage(number) {
  if (!pdfDocument) return;
  pageNumber = Math.max(1, Math.min(pdfDocument.numPages, Number(number) || 1));
  const sequence = ++renderSequence;
  renderTask?.cancel();
  updateControls();
  statusElement.textContent = `Preparando la página ${pageNumber}...`;
  statusElement.hidden = false;
  fallback.hidden = true;

  const page = await pdfDocument.getPage(pageNumber);
  if (sequence !== renderSequence) return;
  const base = page.getViewport({ scale: 1 });
  const available = availableSize();
  const widthScale = available.width / base.width;
  const pageScale = Math.min(widthScale, available.height / base.height);
  const scale = Math.max(0.1, fitMode === 'width' ? widthScale : pageScale);
  const viewport = page.getViewport({ scale });
  const outputScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));

  canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
  canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  canvas.setAttribute('aria-label', `Página ${pageNumber} de ${pdfDocument.numPages}: ${presentation.lesson.title}`);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  renderTask = page.render({
    canvasContext: context,
    viewport,
    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
  });
  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name === 'RenderingCancelledException') return;
    throw error;
  } finally {
    if (sequence === renderSequence) renderTask = null;
  }
  if (sequence !== renderSequence) return;
  canvasWrap.hidden = false;
  statusElement.hidden = true;
  document.documentElement.dataset.presentationStatus = 'ready';
  document.documentElement.dataset.presentationPage = String(pageNumber);
}

async function goToPage(value) {
  const count = pdfDocument?.numPages || 0;
  if (!count) return;
  const number = Math.max(1, Math.min(count, Math.trunc(Number(value) || pageNumber)));
  await renderPage(number);
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
  downloadLink.href = presentation.lesson.downloadUrl;
  downloadLink.download = presentation.lesson.originalName || '';
  downloadLink.removeAttribute('aria-disabled');

  const loadingTask = pdfjsLib.getDocument({
    url: presentation.pdfUrl,
    isEvalSupported: false,
    enableXfa: false,
    verbosity: 0
  });
  pdfDocument = await loadingTask.promise;
  if (pdfDocument.numPages !== presentation.pageCount) {
    await loadingTask.destroy();
    pdfDocument = null;
    throw new Error('PAGE_COUNT_MISMATCH');
  }
  pageNumber = Number.isSafeInteger(requestedPage) ? Math.max(1, Math.min(pdfDocument.numPages, requestedPage)) : 1;
  updateControls();
  await renderPage(pageNumber);
}

previousButton.addEventListener('click', () => goToPage(pageNumber - 1).catch(() => showError('No se pudo mostrar esa página.')));
nextButton.addEventListener('click', () => goToPage(pageNumber + 1).catch(() => showError('No se pudo mostrar esa página.')));
pageInput.addEventListener('change', () => goToPage(pageInput.value).catch(() => showError('No se pudo mostrar esa página.')));
pageInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  goToPage(pageInput.value).catch(() => showError('No se pudo mostrar esa página.'));
});
fitButton.addEventListener('click', () => {
  fitMode = fitMode === 'width' ? 'page' : 'width';
  updateControls();
  renderPage(pageNumber).catch(() => showError('No se pudo ajustar la página.'));
});
fullScreenButton.addEventListener('click', async () => {
  if (!pdfDocument) return;
  if (document.fullscreenElement) await document.exitFullscreen();
  else await stage.requestFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  fullScreenButton.textContent = document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa';
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPage(pageNumber).catch(() => {}), 100);
});
document.addEventListener('keydown', event => {
  if (!pdfDocument || event.defaultPrevented || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
  const target = event.key === 'ArrowLeft' || event.key === 'PageUp'
    ? pageNumber - 1
    : event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' '
      ? pageNumber + 1
      : event.key === 'Home'
        ? 1
        : event.key === 'End'
          ? pdfDocument.numPages
          : null;
  if (target === null) return;
  event.preventDefault();
  goToPage(target).catch(() => showError('No se pudo mostrar esa página.'));
});
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPage(pageNumber).catch(() => {}), 160);
});

updateControls();
load().catch(() => showError('No se pudo cargar la presentación.'));
