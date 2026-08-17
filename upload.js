const { presignUrl } = require('@vercel/blob');
const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = '/var/folders/1_/4qp9b2_j075cw07c02lydt0c0000gn/T/opencode/Cursos Biblicos';
const TOKEN_URL = 'https://cursos-biblicos-web.vercel.app/api/token';

function slugify(name) {
  return name
    .replace(/^\d+ /, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/g, 'n')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function postToken(maxSize) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ maximumSizeInBytes: maxSize });
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

function signedReq(method, url, body) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/pdf' };
    if (method === 'GET' || method === 'HEAD') delete headers['Content-Type'];
    const req = https.request(url, { method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (body) {
      fs.createReadStream(body).pipe(req);
    } else {
      req.end();
    }
  });
}

async function main() {
  const folders = fs.readdirSync(SRC).filter((f) => fs.statSync(path.join(SRC, f)).isDirectory());
  const all = [];
  for (const folder of folders) {
    const dir = path.join(SRC, folder);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort((a, b) =>
      a.localeCompare(b, 'es', { numeric: true })
    );
    for (const f of files) all.push({ folder: slugify(folder), file: f, abs: path.join(dir, f) });
  }

  const tokenRes = await postToken(16 * 1024 * 1024);
  const token = { clientSigningToken: tokenRes.clientSigningToken, delegationToken: tokenRes.delegationToken };

  const results = [];
  for (let i = 0; i < all.length; i++) {
    const { folder, file, abs } = all[i];
    const pathname = folder + '/' + file;
    const p = await presignUrl(token, { pathname, operation: 'put' });
    const r = await signedReq('PUT', p.presignedUrl, abs);
    if (r.status < 200 || r.status >= 300) {
      throw new Error('PUT fail ' + pathname + ' ' + r.status + ' ' + r.body.slice(0, 300));
    }
    const parsed = JSON.parse(r.body);
    results.push({ folder, file, pathname, url: parsed.url, size: parsed.size });
    process.stdout.write('\r' + (i + 1) + '/' + all.length + ' ' + pathname + '                  ');
  }
  console.log('\nDONE ' + results.length);
  fs.writeFileSync('/var/folders/1_/4qp9b2_j075cw07c02lydt0c0000gn/T/opencode/blob-results.json', JSON.stringify(results, null, 1));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});