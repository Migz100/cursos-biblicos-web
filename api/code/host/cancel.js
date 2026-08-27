const { allowMethod, sendError, standardHeaders } = require('../../_lib/cms/http');
const { requireHost, requireUuid } = require('../../_lib/code/security');
const { cancellationRequested } = require('../../_lib/code/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    requireHost(req);
    const jobId = requireUuid(req.query.jobId, 'trabajo');
    const hostId = requireUuid(req.query.hostId, 'equipo');
    const leaseToken = String(req.query.leaseToken || '');
    standardHeaders(res);
    res.status(200).json({ cancelled: await cancellationRequested(jobId, hostId, leaseToken) });
  } catch (error) { sendError(res, error); }
};
