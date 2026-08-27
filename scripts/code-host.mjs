import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = path.resolve(process.env.CODE_HOST_DATA_ROOT || path.join(process.env.LOCALAPPDATA || os.homedir(), 'CursosBiblicosCodeHost'));
const ENV_ONLY = process.env.CODE_HOST_ENV_ONLY === '1';
const ENV_FILE = ENV_ONLY ? '' : path.resolve(process.env.CODE_HOST_CONFIG || path.join(HOST_ROOT, 'config.env'));
const CONFIG = ENV_ONLY ? environmentConfig() : loadEnvFile(ENV_FILE);
const REPO_ROOT = realDirectory(requiredEnv('CODE_REPO_ROOT'));
const STATE_DIR = path.join(HOST_ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const WORK_ROOT = path.join(HOST_ROOT, 'work');
const VERSION = '2.0.1';

const BASE_URL = requiredEnv('CODE_RELAY_BASE_URL').replace(/\/$/, '');
const HOST_TOKEN = requiredEnv('CODE_HOST_TOKEN');
const HOST_ID = requiredEnv('CODE_HOST_ID');
const EXPECTED_GIT_REMOTE = requiredEnv('CODE_EXPECTED_GIT_REMOTE');
const EXPECTED_VERCEL_PROJECT_ID = requiredEnv('CODE_EXPECTED_VERCEL_PROJECT_ID');
const EXPECTED_VERCEL_ORG_ID = requiredEnv('CODE_EXPECTED_VERCEL_ORG_ID');
const SUPPORT_LIBRARY = realDirectory(process.env.CODE_SUPPORT_LIBRARY || 'N:\\projects\\personal\\Personal\\Cursos Biblicos');
const LOCAL_MODEL = process.env.CODE_LOCAL_MODEL || 'qwen3.8:27b-q8_0';
const PROVIDER_ORDER = (process.env.CODE_PROVIDER_ORDER || 'codex,kimi,local').split(',').map(item => item.trim()).filter(Boolean);
const POLL_MS = boundedNumber(process.env.CODE_POLL_MS, 2500, 1000, 30000);
const HEARTBEAT_MS = boundedNumber(process.env.CODE_HEARTBEAT_MS, 30000, 15000, 120000);
const MAX_JOB_MS = boundedNumber(process.env.CODE_MAX_JOB_MS, 45 * 60 * 1000, 60_000, 2 * 60 * 60 * 1000);
const MAX_CHANGED_FILES = 80;
const MAX_CHANGED_BYTES = 100 * 1024 * 1024;

const COMMANDS = {
  codex: findNativeCommand('codex'),
  kimi: findNativeCommand('kimi'),
  claude: findNativeCommand('claude'),
  ollama: findNativeCommand('ollama'),
  git: findNativeCommand('git')
};
const NPM_CLI = findNpmCli('npm-cli.js');
const NPX_CLI = findNpmCli('npx-cli.js');
const SENSITIVE_VALUES = [...new Set([
  HOST_TOKEN,
  ...Object.entries(CONFIG).filter(([key]) => /(token|secret|password|credential|auth)/i.test(key)).map(([, value]) => value)
].filter(value => typeof value === 'string' && value.length >= 8))];

const PROTECTED_PATHS = [
  /(^|\/)\.git(?:\/|$)/i,
  /(^|\/)\.vercel(?:\/|$)/i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.code-host(?:\.|\/|$)/i,
  /^\.gitignore$/i,
  /^\.vercelignore$/i,
  /(^|\/)node_modules(?:\/|$)/i,
  /^api\/code(?:\/|$)/i,
  /^api\/_lib\/code(?:\/|$)/i,
  /^api\/manage(?:\/|$)/i,
  /^api\/_lib\/cms\/(?:security|http)\.js$/i,
  /^edit(?:\/|$)/i,
  /^scripts(?:\/|$)/i,
  /^test(?:\/|$)/i,
  /^package(?:-lock)?\.json$/i,
  /^vercel\.json$/i,
  /^AGENTS\.md$/i,
  /^CODE_CONTEXT\.md$/i
];

validateHostConfiguration();
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(WORK_ROOT, { recursive: true });
cleanupStaleWorkspaces();

let running = true;
let busy = false;
let currentJobId = null;
let currentProcess = null;
let cancelRequested = false;
let providers = probeProviders();
let state = loadState();

if (process.argv.includes('--self-test')) {
  const workspace = createWorkspace(`self-test-${crypto.randomUUID()}`);
  const sink = { emit: async () => {} };
  try {
    verifyReleaseTargets();
    await runChecks(workspace, sink);
    process.stdout.write(`${JSON.stringify({ ok: true, version: VERSION, repository: REPO_ROOT, providers })}\n`);
  } finally { removeWorkspace(workspace); }
  process.exit(0);
}

async function runHost() {
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('uncaughtException', error => log(`Uncaught error: ${safeError(error)}`));
  process.on('unhandledRejection', error => log(`Unhandled rejection: ${safeError(error)}`));

  log(`Cursos Bíblicos code host ${VERSION} starting for ${BASE_URL}`);
  log(`Repository: ${REPO_ROOT}`);
  log(`Providers: ${providers.map(item => `${item.id}=${item.available ? 'ready' : 'off'}`).join(', ')}`);

  await sendHeartbeat();
  const heartbeatTimer = setInterval(() => {
    if (!busy) providers = probeProviders();
    sendHeartbeat().catch(error => log(`Heartbeat failed: ${safeError(error)}`));
  }, HEARTBEAT_MS);

  try {
    while (running) {
      try {
        const response = await relay('/api/code/host/poll', { method: 'POST', body: { hostId: HOST_ID } });
        if (response.job) await processJob(response.job);
        else await delay(POLL_MS);
      } catch (error) {
        log(`Poll failed: ${safeError(error)}`);
        await delay(Math.min(POLL_MS * 2, 15000));
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    await sendHeartbeat().catch(() => {});
    log('Code host stopped.');
  }
}

function loadEnvFile(filename) {
  if (!fs.existsSync(filename)) throw new Error(`Private host configuration is missing: ${filename}`);
  const values = {};
  for (const rawLine of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    value = value.replace(/\\n/g, '\n');
    values[key] = value;
    if (!(key in process.env)) process.env[key] = value;
  }
  return values;
}

function environmentConfig() {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith('CODE_') && typeof value === 'string'));
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is missing from ${ENV_FILE}`);
  return value;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function realDirectory(value) {
  const resolved = fs.realpathSync(path.resolve(String(value)));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Directory is missing: ${resolved}`);
  return resolved;
}

function findNativeCommand(name) {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, [name], { encoding: 'utf8', windowsHide: true });
  const candidates = String(result.stdout || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  if (process.platform === 'win32') return candidates.find(item => item.toLowerCase().endsWith('.exe')) || '';
  return candidates[0] || '';
}

function findNpmCli(filename) {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', filename),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'npm', 'bin', filename)
  ];
  return candidates.find(item => item && fs.existsSync(item)) || '';
}

function commandExists(command) {
  return Boolean(command && path.isAbsolute(command) && fs.existsSync(command));
}

function validateHostConfiguration() {
  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) throw new Error(`CODE_REPO_ROOT is not a Git checkout: ${REPO_ROOT}`);
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(BASE_URL)) throw new Error('CODE_RELAY_BASE_URL must be an HTTPS origin');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(EXPECTED_GIT_REMOTE)) throw new Error('CODE_EXPECTED_GIT_REMOTE is invalid');
  if (!/^prj_[A-Za-z0-9]+$/.test(EXPECTED_VERCEL_PROJECT_ID) || !/^team_[A-Za-z0-9]+$/.test(EXPECTED_VERCEL_ORG_ID)) {
    throw new Error('Expected Vercel destination IDs are invalid');
  }
  if (!commandExists(process.execPath) || !commandExists(COMMANDS.git) || !NPM_CLI || !NPX_CLI) {
    throw new Error('Node, npm, npx, and native Git are required');
  }
}

function childEnv(extra = {}) {
  const allowed = [
    'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'USERNAME',
    'USERDOMAIN', 'LANG', 'LC_ALL', 'TERM'
  ];
  const result = {};
  for (const name of allowed) if (process.env[name]) result[name] = process.env[name];
  return {
    ...result,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
    GCM_INTERACTIVE: 'Never',
    VERCEL_TELEMETRY_DISABLED: '1',
    ...extra
  };
}

function probe(command, args, accepted = () => true, timeout = 15000) {
  if (!commandExists(command)) return { ok: false, output: '' };
  const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', timeout, windowsHide: true, shell: false, env: childEnv() });
  const output = redact(`${result.stdout || ''}\n${result.stderr || ''}`.trim());
  return { ok: result.status === 0 && accepted(output), output };
}

function probeProviders() {
  const codex = probe(COMMANDS.codex, ['login', 'status'], output => /logged in|chatgpt|api key/i.test(output));
  const kimi = probe(COMMANDS.kimi, ['provider', 'list'], output => /kimi|managed|oauth|default/i.test(output));
  const local = probe(COMMANDS.ollama, ['list'], output => output.includes(LOCAL_MODEL));
  const claudeDisabled = String(process.env.CODE_DISABLE_CLAUDE || '').trim();
  const fuguDisabled = String(process.env.CODE_DISABLE_FUGU || '').trim();
  const claude = claudeDisabled ? { ok: false } : probe(COMMANDS.claude, ['auth', 'status'], output => /loggedIn.*true|logged in/i.test(output));
  return [
    provider('codex', 'Codex', codex.ok, codex.ok ? '' : 'La sesión de Codex necesita atención.'),
    provider('kimi', 'Kimi', kimi.ok, kimi.ok ? '' : 'Kimi necesita iniciar sesión.'),
    provider('local', 'Local', local.ok, local.ok ? '' : `No se encontró ${LOCAL_MODEL} en Ollama.`),
    provider('claude', 'Claude', claude.ok, claudeDisabled || (claude.ok ? '' : 'Claude no está disponible.')),
    provider('fugu', 'Fugu', false, fuguDisabled || 'Fugu no está disponible.')
  ];
}

function provider(id, name, available, reason) {
  return { id, name, available: Boolean(available), reason: available ? '' : reason };
}

async function relay(endpoint, { method = 'GET', body, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}${endpoint}`, {
        method,
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${HOST_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) throw new Error(`${response.status} ${data.message || response.statusText}`);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await delay(600 * (attempt + 1));
    }
  }
  throw lastError;
}

async function sendHeartbeat() {
  return relay('/api/code/host/heartbeat', {
    method: 'POST',
    body: { id: HOST_ID, name: os.hostname(), version: VERSION, busy, currentJobId, providers }
  });
}

class EventSink {
  constructor(job) {
    this.jobId = job.id;
    this.leaseToken = job.leaseToken;
    this.sequence = Number.isSafeInteger(job.eventSequence) && job.eventSequence >= 0 ? job.eventSequence : 0;
    this.tail = Promise.resolve();
    this.lastError = null;
  }

  emit(type, text, meta) {
    if (!String(text || '').trim()) return this.tail;
    const event = { seq: ++this.sequence, type, text: redact(String(text)).slice(0, 30000), meta };
    this.tail = this.tail.catch(() => {}).then(async () => {
      try {
        await relay('/api/code/host/events', {
          method: 'POST',
          body: { jobId: this.jobId, hostId: HOST_ID, leaseToken: this.leaseToken, events: [event] },
          retries: 4
        });
      } catch (error) {
        this.lastError = error;
        log(`Event ${event.seq} failed: ${safeError(error)}`);
      }
    });
    return this.tail;
  }

  async flush() {
    await this.tail;
    if (this.lastError) throw this.lastError;
  }
}

async function processJob(job) {
  if (!job?.leaseToken) throw new Error('Relay job is missing its lease');
  busy = true;
  currentJobId = job.id;
  cancelRequested = false;
  currentProcess = null;
  const sink = new EventSink(job);
  const stopCancelMonitor = monitorCancellation(job);
  log(`Starting job ${job.id} (${job.action}, ${job.provider})`);
  await sendHeartbeat().catch(() => {});
  try {
    await sink.emit('status', actionStartText(job.action));
    let outcome;
    if (job.action === 'prompt') outcome = await executePromptJob(job, sink);
    else if (job.action === 'checks') outcome = await executeChecksJob(sink);
    else if (job.action === 'preview') outcome = await executePreviewJob(sink);
    else if (job.action === 'publish') outcome = await executePublishJob(job, sink);
    else throw new Error('Unknown job action');
    throwIfCancelled();
    if (outcome.summary) await sink.emit('result', outcome.summary, { provider: outcome.provider || 'Sistema' });
    await sink.flush();
    await relay('/api/code/host/complete', {
      method: 'POST',
      body: { jobId: job.id, hostId: HOST_ID, leaseToken: job.leaseToken, status: 'completed', provider: outcome.provider || 'Sistema', summary: outcome.summary || '', url: outcome.url || '' },
      retries: 4
    });
    log(`Completed job ${job.id}`);
  } catch (error) {
    const cancelled = error instanceof CancelledError || cancelRequested;
    const message = cancelled ? 'El trabajo se detuvo.' : friendlyFailure(error);
    await sink.emit(cancelled ? 'status' : 'error', message).catch(() => {});
    await sink.flush().catch(() => {});
    await relay('/api/code/host/complete', {
      method: 'POST',
      body: { jobId: job.id, hostId: HOST_ID, leaseToken: job.leaseToken, status: cancelled ? 'cancelled' : 'failed', error: message },
      retries: 4
    }).catch(completionError => log(`Completion failed: ${safeError(completionError)}`));
    log(`${cancelled ? 'Cancelled' : 'Failed'} job ${job.id}: ${safeError(error)}`);
  } finally {
    stopCancelMonitor();
    currentProcess = null;
    currentJobId = null;
    busy = false;
    cancelRequested = false;
    await sendHeartbeat().catch(() => {});
  }
}

function actionStartText(action) {
  return {
    prompt: 'Estoy abriendo una copia segura del proyecto y entendiendo lo que pediste…',
    checks: 'Estoy comprobando todos los archivos…',
    preview: 'Estoy comprobando la app antes de crear la vista previa…',
    publish: 'Estoy comprobando el cambio aprobado antes de publicar…'
  }[action] || 'Empezando…';
}

async function executePromptJob(job, sink) {
  await assertWorkingTreeOwned();
  const workspace = createWorkspace(job.id);
  const baseline = snapshotWorkspace(workspace);
  const realBaseline = snapshotWorkspace(REPO_ROOT);
  try {
    const promptText = buildCodingPrompt(job, workspace);
    const selection = await runWithProvider(job.provider, job.mode, promptText, sink, workspace);
    let answer = selection.answer;
    if (job.mode === 'edit') {
      let changes = validateWorkspaceChanges(baseline, snapshotWorkspace(workspace));
      try {
        await runChecks(workspace, sink);
      } catch (firstError) {
        await sink.emit('status', 'Encontré un problema en las comprobaciones. Voy a repararlo automáticamente…');
        const repair = await runOneProvider(selection.provider, 'edit', buildRepairPrompt(job, firstError), sink, workspace);
        answer = repair.answer || answer;
        changes = validateWorkspaceChanges(baseline, snapshotWorkspace(workspace));
        await runChecks(workspace, sink);
      }
      ensureSnapshotUnchanged(realBaseline, snapshotWorkspace(REPO_ROOT));
      applyWorkspaceChanges(workspace, changes);
      await registerPendingChanges(job, changes);
    } else {
      const changes = validateWorkspaceChanges(baseline, snapshotWorkspace(workspace));
      if (changes.length) throw new Error('Explanation mode attempted to change files; the changes were discarded');
    }
    const changedSummary = job.mode === 'edit' ? await workingTreeSummary() : 'No cambié archivos porque elegiste “Solo explicarme”.';
    const checkLine = job.mode === 'edit' ? 'Comprobaciones: todas pasaron dentro de una copia protegida.' : '';
    const summary = [answer || 'Terminé de revisar el pedido.', checkLine, changedSummary].filter(Boolean).join('\n\n');
    rememberConversation(job.conversationId, job.prompt, summary);
    return { provider: providerName(selection.provider), summary };
  } finally { removeWorkspace(workspace); }
}

async function executeChecksJob(sink) {
  await assertWorkingTreeOwned();
  const workspace = createWorkspace(`check-${crypto.randomUUID()}`);
  try {
    await runChecks(workspace, sink);
    const changes = await workingTreeSummary();
    return { provider: 'Sistema', summary: `Todo está bien: las pruebas protegidas y la revisión de archivos pasaron.\n\n${changes}` };
  } finally { removeWorkspace(workspace); }
}

async function executePreviewJob(sink) {
  await assertWorkingTreeOwned();
  verifyReleaseTargets();
  const workspace = createWorkspace(`preview-${crypto.randomUUID()}`);
  try {
    await runChecks(workspace, sink);
    throwIfCancelled();
    await sink.emit('status', 'Todo pasó. Ahora estoy creando una vista previa…');
    const deployment = await runVercel(['deploy', workspace, '--yes', '--project', EXPECTED_VERCEL_PROJECT_ID, '--json'], { title: 'Crear vista previa', timeoutMs: 20 * 60 * 1000 });
    const url = deploymentUrls(deployment.output).at(-1);
    if (!url) throw new Error('Vercel finished without returning a preview URL');
    return { provider: 'Sistema', url, summary: `La vista previa está lista. Ábrela y revisa el cambio antes de publicar:\n${url}` };
  } finally { removeWorkspace(workspace); }
}

async function executePublishJob(job, sink) {
  verifyReleaseTargets();
  const resumed = state.release && ['committed', 'pushed'].includes(state.release.phase);
  let commit = resumed ? state.release.commit : '';
  if (!resumed) {
    await assertWorkingTreeOwned();
    const pending = state.pendingRelease;
    if (!pending?.paths?.length) return { provider: 'Sistema', url: BASE_URL, summary: 'No hay cambios pendientes. La app en vivo ya está al día.' };
    const branch = (await git(['branch', '--show-current'], { title: 'Revisar rama' })).output.trim();
    if (branch !== 'main') throw new Error(`Publishing is only allowed from main; current branch is ${branch || 'detached'}`);
    await git(['fetch', 'origin', 'main'], { title: 'Actualizar referencia remota', timeoutMs: 5 * 60 * 1000 });
    const counts = (await git(['rev-list', '--left-right', '--count', 'HEAD...origin/main'], { title: 'Comparar versiones' })).output.trim().split(/\s+/).map(Number);
    if ((counts[0] || 0) !== 0 || (counts[1] || 0) !== 0) throw new Error('La copia local y GitHub deben estar exactamente sincronizados antes de publicar.');

    const workspace = createWorkspace(`publish-check-${crypto.randomUUID()}`);
    try { await runChecks(workspace, sink); } finally { removeWorkspace(workspace); }
    throwIfCancelled();
    await sink.emit('status', 'Las comprobaciones pasaron. Estoy guardando exactamente los archivos aprobados…');
    const approved = [...pending.paths].sort();
    await git(['add', '--', ...approved], { title: 'Preparar cambios' });
    const staged = await stagedPaths();
    if (!sameStringSet(staged, approved)) throw new Error('The staged files do not match the approved change set');
    validatePublishPaths(staged);
    await scanStagedSecrets(staged);
    await git(['diff', '--cached', '--check'], { title: 'Revisar cambios guardados' });
    const latest = latestUserInstruction(job.conversationId) || 'verified app changes';
    const subject = `Edit app: ${latest.replace(/[\r\n]+/g, ' ').replace(/[^\p{L}\p{N} .,;:!?()_-]/gu, '').slice(0, 68)}`;
    await git(['commit', '-m', subject], { title: 'Guardar versión', timeoutMs: 5 * 60 * 1000 });
    commit = (await git(['rev-parse', 'HEAD'], { title: 'Confirmar versión' })).output.trim();
    state.release = { phase: 'committed', commit, paths: approved, createdAt: new Date().toISOString() };
    saveState();
  } else {
    const head = (await git(['rev-parse', 'HEAD'], { title: 'Confirmar versión pendiente' })).output.trim();
    if (head !== commit) throw new Error('The saved release does not match the current checkout');
  }

  if (state.release.phase === 'committed') {
    const remoteCommit = await remoteMainCommit();
    if (remoteCommit !== commit) {
      try { await git(['push', 'origin', `${commit}:main`], { title: 'Guardar en GitHub', timeoutMs: 8 * 60 * 1000 }); }
      catch (error) { throw new PartialReleaseError(`La versión ${commit.slice(0, 8)} quedó guardada de forma segura en la computadora, pero GitHub no confirmó la subida. Pulsa Publicar otra vez para reanudar. Detalle: ${safeError(error)}`); }
    }
    state.release.phase = 'pushed';
    state.release.pushedAt = new Date().toISOString();
    saveState();
  }

  throwIfCancelled();
  await sink.emit('status', 'La versión está guardada en GitHub. Ahora la estoy publicando en vivo…');
  const workspace = createWorkspace(`publish-${commit.slice(0, 12)}`);
  try {
    await runChecks(workspace, sink);
    const deployment = await runVercel(['deploy', workspace, '--prod', '--yes', '--project', EXPECTED_VERCEL_PROJECT_ID, '--json'], { title: 'Publicar en Vercel', timeoutMs: 20 * 60 * 1000 });
    const urls = deploymentUrls(deployment.output);
    const url = urls.find(item => item.includes('cursos-biblicos-web.vercel.app')) || urls.at(-1) || BASE_URL;
    await verifyLiveSite();
    state.lastRelease = { commit, url, completedAt: new Date().toISOString() };
    state.release = null;
    state.pendingRelease = null;
    saveState();
    return { provider: 'Sistema', url, summary: `Publicado correctamente. La versión ${commit.slice(0, 8)} está guardada y la app en vivo responde bien:\n${url}` };
  } catch (error) {
    if (state.release?.phase === 'pushed') throw new PartialReleaseError(`La versión ${commit.slice(0, 8)} ya está guardada en GitHub, pero Vercel no confirmó el último paso. Puedes pulsar Publicar otra vez para reanudar sin repetir cambios. Detalle: ${safeError(error)}`);
    throw error;
  } finally { removeWorkspace(workspace); }
}

function buildCodingPrompt(job, workspace) {
  const history = conversationHistory(job.conversationId);
  const transcript = history.length ? history.map(item => `${item.role === 'user' ? 'Usuario' : 'Ayudante'}: ${item.text}`).join('\n\n') : '(Esta es la primera instrucción de esta conversación.)';
  const modeInstruction = job.mode === 'plan'
    ? 'MODO EXPLICACIÓN: inspecciona cuanto necesites, pero no edites ni crees ningún archivo y no ejecutes comandos que cambien estado.'
    : 'MODO EDICIÓN: implementa el cambio completo de forma autónoma dentro de esta copia desechable. No te limites a dar instrucciones.';
  return `Trabajas como el programador dentro del editor sencillo de Cursos Bíblicos. El usuario es una persona no técnica: entiende su intención, toma decisiones seguras y termina el trabajo por él.

Copia desechable de la app: ${workspace}
Biblioteca completa de fuentes del curso (solo lectura): ${SUPPORT_LIBRARY}

${modeInstruction}

Reglas obligatorias:
- Lee AGENTS.md y CODE_CONTEXT.md antes de cambiar código.
- Trabaja únicamente dentro de la copia desechable. La biblioteca de fuentes es solo para consultar.
- Nunca abras, leas, imprimas, copies ni cambies .env*, .vercel, .code-host, credenciales ni archivos fuera de esas dos ubicaciones.
- No cambies el puente de edición, sus APIs, scripts operativos, pruebas, package.json, vercel.json, AGENTS.md ni CODE_CONTEXT.md.
- No hagas commit, push ni despliegues; el anfitrión se ocupa de eso después de las comprobaciones.
- Conserva todo el contenido existente. Haz cambios móviles y accesibles que funcionen en iPhone, iPad y computadora.
- Al terminar responde en español sencillo: qué hiciste y qué debe revisar. No le des comandos técnicos al usuario.

Contexto reciente:
${transcript}

Instrucción nueva:
${job.prompt}`;
}

function buildRepairPrompt(job, error) {
  const details = redact(error?.details || error?.message || error).slice(-9000);
  return `Las comprobaciones protegidas fallaron. Corrige solamente los archivos permitidos dentro de la copia desechable y vuelve a revisar tu solución. No cambies pruebas, package.json, vercel.json, APIs del editor ni scripts operativos.\n\nPedido original:\n${job.prompt}\n\nSalida:\n${details}`;
}

async function runWithProvider(requested, mode, promptText, sink, workDir) {
  const available = new Set(providers.filter(item => item.available).map(item => item.id));
  const choices = requested === 'auto' ? PROVIDER_ORDER.filter(id => available.has(id)) : [requested];
  if (mode === 'plan') {
    const safeChoices = choices.filter(id => id !== 'kimi' && id !== 'claude');
    if (safeChoices.length) choices.splice(0, choices.length, ...safeChoices);
  }
  if (!choices.length) throw new Error('No coding provider is currently available');
  let lastError;
  for (let index = 0; index < choices.length; index++) {
    const id = choices[index];
    const health = providers.find(item => item.id === id);
    if (!health?.available) { lastError = new Error(health?.reason || `${id} is unavailable`); continue; }
    try {
      if (index) await sink.emit('status', `${providerName(choices[index - 1])} no pudo terminar. Continuaré con ${providerName(id)}…`);
      return await runOneProvider(id, mode, promptText, sink, workDir);
    } catch (error) {
      lastError = error;
      if (requested !== 'auto') throw error;
      log(`Provider ${id} failed: ${safeError(error)}`);
    }
  }
  throw lastError || new Error('No coding provider could complete the job');
}

async function runOneProvider(id, mode, promptText, sink, workDir) {
  throwIfCancelled();
  await sink.emit('status', `${providerName(id)} está trabajando en una copia protegida…`);
  let answer;
  if (id === 'codex') answer = await runCodex(promptText, mode, sink, workDir, false);
  else if (id === 'local') answer = await runCodex(promptText, mode, sink, workDir, true);
  else if (id === 'kimi') answer = await runKimi(promptText, mode, sink, workDir);
  else if (id === 'claude') answer = await runClaude(promptText, mode, sink, workDir);
  else throw new Error(`Unsupported provider: ${id}`);
  return { provider: id, answer: cleanAssistantAnswer(answer) };
}

async function runCodex(promptText, mode, sink, workDir, local) {
  const args = ['exec', '--json', '--color', 'never', '--ephemeral'];
  if (mode === 'plan') args.push('--sandbox', 'read-only');
  else args.push('--approve-for-me');
  args.push('-C', workDir);
  if (local) args.push('--oss', '--local-provider', 'ollama', '--model', LOCAL_MODEL);
  args.push('-');
  let answer = '';
  const result = await runProcess(COMMANDS.codex, args, {
    cwd: workDir,
    input: promptText,
    timeoutMs: MAX_JOB_MS,
    onLine(line, stream) {
      if (stream === 'stderr') return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'item.started' && event.item?.type === 'command_execution') sink.emit('status', `Revisando: ${friendlyCommand(event.item.command, workDir)}`);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) answer = event.item.text;
      if (event.type === 'turn.failed' && event.error?.message) answer = event.error.message;
    }
  });
  if (result.code !== 0) throw processFailure(local ? 'Local Codex' : 'Codex', result);
  return answer || lastPlainLine(result.output);
}

async function runKimi(promptText, mode, sink, workDir) {
  if (mode === 'plan') throw new Error('Kimi plan mode is disabled to guarantee no files are changed');
  let answer = '';
  const result = await runProcess(COMMANDS.kimi, ['--auto', '--prompt', promptText, '--output-format', 'stream-json'], {
    cwd: workDir,
    timeoutMs: MAX_JOB_MS,
    onLine(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.role === 'assistant' && typeof event.content === 'string') answer = event.content;
      if (event.type === 'tool' || event.role === 'tool') sink.emit('status', 'Kimi está revisando y actualizando la copia…');
    }
  });
  if (result.code !== 0) throw processFailure('Kimi', result);
  return answer || lastPlainLine(result.output);
}

async function runClaude(promptText, mode, sink, workDir) {
  const args = ['--print', promptText, '--output-format', 'stream-json', '--verbose', '--permission-mode', mode === 'plan' ? 'plan' : 'acceptEdits'];
  let answer = '';
  const result = await runProcess(COMMANDS.claude, args, {
    cwd: workDir,
    timeoutMs: MAX_JOB_MS,
    onLine(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      const text = event.message?.content?.find?.(item => item.type === 'text')?.text;
      if (text) answer = text;
      if (event.type === 'tool_use') sink.emit('status', 'Claude está trabajando en la copia…');
    }
  });
  if (result.code !== 0) throw processFailure('Claude', result);
  return answer || lastPlainLine(result.output);
}

async function runChecks(workDir, sink) {
  throwIfCancelled();
  await sink.emit('status', 'El cambio está hecho. Ahora estoy ejecutando pruebas sin acceso a tus credenciales…');
  const syntaxFiles = listFiles(workDir)
    .filter(filename => /\.(?:c?js|mjs)$/i.test(filename) && !filename.startsWith('node_modules/') && !filename.startsWith('vendor/'))
    .sort();
  for (const filename of syntaxFiles) {
    const result = await runProcess(process.execPath, ['--check', path.join(workDir, ...filename.split('/'))], { cwd: workDir, timeoutMs: 30000 });
    if (result.code !== 0) throw processFailure(`Sintaxis de ${filename}`, result);
  }
  const testFiles = listFiles(path.join(workDir, 'test'))
    .filter(filename => filename.endsWith('.test.js'))
    .sort()
    .map(filename => `test/${filename}`);
  if (testFiles.length) {
    const args = ['--permission', '--allow-child-process', `--allow-fs-read=${workDir}`, '--test', ...testFiles];
    const result = await runProcess(process.execPath, args, { cwd: workDir, timeoutMs: 12 * 60 * 1000 });
    if (result.code !== 0) throw processFailure('Pruebas protegidas', result);
  }
  const htmlCheck = path.join(workDir, 'scripts', 'check-html-modules.js');
  if (fs.existsSync(htmlCheck)) {
    const result = await runProcess(process.execPath, [
      '--permission',
      '--allow-child-process',
      `--allow-fs-read=${workDir}`,
      `--allow-fs-read=${os.tmpdir()}`,
      `--allow-fs-write=${os.tmpdir()}`,
      htmlCheck
    ], { cwd: workDir, timeoutMs: 120000 });
    if (result.code !== 0) throw processFailure('Revisión HTML', result);
  }
  await sink.emit('status', 'Todas las pruebas protegidas pasaron.');
}

function createWorkspace(name) {
  const safeName = String(name).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 90);
  const destination = path.resolve(WORK_ROOT, safeName);
  assertWithin(destination, WORK_ROOT);
  if (fs.existsSync(destination)) removeWorkspace(destination);
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(REPO_ROOT, destination, {
    recursive: true,
    dereference: false,
    filter(source) {
      const relative = relativePath(REPO_ROOT, source);
      if (!relative) return true;
      return !/(^|\/)(?:\.git|\.vercel|\.code-host)(?:\/|$)/i.test(relative) && !/(^|\/)\.env(?:\.|$)/i.test(relative);
    }
  });
  return destination;
}

function removeWorkspace(directory) {
  const resolved = path.resolve(directory);
  assertWithin(resolved, WORK_ROOT);
  if (resolved === path.resolve(WORK_ROOT)) throw new Error('Refusing to remove the workspace root');
  try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 }); } catch (error) { log(`Workspace cleanup failed: ${safeError(error)}`); }
}

function cleanupStaleWorkspaces() {
  for (const entry of fs.readdirSync(WORK_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.resolve(WORK_ROOT, entry.name);
    assertWithin(target, WORK_ROOT);
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  }
}

function assertWithin(target, root) {
  const base = `${path.resolve(root).toLowerCase()}${path.sep}`;
  if (!`${path.resolve(target).toLowerCase()}${path.sep}`.startsWith(base)) throw new Error(`Path escaped its allowed root: ${target}`);
}

function relativePath(root, filename) {
  return path.relative(root, filename).split(path.sep).join('/');
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { output.push(relative); continue; }
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) output.push(relative);
    }
  };
  walk(root);
  return output;
}

function snapshotWorkspace(root) {
  const snapshot = new Map();
  for (const filename of listFiles(root)) {
    if (filename.startsWith('node_modules/') || filename.startsWith('.git/') || filename.startsWith('.vercel/')) continue;
    const absolute = path.join(root, ...filename.split('/'));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) snapshot.set(filename, { type: 'link', hash: '', size: 0 });
    else snapshot.set(filename, { type: 'file', hash: hashFile(absolute), size: stat.size });
  }
  return snapshot;
}

function hashFile(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function validateWorkspaceChanges(before, after) {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = names.filter(filename => {
    const left = before.get(filename);
    const right = after.get(filename);
    return !left || !right || left.type !== right.type || left.hash !== right.hash;
  }).map(filename => ({ filename, before: before.get(filename) || null, after: after.get(filename) || null }));
  if (changes.length > MAX_CHANGED_FILES) throw new Error(`The requested edit touched ${changes.length} files; the safe limit is ${MAX_CHANGED_FILES}`);
  const totalBytes = changes.reduce((sum, item) => sum + (item.after?.size || 0), 0);
  if (totalBytes > MAX_CHANGED_BYTES) throw new Error('The requested edit is too large to apply safely');
  for (const change of changes) {
    if (isProtectedPath(change.filename)) throw new Error(`The coding provider attempted to change a protected file: ${change.filename}`);
    if (change.after?.type === 'link') throw new Error(`Symbolic links are not allowed: ${change.filename}`);
  }
  return changes;
}

function isProtectedPath(filename) {
  const normalized = String(filename).replace(/\\/g, '/').replace(/^\.\//, '');
  return !normalized || normalized.includes('../') || path.isAbsolute(normalized) || PROTECTED_PATHS.some(pattern => pattern.test(normalized));
}

function ensureSnapshotUnchanged(expected, actual) {
  const names = [...new Set([...expected.keys(), ...actual.keys()])];
  for (const filename of names) {
    const left = expected.get(filename);
    const right = actual.get(filename);
    if (!left || !right || left.type !== right.type || left.hash !== right.hash) throw new Error(`The real checkout changed while the safe copy was being edited: ${filename}`);
  }
}

function applyWorkspaceChanges(workspace, changes) {
  for (const change of changes) {
    const target = path.resolve(REPO_ROOT, ...change.filename.split('/'));
    assertWithin(target, REPO_ROOT);
    if (!change.after) {
      if (fs.existsSync(target) && fs.lstatSync(target).isFile()) fs.rmSync(target, { force: true });
      continue;
    }
    const source = path.resolve(workspace, ...change.filename.split('/'));
    assertWithin(source, workspace);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.cb-apply-${crypto.randomUUID()}.tmp`;
    fs.copyFileSync(source, temporary);
    fs.copyFileSync(temporary, target);
    fs.rmSync(temporary, { force: true });
  }
}

async function assertWorkingTreeOwned() {
  const current = await workingTreePaths();
  const expected = state.pendingRelease?.paths || [];
  if (!sameStringSet(current, expected)) throw new Error('The checkout contains changes that were not created by the family editor. Miguel must review them before the host can continue.');
  if (state.pendingRelease) {
    const head = (await git(['rev-parse', 'HEAD'], { title: 'Confirmar base' })).output.trim();
    if (head !== state.pendingRelease.baseCommit) throw new Error('The pending changes no longer match their original base commit');
  }
}

async function registerPendingChanges(job, changes) {
  const previous = state.pendingRelease?.paths || [];
  const allowed = new Set([...previous, ...changes.map(item => item.filename)]);
  const current = await workingTreePaths();
  const unexpected = current.filter(filename => !allowed.has(filename));
  if (unexpected.length) throw new Error(`Unexpected working-tree files appeared: ${unexpected.join(', ')}`);
  validatePublishPaths(current);
  const baseCommit = (await git(['rev-parse', 'HEAD'], { title: 'Guardar base del cambio' })).output.trim();
  state.pendingRelease = current.length ? {
    baseCommit,
    paths: current,
    lastConversationId: job.conversationId,
    lastJobId: job.id,
    updatedAt: new Date().toISOString()
  } : null;
  saveState();
}

async function workingTreePaths() {
  const tracked = (await git(['diff', '--name-only', '-z', 'HEAD'], { title: 'Revisar cambios', quiet: true })).output.split('\0').filter(Boolean);
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], { title: 'Revisar archivos nuevos', quiet: true })).output.split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked].map(item => item.replace(/\\/g, '/')))].sort();
}

async function stagedPaths() {
  return (await git(['diff', '--cached', '--name-only', '-z'], { title: 'Revisar archivos preparados', quiet: true })).output.split('\0').filter(Boolean).map(item => item.replace(/\\/g, '/')).sort();
}

function validatePublishPaths(paths) {
  const blocked = paths.filter(isProtectedPath);
  if (blocked.length) throw new Error(`Protected files cannot be published: ${blocked.join(', ')}`);
}

async function scanStagedSecrets(paths) {
  const dangerous = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:OPENAI|VERCEL|GITHUB|CODE_HOST|BLOB_READ_WRITE)_?[A-Z0-9_]*\s*[=:]\s*["']?[A-Za-z0-9_\-.]{20,}/i;
  for (const filename of paths) {
    const absolute = path.join(REPO_ROOT, ...filename.split('/'));
    if (!fs.existsSync(absolute) || fs.statSync(absolute).size > 2 * 1024 * 1024) continue;
    const content = fs.readFileSync(absolute, 'utf8');
    if (dangerous.test(content)) throw new Error(`A possible credential was found in ${filename}; publishing stopped`);
  }
}

function verifyReleaseTargets() {
  const remote = spawnSync(COMMANDS.git, ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, shell: false, env: childEnv() });
  if (remote.status !== 0 || String(remote.stdout || '').trim().toLowerCase() !== EXPECTED_GIT_REMOTE.toLowerCase()) throw new Error('Git origin does not match the pinned Cursos Biblicos repository');
  let link;
  try { link = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.vercel', 'project.json'), 'utf8')); } catch { throw new Error('The pinned Vercel project link is missing'); }
  if (link.projectId !== EXPECTED_VERCEL_PROJECT_ID || link.orgId !== EXPECTED_VERCEL_ORG_ID) throw new Error('Vercel project linkage does not match the pinned production project');
}

async function remoteMainCommit() {
  const result = await git(['ls-remote', 'origin', 'refs/heads/main'], { title: 'Confirmar GitHub', timeoutMs: 120000 });
  return result.output.trim().split(/\s+/)[0] || '';
}

async function verifyLiveSite() {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(BASE_URL, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (response.ok && /text\/html/i.test(response.headers.get('content-type') || '')) return;
      lastError = new Error(`Live site returned ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(2500);
  }
  throw lastError || new Error('The live site did not respond');
}

async function workingTreeSummary() {
  const files = await workingTreePaths();
  if (!files.length) return 'Archivos: no hubo cambios pendientes.';
  const stat = await git(['diff', '--stat'], { title: 'Resumir cambios', quiet: true });
  const concise = stat.output.trim().split(/\r?\n/).slice(-8).join('\n');
  return `Archivos cambiados: ${files.length}.\n${concise}`.trim();
}

function git(args, options = {}) {
  return runCommand(COMMANDS.git, args, { cwd: REPO_ROOT, ...options });
}

function runVercel(args, options = {}) {
  return runCommand(process.execPath, [NPX_CLI, '--yes', 'vercel@59.7.0', ...args], { cwd: REPO_ROOT, ...options });
}

async function runCommand(command, args, { title, timeoutMs = 120000, quiet = false, cwd = REPO_ROOT } = {}) {
  throwIfCancelled();
  if (!commandExists(command)) throw new Error(`${title || command} is not installed`);
  const result = await runProcess(command, args, { cwd, timeoutMs });
  if (result.code !== 0) {
    const error = processFailure(title || path.basename(command), result);
    error.details = redact(result.output).slice(-12000);
    throw error;
  }
  if (!quiet) log(`${title || path.basename(command)} passed`);
  return result;
}

function runProcess(command, args, { cwd = REPO_ROOT, input, timeoutMs = 120000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (!commandExists(command)) return reject(new Error(`Native command not found: ${command}`));
    const child = spawn(command, args, { cwd, env: childEnv(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    currentProcess = child;
    let combined = '';
    const partial = { stdout: '', stderr: '' };
    const capture = (chunk, stream) => {
      const value = chunk.toString('utf8');
      combined = `${combined}${value}`.slice(-600000);
      const lines = `${partial[stream]}${value}`.split(/\r?\n/);
      partial[stream] = lines.pop() || '';
      for (const line of lines) { try { onLine?.(redact(line), stream); } catch {} }
    };
    child.stdout.on('data', chunk => capture(chunk, 'stdout'));
    child.stderr.on('data', chunk => capture(chunk, 'stderr'));
    child.on('error', reject);
    const timer = setTimeout(() => terminateProcess(child), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      for (const stream of ['stdout', 'stderr']) if (partial[stream]) { try { onLine?.(redact(partial[stream]), stream); } catch {} }
      if (currentProcess === child) currentProcess = null;
      if (cancelRequested) return reject(new CancelledError());
      if (signal && code == null) return reject(new Error(`Process stopped by ${signal}`));
      resolve({ code: Number.isInteger(code) ? code : 1, output: redact(stripAnsi(combined)) });
    });
    if (input != null) child.stdin.end(String(input));
    else child.stdin.end();
  });
}

function monitorCancellation(job) {
  let active = true;
  const check = async () => {
    if (!active) return;
    try {
      const query = new URLSearchParams({ jobId: job.id, hostId: HOST_ID, leaseToken: job.leaseToken });
      const result = await relay(`/api/code/host/cancel?${query}`, { retries: 0 });
      if (result.cancelled) { cancelRequested = true; if (currentProcess) terminateProcess(currentProcess); }
    } catch {}
    if (active) setTimeout(check, 4000);
  };
  setTimeout(check, 4000);
  return () => { active = false; };
}

function terminateProcess(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else { try { child.kill('SIGTERM'); } catch {} }
}

function throwIfCancelled() {
  if (cancelRequested) throw new CancelledError();
}

class CancelledError extends Error {
  constructor() { super('Job cancelled'); this.name = 'CancelledError'; }
}

class PartialReleaseError extends Error {
  constructor(message) { super(message); this.name = 'PartialReleaseError'; }
}

function processFailure(name, result) {
  const tail = redact(result.output).trim().split(/\r?\n/).slice(-18).join('\n');
  return new Error(`${name} exited with code ${result.code}${tail ? `\n${tail}` : ''}`);
}

function friendlyFailure(error) {
  const text = safeError(error);
  if (error instanceof PartialReleaseError) return error.message;
  if (/quota|usage limit|rate.?limit|too many requests/i.test(text)) return 'El ayudante alcanzó su límite de uso y los otros ayudantes tampoco pudieron terminar. Intenta otra vez más tarde.';
  if (/auth|log.?in|unauthorized|forbidden|403/i.test(text)) return 'La conexión del ayudante necesita atención en la computadora de Miguel.';
  if (/protected file|credentials?|secret|checkout contains changes|base commit|exactamente sincronizados/i.test(text)) return `Detuve el trabajo para proteger la app y tus cuentas. Miguel puede revisar este detalle:\n${text.slice(-1800)}`;
  if (/test|check|npm|syntax|failed/i.test(text)) return `No publiqué nada porque una comprobación todavía falla. Miguel puede revisar este detalle:\n${text.slice(-1800)}`;
  if (/fetch|network|timeout|timed out|econn/i.test(text)) return 'Se perdió la conexión por un momento. El cambio no se publicó; inténtalo otra vez.';
  return `No pude terminar este pedido de forma segura. Nada nuevo se publicó. Detalle para Miguel:\n${text.slice(-1800)}`;
}

function providerName(id) {
  return { codex: 'Codex', kimi: 'Kimi', local: 'Local', claude: 'Claude', fugu: 'Fugu' }[id] || id;
}

function cleanAssistantAnswer(value) {
  return redact(stripAnsi(String(value || ''))).replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/)[^\s)]+/g, 'el proyecto').trim().slice(0, 24000);
}

function friendlyCommand(value, workDir) {
  const command = redact(String(value || '')).replaceAll(workDir, 'la copia').replaceAll(REPO_ROOT, 'el proyecto').replaceAll(SUPPORT_LIBRARY, 'la biblioteca');
  return command.length > 110 ? `${command.slice(0, 107)}…` : command || 'archivos del proyecto';
}

function deploymentUrls(output) {
  const text = String(output || '');
  const urls = text.match(/https:\/\/[A-Za-z0-9.-]+\.vercel\.app(?:\/[^\s"']*)?/g) || [];
  try {
    const parsed = JSON.parse(text);
    for (const value of [parsed.url, parsed.inspectorUrl, parsed.alias]) if (typeof value === 'string') urls.push(value.startsWith('http') ? value : `https://${value}`);
  } catch {}
  return [...new Set(urls.map(value => value.replace(/[),.;]+$/, '')))];
}

function lastPlainLine(output) {
  return String(output || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean).at(-1) || '';
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '');
}

function redact(value) {
  let output = String(value || '');
  for (const secret of SENSITIVE_VALUES) output = output.split(secret).join('[redacted]');
  return output
    .replace(/((?:token|secret|password|credential|authorization|api[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]{12,}/gi, 'Bearer [redacted]');
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { conversations: {} };
  } catch { return { conversations: {} }; }
}

function saveState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, STATE_FILE);
}

function conversationRecord(id) {
  state.conversations ||= {};
  const current = state.conversations[id];
  if (Array.isArray(current)) state.conversations[id] = { messages: current };
  if (!state.conversations[id] || typeof state.conversations[id] !== 'object') state.conversations[id] = { messages: [] };
  state.conversations[id].messages ||= [];
  return state.conversations[id];
}

function conversationHistory(id) {
  return conversationRecord(id).messages.slice(-12);
}

function rememberConversation(id, userText, assistantText) {
  const record = conversationRecord(id);
  record.messages.push({ role: 'user', text: String(userText).slice(0, 12000), at: new Date().toISOString() });
  record.messages.push({ role: 'assistant', text: String(assistantText).slice(0, 12000), at: new Date().toISOString() });
  record.messages = record.messages.slice(-16);
  const ids = Object.keys(state.conversations);
  if (ids.length > 30) for (const oldId of ids.slice(0, ids.length - 30)) delete state.conversations[oldId];
  saveState();
}

function latestUserInstruction(id) {
  return [...conversationHistory(id)].reverse().find(item => item.role === 'user')?.text || '';
}

function sameStringSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function safeError(error) {
  return redact(error instanceof Error ? error.message : String(error || 'Unknown error')).slice(-12000);
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${redact(String(message)).replace(/[\r\n]+/g, ' ').slice(0, 4000)}\n`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stop() {
  running = false;
  if (currentProcess) terminateProcess(currentProcess);
}

await runHost();
