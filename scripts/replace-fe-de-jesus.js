const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  COMPLETE_COURSE_ID,
  COMPLETE_COURSE_SHA256,
  COURSE_ID,
  LESSON_TITLES,
  SOURCE_IDS,
  SOURCE_INDEX_PATH,
  SOURCE_INDEX_SHA256,
  SOURCE_PAGES,
  SOURCE_SHA256,
  assertReplacementResult,
  assertSourceIndexIds,
  buildReplacementAction,
  parseTopRowDriveIds,
  slug
} = require('./fe-de-jesus-source');

const CONTENT_TYPE = 'application/pdf';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function pdfPages(filename) {
  const output = execFileSync('pdfinfo', [filename], { encoding: 'utf8' });
  const pages = Number(output.match(/^Pages:\s+(\d+)$/m)?.[1]);
  invariant(Number.isInteger(pages), `Could not inspect ${path.basename(filename)}`);
  return pages;
}

function assertPdf(filename, expectedPages) {
  const bytes = fs.readFileSync(filename);
  invariant(bytes.subarray(0, 5).toString('ascii') === '%PDF-', `${path.basename(filename)} is not a PDF`);
  invariant(bytes.subarray(-4096).toString('latin1').includes('%%EOF'), `${path.basename(filename)} is incomplete`);
  invariant(pdfPages(filename) === expectedPages, `${path.basename(filename)} has the wrong page count`);
}

async function downloadDriveFile(id, filename) {
  const response = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`, { redirect: 'follow' });
  invariant(response.ok, `Source download failed with ${response.status}`);
  fs.writeFileSync(filename, Buffer.from(await response.arrayBuffer()));
}

async function verifySourceIndex() {
  invariant(fs.existsSync(SOURCE_INDEX_PATH), 'The local source index PDF is missing');
  invariant(sha256(fs.readFileSync(SOURCE_INDEX_PATH)) === SOURCE_INDEX_SHA256, 'The local source index PDF changed');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(SOURCE_INDEX_PATH));
  const document = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  invariant(document.numPages === 1, 'The source index should contain one page');
  const annotations = await (await document.getPage(1)).getAnnotations();
  return assertSourceIndexIds(parseTopRowDriveIds(annotations));
}

async function prepareSources(directory) {
  await verifySourceIndex();
  const originals = [];
  for (let index = 0; index < SOURCE_IDS.length; index++) {
    const filename = path.join(directory, `source-${String(index + 1).padStart(2, '0')}.pdf`);
    await downloadDriveFile(SOURCE_IDS[index], filename);
    const bytes = fs.readFileSync(filename);
    invariant(sha256(bytes) === SOURCE_SHA256[index], `Source lesson ${index + 1} did not match the verified file`);
    assertPdf(filename, SOURCE_PAGES[index]);
    originals.push(filename);
  }
  invariant(sha256(fs.readFileSync(originals[12])) === sha256(fs.readFileSync(originals[13])), 'Source lessons 13 and 14 are no longer the expected duplicate');

  const complete = path.join(directory, 'complete-course.pdf');
  await downloadDriveFile(COMPLETE_COURSE_ID, complete);
  invariant(sha256(fs.readFileSync(complete)) === COMPLETE_COURSE_SHA256, 'The complete-course recovery source changed');
  assertPdf(complete, 42);
  const pagePattern = path.join(directory, 'recovery-page-%d.pdf');
  execFileSync('pdfseparate', ['-f', '28', '-l', '29', complete, pagePattern]);
  const recovered = path.join(directory, '14-la-muerte.pdf');
  execFileSync('pdfunite', [path.join(directory, 'recovery-page-28.pdf'), path.join(directory, 'recovery-page-29.pdf'), recovered]);
  assertPdf(recovered, 2);
  invariant(sha256(fs.readFileSync(recovered)) !== sha256(fs.readFileSync(originals[12])), 'Recovered lesson 14 still duplicates El Bautismo');

  const ready = originals.map((filename, index) => index === 13 ? recovered : filename);
  return ready.map((filename, index) => ({
    filename,
    uploadName: `${String(index + 1).padStart(2, '0')} - ${slug(LESSON_TITLES[index])}.pdf`
  }));
}

function protectedJson(baseUrl, route, options, directory) {
  const output = path.join(directory, `response-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const cookieJar = path.join(directory, 'cookies.txt');
  const args = [
    'curl', route, '--deployment', baseUrl,
    '--', '--silent', '--show-error', '--cookie', cookieJar, '--cookie-jar', cookieJar,
    '--output', output, '--request', options.method || 'GET'
  ];
  for (const [name, value] of Object.entries(options.headers || {})) args.push('--header', `${name}: ${value}`);
  if (options.body) args.push('--data-binary', JSON.stringify(options.body));
  try {
    execFileSync('vercel', args, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    let failure = {};
    try { failure = JSON.parse(fs.readFileSync(output, 'utf8')); } catch {}
    throw new Error(failure.message || `Protected preview request failed for ${route}`);
  }
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (result.error) throw new Error(`${result.error}: ${result.message || 'sin detalle'}`);
  return result;
}

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed with ${response.status}`);
  return data;
}

async function main() {
  const baseUrl = process.argv[2]?.replace(/\/$/, '');
  const production = process.argv.includes('--production');
  const protectedPreview = process.argv.includes('--vercel-protected');
  invariant(baseUrl, 'Usage: node scripts/replace-fe-de-jesus.js <deployment-url> [--vercel-protected|--production]');
  invariant(!production || baseUrl === 'https://cursos-biblicos-web.vercel.app', 'Production replacement requires the canonical URL');
  invariant(!protectedPreview || !production, 'Choose preview or production mode');
  invariant(production || baseUrl !== 'https://cursos-biblicos-web.vercel.app', 'Use --production for the canonical URL');

  const origin = new URL(baseUrl).origin;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursos-fe-replace-'));
  const uploadedTokens = [];
  let cookie = '';
  let committed = false;
  let editingHeaders = null;
  let before = null;
  let writtenManifest = null;
  const apiJson = async (route, options = {}) => {
    if (protectedPreview) return protectedJson(baseUrl, route, options, directory);
    return responseJson(await fetch(`${baseUrl}${route}`, {
      cache: 'no-store',
      method: options.method,
      headers: options.headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }));
  };

  try {
    const sources = await prepareSources(directory);
    let session;
    if (protectedPreview) {
      session = await apiJson('/api/manage/session');
    } else {
      const response = await fetch(`${baseUrl}/api/manage/session`, { cache: 'no-store' });
      session = await responseJson(response);
      cookie = response.headers.getSetCookie?.()[0]?.split(';')[0] || response.headers.get('set-cookie')?.split(';')[0] || '';
      invariant(cookie, 'Editing session cookie was not issued');
    }
    editingHeaders = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken,
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      ...(cookie ? { Cookie: cookie } : {})
    };

    const initial = await apiJson(`/api/catalog?replace=${Date.now()}`);
    const existing = initial.courses.find(item => item.id === COURSE_ID);
    invariant(existing, 'Fe de Jesús is missing');
    const expectedPrefix = production ? 'cms/production/assets/' : 'cms/preview/';
    if (
      JSON.stringify(existing.lessons.map(item => item.title)) === JSON.stringify(LESSON_TITLES) &&
      existing.lessons.every(item => item.type === 'pdf' && item.managed && item.pathname?.startsWith(expectedPrefix))
    ) {
      process.stdout.write(JSON.stringify({ alreadyCorrect: true, revision: initial.revision, lessons: 20 }) + '\n');
      return;
    }

    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      const bytes = fs.readFileSync(source.filename);
      const prepared = await apiJson('/api/manage/upload', {
        method: 'POST', headers: editingHeaders,
        body: { action: 'prepare', filename: source.uploadName, contentType: CONTENT_TYPE, size: bytes.length }
      });
      const upload = await fetch(prepared.presignedUrl, { method: 'PUT', headers: { 'Content-Type': prepared.contentType }, body: bytes });
      invariant(upload.ok, `Upload failed for Fe de Jesús lesson ${index + 1}`);
      const finalized = await apiJson('/api/manage/upload', {
        method: 'POST', headers: editingHeaders, body: { action: 'finalize', receipt: prepared.receipt }
      });
      uploadedTokens.push(finalized.assetToken);
      process.stdout.write(`Uploaded Fe de Jesús lesson ${index + 1} of 20\n`);
    }

    before = await apiJson(`/api/catalog?replace=${Date.now()}`);
    const action = buildReplacementAction(before.revision, uploadedTokens);
    const result = await apiJson('/api/manage/catalog', { method: 'POST', headers: editingHeaders, body: action });
    writtenManifest = result.manifest;
    assertReplacementResult(before, result.manifest);
    committed = true;
    process.stdout.write(JSON.stringify({
      revision: result.manifest.revision,
      sourceIndexVerified: true,
      recoveredLesson14: 'La Muerte',
      lessons: 20,
      otherCoursesUnchanged: true
    }) + '\n');
  } catch (error) {
    let rollbackError = null;
    if (!committed && before && writtenManifest && editingHeaders) {
      try {
        const restored = await apiJson('/api/manage/catalog', {
          method: 'POST',
          headers: editingHeaders,
          body: {
            type: 'catalog.rollback',
            baseRevision: writtenManifest.revision,
            targetRevision: before.revision,
            confirmText: 'RESTAURAR'
          }
        });
        invariant(JSON.stringify(restored.manifest.courses) === JSON.stringify(before.courses), 'Automatic rollback did not restore the original courses');
        invariant(JSON.stringify(restored.manifest.trash) === JSON.stringify(before.trash), 'Automatic rollback did not restore the original trash');
        writtenManifest = null;
      } catch (failure) {
        rollbackError = failure;
      }
    }
    if (!committed && uploadedTokens.length) {
      try {
        for (const assetToken of uploadedTokens) {
          await apiJson('/api/manage/upload', { method: 'POST', headers: editingHeaders, body: { action: 'discard', assetToken } }).catch(() => {});
        }
      } catch {}
    }
    if (rollbackError) throw new Error(`${error.message}. Automatic rollback failed: ${rollbackError.message}`);
    throw error;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
