const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.HOME_TEST_ROOT || path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('the published photographic homepage has its own stylesheet without changing reader styles', () => {
  const home = read('index.html');
  assert.match(home, /<link[^>]+href="home\.css"/);
  assert.match(home, /class="homeHeroImage"[^>]+src="assets\/course-covers\/fe-de-jesus\.webp"/);
  assert.match(home, /<h1[^>]*>Estudia la Biblia<br>\s*a tu ritmo<\/h1>/);
  assert.match(home, /<label[^>]+for="search"/);
  for (const page of ['curso.html', 'leer.html', 'presentacion.html']) {
    const html = read(page);
    assert.match(html, /href="styles\.css"/);
    assert.doesNotMatch(html, /href="home\.css"/);
  }
  const css = read('home.css');
  assert.match(css, /\.homeHeroImage\s*\{[^}]*object-fit:\s*cover/);
  assert.match(css, /\.homeHero h1\s*\{[^}]*color:\s*#fff/);
  assert.doesNotMatch(css, /\.answerField|\.readerNav|\.pdfArea/);
});

function domElement(tagName) {
  return {
    tagName, style: {}, dataset: {}, attributes: {}, children: [], listeners: {}, hidden: true,
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, listener) { this.listeners[name] = listener; }
  };
}

async function homepage() {
  const elements = Object.fromEntries(['sections', 'empty', 'search', 'dlBtn'].map(id => [id, domElement('div')]));
  elements.search.value = '';
  let deliver;
  const response = new Promise(resolve => { deliver = resolve; });
  const context = {
    document: { createElement: domElement, getElementById: id => elements[id] },
    fetch: () => response
  };
  vm.createContext(context);
  vm.runInContext(read('site.js'), context);
  return {
    elements,
    async load(catalog) {
      deliver({ ok: true, json: async () => catalog });
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

const catalog = {
  zip: 'https://example.com/original.zip',
  courses: [
    { id: '1', name: 'Fe de Jesús', short: 'FJ', color: '#0071E3', section: 'cursos', coverUrl: '/assets/course-covers/fe-de-jesus.webp', lessons: [{}] },
    { id: '2', name: 'La Gran Esperanza', short: 'GE', color: '#0071E3', section: 'cursos', coverUrl: '/assets/course-covers/la-gran-esperanza.webp', lessons: [{}, {}] }
  ]
};

test('published home loads covered course links and its original archive download without extra required elements', async () => {
  const { elements, load } = await homepage();
  await load(catalog);
  assert.equal(elements.sections.children[0].tagName, 'h2');
  const cards = elements.sections.children[1].children;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].href, 'curso.html?c=1');
  assert.match(cards[0].children[0].style.backgroundImage, /fe-de-jesus\.webp/);
  assert.equal(cards[0].children[0].attributes['aria-label'], 'Portada de Fe de Jesús');
  assert.equal(elements.dlBtn.href, catalog.zip);
  assert.equal(elements.dlBtn.hidden, false);
  assert.equal(typeof elements.dlBtn.listeners.click, 'function');
});

test('search remains safe before catalog loading and correctly filters and restores the published cards', async () => {
  const { elements, load } = await homepage();
  assert.doesNotThrow(() => elements.search.listeners.input({ target: { value: 'Jesús' } }));
  await load(catalog);
  elements.search.value = 'esperanza';
  elements.search.listeners.input({ target: elements.search });
  assert.equal(elements.sections.children[1].children.length, 1);
  assert.equal(elements.sections.children[1].children[0].href, 'curso.html?c=2');
  elements.search.value = 'sin coincidencia';
  elements.search.listeners.input({ target: elements.search });
  assert.equal(elements.sections.children.length, 0);
  assert.match(elements.empty.textContent, /sin coincidencia/);
  elements.search.value = '';
  elements.search.listeners.input({ target: elements.search });
  assert.equal(elements.sections.children[1].children.length, 2);
  assert.equal(elements.empty.style.display, 'none');
});
