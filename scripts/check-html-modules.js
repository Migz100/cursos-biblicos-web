const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const html = fs.readFileSync(path.join(__dirname, '..', 'leer.html'), 'utf8');
const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!match) throw new Error('No se encontró el módulo del lector.');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursos-check-'));
const filename = path.join(directory, 'reader.mjs');
try {
  fs.writeFileSync(filename, match[1]);
  execFileSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
