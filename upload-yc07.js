const { presignUrl } = require('@vercel/blob');
const fs = require('fs');
const https = require('https');
const TOKEN_URL = 'https://cursos-biblicos-web.vercel.app/api/token';
const OUT = '/tmp/lafe-build/upload-yc07-result.json';

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
  if (r.status < 200 || r.status >= 300) throw new Error('PUT fail ' + pathname + ' ' + r.status);
  return JSON.parse(r.body);
}
async function main() {
  const results = {};
  let tp = await postToken(16 * 1024 * 1024, 'application/pdf');
  let r = await uploadOne(tp, 'yo-creo/Leccion 07.pdf', '/tmp/lafe-build/stage/yo-creo/Lección 07.pdf', 'application/pdf');
  results['11-07'] = r.url;
  console.log('ok yc07', r.url);
  for (const [name, file] of [
    ['zips/yo-creo-v2.zip', '/tmp/lafe-build/zips/yo-creo.zip'],
    ['todos/cursos-biblicos-todos-v3.zip', '/tmp/lafe-build/cursos-biblicos-todos-v2.zip'],
  ]) {
    const size = fs.statSync(file).size;
    const tpz = await postToken(size + 2 * 1024 * 1024, 'application/zip');
    const rz = await uploadOne(tpz, name, file, 'application/zip');
    results[name] = rz.url;
    console.log('ok', name, size);
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log('DONE');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
