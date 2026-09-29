const { allowMethod, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireEditor, requireUuid } = require('../_lib/code/security');
const { jobState } = require('../_lib/code/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    requireEditor(req);
    const jobId = requireUuid(req.query.jobId, 'trabajo');
    const clientId = requireUuid(req.query.clientId, 'navegador');
    const conversationId = requireUuid(req.query.conversationId, 'chat');
    const after = Math.max(0, Math.min(999999999, Number(req.query.after) || 0));
    standardHeaders(res);
    res.status(200).json(await jobState(jobId, after, clientId, conversationId));
  } catch (error) { sendError(res, error); }
};
