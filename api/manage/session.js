const { allowMethod, sendError, standardHeaders } = require('../_lib/cms/http');
const { csrfCookie, existingCsrfToken, newCsrfToken } = require('../_lib/cms/security');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    const token = existingCsrfToken(req) || newCsrfToken();
    standardHeaders(res);
    res.setHeader('Set-Cookie', csrfCookie(token));
    res.status(200).json({ csrfToken: token });
  } catch (error) {
    sendError(res, error);
  }
};
