const { CmsError, fileInfo } = require('../_lib/cms/core');
const { allowMethod, readJson, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireCsrf } = require('../_lib/cms/security');
const { requireEditor } = require('../_lib/code/security');
const { discardUpload, enforceRate, finalizeUpload, prepareUpload } = require('../_lib/cms/storage');

const VISITOR_UPLOAD_LIMIT = { count: 70, bytes: 150 * 1024 * 1024, windowMs: 24 * 60 * 60 * 1000 };
const GLOBAL_UPLOAD_LIMIT = { count: 100, bytes: 500 * 1024 * 1024, windowMs: 24 * 60 * 60 * 1000 };

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireEditor(req);
    requireCsrf(req);
    const body = await readJson(req, 16384);
    let result;
    if (body.action === 'prepare') {
      const info = fileInfo(body.filename, body.contentType, body.size);
      await enforceRate(req, 'uploads', info.size, VISITOR_UPLOAD_LIMIT, GLOBAL_UPLOAD_LIMIT);
      result = await prepareUpload(info);
    } else if (body.action === 'finalize') {
      result = await finalizeUpload(body.receipt);
    } else if (body.action === 'discard') {
      result = await discardUpload(body.assetToken);
    } else {
      throw new CmsError(400, 'INVALID_ACTION', 'La acción de carga no es válida.');
    }
    standardHeaders(res);
    res.status(200).json(result);
  } catch (error) {
    sendError(res, error);
  }
};
