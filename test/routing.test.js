const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../middleware.ts'), 'utf8')
  .replace("import { rewrite } from '@vercel/functions';", '')
  .replace('export const config', 'const config')
  .replace('export default function middleware(request: Request)', 'function middleware(request)');
const route = vm.runInNewContext(`${source}\nmiddleware`, {
  URL, Response, rewrite: destination => new Response(null, { headers: { 'x-middleware-rewrite': String(destination) } }),
});
const token = 'a'.repeat(64);

test('routing rejects empty, duplicate and malformed shares before Vercel can discard empty values', async () => {
  for (const path of ['/?s', '/?s=', '/index.html?s=', '/curso.html?c=1&s=', '/cursos/fe-de-jesus/?s=', '/?s=&s=', `/?s=${token}&s=`, '/?s=bad']) {
    const response = route(new Request(`https://cursosbiblicos.app${path}`));
    assert.equal(response.status, 400, path);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
    assert.equal(response.headers.get('x-middleware-rewrite'), null);
    assert.doesNotMatch(await response.text(), /class="card"|courseTitle|api\/catalog/);
  }
});

test('routing preserves valid selection and reader parameters and keeps public sitemap separate', () => {
  const response = route(new Request(`https://cursosbiblicos.app/leer.html?c=1&l=1-03&s=${token}`));
  const destination = new URL(response.headers.get('x-middleware-rewrite'));
  assert.equal(destination.pathname, '/api/seo-page');
  assert.equal(destination.searchParams.get('__path'), '/leer.html');
  assert.equal(destination.searchParams.get('s'), token);
  assert.equal(destination.searchParams.get('l'), '1-03');
  assert.equal(new URL(route(new Request('https://cursosbiblicos.app/')).headers.get('x-middleware-rewrite')).searchParams.has('s'), false);
  assert.equal(route(new Request('https://cursosbiblicos.app/sitemap.xml')).headers.get('x-middleware-rewrite'), 'https://cursosbiblicos.app/api/sitemap');
});
