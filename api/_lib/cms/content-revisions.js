const { applyCatalogArchive } = require('./catalog-archive');
const catalogArchive = require('./catalog-archive.json');
const { withLaFeDeJesus3 } = require('./la-fe-de-jesus-3');
const CONTENT_REVISION_VERSION = 'content-la-fe-3-20261003-v8';
const BLOB_ORIGIN = 'https://s0anajbi1aoffqbv.public.blob.vercel-storage.com';
const REVISION_PATH = `${BLOB_ORIGIN}/revisions-20260926-salvacion`;
const ORIGINAL_LESSON = `${BLOB_ORIGIN}/la-fe-de-jesus-v2/Leccion%2007-WDj950nBdSkHchQxIWopEwmjQR6WTw.pdf`;
const COURSE_ZIP = `${BLOB_ORIGIN}/revisions-20260927-la-fe/la-fe-de-jesus-pdf.zip`;
const PPT_ZIP = `${BLOB_ORIGIN}/revisions-20260927-la-fe/la-fe-de-jesus-ppt.zip`;
const LOCAL_REVISIONS = '/assets/revisions/la-fe-de-jesus';
const ORIGINAL_LESSONS = {
  '13-01': `${BLOB_ORIGIN}/la-fe-de-jesus-v2/Leccion%2001-00qk3wEIQyab3IwBwKk8o9W3FqW1nC.pdf`,
  '13-04': `${BLOB_ORIGIN}/la-fe-de-jesus-v2/Leccion%2004-kYKINirKnAgTyVm1aG8DXAce1KA3Y7.pdf`,
  '13-06': `${BLOB_ORIGIN}/la-fe-de-jesus-v2/Leccion%2006-q31jTw4h5UaML2adD7bUnBqszJadS7.pdf`,
  '13-08': `${BLOB_ORIGIN}/la-fe-de-jesus-v2/Leccion%2008-CuTqluyNrNlRusQSBNEjMo4JqSOrLg.pdf`,
  '13-10': `${BLOB_ORIGIN}/la-fe-de-jesus-v2/Leccion%2010-yY2f7T6kyeXHr7YiQFm3ZCI0Y42Ea4.pdf`,
};
const ORIGINAL_COURSE_ZIP = `${BLOB_ORIGIN}/zips/la-fe-de-jesus-pdf-v2-DPMiim56x6AHXL9kL70RoanqNcLDaY.zip`;
const ORIGINAL_PPT_ZIP = `${BLOB_ORIGIN}/zips/la-fe-de-jesus-ppt-LPBj4PmBn0VD4wvGLu7EliGareM63a.zip`;

function applyContentRevisions(manifest) {
  return applyCatalogArchive({
    ...manifest,
    courses: withLaFeDeJesus3((manifest.courses || []).map(course => course.id !== '13' ? course : {
      ...course,
      ...(course.zip === ORIGINAL_COURSE_ZIP ? { zip: COURSE_ZIP } : {}),
      ...(course.pptZip === ORIGINAL_PPT_ZIP ? { pptZip: PPT_ZIP, pptZipKind: 'current' } : {}),
      lessons: course.lessons.map(lesson => {
        if (lesson.id === '13-07' && lesson.url === ORIGINAL_LESSON) {
          return { ...lesson, url: `${REVISION_PATH}/leccion-07.pdf`, downloadUrl: `${REVISION_PATH}/leccion-07.pdf?download=1` };
        }
        if (ORIGINAL_LESSONS[lesson.id] && lesson.url === ORIGINAL_LESSONS[lesson.id]) {
          const url = `${LOCAL_REVISIONS}/leccion-${lesson.id.slice(3)}.pdf`;
          return { ...lesson, url, downloadUrl: url };
        }
        return lesson;
      }),
    })),
  }, catalogArchive);
}

module.exports = { applyContentRevisions, CONTENT_REVISION_VERSION };
