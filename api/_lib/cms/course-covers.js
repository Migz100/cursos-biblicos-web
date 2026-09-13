const DEFAULT_COURSE_COVERS = Object.freeze({
  '1': '/assets/course-covers/fe-de-jesus.webp',
  '2': '/assets/course-covers/la-gran-esperanza.webp',
  '3': '/assets/course-covers/apocalipsis.webp',
  '4': '/assets/course-covers/daniel.webp',
  '5': '/assets/course-covers/familia-feliz.webp',
  '6': '/assets/course-covers/el-gran-conflicto.webp',
  '7': '/assets/course-covers/vuelve-a-casa.webp',
  '8': '/assets/course-covers/juventud-prometedora.webp',
  '9': '/assets/course-covers/acampando-con-el-creador.webp',
  '10': '/assets/course-covers/exploradores-de-la-verdad.webp',
  '11': '/assets/course-covers/yo-creo.webp',
  '12': '/assets/course-covers/jesus-y-yo.webp',
  '13': '/assets/course-covers/la-fe-de-jesus-powerpoint.webp',
});

const COURSE_COVER_VERSION = 'course-covers-v1';

function applyDefaultCourseCovers(manifest) {
  return {
    ...manifest,
    courses: (manifest.courses || []).map(course => ({
      ...course,
      coverUrl: course.coverUrl || DEFAULT_COURSE_COVERS[String(course.id)] || null,
    })),
  };
}

function courseCoverEtag(revision) {
  return `"${String(revision || 'catalog')}-${COURSE_COVER_VERSION}"`;
}

module.exports = {
  DEFAULT_COURSE_COVERS,
  applyDefaultCourseCovers,
  courseCoverEtag,
};
