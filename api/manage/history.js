const { allowMethod, sendError, standardHeaders } = require('../_lib/cms/http');
const { history } = require('../_lib/cms/storage');
const { requireEditor } = require('../_lib/code/security');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    requireEditor(req);
    const entries = await history(20);
    standardHeaders(res);
    res.status(200).json({ entries });
  } catch (error) {
    sendError(res, error);
  }
};
