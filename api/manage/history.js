const { allowMethod, sendError, standardHeaders } = require('../_lib/cms/http');
const { history } = require('../_lib/cms/storage');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    const entries = await history(20);
    standardHeaders(res);
    res.status(200).json({ entries });
  } catch (error) {
    sendError(res, error);
  }
};
