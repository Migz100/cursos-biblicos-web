const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { CmsError } = require('../api/_lib/cms/core');

const ROOT = path.join(__dirname, '..');
const NAMESPACE = 'cms/preview/share-tests';
const ORIGIN = 'https://cursosbiblicos.app';
const plain = value => JSON.parse(JSON.stringify(value));

function loadModule(filename, overrides, globals = {}) {
  const absolute = path.join(ROOT, filename);
  const localRequire = createRequire(absolute);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(absolute, 'utf8'), {
    module, exports: module.exports, Buffer, URL,
    require: name => Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : localRequire(name),
    ...globals
  }, { filename: absolute });
  return module.exports;
}

function manifest() {
  const presentation = id => ({
    id, title: id, type: 'pptx', managed: true,
    pathname: `${NAMESPACE}/assets/${id}.pptx`,
    url: `https://store.public.blob.vercel-storage.com/${NAMESPACE}/assets/${id}.pptx`,
    originalName: `${id}.pptx`
  });
  return {
    schemaVersion: 1, revision: 'revision-one', appName: 'Cursos Bíblicos',
    zip: 'https://hidden.invalid/all.zip', zipKind: 'starter', pptZip: 'https://hidden.invalid/all-ppt.zip',
    archive: { url: 'https://hidden.invalid/archive.zip' }, exports: ['https://hidden.invalid/export.zip'],
    change: { label: 'Hidden history' }, trash: [{ item: { url: 'https://hidden.invalid/deleted.pdf' } }],
    courses: [{
      id: '1', name: 'Primero', short: 'P', color: '#000000', section: 'cursos',
      zip: 'https://hidden.invalid/course.zip', zipKind: 'starter', pptZip: 'https://hidden.invalid/course-ppt.zip',
      archives: ['https://hidden.invalid/course-archive.zip'], exports: ['https://hidden.invalid/course-export.zip'],
      lessons: [
        { id: '1-01', legacyNumber: '01', title: 'Una', type: 'pdf', url: 'https://selected.invalid/one.pdf', archiveUrl: 'https://hidden.invalid/lesson.zip' },
        { id: '1-02', legacyNumber: '02', title: 'Dos', type: 'pdf', url: 'https://selected.invalid/two.pdf' }
      ]
    }, {
      id: 'c_other', name: 'Otro', lessons: [presentation('l_first'), presentation('l_second')]
    }]
  };
}

function setup() {
  const state = { manifest: manifest(), blobs: new Map(), writes: [], rates: [], race: false, rateError: null };
  class NotFound extends Error {}
  const storage = {
    namespace: () => NAMESPACE,
    loadManifest: async () => state.manifest,
    enforceRate: async (...args) => {
      state.rates.push(args);
      if (state.rateError) throw state.rateError;
    }
  };
  const blob = {
    BlobNotFoundError: NotFound,
    head: async pathname => {
      if (!state.blobs.has(pathname)) throw new NotFound();
      return { pathname, url: `https://store.public.blob.vercel-storage.com/${pathname}` };
    },
    put: async (pathname, body, options) => {
      assert.equal(options.allowOverwrite, false);
      assert.equal(options.addRandomSuffix, false);
      assert.equal(options.access, 'public');
      if (state.blobs.has(pathname)) throw new Error('Already exists');
      state.blobs.set(pathname, body);
      state.writes.push({ pathname, body, options });
      if (state.race) throw new Error('Another request created the same record');
      return { pathname };
    }
  };
  const shares = loadModule('api/_lib/cms/shares.js', { '@vercel/blob': blob, './storage': storage }, {
    fetch: async url => {
      const body = state.blobs.get(new URL(url).pathname.slice(1));
      return { ok: body !== undefined, json: async () => JSON.parse(body) };
    }
  });
  const overrides = { './_lib/cms/shares': shares, './_lib/cms/storage': storage };
  const handlers = Object.fromEntries(['share', 'catalog', 'presentation'].map(name => [name, loadModule(`api/${name}.js`, overrides)]));
  async function call(name, { method = name === 'share' ? 'POST' : 'GET', body, query = {}, url, headers = {} } = {}) {
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(value) { this.body = plain(value); } };
    await handlers[name]({
      method, body, query, url: url || `/api/${name}`,
      headers: { host: 'cursosbiblicos.app', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers }
    }, response);
    return response;
  }
  const selection = (lessonIds = ['1-01']) => [{ courseId: '1', lessonIds }];
  const create = input => call('share', { body: input || { selection: selection() } });
  return { state, shares, call, selection, create };
}

test('shares store exact sorted IDs, reuse identical records, and never store private answers', async () => {
  const { state, create } = setup();
  const one = await create({ selection: [{ courseId: 'c_other', lessonIds: ['l_second', 'l_first'] }, { courseId: '1', lessonIds: ['1-02', '1-01'], answers: 'PRIVATE' }], answers: 'PRIVATE' });
  const two = await create({ selection: [{ courseId: '1', lessonIds: ['1-01', '1-02'] }, { courseId: 'c_other', lessonIds: ['l_first', 'l_second'] }] });
  assert.equal(one.code, 200);
  assert.deepEqual(two.body, one.body);
  assert.match(one.body.id, /^[a-f0-9]{64}$/);
  assert.equal(one.body.url, `${ORIGIN}/index.html?s=${one.body.id}`);
  assert.equal(one.body.lessonCount, 4);
  assert.equal(one.body.courseCount, 2);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].pathname, `${NAMESPACE}/shares/${one.body.id}.json`);
  assert.equal(state.writes[0].body.includes('PRIVATE'), false);
  assert.equal(state.rates[0][1], 'shares');
});

test('empty, duplicate, malformed, wildcard, nonexistent, and legacy-only selections are rejected', async () => {
  const { create, selection, state } = setup();
  for (const input of [
    {}, { selection: [] }, { selection: selection([]) }, { selection: selection(['1-01', '1-01']) },
    { selection: [...selection(), ...selection()] }, { selection: selection(['*']) },
    { selection: selection([null]) }, { selection: [{ courseId: '../1', lessonIds: ['1-01'] }] }
  ]) assert.equal((await create(input)).code, 400);
  for (const input of [{ selection: selection(['01']) }, { selection: selection(['missing']) }, { selection: [{ courseId: 'missing', lessonIds: ['1-01'] }] }]) {
    assert.equal((await create(input)).code, 404);
  }
  assert.equal(state.writes.length, 0);
});

test('catalog scope ignores altered course/lesson parameters and removes every bulk export and deleted item', async () => {
  const { create, call, state } = setup();
  const { body: share } = await create();
  const result = await call('catalog', { query: { s: share.id, c: 'c_other', l: 'l_second' } });
  assert.equal(result.code, 200);
  assert.deepEqual(result.body.courses.map(course => course.id), ['1']);
  assert.deepEqual(result.body.courses[0].lessons.map(lesson => lesson.id), ['1-01']);
  assert.equal(JSON.stringify(result.body).includes('hidden.invalid'), false);
  assert.equal('trash' in result.body, false);
  assert.equal('change' in result.body, false);
  assert.match(result.headers['Cache-Control'], /no-store/);
  assert.equal(result.headers.ETag, undefined);
  assert.equal(state.manifest.courses[0].lessons.length, 2);
  const normal = await call('catalog');
  assert.equal(normal.body.zip, state.manifest.zip);
  assert.deepEqual(normal.body.trash, state.manifest.trash);
  assert.equal(normal.body.courses.length, 3);
  assert.equal(normal.body.courses[2].id, 'la-fe-de-jesus-3');
  assert.match(normal.headers['Cache-Control'], /public/);
  assert.ok(normal.headers.ETag);
});

test('future lessons cannot enter an existing collection and deleted members never reveal the full catalog', async () => {
  const { create, call, state, selection } = setup();
  const { body: share } = await create({ selection: selection(['1-01', '1-02']) });
  state.manifest.courses[0].lessons.push({ id: '1-03', title: 'New', type: 'pdf', url: 'https://hidden.invalid/new.pdf' });
  state.manifest.courses[0].lessons.shift();
  const partial = await call('catalog', { query: { s: share.id } });
  assert.equal(partial.code, 200);
  assert.deepEqual(partial.body.courses[0].lessons.map(lesson => lesson.id), ['1-02']);
  state.manifest.courses[0].lessons.shift();
  const removed = await call('catalog', { query: { s: share.id } });
  assert.equal(removed.code, 410);
  assert.equal(removed.body.courses, undefined);
  state.manifest.courses.shift();
  assert.equal((await call('catalog', { query: { s: share.id } })).code, 410);
});

test('scoped catalogs retain original lesson positions without changing stored content', async () => {
  const { create, call, state } = setup();
  const { body: share } = await create({ selection: [{ courseId: 'c_other', lessonIds: ['l_second'] }] });
  const response = await call('catalog', { query: { s: share.id } });
  assert.equal(response.code, 200);
  const lessons = response.body.courses[0].lessons;
  assert.deepEqual(lessons.map(lesson => [lesson.id, lesson.lessonNumber]), [['l_second', 2]]);
  assert.equal(state.manifest.courses[1].lessons[1].lessonNumber, undefined);
});

test('empty, malformed, duplicate, missing and corrupt share tokens fail closed in both read APIs', async () => {
  const { create, call, state } = setup();
  const { body: share } = await create();
  for (const name of ['catalog', 'presentation']) {
    for (const s of ['', null, undefined, [], [share.id], [share.id, share.id], 'A'.repeat(64), 'a'.repeat(63), '../shares/id']) {
      const response = await call(name, { query: { s, c: 'c_other', l: 'l_first' } });
      assert.equal(response.code, 400, `${name}: ${JSON.stringify(s)}`);
      assert.equal(response.body.courses, undefined);
    }
    assert.equal((await call(name, { url: `/api/${name}?s=${share.id}&s=${share.id}` })).code, 400);
    assert.equal((await call(name, { url: `/api/${name}?s=`, query: { s: share.id } })).code, 400);
    assert.equal((await call(name, { query: { s: 'f'.repeat(64) } })).code, 404);
  }
  const pathname = `${NAMESPACE}/shares/${share.id}.json`;
  state.blobs.set(pathname, JSON.stringify({ schemaVersion: 1, selection: [{ courseId: 'c_other', lessonIds: ['l_second'] }] }));
  assert.equal((await call('catalog', { query: { s: share.id } })).code, 410);
  assert.equal((await create()).code, 410);
  assert.equal(state.writes.length, 1);
});

test('presentation API enforces selected course and exact lesson before exposing its download', async () => {
  const { create, call } = setup();
  const { body: share } = await create({ selection: [{ courseId: 'c_other', lessonIds: ['l_first'] }] });
  const selected = await call('presentation', { query: { s: share.id, c: 'c_other', l: 'l_first' } });
  assert.equal(selected.code, 200);
  assert.equal(selected.body.lesson.id, 'l_first');
  assert.equal((await call('presentation', { query: { s: share.id, c: 'c_other', l: 'l_second' } })).code, 404);
  assert.equal((await call('presentation', { query: { s: share.id, c: '1', l: '1-01' } })).code, 404);
  assert.equal((await call('presentation', { query: { s: share.id, c: ['c_other', '1'], l: 'l_first' } })).code, 400);
  assert.equal((await call('presentation', { query: { c: 'c_other', l: 'l_second' } })).code, 200);
});

test('resharing permits only an existing parent subset and rejects expanded or invalid parents', async () => {
  const { create, selection, call } = setup();
  const { body: parent } = await create({ selection: selection(['1-01', '1-02']) });
  const child = await create({ parentToken: parent.id, selection: selection(['1-02']) });
  assert.equal(child.code, 200);
  assert.notEqual(child.body.id, parent.id);
  assert.deepEqual((await call('catalog', { query: { s: child.body.id } })).body.courses[0].lessons.map(lesson => lesson.id), ['1-02']);
  assert.equal((await create({ parentToken: child.body.id, selection: selection(['1-01']) })).code, 403);
  assert.equal((await create({ parentToken: parent.id, selection: [{ courseId: 'c_other', lessonIds: ['l_first'] }] })).code, 403);
  assert.equal((await create({ parentToken: '', selection: selection() })).code, 400);
  assert.equal((await create({ parentToken: 'f'.repeat(64), selection: selection() })).code, 404);
});

test('a concurrent identical create reuses the verified record without overwriting it', async () => {
  const { state, create } = setup();
  state.race = true;
  const response = await create();
  assert.equal(response.code, 200);
  assert.equal(state.writes.length, 1);
  assert.equal((await create()).body.id, response.body.id);
  assert.equal(state.writes.length, 1);
});

test('share creation retains method, origin, body-size and rate protections', async () => {
  const { call, state, selection, create } = setup();
  assert.equal((await call('share', { method: 'GET' })).code, 405);
  assert.equal((await call('share', { body: { selection: selection() }, headers: { origin: 'https://other.invalid' } })).code, 403);
  assert.equal((await call('share', { body: { selection: selection() }, headers: { origin: '' } })).code, 403);
  assert.equal((await call('share', { body: { selection: selection(), extra: 'x'.repeat(65536) } })).code, 413);
  state.rateError = new CmsError(429, 'RATE_LIMIT', 'Límite temporal.');
  assert.equal((await create()).code, 429);
  assert.equal(state.writes.length, 0);
});
