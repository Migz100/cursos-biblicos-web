const { allowMethod, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireCsrf } = require('../_lib/cms/security');
const { backupManifest, enforceRate } = require('../_lib/cms/storage');

const VISITOR_LIMIT = { count: 1, bytes: 0, windowMs: 24 * 60 * 60 * 1000 };
const GLOBAL_LIMIT = { count: 4, bytes: 0, windowMs: 24 * 60 * 60 * 1000 };

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireCsrf(req);
    await enforceRate(req, 'backups', 0, VISITOR_LIMIT, GLOBAL_LIMIT);
    const backup = await backupManifest();
    standardHeaders(res);
    res.status(200).json(backup);
  } catch (error) {
    sendError(res, error);
  }
};
