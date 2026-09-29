const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { unzipSync, zipSync } = require('fflate');
const { zipEntries } = require('../api/_lib/cms/validation');
const { resolvePresentationLesson, trustedBlobUrl } = require('../api/_lib/cms/presentation');

const SOURCE_SHA = 'a'.repeat(64);
const PDF_SHA = 'b'.repeat(64);
const COURSE_COVER_SHA = 'd7197713d94669eed51b83a882264f3de5cabd9702c3d67d49d5195360c228a0';
const FAVICON_SHA = 'fdd860483d8a3eb16e8aa09f1203ab96f61a0da4827829eb1ac53b0cd9227335';

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function startEvidenceServer(packageRoot, port) {
  const script = path.join(__dirname, '..', 'scripts', 'serve-presentation-evidence.mjs');
  const child = spawn(process.execPath, [script, '--package', packageRoot, '--port', String(port)], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`evidence server timeout: ${stderr}`)), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (chunk.includes('READY ')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`evidence server exited ${code}: ${stderr}`));
    });
  });
  return { child, ready };
}

function stopEvidenceServer(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function manifest(url, options = {}) {
  const namespace = options.namespace || 'cms/preview/test';
  const pathname = options.pathname || `${namespace}/assets/lesson.pptx`;
  const pdfPathname = options.pdfPathname || `${namespace}/assets/lesson-derived.pdf`;
  const pdfUrl = options.pdfUrl || `https://store.public.blob.vercel-storage.com/${pdfPathname}`;
  return {
    courses: [{
      id: 'course-one',
      name: 'Curso',
      lessons: [{
        id: 'lesson-one',
        title: 'Presentación',
        type: options.type || 'pptx',
        url,
        downloadUrl: `${url}?download=1`,
        originalName: 'presentacion.pptx',
        pathname,
        size: 1024,
        sha256: options.sourceSha256 || SOURCE_SHA,
        managed: options.managed !== false,
        derivedPdf: options.derivedPdf === null ? null : {
          type: 'pdf',
          url: pdfUrl,
          downloadUrl: `${pdfUrl}?download=1`,
          originalName: 'presentacion.pdf',
          pathname: pdfPathname,
          size: 2048,
          sha256: PDF_SHA,
          sourceSha256: options.derivedSourceSha256 || SOURCE_SHA,
          sourceSlideCount: options.sourceSlideCount || 19,
          pageCount: options.pageCount || 19,
          validationStatus: options.validationStatus || 'passed',
          generator: options.generator || 'libreoffice-offline',
          managed: options.derivedManaged !== false
        }
      }]
    }]
  };
}

function fixtureSlide(number, { blank = false, hidden = false } = {}) {
  const hiddenAttribute = hidden ? ' show="0"' : '';
  const content = blank ? '' : `<p:sp><p:nvSpPr><p:cNvPr id="${number}" name="Slide ${number}"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="1000" cy="1000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:latin typeface="Arial"/></a:rPr><a:t>Slide ${number}</a:t></a:r></a:p></p:txBody></p:sp>`;
  return `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"${hiddenAttribute}><p:cSld><p:spTree>${content}</p:spTree></p:cSld></p:sld>`;
}

function presentationFixture({ slideCount = 3, hidden = [2], blank = [] } = {}) {
  const entries = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="10000" cy="7500"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: slideCount }, (_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`
  };
  for (let number = 1; number <= slideCount; number += 1) {
    entries[`ppt/slides/slide${number}.xml`] = fixtureSlide(number, { blank: blank.includes(number), hidden: hidden.includes(number) });
  }
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, Buffer.from(value)])), { level: 6 }));
}

function memberHashes(buffer) {
  return Object.fromEntries(Object.entries(unzipSync(buffer)).map(([name, value]) => [name, crypto.createHash('sha256').update(value).digest('hex')]));
}

test('presentation resolution returns only a validated catalog-owned derived PDF', () => {
  const source = 'https://store.public.blob.vercel-storage.com/cms/preview/test/assets/lesson.pptx';
  const result = resolvePresentationLesson(manifest(source), 'course-one', 'lesson-one', 'cms/preview/test');
  assert.equal(result.lesson.id, 'lesson-one');
  assert.equal(result.lesson.downloadUrl, `${source}?download=1`);
  assert.equal(result.pdfUrl, 'https://store.public.blob.vercel-storage.com/cms/preview/test/assets/lesson-derived.pdf');
  assert.equal(result.pageCount, 19);
  assert.equal('viewerUrl' in result, false);
});

test('forged, missing, unvalidated, and mismatched derived PDFs are rejected', () => {
  const trusted = 'https://store.public.blob.vercel-storage.com/cms/production/assets/lesson.pptx';
  const base = { namespace: 'cms/production' };
  assert.throws(() => resolvePresentationLesson(manifest('https://attacker.invalid/lesson.pptx', base), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'UNTRUSTED_PRESENTATION');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, base), 'course-one', 'missing', 'cms/production'), error => error.code === 'LESSON_NOT_FOUND');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, { ...base, type: 'pdf' }), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'NOT_A_PRESENTATION');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, { ...base, derivedPdf: null }), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'PRESENTATION_PDF_NOT_VALIDATED');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, { ...base, validationStatus: 'pending' }), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'PRESENTATION_PDF_NOT_VALIDATED');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, { ...base, derivedSourceSha256: 'c'.repeat(64) }), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'PRESENTATION_PDF_NOT_VALIDATED');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, { ...base, pageCount: 18, sourceSlideCount: 19 }), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'PRESENTATION_PDF_NOT_VALIDATED');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, { ...base, pdfUrl: 'https://attacker.invalid/lesson.pdf' }), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'PRESENTATION_PDF_NOT_VALIDATED');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, { ...base, pdfPathname: 'cms/preview/test/assets/lesson.pdf' }), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'PRESENTATION_PDF_NOT_VALIDATED');
  assert.throws(() => resolvePresentationLesson(manifest(trusted, { ...base, derivedManaged: false }), 'course-one', 'lesson-one', 'cms/production'), error => error.code === 'PRESENTATION_PDF_NOT_VALIDATED');
  assert.throws(() => trustedBlobUrl('https://store.public.blob.vercel-storage.com.attacker.invalid/lesson.pptx'), error => error.code === 'UNTRUSTED_PRESENTATION');
});

test('CSP permits local PDF.js workers and has no external presentation frame', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const csp = config.headers.flatMap(rule => rule.headers || []).find(header => header.key === 'Content-Security-Policy').value;
  assert.match(csp, /worker-src 'self';/);
  assert.doesNotMatch(csp, /view\.officeapps\.live\.com/);
  assert.doesNotMatch(csp, /frame-src [^;]*https:\/\//);
  assert.doesNotMatch(csp, /connect-src [^;]*https:\/\/\*(?:[ ;])/);
});

test('presentation stage resets global main sizing before the initial PDF fit', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const stageRule = styles.match(/\.presentationStage\s*\{([^}]*)\}/);
  assert.ok(stageRule, 'missing .presentationStage rule');
  assert.match(stageRule[1], /(?:^|;)\s*width:\s*100%\s*;/);
  assert.match(stageRule[1], /(?:^|;)\s*max-width:\s*none\s*;/);
  assert.match(stageRule[1], /(?:^|;)\s*margin:\s*0\s*;/);
});

test('OOXML objects distinguish ordinary text from proven WordArt vector text', async () => {
  const { parseSlideObjects } = await import('../scripts/prerender-presentations.mjs');
  const xml = `
    <p:sp><p:nvSpPr><p:cNvPr id="1" name="WordArt-looking title"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>Texto ordinario</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="WordArt 18"/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="500" y="600"/><a:ext cx="700" cy="800"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr wrap="none" fromWordArt="1"/><a:p><a:r><a:t>30</a:t></a:r></a:p></p:txBody></p:sp>`;
  const objects = parseSlideObjects(xml);
  assert.equal(objects.length, 2);
  assert.deepEqual(objects[0], {
    id: '1',
    name: 'WordArt-looking title',
    objectType: 'shape',
    boundsEmu: { x: 100, y: 200, cx: 300, cy: 400 },
    text: 'Texto ordinario',
    normalizedText: 'texto ordinario',
    tokens: ['texto', 'ordinario'],
    nonExtractableVectorText: false,
    vectorTextProof: null
  });
  assert.equal(objects[1].normalizedText, '30');
  assert.equal(objects[1].nonExtractableVectorText, true);
  assert.equal(objects[1].vectorTextProof, 'a:bodyPr[fromWordArt="1"]');
  assert.deepEqual(objects[1].boundsEmu, { x: 500, y: 600, cx: 700, cy: 800 });
});

test('ordinary text remains a strict PDF.js requirement when vector text is omitted', async () => {
  const { validateOrdinaryTextCoverage } = await import('../scripts/prerender-presentations.mjs');
  const sourcePage = { number: 1, ordinaryText: 'Texto ordinario completo' };
  assert.equal(validateOrdinaryTextCoverage(sourcePage, 'Texto ordinario completo'), 1);
  assert.throws(
    () => validateOrdinaryTextCoverage(sourcePage, 'Texto completo 30'),
    error => error.code === 'TEXT_MISMATCH'
  );
});

test('ephemeral OOXML staging exposes a hidden nonblank slide without mutating source or non-target ZIP members', async () => {
  const { stagePresentationBuffer } = await import('../scripts/prerender-presentations.mjs');
  const source = presentationFixture();
  const sourceBefore = Buffer.from(source);
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
  const sourceMembers = memberHashes(source);
  const staged = stagePresentationBuffer(source, 'pptx');
  const stagedMembers = memberHashes(staged.buffer);

  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), sourceHash);
  assert.deepEqual(source, sourceBefore);
  assert.deepEqual(Object.keys(unzipSync(staged.buffer)), Object.keys(unzipSync(source)));
  assert.deepEqual(staged.audit.changedMembers, ['ppt/slides/slide2.xml']);
  assert.deepEqual(staged.audit.hiddenNonblankSlideOrders, [2]);
  assert.match(Buffer.from(unzipSync(source)['ppt/slides/slide2.xml']).toString(), /show="0"/);
  assert.match(Buffer.from(unzipSync(staged.buffer)['ppt/slides/slide2.xml']).toString(), /show="1"/);
  for (const [name, hash] of Object.entries(sourceMembers)) {
    if (name !== 'ppt/slides/slide2.xml') assert.equal(stagedMembers[name], hash, `${name} changed`);
  }
  assert.equal(stagedMembers['ppt/presentation.xml'], sourceMembers['ppt/presentation.xml']);
  assert.equal(stagedMembers['ppt/_rels/presentation.xml.rels'], sourceMembers['ppt/_rels/presentation.xml.rels']);
});

test('hidden blank slides fail closed before any staged deck can be used', async () => {
  const { stagePresentationBuffer } = await import('../scripts/prerender-presentations.mjs');
  assert.throws(
    () => stagePresentationBuffer(presentationFixture({ hidden: [2], blank: [2] }), 'pptx'),
    error => error.code === 'HIDDEN_BLANK_SLIDE'
  );
});

test('an 18-slide staged deck retains exact ZIP, relationship, and slide order', async () => {
  const { inspectPresentation, stagePresentationBuffer } = await import('../scripts/prerender-presentations.mjs');
  const source = presentationFixture({ slideCount: 18, hidden: [16] });
  const sourceOrder = zipEntries(source).map(entry => entry.name);
  const sourceFiles = unzipSync(source);
  const staged = stagePresentationBuffer(source, 'pptx');
  const stagedFiles = unzipSync(staged.buffer);

  assert.deepEqual(zipEntries(staged.buffer).map(entry => entry.name), sourceOrder);
  assert.deepEqual(staged.audit.hiddenNonblankSlideOrders, [16]);
  assert.deepEqual(inspectPresentation(staged.buffer, 'pptx').pages.map(page => page.text), Array.from({ length: 18 }, (_, index) => `Slide ${index + 1}`));
  assert.deepEqual(Buffer.from(stagedFiles['ppt/presentation.xml']), Buffer.from(sourceFiles['ppt/presentation.xml']));
  assert.deepEqual(Buffer.from(stagedFiles['ppt/_rels/presentation.xml.rels']), Buffer.from(sourceFiles['ppt/_rels/presentation.xml.rels']));
});

test('only the exact proven answer-slide PDF.js fragments are normalized', async () => {
  const { normalizePdfExtractionArtifacts, validateOrdinaryTextCoverage } = await import('../scripts/prerender-presentations.mjs');
  const cases = [
    ['Respuesta: Un solo Dios', 'Respuest a: Un solo Dios'],
    ['Respuesta: Espiritual', 'Respuest a: Espiritu al'],
    ['Respuesta: Amor', 'Respuest a: Amo r'],
    ['Respuesta: Padre', 'Respuest a: Padr e'],
    ['Respuesta: Si', 'Respuest a: S i']
  ];
  for (const [ordinaryText, extracted] of cases) {
    const sourcePage = { number: 1, ordinaryText };
    assert.equal(validateOrdinaryTextCoverage(sourcePage, extracted), 1);
    assert.equal(normalizePdfExtractionArtifacts(sourcePage, extracted), ordinaryText.toLowerCase().replace(':', ''));
  }
  assert.equal(normalizePdfExtractionArtifacts({ number: 1, ordinaryText: 'Amo ríos' }, 'Amo r'), 'amo r');
  assert.throws(
    () => validateOrdinaryTextCoverage({ number: 1, ordinaryText: 'Respuesta: Amor' }, 'Respuest a: r Amo'),
    error => error.code === 'TEXT_MISMATCH'
  );
  assert.throws(
    () => validateOrdinaryTextCoverage({ number: 1, ordinaryText: 'Respuesta: Amor completo' }, 'Respuest a: Amo r'),
    error => error.code === 'TEXT_MISMATCH'
  );
});

test('grouped source objects fail closed until their transforms can be resolved', async () => {
  const { parseSlideObjects } = await import('../scripts/prerender-presentations.mjs');
  assert.throws(
    () => parseSlideObjects('<p:grpSp><p:sp><a:t>Texto</a:t></p:sp></p:grpSp>'),
    error => error.code === 'UNRESOLVED_SOURCE_OBJECT'
  );
});

test('vector object bounds map exactly and fail closed at slide edges', async () => {
  const { mapObjectBounds } = await import('../scripts/prerender-presentations.mjs');
  const mapped = mapObjectBounds(
    { x: 250, y: 250, cx: 500, cy: 500 },
    { cx: 1000, cy: 1000 },
    { width: 4000, height: 4000 }
  );
  assert.deepEqual(mapped.exact, { x: 1000, y: 1000, width: 2000, height: 2000 });
  assert.deepEqual(mapped.pixels, { x: 1000, y: 1000, width: 2000, height: 2000 });
  assert.throws(
    () => mapObjectBounds({ x: 0, y: 10, cx: 100, cy: 100 }, { cx: 1000, cy: 1000 }, { width: 4000, height: 4000 }),
    error => error.code === 'VECTOR_OBJECT_EDGE_CLIPPED'
  );
});

function reviewInput(overrides = {}) {
  return {
    sourceSha256: '1'.repeat(64),
    pdfSha256: '2'.repeat(64),
    assetPath: 'assets/30-deck-222222222222.pdf',
    deckPosition: 30,
    courseId: 'course-one',
    courseName: 'Curso',
    lessonId: 'lesson-thirty',
    lessonTitle: 'Un Nuevo Mundo',
    originalName: '30 - un-nuevo-mundo.pptx',
    pageNumber: 1,
    objectId: '1042',
    objectName: 'WordArt 18',
    objectType: 'shape',
    expectedNormalizedText: '30',
    vectorTextProof: 'a:bodyPr[fromWordArt="1"]',
    boundsEmu: { x: 4286248, y: 571480, cx: 600075, cy: 636588 },
    cropPixels: { x: 1349, y: 179, width: 190, height: 202 },
    cropExactPixels: { x: 1349.999, y: 179.993, width: 189, height: 200.5 },
    fullPageRaster: { width: 2880, height: 2160, generatedSha256: '3'.repeat(64), directReferenceSha256: '3'.repeat(64) },
    objectRaster: { generatedSha256: '4'.repeat(64), directReferenceSha256: '4'.repeat(64) },
    cropSha256: '5'.repeat(64),
    cropMetrics: { inkPixelRatio: 0.5, luminanceStandardDeviation: 100 },
    automatedOcr: { engine: 'Windows.Media.Ocr', available: true, recognizedText: '', exactMatch: false, detail: '' },
    ...overrides
  };
}

function passingReviewLedger(item, queueSha256, binding, checks) {
  return {
    schemaVersion: 1,
    queueSha256,
    reviewer: { name: 'Fresh verifier', freshEyes: true, independentFromGeneration: true },
    reviewedAt: '2026-08-30T00:00:00.000Z',
    decisions: [{ reviewId: item.reviewId, decision: 'pass', binding, checks }]
  };
}

function reviewQueue(item, requiredVisualChecks) {
  return {
    schemaVersion: 1,
    reviewLedgerSchemaVersion: 1,
    status: 'visual-review-required',
    itemCount: 1,
    requiredVisualChecks: [...requiredVisualChecks],
    items: [item]
  };
}

test('review queue items are deterministic and exactly bound to package artifacts', async () => {
  const { buildReviewQueueItem, validateQueueItemBinding } = await import('../scripts/prerender-presentations.mjs');
  const first = buildReviewQueueItem(reviewInput());
  const second = buildReviewQueueItem(reviewInput());
  assert.deepEqual(first, second);
  assert.match(first.reviewId, /^vr-[a-f0-9]{64}$/);
  assert.equal(first.artifactPath, `evidence/visual-review-required/${first.reviewId}.png`);
  assert.equal(validateQueueItemBinding(first), true);
  assert.throws(() => validateQueueItemBinding({ ...first, cropSha256: '6'.repeat(64) }), error => error.code === 'REVIEW_QUEUE_TAMPERED');
});

test('review ledger rejects missing, extra, failed, or tampered decisions', async () => {
  const { buildReviewQueueItem, REQUIRED_VISUAL_CHECKS, reviewDecisionBinding, validateReviewLedger } = await import('../scripts/prerender-presentations.mjs');
  const item = buildReviewQueueItem(reviewInput());
  const queueSha = 'a'.repeat(64);
  const checks = Object.fromEntries(REQUIRED_VISUAL_CHECKS.map(check => [check, true]));
  const queue = reviewQueue(item, REQUIRED_VISUAL_CHECKS);
  const valid = passingReviewLedger(item, queueSha, reviewDecisionBinding(item), checks);
  assert.equal(validateReviewLedger(queue, valid, queueSha).length, 1);
  assert.throws(() => validateReviewLedger(queue, { ...valid, decisions: [] }, queueSha), error => error.code === 'REVIEW_LEDGER_INCOMPLETE');
  assert.throws(() => validateReviewLedger(queue, { ...valid, decisions: [...valid.decisions, { ...valid.decisions[0], reviewId: 'vr-extra' }] }, queueSha), error => error.code === 'REVIEW_LEDGER_INCOMPLETE');
  assert.throws(() => validateReviewLedger(queue, { ...valid, decisions: [{ ...valid.decisions[0], decision: 'fail' }] }, queueSha), error => error.code === 'VISUAL_REVIEW_FAILED');
  assert.throws(() => validateReviewLedger(queue, passingReviewLedger(item, queueSha, { ...reviewDecisionBinding(item), cropSha256: '9'.repeat(64) }, checks), queueSha), error => error.code === 'REVIEW_LEDGER_MISMATCH');
  assert.throws(() => validateReviewLedger(queue, valid, 'b'.repeat(64)), error => error.code === 'REVIEW_LEDGER_MISMATCH');
});

test('every visual pass requires all five explicit attestations', async () => {
  const { buildReviewQueueItem, REQUIRED_VISUAL_CHECKS, reviewDecisionBinding, validateReviewLedger } = await import('../scripts/prerender-presentations.mjs');
  const item = buildReviewQueueItem(reviewInput());
  const queueSha = 'a'.repeat(64);
  const queue = reviewQueue(item, REQUIRED_VISUAL_CHECKS);
  for (const omitted of REQUIRED_VISUAL_CHECKS) {
    const checks = Object.fromEntries(REQUIRED_VISUAL_CHECKS.map(check => [check, check !== omitted]));
    const ledger = passingReviewLedger(item, queueSha, reviewDecisionBinding(item), checks);
    assert.throws(() => validateReviewLedger(queue, ledger, queueSha), error => error.code === 'REVIEW_LEDGER_INCOMPLETE');
  }
});

test('ordinary text failure aborts before any visual-review item can be created', async () => {
  const { buildReviewQueueItem, validateOrdinaryTextCoverage } = await import('../scripts/prerender-presentations.mjs');
  let queued = false;
  assert.throws(() => {
    validateOrdinaryTextCoverage({ number: 1, ordinaryText: 'Texto ordinario completo' }, 'Texto incompleto');
    buildReviewQueueItem(reviewInput());
    queued = true;
  }, error => error.code === 'TEXT_MISMATCH');
  assert.equal(queued, false);
});

test('package-relative review paths reject absolute paths and traversal', async () => {
  const { packageRelativePath } = await import('../scripts/prerender-presentations.mjs');
  const root = path.resolve('C:\\review-package');
  assert.equal(packageRelativePath(root, 'evidence/review.png'), path.join(root, 'evidence', 'review.png'));
  assert.throws(() => packageRelativePath(root, '../review.png'), error => error.code === 'PACKAGE_PATH_INVALID');
  assert.throws(() => packageRelativePath(root, 'C:/review.png'), error => error.code === 'PACKAGE_PATH_INVALID');
  assert.throws(() => packageRelativePath(root, 'evidence\\review.png'), error => error.code === 'PACKAGE_PATH_INVALID');
});

test('finalization rehash rejects a changed crop artifact', async () => {
  const { verifyPackageFile } = await import('../scripts/prerender-presentations.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-review-'));
  try {
    const evidence = path.join(root, 'evidence');
    fs.mkdirSync(evidence);
    const file = path.join(evidence, 'crop.png');
    const original = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('deterministic crop')]);
    fs.writeFileSync(file, original);
    const expected = crypto.createHash('sha256').update(original).digest('hex');
    await verifyPackageFile(root, 'evidence/crop.png', expected, 'png');
    fs.appendFileSync(file, 'tampered');
    await assert.rejects(() => verifyPackageFile(root, 'evidence/crop.png', expected, 'png'), error => error.code === 'PACKAGE_TAMPERED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evidence server Back route serves only hash-bound local cover and favicon assets', async () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-evidence-server-'));
  fs.mkdirSync(path.join(packageRoot, 'assets'));
  fs.writeFileSync(path.join(packageRoot, 'ledger.json'), JSON.stringify({
    status: 'passed',
    namespace: 'cms/preview/evidence-test',
    noUploadPerformed: true,
    noCatalogMutationPerformed: true,
    assets: []
  }));
  fs.writeFileSync(path.join(packageRoot, 'catalog.proposed.json'), JSON.stringify({
    courses: [{
      id: 'course-one',
      name: 'La Fe de Jesús 2',
      coverUrl: '/assets/la-fe-de-jesus-2-cover.png',
      lessons: []
    }]
  }));
  const port = await reserveLocalPort();
  const running = startEvidenceServer(packageRoot, port);
  try {
    await running.ready;
    const base = `http://127.0.0.1:${port}`;
    const course = await fetch(`${base}/curso.html?c=course-one`);
    assert.equal(course.status, 200);
    assert.match(await course.text(), /course\.js/);

    const catalog = await fetch(`${base}/api/catalog`).then(response => response.json());
    assert.equal(catalog.courses[0].coverUrl, '/assets/la-fe-de-jesus-2-cover.png');

    const cover = await fetch(`${base}/assets/la-fe-de-jesus-2-cover.png`);
    assert.equal(cover.status, 200);
    assert.equal(cover.headers.get('content-type'), 'image/png');
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await cover.arrayBuffer())).digest('hex'), COURSE_COVER_SHA);

    const favicon = await fetch(`${base}/favicon.ico`);
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get('content-type'), 'image/svg+xml');
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await favicon.arrayBuffer())).digest('hex'), FAVICON_SHA);

    const unlisted = await fetch(`${base}/not-allowlisted.txt`);
    assert.equal(unlisted.status, 404);
  } finally {
    await stopEvidenceServer(running.child);
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('evidence server fails closed on a static artifact hash mismatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-evidence-hash-'));
  try {
    fs.writeFileSync(path.join(root, 'favicon.svg'), '<svg/>');
    const artifacts = new Map([['favicon.ico', {
      relativeFile: 'favicon.svg',
      sha256: '0'.repeat(64),
      contentType: 'image/svg+xml'
    }]]);
    const { verifyStaticArtifacts } = await import('../scripts/serve-presentation-evidence.mjs');
    await assert.rejects(
      () => verifyStaticArtifacts(artifacts, root),
      error => error.code === 'STATIC_ARTIFACT_HASH_MISMATCH'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
