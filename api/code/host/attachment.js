const { allowMethod, sendError, standardHeaders } = require('../../_lib/cms/http');
const { requireHost, requireUuid } = require('../../_lib/code/security');
const { readClaimedAttachment } = require('../../_lib/code/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    requireHost(req);
    const jobId = requireUuid(req.query.jobId, 'trabajo');
    const hostId = requireUuid(req.query.hostId, 'equipo');
    const attachmentId = requireUuid(req.query.attachmentId, 'archivo');
    const record = await readClaimedAttachment(jobId, hostId, String(req.query.leaseToken || ''), attachmentId);
    standardHeaders(res);
    res.status(200).json({
      attachmentId: record.id,
      name: record.name,
      mime: record.mime,
      size: record.size,
      sha256: record.sha256,
      data: record.data
    });
  } catch (error) { sendError(res, error); }
};
