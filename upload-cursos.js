// Sube cursos corregidos: PDFs nuevos/reemplazo + zips por curso.
// Uso: node upload-cursos.js
const { presignUrl } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');
const https = require('https');

const STAGE = '/private/tmp/stage';
const TOKEN_URL = 'https://cursos-biblicos-web.vercel.app/api/token';
const OUT = '/private/tmp/stage/upload-results.json';

// [courseSlug, sourceDirOrFile, files[], zipFile, zipPathname]
const JOBS = [
  { slug: 'la-gran-esperanza', dir: '02 La Gran Esperanza', all: true,  zip: '02 La Gran Esperanza.zip', zipPath: 'zips/la-gran-esperanza-zip.zip' },
  { slug: 'apocalipsis',       dir: '03 Apocalipsis',       only: ['Lección 07.pdf'], zip: '03 Apocalipsis.zip', zipPath: 'zips/apocalipsis-zip.zip' },
  { slug: 'yo-creo',           dir: '11 Yo Creo',           only: ['Lección 07.pdf'], zip: '11 Yo Creo.zip', zipPath: 'zips/yo-creo-zip.zip' },
];

function postToken(maxSize, contentType) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ maximumSizeInBytes: maxSize, allowedContentTypes: [contentType] });
    const req = https.request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('token ' + res.statusCode + ': ' + b.slice(0, 300)));
        resolve(JSON.parse(b));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function put(presignedUrl, file, contentType) {
  return new Promise((resolve, reject) => {
    const req = https.request(presignedUrl, { method: 'PUT', headers: { 'Content-Type': contentType } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    fs.createReadStream(file).pipe(req);
  });
}

async function uploadOne(tokenPack, pathname, abs, contentType) {
  const p = await presignUrl(tokenPack, { pathname, operation: 'put' });
  const r = await put(p.presignedUrl, abs, contentType);
  if (r.status < 200 || r.status >= 300) throw new Error('PUT fail ' + pathname + ' ' + r.status + ' ' + r.body.slice(0, 300));
  return JSON.parse(r.body);
}

async function main() {
  const results = {};
  let pdfToken = await postToken(40 * 1024 * 1024, 'application/pdf');
  for (const job of JOBS) {
    const dirAbs = path.join(STAGE, job.dir);
    const files = job.all ? fs.readdirSync(dirAbs).filter((f) => f.endsWith('.pdf')).sort() : job.only;
    for (const f of files) {
      const pathname = job.slug + '/' + f;
      const r = await uploadOne(pdfToken, pathname, path.join(dirAbs, f), 'application/pdf');
      results[job.slug + '/' + f] = r.url;
      console.log('ok', pathname);
    }
  }
  for (const job of JOBS) {
    const zipAbs = path.join(STAGE, job.zip);
    const zipSize = fs.statSync(zipAbs).size;
    const zipToken = await postToken(zipSize + 1024 * 1024, 'application/zip');
    const r = await uploadOne(zipToken, job.zipPath, zipAbs, 'application/zip');
    results[job.zipPath] = r.url;
    console.log('ok', job.zipPath, zipSize);
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log('DONE', OUT);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
