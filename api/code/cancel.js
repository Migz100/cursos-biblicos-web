const { allowMethod, readJson, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireSameOrigin } = require('../_lib/cms/security');
const { requireEditor, requireUuid } = require('../_lib/code/security');
const { requestCancellation } = require('../_lib/code/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireSameOrigin(req);
    requireEditor(req);
    const input = await readJson(req, 4096);
    const jobId = requireUuid(input.jobId, 'trabajo');
    standardHeaders(res);
    res.status(200).json(await requestCancellation(jobId));
  } catch (error) { sendError(res, error); }
};
