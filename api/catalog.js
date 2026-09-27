const { allowMethod, sendError, standardHeaders } = require('./_lib/cms/http');
const { loadManifest } = require('./_lib/cms/storage');
const { applyDefaultCourseCovers, courseCoverEtag } = require('./_lib/cms/course-covers');
const { applyContentRevisions, CONTENT_REVISION_VERSION } = require('./_lib/cms/content-revisions');
const { restrictManifest, shareTokenFromRequest } = require('./_lib/cms/shares');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    const shareToken = shareTokenFromRequest(req);
    const manifest = await restrictManifest(req, applyContentRevisions(await loadManifest()));
    const catalog = applyDefaultCourseCovers(manifest);
    standardHeaders(res);
    if (!shareToken) {
      res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
      res.setHeader('ETag', courseCoverEtag(`${manifest.revision || 'catalog'}-${CONTENT_REVISION_VERSION}`));
    }
    res.status(200).json(catalog);
  } catch (error) {
    sendError(res, error);
  }
};
