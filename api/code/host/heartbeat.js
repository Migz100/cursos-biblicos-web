const { allowMethod, readJson, sendError, standardHeaders } = require('../../_lib/cms/http');
const { requireHost, requireUuid } = require('../../_lib/code/security');
const { heartbeat } = require('../../_lib/code/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireHost(req);
    const input = await readJson(req, 32 * 1024);
    const id = requireUuid(input.id, 'equipo');
    const providers = Array.isArray(input.providers) ? input.providers.slice(0, 10).map(item => ({
      id: String(item.id || '').slice(0, 30),
      name: String(item.name || '').slice(0, 60),
      available: Boolean(item.available),
      reason: String(item.reason || '').slice(0, 160)
    })) : [];
    await heartbeat({
      id,
      name: String(input.name || 'Computadora de edición').slice(0, 80),
      version: String(input.version || '').slice(0, 30),
      busy: Boolean(input.busy),
      currentJobId: input.currentJobId ? requireUuid(input.currentJobId, 'trabajo') : null,
      providers
    });
    standardHeaders(res);
    res.status(200).json({ ok: true });
  } catch (error) { sendError(res, error); }
};
