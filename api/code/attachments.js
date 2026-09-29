const { allowMethod, readJson, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireSameOrigin } = require('../_lib/cms/security');
const { requireEditor } = require('../_lib/code/security');
const { storeAttachment } = require('../_lib/code/storage');
const { validateAttachmentInput } = require('../_lib/code/validation');
const { enforceRate } = require('../_lib/cms/storage');

const VISITOR_LIMIT = { count: 20, bytes: 24 * 1024 * 1024, windowMs: 24 * 60 * 60 * 1000 };
const GLOBAL_LIMIT = { count: 100, bytes: 120 * 1024 * 1024, windowMs: 24 * 60 * 60 * 1000 };

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireSameOrigin(req);
    requireEditor(req);
    const attachment = validateAttachmentInput(await readJson(req, 4 * 1024 * 1024 + 64 * 1024));
    await enforceRate(req, 'code-attachments', attachment.size, VISITOR_LIMIT, GLOBAL_LIMIT);
    const result = await storeAttachment(attachment);
    standardHeaders(res);
    res.status(201).json(result);
  } catch (error) { sendError(res, error); }
};
