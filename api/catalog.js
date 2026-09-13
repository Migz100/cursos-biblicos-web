const { allowMethod, sendError, standardHeaders } = require('./_lib/cms/http');
const { loadManifest } = require('./_lib/cms/storage');
const { applyDefaultCourseCovers, courseCoverEtag } = require('./_lib/cms/course-covers');

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  try {
    const manifest = await loadManifest();
    const catalog = applyDefaultCourseCovers(manifest);
    standardHeaders(res);
    res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
    res.setHeader('ETag', courseCoverEtag(manifest.revision));
    res.status(200).json(catalog);
  } catch (error) {
    sendError(res, error);
  }
};
