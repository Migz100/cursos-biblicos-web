const { allowMethod, readJson, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireSameOrigin } = require('../_lib/cms/security');
const { requireEditor } = require('../_lib/code/security');
const { submitApproval } = require('../_lib/code/storage');
const { validateApprovalInput } = require('../_lib/code/validation');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireSameOrigin(req);
    requireEditor(req);
    const result = await submitApproval(validateApprovalInput(await readJson(req, 8 * 1024)));
    standardHeaders(res);
    res.status(202).json(result);
  } catch (error) { sendError(res, error); }
};
