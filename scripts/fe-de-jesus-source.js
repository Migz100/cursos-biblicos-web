const SOURCE_INDEX_PATH = '/Users/miguelperez/Desktop/Cursos biblícos (1).pdf';
const SOURCE_INDEX_SHA256 = '72c0f0a5320f9242eb2fb43dc2d883a6032060e19cdb5ea06ac8748d55c58e5f';
const COURSE_ID = '1';
const COURSE_NAME = 'Fe de Jesús';
const COMPLETE_COURSE_ID = '1rLBcLmifhNuFXfFm0d6vjVyXDeholiQi';
const COMPLETE_COURSE_SHA256 = 'a8145444ccf08d8577fa51559993073bbbec1668ddd4ae5df9db3157942bff31';

const SOURCE_IDS = [
  '1PMOv8nGneMvKcuEhD70sqjGjHIAG7LVp',
  '1VLiIWimgQmwEKvxugTRFGZ2XtR3eoIz1',
  '1l0mqVfVoCatBCCI8i2y8wE2tXTp-UETj',
  '1EHOWfsv25SwwbHeKvfO6KGjKQvEP_Sms',
  '18RU48ntvqnXMje3myBlhek0_pSykd3G1',
  '1fITxkdBVdDTKKCp2vyIQmeDvPwDI0c2L',
  '1mQqeGJmtzYUWHqKIOyW7HCyJ0LyHjkjM',
  '1vCwZUraRhE_41XvGEsWrV4_xLVZyU_BR',
  '1bHBw4y7Xyt0kYzfuTbogZhJ4qfqCLkUm',
  '1Ld6wT4tBw6Mvk_4N8HblWjlItvkRaRWe',
  '1_fI7nP9l-mBLNikLEylfmwKAUXI-n_Xv',
  '1KF5n3A3ZPIww4lwEMQIamXA0alASiF8R',
  '1tkxSIptuj9xRroFiv_J8V19FBKwX0Uvp',
  '1tkxSIptuj9xRroFiv_J8V19FBKwX0Uvp',
  '1KkkPi60s3aFfmKssiwl_uJKw2JKdYu0W',
  '155gnVIEDcStwsPFwdUuaClFNvSD8uTnh',
  '10ZlmUqD-UZ1_Llco8tMRrLFP3MmGS50M',
  '16x-oaLFyUnM2RfeRhjaX-LruR9Wka_aE',
  '13oP6I9kdW9oaxZ1YjwP_EZLxU6EaRqGE',
  '1I51TzeF43sIgA0gT_NgSnFUbiKEA1BVo'
];

const SOURCE_SHA256 = [
  '2e13452126a1894ea49f6ba28df58bb75181974877886103e79654533f52bc4d',
  '55c9207c59caefbb0f918fc4cfe019eae9f48b23f2744f384dbbee271af8b3e2',
  'bc90e8021a22742720ec5d4b3c36fba51bc045b3ddc63cd179633fbb65403adc',
  'd2313733a90b46a1dd06f0628563299a79fa4b987ecfe36b98641685685334e4',
  '3c4da855e925d3f926f714a3c2a91576befa144d9e926b4f69aa98310ccf0618',
  'ece8656698cb90e836e98576d63758eb06789a9dcd1a094405b318738a96e683',
  '220b764081949c9c543225052bd6dd9cbf2430162308cbe2f40c5d142def1529',
  '2f5dbbed77fa0a7a911aa15899ca99b25c7a116d49dc91002dac6d43c6d97c2d',
  '393f33bed9d281a6334df3e3f7effe28a052875f5cb2fd400acc0d918f325e39',
  '368702f365e03006ea0111fe4d3ec9085a1f39894b8cf9f9bf86d367c7fa4b47',
  '659c553df12ce907962206b0a150edb9e806e6744138ffc586714b0031f0c60d',
  '9fc0e0ccf802f3ae62e061af00be140cffe92ba4908bada91be90b5ee7e1e11e',
  'e7678222788e340e737c01f7285fddabc3285ef9c810bb21514f0394f1c7bea6',
  'e7678222788e340e737c01f7285fddabc3285ef9c810bb21514f0394f1c7bea6',
  '006e66d214c7417fdc52c1d53633d683350d569bdff3954cd27794732e8d8158',
  '5c6119041d2a17ea53659ef0b5266c89aae4500883a22f555e2a9758c069a659',
  '577ab842507a7cffac028a88bb7e2e307af78a6db7e145cd93e1603e43bc2031',
  'd328b164aa83ad5022060112ed32ec3c3795dbf440f5409fbd1b95c3c0727ae8',
  '8f0c9ec89b8dd23ae5d61c65ca0210c317ac45f5de34279bbf1396e04b4645c6',
  'b7ad952a9128bd3409322d3767dd32ed2d384aa76d407060a954ec5de5d42b9c'
];

const SOURCE_PAGES = [2, 2, 2, 2, 2, 2, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];

const LESSON_TITLES = [
  'La Santa Biblia',
  'Dios',
  'La Oración y la Fe',
  'Origen del Pecado',
  'La Salvación',
  'Perdón de los Pecados',
  'La Segunda Venida de Nuestro Señor Jesucristo',
  'Las Señales de la Segunda Venida de Nuestro Señor Jesucristo',
  'La Santa Ley de Dios',
  'Día de Descanso',
  'Cómo se Debe Guardar el Sábado',
  'Plan de Dios para el Sostén de la Iglesia',
  'El Bautismo',
  'La Muerte',
  'El Juicio',
  'La Iglesia',
  'Don de Profecía',
  'Las Normas Cristianas',
  'La Vida Cristiana',
  'Dios nos Llama'
];

function driveIdFromUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\//);
  return match?.[1] || null;
}

function parseTopRowDriveIds(annotations) {
  const links = annotations
    .map(item => ({ id: driveIdFromUrl(item.url || item.unsafeUrl), rect: item.rect }))
    .filter(item => item.id && Array.isArray(item.rect) && item.rect.length === 4 && item.rect.every(Number.isFinite));
  if (!links.length) return [];
  const top = Math.max(...links.map(item => item.rect[1]));
  return links
    .filter(item => top - item.rect[1] <= 5)
    .sort((a, b) => a.rect[0] - b.rect[0])
    .map(item => item.id);
}

function assertSourceIndexIds(ids) {
  if (JSON.stringify(ids) !== JSON.stringify(SOURCE_IDS)) {
    throw new Error('The Fe de Jesús source index links or order changed');
  }
  if (ids[12] !== ids[13] || ids.filter(id => id === ids[12]).length !== 2) {
    throw new Error('The expected lesson 13 and 14 source duplicate was not found');
  }
  return true;
}

function slug(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildReplacementAction(baseRevision, assetTokens) {
  if (!Array.isArray(assetTokens) || assetTokens.length !== LESSON_TITLES.length || assetTokens.some(token => typeof token !== 'string')) {
    throw new Error('Expected exactly 20 validated PDF asset tokens');
  }
  return {
    type: 'course.replaceLessons',
    baseRevision,
    courseId: COURSE_ID,
    confirmText: COURSE_NAME,
    lessons: LESSON_TITLES.map((title, index) => ({ title, assetToken: assetTokens[index] }))
  };
}

function withoutLessons(course) {
  const clone = structuredClone(course);
  delete clone.lessons;
  return clone;
}

function assertReplacementResult(before, after) {
  const beforeCourse = before.courses.find(item => item.id === COURSE_ID);
  const afterCourse = after.courses.find(item => item.id === COURSE_ID);
  if (!beforeCourse || !afterCourse || before.courses.length !== after.courses.length) {
    throw new Error('The Fe de Jesús course was not replaced in place');
  }
  if (JSON.stringify(withoutLessons(beforeCourse)) !== JSON.stringify(withoutLessons(afterCourse))) {
    throw new Error('A Fe de Jesús course field other than lessons changed');
  }
  const beforeOthers = before.courses.filter(item => item.id !== COURSE_ID);
  const afterOthers = after.courses.filter(item => item.id !== COURSE_ID);
  if (JSON.stringify(beforeOthers) !== JSON.stringify(afterOthers)) {
    throw new Error('A course other than Fe de Jesús changed');
  }
  if (JSON.stringify(before.trash) !== JSON.stringify(after.trash)) {
    throw new Error('The replacement unexpectedly changed the trash');
  }
  if (JSON.stringify(afterCourse.lessons.map(item => item.title)) !== JSON.stringify(LESSON_TITLES)) {
    throw new Error('The Fe de Jesús lesson titles or order are wrong');
  }
  if (afterCourse.lessons.some((item, index) => (
    item.type !== 'pdf' ||
    !item.managed ||
    item.id !== beforeCourse.lessons[index]?.id ||
    item.legacyNumber !== beforeCourse.lessons[index]?.legacyNumber
  ))) {
    throw new Error('The Fe de Jesús lesson identity or file ownership changed unexpectedly');
  }
  return true;
}

module.exports = {
  COMPLETE_COURSE_ID,
  COMPLETE_COURSE_SHA256,
  COURSE_ID,
  COURSE_NAME,
  LESSON_TITLES,
  SOURCE_IDS,
  SOURCE_INDEX_PATH,
  SOURCE_INDEX_SHA256,
  SOURCE_PAGES,
  SOURCE_SHA256,
  assertReplacementResult,
  assertSourceIndexIds,
  buildReplacementAction,
  driveIdFromUrl,
  parseTopRowDriveIds,
  slug
};
