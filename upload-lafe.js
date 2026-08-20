// Sube los 20 PDFs de La Fe de Jesus (convertidos con Keynote) + ZIP de PDFs.
// Uso: node upload-lafe.js
const { presignUrl } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = '/var/folders/1_/4qp9b2_j075cw07c02lydt0c0000gn/T/opencode/lf-keynote';
const ZIP = '/var/folders/1_/4qp9b2_j075cw07c02lydt0c0000gn/T/opencode/la-fe-de-jesus-pdf.zip';
const TOKEN_URL = 'https://cursos-biblicos-web.vercel.app/api/token';
const OUT = '/var/folders/1_/4qp9b2_j075cw07c02lydt0c0000gn/T/opencode/lf-upload2.json';

function postToken(maxSize, contentType) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ maximumSizeInBytes: maxSize, allowedContentTypes: [contentType] });
    const req = https.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('token ' + res.statusCode + ': ' + b.slice(0, 300)));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('token parse fail: ' + b.slice(0, 200))); }
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
  if (r.status < 200 || r.status >= 300) {
    throw new Error('PUT fail ' + pathname + ' ' + r.status + ' ' + r.body.slice(0, 300));
  }
  return JSON.parse(r.body);
}

async function main() {
  const pdfs = fs.readdirSync(SRC).filter((f) => /^Leccion \d+\.pdf$/.test(f)).sort();
  if (pdfs.length !== 20) throw new Error('esperaba 20 PDFs, hay ' + pdfs.length);
  if (!fs.existsSync(ZIP)) throw new Error('falta ' + ZIP);

  const results = {};
  // 1) PDFs individuales
  let tokenPack = await postToken(32 * 1024 * 1024, 'application/pdf');
  for (const f of pdfs) {
    const pathname = 'la-fe-de-jesus/' + f;
    const r = await uploadOne(tokenPack, pathname, path.join(SRC, f), 'application/pdf');
    results[f] = r.url;
    console.log('ok', f);
  }
  // 2) ZIP de PDFs
  const zipSize = fs.statSync(ZIP).size;
  tokenPack = await postToken(zipSize + 1024 * 1024, 'application/zip');
  const rz = await uploadOne(tokenPack, 'zips/la-fe-de-jesus-pdf.zip', ZIP, 'application/zip');
  results['ZIP'] = rz.url;
  console.log('ok ZIP', zipSize);

  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log('DONE', OUT);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
