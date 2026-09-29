const { allowMethod, sendError, standardHeaders } = require('../../_lib/cms/http');
const { requireHost, requireUuid } = require('../../_lib/code/security');
const { approvalDecision } = require('../../_lib/code/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    requireHost(req);
    const jobId = requireUuid(req.query.jobId, 'trabajo');
    const hostId = requireUuid(req.query.hostId, 'equipo');
    const approvalId = requireUuid(req.query.approvalId, 'aprobación');
    const decision = await approvalDecision(jobId, hostId, String(req.query.leaseToken || ''), approvalId);
    standardHeaders(res);
    res.status(200).json({ decision });
  } catch (error) { sendError(res, error); }
};
