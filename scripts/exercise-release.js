const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PDF_ONE = '/Users/miguelperez/Desktop/Personal/Cursos Biblicos/02 La Gran Esperanza/Lección 08.pdf';
const PDF_TWO = '/Users/miguelperez/Desktop/Personal/Cursos Biblicos/02 La Gran Esperanza/Lección 09.pdf';
const PPTX = '/Users/miguelperez/Desktop/La Fe de Jes£s - PowePoint/01 Que ense¤a la biblia acerca de LAS SAGRADAS ESCRITURAS.pptx';
const PPSX = '/Users/miguelperez/Desktop/La Fe de Jesus PowerPoint.ppsx';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function tokenPath(token) {
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  return payload.value.pathname;
}

async function main() {
  const baseUrl = process.argv[2]?.replace(/\/$/, '');
  const protectedPreview = process.argv.includes('--vercel-protected');
  const production = process.argv.includes('--production');
  invariant(baseUrl, 'Usage: node scripts/exercise-release.js <deployment-url> [--vercel-protected|--production]');
  invariant(!production || baseUrl === 'https://cursos-biblicos-web.vercel.app', 'Production exercise requires the canonical URL');
  invariant(!protectedPreview || !production, 'Choose preview or production mode');

  const origin = new URL(baseUrl).origin;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursos-exercise-'));
  const cookieJar = path.join(directory, 'cookies.txt');
  let cookie = '';
  let csrf = '';
  const fixtureTokens = [];

  async function request(route, options = {}) {
    if (protectedPreview) {
      const output = path.join(directory, `response-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
      const args = [
        'curl', route, '--deployment', baseUrl,
        '--', '--silent', '--show-error', '--cookie', cookieJar, '--cookie-jar', cookieJar,
        '--output', output, '--request', options.method || 'GET'
      ];
      for (const [name, value] of Object.entries(options.headers || {})) args.push('--header', `${name}: ${value}`);
      if (options.body) args.push('--data-binary', JSON.stringify(options.body));
      execFileSync('vercel', args, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'ignore'] });
      const text = fs.readFileSync(output, 'utf8');
      try { return { data: JSON.parse(text) }; } catch { return { data: { error: 'NON_JSON_RESPONSE' } }; }
    }
    const response = await fetch(`${baseUrl}${route}`, {
      cache: 'no-store',
      method: options.method,
      headers: options.headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return { response, data: await response.json().catch(() => ({ error: 'NON_JSON_RESPONSE' })) };
  }

  async function api(route, options = {}, allowError = false) {
    const result = await request(route, options);
    if (!allowError && result.data.error) throw new Error(`${route}: ${result.data.error}`);
    return result;
  }

  function headers(overrides = {}) {
    return {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      ...(cookie ? { Cookie: cookie } : {}),
      ...overrides
    };
  }

  async function establishSession() {
    if (protectedPreview) {
      csrf = (await api('/api/manage/session')).data.csrfToken;
      return;
    }
    const response = await fetch(`${baseUrl}/api/manage/session`, { cache: 'no-store' });
    const data = await response.json();
    csrf = data.csrfToken;
    cookie = response.headers.getSetCookie?.()[0]?.split(';')[0] || response.headers.get('set-cookie')?.split(';')[0] || '';
    invariant(cookie && csrf, 'Editing session was not established');
  }

  async function mutate(action, baseRevision, allowError = false) {
    return (await api('/api/manage/catalog', {
      method: 'POST', headers: headers(), body: { ...action, baseRevision }
    }, allowError)).data;
  }

  async function upload(filename, contentType, bytes) {
    const prepared = (await api('/api/manage/upload', {
      method: 'POST', headers: headers(),
      body: { action: 'prepare', filename, contentType, size: bytes.length }
    })).data;
    const stored = await fetch(prepared.presignedUrl, {
      method: 'PUT', headers: { 'Content-Type': prepared.contentType }, body: bytes
    });
    invariant(stored.ok, `Fixture upload failed for ${filename}`);
    const finalized = (await api('/api/manage/upload', {
      method: 'POST', headers: headers(), body: { action: 'finalize', receipt: prepared.receipt }
    })).data;
    fixtureTokens.push(finalized.assetToken);
    return finalized;
  }

  async function cleanupAssets(cleanManifest) {
    const prefix = production ? 'cms/production/assets/' : 'cms/preview/';
    const serialized = JSON.stringify(cleanManifest);
    const unique = [...new Map(fixtureTokens.map(token => [tokenPath(token), token])).entries()];
    invariant(unique.every(([pathname]) => pathname.startsWith(prefix) && !serialized.includes(pathname)), 'Fixture cleanup boundary failed');
    for (const [, token] of unique) {
      const discarded = (await api('/api/manage/upload', {
        method: 'POST', headers: headers(), body: { action: 'discard', assetToken: token }
      })).data;
      invariant(discarded.discarded, 'Fixture asset was not discarded');
    }
  }

  try {
    await establishSession();
    const baseline = (await api(`/api/catalog?verify=${Date.now()}`)).data;
    invariant(baseline.courses.some(item => item.name === 'La Fe de Jesús 2'), 'Release course is missing before exercise');

    const missingCsrf = (await api('/api/manage/catalog', {
      method: 'POST', headers: headers({ 'X-CSRF-Token': '' }),
      body: { type: 'course.move', courseId: baseline.courses[0].id, toIndex: 1, baseRevision: baseline.revision }
    }, true)).data;
    invariant(missingCsrf.error === 'CSRF_DENIED', 'Missing CSRF request was not denied');

    const crossSite = (await api('/api/manage/catalog', {
      method: 'POST', headers: headers({ Origin: 'https://cross-site.invalid', 'Sec-Fetch-Site': 'cross-site' }),
      body: { type: 'course.move', courseId: baseline.courses[0].id, toIndex: 1, baseRevision: baseline.revision }
    }, true)).data;
    invariant(crossSite.error === 'ORIGIN_DENIED', 'Cross-site request was not denied');

    const invalidType = (await api('/api/manage/upload', {
      method: 'POST', headers: headers(),
      body: { action: 'prepare', filename: 'archivo.exe', contentType: 'application/octet-stream', size: 12 }
    }, true)).data;
    invariant(invalidType.error === 'INVALID_FILE_TYPE', 'Invalid extension was not denied');

    const fakePdf = Buffer.from('This is not a PDF file');
    const fakePrepared = (await api('/api/manage/upload', {
      method: 'POST', headers: headers(),
      body: { action: 'prepare', filename: 'falso.pdf', contentType: 'application/pdf', size: fakePdf.length }
    })).data;
    const fakeStored = await fetch(fakePrepared.presignedUrl, {
      method: 'PUT', headers: { 'Content-Type': fakePrepared.contentType }, body: fakePdf
    });
    invariant(fakeStored.ok, 'Invalid-file test upload did not reach inspection');
    const fakeFinalized = (await api('/api/manage/upload', {
      method: 'POST', headers: headers(), body: { action: 'finalize', receipt: fakePrepared.receipt }
    }, true)).data;
    invariant(fakeFinalized.error === 'INVALID_FILE_CONTENT', 'Invalid PDF content was not denied');

    const forged = (await mutate({
      type: 'lesson.add', courseId: baseline.courses[0].id, title: 'Forjada',
      asset: { validated: true, type: 'pdf', url: 'https://attacker.invalid/file.pdf' }
    }, baseline.revision, true));
    invariant(forged.error === 'INVALID_RECEIPT', 'Forged raw asset was not denied');

    const pdfOne = await upload('prueba-temporal-uno.pdf', 'application/pdf', fs.readFileSync(PDF_ONE));
    const pptx = await upload('prueba-temporal.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', fs.readFileSync(PPTX));
    const ppsx = await upload('prueba-temporal.ppsx', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow', fs.readFileSync(PPSX));
    const pdfTwo = await upload('prueba-temporal-dos.pdf', 'application/pdf', fs.readFileSync(PDF_TWO));

    let result = await mutate({
      type: 'course.add', name: 'PRUEBA TEMPORAL', short: 'TMP', color: '#2457A6', section: 'cursos',
      lessons: [
        { title: 'PDF temporal', assetToken: pdfOne.assetToken },
        { title: 'PowerPoint temporal', assetToken: pptx.assetToken }
      ]
    }, baseline.revision);
    let manifest = result.manifest;
    let course = manifest.courses.find(item => item.name === 'PRUEBA TEMPORAL');
    invariant(course?.lessons.length === 2, 'Temporary course add failed');

    result = await mutate({ type: 'course.update', courseId: course.id, name: production ? 'PRUEBA TEMPORAL PRODUCCIÓN' : 'PRUEBA TEMPORAL PREVIEW', short: 'TMP', color: '#336699', section: 'lafe' }, manifest.revision);
    manifest = result.manifest;
    course = manifest.courses.find(item => item.id === course.id);
    invariant(course.section === 'lafe', 'Course edit failed');

    result = await mutate({ type: 'course.move', courseId: course.id, toIndex: 0 }, manifest.revision);
    manifest = result.manifest;
    invariant(manifest.courses[0].id === course.id, 'Course reorder failed');

    result = await mutate({ type: 'lesson.add', courseId: course.id, title: 'Presentación completa temporal', assetToken: ppsx.assetToken }, manifest.revision);
    manifest = result.manifest;
    course = manifest.courses.find(item => item.id === course.id);
    let addedLesson = course.lessons.find(item => item.type === 'ppsx');

    result = await mutate({ type: 'lesson.rename', courseId: course.id, lessonId: addedLesson.id, title: 'PPSX temporal renombrada' }, manifest.revision);
    manifest = result.manifest;
    result = await mutate({ type: 'lesson.move', courseId: course.id, lessonId: addedLesson.id, toIndex: 0 }, manifest.revision);
    manifest = result.manifest;
    course = manifest.courses.find(item => item.id === course.id);
    invariant(course.lessons[0].id === addedLesson.id && course.lessons[0].title === 'PPSX temporal renombrada', 'Lesson rename or reorder failed');

    const pdfLesson = course.lessons.find(item => item.title === 'PDF temporal');
    result = await mutate({ type: 'lesson.replace', courseId: course.id, lessonId: pdfLesson.id, assetToken: pdfTwo.assetToken }, manifest.revision);
    manifest = result.manifest;
    course = manifest.courses.find(item => item.id === course.id);
    invariant(course.lessons.find(item => item.id === pdfLesson.id).originalName === 'prueba-temporal-dos.pdf', 'Lesson replacement failed');

    const pptLesson = course.lessons.find(item => item.title === 'PowerPoint temporal');
    result = await mutate({ type: 'lesson.remove', courseId: course.id, lessonId: pptLesson.id, confirmText: pptLesson.title }, manifest.revision);
    manifest = result.manifest;
    invariant(result.undoTrashId && manifest.trash.some(item => item.id === result.undoTrashId), 'Lesson soft delete failed');
    result = await mutate({ type: 'lesson.restore', trashId: result.undoTrashId }, manifest.revision);
    manifest = result.manifest;
    course = manifest.courses.find(item => item.id === course.id);
    invariant(course.lessons.some(item => item.id === pptLesson.id), 'Lesson restore failed');

    result = await mutate({ type: 'course.remove', courseId: course.id, confirmText: course.name }, manifest.revision);
    manifest = result.manifest;
    invariant(!manifest.courses.some(item => item.id === course.id), 'Course soft delete failed');
    result = await mutate({ type: 'course.restore', trashId: result.undoTrashId }, manifest.revision);
    manifest = result.manifest;
    course = manifest.courses.find(item => item.id === course.id);
    invariant(course, 'Course restore failed');

    const staleRevision = manifest.revision;
    result = await mutate({ type: 'course.update', courseId: course.id, name: course.name, short: 'TM1', color: course.color, section: course.section }, staleRevision);
    manifest = result.manifest;
    const conflict = await mutate({ type: 'course.update', courseId: course.id, name: course.name, short: 'TM2', color: course.color, section: course.section }, staleRevision, true);
    invariant(conflict.error === 'REVISION_CONFLICT', 'Stale revision was not denied');

    const history = (await api('/api/manage/history')).data.entries;
    invariant(history.length >= 10, 'Version history did not record the exercise');

    result = await mutate({ type: 'catalog.rollback', targetRevision: baseline.revision, confirmText: 'RESTAURAR' }, manifest.revision);
    const clean = result.manifest;
    invariant(clean.courses.length === baseline.courses.length && clean.trash.length === baseline.trash.length, 'Rollback did not restore the baseline');
    invariant(!clean.courses.some(item => item.name.includes('PRUEBA TEMPORAL')), 'Temporary course survived rollback');
    await cleanupAssets(clean);

    process.stdout.write(JSON.stringify({ csrfDenied: true, crossSiteDenied: true, invalidFilesDenied: 2, forgedAssetDenied: true, courseFlow: true, lessonFlow: true, conflictDenied: true, history: true, rollback: true, fixtureAssetsDeleted: fixtureTokens.length }) + '\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
