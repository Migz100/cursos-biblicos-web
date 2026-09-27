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
  assert.match(home.replace(/<\/?span[^>]*>/g, ''), /<h1[^>]*>Cursos Bíblicos<\/h1>/);
  assert.doesNotMatch(home, /<nav\b/);
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

async function homepage(search = '', metadata = {}) {
  const elements = Object.fromEntries(['sections', 'empty', 'search', 'dlBtn', 'downloadEstimate', 'downloadStatus', 'shareCatalog', 'homeTitle', 'sharedNotice'].map(id => [id, domElement('div')]));
  elements.dlBtn.tagName = 'a';
  elements.dlBtn.download = '';
  elements.search.value = '';
  let deliver;
  const response = new Promise(resolve => { deliver = resolve; });
  const requests = [], fetches = [], timers = new Map();
  const calls = { blob: 0, files: 0, share: 0, popup: 0, objectUrl: 0 };
  const archiveResponse = {
    ok: metadata.ok !== false,
    headers: { get: name => name.toLowerCase() === 'content-length' ? String(metadata.length ?? 242_000_000) : null },
    async blob() { calls.blob++; throw new Error('archive body must remain in the browser download manager'); }
  };
  let resolveMetadata;
  const context = {
    document: { createElement: domElement, getElementById: id => elements[id] },
    URLSearchParams, AbortController,
    location: { search },
    navigator: { canShare: () => true, async share() { calls.share++; } },
    File: class { constructor() { calls.files++; } },
    URL: { createObjectURL() { calls.objectUrl++; return 'blob:unexpected'; }, revokeObjectURL() {} },
    open() { calls.popup++; },
    setTimeout(callback, delay) { const timer = {}; timers.set(timer, { callback, delay }); return timer; },
    clearTimeout: timer => timers.delete(timer),
    fetch(url, options = {}) {
      requests.push(url);
      fetches.push({ url, ...options, method: options.method || 'GET' });
      if (url.startsWith('/api/catalog')) return response;
      if (metadata.fail) return Promise.reject(new Error('metadata unavailable'));
      if (metadata.pending) return new Promise((resolve, reject) => {
        resolveMetadata = () => resolve(archiveResponse);
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('metadata timeout'), { name: 'AbortError' })), { once: true });
      });
      return Promise.resolve(archiveResponse);
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('site.js'), context);
  return {
    elements, requests, fetches, calls, timers,
    async finishMetadata() { resolveMetadata(); await new Promise(resolve => setImmediate(resolve)); },
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

test('published home loads covered course links and keeps the archive estimate hidden until requested', async () => {
  const { elements, fetches, load } = await homepage();
  await load(catalog);
  assert.equal(elements.homeTitle.textContent, 'Cursos Bíblicos');
  assert.equal(elements.sections.children[0].tagName, 'section');
  assert.equal(elements.sections.children[0].attributes['aria-labelledby'], 'section-cursos');
  const cards = elements.sections.children[0].children[1].children;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].href, 'curso.html?c=1');
  assert.match(cards[0].children[0].style.backgroundImage, /fe-de-jesus\.webp/);
  assert.equal(cards[0].children[0].attributes['aria-label'], 'Portada de Fe de Jesús');
  assert.equal(elements.dlBtn.href, catalog.zip);
  assert.equal(elements.dlBtn.hidden, false);
  assert.equal(typeof elements.dlBtn.listeners.click, 'function');
  assert.match(read('index.html'), /<a\b[^>]*id="dlBtn"[^>]*\bdownload\b/);
  assert.deepEqual(fetches.map(({ url, method }) => ({ url, method })), [
    { url: '/api/catalog', method: 'GET' }, { url: catalog.zip, method: 'HEAD' }
  ]);
  assert.equal(elements.downloadEstimate.hidden, true);
  assert.match(elements.downloadEstimate.textContent, /\d.*MB/);
  assert.match(elements.downloadEstimate.textContent, /min/i);
  assert.match(elements.downloadEstimate.textContent, /aprox\./i);
  assert.match(elements.downloadEstimate.textContent, /Wi-Fi/);
  assert.match(elements.downloadEstimate.textContent, /puede tardar más/i);
});

test('archive clicks use the browser download directly without buffering, sharing or opening a popup', async () => {
  const { elements, fetches, calls, load } = await homepage();
  await load(catalog);
  const before = fetches.length;
  assert.equal(elements.downloadEstimate.hidden, true);
  let prevented = 0;
  const result = elements.dlBtn.listeners.click({ preventDefault() { prevented++; } });
  assert.equal(result, undefined, 'the click handler remains synchronous');
  assert.equal(prevented, 0, 'the actual archive link must handle the click');
  assert.equal(elements.dlBtn.href, catalog.zip);
  assert.equal(elements.dlBtn.download, '');
  assert.equal(elements.downloadEstimate.hidden, false);
  assert.equal(elements.downloadStatus.hidden, false);
  assert.match(elements.downloadStatus.textContent, /Descargar/);
  assert.match(elements.downloadStatus.textContent, /descargas/i);
  assert.doesNotMatch(elements.downloadStatus.textContent, /completad[oa]|terminad[oa]|descarga lista/i);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches.length, before, 'clicking does not fetch a copy of the archive into JavaScript');
  assert.deepEqual(calls, { blob: 0, files: 0, share: 0, popup: 0, objectUrl: 0 });
  assert.equal(elements.dlBtn.dataset.busy, undefined);
});

test('slow archive metadata never blocks course rendering or the direct download link', async () => {
  const view = await homepage('', { pending: true });
  await view.load(catalog);
  assert.equal(view.elements.sections.children[0].children[1].children.length, 2);
  assert.equal(view.elements.dlBtn.href, catalog.zip);
  assert.equal(view.elements.dlBtn.hidden, false);
  assert.equal(view.elements.downloadEstimate.hidden, true);
  let prevented = false;
  view.elements.dlBtn.listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(view.elements.downloadEstimate.hidden, false);
  await view.finishMetadata();
  assert.equal(view.elements.downloadEstimate.hidden, false);
  assert.match(view.elements.downloadEstimate.textContent, /\d.*MB/);
  assert.equal(view.timers.size, 0, 'successful metadata clears the abort timeout');
});

test('unavailable or invalid archive sizes use honest fallback guidance and keep downloads usable', async () => {
  for (const metadata of [{ fail: true }, { ok: false }, { length: '' }, { length: 'Infinity' }, { length: '-1' }]) {
    const { elements, fetches, load } = await homepage('', metadata);
    await load(catalog);
    assert.equal(elements.downloadEstimate.textContent, 'El tiempo depende de tu conexión.');
    assert.equal(elements.downloadEstimate.hidden, true);
    assert.equal(elements.dlBtn.href, catalog.zip);
    assert.equal(elements.dlBtn.hidden, false);
    let prevented = false;
    elements.dlBtn.listeners.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(elements.downloadEstimate.hidden, false);
    assert.deepEqual(fetches.filter(request => request.url === catalog.zip).map(request => request.method), ['HEAD']);
  }
});

test('archive metadata has a finite abort timeout that leaves the link and fallback usable', async () => {
  const view = await homepage('', { pending: true });
  await view.load(catalog);
  assert.equal(view.elements.downloadEstimate.hidden, true);
  const request = view.fetches.find(request => request.url === catalog.zip);
  assert.equal(request.method, 'HEAD');
  assert.ok(request.signal instanceof AbortSignal);
  assert.equal(view.timers.size, 1);
  const timer = [...view.timers.values()][0];
  assert.ok(Number.isFinite(timer.delay) && timer.delay > 0 && timer.delay <= 30_000);
  timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(request.signal.aborted, true);
  assert.equal(view.timers.size, 0);
  assert.equal(view.elements.downloadEstimate.textContent, 'El tiempo depende de tu conexión.');
  assert.equal(view.elements.downloadEstimate.hidden, true);
  assert.equal(view.elements.dlBtn.href, catalog.zip);
  assert.equal(view.elements.dlBtn.hidden, false);
  let prevented = false;
  view.elements.dlBtn.listeners.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(view.elements.downloadEstimate.hidden, false);
});

test('shared catalog preserves selection on every course link and never exposes the full archive', async () => {
  const token = 'a'.repeat(64);
  const { elements, requests, load } = await homepage(`?s=${token}`);
  await load(catalog);
  assert.equal(elements.homeTitle.textContent, 'Lecciones compartidas contigo');
  assert.deepEqual(requests, [`/api/catalog?s=${token}`]);
  const cards = elements.sections.children[0].children[1].children;
  assert.equal(cards[0].href, `curso.html?c=1&s=${token}`);
  assert.equal(cards[1].href, `curso.html?c=2&s=${token}`);
  assert.equal(elements.dlBtn.hidden, true);
  assert.equal(elements.dlBtn.href, undefined);
  assert.equal(elements.downloadEstimate.hidden, true);
  assert.equal(elements.downloadStatus.hidden, true);
  assert.equal(elements.sharedNotice.hidden, false);
});

test('empty and duplicate share parameters cannot silently open the full catalog', async () => {
  for (const query of ['?s=', `?s=${'a'.repeat(64)}&s=${'b'.repeat(64)}`]) {
    const { requests, elements, load } = await homepage(query);
    await load(catalog);
    assert.deepEqual(requests, ['/api/catalog?s=']);
    assert.equal(elements.dlBtn.hidden, true);
    assert.equal(elements.dlBtn.href, undefined);
    assert.equal(elements.downloadEstimate.hidden, true);
  }
});

test('a catalog without an archive cannot expose a download or fetch archive metadata', async () => {
  const { elements, fetches, load } = await homepage();
  await load({ courses: catalog.courses });
  assert.equal(elements.dlBtn.hidden, true);
  assert.equal(elements.dlBtn.href, undefined);
  assert.equal(elements.downloadEstimate.hidden, true);
  assert.equal(elements.downloadStatus.hidden, true);
  assert.deepEqual(fetches.map(request => request.url), ['/api/catalog']);
});

test('search remains safe before catalog loading and correctly filters and restores the published cards', async () => {
  const { elements, load } = await homepage();
  assert.doesNotThrow(() => elements.search.listeners.input({ target: { value: 'Jesús' } }));
  await load(catalog);
  elements.search.value = 'esperanza';
  elements.search.listeners.input({ target: elements.search });
  assert.equal(elements.sections.children[0].children[1].children.length, 1);
  assert.equal(elements.sections.children[0].children[1].children[0].href, 'curso.html?c=2');
  elements.search.value = 'sin coincidencia';
  elements.search.listeners.input({ target: elements.search });
  assert.equal(elements.sections.children.length, 0);
  assert.match(elements.empty.textContent, /sin coincidencia/);
  elements.search.value = '';
  elements.search.listeners.input({ target: elements.search });
  assert.equal(elements.sections.children[0].children[1].children.length, 2);
  assert.equal(elements.empty.style.display, 'none');
});
