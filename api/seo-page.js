const fs = require('node:fs');
const { loadManifest } = require('./_lib/cms/storage');
const { restrictManifest, shareTokenFromRequest } = require('./_lib/cms/shares');
const { applyContentRevisions } = require('./_lib/cms/content-revisions');
const { applyDefaultCourseCovers } = require('./_lib/cms/course-covers');
const { standardHeaders } = require('./_lib/cms/http');
const { resolvePage, renderPage, errorPage } = require('./_lib/cms/seo');

// Literal template paths keep the HTML files in Vercel's function trace.
const templates = {
  index: fs.readFileSync(require.resolve('../index.html'), 'utf8'),
  curso: fs.readFileSync(require.resolve('../curso.html'), 'utf8'),
  leer: fs.readFileSync(require.resolve('../leer.html'), 'utf8'),
  presentacion: fs.readFileSync(require.resolve('../presentacion.html'), 'utf8')
};

module.exports = async function handler(req, res) {
  standardHeaders(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('X-Robots-Tag', 'noindex, follow');
    res.status(405).send(errorPage('Método no permitido.'));
    return;
  }
  try {
    const params = new URL(req.url, 'https://cursosbiblicos.app').searchParams;
    const paths = params.getAll('__path');
    if (paths.length !== 1) { const error = new Error('Invalid route'); error.status = 404; throw error; }
    const scope = shareTokenFromRequest(req);
    const manifest = applyDefaultCourseCovers(await restrictManifest(req, applyContentRevisions(await loadManifest())));
    const page = resolvePage(paths[0], params, manifest, scope);
    const rendered = renderPage(templates[page.template], page, manifest, scope);
    if (rendered.noindex) res.setHeader('X-Robots-Tag', 'noindex, follow');
    if (!scope) res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
    res.status(200).send(req.method === 'HEAD' ? '' : rendered.html);
  } catch (error) {
    res.setHeader('X-Robots-Tag', 'noindex, follow');
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 503;
    const message = status === 503 ? 'No se pudo cargar esta página. Intenta recargarla.' : 'Este enlace no está disponible. Pide un nuevo enlace a quien te lo envió.';
    res.status(status).send(req.method === 'HEAD' ? '' : errorPage(message));
  }
};
