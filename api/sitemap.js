const { loadManifest } = require('./_lib/cms/storage');
const { sitemap } = require('./_lib/cms/seo');
const { applyContentRevisions } = require('./_lib/cms/content-revisions');
const { standardHeaders } = require('./_lib/cms/http');

module.exports = async function handler(req, res) {
  standardHeaders(res);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).send('');
    return;
  }
  try {
    const xml = sitemap(applyContentRevisions(await loadManifest()));
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.status(200).send(req.method === 'HEAD' ? '' : xml);
  } catch (_) {
    res.status(503).send('');
  }
};
