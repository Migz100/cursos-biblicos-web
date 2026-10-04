// La Fe de Jesús 3: the "Curso Básico" edition published by the Angeles Seventh-day
// Adventist church (angelesva.adventistchurch.org/about-us/la-fe-de-jesus-pdf/).
// Each source PDF is one landscape spread (lesson + Estudio adicional). The reader
// opens a lossless two-page portrait copy (the spread cropped in half) so answer
// lines and verse buttons are usable on a phone; downloads keep the source file.
const BLOB_ORIGIN = 'https://s0anajbi1aoffqbv.public.blob.vercel-storage.com';
const FOLDER = `${BLOB_ORIGIN}/la-fe-de-jesus-3`;
const COURSE_ID = 'la-fe-de-jesus-3';
const TITLES = [
  '¿Qué Enseña la Biblia Acerca de Dios?',
  'La Santa Biblia',
  'La Oración y la Fe',
  'El Regreso de Cristo',
  'Señales del Regreso de Cristo',
  'El Origen del Pecado',
  'La Salvación',
  'El Perdón de los Pecados',
  'El Juicio',
  'La Ley de Dios',
  'El Día de Descanso',
  'Cómo se Debe Guardar el Sábado',
  '¿Qué es la Muerte?',
  'La Iglesia de Cristo',
  'El Don de Profecía',
  'Las Normas Cristianas',
  'El Bautismo',
  'Socios de Dios',
  'La Vida Cristiana',
  'Dios nos Llama'
];

const course = Object.freeze({
  id: COURSE_ID,
  name: 'La Fe de Jesús 3',
  short: 'LF3',
  color: '#8B1E3F',
  section: 'cursos',
  source: 'starter',
  managed: false,
  coverUrl: '/assets/course-covers/la-fe-de-jesus-3.webp',
  zip: `${BLOB_ORIGIN}/zips/la-fe-de-jesus-3.zip`,
  zipKind: 'current',
  pptZip: null,
  lessons: Object.freeze(TITLES.map((title, index) => {
    const number = String(index + 1).padStart(2, '0');
    const original = `${FOLDER}/original/leccion-${number}.pdf`;
    return Object.freeze({
      id: `lf3-${number}`,
      legacyNumber: number,
      title,
      type: 'pdf',
      url: `${FOLDER}/leccion-${number}.pdf`,
      downloadUrl: `${original}?download=1`,
      originalUrl: original,
      originalName: `La Fe de Jesús 3 - Lección ${number}.pdf`,
      pathname: null,
      size: null,
      managed: false
    });
  }))
});

// Adds the course once, before the existing ones, unless the catalog already has it.
function withLaFeDeJesus3(courses) {
  if (courses.some(item => item.id === COURSE_ID)) return courses;
  return [{ ...course, lessons: course.lessons.map(lesson => ({ ...lesson })) }, ...courses];
}

module.exports = { LA_FE_DE_JESUS_3: course, withLaFeDeJesus3 };
