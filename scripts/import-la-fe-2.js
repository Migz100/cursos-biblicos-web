const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SOURCE_DIR = '/Users/miguelperez/Desktop/La Fe de Jes£s - PowePoint';
const COURSE_NAME = 'La Fe de Jesús 2';
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const TITLES = [
  'Las Sagradas Escrituras',
  'Dios',
  'La Trinidad',
  'La Oración',
  'La Fe',
  'La Segunda Venida de Jesús',
  'Las Señales del Regreso de Jesús',
  'El Origen del Mal',
  'La Salvación',
  'El Perdón',
  'El Juicio',
  'La Ley de Dios',
  'El Día de Descanso',
  'La Observancia del Sábado',
  'La Muerte',
  'La Iglesia',
  'El Don de Profecía',
  'El Bautismo',
  'El Diezmo',
  'Las Ofrendas',
  'El Estilo de Vida Cristiano',
  'Los Principios de Salud',
  'El Discipulado',
  'El Hogar Cristiano',
  'Las Luchas del Cristiano',
  'Los Miembros de Iglesia',
  'El Futuro Revelado',
  'La Profecía Más Extraordinaria',
  'El Milenio',
  'Un Nuevo Mundo'
];

function slug(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed with ${response.status}`);
  return data;
}

function protectedJson(baseUrl, route, options, tempDirectory) {
  const output = path.join(tempDirectory, `response-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const cookieJar = path.join(tempDirectory, 'cookies.txt');
  const curl = [
    'curl', route,
    '--deployment', baseUrl,
    '--', '--silent', '--show-error',
    '--cookie', cookieJar,
    '--cookie-jar', cookieJar,
    '--output', output,
    '--request', options.method || 'GET'
  ];
  for (const [name, value] of Object.entries(options.headers || {})) curl.push('--header', `${name}: ${value}`);
  if (options.body) curl.push('--data-binary', JSON.stringify(options.body));
  try {
    execFileSync('vercel', curl, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    let failure = {};
    try { failure = JSON.parse(fs.readFileSync(output, 'utf8')); } catch {}
    const detail = [failure.error, failure.message].filter(Boolean).join(': ');
    throw new Error(`Protected preview request failed for ${route}${detail ? ` (${detail})` : ''}`);
  }
  const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (parsed.error) throw new Error(`Protected preview request failed for ${route} (${parsed.error}: ${parsed.message || 'sin detalle'})`);
  return parsed;
}

async function main() {
  const baseUrl = process.argv[2]?.replace(/\/$/, '');
  const production = process.argv.includes('--production');
  const protectedPreview = process.argv.includes('--vercel-protected');
  if (!baseUrl) throw new Error('Usage: node scripts/import-la-fe-2.js <deployment-url> [--production]');
  const origin = new URL(baseUrl).origin;
  if (production && origin !== 'https://cursos-biblicos-web.vercel.app') throw new Error('Production import requires the canonical production URL');
  if (!production && origin === 'https://cursos-biblicos-web.vercel.app') throw new Error('Use --production for the canonical production URL');

  const files = fs.readdirSync(SOURCE_DIR)
    .filter(name => /\.pptx$/i.test(name))
    .map(name => ({ name, number: Number(name.match(/^\s*(\d+)/)?.[1]) }))
    .sort((a, b) => a.number - b.number);
  if (files.length !== 30 || files.some((file, index) => file.number !== index + 1)) {
    throw new Error('Expected exactly 30 numbered PPTX lessons');
  }

  const tempDirectory = protectedPreview ? fs.mkdtempSync(path.join(os.tmpdir(), 'cursos-preview-import-')) : null;
  const apiJson = async (route, options = {}) => {
    if (protectedPreview) return protectedJson(baseUrl, route, options, tempDirectory);
    return responseJson(await fetch(`${baseUrl}${route}`, {
      cache: 'no-store',
      method: options.method,
      headers: options.headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }));
  };

  try {
    const existing = await apiJson('/api/catalog');
    if (existing.courses.some(course => course.name === COURSE_NAME)) {
      process.stdout.write('La Fe de Jesús 2 already exists.\n');
      return;
    }

    let cookie;
    let session;
    if (protectedPreview) {
      session = await apiJson('/api/manage/session');
    } else {
      const sessionResponse = await fetch(`${baseUrl}/api/manage/session`, { cache: 'no-store' });
      session = await responseJson(sessionResponse);
      cookie = sessionResponse.headers.getSetCookie?.()[0]?.split(';')[0] || sessionResponse.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw new Error('Editing session cookie was not issued');
    }
    const commonHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
    if (cookie) commonHeaders.Cookie = cookie;

    const lessons = [];
    for (let index = 0; index < files.length; index++) {
      const source = path.join(SOURCE_DIR, files[index].name);
      const cleanName = `${String(index + 1).padStart(2, '0')} - ${slug(TITLES[index])}.pptx`;
      const size = fs.statSync(source).size;
      const prepared = await apiJson('/api/manage/upload', {
        method: 'POST',
        headers: commonHeaders,
        body: { action: 'prepare', filename: cleanName, contentType: CONTENT_TYPE, size }
      });
      const upload = await fetch(prepared.presignedUrl, { method: 'PUT', headers: { 'Content-Type': prepared.contentType }, body: fs.readFileSync(source) });
      if (!upload.ok) throw new Error(`Upload failed for lesson ${index + 1}`);
      const finalized = await apiJson('/api/manage/upload', {
        method: 'POST',
        headers: commonHeaders,
        body: { action: 'finalize', receipt: prepared.receipt }
      });
      lessons.push({ title: TITLES[index], assetToken: finalized.assetToken });
      process.stdout.write(`Uploaded lesson ${index + 1} of 30\n`);
    }

    const current = await apiJson('/api/catalog');
    const result = await apiJson('/api/manage/catalog', {
      method: 'POST',
      headers: commonHeaders,
      body: {
        type: 'course.add',
        baseRevision: current.revision,
        name: COURSE_NAME,
        short: 'LF2',
        color: '#981447',
        section: 'lafe',
        coverKey: 'lafe2',
        lessons
      }
    });
    const course = result.manifest.courses.find(item => item.name === COURSE_NAME);
    if (!course || course.lessons.length !== 30 || course.coverUrl !== '/assets/la-fe-de-jesus-2-cover.png') {
      throw new Error('Imported course did not pass post-write verification');
    }
    process.stdout.write(`Imported ${COURSE_NAME} with 30 lessons.\n`);
  } finally {
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
