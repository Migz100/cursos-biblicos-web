const { allowMethod, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireEditor } = require('../_lib/code/security');
const { auditManifest } = require('../_lib/cms/content-audit');
const { loadManifest } = require('../_lib/cms/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    requireEditor(req);
    const manifest = await loadManifest();
    standardHeaders(res);
    res.status(200).json(auditManifest(manifest));
  } catch (error) {
    sendError(res, error);
  }
};
