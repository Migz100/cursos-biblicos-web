const { CmsError } = require('../../_lib/cms/core');
const { allowMethod, readJson, sendError, standardHeaders } = require('../../_lib/cms/http');
const { requireHost, requireUuid } = require('../../_lib/code/security');
const { completeClaimedJob } = require('../../_lib/code/storage');
const { cleanBrowserText, cleanCompletionData, cleanReleaseResult } = require('../../_lib/code/validation');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireHost(req);
    const input = await readJson(req, 256 * 1024);
    const jobId = requireUuid(input.jobId, 'trabajo');
    const hostId = requireUuid(input.hostId, 'equipo');
    const leaseToken = String(input.leaseToken || '');
    const status = String(input.status || '');
    if (!['completed', 'failed', 'cancelled'].includes(status)) throw new CmsError(400, 'INVALID_STATUS', 'El resultado no es válido.');
    const result = {
      status,
      provider: String(input.provider || '').slice(0, 30) || null,
      summary: cleanBrowserText(input.summary, 30000),
      url: /^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s]*)?$/.test(String(input.url || '')) ? String(input.url) : null,
      error: cleanBrowserText(input.error, 10000) || null,
      data: cleanCompletionData(input.data),
      release: cleanReleaseResult(input.release)
    };
    const record = await completeClaimedJob(jobId, hostId, leaseToken, result);
    standardHeaders(res);
    res.status(200).json(record);
  } catch (error) { sendError(res, error); }
};
