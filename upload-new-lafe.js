const { presignUrl } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = '/tmp/lafe-build/dist';
const ZIP = '/tmp/lafe-build/la-fe-de-jesus-pdf.zip';
const TOKEN_URL = 'https://cursos-biblicos-web.vercel.app/api/token';
const OUT = '/tmp/lafe-build/upload-result.json';

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
  if (r.status < 200 || r.status >= 300) throw new Error('PUT fail ' + pathname + ' ' + r.status + ' ' + r.body.slice(0, 300));
  return JSON.parse(r.body);
}

async function main() {
  const pdfs = fs.readdirSync(SRC).filter((f) => /^Leccion \d+\.pdf$/.test(f)).sort();
  if (pdfs.length !== 20) throw new Error('expected 20 PDFs, got ' + pdfs.length);
  const results = {};
  let tokenPack = await postToken(16 * 1024 * 1024, 'application/pdf');
  for (const f of pdfs) {
    const r = await uploadOne(tokenPack, 'la-fe-de-jesus-v2/' + f, path.join(SRC, f), 'application/pdf');
    results[f] = r.url;
    console.log('ok', f);
  }
  const zipSize = fs.statSync(ZIP).size;
  tokenPack = await postToken(zipSize + 2 * 1024 * 1024, 'application/zip');
  const rz = await uploadOne(tokenPack, 'zips/la-fe-de-jesus-pdf-v2.zip', ZIP, 'application/zip');
  results['ZIP'] = rz.url;
  console.log('ok ZIP', zipSize);
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log('DONE');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
