// Sube las correcciones de cursos: FJ v2 (20), GE v2 (18), Apoc 07 + zips.
const { presignUrl } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN_URL = 'https://cursos-biblicos-web.vercel.app/api/token';
const OUT = '/tmp/lafe-build/upload-fixes-result.json';

function postToken(maxSize, contentType) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ maximumSizeInBytes: maxSize, allowedContentTypes: [contentType] });
    const req = https.request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('token ' + res.statusCode + ': ' + b.slice(0, 300)));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('token parse fail')); }
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
  if (r.status < 200 || r.status >= 300) throw new Error('PUT fail ' + pathname + ' ' + r.status + ' ' + r.body.slice(0, 200));
  return JSON.parse(r.body);
}

async function main() {
  const results = {};
  let tokenPack = await postToken(16 * 1024 * 1024, 'application/pdf');
  const jobs = [
    ['fe-de-jesus-v2', '/tmp/lafe-build/stage/fe-de-jesus', 20],
    ['la-gran-esperanza-v2', '/tmp/lafe-build/stage/la-gran-esperanza', 18],
  ];
  for (const [folder, dir, expect] of jobs) {
    const pdfs = fs.readdirSync(dir).filter(f => f.endsWith('.pdf')).sort();
    if (pdfs.length !== expect) throw new Error(dir + ': esperaba ' + expect + ', hay ' + pdfs.length);
    for (const f of pdfs) {
      const ascii = 'Leccion ' + f.match(/\d+/)[0] + '.pdf';
      const r = await uploadOne(tokenPack, folder + '/' + ascii, path.join(dir, f), 'application/pdf');
      results[folder + '/' + f] = r.url;
      console.log('ok', folder, f);
    }
  }
  // Apoc lesson 07
  const r7 = await uploadOne(tokenPack, 'apocalipsis/Leccion 07.pdf', '/tmp/lafe-build/stage/apocalipsis/Lección 07.pdf', 'application/pdf');
  results['apocalipsis/Lección 07.pdf'] = r7.url;
  console.log('ok apocalipsis 07');

  // zips
  for (const [name, file] of [
    ['zips/fe-de-jesus-v2.zip', '/tmp/lafe-build/zips/fe-de-jesus.zip'],
    ['zips/la-gran-esperanza-v2.zip', '/tmp/lafe-build/zips/la-gran-esperanza.zip'],
    ['zips/apocalipsis-v2.zip', '/tmp/lafe-build/zips/apocalipsis.zip'],
    ['todos/cursos-biblicos-todos-v2.zip', '/tmp/lafe-build/cursos-biblicos-todos-v2.zip'],
  ]) {
    const size = fs.statSync(file).size;
    const tp = await postToken(size + 2 * 1024 * 1024, 'application/zip');
    const rz = await uploadOne(tp, name, file, 'application/zip');
    results[name] = rz.url;
    console.log('ok zip', name, size);
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log('DONE');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
