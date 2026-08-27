import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
const HOST_ROOT = path.resolve(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cursos-biblicos-code-host'), 'CursosBiblicosCodeHost');
const ENV_PATH = path.join(HOST_ROOT, 'config.env');
const DEFAULT_OUTPUT = path.join(HOST_ROOT, 'pairing-link.txt');
const outputArg = process.argv.indexOf('--pairing-output');
const pairingOutput = outputArg >= 0 && process.argv[outputArg + 1] ? path.resolve(process.argv[outputArg + 1]) : DEFAULT_OUTPUT;
const baseUrl = String(process.env.CODE_RELAY_BASE_URL || 'https://cursos-biblicos-web.vercel.app').replace(/\/$/, '');
const expectedGitRemote = 'https://github.com/Migz100/cursos-biblicos-web.git';
const expectedProjectId = 'prj_7RMmbhuK2ajCOtgTFgjp2DqpR9Pv';
const expectedOrgId = 'team_xy8XrH1OZB5EIPsBKmLJXUuQ';
const npxCli = findNpxCli();

if (fs.existsSync(ENV_PATH)) throw new Error(`${ENV_PATH} already exists. It was not overwritten.`);
if (fs.existsSync(pairingOutput)) throw new Error(`${pairingOutput} already exists. It was not overwritten.`);
verifyPinnedCheckout();

const editorAccess = crypto.randomBytes(32).toString('base64url');
const hostToken = crypto.randomBytes(32).toString('base64url');
const production = {
  CODE_EDITOR_KEY_HASH: sha256(editorAccess),
  CODE_HOST_TOKEN_HASH: sha256(hostToken),
  CODE_RELAY_SECRET: crypto.randomBytes(48).toString('base64url')
};
const preview = {
  CODE_EDITOR_KEY_HASH: sha256(crypto.randomBytes(32).toString('base64url')),
  CODE_HOST_TOKEN_HASH: sha256(crypto.randomBytes(32).toString('base64url')),
  CODE_RELAY_SECRET: crypto.randomBytes(48).toString('base64url')
};

for (const [environment, values] of Object.entries({ production, preview })) {
  for (const [name, value] of Object.entries(values)) await setVercelEnv(name, value, environment);
}

fs.mkdirSync(HOST_ROOT, { recursive: true });
const envFile = [
  '# Private local settings for the Cursos Bíblicos coding host.',
  '# Stored outside the editable repository. Never commit or share this file.',
  `CODE_REPO_ROOT=${REPO_ROOT}`,
  `CODE_RELAY_BASE_URL=${baseUrl}`,
  `CODE_HOST_TOKEN=${hostToken}`,
  `CODE_HOST_ID=${crypto.randomUUID()}`,
  `CODE_EXPECTED_GIT_REMOTE=${expectedGitRemote}`,
  `CODE_EXPECTED_VERCEL_PROJECT_ID=${expectedProjectId}`,
  `CODE_EXPECTED_VERCEL_ORG_ID=${expectedOrgId}`,
  'CODE_PROVIDER_ORDER=codex,kimi,local',
  'CODE_LOCAL_MODEL=qwen3.8:27b-q8_0',
  'CODE_SUPPORT_LIBRARY=N:\\projects\\personal\\Personal\\Cursos Biblicos',
  'CODE_DISABLE_CLAUDE=La organización de Claude bloquea el acceso de suscripción para Claude Code.',
  'CODE_DISABLE_FUGU=La cuenta de Sakana no tiene una suscripción activa.',
  ''
].join('\r\n');

fs.writeFileSync(ENV_PATH, envFile, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
fs.mkdirSync(path.dirname(pairingOutput), { recursive: true });
fs.writeFileSync(pairingOutput, [
  'CURSOS BÍBLICOS — ENLACE PRIVADO PARA EDITAR LA APP',
  '',
  'Abre este enlace una vez en cada iPhone, iPad o computadora:',
  `${baseUrl}/edit/#access=${editorAccess}`,
  '',
  'Cuando se abra el editor, el permiso queda guardado de forma privada en ese dispositivo.',
  'En iPhone o iPad usa Compartir → Agregar a pantalla de inicio.',
  'Este enlace permite pedir y publicar cambios. Compártelo solamente con la familia.',
  ''
].join('\r\n'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
lockDown(ENV_PATH);
lockDown(pairingOutput);

process.stdout.write('Configured separate encrypted relay secrets for production and preview.\n');
process.stdout.write(`Private host settings: ${ENV_PATH}\n`);
process.stdout.write(`Private pairing link: ${pairingOutput}\n`);

function verifyPinnedCheckout() {
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const remote = spawnSync(git, ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
  if (remote.status !== 0 || String(remote.stdout || '').trim().toLowerCase() !== expectedGitRemote.toLowerCase()) throw new Error('This checkout is not linked to the expected GitHub repository.');
  const link = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.vercel', 'project.json'), 'utf8'));
  if (link.projectId !== expectedProjectId || link.orgId !== expectedOrgId) throw new Error('This checkout is not linked to the expected Vercel project.');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function findNpxCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'npm', 'bin', 'npx-cli.js')
  ];
  const found = candidates.find(item => item && fs.existsSync(item));
  if (!found) throw new Error('The native npm CLI could not be found.');
  return found;
}

function setVercelEnv(name, value, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npxCli, '--yes', 'vercel@59.7.0', 'env', 'add', name, environment, '--force'], {
      cwd: REPO_ROOT,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: minimalEnv()
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Unable to configure ${name} for ${environment}: ${output.slice(-1500)}`)));
    child.stdin.end(`${value}\n`);
  });
}

function minimalEnv() {
  const result = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'USERNAME']) if (process.env[name]) result[name] = process.env[name];
  return { ...result, NO_COLOR: '1', VERCEL_TELEMETRY_DISABLED: '1' };
}

function lockDown(filename) {
  if (process.platform !== 'win32') return;
  const who = spawnSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true });
  const account = String(who.stdout || '').trim();
  if (!account) return;
  const result = spawnSync('icacls.exe', [filename, '/inheritance:r', '/grant:r', `${account}:(F)`, 'SYSTEM:(F)'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) process.stderr.write(`Warning: Windows ACL hardening failed for ${filename}.\n`);
}
