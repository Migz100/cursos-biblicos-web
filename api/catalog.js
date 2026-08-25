const { allowMethod, sendError, standardHeaders } = require('./_lib/cms/http');
const { loadManifest } = require('./_lib/cms/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    const manifest = await loadManifest();
    standardHeaders(res);
    res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
    res.setHeader('ETag', `"${manifest.revision}"`);
    res.status(200).json(manifest);
  } catch (error) {
    sendError(res, error);
  }
};
