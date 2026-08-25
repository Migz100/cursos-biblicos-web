const { allowMethod, sendError, standardHeaders } = require('./_lib/cms/http');
const { resolvePresentationLesson } = require('./_lib/cms/presentation');
const { loadManifest, namespace } = require('./_lib/cms/storage');

function queryValue(req, name) {
  const value = req.query?.[name];
  return Array.isArray(value) ? null : value;
}

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    const manifest = await loadManifest();
    const result = resolvePresentationLesson(manifest, queryValue(req, 'c'), queryValue(req, 'l'), namespace());
    standardHeaders(res);
    res.status(200).json(result);
  } catch (error) {
    sendError(res, error);
  }
};
