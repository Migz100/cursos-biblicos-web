#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { fetchPresentationAccessibility } = require('../api/_lib/cms/presentation-accessibility.js');
const LIVE_ORIGIN = 'https://cursos-biblicos-web.vercel.app';
const READ_ONLY_API = new Set([
  '/api/catalog',
  '/api/presentation',
  '/api/manage/audit',
  '/api/manage/history',
  '/api/manage/session'
]);
const BLOCKED_SEGMENTS = new Set(['.git', '.vercel', '.code-host', 'node_modules', 'work', 'worktrees']);
const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json']
]);

export function resolveStaticPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const parts = decoded.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some(part => part.startsWith('.env') || BLOCKED_SEGMENTS.has(part))) return null;
  if (!parts.length || decoded.endsWith('/')) parts.push('index.html');
  const candidate = path.resolve(ROOT, ...parts);
  return candidate === ROOT || candidate.startsWith(`${ROOT}${path.sep}`) ? candidate : null;
}

export function apiProxyAllowed(pathname, method = 'GET') {
  return method === 'GET' && READ_ONLY_API.has(pathname);
}

function securityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.public.blob.vercel-storage.com; connect-src 'self' https://*.public.blob.vercel-storage.com; frame-src https://view.officeapps.live.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

async function proxyApi(request, response, url) {
  if (!apiProxyAllowed(url.pathname, request.method)) {
    response.writeHead(405, { Allow: 'GET', 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'READ_ONLY_AUDIT_SERVER' }));
    return;
  }
  const upstream = await fetch(`${LIVE_ORIGIN}${url.pathname}${url.search}`, {
    method: 'GET',
    headers: { Accept: request.headers.accept || 'application/json' },
    cache: 'no-store',
    redirect: 'follow'
  });
  if (url.pathname === '/api/presentation' && upstream.ok) {
    const presentation = await upstream.json();
    presentation.accessibility = await fetchPresentationAccessibility(
      presentation.lesson?.downloadUrl,
      presentation.lesson?.type
    );
    response.statusCode = upstream.status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(presentation));
    return;
  }
  response.statusCode = upstream.status;
  response.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

async function handle(request, response) {
  securityHeaders(response);
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    await proxyApi(request, response, url);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }
  const filename = resolveStaticPath(url.pathname);
  if (!filename) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('No encontrado');
    return;
  }
  try {
    const body = await fs.readFile(filename);
    response.setHeader('Content-Type', MIME.get(path.extname(filename).toLowerCase()) || 'application/octet-stream');
    response.statusCode = 200;
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('No encontrado');
  }
}

export function startAuditServer(port = 4173) {
  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('No se pudo cargar el recurso de auditoría.');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argument = process.argv.find(value => value.startsWith('--port='));
  const requested = Number(argument?.split('=')[1] || 4173);
  const port = Number.isInteger(requested) && requested > 1024 && requested < 65536 ? requested : 4173;
  await startAuditServer(port);
  console.log(`Servidor local de auditoría: http://127.0.0.1:${port}`);
}
