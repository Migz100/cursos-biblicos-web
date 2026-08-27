const { allowMethod, sendError, standardHeaders } = require('../_lib/cms/http');
const { requireSameOrigin } = require('../_lib/cms/security');
const { editorSessionCookie, newEditorSessionToken, requirePairingKey } = require('../_lib/code/security');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['POST'])) return;
  try {
    requireSameOrigin(req);
    requirePairingKey(req);
    standardHeaders(res);
    res.setHeader('Set-Cookie', editorSessionCookie(newEditorSessionToken()));
    res.status(200).json({ paired: true });
  } catch (error) { sendError(res, error); }
};
