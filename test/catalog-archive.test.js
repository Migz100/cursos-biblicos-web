const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { catalogFingerprint, applyCatalogArchive } = require('../api/_lib/cms/catalog-archive');

const oldZip = 'https://s0anajbi1aoffqbv.public.blob.vercel-storage.com/todos/cursos-biblicos-todos-v3-U903kzUWNQvcMirvxw5xMYG8waXDop.zip';
const newZip = 'https://files.example/complete-courses.zip';

function fixture() {
  return {
    zip: oldZip, zipKind: 'starter', revision: 'one',
    courses: [
      { id: '1', name: 'Fe de Jesús', lessons: [
        { id: '1-01', title: 'La Biblia', url: 'https://files.example/biblia.pdf', type: 'pdf' },
        { id: '1-02', title: 'Dios', url: 'https://files.example/dios.pdf', type: 'pdf' },
      ] },
      { id: '13', name: 'La Fe de Jesús (PowerPoint)', pptZip: 'https://files.example/slides.zip', lessons: [
        { id: '13-01', title: 'Las Escrituras', url: 'https://files.example/escrituras.pdf', type: 'pdf', sourceUrl: 'https://files.example/escrituras.pptx' },
      ] },
    ],
  };
}

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

test('an exact current catalog fingerprint replaces only the legacy full archive immutably', () => {
  const manifest = freeze(fixture());
  const before = structuredClone(manifest);
  const archive = freeze({ url: newZip, fingerprint: catalogFingerprint(manifest), size: 12345 });
  const result = applyCatalogArchive(manifest, archive);
  assert.deepEqual(result, { ...manifest, zip: newZip, zipKind: 'current' });
  assert.equal(result.courses, manifest.courses);
  assert.deepEqual(manifest, before);
  assert.notEqual(result, manifest);
});

test('catalog fingerprint uses ordered public content and ordered HTTPS original sources', () => {
  const lesson = {
    id: 'a', title: 'La Biblia', url: 'https://files.example/a.pdf', type: 'pdf',
    sourceUrl: 'https://files.example/source.pptx', originalUrl: 'https://files.example/original.pptx',
    originalDownloadUrl: 'https://files.example/original.pptx?download=1', sourceDownloadUrl: 'https://files.example/source.pptx?download=1',
    source: { url: 'https://files.example/nested.pptx', downloadUrl: 'https://files.example/unused.pptx' },
    original: { downloadUrl: 'https://files.example/nested-original.pptx' },
  };
  const manifest = { courses: [{ id: 'c', name: 'Curso', lessons: [lesson] }] };
  const expected = [{
    id: 'c', name: 'Curso', pptZip: null, lessons: [{
      id: 'a', title: 'La Biblia', url: 'https://files.example/a.pdf', type: 'pdf', originalSources: [
        { field: 'sourceUrl', url: 'https://files.example/source.pptx' },
        { field: 'originalUrl', url: 'https://files.example/original.pptx' },
        { field: 'originalDownloadUrl', url: 'https://files.example/original.pptx?download=1' },
        { field: 'sourceDownloadUrl', url: 'https://files.example/source.pptx?download=1' },
        { field: 'source', url: 'https://files.example/nested.pptx' },
        { field: 'original', url: 'https://files.example/nested-original.pptx' },
      ],
    }],
  }];
  assert.equal(catalogFingerprint(manifest), createHash('sha256').update(JSON.stringify(expected)).digest('hex'));
  const reorderedProperties = { courses: [{ lessons: [{ ...lesson, source: { downloadUrl: lesson.source.downloadUrl, url: lesson.source.url } }], name: 'Curso', id: 'c' }] };
  assert.equal(catalogFingerprint(reorderedProperties), catalogFingerprint(manifest));
  const differentSourceField = structuredClone(manifest);
  differentSourceField.courses[0].lessons[0].original = { url: lesson.sourceUrl };
  assert.notEqual(catalogFingerprint(differentSourceField), catalogFingerprint(manifest));
});

test('course or lesson additions, removals, reordering and content changes hide a stale legacy archive', () => {
  const initial = fixture();
  const archive = { url: newZip, fingerprint: catalogFingerprint(initial) };
  const changes = {
    'add course': manifest => manifest.courses.push({ id: 'new', name: 'Nuevo', lessons: [] }),
    'remove course': manifest => manifest.courses.pop(),
    'reorder courses': manifest => manifest.courses.reverse(),
    'course ID': manifest => { manifest.courses[0].id = 'changed'; },
    'course name': manifest => { manifest.courses[0].name = 'Nombre nuevo'; },
    'add lesson': manifest => manifest.courses[0].lessons.push({ id: '1-03', title: 'Nueva', url: 'https://files.example/new.pdf', type: 'pdf' }),
    'remove lesson': manifest => manifest.courses[0].lessons.pop(),
    'reorder lessons': manifest => manifest.courses[0].lessons.reverse(),
    'lesson ID': manifest => { manifest.courses[0].lessons[0].id = 'changed'; },
    'lesson title': manifest => { manifest.courses[0].lessons[0].title = 'Nueva Biblia'; },
    'lesson URL': manifest => { manifest.courses[0].lessons[0].url = 'https://files.example/revised.pdf'; },
    'lesson type': manifest => { manifest.courses[0].lessons[0].type = 'pptx'; },
    'PowerPoint archive': manifest => { manifest.courses[1].pptZip = 'https://files.example/revised-slides.zip'; },
    'remove PowerPoint archive': manifest => { delete manifest.courses[1].pptZip; },
    'original source': manifest => { manifest.courses[1].lessons[0].sourceUrl = 'https://files.example/revised.pptx'; },
  };
  for (const [label, change] of Object.entries(changes)) {
    const manifest = fixture();
    change(manifest);
    freeze(manifest);
    const result = applyCatalogArchive(manifest, archive);
    assert.notEqual(catalogFingerprint(manifest), archive.fingerprint, label);
    assert.equal(Object.hasOwn(result, 'zip'), false, label);
    assert.equal(Object.hasOwn(result, 'zipKind'), false, label);
    assert.equal(result.courses, manifest.courses, label);
    assert.equal(manifest.zip, oldZip, `${label}: input stays untouched`);
  }
});

test('every supported HTTPS original-source field participates in archive freshness', () => {
  const initial = fixture();
  const fingerprint = catalogFingerprint(initial);
  for (const field of ['sourceUrl', 'originalUrl', 'originalDownloadUrl', 'sourceDownloadUrl']) {
    const manifest = fixture();
    manifest.courses[0].lessons[0][field] = 'https://files.example/original.pptx';
    assert.notEqual(catalogFingerprint(manifest), fingerprint, field);
  }
  for (const field of ['source', 'original']) {
    for (const nested of ['url', 'downloadUrl']) {
      const manifest = fixture();
      manifest.courses[0].lessons[0][field] = { [nested]: 'https://files.example/original.pptx' };
      assert.notEqual(catalogFingerprint(manifest), fingerprint, `${field}.${nested}`);
    }
  }
});

test('non-HTTPS or malformed original sources do not enter the public archive fingerprint', () => {
  const initial = fixture();
  for (const value of ['http://files.example/a.pptx', '/private/a.pptx', 'not a URL', '', null, {}]) {
    const manifest = fixture();
    Object.assign(manifest.courses[0].lessons[0], {
      sourceUrl: value, originalUrl: value, originalDownloadUrl: value, sourceDownloadUrl: value,
      source: { url: value }, original: { downloadUrl: value },
    });
    assert.equal(catalogFingerprint(manifest), catalogFingerprint(initial));
  }
});

test('unrelated covers and display metadata do not invalidate a complete archive', () => {
  const manifest = fixture();
  const archive = { url: newZip, fingerprint: catalogFingerprint(manifest) };
  manifest.revision = 'new-display-revision';
  manifest.courses[0].coverUrl = '/new-cover.webp';
  manifest.courses[0].description = 'Nuevo texto';
  manifest.courses[0].color = '#FFF';
  manifest.courses[0].lessons[0].thumbnail = '/thumbnail.webp';
  manifest.courses[0].lessons[0].downloadUrl = 'https://files.example/biblia.pdf?download=1';
  assert.equal(applyCatalogArchive(manifest, archive).zip, newZip);
});

test('custom and missing archive URLs remain authoritative, even when fingerprints differ', () => {
  for (const zip of [undefined, null, 'https://files.example/custom.zip', `${oldZip}?revision=2`]) {
    const manifest = fixture();
    if (zip === undefined) delete manifest.zip;
    else manifest.zip = zip;
    freeze(manifest);
    assert.equal(applyCatalogArchive(manifest, { url: newZip, fingerprint: 'stale' }), manifest);
  }
});

test('missing archive metadata suppresses the obsolete legacy download without touching courses', () => {
  const manifest = freeze(fixture());
  const result = applyCatalogArchive(manifest);
  assert.equal(Object.hasOwn(result, 'zip'), false);
  assert.equal(Object.hasOwn(result, 'zipKind'), false);
  assert.equal(result.courses, manifest.courses);
  assert.equal(manifest.zip, oldZip);
});
