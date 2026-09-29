const { allowMethod, readJson, sendError, standardHeaders } = require('../../_lib/cms/http');
const { requireSameOrigin } = require('../../_lib/cms/security');
const { requireEditor } = require('../../_lib/code/security');
const { enqueueJob } = require('../../_lib/code/storage');
const { validateReleaseRequest } = require('../../_lib/code/validation');
const { enforceRate } = require('../../_lib/cms/storage');
const { CODE_JOB_GLOBAL_LIMIT, CODE_JOB_VISITOR_LIMIT } = require('../../_lib/code/limits');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireSameOrigin(req);
    requireEditor(req);
    const request = validateReleaseRequest('publish', await readJson(req, 16 * 1024));
    await enforceRate(req, 'code-jobs', 0, CODE_JOB_VISITOR_LIMIT, CODE_JOB_GLOBAL_LIMIT);
    const job = await enqueueJob(request);
    standardHeaders(res);
    res.status(202).json({ jobId: job.id, conversationId: job.conversationId, queuedAt: job.createdAt });
  } catch (error) { sendError(res, error); }
};
