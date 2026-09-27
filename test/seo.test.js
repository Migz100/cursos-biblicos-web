const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { CmsError } = require('../api/_lib/cms/core');
const { courseIndex, resolvePage, renderPage, sitemap } = require('../api/_lib/cms/seo');
const { coursePath } = require('../seo');

const root = path.join(__dirname, '..');
const scope = 'ab'.repeat(32);
const catalog = {
  revision: 'test', zip: 'https://hidden.example/all.zip', courses: [
    { id: '1', name: 'Fe de Jesús', short: 'FJ', section: 'cursos', coverUrl: '/assets/course-covers/fe-de-jesus.webp', zip: 'https://hidden.example/course.zip', lessons: [
      { id: '1-01', legacyNumber: '01', title: 'La Santa Biblia', type: 'pdf', url: 'https://files.example/one.pdf' },
      { id: '1-02', legacyNumber: '02', title: 'LECCION_NO_COMPARTIDA', type: 'pdf', url: 'https://hidden.example/two.pdf' }
    ] },
    { id: 'c_2', name: 'CURSO_NO_COMPARTIDO', section: 'cursos', lessons: [{ id: 'other', title: 'Otro contenido', type: 'pptx', url: 'https://hidden.example/other.pptx' }] }
  ]
};

function loadModule(name, overrides) {
  const filename = path.join(root, name);
  const localRequire = createRequire(filename);
  const requireWithMocks = name => overrides[name] || localRequire(name);
  requireWithMocks.resolve = localRequire.resolve;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: requireWithMocks, module, URL }, { filename });
  return module.exports;
}

const { shareTokenFromRequest } = loadModule('api/_lib/cms/shares.js', { '@vercel/blob': {}, './storage': { namespace: () => 'test' } });

function setup() {
  let reads = 0;
  const overrides = {
    './_lib/cms/storage': { loadManifest: async () => { reads++; return catalog; } },
    './_lib/cms/shares': {
      shareTokenFromRequest,
      restrictManifest: async (req, manifest) => {
        const selected = shareTokenFromRequest(req);
        if (!selected) return manifest;
        if (selected !== scope) throw new CmsError(404, 'SHARE_NOT_FOUND', 'Missing selection');
        return { courses: [{ ...manifest.courses[0], zip: undefined, lessons: [{ ...manifest.courses[0].lessons[0], lessonNumber: 3 }] }] };
      }
    }
  };
  const handlers = { page: loadModule('api/seo-page.js', overrides), sitemap: loadModule('api/sitemap.js', overrides) };
  return {
    get reads() { return reads; },
    async request(pathname, query = '', { method = 'GET', handler = 'page' } = {}) {
      const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, send(body) { this.body = body; } };
      const url = handler === 'page' ? `/api/seo-page?__path=${encodeURIComponent(pathname)}${query ? `&${query}` : ''}` : `/api/sitemap${query ? `?${query}` : ''}`;
      await handlers[handler]({ url, method, query: {} }, response);
      return response;
    }
  };
}

const structuredData = html => JSON.parse(html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1]);

test('public homepage has crawlable course cards, current counts, canonical and factual structured data', async () => {
  const result = await setup().request('/');
  assert.equal(result.code, 200);
  assert.match(result.body, /<title>Cursos bíblicos gratis en español \| Cursos Bíblicos<\/title>/);
  assert.match(result.body, /Explora 2 cursos bíblicos/);
  assert.match(result.body, /href="\/cursos\/fe-de-jesus\/"/);
  assert.match(result.body, /rel="canonical" href="https:\/\/cursosbiblicos.app\/"/);
  assert.match(result.body, /property="og:title"/);
  assert.match(result.body, /name="twitter:card"/);
  assert.match(result.body, /href="\/home.css"/);
  assert.match(result.body, /src="\/site.js"/);
  assert.equal(structuredData(result.body)['@graph'][1].numberOfItems, 2);
  assert.equal(result.headers['X-Robots-Tag'], undefined);
});

test('canonical course and legacy course routes render the same lessons without JavaScript', async () => {
  const api = setup();
  for (const [pathname, query] of [['/cursos/fe-de-jesus/', ''], ['/curso.html', 'c=1']]) {
    const result = await api.request(pathname, query);
    assert.equal(result.code, 200);
    assert.match(result.body, /<body data-course-id="1">/);
    assert.match(result.body, /<h1 class="courseTitle" id="courseTitle">Fe de Jesús<\/h1>/);
    assert.match(result.body, /href="\/leer.html\?c=1&amp;l=01"/);
    assert.match(result.body, /href="\/leer.html\?c=1&amp;l=02"/);
    assert.match(result.body, /rel="canonical" href="https:\/\/cursosbiblicos.app\/cursos\/fe-de-jesus\/"/);
    assert.equal(structuredData(result.body)['@graph'][0]['@type'], 'Course');
    assert.doesNotMatch(result.body, /CURSO_NO_COMPARTIDO/);
  }
});

test('every scoped entry renders only selected content, with no public catalog schema or cached fallback', async () => {
  for (const [pathname, query] of [['/index.html', `s=${scope}`], ['/cursos/fe-de-jesus/', `s=${scope}`], ['/curso.html', `c=1&s=${scope}`], ['/leer.html', `c=1&l=1-01&s=${scope}`]]) {
    const result = await setup().request(pathname, query);
    assert.equal(result.code, 200);
    assert.equal(result.headers['X-Robots-Tag'], 'noindex, follow');
    assert.match(result.headers['Cache-Control'], /no-store/);
    assert.match(result.body, /name="robots" content="noindex, follow"/);
    assert.doesNotMatch(result.body, /CURSO_NO_COMPARTIDO|LECCION_NO_COMPARTIDA|hidden\.example|ItemList|"@type":"Course"/);
    assert.doesNotMatch(result.body, /class="homeControls seoIntro"/);
    assert.match(result.body, new RegExp(scope));
  }
});

test('empty, duplicate and malformed scope values fail before loading any public catalog', async () => {
  for (const query of ['s=', 's=wrong', `s=${scope}&s=${scope}`, 's=https://example.com']) {
    const api = setup();
    const result = await api.request('/', query);
    assert.equal(result.code, 400);
    assert.equal(api.reads, 0);
    assert.match(result.headers['Cache-Control'], /no-store/);
    assert.equal(result.headers['X-Robots-Tag'], 'noindex, follow');
    assert.doesNotMatch(result.body, /Fe de Jesús|CURSO_NO_COMPARTIDO|\/cursos\//);
  }
});

test('shared course HTML preserves original lesson numbers and uses singular course copy', async () => {
  const result = await setup().request('/curso.html', `c=1&s=${scope}`);
  assert.equal(result.code, 200);
  assert.match(result.body, /<div class="num">3<\/div><div class="label">Lección 3<\/div>/);
  assert.match(result.body, /con 1 lección\./);
  assert.doesNotMatch(result.body, /con 1 lecciones|La Santa Biblia/);
});

test('shared course controls localize original lecture numbers while public rows keep lesson titles', () => {
  const source = fs.readFileSync(path.join(root, 'course.js'), 'utf8');
  const rowSource = source.slice(source.indexOf('function lessonRow('), source.indexOf('\nasync function load('));
  function render(sharedView) {
    let language = 'es';
    const updates = [];
    const shares = [];
    const context = {
      sharedView, shareId: scope,
      t: (es, en) => language === 'en' ? en : es,
      localize: update => { updates.push(update); update(); },
      document: { createElement: tag => ({ tag, children: [], dataset: {}, attributes: {}, append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); }, setAttribute(name, value) { this.attributes[name] = value; } }) },
      window: { CourseShare: { shareSelection: payload => shares.push(payload) } }
    };
    vm.runInNewContext(`${rowSource}\nthis.makeRow = lessonRow;`, context);
    return { row: context.makeRow(catalog.courses[0], { ...catalog.courses[0].lessons[0], lessonNumber: 3 }, 0), shares, english() { language = 'en'; updates.forEach(update => update()); } };
  }
  const shared = render(true);
  const [open, download, share] = shared.row.children;
  assert.equal(open.children[0].textContent, '3');
  assert.equal(open.children[1].textContent, 'Lección 3');
  assert.equal(download.attributes['aria-label'], 'Descargar Lección 3');
  assert.equal(share.attributes['aria-label'], 'Compartir Lección 3');
  shared.english();
  assert.equal(open.children[1].textContent, 'Lecture 3');
  assert.equal(download.attributes['aria-label'], 'Download Lecture 3');
  assert.equal(share.attributes['aria-label'], 'Share Lecture 3');
  share.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(shared.shares[0].title, 'Lecture 3');
  assert.equal(shared.shares[0].selection[0].lessonIds[0], '1-01');
  assert.equal(render(false).row.children[0].children[1].textContent, 'La Santa Biblia');
});

test('missing selections, other courses, other lessons and unknown routes return nonindexable error pages', async () => {
  for (const [pathname, query] of [
    ['/', `s=${'cd'.repeat(32)}`], ['/curso.html', `c=c_2&s=${scope}`], ['/leer.html', `c=1&l=1-02&s=${scope}`],
    ['/cursos/curso-no-compartido/', `s=${scope}`], ['/cursos/missing/', ''], ['/admin/', ''], ['/curso.html', 'c=missing']
  ]) {
    const result = await setup().request(pathname, query);
    assert.equal(result.code, 404, `${pathname}?${query}`);
    assert.equal(result.headers['X-Robots-Tag'], 'noindex, follow');
    assert.doesNotMatch(result.body, /La Santa Biblia|CURSO_NO_COMPARTIDO|LECCION_NO_COMPARTIDA/);
  }
  const duplicate = await setup().request('/', '__path=/curso.html');
  assert.equal(duplicate.code, 404);
});

test('reader metadata resolves both public legacy lesson numbers and canonical shared IDs', async () => {
  for (const query of ['', 'c=1', 'c=1&l=1', 'c=1&l=01', 'c=1&l=1-01', `c=1&l=1-01&s=${scope}`]) {
    const result = await setup().request('/leer.html', query);
    assert.equal(result.code, 200);
    assert.match(result.body, /<title>La Santa Biblia · Fe de Jesús \| Cursos Bíblicos<\/title>/);
    assert.equal(result.headers['X-Robots-Tag'], 'noindex, follow');
  }
  assert.equal((await setup().request('/leer.html', `c=1&l=01&s=${scope}`)).code, 404);
});

test('sitemap contains only public canonical URLs and HEAD sends no HTML or XML body', async () => {
  const api = setup();
  const result = await api.request('', '', { handler: 'sitemap' });
  assert.equal(result.code, 200);
  assert.equal((result.body.match(/<url>/g) || []).length, 3);
  assert.match(result.body, /https:\/\/cursosbiblicos.app\/cursos\/fe-de-jesus\//);
  assert.doesNotMatch(result.body, /\?s=|leer\.html|presentacion\.html|__path/);
  assert.equal((await api.request('/', '', { method: 'HEAD' })).body, '');
  assert.equal((await api.request('', '', { method: 'HEAD', handler: 'sitemap' })).body, '');
});

test('course slugs handle accents and real collisions without duplicating canonical URLs', () => {
  assert.equal(coursePath(catalog.courses[0], catalog.courses), '/cursos/fe-de-jesus/');
  const courses = [{ id: 'one', name: 'Jesús' }, { id: 'two', name: 'Jesus' }];
  assert.deepEqual([...courseIndex(courses).keys()], ['/cursos/jesus-one/', '/cursos/jesus-two/']);
});

test('catalog text is escaped in rendered markup and JSON-LD cannot break out into a script', () => {
  const malicious = { courses: [{ id: 'safe', name: '</script><script>alert(1)</script>', section: 'cursos', lessons: [] }] };
  const page = resolvePage('/', new URLSearchParams(), malicious, null);
  const html = renderPage(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), page, malicious, null).html;
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;\/script&gt;/);
  assert.doesNotThrow(() => structuredData(html));
});

test('favicon reuses the existing book icon and robots allow rendering resources', () => {
  const icon = fs.readFileSync(path.join(root, 'favicon.ico'));
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 1);
  assert.deepEqual(icon.subarray(22), fs.readFileSync(path.join(root, 'assets/app-icon-192.png')));
  const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
  assert.match(robots, /Sitemap: https:\/\/cursosbiblicos.app\/sitemap.xml/);
  assert.doesNotMatch(robots, /Disallow: \/(?:api\/?$|assets|vendor|\*\?s)/m);
  for (const name of ['index', 'curso', 'leer', 'presentacion']) assert.match(fs.readFileSync(path.join(root, `${name}.html`), 'utf8'), /rel="icon" href="\/favicon.ico"/);
});
