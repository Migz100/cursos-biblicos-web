const { allowMethod, standardHeaders } = require('./_lib/cms/http');

module.exports = function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  const params = new URL(req.url, 'https://cursosbiblicos.app').searchParams;
  const tokens = params.getAll('s');
  standardHeaders(res);
  if (params.has('s') && (tokens.length !== 1 || !/^[a-f0-9]{64}$/.test(tokens[0]))) {
    return res.status(400).json({ error: 'INVALID_SELECTION' });
  }
  const start = tokens.length ? `/index.html?s=${tokens[0]}` : '/';
  const manifest = {
    id: start,
    name: 'Cursos Bíblicos',
    short_name: 'Cursos Bíblicos',
    start_url: start,
    scope: '/',
    display: 'standalone',
    background_color: '#F5F5F7',
    theme_color: '#F5F5F7',
    icons: [192, 512].map(size => ({
      src: `/assets/app-icon-${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'any maskable'
    }))
  };
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.status(200).send(JSON.stringify(manifest));
};
