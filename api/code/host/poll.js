const { allowMethod, readJson, sendError, standardHeaders } = require('../../_lib/cms/http');
const { requireHost, requireUuid } = require('../../_lib/code/security');
const { claimNextJob, heartbeat } = require('../../_lib/code/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireHost(req);
    const input = await readJson(req, 32 * 1024);
    const hostId = requireUuid(input.hostId, 'equipo');
    if (input.host && typeof input.host === 'object') {
      await heartbeat({ ...input.host, id: hostId, busy: false, currentJobId: null });
    }
    const job = await claimNextJob(hostId);
    standardHeaders(res);
    res.status(200).json({ job });
  } catch (error) { sendError(res, error); }
};
