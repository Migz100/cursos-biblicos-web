const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { allowMethod, sendError, standardHeaders } = require('./_lib/cms/http');
const { resolvePresentationLesson } = require('./_lib/cms/presentation');
const { preparePresentationPdf } = require('./_lib/cms/presentation-pdf');
const { loadManifest, namespace } = require('./_lib/cms/storage');

function queryValue(req, name) {
  const value = req.query?.[name];
  return Array.isArray(value) ? null : value;
}

module.exports = async function handler(req, res) {
  if (!allowMethod(req, res, ['GET'])) return;
  let prepared;
  try {
    const manifest = await loadManifest();
    const result = resolvePresentationLesson(manifest, queryValue(req, 'c'), queryValue(req, 'l'), namespace());
    const course = manifest.courses.find(item => item.id === result.course.id);
    const lesson = course.lessons.find(item => item.id === result.lesson.id);
    prepared = await preparePresentationPdf(lesson.url, { expectedBytes: lesson.size || undefined });
    standardHeaders(res);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(prepared.pdfBytes));
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(result.lesson.title)}.pdf"`);
    await pipeline(fs.createReadStream(prepared.pdfPath), res);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    else res.destroy(error);
  } finally {
    await prepared?.cleanup();
  }
};
