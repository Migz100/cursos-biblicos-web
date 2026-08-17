const { issueSignedToken } = require('@vercel/blob');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let maxSize = 15 * 1024 * 1024;
  let allowedContentTypes = ['application/pdf'];
  try {
    const j = JSON.parse(raw || '{}');
    if (Number.isFinite(j.maximumSizeInBytes)) maxSize = j.maximumSizeInBytes;
    if (Array.isArray(j.allowedContentTypes) && j.allowedContentTypes.length) {
      allowedContentTypes = j.allowedContentTypes.map(String);
    }
  } catch (e) {
    res.status(400).json({ error: 'invalid json' });
    return;
  }
  try {
    const result = await issueSignedToken({
      pathname: '*',
      operations: ['put'],
      maximumSizeInBytes: maxSize,
      allowedContentTypes,
      validUntil: Date.now() + 60 * 60 * 1000
    });
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};