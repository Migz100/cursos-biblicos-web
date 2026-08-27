const { CmsError } = require('./core');

function standardHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

async function readJson(req, maxBytes = 65536) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    let serialized;
    try { serialized = JSON.stringify(req.body); } catch { throw new CmsError(400, 'INVALID_JSON', 'La solicitud no es válida.'); }
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new CmsError(413, 'BODY_TOO_LARGE', 'La solicitud es demasiado grande.');
    return req.body;
  }
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
    const serialized = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new CmsError(413, 'BODY_TOO_LARGE', 'La solicitud es demasiado grande.');
    try { return JSON.parse(serialized || '{}'); } catch { throw new CmsError(400, 'INVALID_JSON', 'La solicitud no es válida.'); }
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw new CmsError(413, 'BODY_TOO_LARGE', 'La solicitud es demasiado grande.');
  }
  try { return JSON.parse(raw || '{}'); } catch { throw new CmsError(400, 'INVALID_JSON', 'La solicitud no es válida.'); }
}

function sendError(res, error) {
  standardHeaders(res);
  if (error instanceof CmsError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  res.status(500).json({ error: 'SERVER_ERROR', message: 'No se pudo completar la acción. Intenta otra vez.' });
}

function allowMethod(req, res, methods) {
  if (methods.includes(req.method)) return true;
  standardHeaders(res);
  res.setHeader('Allow', methods.join(', '));
  res.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'Método no permitido.' });
  return false;
}

module.exports = { allowMethod, readJson, sendError, standardHeaders };
