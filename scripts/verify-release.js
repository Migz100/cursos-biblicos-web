const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildStarterManifest, totalLessons } = require('../api/_lib/cms/core');

const COURSE_NAME = 'La Fe de Jesús 2';
const TITLES = [
  'Las Sagradas Escrituras', 'Dios', 'La Trinidad', 'La Oración', 'La Fe',
  'La Segunda Venida de Jesús', 'Las Señales del Regreso de Jesús', 'El Origen del Mal',
  'La Salvación', 'El Perdón', 'El Juicio', 'La Ley de Dios', 'El Día de Descanso',
  'La Observancia del Sábado', 'La Muerte', 'La Iglesia', 'El Don de Profecía',
  'El Bautismo', 'El Diezmo', 'Las Ofrendas', 'El Estilo de Vida Cristiano',
  'Los Principios de Salud', 'El Discipulado', 'El Hogar Cristiano',
  'Las Luchas del Cristiano', 'Los Miembros de Iglesia', 'El Futuro Revelado',
  'La Profecía Más Extraordinaria', 'El Milenio', 'Un Nuevo Mundo'
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadCatalog(baseUrl, protectedPreview) {
  const route = `/api/catalog?verify=${Date.now()}`;
  if (!protectedPreview) {
    const response = await fetch(`${baseUrl}${route}`, { cache: 'no-store' });
    invariant(response.ok, `Catalog returned ${response.status}`);
    return response.json();
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursos-preview-verify-'));
  const output = path.join(directory, 'catalog.json');
  try {
    execFileSync('vercel', [
      'curl', route, '--deployment', baseUrl,
      '--', '--silent', '--show-error', '--output', output
    ], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'ignore'] });
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function readDeploymentAsset(baseUrl, route, protectedPreview) {
  if (!protectedPreview) {
    const response = await fetch(`${baseUrl}${route}`, { cache: 'no-store' });
    invariant(response.ok, `Asset ${route} returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursos-preview-asset-'));
  const output = path.join(directory, 'asset.bin');
  try {
    execFileSync('vercel', [
      'curl', route, '--deployment', baseUrl,
      '--', '--silent', '--show-error', '--output', output
    ], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'ignore'] });
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const baseUrl = process.argv[2]?.replace(/\/$/, '');
  const protectedPreview = process.argv.includes('--vercel-protected');
  invariant(baseUrl, 'Usage: node scripts/verify-release.js <deployment-url> [--vercel-protected]');
  const manifest = await loadCatalog(baseUrl, protectedPreview);
  const starter = buildStarterManifest();

  invariant(manifest.courses.length === 14, 'Expected 14 courses');
  invariant(totalLessons(manifest) === 215, 'Expected 215 lessons');
  for (const expected of starter.courses) {
    const actual = manifest.courses.find(course => course.id === expected.id);
    invariant(actual, `Starter course ${expected.id} is missing`);
    invariant(actual.name === expected.name, `Starter course ${expected.id} was renamed`);
    invariant(actual.lessons.length === expected.lessons.length, `Starter course ${expected.id} lesson count changed`);
    invariant(JSON.stringify(actual.lessons) === JSON.stringify(expected.lessons), `Starter course ${expected.id} lessons changed`);
  }

  const course = manifest.courses.find(item => item.name === COURSE_NAME);
  invariant(course?.section === 'lafe', 'La Fe de Jesús 2 is not in the PowerPoint section');
  invariant(course.coverUrl === '/assets/la-fe-de-jesus-2-cover.png', 'The real cover is not assigned');
  invariant(course.lessons.length === TITLES.length, 'La Fe de Jesús 2 does not have 30 lessons');
  invariant(JSON.stringify(course.lessons.map(item => item.title)) === JSON.stringify(TITLES), 'Lesson titles or order changed');
  invariant(course.lessons.every(item => item.type === 'pptx' && item.managed), 'A lesson has the wrong format');
  invariant(!course.lessons.some(item => /ppsx/i.test(item.originalName)), 'The cover PPSX was counted as a lesson');

  const expectedNamespace = baseUrl === 'https://cursos-biblicos-web.vercel.app' ? '/cms/production/assets/' : '/cms/preview/';
  invariant(course.lessons.every(item => new URL(item.url).pathname.includes(expectedNamespace)), 'An asset is in the wrong environment namespace');

  const cover = await readDeploymentAsset(baseUrl, course.coverUrl, protectedPreview);
  invariant(cover.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Cover image is unavailable');
  await Promise.all(course.lessons.map(async (item, index) => {
    const response = await fetch(item.url, { headers: { Range: 'bytes=0-15' }, cache: 'no-store' });
    invariant(response.ok, `Lesson ${index + 1} is unavailable`);
    const bytes = Buffer.from(await response.arrayBuffer());
    invariant(bytes[0] === 0x50 && bytes[1] === 0x4B, `Lesson ${index + 1} is not a PowerPoint file`);
  }));

  process.stdout.write(JSON.stringify({ revision: manifest.revision, courses: 14, lessons: 215, laFe2Lessons: 30, assetsVerified: 30 }) + '\n');
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
