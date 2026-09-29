const { allowMethod, sendError, standardHeaders } = require('../../_lib/cms/http');
const { requireHost, requireUuid } = require('../../_lib/code/security');
const { readControls } = require('../../_lib/code/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    requireHost(req);
    const jobId = requireUuid(req.query.jobId, 'trabajo');
    const hostId = requireUuid(req.query.hostId, 'equipo');
    const after = String(req.query.after || '');
    if (after && !/^[0-9]{13}-[0-9a-f-]{36}\.json$/i.test(after)) throw new Error('Invalid control cursor');
    const result = await readControls(jobId, hostId, String(req.query.leaseToken || ''), after);
    standardHeaders(res);
    res.status(200).json(result);
  } catch (error) { sendError(res, error); }
};
