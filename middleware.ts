import { rewrite } from '@vercel/functions';

export const config = {
  matcher: ['/', '/index.html', '/curso.html', '/cursos/:path*', '/leer.html', '/presentacion.html', '/sitemap.xml'],
};

export default function middleware(request: Request) {
  const original = new URL(request.url);
  const scopes = original.searchParams.getAll('s');
  // Vercel rewrites can discard empty query values. Reject them before rewriting.
  if (scopes.length && (scopes.length !== 1 || !/^[a-f0-9]{64}$/.test(scopes[0]))) {
    return new Response(request.method === 'HEAD' ? null : '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, follow"><title>Enlace no disponible · Cursos Bíblicos</title></head><body><main><h1>Este enlace no está disponible</h1><p>Pide un nuevo enlace a quien te lo envió.</p></main></body></html>', {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'X-Robots-Tag': 'noindex, follow' },
    });
  }
  const destination = new URL(original);
  if (original.pathname === '/sitemap.xml') {
    destination.pathname = '/api/sitemap';
    destination.search = '';
  } else {
    destination.pathname = '/api/seo-page';
    destination.searchParams.set('__path', original.pathname);
  }
  return rewrite(destination);
}
