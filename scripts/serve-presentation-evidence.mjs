import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import presentationModule from '../api/_lib/cms/presentation.js';

const { resolvePresentationLesson } = presentationModule;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const STATIC_FILES = new Set([
  '', 'index.html', 'site.js', 'curso.html', 'course.js', 'presentacion.html', 'presentation.js', 'styles.css'
]);
const STATIC_PREFIXES = ['vendor/'];
const STATIC_ARTIFACTS = new Map([
  ['assets/la-fe-de-jesus-2-cover.png', {
    relativeFile: 'assets/la-fe-de-jesus-2-cover.png',
    sha256: 'd7197713d94669eed51b83a882264f3de5cabd9702c3d67d49d5195360c228a0',
    contentType: 'image/png'
  }],
  ['favicon.svg', {
    relativeFile: 'favicon.svg',
    sha256: 'fdd860483d8a3eb16e8aa09f1203ab96f61a0da4827829eb1ac53b0cd9227335',
    contentType: 'image/svg+xml'
  }],
  ['favicon.ico', {
    relativeFile: 'favicon.svg',
    sha256: 'fdd860483d8a3eb16e8aa09f1203ab96f61a0da4827829eb1ac53b0cd9227335',
    contentType: 'image/svg+xml'
  }]
]);
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon']
]);

function parseArgs(values) {
  const options = { port: 4173 };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--package') options.package = values[++index];
    else if (values[index] === '--port') options.port = Number(values[++index]);
    else throw new Error(`Argumento no reconocido: ${values[index]}`);
  }
  if (!options.package) throw new Error('Falta --package.');
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('Puerto inválido.');
  return options;
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function within(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved !== resolvedRoot && resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

async function sendFile(request, response, file, options = {}) {
  const stat = await fs.stat(file);
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = request.headers.range;
  if (range && options.ranges) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      response.end();
      return;
    }
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= stat.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      response.end();
      return;
    }
    status = 206;
  }
  const headers = {
    'Content-Type': options.contentType || CONTENT_TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Cache-Control': options.cache || 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (options.ranges) headers['Accept-Ranges'] = 'bytes';
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  response.writeHead(status, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const handle = await fs.open(file, 'r');
  const stream = handle.createReadStream({ start, end });
  stream.once('close', () => handle.close().catch(() => {}));
  stream.once('error', error => response.destroy(error));
  stream.pipe(response);
}

export async function verifyStaticArtifacts(artifacts = STATIC_ARTIFACTS, repoRoot = REPO_ROOT) {
  const verifiedRoot = await fs.realpath(repoRoot);
  const verified = new Map();
  for (const [requestPath, artifact] of artifacts) {
    if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(requestPath) || requestPath.includes('..') || requestPath.includes('\\')) {
      throw Object.assign(new Error(`Ruta de evidencia no permitida: ${requestPath}`), { code: 'STATIC_ARTIFACT_PATH_INVALID' });
    }
    if (!artifact || !/^[a-f0-9]{64}$/i.test(artifact.sha256 || '')) {
      throw Object.assign(new Error(`Hash de evidencia inválido: ${requestPath}`), { code: 'STATIC_ARTIFACT_HASH_INVALID' });
    }
    const candidate = path.resolve(verifiedRoot, artifact.relativeFile || '');
    if (!within(verifiedRoot, candidate)) {
      throw Object.assign(new Error(`Activo de evidencia fuera del repositorio: ${requestPath}`), { code: 'STATIC_ARTIFACT_PATH_INVALID' });
    }
    const file = await fs.realpath(candidate);
    if (!within(verifiedRoot, file)) {
      throw Object.assign(new Error(`Activo de evidencia fuera del repositorio: ${requestPath}`), { code: 'STATIC_ARTIFACT_PATH_INVALID' });
    }
    const actualSha256 = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
    if (actualSha256 !== artifact.sha256.toLowerCase()) {
      throw Object.assign(new Error(`Hash de evidencia no coincide: ${requestPath}`), {
        code: 'STATIC_ARTIFACT_HASH_MISMATCH',
        requestPath,
        expectedSha256: artifact.sha256.toLowerCase(),
        actualSha256
      });
    }
    verified.set(requestPath, { ...artifact, file, sha256: actualSha256 });
  }
  return verified;
}

async function buildServer(options) {
  const packageRoot = await fs.realpath(path.resolve(options.package));
  const failed = path.join(packageRoot, 'FAILED.json');
  const [ledger, catalog, failedRecord, staticArtifacts] = await Promise.all([
    fs.readFile(path.join(packageRoot, 'ledger.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(packageRoot, 'catalog.proposed.json'), 'utf8').then(JSON.parse),
    fs.readFile(failed, 'utf8').then(JSON.parse, () => null),
    verifyStaticArtifacts()
  ]);
  if (failedRecord && !(failedRecord.code === 'VISUAL_REVIEW_REQUIRED' && ledger.status === 'passed' && ledger.priorFailureRecord === 'FAILED.json' && ledger.visualReview?.finalized === true)) {
    throw new Error('El paquete está marcado como fallido.');
  }
  if (ledger.status !== 'passed' || !ledger.noUploadPerformed || !ledger.noCatalogMutationPerformed) throw new Error('El ledger no es una evidencia local aprobada.');
  const assets = new Map(ledger.assets.map(asset => [asset.lessonId, asset]));
  for (const asset of assets.values()) {
    if (!/^[a-z0-9][a-z0-9.-]*\.pdf$/i.test(asset.assetFile)) throw new Error(`Nombre de activo inseguro: ${asset.assetFile}`);
    const file = await fs.realpath(path.join(packageRoot, 'assets', asset.assetFile));
    if (!within(path.join(packageRoot, 'assets'), file)) throw new Error(`Activo fuera del paquete: ${asset.assetFile}`);
  }

  return http.createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end();
        return;
      }
      const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
      if (url.pathname === '/api/catalog') {
        if (request.method === 'HEAD') { response.writeHead(200, { 'Cache-Control': 'no-store' }); response.end(); return; }
        sendJson(response, 200, catalog);
        return;
      }
      if (url.pathname === '/api/presentation') {
        if (request.method === 'HEAD') { response.writeHead(405, { Allow: 'GET' }); response.end(); return; }
        const courseId = url.searchParams.get('c');
        const lessonId = url.searchParams.get('l');
        const result = resolvePresentationLesson(catalog, courseId, lessonId, ledger.namespace);
        const asset = assets.get(lessonId);
        if (!asset) throw Object.assign(new Error('La evidencia local no contiene ese PDF.'), { status: 404, code: 'LOCAL_PDF_NOT_FOUND' });
        result.pdfUrl = `/__derived/${encodeURIComponent(asset.assetFile)}`;
        sendJson(response, 200, result);
        return;
      }
      if (url.pathname.startsWith('/__derived/')) {
        const name = decodeURIComponent(url.pathname.slice('/__derived/'.length));
        const asset = [...assets.values()].find(item => item.assetFile === name);
        if (!asset) { sendJson(response, 404, { error: 'LOCAL_PDF_NOT_FOUND', message: 'PDF local no permitido.' }); return; }
        const file = await fs.realpath(path.join(packageRoot, 'assets', asset.assetFile));
        if (!within(path.join(packageRoot, 'assets'), file)) throw new Error('Ruta de activo insegura.');
        await sendFile(request, response, file, { ranges: true, cache: 'private, max-age=0' });
        return;
      }
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!relative) relative = 'index.html';
      const artifact = staticArtifacts.get(relative);
      if (artifact) {
        await sendFile(request, response, artifact.file, { cache: 'no-store', contentType: artifact.contentType });
        return;
      }
      if (!STATIC_FILES.has(relative) && !STATIC_PREFIXES.some(prefix => relative.startsWith(prefix))) {
        sendJson(response, 404, { error: 'LOCAL_PATH_NOT_ALLOWLISTED', message: 'Ruta local no permitida.' });
        return;
      }
      const file = path.resolve(REPO_ROOT, relative);
      if (!within(REPO_ROOT, file)) throw new Error('Ruta estática insegura.');
      await sendFile(request, response, file, { cache: 'no-store' });
    } catch (error) {
      if (!response.headersSent) sendJson(response, Number(error.status) || 500, { error: error.code || 'LOCAL_SERVER_ERROR', message: error.message });
      else response.destroy(error);
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = await buildServer(options);
  server.listen(options.port, '127.0.0.1', () => {
    console.log(`READY http://127.0.0.1:${options.port}`);
  });
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch(error => {
    console.error(`FAIL: ${error.code || 'LOCAL_SERVER_ERROR'}: ${error.message}`);
    process.exitCode = 1;
  });
}
