const pageParams = new URLSearchParams(location.search);
const sharedView = pageParams.has('s');
const shareId = pageParams.getAll('s').length === 1 ? pageParams.get('s') : '';
const DATA_URL = sharedView ? `/api/catalog?s=${encodeURIComponent(shareId || '')}` : '/api/catalog';
const SECTIONS = [
  { id: 'cursos', title: 'Cursos Bíblicos', english: 'Bible courses' },
  { id: 'lafe', title: 'La Fe de Jesús (PowerPoint)', english: 'La Fe de Jesús (PowerPoint)' }
];
let DATA = null;
let loadFailed = false;
let archiveBytes = null;
let archiveInfoFailed = false;
let downloadRequested = false;
const t = (es, en, values = {}) => globalThis.CourseUI?.t(es, en, values) || es.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

function localizeHome() {
  document.title = sharedView ? t('Lecciones compartidas · Cursos Bíblicos', 'Shared lessons · Cursos Bíblicos') : t('Cursos bíblicos gratis en español | Cursos Bíblicos', 'Free Bible courses in Spanish | Cursos Bíblicos');
  if (sharedView) document.getElementById('homeTitle').textContent = t('Lecciones compartidas contigo', 'Lessons shared with you');
  else document.getElementById('homeTitle').textContent = t('Cursos Bíblicos', 'Bible courses');
  document.getElementById('sharedNotice').hidden = !sharedView;
  document.getElementById('sharedNotice').textContent = t('Estas son las lecciones que eligieron compartir contigo.', 'These are the lessons selected to share with you.');
  document.getElementById('search').placeholder = sharedView ? t('Buscar en esta selección', 'Search this selection') : t('Buscar curso', 'Search courses');
  document.getElementById('shareCatalog').textContent = t('Compartir cursos', 'Share courses');
  const download = document.getElementById('dlBtn');
  download.textContent = t('Descargar todos los cursos', 'Download all courses');
  updateArchiveInfo();
}
localizeHome();

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function readableTextColor(background) {
  const match = String(background || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return '#000';
  const channels = [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;
  return blackContrast >= whiteContrast ? '#000' : '#fff';
}

function updateArchiveInfo() {
  const estimate = document.getElementById('downloadEstimate');
  const status = document.getElementById('downloadStatus');
  if (!estimate || !status || sharedView || !DATA?.zip) return;
  estimate.hidden = !downloadRequested;
  if (archiveBytes) {
    const size = Math.max(1, Math.round(archiveBytes / 1_000_000));
    // Estimate transfer at 8 to 20 Mbps, with the connection assumption visible.
    const fast = Math.max(1, Math.ceil(archiveBytes * 8 / 20_000_000 / 60));
    const slow = Math.max(fast, Math.ceil(archiveBytes * 8 / 8_000_000 / 60));
    const time = fast === slow ? String(fast) : t('{fast} a {slow}', '{fast} to {slow}', { fast, slow });
    estimate.textContent = t('{size} MB · aprox. {time} min con buen Wi-Fi. Puede tardar más.',
      '{size} MB · about {time} min on good Wi-Fi. It may take longer.', { size, time });
  } else {
    estimate.textContent = archiveInfoFailed
      ? t('El tiempo depende de tu conexión.', 'Download time depends on your connection.')
      : t('Calculando tamaño y tiempo estimado...', 'Checking size and estimated time...');
  }
  status.hidden = !downloadRequested;
  if (downloadRequested) status.textContent = t(
    'Si aparece una confirmación, toca Descargar. Puedes ver el progreso en las descargas de tu navegador.',
    'If a confirmation appears, tap Download. You can follow progress in your browser’s downloads.');
}

async function loadArchiveInfo(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    const bytes = Number(response.headers.get('Content-Length'));
    if (!response.ok || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('size unavailable');
    archiveBytes = bytes;
  } catch (_) {
    archiveInfoFailed = true;
  } finally {
    clearTimeout(timeout);
    updateArchiveInfo();
  }
}

function makeCard(course) {
  const link = document.createElement('a');
  link.className = `card${course.coverUrl ? ' hasCover' : ''}`;
  link.href = !sharedView && globalThis.CourseSEO ? globalThis.CourseSEO.coursePath(course, DATA?.courses || []) : `curso.html?c=${encodeURIComponent(course.id)}`;
  if (sharedView) link.href += `&s=${encodeURIComponent(shareId || '')}`;
  if (course.coverUrl) {
    const cover = document.createElement('div');
    cover.className = 'coverArt';
    cover.style.backgroundImage = `url("${course.coverUrl}")`;
    cover.setAttribute('role', 'img');
    cover.setAttribute('aria-label', t('Portada de {name}', 'Cover of {name}', { name: course.name }));
    link.appendChild(cover);
  } else {
    const tile = textElement('div', 'tile', course.short);
    tile.style.background = course.color;
    tile.style.color = readableTextColor(course.color);
    link.appendChild(tile);
  }
  const copy = document.createElement('div');
  copy.appendChild(textElement('div', 'name', course.name));
  copy.appendChild(textElement('div', 'meta', course.lessons.length === 1 ? t('1 lección', '1 lesson') : t('{n} lecciones', '{n} lessons', { n: course.lessons.length })));
  link.appendChild(copy);
  return link;
}

function render(courses) {
  const wrap = document.getElementById('sections');
  const empty = document.getElementById('empty');
  wrap.replaceChildren();
  if (!courses.length) {
    empty.style.display = '';
    empty.textContent = t('Ningún curso coincide con "{query}".', 'No courses match "{query}".', { query: document.getElementById('search').value });
    return;
  }
  empty.style.display = 'none';
  for (const section of SECTIONS) {
    const list = courses.filter(course => (course.section || 'cursos') === section.id);
    if (!list.length) continue;
    const container = textElement('section', 'catalogSection');
    const header = textElement('div', 'catalogSectionHead');
    const title = t(section.title, section.english);
    const heading = textElement('h2', 'secHead', title);
    heading.id = `section-${section.id}`;
    container.setAttribute('aria-labelledby', heading.id);
    header.appendChild(heading);
    const controls = textElement('div', 'catalogRowControls');
    const row = textElement('div', 'courseRail');
    row.id = `row-${section.id}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'region');
    row.setAttribute('aria-labelledby', heading.id);
    const arrows = [-1, 1].map(direction => {
      const arrow = textElement('button', 'catalogRowArrow', '');
      arrow.type = 'button';
      arrow.setAttribute('data-direction', direction < 0 ? 'previous' : 'next');
      arrow.setAttribute('aria-controls', row.id);
      arrow.setAttribute('aria-label', direction < 0 ? t('Cursos anteriores en {section}', 'Previous courses in {section}', { section: title }) : t('Más cursos en {section}', 'More courses in {section}', { section: title }));
      arrow.addEventListener('click', () => move(direction));
      controls.appendChild(arrow);
      return arrow;
    });
    function move(direction) {
      row.scrollBy({ left: direction * Math.max(220, row.clientWidth * 0.85), behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    function updateArrows() {
      const end = row.scrollWidth - row.clientWidth;
      controls.hidden = end <= 1;
      arrows[0].disabled = row.scrollLeft <= 1;
      arrows[1].disabled = row.scrollLeft >= end - 1;
    }
    row.addEventListener('scroll', updateArrows, { passive: true });
    row.addEventListener('keydown', event => {
      if (event.target !== row || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    });
    list.forEach(course => row.appendChild(makeCard(course)));
    header.appendChild(controls);
    container.appendChild(header);
    container.appendChild(row);
    wrap.appendChild(container);
    globalThis.requestAnimationFrame?.(updateArrows);
    if (globalThis.ResizeObserver) {
      const observer = new ResizeObserver(() => {
        if (!row.isConnected) observer.disconnect();
        else updateArrows();
      });
      observer.observe(row);
    }
  }
}

async function load() {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error('catalog unavailable');
  DATA = await response.json();
  const download = document.getElementById('dlBtn');
  if (DATA.zip && !sharedView) {
    download.href = DATA.zip;
    download.hidden = false;
    updateArchiveInfo();
    void loadArchiveInfo(DATA.zip);
    download.addEventListener('click', () => {
      // Keep the native attachment download in the original tap; never buffer the ZIP.
      downloadRequested = true;
      updateArchiveInfo();
    });
  }
  const shareButton = document.getElementById('shareCatalog');
  shareButton.disabled = !DATA.courses.some(course => course.lessons.length);
  shareButton.onclick = () => window.CourseShare.select({ courses: DATA.courses, title: 'Cursos Bíblicos', sharePage: true });
  render(DATA.courses);
}

function filterCourses() {
  if (!DATA) return;
  const query = document.getElementById('search').value.trim().toLocaleLowerCase(globalThis.CourseUI?.language || 'es');
  render(DATA.courses.filter(course =>
    course.name.toLocaleLowerCase('es').includes(query) || String(course.short || '').toLocaleLowerCase('es').includes(query)
  ));
}
document.getElementById('search').addEventListener('input', filterCourses);

function showLoadError() {
  document.getElementById('sections').replaceChildren(textElement('p', 'empty', sharedView
    ? t('Este enlace compartido no está disponible. Pide un nuevo enlace a quien te lo envió.', 'This shared link is unavailable. Ask the sender for a new link.')
    : t('No se pudo cargar el catálogo. Intenta recargar la página.', 'The catalog could not load. Try refreshing the page.')));
}
globalThis.addEventListener?.('course-language-change', () => {
  localizeHome();
  if (loadFailed) showLoadError();
  else filterCourses();
});
load().catch(() => {
  loadFailed = true;
  showLoadError();
});
