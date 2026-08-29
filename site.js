const DATA_URL = '/api/catalog';
const SECTIONS = [
  { id: 'cursos', title: 'Cursos Bíblicos' },
  { id: 'lafe', title: 'La Fe de Jesús (PowerPoint)' }
];
let DATA = null;

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

async function shareDownload(url, name, button) {
  if (button.dataset.busy) return;
  button.dataset.busy = '1';
  const label = button.textContent;
  button.textContent = 'Preparando descarga...';
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    const file = new File([blob], name, { type: blob.type || 'application/zip' });
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: name });
    } else {
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
    }
  } catch (error) {
    if (error?.name !== 'AbortError') window.open(url, '_blank', 'noopener');
  } finally {
    button.textContent = label;
    delete button.dataset.busy;
  }
}

function makeCard(course) {
  const link = document.createElement('a');
  link.className = `card${course.coverUrl ? ' hasCover' : ''}`;
  link.href = `curso.html?c=${encodeURIComponent(course.id)}`;
  if (course.coverUrl) {
    const cover = document.createElement('div');
    cover.className = 'coverArt';
    cover.style.backgroundImage = `url("${course.coverUrl}")`;
    cover.setAttribute('role', 'img');
    cover.setAttribute('aria-label', `Portada de ${course.name}`);
    link.appendChild(cover);
  } else {
    const tile = textElement('div', 'tile', course.short);
    tile.style.background = course.color;
    tile.style.color = readableTextColor(course.color);
    link.appendChild(tile);
  }
  const copy = document.createElement('div');
  copy.appendChild(textElement('div', 'name', course.name));
  copy.appendChild(textElement('div', 'meta', `${course.lessons.length} lecciones`));
  link.appendChild(copy);
  return link;
}

function render(courses) {
  const wrap = document.getElementById('sections');
  const empty = document.getElementById('empty');
  wrap.replaceChildren();
  if (!courses.length) {
    empty.style.display = '';
    empty.textContent = `Ningún curso coincide con "${document.getElementById('search').value}".`;
    return;
  }
  empty.style.display = 'none';
  for (const section of SECTIONS) {
    const list = courses.filter(course => (course.section || 'cursos') === section.id);
    if (!list.length) continue;
    wrap.appendChild(textElement('h3', 'secHead', section.title));
    const grid = document.createElement('div');
    grid.className = 'grid';
    list.forEach(course => grid.appendChild(makeCard(course)));
    wrap.appendChild(grid);
  }
}

async function load() {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error('No se pudo cargar el catálogo.');
  DATA = await response.json();
  const startingCourse = DATA.courses.find(course => String(course.id) === '1')
    || DATA.courses.find(course => (course.section || 'cursos') === 'cursos')
    || DATA.courses[0];
  if (startingCourse) {
    const start = document.getElementById('startBtn');
    start.href = `curso.html?c=${encodeURIComponent(startingCourse.id)}`;
    start.textContent = `Comenzar con ${startingCourse.name}`;
    start.hidden = false;
  }
  const download = document.getElementById('dlBtn');
  if (DATA.zip) {
    download.href = DATA.zip;
    download.hidden = false;
    document.getElementById('homeArchive').hidden = false;
    document.getElementById('archiveNote').hidden = false;
    download.addEventListener('click', event => {
      event.preventDefault();
      shareDownload(DATA.zip, 'Cursos Bíblicos - catálogo original.zip', download);
    });
  }
  render(DATA.courses);
}

document.getElementById('search').addEventListener('input', event => {
  if (!DATA) return;
  const query = event.target.value.trim().toLocaleLowerCase('es');
  render(DATA.courses.filter(course =>
    course.name.toLocaleLowerCase('es').includes(query) || course.short.toLocaleLowerCase('es').includes(query)
  ));
});

load().catch(() => {
  document.getElementById('sections').replaceChildren(textElement('p', 'empty', 'No se pudo cargar el catálogo. Intenta recargar la página.'));
});
