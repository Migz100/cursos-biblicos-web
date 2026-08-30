import * as pdfjsLib from './vendor/pdf.min.mjs';

const params = new URLSearchParams(location.search);
const cid = params.get('c') || '1';
const lessonParam = params.get('l') || '1-01';
const soloMode = params.get('solo') === '1';
const ANSWER_PREFIX = 'cursosBiblicosText_v1_';
const ZOOM_KEY = 'cursosBiblicosReaderZoom_v2';
const ROTATION_PREFIX = 'cursosBiblicosReaderRotation_v1_';
const MIN_ZOOM = 0.65;
const MAX_ZOOM = 2.5;

let course = null;
let lessons = [];
let lesson = null;
let pdfDoc = null;
let pageNum = 1;
let zoomFactor = preferredZoom();
let pageRotations = {};
let renderTasks = new Map();
let renderObserver = null;
let renderSequence = 0;
let pageMetrics = [];
let scrollFrame = null;
let fieldCatalog = { documents: {} };
let verseCatalog = { documents: {} };
let answerState = { values: {}, fields: {} };
let clearBackup = null;
let clearTimer = null;
let lastAreaWidth = 0;

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.mjs';

function preferredZoom() {
  try {
    const stored = Number(localStorage.getItem(ZOOM_KEY));
    if (stored >= MIN_ZOOM && stored <= MAX_ZOOM) return stored;
  } catch {}
  return 1;
}

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
  if (document.url && cleanPath(document.url) !== cleanPath(lesson.url)) return null;
  // A Blob URL can be overwritten while keeping the same pathname.  The field
  // catalog records every source page (including pages without fields), so a
  // page-count mismatch proves that its coordinates belong to an older PDF.
  const catalogPageCount = Object.keys(document.pages || {}).length;
  if (catalogPageCount && pdfDoc?.numPages && catalogPageCount !== pdfDoc.numPages) return null;
  return document;
}

function rotationKey() {
  return `${ROTATION_PREFIX}${cid}_${lesson?.id || lessonParam}_${shortHash(lesson?.url || 'sin-archivo')}`;
}

function loadRotations() {
  try {
    const stored = JSON.parse(localStorage.getItem(rotationKey()) || '{}');
    pageRotations = Object.fromEntries(Object.entries(stored).filter(([page, degrees]) =>
      /^\d+$/.test(page) && [0, 90, 180, 270].includes(Number(degrees))
    ));
  } catch {
    pageRotations = {};
  }
}

function saveRotations() {
  try { localStorage.setItem(rotationKey(), JSON.stringify(pageRotations)); } catch {}
}

function rotateGeometry(field, degrees = 0) {
  const rotation = ((Number(degrees) % 360) + 360) % 360;
  const x = Number(field.x) || 0;
  const y = Number(field.y) || 0;
  const w = Number(field.w) || 0;
  const h = Number(field.h) || 0;
  if (rotation === 90) return { ...field, x: 1 - y - h, y: x, w: h, h: w, rotated: true };
  if (rotation === 180) return { ...field, x: 1 - x - w, y: 1 - y - h, w, h, rotated: true };
  if (rotation === 270) return { ...field, x: y, y: 1 - x - w, w: h, h: w, rotated: true };
  return { ...field };
}

function fieldId(page, field) {
  if (field.id) return `${page}:${field.id}`;
  return `${page}:${['x', 'y', 'w', 'h'].map(key => Number(field[key] || 0).toFixed(4)).join(':')}`;
}

function mergeFields(fields) {
  const merged = [];
  for (const field of fields) {
    const maxHeight = field.native || field.rotated ? 1 : 0.25;
    const normalized = {
      x: Math.max(0, Math.min(0.99, Number(field.x) || 0)),
      y: Math.max(0, Math.min(0.99, Number(field.y) || 0)),
      w: Math.max(0.04, Math.min(1, Number(field.w) || 0.2)),
      h: Math.max(0.018, Math.min(maxHeight, Number(field.h) || 0.038)),
      kind: ['box', 'widget', 'check'].includes(field.kind) ? field.kind : 'line',
      ...(field.native ? { native: true } : {}),
      ...(field.rotated ? { rotated: true } : {}),
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
  for (const checkbox of detectedCheckboxes(data, width, height, minY, maxY)) {
    const overlaps = fields.some(field =>
      Math.abs(field.x - checkbox.x) < field.w * 0.6 && Math.abs(field.y - checkbox.y) < 0.02
    );
    if (!overlaps) fields.push(checkbox);
  }
  return mergeFields(fields);
}

// Small empty squares (☐) used as checkboxes in the study guides.
function detectedCheckboxes(data, width, height, minY, maxY) {
  const minSize = Math.max(7, Math.round(width * 0.010));
  const maxSize = Math.round(width * 0.040);
  const found = [];
  const isInk = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const stats = pixelStats(data, (y * width + x) * 4);
    return stats.gray < 200 && stats.spread < 70;
  };
  for (let y = minY; y < maxY - minSize; y += 1) {
    let x = 0;
    while (x < width - minSize) {
      if (!isInk(x, y)) { x += 1; continue; }
      let x1 = x;
      while (x1 + 1 < width && isInk(x1 + 1, y)) x1 += 1;
      const span = x1 - x + 1;
      x = x1 + 1;
      if (span < minSize || span > maxSize) continue;
      // Candidate top border. Find the bottom border within a square-ish distance.
      let bottom = -1;
      for (let yy = y + minSize; yy <= Math.min(y + maxSize + 2, maxY - 1); yy += 1) {
        let dark = 0;
        for (let xx = x1 - span + 1; xx <= x1; xx += 1) dark += isInk(xx, yy) ? 1 : 0;
        if (dark / span >= 0.7) { bottom = yy; break; }
      }
      if (bottom < 0) continue;
      const side = bottom - y + 1;
      if (Math.abs(side - span) > Math.max(3, span * 0.35)) continue;
      let left = 0;
      let right = 0;
      for (let yy = y; yy <= bottom; yy += 1) {
        left += isInk(x1 - span + 1, yy) ? 1 : 0;
        right += isInk(x1, yy) ? 1 : 0;
      }
      if (left / side < 0.55 || right / side < 0.55) continue;
      // A real checkbox stands alone: no letters touching it on either side.
      let neighbor = 0;
      let neighborPixels = 0;
      for (let yy = y; yy <= bottom; yy += 1) {
        for (const xx of [x1 - span - 6, x1 - span - 5, x1 - span - 4, x1 + 4, x1 + 5, x1 + 6]) {
          neighbor += isInk(xx, yy) ? 1 : 0;
          neighborPixels += 1;
        }
      }
      if (neighborPixels && neighbor / neighborPixels > 0.10) continue;
      // ...and its interior is empty.
      let inner = 0;
      let innerPixels = 0;
      for (let yy = y + 3; yy <= bottom - 3; yy += 2) {
        for (let xx = x1 - span + 4; xx <= x1 - 3; xx += 2) {
          inner += isInk(xx, yy) ? 1 : 0;
          innerPixels += 1;
        }
      }
      if (innerPixels && inner / innerPixels > 0.02) continue;
      // Real checkboxes are square-cornered; rounded letters (O, D, Q) are not.
      const x0 = x1 - span + 1;
      let corners = 0;
      for (const [cxx, cyy] of [[x0, y], [x1, y], [x0, bottom], [x1, bottom]]) {
        let dark = 0;
        for (let dy = 0; dy <= 1; dy += 1) for (let dx = 0; dx <= 1; dx += 1) dark += isInk(cxx + dx, cyy + dy) ? 1 : 0;
        if (dark >= 3) corners += 1;
      }
      if (corners < 3) continue;
      const cx = x1 - span + 1;
      const duplicate = found.some(box => Math.abs(box.px - cx) < span * 0.6 && Math.abs(box.py - y) < span * 0.6);
      if (duplicate) continue;
      found.push({
        px: cx,
        py: y,
        x: Math.max(0, cx - 1) / width,
        y: Math.max(0, y - 1) / height,
        w: (span + 2) / width,
        h: (side + 2) / height,
        kind: 'check'
      });
    }
  }
  return found;
}

function annotationRectangle(rect, viewport) {
  const first = [rect[0], rect[1]];
  const second = [rect[2], rect[3]];
  pdfjsLib.Util.applyTransform(first, viewport.transform);
  pdfjsLib.Util.applyTransform(second, viewport.transform);
  const left = Math.min(first[0], second[0]);
  const top = Math.min(first[1], second[1]);
  return {
    x: left / viewport.width,
    y: top / viewport.height,
    w: Math.abs(second[0] - first[0]) / viewport.width,
    h: Math.abs(second[1] - first[1]) / viewport.height
  };
}

function minimumTargetGeometry(geometry, viewport, minimumPixels = 44) {
  const minimumWidth = Math.min(1, minimumPixels / Math.max(1, viewport.width));
  const minimumHeight = Math.min(1, minimumPixels / Math.max(1, viewport.height));
  const originalWidth = Number(geometry.w) || 0;
  const originalHeight = Number(geometry.h) || 0;
  const width = Math.max(originalWidth, minimumWidth);
  const height = Math.max(originalHeight, minimumHeight);
  return {
    ...geometry,
    x: Math.max(0, Math.min(1 - width, (Number(geometry.x) || 0) - (width - originalWidth) / 2)),
    y: Math.max(0, Math.min(1 - height, (Number(geometry.y) || 0) - (height - originalHeight) / 2)),
    w: width,
    h: height
  };
}

function annotationFields(annotations, viewport) {
  return annotations
    .filter(annotation => (annotation.fieldType === 'Tx' || (annotation.fieldType === 'Btn' && annotation.checkBox)) && Array.isArray(annotation.rect))
    .map(annotation => {
      return {
        id: `widget-${annotation.id}`,
        ...annotationRectangle(annotation.rect, viewport),
        kind: annotation.fieldType === 'Btn' ? 'check' : 'widget',
        native: true
      };
    });
}

// Rects (fractions of the page) of every printed text glyph run.
function printedTextRects(textContent, viewport) {
  const rects = [];
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (fontHeight < 3) continue;
    const baseline = tx[5] / viewport.height;
    const x0 = tx[4] / viewport.width;
    const x1 = (tx[4] + item.width * viewport.scale) / viewport.width;
    const fh = fontHeight / viewport.height;
    // The glyphs themselves, plus the underline zone below the baseline
    // (links in these guides are underlined; the underline is not a write-in line).
    rects.push({ x0, y0: baseline - fh, x1, y1: baseline + fh * 0.25 });
    rects.push({ x0, y0: baseline + fh * 0.05, x1, y1: baseline + fh * 0.65 });
  }
  return rects;
}

// A real write-in blank has no printed text inside it; underlined words do.
function overlapsPrintedText(field, rects) {
  const fx0 = field.x;
  const fy0 = field.y;
  const fx1 = field.x + field.w;
  const fy1 = field.y + field.h;
  let hits = 0;
  for (const rect of rects) {
    const overlapX = Math.min(fx1, rect.x1) - Math.max(fx0, rect.x0);
    const overlapY = Math.min(fy1, rect.y1) - Math.max(fy0, rect.y0);
    if (overlapX > 0 && overlapY > 0) hits += 1;
    if (hits >= 1) return true;
  }
  return false;
}

function filterAndRotateFields(fields, rects, extraRotation = 0) {
  // Decide whether a guessed field covers printed wording in the PDF's
  // canonical orientation. Rotating both sides before this test introduces
  // rounding differences that can make a control appear or disappear.
  const filtered = fields.filter(field => field.native || !overlapsPrintedText(field, rects));
  return mergeFields(filtered.map(field => rotateGeometry(field, extraRotation)));
}

function fieldsForPage(viewport, canvas, pageNumber, annotations, textContent, extraRotation = 0, canonicalViewport = viewport, canonicalCanvas = canvas) {
  const fieldsFromAnnotations = annotationFields(annotations, canonicalViewport);
  const fieldDocument = currentFieldDocument();
  const needsFilter = fieldDocument?.pages?.[String(pageNumber)]?.length || (!fieldsFromAnnotations.length && !fieldDocument);
  if (!needsFilter && fieldsFromAnnotations.length) {
    return mergeFields(fieldsFromAnnotations.map(field => rotateGeometry(field, extraRotation)));
  }
  let detected;
  if (fieldDocument && Object.prototype.hasOwnProperty.call(fieldDocument.pages || {}, String(pageNumber))) {
    const catalogFields = fieldDocument.pages[String(pageNumber)] || [];
    detected = mergeFields([...fieldsFromAnnotations, ...catalogFields]);
  } else if (fieldsFromAnnotations.length) {
    return mergeFields(fieldsFromAnnotations.map(field => rotateGeometry(field, extraRotation)));
  } else {
    // Without extractable text there is no reliable way to distinguish an
    // empty square/line from a printed letter or border. Prefer no guessed
    // control to an overlay that hides lesson wording; native annotations and
    // a matching field catalog remain available on image-only pages.
    const hasPrintedText = (textContent.items || []).some(item => String(item.str || '').trim());
    detected = hasPrintedText ? detectedCanvasFields(canonicalCanvas) : [];
  }
  if (!detected.length) return [];
  const rects = printedTextRects(textContent, canonicalViewport);
  // Catalog/canvas guesses never sit on top of printed glyphs. Native AcroForm
  // widgets are authoritative even when their rectangle touches printed text.
  return filterAndRotateFields(detected, rects, extraRotation);
}

function createAnswerLayer(pageElement, fields, viewport, pageNumber) {
  const layer = document.createElement('div');
  layer.className = 'answerLayer';
  let visibleCount = 0;
  fields.forEach((field, index) => {
    const id = fieldId(pageNumber, field);
    const target = minimumTargetGeometry(field, viewport);
    answerState.fields[id] = { page: pageNumber, ...field };
    if (field.kind === 'check') {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'answerCheck';
      toggle.dataset.answerId = id;
      toggle.setAttribute('aria-label', `Marcar casilla ${index + 1} de la página ${pageNumber}`);
      toggle.setAttribute('aria-pressed', String(answerState.values[id] === '1'));
      if (answerState.values[id] === '1') toggle.classList.add('on');
      toggle.style.left = `${target.x * 100}%`;
      toggle.style.top = `${target.y * 100}%`;
      toggle.style.width = `${target.w * 100}%`;
      toggle.style.height = `${target.h * 100}%`;
      toggle.addEventListener('click', () => {
        const next = answerState.values[id] === '1' ? '' : '1';
        if (next) answerState.values[id] = next;
        else delete answerState.values[id];
        toggle.classList.toggle('on', Boolean(next));
        toggle.setAttribute('aria-pressed', String(Boolean(next)));
        saveAnswers();
      });
      layer.appendChild(toggle);
      visibleCount += 1;
      return;
    }
    const input = document.createElement('textarea');
    input.className = `answerField ${field.kind}`;
    input.dataset.answerId = id;
    input.rows = field.h > 0.055 ? 2 : 1;
    input.value = answerState.values[id] || '';
    input.setAttribute('aria-label', `Respuesta ${index + 1} de la página ${pageNumber}`);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'true');
    input.style.left = `${target.x * 100}%`;
    input.style.top = `${target.y * 100}%`;
    input.style.width = `${target.w * 100}%`;
    input.style.height = `${target.h * 100}%`;
    input.style.fontSize = `${Math.max(14, Math.min(22, viewport.height * 0.018))}px`;
    input.addEventListener('input', () => {
      answerState.values[id] = input.value;
      saveAnswers();
    });
    layer.appendChild(input);
    visibleCount += 1;
  });
  pageElement.appendChild(layer);
  pageElement.dataset.fieldCount = String(visibleCount);
  saveAnswers();
  if (pageNumber === pageNum) updateAnswerHint();
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value, location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function destinationPageNumber(destination) {
  try {
    const explicit = typeof destination === 'string' ? await pdfDoc.getDestination(destination) : destination;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const target = explicit[0];
    if (Number.isInteger(target)) return target + 1;
    return (await pdfDoc.getPageIndex(target)) + 1;
  } catch {
    return null;
  }
}

async function createPdfLinkLayer(pageElement, annotations, viewport, pageNumber) {
  const links = annotations.filter(annotation => Array.isArray(annotation.rect) && (annotation.url || annotation.dest));
  if (!links.length) return;
  const layer = document.createElement('div');
  layer.className = 'pdfLinkLayer';
  for (const [index, annotation] of links.entries()) {
    const geometry = minimumTargetGeometry(annotationRectangle(annotation.rect, viewport), viewport);
    const external = safeExternalUrl(annotation.url);
    const destination = external ? null : await destinationPageNumber(annotation.dest);
    if (!external && !destination) continue;
    const control = document.createElement(external ? 'a' : 'button');
    control.className = 'pdfLink';
    control.style.left = `${geometry.x * 100}%`;
    control.style.top = `${geometry.y * 100}%`;
    control.style.width = `${geometry.w * 100}%`;
    control.style.height = `${geometry.h * 100}%`;
    const label = annotation.title || (external ? 'Abrir enlace de la lección en otra pestaña' : `Ir a la página ${destination}`);
    control.title = label;
    control.setAttribute('aria-label', `${label}, página ${pageNumber}, enlace ${index + 1}`);
    if (external) {
      control.href = external;
      control.target = '_blank';
      control.rel = 'noopener noreferrer';
    } else {
      control.type = 'button';
      control.addEventListener('click', () => scrollToPage(destination));
    }
    layer.appendChild(control);
  }
  if (layer.childElementCount) pageElement.appendChild(layer);
}

function createAccessiblePageText(pageElement, canvas, textContent, pageNumber) {
  const parts = [];
  for (const item of textContent.items || []) {
    const text = String(item.str || '').trim();
    if (text) parts.push(text);
    if (item.hasEOL && parts.at(-1) !== '\n') parts.push('\n');
  }
  const normalized = parts.join(' ').replace(/\s*\n\s*/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const description = document.createElement('div');
  description.className = 'srOnly accessiblePageText';
  description.id = `accessible-page-${pageNumber}`;
  description.textContent = normalized
    ? `Texto de la página ${pageNumber}: ${normalized}`
    : `La página ${pageNumber} es una imagen sin texto seleccionable. Usa Texto más para ampliarla.`;
  canvas.setAttribute('aria-describedby', description.id);
  pageElement.appendChild(description);
  pageElement.dataset.hasAccessibleText = String(Boolean(normalized));
}

// Tap any Bible reference (Juan 3:16, Apoc. 14:6-12...) to read the full verse.
async function createVerseLayer(pageElement, viewport, pageNumber, textContent, extraRotation = 0) {
  if (typeof BibleVerses === 'undefined') return;
  // OCR-generated catalog covers lessons whose PDFs have no usable text layer.
  const verseDocument = verseCatalog.documents?.[`${cid}|${lesson?.id}`] ||
    verseCatalog.documents?.[`${cid}|${lesson?.legacyNumber}`];
  const catalogRefs = verseDocument && (!verseDocument.url || cleanPath(verseDocument.url) === cleanPath(lesson.url))
    ? verseDocument.pages?.[String(pageNumber)]
    : null;
  if (catalogRefs) {
    if (!catalogRefs.length) return;
    const layer = document.createElement('div');
    layer.className = 'verseLayer';
    const uniqueBooks = [...new Set(catalogRefs.map(entry => entry.bookId))];
    const bookData = new Map(await Promise.all(uniqueBooks.map(id => BibleVerses.fetchBook(id).then(data => [id, data]))));
    let rejected = 0;
    for (const originalEntry of catalogRefs) {
      const entry = rotateGeometry(originalEntry, extraRotation);
      const match = { bookId: entry.bookId, bookName: entry.bookName, parts: entry.parts };
      if (!BibleVerses.referenceIsValid(match, bookData.get(match.bookId))) {
        rejected += 1;
        continue;
      }
      const target = minimumTargetGeometry(entry, viewport);
      const hotspot = document.createElement('button');
      hotspot.type = 'button';
      hotspot.className = 'verseRef';
      hotspot.style.left = `${target.x * 100}%`;
      hotspot.style.top = `${target.y * 100}%`;
      hotspot.style.width = `${target.w * 100}%`;
      hotspot.style.height = `${target.h * 100}%`;
      const label = BibleVerses.formatReference(match);
      hotspot.title = label;
      hotspot.setAttribute('aria-label', `Leer ${label} en la Biblia (Reina-Valera 1960)`);
      hotspot.addEventListener('click', () => openVersePopup(match));
      layer.appendChild(hotspot);
    }
    pageElement.dataset.invalidVerseCount = String(rejected);
    pageElement.appendChild(layer);
    return;
  }
  const items = [];
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (fontHeight < 3) continue;
    items.push({ text: item.str, x: tx[4], y: tx[5] - fontHeight, w: item.width * viewport.scale, h: fontHeight });
  }
  if (!items.length) return;
  items.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines = [];
  for (const item of items) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(item.y - line.y) <= Math.max(2, item.h * 0.45)) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  const layer = document.createElement('div');
  layer.className = 'verseLayer';
  let lastBookId = '';
  const placements = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    const spans = [];
    for (const item of line.items) {
      if (spans.length) {
        const prev = spans[spans.length - 1];
        const gap = item.x - (prev.x + prev.w);
        if (gap > item.h * 0.18 && !text.endsWith(' ') && !item.text.startsWith(' ')) text += ' ';
      }
      spans.push({ ...item, start: text.length });
      text += item.text;
    }
    const lineHeight = Math.max(...line.items.map(item => item.h));
    const normalized = BibleVerses.normalizeExtracted(text);
    for (const match of BibleVerses.findReferences(normalized.text, lastBookId)) {
      lastBookId = match.bookId;
      const rawStart = normalized.map[match.index];
      const rawEnd = normalized.map[Math.min(match.end, normalized.map.length - 1)];
      const first = spans.find(span => span.start + span.text.length > rawStart);
      const last = [...spans].reverse().find(span => span.start < rawEnd);
      if (!first || !last) continue;
      const startX = first.x + first.w * Math.max(0, Math.min(1, (rawStart - first.start) / first.text.length));
      const endX = last.x + last.w * Math.max(0, Math.min(1, (rawEnd - last.start) / last.text.length));
      if (endX - startX < 6) continue;
      placements.push({ match, line, lineHeight, startX, endX });
    }
  }
  const uniqueBooks = [...new Set(placements.map(p => p.match.bookId))];
  const bookData = new Map(await Promise.all(uniqueBooks.map(id => BibleVerses.fetchBook(id).then(data => [id, data]))));
  let count = 0;
  for (const placement of placements) {
    const { match, line, lineHeight, startX, endX } = placement;
    const data = bookData.get(match.bookId);
    // Keep only the parts that really exist (PDF extraction sometimes merges digits).
    match.parts = match.parts.filter(part => BibleVerses.referenceIsValid({ ...match, parts: [part] }, data));
    if (!match.parts.length) continue;
    const target = minimumTargetGeometry({
      x: startX / viewport.width,
      y: line.y / viewport.height,
      w: (endX - startX) / viewport.width,
      h: Math.max(lineHeight, 10) / viewport.height
    }, viewport);
    const hotspot = document.createElement('button');
    hotspot.type = 'button';
    hotspot.className = 'verseRef';
    hotspot.style.left = `${target.x * 100}%`;
    hotspot.style.top = `${target.y * 100}%`;
    hotspot.style.width = `${target.w * 100}%`;
    hotspot.style.height = `${target.h * 100}%`;
    const label = BibleVerses.formatReference(match);
    hotspot.title = label;
    hotspot.setAttribute('aria-label', `Leer ${label} en la Biblia (Reina-Valera 1960)`);
    hotspot.addEventListener('click', () => openVersePopup(match));
    layer.appendChild(hotspot);
    count += 1;
  }
  if (count) pageElement.appendChild(layer);
}

let verseModal = null;
let verseReturnFocus = null;

function ensureVerseModal() {
  if (verseModal) return verseModal;
  const modal = document.createElement('div');
  modal.className = 'verseModal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="verseCard" role="dialog" aria-modal="true" aria-labelledby="verseTitle">
      <h2 class="verseTitle" id="verseTitle"></h2>
      <div class="verseText" id="verseText" aria-live="polite"></div>
      <p class="verseVersion">Reina-Valera 1960</p>
      <div class="verseActions">
        <button type="button" class="wBtn" id="verseCopy">Copiar</button>
        <button type="button" class="wBtn primaryTool" id="verseClose">Cerrar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => {
    modal.hidden = true;
    const target = verseReturnFocus;
    verseReturnFocus = null;
    if (target?.isConnected) target.focus();
  };
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  modal.querySelector('#verseClose').addEventListener('click', close);
  modal.querySelector('#verseCopy').addEventListener('click', event => {
    const text = `${modal.querySelector('#verseTitle').textContent}\n${modal.querySelector('#verseText').innerText}\nReina-Valera 1960`;
    navigator.clipboard?.writeText(text).then(() => {
      event.target.textContent = 'Copiado';
      setTimeout(() => { event.target.textContent = 'Copiar'; }, 1600);
    }).catch(() => {});
  });
  document.addEventListener('keydown', event => {
    if (modal.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...modal.querySelectorAll('button:not([disabled]), a[href]')];
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
  verseModal = modal;
  return modal;
}

async function openVersePopup(ref) {
  const modal = ensureVerseModal();
  const title = modal.querySelector('#verseTitle');
  const body = modal.querySelector('#verseText');
  title.textContent = BibleVerses.formatReference(ref);
  body.textContent = 'Buscando el texto...';
  verseReturnFocus = document.activeElement;
  modal.hidden = false;
  modal.querySelector('#verseClose').focus();
  const blocks = await BibleVerses.resolveReference(ref, 'assets/bible/rvr1960/');
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
      const p = document.createElement('p');
      const number = document.createElement('sup');
      number.textContent = String(line.verse);
      p.append(number, document.createTextNode(` ${line.text}`));
      body.appendChild(p);
    }
  }
  if (!any) body.textContent = 'No se encontró este texto. Revisa la cita en la lección.';
}

function loadingElement(pageNumber) {
  const loading = document.createElement('span');
  loading.className = 'pageLoading';
  loading.textContent = `Cargando página ${pageNumber}...`;
  return loading;
}

function pageElement(metric) {
  const page = document.createElement('div');
  page.className = 'pg';
  page.dataset.pageNumber = String(metric.number);
  page.dataset.rotation = String(metric.extraRotation || 0);
  page.dataset.rendered = 'false';
  page.style.width = `${metric.width}px`;
  page.style.height = `${metric.height}px`;
  page.setAttribute('role', 'group');
  page.setAttribute('aria-label', 'P\u00e1gina ' + metric.number + ' de ' + pdfDoc.numPages + (metric.extraRotation ? ', girada ' + metric.extraRotation + ' grados' : ''));
  page.appendChild(loadingElement(metric.number));
  return page;
}

function cancelRenderTasks() {
  for (const task of renderTasks.values()) task.cancel();
  renderTasks = new Map();
}

async function renderCanonicalFieldCanvas(page, rotation) {
  const unitViewport = page.getViewport({ scale: 1, rotation });
  const scale = 1200 / Math.max(1, unitViewport.width);
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

function updateAnswerHint() {
  const hint = document.getElementById('answerHint');
  const current = document.querySelector(`.pg[data-page-number="${pageNum}"]`);
  if (!current || current.dataset.rendered !== 'true') {
    hint.textContent = (pdfDoc?.numPages || 1) > 1
      ? `Página ${pageNum} de ${pdfDoc.numPages}. Desliza hacia abajo para continuar.`
      : 'Cargando la página...';
    return;
  }
  const visibleCount = Number(current.dataset.fieldCount || 0);
  hint.textContent = visibleCount
    ? `${visibleCount} ${visibleCount === 1 ? 'espacio listo' : 'espacios listos'} para escribir en esta página.`
    : 'Esta página no tiene espacios de respuesta detectados.';
}

async function renderPageElement(element, sequence) {
  if (!pdfDoc || sequence !== renderSequence || element.dataset.rendered === 'true' || element.dataset.rendering === 'true') return;
  const pageNumber = Number(element.dataset.pageNumber);
  const metric = pageMetrics[pageNumber - 1];
  if (!metric) return;
  element.dataset.rendering = 'true';
  const page = await pdfDoc.getPage(pageNumber);
  if (sequence !== renderSequence || element.dataset.rendering !== 'true') return;
  const viewport = page.getViewport({ scale: metric.scale, rotation: metric.rotation });
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.className = 'pdfCanvas';
  canvas.width = Math.ceil(viewport.width * dpr);
  canvas.height = Math.ceil(viewport.height * dpr);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Contenido de la página ${pageNumber}`);
  element.replaceChildren(canvas);
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const task = page.render({ canvasContext: context, viewport });
  renderTasks.set(pageNumber, task);
  try {
    await task.promise;
  } catch (error) {
    if (error?.name === 'RenderingCancelledException') return;
    throw error;
  } finally {
    if (renderTasks.get(pageNumber) === task) renderTasks.delete(pageNumber);
  }
  if (sequence !== renderSequence || element.dataset.rendering !== 'true' || !element.isConnected) return;
  const [annotations, textContent] = await Promise.all([
    page.getAnnotations({ intent: 'display' }),
    page.getTextContent()
  ]);
  const canonicalRotation = ((metric.rotation - metric.extraRotation) % 360 + 360) % 360;
  const canonicalViewport = page.getViewport({ scale: metric.scale, rotation: canonicalRotation });
  const fieldDocument = currentFieldDocument();
  const hasCatalogPage = Boolean(fieldDocument && Object.prototype.hasOwnProperty.call(fieldDocument.pages || {}, String(pageNumber)));
  const hasNativeFields = annotationFields(annotations, canonicalViewport).length > 0;
  const hasPrintedText = (textContent.items || []).some(item => String(item.str || '').trim());
  let canonicalCanvas = canvas;
  if (metric.extraRotation && !hasCatalogPage && !hasNativeFields && hasPrintedText) {
    canonicalCanvas = await renderCanonicalFieldCanvas(page, canonicalRotation);
  }
  const fields = fieldsForPage(
    viewport,
    canvas,
    pageNumber,
    annotations,
    textContent,
    metric.extraRotation,
    canonicalViewport,
    canonicalCanvas
  );
  if (sequence !== renderSequence || element.dataset.rendering !== 'true' || !element.isConnected) return;
  createAnswerLayer(element, fields, viewport, pageNumber);
  await createPdfLinkLayer(element, annotations, viewport, pageNumber);
  createAccessiblePageText(element, canvas, textContent, pageNumber);
  await createVerseLayer(element, viewport, pageNumber, textContent, metric.extraRotation).catch(() => {});
  element.dataset.rendered = 'true';
  element.dataset.rendering = 'false';
  if (Math.abs(pageNumber - pageNum) > 3) {
    unrenderPageElement(element);
    return;
  }
  if (pageNumber === pageNum) updateAnswerHint();
}

function unrenderPageElement(element) {
  if (element.contains(document.activeElement)) return;
  const pageNumber = Number(element.dataset.pageNumber);
  renderTasks.get(pageNumber)?.cancel();
  renderTasks.delete(pageNumber);
  element.dataset.rendered = 'false';
  element.dataset.rendering = 'false';
  delete element.dataset.fieldCount;
  element.replaceChildren(loadingElement(pageNumber));
}

function trimDistantPages() {
  document.querySelectorAll('.pg').forEach(element => {
    const isLoaded = element.dataset.rendered === 'true' || element.dataset.rendering === 'true';
    if (Math.abs(Number(element.dataset.pageNumber) - pageNum) > 3 && isLoaded) {
      unrenderPageElement(element);
    }
  });
}

function renderNearbyPages() {
  const sequence = renderSequence;
  document.querySelectorAll('.pg').forEach(element => {
    if (Math.abs(Number(element.dataset.pageNumber) - pageNum) <= 3) {
      renderPageElement(element, sequence).catch(() => {});
    }
  });
}

function updateCurrentPageFromScroll() {
  scrollFrame = null;
  const area = document.getElementById('pdfArea');
  const areaRect = area.getBoundingClientRect();
  const navHeight = document.querySelector('.pdfNav')?.offsetHeight || 0;
  const targetY = areaRect.top + navHeight + Math.max(80, (areaRect.height - navHeight) * 0.35);
  let nearest = null;
  if (area.scrollTop <= 2) {
    nearest = { element: document.querySelector('.pg'), distance: 0 };
  } else if (area.scrollTop + area.clientHeight >= area.scrollHeight - 2) {
    nearest = { element: document.querySelector('.pg:last-child'), distance: 0 };
  } else {
    document.querySelectorAll('.pg').forEach(element => {
      const rect = element.getBoundingClientRect();
      const distance = targetY < rect.top ? rect.top - targetY : targetY > rect.bottom ? targetY - rect.bottom : 0;
      if (!nearest || distance < nearest.distance) nearest = { element, distance };
    });
  }
  if (nearest) {
    const nextPage = Number(nearest.element.dataset.pageNumber);
    if (nextPage !== pageNum) {
      pageNum = nextPage;
      updatePageNavigation();
      updateAnswerHint();
    }
  }
  trimDistantPages();
  renderNearbyPages();
}

function scheduleCurrentPageUpdate() {
  if (scrollFrame !== null) return;
  scrollFrame = requestAnimationFrame(updateCurrentPageFromScroll);
}

function scrollToPage(number, behavior = 'smooth') {
  if (!pdfDoc) return;
  pageNum = Math.max(1, Math.min(pdfDoc.numPages, number));
  const area = document.getElementById('pdfArea');
  const target = document.querySelector(`.pg[data-page-number="${pageNum}"]`);
  if (!target) return;
  const areaRect = area.getBoundingClientRect();
  const targetTop = target.getBoundingClientRect().top - areaRect.top + area.scrollTop;
  const navHeight = document.querySelector('.pdfNav')?.offsetHeight || 0;
  area.scrollTo({ top: Math.max(0, targetTop - navHeight - 8), left: area.scrollLeft, behavior });
  updatePageNavigation();
  updateAnswerHint();
}

async function buildPageStack({ preservePage = false } = {}) {
  if (!pdfDoc) return;
  const area = document.getElementById('pdfArea');
  area.dataset.allowHorizontalScroll = String(zoomFactor > 1);
  const box = document.getElementById('pdfBox');
  const anchor = preservePage ? document.querySelector(`.pg[data-page-number="${pageNum}"]`) : null;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - area.getBoundingClientRect().top : 0;
  cancelRenderTasks();
  renderObserver?.disconnect();
  const sequence = ++renderSequence;
  const fitWidth = Math.min(1000, Math.max(260, area.clientWidth - 24));
  const metrics = await Promise.all(Array.from({ length: pdfDoc.numPages }, async (_, index) => {
    const number = index + 1;
    const page = await pdfDoc.getPage(number);
    const extraRotation = Number(pageRotations[String(number)] || 0);
    const rotation = (Number(page.rotate || 0) + extraRotation) % 360;
    const baseViewport = page.getViewport({ scale: 1, rotation });
    const scale = fitWidth / baseViewport.width * zoomFactor;
    const viewport = page.getViewport({ scale, rotation });
    return { number, scale, rotation, extraRotation, width: viewport.width, height: viewport.height };
  }));
  if (sequence !== renderSequence) return;
  pageMetrics = metrics;
  const fragment = document.createDocumentFragment();
  metrics.forEach(metric => fragment.appendChild(pageElement(metric)));
  box.replaceChildren(fragment);
  renderObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) renderPageElement(entry.target, sequence).catch(() => {});
    });
  }, { root: area, rootMargin: '75% 0px' });
  box.querySelectorAll('.pg').forEach(element => renderObserver.observe(element));
  if (preservePage) {
    const nextAnchor = document.querySelector(`.pg[data-page-number="${pageNum}"]`);
    if (nextAnchor) {
      const nextOffset = nextAnchor.getBoundingClientRect().top - area.getBoundingClientRect().top;
      area.scrollTop += nextOffset - anchorOffset;
    }
  } else {
    area.scrollTop = 0;
    area.scrollLeft = 0;
  }
  lastAreaWidth = area.clientWidth;
  updatePageNavigation();
  updateAnswerHint();
  scheduleCurrentPageUpdate();
}

function updatePageNavigation() {
  const total = pdfDoc?.numPages || 1;
  document.getElementById('pgCount').textContent = `${pageNum} de ${total}`;
  document.getElementById('pgPrev').disabled = pageNum <= 1;
  document.getElementById('pgNext').disabled = !pdfDoc || pageNum >= pdfDoc.numPages;
  document.querySelector('.pdfNav').hidden = total <= 1;
  document.getElementById('scrollHint').hidden = total <= 1;
  document.getElementById('zoomOut').disabled = zoomFactor <= MIN_ZOOM;
  document.getElementById('zoomIn').disabled = zoomFactor >= MAX_ZOOM;
  document.getElementById('zoomValue').textContent = `${Math.round(zoomFactor * 100)}%`;
}

async function setZoom(value) {
  zoomFactor = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 20) / 20));
  try { localStorage.setItem(ZOOM_KEY, String(zoomFactor)); } catch {}
  await buildPageStack({ preservePage: true });
}

async function rotateCurrentPage() {
  if (!pdfDoc) return;
  const button = document.getElementById('rotatePage');
  if (button.dataset.busy) return;
  const targetPage = pageNum;
  const key = String(targetPage);
  button.dataset.busy = '1';
  button.disabled = true;
  try {
    pageRotations[key] = (Number(pageRotations[key] || 0) + 90) % 360;
    if (!pageRotations[key]) delete pageRotations[key];
    saveRotations();
    await buildPageStack({ preservePage: true });
    pageNum = targetPage;
    scrollToPage(targetPage, 'auto');
    document.getElementById('answerHint').textContent = 'P\u00e1gina ' + targetPage + ' girada ' + Number(pageRotations[key] || 0) + ' grados.';
  } finally {
    button.disabled = false;
    delete button.dataset.busy;
  }
}

async function loadPdf(url) {
  pdfDoc = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
  pageNum = 1;
  await buildPageStack();
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
  const x = field.x * width;
  const y = field.y * height;
  const boxWidth = field.w * width;
  const boxHeight = field.h * height;
  if (field.kind === 'check') {
    if (text !== '1') return;
    context.save();
    context.fillStyle = '#0A6BCE';
    context.font = `800 ${Math.max(14, boxHeight * 1.1)}px -apple-system, Arial, sans-serif`;
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    context.fillText('✓', x + boxWidth / 2, y + boxHeight / 2);
    context.restore();
    return;
  }
  if (!text) return;
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
      const rotation = (Number(page.rotate || 0) + Number(pageRotations[String(number)] || 0)) % 360;
      const sourceViewport = page.getViewport({ scale: 1, rotation });
      const renderViewport = page.getViewport({ scale: 1.7, rotation });
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

function syncVisibleAnswers() {
  document.querySelectorAll('.answerField[data-answer-id]').forEach(input => {
    input.value = answerState.values[input.dataset.answerId] || '';
  });
  document.querySelectorAll('.answerCheck[data-answer-id]').forEach(toggle => {
    const on = answerState.values[toggle.dataset.answerId] === '1';
    toggle.classList.toggle('on', on);
    toggle.setAttribute('aria-pressed', String(on));
  });
}

function clearOrRestoreAnswers() {
  const button = document.getElementById('clearAnswers');
  if (clearBackup) {
    answerState = clearBackup;
    clearBackup = null;
    clearTimeout(clearTimer);
    button.textContent = 'Borrar respuestas';
    saveAnswers();
    syncVisibleAnswers();
    return;
  }
  if (!Object.values(answerState.values).some(Boolean)) return;
  clearBackup = structuredClone(answerState);
  answerState.values = {};
  saveAnswers();
  button.textContent = 'Deshacer borrado';
  syncVisibleAnswers();
  clearTimer = setTimeout(() => {
    clearBackup = null;
    button.textContent = 'Borrar respuestas';
  }, 10000);
}

async function init() {
  const [catalogResponse, fieldsResponse, versesResponse] = await Promise.all([
    fetch('/api/catalog', { cache: 'no-store' }),
    fetch('/assets/answer-fields.json', { cache: 'no-store' }).catch(() => null),
    fetch('/assets/verse-fields.json', { cache: 'no-store' }).catch(() => null)
  ]);
  if (!catalogResponse.ok) throw new Error('catalog');
  const data = await catalogResponse.json();
  if (fieldsResponse?.ok) fieldCatalog = await fieldsResponse.json();
  if (versesResponse?.ok) verseCatalog = await versesResponse.json();
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
  document.getElementById('count').textContent = soloMode ? '' : `${index + 1} / ${lessons.length}`;
  document.getElementById('prev').style.visibility = index <= 0 || soloMode ? 'hidden' : 'visible';
  document.getElementById('next').style.visibility = index >= lessons.length - 1 || soloMode ? 'hidden' : 'visible';
  const original = document.getElementById('downloadOriginal');
  original.href = lesson.downloadUrl || lesson.url;
  original.setAttribute('download', lesson.originalName || `${lesson.title}.pdf`);
  original.hidden = false;
  loadAnswers();
  loadRotations();
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
document.getElementById('pgPrev').onclick = () => scrollToPage(pageNum - 1);
document.getElementById('pgNext').onclick = () => scrollToPage(pageNum + 1);
document.getElementById('zoomOut').onclick = () => setZoom(zoomFactor - 0.2).catch(() => {});
document.getElementById('zoomIn').onclick = () => setZoom(zoomFactor + 0.2).catch(() => {});
document.getElementById('zoomFit').onclick = () => setZoom(1).catch(() => {});
document.getElementById('rotatePage').onclick = () => rotateCurrentPage().catch(() => {});
document.getElementById('clearAnswers').onclick = clearOrRestoreAnswers;
document.getElementById('savePdf').onclick = () => saveAnsweredPdf().catch(() => {
  document.getElementById('answerHint').textContent = 'No se pudo crear el PDF. Intenta otra vez.';
});
document.getElementById('pdfArea').addEventListener('wheel', event => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  setZoom(zoomFactor + (event.deltaY < 0 ? 0.15 : -0.15)).catch(() => {});
}, { passive: false });
document.getElementById('pdfArea').addEventListener('scroll', scheduleCurrentPageUpdate, { passive: true });

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const area = document.getElementById('pdfArea');
    if (document.activeElement?.classList.contains('answerField')) return;
    if (Math.abs(area.clientWidth - lastAreaWidth) > 24) buildPageStack({ preservePage: true }).catch(() => {});
  }, 180);
});

init().catch(error => {
  console.error('No se pudo cargar el lector.', error?.stack || error);
  const message = document.createElement('p');
  message.className = 'emptyMsg';
  message.textContent = 'No se pudo cargar la lección. Intenta recargar la página.';
  document.getElementById('pdfBox').replaceChildren(message);
});
