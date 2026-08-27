const { allowMethod, readJson, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireSameOrigin } = require('../_lib/cms/security');
const { requireEditor } = require('../_lib/code/security');
const { enqueueJob } = require('../_lib/code/storage');
const { validateJobInput } = require('../_lib/code/validation');
const { enforceRate } = require('../_lib/cms/storage');

const VISITOR_LIMIT = { count: 120, bytes: 2 * 1024 * 1024, windowMs: 24 * 60 * 60 * 1000 };
const GLOBAL_LIMIT = { count: 240, bytes: 4 * 1024 * 1024, windowMs: 24 * 60 * 60 * 1000 };

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireSameOrigin(req);
    requireEditor(req);
    const job = validateJobInput(await readJson(req, 32 * 1024));
    await enforceRate(req, 'code-jobs', Buffer.byteLength(job.prompt || '', 'utf8'), VISITOR_LIMIT, GLOBAL_LIMIT);
    await enqueueJob(job);
    standardHeaders(res);
    res.status(202).json({ jobId: job.id, conversationId: job.conversationId, queuedAt: job.createdAt });
  } catch (error) { sendError(res, error); }
};
