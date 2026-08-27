import * as pdfjsLib from './vendor/pdf.min.mjs';

const params = new URLSearchParams(location.search);
const cid = params.get('c') || '1';
const lessonParam = params.get('l') || '1-01';
const ANSWER_PREFIX = 'cursosBiblicosText_v1_';
const MIN_ZOOM = 0.65;
const MAX_ZOOM = 2.5;

let course = null;
let lessons = [];
let lesson = null;
let pdfDoc = null;
let pageNum = 1;
let zoomFactor = 1;
let renderTask = null;
let renderSequence = 0;
let fieldCatalog = { documents: {} };
let answerState = { values: {}, fields: {} };
let clearBackup = null;
let clearTimer = null;
let lastAreaWidth = 0;

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';

function shortHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function answerKey() {
  if (lesson && !lesson.managed && lesson.legacyNumber) return `${ANSWER_PREFIX}${cid}_${lesson.legacyNumber}`;
  return `${ANSWER_PREFIX}${cid}_${lesson?.id || lessonParam}_${shortHash(lesson?.url || 'sin-archivo')}`;
}

function loadAnswers() {
  try {
    const value = JSON.parse(localStorage.getItem(answerKey()) || '{}');
    answerState = {
      values: value && typeof value.values === 'object' ? value.values : {},
      fields: value && typeof value.fields === 'object' ? value.fields : {}
    };
  } catch {
    answerState = { values: {}, fields: {} };
  }
}

function saveAnswers() {
  try { localStorage.setItem(answerKey(), JSON.stringify(answerState)); } catch {}
}

function cleanPath(value) {
  try { return new URL(value, location.href).pathname; } catch { return String(value || '').split('?')[0]; }
}

function currentFieldDocument() {
  const document = fieldCatalog.documents?.[`${cid}|${lesson?.id}`] ||
    fieldCatalog.documents?.[`${cid}|${lesson?.legacyNumber}`];
  if (!document) return null;
  return !document.url || cleanPath(document.url) === cleanPath(lesson.url) ? document : null;
}

function fieldId(page, field) {
  if (field.id) return `${page}:${field.id}`;
  return `${page}:${['x', 'y', 'w', 'h'].map(key => Number(field[key] || 0).toFixed(4)).join(':')}`;
}

function mergeFields(fields) {
  const merged = [];
  for (const field of fields) {
    const normalized = {
      x: Math.max(0, Math.min(0.99, Number(field.x) || 0)),
      y: Math.max(0, Math.min(0.99, Number(field.y) || 0)),
      w: Math.max(0.04, Math.min(1, Number(field.w) || 0.2)),
      h: Math.max(0.018, Math.min(0.25, Number(field.h) || 0.038)),
      kind: field.kind === 'box' || field.kind === 'widget' ? field.kind : 'line',
      ...(field.id ? { id: field.id } : {})
    };
    normalized.w = Math.min(normalized.w, 1 - normalized.x);
    normalized.h = Math.min(normalized.h, 1 - normalized.y);
    const duplicate = merged.some(existing => {
      const xOverlap = Math.max(0, Math.min(existing.x + existing.w, normalized.x + normalized.w) - Math.max(existing.x, normalized.x));
      const yOverlap = Math.max(0, Math.min(existing.y + existing.h, normalized.y + normalized.h) - Math.max(existing.y, normalized.y));
      return xOverlap * yOverlap > Math.min(existing.w * existing.h, normalized.w * normalized.h) * 0.55;
    });
    if (!duplicate) merged.push(normalized);
  }
  const sorted = merged.sort((a, b) => a.y - b.y || a.x - b.x);
  const grouped = [];
  for (const field of sorted) {
    const previous = grouped.at(-1);
    const gap = previous ? field.x - (previous.x + previous.w) : 1;
    const sameRow = previous && Math.abs(field.y - previous.y) <= Math.max(0.004, Math.min(field.h, previous.h) * 0.25);
    const smallWidgets = previous?._smallWidgetRun && field.kind === 'widget' && field.w <= 0.08;
    if (smallWidgets && sameRow && gap >= -0.002 && gap <= 0.014) {
      const right = Math.max(previous.x + previous.w, field.x + field.w);
      previous.y = Math.min(previous.y, field.y);
      previous.h = Math.max(previous.h, field.h);
      previous.w = right - previous.x;
    } else grouped.push({ ...field, _smallWidgetRun: field.kind === 'widget' && field.w <= 0.08 });
  }
  return grouped.map(({ _smallWidgetRun, ...field }) => field);
}

function rowSegments(mask, maxGap = 4) {
  const segments = [];
  let start = -1;
  let previous = -1;
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    if (start < 0 || index - previous > maxGap + 1) {
      if (start >= 0) segments.push([start, previous, count]);
      start = index;
      count = 1;
    } else count += 1;
    previous = index;
  }
  if (start >= 0) segments.push([start, previous, count]);
  return segments;
}

function pixelStats(data, offset) {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return {
    gray: (red + green + blue) / 3,
    spread: Math.max(red, green, blue) - Math.min(red, green, blue)
  };
}

function detectedCanvasFields(sourceCanvas) {
  const maxWidth = 1200;
  const scale = Math.min(1, maxWidth / sourceCanvas.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const width = canvas.width;
  const height = canvas.height;
  const candidates = [];
  const minY = Math.max(1, Math.floor(height * 0.06));
  const maxY = Math.min(height - 1, Math.floor(height * 0.92));

  for (let y = minY; y < maxY; y += 1) {
    const mask = new Uint8Array(width);
    for (let x = 0; x < width; x += 1) {
      const stats = pixelStats(data, (y * width + x) * 4);
      mask[x] = stats.gray < 220 && stats.spread < 34 ? 1 : 0;
    }
    for (const [x0, x1, dark] of rowSegments(mask)) {
      const span = x1 - x0 + 1;
      if (span < width * 0.14 || dark / span < 0.62) continue;
      if (span > width * 0.88 && (x0 < width * 0.08 || x1 > width * 0.92)) continue;
      candidates.push({ x0, x1, y0: y, y1: y, density: dark / span });
    }
  }

  const groups = [];
  for (const candidate of candidates) {
    const match = [...groups].reverse().slice(0, 24).find(group => {
      const overlap = Math.min(group.x1, candidate.x1) - Math.max(group.x0, candidate.x0);
      const base = Math.min(group.x1 - group.x0, candidate.x1 - candidate.x0);
      return candidate.y0 - group.y1 <= 3 && overlap >= base * 0.72;
    });
    if (match) {
      match.x0 = Math.min(match.x0, candidate.x0);
      match.x1 = Math.max(match.x1, candidate.x1);
      match.y1 = candidate.y1;
      match.density = Math.max(match.density, candidate.density);
    } else groups.push(candidate);
  }

  const fields = [];
  for (const group of groups) {
    const span = group.x1 - group.x0 + 1;
    const thickness = group.y1 - group.y0 + 1;
    if (thickness > Math.max(4, height * 0.004)) continue;
    const top = Math.max(0, group.y0 - Math.round(height * 0.03));
    const bottom = Math.max(top, group.y0 - Math.round(height * 0.006));
    let ink = 0;
    let pixels = 0;
    for (let y = top; y < bottom; y += 2) {
      for (let x = group.x0; x <= group.x1; x += 2) {
        const stats = pixelStats(data, (y * width + x) * 4);
        ink += stats.gray < 185 ? 1 : 0;
        pixels += 1;
      }
    }
    if (pixels && ink / pixels > 0.085) continue;
    const fieldHeight = Math.max(0.032, Math.min(0.055, (group.y0 - top) / height));
    fields.push({
      x: group.x0 / width,
      y: Math.max(0, group.y0 / height - fieldHeight),
      w: span / width,
      h: fieldHeight,
      kind: 'line'
    });
  }

  const rectangleRows = [];
  for (let y = minY; y < Math.min(maxY, height * 0.88); y += 1) {
    const mask = new Uint8Array(width);
    for (let x = 0; x < width; x += 1) {
      const stats = pixelStats(data, (y * width + x) * 4);
      mask[x] = stats.spread <= 12 && stats.gray >= 190 && stats.gray <= 240 ? 1 : 0;
    }
    for (const [x0, x1, filled] of rowSegments(mask, 1)) {
      const span = x1 - x0 + 1;
      if (span < width * 0.06 || span > width * 0.65 || filled / span < 0.95) continue;
      if (x0 < width * 0.07 || x1 > width * 0.96) continue;
      rectangleRows.push({ x0, x1, y0: y, y1: y });
    }
  }
  const rectangles = [];
  for (const row of rectangleRows) {
    const match = [...rectangles].reverse().slice(0, 36).find(group =>
      row.y0 - group.y1 <= 2 && Math.abs(group.x0 - row.x0) <= 4 && Math.abs(group.x1 - row.x1) <= 4
    );
    if (match) match.y1 = row.y1;
    else rectangles.push(row);
  }
  const validRectangles = rectangles.filter(rectangle => {
    const rectHeight = rectangle.y1 - rectangle.y0 + 1;
    return rectHeight >= Math.max(7, height * 0.008) && rectHeight <= height * 0.09;
  });
  if (validRectangles.length >= 2) {
    for (const rectangle of validRectangles) {
      fields.push({
        x: rectangle.x0 / width,
        y: rectangle.y0 / height,
        w: (rectangle.x1 - rectangle.x0 + 1) / width,
        h: (rectangle.y1 - rectangle.y0 + 1) / height,
        kind: 'box'
      });
    }
  }
  return mergeFields(fields);
}

async function annotationFields(page, viewport) {
  const annotations = await page.getAnnotations({ intent: 'display' });
  return annotations.filter(annotation => annotation.fieldType === 'Tx' && Array.isArray(annotation.rect)).map(annotation => {
    const first = [annotation.rect[0], annotation.rect[1]];
    const second = [annotation.rect[2], annotation.rect[3]];
    pdfjsLib.Util.applyTransform(first, viewport.transform);
    pdfjsLib.Util.applyTransform(second, viewport.transform);
    const rectangle = [first[0], first[1], second[0], second[1]];
    const left = Math.min(rectangle[0], rectangle[2]);
    const top = Math.min(rectangle[1], rectangle[3]);
    return {
      id: `widget-${annotation.id}`,
      x: left / viewport.width,
      y: top / viewport.height,
      w: Math.abs(rectangle[2] - rectangle[0]) / viewport.width,
      h: Math.abs(rectangle[3] - rectangle[1]) / viewport.height,
      kind: 'widget'
    };
  });
}

async function fieldsForPage(page, viewport, canvas) {
  const annotations = await annotationFields(page, viewport);
  const fieldDocument = currentFieldDocument();
  if (fieldDocument && Object.prototype.hasOwnProperty.call(fieldDocument.pages || {}, String(pageNum))) {
    return mergeFields([...annotations, ...(fieldDocument.pages[String(pageNum)] || [])]);
  }
  if (annotations.length) return mergeFields(annotations);
  return mergeFields(detectedCanvasFields(canvas));
}

function createAnswerLayer(pageElement, fields, viewport) {
  const layer = document.createElement('div');
  layer.className = 'answerLayer';
  let visibleCount = 0;
  fields.forEach((field, index) => {
    const id = fieldId(pageNum, field);
    answerState.fields[id] = { page: pageNum, ...field };
    const input = document.createElement('textarea');
    input.className = `answerField ${field.kind}`;
    input.rows = field.h > 0.055 ? 2 : 1;
    input.value = answerState.values[id] || '';
    input.setAttribute('aria-label', `Respuesta ${index + 1} de la página ${pageNum}`);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'true');
    input.style.left = `${field.x * 100}%`;
    input.style.top = `${field.y * 100}%`;
    input.style.width = `${field.w * 100}%`;
    input.style.height = `${field.h * 100}%`;
    input.style.fontSize = `${Math.max(14, Math.min(22, viewport.height * 0.018))}px`;
    input.addEventListener('input', () => {
      answerState.values[id] = input.value;
      saveAnswers();
    });
    layer.appendChild(input);
    visibleCount += 1;
  });
  pageElement.appendChild(layer);
  saveAnswers();
  const hint = document.getElementById('answerHint');
  hint.textContent = visibleCount
    ? `${visibleCount} ${visibleCount === 1 ? 'espacio listo' : 'espacios listos'} para escribir en esta página.`
    : 'Esta página no tiene espacios de respuesta detectados.';
}

function pageElement() {
  const page = document.createElement('div');
  page.className = 'pg';
  const canvas = document.createElement('canvas');
  canvas.className = 'pdfCanvas';
  page.appendChild(canvas);
  return { page, canvas };
}

async function renderPage({ preserveCenter = false } = {}) {
  if (!pdfDoc) return;
  if (renderTask) renderTask.cancel();
  const sequence = ++renderSequence;
  const area = document.getElementById('pdfArea');
  const oldPage = document.querySelector('.pg');
  const oldWidth = oldPage?.offsetWidth || 1;
  const centerX = area.scrollLeft + area.clientWidth / 2;
  const centerY = area.scrollTop + area.clientHeight / 2;
  const page = await pdfDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const fitWidth = Math.min(1000, Math.max(260, area.clientWidth - 24));
  const scale = fitWidth / baseViewport.width * zoomFactor;
  const viewport = page.getViewport({ scale });
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const box = document.getElementById('pdfBox');
  const elements = pageElement();
  box.replaceChildren(elements.page);
  elements.canvas.width = Math.ceil(viewport.width * dpr);
  elements.canvas.height = Math.ceil(viewport.height * dpr);
  elements.canvas.style.width = `${viewport.width}px`;
  elements.canvas.style.height = `${viewport.height}px`;
  elements.page.style.width = `${viewport.width}px`;
  elements.page.style.height = `${viewport.height}px`;
  const context = elements.canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  try {
    renderTask = page.render({ canvasContext: context, viewport });
    await renderTask.promise;
  } catch (error) {
    if (error?.name === 'RenderingCancelledException') return;
    throw error;
  } finally {
    renderTask = null;
  }
  if (sequence !== renderSequence) return;
  const fields = await fieldsForPage(page, viewport, elements.canvas);
  createAnswerLayer(elements.page, fields, viewport);
  updatePageNavigation();
  document.getElementById('zoomValue').textContent = `${Math.round(zoomFactor * 100)}%`;
  if (preserveCenter) {
    const ratio = viewport.width / oldWidth;
    area.scrollLeft = Math.max(0, centerX * ratio - area.clientWidth / 2);
    area.scrollTop = Math.max(0, centerY * ratio - area.clientHeight / 2);
  }
  lastAreaWidth = area.clientWidth;
}

function updatePageNavigation() {
  document.getElementById('pgCount').textContent = `${pageNum} / ${pdfDoc?.numPages || 1}`;
  document.getElementById('pgPrev').disabled = pageNum <= 1;
  document.getElementById('pgNext').disabled = !pdfDoc || pageNum >= pdfDoc.numPages;
  document.getElementById('zoomOut').disabled = zoomFactor <= MIN_ZOOM;
  document.getElementById('zoomIn').disabled = zoomFactor >= MAX_ZOOM;
}

async function setZoom(value) {
  zoomFactor = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 20) / 20));
  await renderPage({ preserveCenter: true });
}

async function loadPdf(url) {
  pdfDoc = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
  pageNum = 1;
  await renderPage();
}

function wrapText(context, text, width) {
  const paragraphs = String(text).split(/\n/);
  const lines = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > width) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
    if (!words.length || paragraphIndex < paragraphs.length - 1) lines.push('');
  });
  return lines;
}

function drawAnswer(context, field, text, width, height) {
  if (!text) return;
  const x = field.x * width;
  const y = field.y * height;
  const boxWidth = field.w * width;
  const boxHeight = field.h * height;
  const fontSize = Math.max(11, Math.min(19, boxHeight * 0.58));
  const lineHeight = fontSize * 1.18;
  context.save();
  context.beginPath();
  context.rect(x, y, boxWidth, Math.max(boxHeight, lineHeight));
  context.clip();
  context.fillStyle = '#17365D';
  context.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;
  context.textBaseline = 'top';
  const lines = wrapText(context, text, Math.max(20, boxWidth - 4));
  lines.forEach((line, index) => context.fillText(line, x + 2, y + 1 + index * lineHeight));
  context.restore();
}

async function saveAnsweredPdf() {
  const button = document.getElementById('savePdf');
  if (!pdfDoc || button.dataset.busy) return;
  button.dataset.busy = '1';
  const label = button.textContent;
  button.textContent = 'Preparando...';
  try {
    const { jsPDF } = window.jspdf;
    let output = null;
    for (let number = 1; number <= pdfDoc.numPages; number += 1) {
      button.textContent = `Página ${number} de ${pdfDoc.numPages}`;
      const page = await pdfDoc.getPage(number);
      const sourceViewport = page.getViewport({ scale: 1 });
      const renderViewport = page.getViewport({ scale: 1.7 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: renderViewport }).promise;
      for (const [id, field] of Object.entries(answerState.fields)) {
        if (field.page !== number || !answerState.values[id]) continue;
        drawAnswer(context, field, answerState.values[id], renderViewport.width, renderViewport.height);
      }
      const orientation = sourceViewport.width > sourceViewport.height ? 'landscape' : 'portrait';
      if (!output) output = new jsPDF({ unit: 'pt', format: [sourceViewport.width, sourceViewport.height], orientation });
      else output.addPage([sourceViewport.width, sourceViewport.height], orientation);
      output.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, sourceViewport.width, sourceViewport.height, undefined, 'FAST');
      canvas.width = 1;
      canvas.height = 1;
    }
    output.save(`${lesson.title} - contestado.pdf`);
  } finally {
    delete button.dataset.busy;
    button.textContent = label;
  }
}

function clearOrRestoreAnswers() {
  const button = document.getElementById('clearAnswers');
  if (clearBackup) {
    answerState = clearBackup;
    clearBackup = null;
    clearTimeout(clearTimer);
    button.textContent = 'Borrar respuestas';
    saveAnswers();
    renderPage().catch(() => {});
    return;
  }
  if (!Object.values(answerState.values).some(Boolean)) return;
  clearBackup = structuredClone(answerState);
  answerState.values = {};
  saveAnswers();
  button.textContent = 'Deshacer borrado';
  renderPage().catch(() => {});
  clearTimer = setTimeout(() => {
    clearBackup = null;
    button.textContent = 'Borrar respuestas';
  }, 10000);
}

async function init() {
  const [catalogResponse, fieldsResponse] = await Promise.all([
    fetch('/api/catalog', { cache: 'no-store' }),
    fetch('/assets/answer-fields.json', { cache: 'no-store' }).catch(() => null)
  ]);
  if (!catalogResponse.ok) throw new Error('catalog');
  const data = await catalogResponse.json();
  if (fieldsResponse?.ok) fieldCatalog = await fieldsResponse.json();
  course = data.courses.find(item => item.id === cid);
  if (!course) { location.href = 'index.html'; return; }
  lessons = course.lessons.filter(item => item.type === 'pdf');
  lesson = lessons.find(item => item.id === lessonParam || item.legacyNumber === lessonParam.padStart(2, '0'));
  if (!lesson) {
    document.title = 'No disponible';
    document.getElementById('title').textContent = 'Lección no disponible';
    const message = document.createElement('p');
    message.className = 'emptyMsg';
    message.textContent = 'Este archivo no está disponible.';
    document.getElementById('pdfBox').replaceChildren(message);
    return;
  }
  const index = lessons.indexOf(lesson);
  document.title = `${course.name} · ${lesson.title}`;
  document.getElementById('title').textContent = `${course.name} · ${lesson.title}`;
  document.getElementById('count').textContent = `${index + 1} / ${lessons.length}`;
  document.getElementById('prev').style.visibility = index <= 0 ? 'hidden' : 'visible';
  document.getElementById('next').style.visibility = index >= lessons.length - 1 ? 'hidden' : 'visible';
  loadAnswers();
  await loadPdf(lesson.url);
}

document.getElementById('back').onclick = () => { location.href = `curso.html?c=${encodeURIComponent(cid)}`; };
document.getElementById('prev').onclick = () => {
  const index = lessons.indexOf(lesson) - 1;
  if (index >= 0) location.href = `leer.html?c=${encodeURIComponent(cid)}&l=${encodeURIComponent(lessons[index].legacyNumber || lessons[index].id)}`;
};
document.getElementById('next').onclick = () => {
  const index = lessons.indexOf(lesson) + 1;
  if (index < lessons.length) location.href = `leer.html?c=${encodeURIComponent(cid)}&l=${encodeURIComponent(lessons[index].legacyNumber || lessons[index].id)}`;
};
document.getElementById('pgPrev').onclick = async () => {
  if (pageNum <= 1) return;
  pageNum -= 1;
  await renderPage();
  const area = document.getElementById('pdfArea');
  area.scrollTop = 0;
  area.scrollLeft = 0;
};
document.getElementById('pgNext').onclick = async () => {
  if (!pdfDoc || pageNum >= pdfDoc.numPages) return;
  pageNum += 1;
  await renderPage();
  const area = document.getElementById('pdfArea');
  area.scrollTop = 0;
  area.scrollLeft = 0;
};
document.getElementById('zoomOut').onclick = () => setZoom(zoomFactor - 0.2).catch(() => {});
document.getElementById('zoomIn').onclick = () => setZoom(zoomFactor + 0.2).catch(() => {});
document.getElementById('zoomFit').onclick = () => setZoom(1).catch(() => {});
document.getElementById('clearAnswers').onclick = clearOrRestoreAnswers;
document.getElementById('savePdf').onclick = () => saveAnsweredPdf().catch(() => {
  document.getElementById('answerHint').textContent = 'No se pudo crear el PDF. Intenta otra vez.';
});
document.getElementById('pdfArea').addEventListener('wheel', event => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  setZoom(zoomFactor + (event.deltaY < 0 ? 0.15 : -0.15)).catch(() => {});
}, { passive: false });

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const area = document.getElementById('pdfArea');
    if (document.activeElement?.classList.contains('answerField')) return;
    if (Math.abs(area.clientWidth - lastAreaWidth) > 24) renderPage({ preserveCenter: true }).catch(() => {});
  }, 180);
});

init().catch(error => {
  console.error('No se pudo cargar el lector.', error?.stack || error);
  const message = document.createElement('p');
  message.className = 'emptyMsg';
  message.textContent = 'No se pudo cargar la lección. Intenta recargar la página.';
  document.getElementById('pdfBox').replaceChildren(message);
});
