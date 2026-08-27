const { CmsError } = require('../../_lib/cms/core');
const { allowMethod, readJson, sendError, standardHeaders } = require('../../_lib/cms/http');
const { requireHost, requireUuid } = require('../../_lib/code/security');
const { appendEvents } = require('../../_lib/code/storage');
const { cleanEvent } = require('../../_lib/code/validation');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireHost(req);
    const input = await readJson(req, 512 * 1024);
    const jobId = requireUuid(input.jobId, 'trabajo');
    const hostId = requireUuid(input.hostId, 'equipo');
    const leaseToken = String(input.leaseToken || '');
    if (!Array.isArray(input.events) || !input.events.length || input.events.length > 25) {
      throw new CmsError(400, 'INVALID_EVENTS', 'El grupo de avances no es válido.');
    }
    await appendEvents(jobId, hostId, leaseToken, input.events.map(cleanEvent));
    standardHeaders(res);
    res.status(200).json({ saved: input.events.length });
  } catch (error) { sendError(res, error); }
};
