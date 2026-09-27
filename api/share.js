const { allowMethod, readJson, sendError, standardHeaders } = require('./_lib/cms/http');
const { requireSameOrigin } = require('./_lib/cms/security');
const { createShare } = require('./_lib/cms/shares');
const { enforceRate, loadManifest } = require('./_lib/cms/storage');

const VISITOR_LIMIT = { count: 120, bytes: 4 * 1024 * 1024, windowMs: 60 * 60 * 1000 };
const GLOBAL_LIMIT = { count: 1200, bytes: 32 * 1024 * 1024, windowMs: 60 * 60 * 1000 };

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireSameOrigin(req);
    const input = await readJson(req);
    await enforceRate(req, 'shares', Buffer.byteLength(JSON.stringify(input)), VISITOR_LIMIT, GLOBAL_LIMIT);
    const result = await createShare(await loadManifest(), input);
    standardHeaders(res);
    res.status(200).json(result);
  } catch (error) {
    sendError(res, error);
  }
};
