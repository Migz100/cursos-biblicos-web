const { allowMethod, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireEditor } = require('../_lib/code/security');
const { editorStatus } = require('../_lib/code/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    requireEditor(req);
    standardHeaders(res);
    res.status(200).json(await editorStatus());
  } catch (error) { sendError(res, error); }
};
