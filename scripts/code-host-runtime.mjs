import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  AttachmentBudget,
  CodexAppServerClient,
  HOST_ERROR_CODES,
  HostProtocolError,
  OneFileProposalGate,
  ReleaseGate,
  ThreadRegistry,
  applyWorkspaceChanges,
  assertWorkspacePath,
  attachmentUserInput,
  evaluateApprovalRequest,
  extractThreadHistory,
  redactLocalPaths,
  resolveCodexCliLaunch,
  stageAttachment,
  validateUpload
} from './code-host-lib.mjs';

const VERSION = '3.0.0';
const MODEL = 'gpt-5.6-sol';
const EFFORT = 'max';
const SERVICE_TIER = 'priority';
const HOST_ROOT = path.resolve(process.env.CODE_HOST_DATA_ROOT || path.join(process.env.LOCALAPPDATA || os.homedir(), 'CursosBiblicosCodeHost'));
const REPO_ROOT = realDirectory(requiredEnv('CODE_REPO_ROOT'));
const STATE_DIR = path.join(HOST_ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const WORK_ROOT = path.join(HOST_ROOT, 'work');
const DRAFT_ROOT = path.join(WORK_ROOT, 'drafts');
const TRANSIENT_ROOT = path.join(WORK_ROOT, 'transient');
const STAGING_ROOT = path.join(WORK_ROOT, 'staging');
const BASE_URL = requiredEnv('CODE_RELAY_BASE_URL').replace(/\/$/, '');
const HOST_TOKEN = requiredEnv('CODE_HOST_TOKEN');
const HOST_ID = requiredEnv('CODE_HOST_ID');
const EXPECTED_GIT_REMOTE = requiredEnv('CODE_EXPECTED_GIT_REMOTE');
const EXPECTED_VERCEL_PROJECT_ID = requiredEnv('CODE_EXPECTED_VERCEL_PROJECT_ID');
const EXPECTED_VERCEL_ORG_ID = requiredEnv('CODE_EXPECTED_VERCEL_ORG_ID');
const POLL_MS = boundedNumber(process.env.CODE_POLL_MS, 2500, 1000, 30000);
const HEARTBEAT_MS = boundedNumber(process.env.CODE_HEARTBEAT_MS, 30000, 15000, 120000);
const MAX_JOB_MS = boundedNumber(process.env.CODE_MAX_JOB_MS, 45 * 60 * 1000, 60_000, 2 * 60 * 60 * 1000);
const MAX_CHANGED_FILES = 80;
const MAX_CHANGED_BYTES = 100 * 1024 * 1024;
const CODEX = resolveCodexCliLaunch();
const GIT = findNativeExecutable('git');
const NPM_CLI = findNpmCli('npm-cli.js');
const NPX_CLI = findNpmCli('npx-cli.js');
const SENSITIVE_VALUES = [...new Set([
  HOST_TOKEN,
  ...Object.entries(process.env)
    .filter(([key, value]) => key.startsWith('CODE_') && /(token|secret|password|credential|auth)/i.test(key) && typeof value === 'string')
    .map(([, value]) => value)
].filter(value => value.length >= 8))];
const REDACTION_ROOTS = [REPO_ROOT, HOST_ROOT, WORK_ROOT, DRAFT_ROOT, TRANSIENT_ROOT, STAGING_ROOT];
const PROTECTED_PATHS = [
  /(^|\/)\.git(?:\/|$)/i,
  /(^|\/)\.vercel(?:\/|$)/i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)\.code-host(?:\.|\/|$)/i,
  /^\.gitignore$/i,
  /^\.vercelignore$/i,
  /(^|\/)node_modules(?:\/|$)/i,
  /(^|\/)\.codex-(?:attachments|isolation-canary)(?:\/|$)/i,
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
const APP_DEVELOPER_INSTRUCTIONS = `Trabajas únicamente dentro del borrador de Cursos Bíblicos que el host te asignó.
- No abras ni menciones rutas fuera del borrador o de los adjuntos explícitos.
- Nunca busques ni leas credenciales, archivos .env*, .vercel, .code-host, cookies, tokens ni configuración de proveedores.
- No uses red, no publiques, no hagas commit, push ni despliegues.
- Cada propuesta debe cambiar exactamente un archivo. Si el pedido necesita m\u00e1s, explica el l\u00edmite sin modificar archivos.
- No cambies el puente de edición, sus APIs, scripts operativos, pruebas, package.json, vercel.json, AGENTS.md ni CODE_CONTEXT.md.
- Conserva accesibilidad, español, iPhone, iPad y computadora.
- Responde en español sencillo y no muestres rutas locales ni salida cruda de comandos.`;

validateConfiguration();
for (const directory of [STATE_DIR, WORK_ROOT, DRAFT_ROOT, TRANSIENT_ROOT, STAGING_ROOT]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
cleanupTransientRoots();

let running = true;
let busy = false;
let currentJobId = null;
let currentProcess = null;
let cancelRequested = false;
let activeContext = null;
let appServer = null;
let appServerProfile = null;
let isolationProfile = null;
let sandboxSetupWaiter = null;
const state = loadState();
state.drafts ||= {};
state.threads ||= {};
const threadRegistry = new ThreadRegistry({ state, workspaceRoot: DRAFT_ROOT });
const releaseGate = new ReleaseGate({ state, saveState });

export async function runCodeHost({ selfTest = false } = {}) {
  try {
    await ensureHostIsolation();
  } catch (error) {
    await appServer?.close().catch(() => {});
    throw error;
  }
  if (selfTest) return runSelfTest();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('uncaughtException', error => log(`Uncaught error: ${safeError(error)}`));
  process.on('unhandledRejection', error => log(`Unhandled rejection: ${safeError(error)}`));
  log(`Cursos Bíblicos code host ${VERSION} starting.`);
  await ensureAppServer();
  await sendHeartbeat().catch(error => log(`Heartbeat failed: ${safeError(error)}`));
  const heartbeatTimer = setInterval(() => sendHeartbeat().catch(error => log(`Heartbeat failed: ${safeError(error)}`)), HEARTBEAT_MS);
  heartbeatTimer.unref?.();
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
    await appServer?.close().catch(() => {});
    await sendHeartbeat().catch(() => {});
    log('Code host stopped.');
  }
}

export async function configureHostIsolation() {
  if (process.platform !== 'win32') {
    throw new HostProtocolError(HOST_ERROR_CODES.HOST_OS_ISOLATION_REQUIRED, 'Elevated Windows sandbox setup is required.');
  }
  await ensureAppServer();
  const workspace = createTransient(`isolation-setup-${crypto.randomUUID()}`);
  try {
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HostProtocolError(
        HOST_ERROR_CODES.HOST_OS_ISOLATION_REQUIRED,
        'Elevated Windows sandbox setup did not complete.'
      )), 10 * 60 * 1000);
      timer.unref?.();
      sandboxSetupWaiter = {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); }
      };
    });
    const started = await appServer.request('windowsSandbox/setupStart', { mode: 'elevated', cwd: workspace }, { timeoutMs: 60_000 });
    if (started?.started !== true) throw new HostProtocolError(HOST_ERROR_CODES.HOST_OS_ISOLATION_REQUIRED, 'Elevated Windows sandbox setup was not started.');
    const result = await completed;
    if (result?.mode !== 'elevated' || result?.success !== true) {
      throw new HostProtocolError(HOST_ERROR_CODES.HOST_OS_ISOLATION_REQUIRED, 'Elevated Windows sandbox setup failed.');
    }
    const canaries = await verifySandboxCanaries(appServer, workspace);
    if (!canaries.outsideReadDenied || !canaries.workspaceImageReadable || !canaries.workspacePdfReadable) {
      throw new HostProtocolError(HOST_ERROR_CODES.HOST_OS_ISOLATION_REQUIRED, 'Windows sandbox read-boundary canaries did not pass.');
    }
    return { ok: true, mode: 'elevated', verifiedAt: new Date().toISOString(), canaries };
  } finally {
    sandboxSetupWaiter = null;
    removeTransient(workspace);
    await appServer?.close().catch(() => {});
    appServer = null;
    appServerProfile = null;
  }
}

async function ensureHostIsolation() {
  await ensureAppServer();
  const workspace = createTransient(`isolation-start-${crypto.randomUUID()}`);
  try {
    const canaries = await verifySandboxCanaries(appServer, workspace);
    if (!canaries.outsideReadDenied || !canaries.workspaceImageReadable || !canaries.workspacePdfReadable) {
      throw new HostProtocolError(HOST_ERROR_CODES.HOST_OS_ISOLATION_REQUIRED, 'Windows sandbox read-boundary canaries did not pass.');
    }
    isolationProfile = {
      ready: true,
      mode: 'elevated',
      verifiedAt: new Date().toISOString()
    };
    return isolationProfile;
  } finally { removeTransient(workspace); }
}

async function runSelfTest() {
  await ensureAppServer();
  const workspace = createTransient(`self-test-${crypto.randomUUID()}`);
  try {
    await runChecks(workspace, { emit: async () => {} });
    const result = { ok: true, version: VERSION, appServer: appServerProfile };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally { removeTransient(workspace); }
}

async function ensureAppServer() {
  if (appServer?.ready && appServerProfile) return appServer;
  if (appServer) await appServer.close().catch(() => {});
  assertCodexVersion();
  appServer = new CodexAppServerClient({
    command: CODEX.command,
    args: [...CODEX.args, 'app-server', '--listen', 'stdio://'],
    cwd: REPO_ROOT,
    env: childEnv(),
    requestTimeoutMs: 60_000,
    onNotification: handleAppServerNotification,
    onServerRequest: handleAppServerRequest,
    onStderr: line => log(`App Server: ${line}`),
    clientInfo: { name: 'cursos_biblicos_editor', title: 'Cursos Bíblicos Editor', version: VERSION }
  });
  await appServer.start();
  const models = await appServer.request('model/list', { limit: 100 }, { timeoutMs: 60_000 });
  const model = (models?.data || []).find(item => item.id === MODEL || item.model === MODEL);
  const efforts = (model?.supportedReasoningEfforts || []).map(item => item.reasoningEffort);
  const tiers = (model?.serviceTiers || []).map(item => item.id);
  if (!model || !efforts.includes(EFFORT) || !tiers.includes(SERVICE_TIER)) {
    await appServer.close().catch(() => {});
    appServerProfile = null;
    throw new Error('Installed Codex does not support the required model, max reasoning, and priority tier.');
  }
  appServerProfile = { ready: true, model: MODEL, effort: EFFORT, serviceTier: SERVICE_TIER };
  return appServer;
}

function assertCodexVersion() {
  const result = spawnSync(CODEX.command, [...CODEX.args, '--version'], { encoding: 'utf8', windowsHide: true, shell: false, env: childEnv(), timeout: 15000 });
  if (result.status !== 0 || !/codex-cli\s+0\.149\.1(?:\s|$)/i.test(String(result.stdout || result.stderr || ''))) {
    throw new Error('Codex CLI 0.149.1 is required by the generated protocol schema.');
  }
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
    body: {
      id: HOST_ID,
      name: 'Computadora de edición',
      version: VERSION,
      busy,
      currentJobId,
      connection: appServer?.ready ? (busy ? 'busy' : 'ready') : 'degraded',
      appServer: appServerProfile,
      isolation: isolationProfile,
      providers: [{ id: 'codex', name: 'Codex', available: Boolean(appServer?.ready), reason: appServer?.ready ? '' : 'Codex App Server necesita atención.' }]
    }
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
    const clean = publicText(text, 30000);
    if (!clean.trim()) return this.tail;
    const preserveSpacing = type === 'assistant' && meta?.kind === 'assistant.delta';
    const event = { seq: ++this.sequence, type, text: preserveSpacing ? clean : clean.trim(), meta };
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
  if (!job?.leaseToken) throw new Error('Relay job is missing its lease.');
  busy = true;
  currentJobId = job.id;
  cancelRequested = false;
  currentProcess = null;
  const sink = new EventSink(job);
  const stopMonitor = startControlMonitor(job, sink);
  await sendHeartbeat().catch(() => {});
  try {
    await sink.emit('status', actionStartText(job.action), { kind: 'job.started', action: job.action });
    const outcome = await executeJob(job, sink);
    throwIfCancelled();
    if (outcome.summary) await sink.emit(outcome.streamed ? 'status' : 'result', outcome.summary, { kind: 'job.result', provider: outcome.provider || 'Codex' });
    await sink.flush();
    await relay('/api/code/host/complete', {
      method: 'POST',
      body: {
        jobId: job.id,
        hostId: HOST_ID,
        leaseToken: job.leaseToken,
        status: 'completed',
        provider: outcome.provider || 'Codex',
        summary: outcome.summary || '',
        url: outcome.url || '',
        data: outcome.data || null,
        release: outcome.release || null
      },
      retries: 4
    });
  } catch (error) {
    const cancelled = error instanceof CancelledError || cancelRequested;
    const message = cancelled ? 'El trabajo se detuvo.' : friendlyFailure(error);
    await sink.emit(cancelled ? 'status' : 'error', message, { kind: cancelled ? 'job.cancelled' : 'job.failed', retryable: isRetryable(error) }).catch(() => {});
    await sink.flush().catch(() => {});
    await relay('/api/code/host/complete', {
      method: 'POST',
      body: { jobId: job.id, hostId: HOST_ID, leaseToken: job.leaseToken, status: cancelled ? 'cancelled' : 'failed', error: message },
      retries: 4
    }).catch(completionError => log(`Completion failed: ${safeError(completionError)}`));
    log(`${cancelled ? 'Cancelled' : 'Failed'} job: ${safeError(error)}`);
  } finally {
    stopMonitor();
    await flushAgentDelta(activeContext).catch(() => {});
    activeContext = null;
    currentProcess = null;
    currentJobId = null;
    busy = false;
    cancelRequested = false;
    cleanupJobStaging(job.id);
    await sendHeartbeat().catch(() => {});
  }
}

async function executeJob(job, sink) {
  switch (job.action) {
    case 'prompt': return executeTurnJob(job, sink, true);
    case 'turn.start': return executeTurnJob(job, sink, false);
    case 'thread.start': return executeThreadStartJob(job, sink);
    case 'thread.resume': return executeThreadResumeJob(job, sink);
    case 'thread.read': return executeThreadReadJob(job);
    case 'thread.list': return executeThreadListJob(job);
    case 'checks': return executeChecksJob(job, sink);
    case 'preview': return executePreviewJob(job, sink);
    case 'release.prepare': return executeReleasePrepareJob(job, sink);
    case 'release.confirm': return executeReleaseConfirmJob(job);
    case 'release.publish': return executeReleasePublishJob(job, sink);
    case 'publish': throw new HostProtocolError(HOST_ERROR_CODES.RELEASE_PREPARE_REQUIRED, 'Chat cannot publish. Use the reviewed release controls.');
    default: throw new Error('Unknown relay job action.');
  }
}

function actionStartText(action) {
  return {
    prompt: 'Estoy abriendo tu borrador y entendiendo lo que pediste…',
    'turn.start': 'Estoy abriendo tu borrador y entendiendo lo que pediste…',
    'thread.start': 'Estoy creando un chat nuevo…',
    'thread.resume': 'Estoy retomando el chat…',
    'thread.read': 'Estoy cargando el historial…',
    'thread.list': 'Estoy cargando tus chats…',
    checks: 'Estoy comprobando el borrador…',
    preview: 'Estoy creando una vista previa del borrador…',
    'release.prepare': 'Estoy comprobando pruebas, diff y vista previa…',
    'release.confirm': 'Estoy verificando tu primera confirmación…',
    'release.publish': 'Estoy verificando la confirmación final antes de publicar…'
  }[action] || 'Empezando…';
}

async function executeThreadStartJob(job, sink) {
  const draft = await ensureDraft(job.clientId, job.conversationId);
  const thread = await startThread(job, draft, sink);
  return { provider: 'Codex', summary: 'El chat nuevo está listo.', data: { thread } };
}

async function executeThreadResumeJob(job, sink) {
  const record = threadRegistry.require(job.threadId, job.clientId, job.conversationId);
  await resumeThread(record, sink);
  const response = await appServer.request('thread/read', { threadId: record.threadId, includeTurns: true });
  return {
    provider: 'Codex',
    summary: 'Retomé el chat y cargué su historial.',
    data: { thread: threadRegistry.public(job.threadId, job.clientId, job.conversationId), history: extractThreadHistory(response?.thread) }
  };
}

async function executeThreadReadJob(job) {
  const record = threadRegistry.require(job.threadId, job.clientId, job.conversationId);
  await ensureAppServer();
  const response = await appServer.request('thread/read', { threadId: record.threadId, includeTurns: true });
  return {
    provider: 'Codex',
    summary: 'El historial está listo.',
    data: { thread: threadRegistry.public(record.threadId, job.clientId, job.conversationId), history: extractThreadHistory(response?.thread) }
  };
}

async function executeThreadListJob(job) {
  const threads = threadRegistry.list(job.clientId).slice(0, job.limit || 20);
  return { provider: 'Codex', summary: threads.length ? 'Tus chats están listos.' : 'Todavía no hay chats guardados en este navegador.', data: { threads } };
}

async function executeTurnJob(job, sink, legacy) {
  await ensureAppServer();
  let registered;
  if (job.threadId) {
    registered = threadRegistry.require(job.threadId, job.clientId, job.conversationId);
    await resumeThread(registered, sink);
  } else {
    registered = Object.values(state.threads).find(item => item.clientId === job.clientId && item.conversationId === job.conversationId) || null;
    if (registered) await resumeThread(registered, sink);
    else {
      const draft = await ensureDraft(job.clientId, job.conversationId);
      const publicThread = await startThread(job, draft, sink);
      registered = threadRegistry.require(publicThread.id, job.clientId, job.conversationId);
    }
  }
  const persistentDraft = registered.workspace;
  const turnWorkspace = createTransient(`${job.mode === 'plan' ? 'plan' : 'proposal'}-${job.id}`, persistentDraft);
  const persistentBefore = snapshotWorkspace(persistentDraft);
  const canonicalBefore = snapshotWorkspace(REPO_ROOT);
  try {
    await sink.emit('status', 'Plan: entender tu pedido, revisar la parte relevante de la app, preparar el cambio en el borrador, probarlo y mostrarte el diff.', { kind: 'turn.plan' });
    let turn;
    try {
      const inputs = await buildTurnInputs(job, turnWorkspace);
      turn = await runAppServerTurn({ job, sink, registered, workspace: turnWorkspace, inputs });
    } finally { cleanupWorkspaceAttachments(turnWorkspace, job.id); }
    const proposedAfter = snapshotWorkspace(turnWorkspace);
    const changes = validateWorkspaceChanges(persistentBefore, proposedAfter);
    if (job.mode === 'plan' && changes.length) throw new Error('Read-only turn attempted to change files; its temporary draft was discarded.');
    let checks = null;
    let review = null;
    let applied = false;
    if (job.mode === 'edit' && changes.length) {
      const approvalId = crypto.randomUUID();
      const proposalGate = new OneFileProposalGate({
        approvalId,
        changes,
        persistentBefore,
        proposedAfter,
        snapshotPersistent: () => snapshotWorkspace(persistentDraft),
        apply: approvedChanges => applyWorkspaceChanges(persistentDraft, turnWorkspace, approvedChanges, { isPathDenied: isProtectedPath })
      });
      checks = await runChecks(turnWorkspace, sink);
      const cumulative = currentDraftChanges(turnWorkspace);
      validateDraftDiff(cumulative, turnWorkspace);
      scanDraftSecrets(turnWorkspace, cumulative.map(item => item.filename));
      checks.diffCheck = { ok: true };
      review = { diff: await buildDiff(changes, turnWorkspace, persistentDraft), tests: checks, applied: false };
      await sink.emit('result', review.diff.preview, {
        kind: 'review.proposed',
        changeCount: review.diff.count,
        file: proposalGate.filename,
        fingerprint: review.diff.sha256,
        testsPassed: true
      });
      await sink.emit('status', 'El cambio y sus pruebas están listos. Revisa el diff y decide si quieres aplicarlo al borrador.', {
        kind: 'approval.required',
        approvalId,
        approvalType: 'fileChange',
        title: `Aplicar el cambio en ${proposalGate.filename}`,
        risk: 'Esto modifica solo el borrador revisado. Todavía no publica la app.'
      });
      const decision = await waitForApproval(job, approvalId);
      const resolution = await proposalGate.resolve(decision);
      if (resolution.applied) {
        applied = true;
        review.applied = true;
        state.drafts[draftKey(job.clientId, job.conversationId)].updatedAt = new Date().toISOString();
        saveState();
        await sink.emit('status', 'Apliqué el cambio únicamente al borrador. Nada se publicó.', {
          kind: 'approval.resolved', approvalId, decision: 'accept'
        });
      } else {
        await sink.emit('status', 'No apliqué el cambio propuesto. Nada se publicó.', {
          kind: 'approval.resolved', approvalId, decision: decision === 'cancel' ? 'cancel' : 'decline'
        });
      }
    }
    ensureSnapshotUnchanged(canonicalBefore, snapshotWorkspace(REPO_ROOT));
    await assertCanonicalClean();
    const answer = publicText(turn.answer || 'Terminé de revisar tu pedido.', 24000);
    const summary = [
      changes.length
        ? (applied ? `Borrador: ${changes.length} archivo(s) cambiado(s) con tu permiso. Nada se publicó.` : 'La propuesta no se aplicó al borrador. Nada se publicó.')
        : 'No hubo cambios de archivos.',
      checks ? 'Las pruebas y la revisión pasaron; el diff está listo para revisar.' : ''
    ].filter(Boolean).join(' ');
    rememberConversation(job.clientId, job.conversationId, job.prompt, answer);
    return {
      provider: 'Codex',
      summary,
      streamed: true,
      data: {
        thread: threadRegistry.public(registered.threadId, job.clientId, job.conversationId),
        turn: { id: turn.turnId, status: turn.status },
        review
      }
    };
  } finally {
    cleanupWorkspaceAttachments(turnWorkspace, job.id);
    removeTransient(turnWorkspace);
    cleanupJobStaging(job.id);
  }
}

async function executeChecksJob(job, sink) {
  const draft = requireDraft(job.clientId, job.conversationId);
  const tests = await runChecks(draft.workspace, sink);
  return { provider: 'Sistema', summary: 'Las pruebas y la revisión del borrador pasaron.', data: { tests } };
}

async function executePreviewJob(job, sink) {
  const draft = requireDraft(job.clientId, job.conversationId);
  const tests = await runChecks(draft.workspace, sink);
  const url = await deployPreview(draft.workspace, sink);
  return { provider: 'Sistema', url, summary: `La vista previa está lista y respondió correctamente:\n${url}`, data: { tests, previewUrl: url } };
}

async function startThread(job, draft, sink) {
  await ensureAppServer();
  const response = await appServer.request('thread/start', {
    model: MODEL,
    serviceTier: SERVICE_TIER,
    cwd: draft.workspace,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    serviceName: 'cursos_biblicos_editor',
    developerInstructions: APP_DEVELOPER_INSTRUCTIONS
  });
  const threadId = String(response?.thread?.id || '');
  const thread = threadRegistry.register({
    threadId,
    conversationId: job.conversationId,
    clientId: job.clientId,
    workspace: draft.workspace,
    name: response?.thread?.name || null,
    status: 'idle'
  });
  state.drafts[draftKey(job.clientId, job.conversationId)].threadId = threadId;
  saveState();
  await sink.emit('status', 'El chat está listo.', { kind: 'thread.started', threadId });
  return thread;
}

async function resumeThread(record, sink) {
  await ensureAppServer();
  await appServer.request('thread/resume', {
    threadId: record.threadId,
    model: MODEL,
    serviceTier: SERVICE_TIER,
    cwd: record.workspace,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    developerInstructions: APP_DEVELOPER_INSTRUCTIONS
  });
  if (sink) await sink.emit('status', 'Retomé el chat.', { kind: 'thread.resumed', threadId: record.threadId });
}

async function runAppServerTurn({ job, sink, registered, workspace, inputs }) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  const context = {
    job,
    sink,
    threadId: registered.threadId,
    turnId: null,
    workspace,
    answer: '',
    finalAnswer: '',
    pendingDelta: '',
    deltaTimer: null,
    resolveCompletion,
    rejectCompletion
  };
  activeContext = context;
  const params = {
    threadId: registered.threadId,
    input: inputs,
    cwd: workspace,
    approvalPolicy: 'on-request',
    sandboxPolicy: job.mode === 'plan'
      ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    model: MODEL,
    serviceTier: SERVICE_TIER,
    effort: EFFORT,
    summary: 'concise'
  };
  const started = await appServer.request('turn/start', params, { timeoutMs: 60_000 });
  context.turnId = String(started?.turn?.id || context.turnId || '');
  if (!context.turnId) throw new Error('App Server did not return a turn identifier.');
  if (inputs.length > 1) {
    await sink.emit('status', 'Codex recibi\u00f3 los archivos adjuntos dentro del borrador protegido.', {
      kind: 'attachments.accepted',
      attachmentCount: inputs.length - 1,
      inputKinds: inputs.slice(1).map(item => item.type).join(',')
    });
  }
  await sink.emit('status', 'Codex está trabajando en el borrador…', { kind: 'turn.started', threadId: context.threadId, turnId: context.turnId });
  const timeout = setTimeout(() => rejectCompletion(new HostProtocolError(HOST_ERROR_CODES.PROTOCOL_TIMEOUT, 'Codex turn timed out.')), MAX_JOB_MS);
  timeout.unref?.();
  try {
    const finished = await completion;
    await flushAgentDelta(context);
    if (!context.answer && context.finalAnswer) {
      await context.sink.emit('assistant', context.finalAnswer, { kind: 'assistant.final', threadId: context.threadId, turnId: context.turnId || '' });
    }
    const status = String(finished?.turn?.status || 'completed');
    if (status === 'failed') throw new Error(finished?.turn?.error?.message || 'Codex turn failed.');
    if (status === 'interrupted') throw new CancelledError();
    return { turnId: context.turnId, status, answer: context.finalAnswer || context.answer };
  } finally {
    clearTimeout(timeout);
    if (activeContext === context) activeContext = null;
  }
}

async function buildTurnInputs(job, workspace) {
  const inputs = [{ type: 'text', text: String(job.prompt || ''), text_elements: [] }];
  const attachments = Array.isArray(job.attachments) ? job.attachments : [];
  if (!attachments.length) return inputs;
  const budget = new AttachmentBudget();
  const stageRoot = path.join(workspace, '.codex-attachments', job.id);
  assertWorkspacePath(workspace, stageRoot, { allowMissing: true });
  fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  for (const metadata of attachments) {
    budget.add(metadata);
    const query = new URLSearchParams({ jobId: job.id, hostId: HOST_ID, leaseToken: job.leaseToken, attachmentId: metadata.id });
    const payload = await relay(`/api/code/host/attachment?${query.toString()}`, { retries: 4 });
    const upload = validateUpload({
      name: payload.name,
      mime: payload.mime,
      data: payload.data,
      declaredSize: payload.size,
      sha256: payload.sha256
    });
    if (metadata.name !== upload.name || metadata.mime !== upload.mime || metadata.size !== upload.size || metadata.sha256 !== upload.sha256) {
      throw new HostProtocolError(HOST_ERROR_CODES.UPLOAD_HASH_MISMATCH, 'Attachment changed before staging.');
    }
    const staged = stageAttachment(stageRoot, upload, { id: metadata.id });
    inputs.push(attachmentUserInput(staged));
  }
  return inputs;
}

function handleAppServerNotification(message) {
  if (message.method === 'windowsSandbox/setupCompleted' && sandboxSetupWaiter) {
    sandboxSetupWaiter.resolve(message.params || {});
    sandboxSetupWaiter = null;
    return;
  }
  const context = activeContext;
  if (!context || message.params?.threadId !== context.threadId) return;
  const params = message.params || {};
  if (message.method === 'turn/started') {
    context.turnId ||= String(params.turn?.id || '');
    return;
  }
  if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
    context.answer += params.delta;
    context.pendingDelta += params.delta;
    if (!context.deltaTimer) {
      context.deltaTimer = setTimeout(() => flushAgentDelta(context).catch(() => {}), 150);
      context.deltaTimer.unref?.();
    }
    return;
  }
  if (message.method === 'item/completed') {
    if (params.item?.type === 'agentMessage' && params.item.text) context.finalAnswer = params.item.text;
    if (params.item?.type === 'commandExecution') context.sink.emit('status', 'Codex terminó una comprobación interna.', { kind: 'item.command.completed', status: params.item.status || 'completed' });
    if (params.item?.type === 'fileChange') context.sink.emit('status', 'Codex actualizó el borrador.', { kind: 'item.file.completed', status: params.item.status || 'completed' });
    return;
  }
  if (message.method === 'item/started') {
    if (params.item?.type === 'commandExecution') context.sink.emit('status', 'Codex está haciendo una comprobación interna…', { kind: 'item.command.started' });
    if (params.item?.type === 'fileChange') context.sink.emit('status', 'Codex está preparando un cambio en el borrador…', { kind: 'item.file.started' });
    return;
  }
  if (message.method === 'turn/completed') context.resolveCompletion(params);
}

async function flushAgentDelta(context) {
  if (!context) return;
  if (context.deltaTimer) clearTimeout(context.deltaTimer);
  context.deltaTimer = null;
  const text = context.pendingDelta;
  context.pendingDelta = '';
  if (text) await context.sink.emit('assistant', text, { kind: 'assistant.delta', threadId: context.threadId, turnId: context.turnId || '' });
}

async function handleAppServerRequest(message) {
  const context = activeContext;
  if (!context || message.params?.threadId !== context.threadId) {
    throw new HostProtocolError(HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED, 'Unexpected App Server request.');
  }
  const policy = evaluateApprovalRequest(message, { workspaceRoot: context.workspace });
  if (policy.type === 'unsupported') {
    throw new HostProtocolError(HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED, 'Unsupported App Server request.');
  }
  if (!policy.browserMayAccept) {
    await context.sink.emit('status', 'Rechacé una solicitud que intentaba ampliar los permisos del borrador.', { kind: 'approval.denied', approvalType: policy.type, reason: policy.reason });
    return { decision: 'decline' };
  }
  await context.sink.emit('status', 'Codex prepara el cambio dentro de una copia temporal.', {
    kind: 'proposal.internal.approved',
    approvalType: policy.type,
    threadId: context.threadId,
    turnId: context.turnId || String(message.params.turnId || '')
  });
  return { decision: 'accept' };
}

async function waitForApproval(job, approvalId) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    throwIfCancelled();
    const query = new URLSearchParams({ jobId: job.id, hostId: HOST_ID, leaseToken: job.leaseToken, approvalId });
    const response = await relay(`/api/code/host/approval?${query.toString()}`, { retries: 1 });
    if (response.decision?.decision && response.decision.clientId === job.clientId && response.decision.conversationId === job.conversationId) {
      return response.decision.decision;
    }
    await delay(1200);
  }
  return 'cancel';
}

function startControlMonitor(job, sink) {
  let stopped = false;
  let cursor = '';
  let timer = null;
  let interruptSent = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const cancelQuery = new URLSearchParams({ jobId: job.id, hostId: HOST_ID, leaseToken: job.leaseToken });
      const cancellation = await relay(`/api/code/host/cancel?${cancelQuery.toString()}`, { retries: 0 });
      if (cancellation.cancelled) {
        cancelRequested = true;
        if (activeContext?.turnId && !interruptSent) {
          interruptSent = true;
          await appServer.request('turn/interrupt', { threadId: activeContext.threadId, turnId: activeContext.turnId }).catch(() => {});
        } else if (currentProcess) terminateProcess(currentProcess);
      }
      const controlQuery = new URLSearchParams({ jobId: job.id, hostId: HOST_ID, leaseToken: job.leaseToken, after: cursor });
      const controls = await relay(`/api/code/host/controls?${controlQuery.toString()}`, { retries: 0 });
      cursor = controls.cursor || cursor;
      for (const control of controls.controls || []) {
        const context = activeContext;
        if (!context || control.clientId !== job.clientId || control.conversationId !== job.conversationId || control.threadId !== context.threadId || control.turnId !== context.turnId) continue;
        if (control.operation === 'steer') {
          await appServer.request('turn/steer', {
            threadId: context.threadId,
            expectedTurnId: context.turnId,
            input: [{ type: 'text', text: control.prompt, text_elements: [] }]
          });
          await sink.emit('status', 'Añadí tu aclaración al turno activo.', { kind: 'turn.steered', threadId: context.threadId, turnId: context.turnId });
        }
        if (control.operation === 'interrupt' && !interruptSent) {
          interruptSent = true;
          cancelRequested = true;
          await appServer.request('turn/interrupt', { threadId: context.threadId, turnId: context.turnId });
        }
      }
    } catch (error) {
      if (!stopped) log(`Control monitor failed: ${safeError(error)}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, 1200);
    }
  };
  timer = setTimeout(tick, 400);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

async function executeReleasePrepareJob(job, sink) {
  const draft = requireDraft(job.clientId, job.conversationId);
  await assertReleaseBase(draft.baseCommit, false);
  const changes = currentDraftChanges(draft.workspace);
  if (!changes.length) throw new HostProtocolError(HOST_ERROR_CODES.RELEASE_PREPARE_REQUIRED, 'No hay cambios en el borrador para preparar.');
  scanDraftSecrets(draft.workspace, changes.map(item => item.filename));
  const tests = await runChecks(draft.workspace, sink);
  validateDraftDiff(changes, draft.workspace);
  tests.diffCheck = { ok: true };
  const diff = await buildDiff(changes, draft.workspace);
  const url = await deployPreview(draft.workspace, sink);
  const prepared = await releaseGate.prepare({
    baseCommit: draft.baseCommit,
    fingerprint: diff.sha256,
    paths: diff.files,
    diff,
    tests,
    previewUrl: url
  });
  state.releaseContext = { releaseId: prepared.releaseId, clientId: job.clientId, conversationId: job.conversationId };
  saveState();
  await sink.emit('status', 'La versión está preparada. Revisa la vista previa y el diff antes de confirmar.', {
    kind: 'release.prepared', releaseId: prepared.releaseId, fingerprint: diff.sha256, status: 'prepared'
  });
  return {
    provider: 'Sistema',
    url,
    summary: 'Pruebas, revisión, diff y vista previa pasaron. Nada se publicó. Confirma REVISADO para continuar.',
    release: { ...prepared, fingerprint: diff.sha256 }
  };
}

async function executeReleaseConfirmJob(job) {
  const context = requireReleaseContext(job);
  const draft = requireDraft(context.clientId, context.conversationId);
  const diff = await buildDiff(currentDraftChanges(draft.workspace), draft.workspace);
  const confirmed = await releaseGate.confirm({
    releaseId: job.releaseId,
    confirmationToken: job.confirmationToken,
    confirmation: job.confirmation,
    fingerprint: diff.sha256
  });
  return {
    provider: 'Sistema',
    summary: 'Primera confirmación guardada. Nada se publicó. Usa la confirmación final PUBLICAR para lanzar exactamente esta versión.',
    release: { ...confirmed, fingerprint: diff.sha256 }
  };
}

async function executeReleasePublishJob(job, sink) {
  const context = requireReleaseContext(job);
  const draft = requireDraft(context.clientId, context.conversationId);
  await assertReleaseBase(draft.baseCommit, true);
  const changes = currentDraftChanges(draft.workspace);
  const tests = await runChecks(draft.workspace, sink);
  validateDraftDiff(changes, draft.workspace);
  tests.diffCheck = { ok: true };
  const diff = await buildDiff(changes, draft.workspace);
  scanDraftSecrets(draft.workspace, diff.files);
  const proposal = await releaseGate.consume({
    releaseId: job.releaseId,
    publishToken: job.publishToken,
    confirmation: job.confirmation,
    fingerprint: diff.sha256
  });
  if (proposal.baseCommit !== draft.baseCommit || !sameStringSet(proposal.paths, diff.files)) {
    throw new HostProtocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'El conjunto de archivos cambió después de la revisión.');
  }
  await sink.emit('status', 'Las dos confirmaciones coinciden. Estoy creando una copia de publicación aislada…', { kind: 'release.applying', releaseId: job.releaseId });
  const releaseWorkspace = await createReleaseWorktree(draft.baseCommit, job.releaseId);
  let commit = '';
  let pushed = false;
  try {
    applyWorkspaceChanges(releaseWorkspace, draft.workspace, changes, { isPathDenied: isProtectedPath });
    const releasePaths = await workingTreePaths(releaseWorkspace);
    if (!sameStringSet(releasePaths, proposal.paths)) throw new Error('Release worktree files do not match the confirmed release.');
    validatePublishPaths(releasePaths);
    scanDraftSecrets(releaseWorkspace, releasePaths);
    await runChecks(releaseWorkspace, sink);
    await gitAt(releaseWorkspace, ['add', '--', ...proposal.paths], { title: 'Preparar archivos confirmados' });
    const staged = await stagedPaths(releaseWorkspace);
    if (!sameStringSet(staged, proposal.paths)) throw new Error('Staged files do not match the confirmed release.');
    validatePublishPaths(staged);
    await scanStagedSecrets(staged, releaseWorkspace);
    await gitAt(releaseWorkspace, ['diff', '--cached', '--check'], { title: 'Revisar diff confirmado' });
    await gitAt(releaseWorkspace, ['commit', '-m', `Edit app: confirmed release ${job.releaseId.slice(0, 8)}`], { title: 'Guardar punto de restauración', timeoutMs: 5 * 60 * 1000 });
    commit = (await gitAt(releaseWorkspace, ['rev-parse', 'HEAD'], { title: 'Confirmar versión' })).output.trim();
    await gitAt(releaseWorkspace, ['push', 'origin', `${commit}:main`], { title: 'Guardar en GitHub', timeoutMs: 8 * 60 * 1000 });
    pushed = true;
    await sink.emit('status', 'La versión está en GitHub con un punto de restauración. Estoy publicando esa copia exacta…', { kind: 'release.deploying', releaseId: job.releaseId });
    const deployment = await runVercel(['deploy', '--prod', '--yes', '--json'], {
      cwd: releaseWorkspace, title: 'Publicar versión confirmada', timeoutMs: 20 * 60 * 1000
    });
    const urls = deploymentUrls(deployment.output);
    const deploymentUrl = urls.find(item => item.includes('cursos-biblicos-web.vercel.app')) || urls.at(-1);
    if (!deploymentUrl) throw new Error('Vercel finished without returning a production URL.');
    await verifyUrl(deploymentUrl);
    await verifyLiveSite(BASE_URL);
    await git(['merge', '--ff-only', commit], { title: 'Actualizar copia local verificada', timeoutMs: 3 * 60 * 1000 });
  } catch (error) {
    state.lastReleaseAttempt = {
      releaseId: job.releaseId,
      previousCommit: draft.baseCommit,
      commit: commit || null,
      phase: pushed ? 'pushed-unverified' : 'local-failed',
      failedAt: new Date().toISOString()
    };
    saveState();
    if (pushed) {
      throw new PartialReleaseError(`La versión ${commit.slice(0, 8)} quedó guardada en GitHub, pero la publicación o su verificación falló. No la marqué como publicada; el punto anterior ${draft.baseCommit.slice(0, 8)} sigue registrado para restaurar.`);
    }
    throw error;
  } finally { cleanupReleaseWorktree(releaseWorkspace); }
  draft.baseCommit = commit;
  draft.updatedAt = new Date().toISOString();
  state.releaseGate.stage = 'published';
  state.releaseContext = null;
  state.lastReleaseAttempt = null;
  state.lastRelease = { releaseId: job.releaseId, previousCommit: proposal.baseCommit, commit, url: BASE_URL, completedAt: new Date().toISOString() };
  saveState();
  return {
    provider: 'Sistema',
    url: BASE_URL,
    summary: `Publicado correctamente. La versión ${commit.slice(0, 8)} está en vivo.`,
    release: { releaseId: job.releaseId, stage: 'published', fingerprint: diff.sha256, previewUrl: BASE_URL, paths: diff.files, diff, tests }
  };
}

function requireReleaseContext(job) {
  const context = state.releaseContext;
  if (!context || context.releaseId !== job.releaseId || context.clientId !== job.clientId || context.conversationId !== job.conversationId) {
    throw new HostProtocolError(HOST_ERROR_CODES.RELEASE_PREPARE_REQUIRED, 'Esta versión no pertenece a este navegador y chat.');
  }
  return context;
}

async function deployPreview(workspace, sink) {
  await sink.emit('status', 'Todo pasó. Estoy creando la vista previa revisable…', { kind: 'preview.deploying' });
  const deployment = await runVercel(['deploy', '--yes', '--json'], {
    cwd: workspace, title: 'Crear vista previa', timeoutMs: 20 * 60 * 1000
  });
  const url = deploymentUrls(deployment.output).at(-1);
  if (!url) throw new Error('Vercel finished without returning a preview URL.');
  await verifyUrl(url);
  await sink.emit('status', 'La vista previa respondió correctamente.', { kind: 'preview.verified' });
  return url;
}

async function runChecks(workspace, sink) {
  throwIfCancelled();
  await sink.emit('status', 'Estoy ejecutando npm test en el borrador…', { kind: 'checks.test.started' });
  await runCommand(process.execPath, [NPM_CLI, 'test'], { cwd: workspace, title: 'npm test', timeoutMs: 12 * 60 * 1000 });
  await sink.emit('status', 'npm test pasó. Ahora ejecuto npm run check…', { kind: 'checks.check.started' });
  await runCommand(process.execPath, [NPM_CLI, 'run', 'check'], { cwd: workspace, title: 'npm run check', timeoutMs: 12 * 60 * 1000 });
  await sink.emit('status', 'npm test y npm run check pasaron.', { kind: 'checks.completed', status: 'passed' });
  return { test: { ok: true }, check: { ok: true }, diffCheck: { ok: false } };
}

function validateDraftDiff(changes, workspace) {
  for (const change of changes) {
    if (!change.after || change.after.size > 2 * 1024 * 1024) continue;
    const filename = assertWorkspacePath(workspace, path.join(workspace, ...change.filename.split('/')));
    const data = fs.readFileSync(filename);
    if (data.includes(0)) continue;
    const text = data.toString('utf8');
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(text) || /[ \t]+$/m.test(text)) {
      throw new Error(`Diff check failed for ${change.filename}.`);
    }
  }
}

async function buildDiff(changes, workspace, baseWorkspace = REPO_ROOT) {
  if (!changes.length) throw new HostProtocolError(HOST_ERROR_CODES.RELEASE_PREPARE_REQUIRED, 'No hay cambios para revisar.');
  const records = changes.map(change => ({
    filename: change.filename,
    before: change.before ? { hash: change.before.hash, size: change.before.size } : null,
    after: change.after ? { hash: change.after.hash, size: change.after.size } : null
  }));
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex');
  const files = changes.map(item => item.filename).sort();
  const totalBytes = changes.reduce((sum, item) => sum + (item.after?.size || 0), 0);
  const summary = changes.map(item => `${item.before ? (item.after ? 'M' : 'D') : 'A'} ${item.filename}`).join('\n');
  let preview = '';
  const emptyRoot = path.join(TRANSIENT_ROOT, `diff-empty-${crypto.randomUUID()}`);
  fs.mkdirSync(emptyRoot, { recursive: true, mode: 0o700 });
  const emptyFile = path.join(emptyRoot, 'empty');
  fs.writeFileSync(emptyFile, '', { flag: 'wx', mode: 0o600 });
  try {
    for (const change of changes) {
      if (preview.length >= 20000) break;
      const left = change.before ? path.join(baseWorkspace, ...change.filename.split('/')) : emptyFile;
      const right = change.after ? path.join(workspace, ...change.filename.split('/')) : emptyFile;
      const result = await runProcess(GIT, ['diff', '--no-index', '--no-color', '--text', '--', left, right], { cwd: REPO_ROOT, timeoutMs: 30000 });
      if (![0, 1].includes(result.code)) throw processFailure('Crear diff', result);
      let patch = redact(result.output)
        .split(REPO_ROOT).join('')
        .split(workspace).join('')
        .split(emptyRoot).join('');
      patch = publicText(patch, 18000);
      preview += `### ${change.filename}\n${patch}\n`;
    }
  } finally {
    try { fs.rmSync(emptyRoot, { recursive: true, force: true }); } catch {}
  }
  return { sha256, files, count: files.length, totalBytes, summary: publicText(summary, 4000), preview: publicText(preview, 20000) };
}

function draftKey(clientId, conversationId) {
  return `${clientId}:${conversationId}`;
}

async function ensureDraft(clientId, conversationId) {
  const key = draftKey(clientId, conversationId);
  const current = state.drafts[key];
  if (current) {
    if (current.clientId !== clientId || current.conversationId !== conversationId) throw new Error('Draft scope mismatch.');
    assertWorkspacePath(DRAFT_ROOT, current.workspace);
    return current;
  }
  await assertCanonicalClean();
  const baseCommit = (await git(['rev-parse', 'HEAD'], { title: 'Confirmar base' })).output.trim();
  const destination = path.join(DRAFT_ROOT, clientId, conversationId);
  assertWorkspacePath(DRAFT_ROOT, destination, { allowMissing: true });
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  copyTrackedCheckout(REPO_ROOT, destination);
  const record = { clientId, conversationId, workspace: destination, baseCommit, threadId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.drafts[key] = record;
  saveState();
  return record;
}

function requireDraft(clientId, conversationId) {
  const draft = state.drafts[draftKey(clientId, conversationId)];
  if (!draft || draft.clientId !== clientId || draft.conversationId !== conversationId) {
    throw new HostProtocolError(HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED, 'No hay un borrador para este navegador y chat.');
  }
  assertWorkspacePath(DRAFT_ROOT, draft.workspace);
  return draft;
}

function createTransient(name, source = REPO_ROOT) {
  const safeName = String(name).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 90);
  const destination = path.join(TRANSIENT_ROOT, safeName);
  assertWorkspacePath(TRANSIENT_ROOT, destination, { allowMissing: true });
  if (fs.existsSync(destination)) removeTransient(destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (source === REPO_ROOT) copyTrackedCheckout(source, destination);
  else copyWorkspace(source, destination);
  return destination;
}

async function createReleaseWorktree(baseCommit, releaseId) {
  if (!/^[a-f0-9]{40,64}$/i.test(String(baseCommit)) || !/^[0-9a-f-]{36}$/i.test(String(releaseId))) {
    throw new HostProtocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'Release worktree identity is invalid.');
  }
  const destination = path.join(TRANSIENT_ROOT, `release-${String(releaseId).toLowerCase()}`);
  assertWorkspacePath(TRANSIENT_ROOT, destination, { allowMissing: true });
  if (fs.existsSync(destination)) throw new Error('A release worktree already exists for this confirmation.');
  await git(['worktree', 'add', '--detach', destination, baseCommit], {
    title: 'Crear copia aislada de publicación', timeoutMs: 3 * 60 * 1000
  });
  assertWorkspacePath(TRANSIENT_ROOT, destination);
  const head = (await gitAt(destination, ['rev-parse', 'HEAD'], { title: 'Verificar copia de publicación', quiet: true })).output.trim();
  if (head !== baseCommit) {
    cleanupReleaseWorktree(destination);
    throw new HostProtocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'Release worktree did not start from the reviewed commit.');
  }
  return destination;
}

function cleanupReleaseWorktree(directory) {
  const target = assertWorkspacePath(TRANSIENT_ROOT, directory, { allowMissing: true });
  if (target === path.resolve(TRANSIENT_ROOT)) throw new Error('Refusing to remove transient root.');
  spawnSync(GIT, ['worktree', 'remove', '--force', target], {
    cwd: REPO_ROOT, env: childEnv(), windowsHide: true, shell: false, stdio: 'ignore', timeout: 60_000
  });
  if (fs.existsSync(target)) {
    makeWritableTree(target);
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
  spawnSync(GIT, ['worktree', 'prune'], {
    cwd: REPO_ROOT, env: childEnv(), windowsHide: true, shell: false, stdio: 'ignore', timeout: 30_000
  });
}

function copyTrackedCheckout(source, destination) {
  const files = trackedFiles();
  for (const filename of files) {
    if (isSensitiveSourcePath(filename)) continue;
    const from = path.join(source, ...filename.split('/'));
    if (!fs.existsSync(from)) continue;
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`Tracked symbolic links are not allowed: ${filename}`);
    if (!stat.isFile()) continue;
    const target = path.join(destination, ...filename.split('/'));
    assertWithin(target, destination);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, target);
  }
}

function copyWorkspace(source, destination) {
  assertWorkspacePath(DRAFT_ROOT, source);
  for (const filename of listFiles(source)) {
    const from = assertWorkspacePath(source, path.join(source, ...filename.split('/')));
    const target = path.join(destination, ...filename.split('/'));
    assertWithin(target, destination);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, target);
  }
}

function removeTransient(directory) {
  const target = assertWorkspacePath(TRANSIENT_ROOT, directory);
  if (target === path.resolve(TRANSIENT_ROOT)) throw new Error('Refusing to remove transient root.');
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

function cleanupJobStaging(jobId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(jobId))) return;
  const target = path.join(STAGING_ROOT, jobId);
  if (!fs.existsSync(target)) return;
  try {
    assertWorkspacePath(STAGING_ROOT, target);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) { log(`Staging cleanup failed: ${safeError(error)}`); }
}

function cleanupTransientRoots() {
  for (const root of [TRANSIENT_ROOT, STAGING_ROOT]) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const target = path.join(root, entry.name);
      try {
        assertWorkspacePath(root, target);
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
      } catch {}
    }
  }
  spawnSync(GIT, ['worktree', 'prune'], {
    cwd: REPO_ROOT, env: childEnv(), windowsHide: true, shell: false, stdio: 'ignore', timeout: 30_000
  });
}

async function verifySandboxCanaries(client, workspace) {
  const readiness = await client.request('windowsSandbox/readiness', undefined, { timeoutMs: 30_000 });
  if (readiness?.status !== 'ready') {
    throw new HostProtocolError(HOST_ERROR_CODES.HOST_OS_ISOLATION_REQUIRED, 'Elevated Windows sandbox is not ready.');
  }
  const canaryId = crypto.randomUUID();
  const externalPath = path.join(STATE_DIR, `outside-read-canary-${canaryId}.bin`);
  const insideRoot = path.join(workspace, '.codex-isolation-canary');
  const imagePath = path.join(insideRoot, 'canary.png');
  const pdfPath = path.join(insideRoot, 'canary.pdf');
  const externalBytes = crypto.randomBytes(64);
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');
  fs.mkdirSync(insideRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(externalPath, externalBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(imagePath, imageBytes, { flag: 'wx', mode: 0o400 });
  fs.writeFileSync(pdfPath, pdfBytes, { flag: 'wx', mode: 0o400 });
  const reader = "const fs=require('fs'),c=require('crypto');for(const p of process.argv.slice(1)){const b=fs.readFileSync(p);process.stdout.write(c.createHash('sha256').update(b).digest('hex')+'\\n')}";
  const policy = { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  try {
    const inside = await client.request('command/exec', {
      command: [process.execPath, '-e', reader, imagePath, pdfPath], cwd: workspace, timeoutMs: 15_000, sandboxPolicy: policy
    }, { timeoutMs: 30_000 });
    const imageHash = hashBytes(imageBytes);
    const pdfHash = hashBytes(pdfBytes);
    const workspaceImageReadable = inside?.exitCode === 0 && String(inside.stdout || '').includes(imageHash);
    const workspacePdfReadable = inside?.exitCode === 0 && String(inside.stdout || '').includes(pdfHash);
    const outside = await client.request('command/exec', {
      command: [process.execPath, '-e', reader, externalPath], cwd: workspace, timeoutMs: 15_000, sandboxPolicy: policy
    }, { timeoutMs: 30_000 });
    const outsideHash = hashBytes(externalBytes);
    const outsideReadDenied = outside?.exitCode !== 0 && !String(outside.stdout || '').includes(outsideHash);
    return { outsideReadDenied, workspaceImageReadable, workspacePdfReadable };
  } finally {
    try { fs.rmSync(externalPath, { force: true }); } catch {}
    makeWritableTree(insideRoot);
    try { fs.rmSync(insideRoot, { recursive: true, force: true }); } catch {}
  }
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function realDirectory(value) {
  const resolved = fs.realpathSync(path.resolve(String(value || '')));
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Configured repository root is not a directory.');
  return resolved;
}

function commandExists(command) {
  return typeof command === 'string' && path.isAbsolute(command) && fs.existsSync(command) && fs.statSync(command).isFile();
}

function findNativeExecutable(name) {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, [name], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 15_000 });
  const candidates = String(result.stdout || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const executable = process.platform === 'win32' ? candidates.find(item => /\.exe$/i.test(item)) : candidates[0];
  if (!commandExists(executable)) throw new Error(`${name} is not installed as a native executable.`);
  return executable;
}

function findNpmCli(filename) {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', filename),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', filename)
  ].filter(Boolean);
  const result = candidates.find(commandExists);
  if (!result) throw new Error(`npm runtime ${filename} is not installed.`);
  return result;
}

function validateConfiguration() {
  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) throw new Error('CODE_REPO_ROOT is not a Git checkout.');
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(BASE_URL)) throw new Error('CODE_RELAY_BASE_URL must be an HTTPS origin.');
  if (!/^[A-Za-z0-9_-]{32,}$/.test(HOST_TOKEN) || !/^[0-9a-f-]{36}$/i.test(HOST_ID)) throw new Error('Host identity configuration is invalid.');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(EXPECTED_GIT_REMOTE)) throw new Error('Pinned Git remote is invalid.');
  if (!/^prj_[A-Za-z0-9]+$/.test(EXPECTED_VERCEL_PROJECT_ID) || !/^team_[A-Za-z0-9]+$/.test(EXPECTED_VERCEL_ORG_ID)) throw new Error('Pinned deployment IDs are invalid.');
  if (!commandExists(process.execPath) || !commandExists(GIT) || !commandExists(NPM_CLI) || !commandExists(NPX_CLI)) throw new Error('Required native tools are missing.');
  const repo = path.resolve(REPO_ROOT);
  const host = path.resolve(HOST_ROOT);
  if (pathWithin(host, repo) || pathWithin(repo, host)) throw new Error('Host data and repository roots must be separate.');
}

function childEnv(extra = {}) {
  const allowed = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'USERNAME', 'USERDOMAIN', 'LANG', 'LC_ALL', 'TERM'];
  const clean = {};
  for (const name of allowed) if (typeof process.env[name] === 'string') clean[name] = process.env[name];
  return { ...clean, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', GCM_INTERACTIVE: 'Never', VERCEL_TELEMETRY_DISABLED: '1', ...extra };
}

function readPrivateJson(filename) {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function writePrivateJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filename);
}

function loadState() {
  return readPrivateJson(STATE_FILE) || { conversations: {}, drafts: {}, threads: {} };
}

function saveState() {
  writePrivateJson(STATE_FILE, state);
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '');
}

function redact(value) {
  let output = String(value || '');
  for (const secret of SENSITIVE_VALUES) output = output.split(secret).join('[redacted]');
  for (const root of REDACTION_ROOTS) output = output.split(root).join('[local path]');
  return output
    .replace(/((?:token|secret|password|credential|authorization|api[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]{12,}/gi, 'Bearer [redacted]');
}

function publicText(value, limit = 30000) {
  return redactLocalPaths(redact(stripAnsi(value)), REDACTION_ROOTS).normalize('NFC').slice(0, limit);
}

function safeError(error) {
  return publicText(error instanceof Error ? error.message : String(error || 'Unknown error'), 12000);
}

function friendlyFailure(error) {
  const text = safeError(error);
  if (error?.code === HOST_ERROR_CODES.HOST_OS_ISOLATION_REQUIRED) return 'El equipo de edición está bloqueado hasta verificar el aislamiento seguro de Windows. Nada se ejecutó.';
  if (error instanceof PartialReleaseError) return error.message;
  if (/quota|usage limit|rate.?limit|too many requests/i.test(text)) return 'El ayudante alcanzó su límite de uso. Intenta otra vez más tarde.';
  if (/auth|log.?in|unauthorized|forbidden|403/i.test(text)) return 'La conexión del ayudante necesita atención en la computadora de Miguel.';
  if (/test|check|npm|syntax|failed/i.test(text)) return `No publiqué nada porque una comprobación falla. Detalle seguro: ${text.slice(-1200)}`;
  if (/fetch|network|timeout|timed out|econn/i.test(text)) return 'Se perdió la conexión. El cambio no se publicó; inténtalo otra vez.';
  return `No pude terminar de forma segura. Nada nuevo se publicó. Detalle seguro: ${text.slice(-1200)}`;
}

function isRetryable(error) {
  return /timeout|timed out|fetch|network|econn|429|503|rate.?limit/i.test(safeError(error));
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${publicText(message, 3000).replace(/[\r\n]+/g, ' ')}\n`);
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function stop() {
  running = false;
  cancelRequested = true;
  if (activeContext?.threadId && activeContext?.turnId && appServer?.ready) {
    appServer.request('turn/interrupt', {
      threadId: activeContext.threadId,
      turnId: activeContext.turnId
    }, { timeoutMs: 10_000 }).catch(() => {});
  }
  if (currentProcess) terminateProcess(currentProcess);
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

function pathWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertWithin(target, root) {
  if (!pathWithin(target, root)) throw new HostProtocolError(HOST_ERROR_CODES.PATH_OUTSIDE_WORKSPACE, 'Path escaped its allowed root.');
  return path.resolve(target);
}

function normalizedRelative(filename) {
  return String(filename || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isSensitiveSourcePath(filename) {
  const value = normalizedRelative(filename);
  return !value || value.includes('../') || value.startsWith('/') || /^[A-Za-z]:\//.test(value) || /^\/\//.test(value) ||
    /(^|\/)\.env(?:\.|$)/i.test(value) || /(^|\/)(?:\.git|\.vercel|\.code-host)(?:\/|$)/i.test(value) ||
    /(^|\/)(?:credentials?|auth(?:\.json)?|cookies?|pairing[-_.]?keys?|tokens?)(?:[._-]|$)/i.test(value) ||
    /(^|\/)\.codex-(?:attachments|isolation-canary)(?:\/|$)/i.test(value) || /(^|\/)node_modules(?:\/|$)/i.test(value);
}

function trackedFiles() {
  const result = spawnSync(GIT, ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, shell: false, env: childEnv(), timeout: 30_000 });
  if (result.status !== 0) throw new Error('Unable to enumerate tracked project files.');
  return String(result.stdout || '').split('\0').map(normalizedRelative).filter(item => item && !isSensitiveSourcePath(item));
}

function listFiles(root) {
  const output = [];
  if (!fs.existsSync(root)) return output;
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isSensitiveSourcePath(relative)) continue;
      if (entry.isSymbolicLink()) { output.push(relative); continue; }
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) output.push(relative);
    }
  };
  walk(root);
  return output.sort();
}

function hashBytes(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hashFile(filename) { return hashBytes(fs.readFileSync(filename)); }

function snapshotWorkspace(root, files = listFiles(root)) {
  const snapshot = new Map();
  for (const filename of files) {
    if (isSensitiveSourcePath(filename)) continue;
    const absolute = assertWithin(path.join(root, ...filename.split('/')), root);
    if (!fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) snapshot.set(filename, { type: 'link', hash: '', size: 0 });
    else if (stat.isFile()) snapshot.set(filename, { type: 'file', hash: hashFile(absolute), size: stat.size });
  }
  return snapshot;
}

function canonicalSnapshot() { return snapshotWorkspace(REPO_ROOT, trackedFiles()); }

function validateWorkspaceChanges(before, after) {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = names.filter(filename => {
    const left = before.get(filename);
    const right = after.get(filename);
    return !left || !right || left.type !== right.type || left.hash !== right.hash;
  }).map(filename => ({ filename, before: before.get(filename) || null, after: after.get(filename) || null }));
  if (changes.length > MAX_CHANGED_FILES) throw new Error('The draft changed too many files.');
  if (changes.reduce((sum, item) => sum + (item.after?.size || 0), 0) > MAX_CHANGED_BYTES) throw new Error('The draft changes are too large.');
  for (const change of changes) {
    if (isProtectedPath(change.filename)) throw new Error(`A protected file was changed: ${change.filename}`);
    if (change.after?.type === 'link') throw new Error(`Symbolic links are not allowed: ${change.filename}`);
  }
  return changes;
}

function ensureSnapshotUnchanged(expected, actual) {
  const names = [...new Set([...expected.keys(), ...actual.keys()])];
  for (const filename of names) {
    const left = expected.get(filename);
    const right = actual.get(filename);
    if (!left || !right || left.type !== right.type || left.hash !== right.hash) throw new Error('The canonical checkout changed while the draft was being edited.');
  }
}

function isProtectedPath(filename) {
  const value = normalizedRelative(filename);
  return isSensitiveSourcePath(value) || value.startsWith('/') || /^\/{2}/.test(value) || /^[A-Za-z]:\//.test(value) || PROTECTED_PATHS.some(pattern => pattern.test(value));
}

function currentDraftChanges(workspace) {
  const resolved = path.resolve(workspace);
  if (pathWithin(resolved, DRAFT_ROOT)) assertWorkspacePath(DRAFT_ROOT, resolved);
  else if (pathWithin(resolved, TRANSIENT_ROOT)) assertWorkspacePath(TRANSIENT_ROOT, resolved);
  else throw new HostProtocolError(HOST_ERROR_CODES.PATH_OUTSIDE_WORKSPACE, 'Draft review escaped the protected work roots.');
  return validateWorkspaceChanges(canonicalSnapshot(), snapshotWorkspace(workspace));
}

async function assertCanonicalClean() {
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { title: 'Comprobar checkout', quiet: true });
  if (status.output) throw new Error('The canonical checkout contains changes and cannot be used by the editor host.');
}

async function assertReleaseBase(baseCommit, syncRemote) {
  await assertCanonicalClean();
  const remote = (await git(['remote', 'get-url', 'origin'], { title: 'Verificar destino Git', quiet: true })).output.trim();
  if (remote.toLowerCase() !== EXPECTED_GIT_REMOTE.toLowerCase()) throw new Error('Git origin does not match the pinned repository.');
  const branch = (await git(['branch', '--show-current'], { title: 'Verificar rama', quiet: true })).output.trim();
  const head = (await git(['rev-parse', 'HEAD'], { title: 'Verificar base', quiet: true })).output.trim();
  if (branch !== 'main' || head !== baseCommit) throw new HostProtocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'La base del borrador cambió.');
  if (syncRemote) {
    await git(['fetch', '--no-tags', 'origin', 'main'], { title: 'Actualizar referencia de GitHub', timeoutMs: 3 * 60 * 1000 });
    const remoteMain = (await git(['rev-parse', 'origin/main'], { title: 'Verificar GitHub', quiet: true })).output.trim();
    if (remoteMain !== baseCommit || head !== remoteMain) throw new HostProtocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'GitHub, el checkout y el borrador ya no comparten la misma base.');
  }
}

async function workingTreePaths(cwd = REPO_ROOT) {
  const tracked = (await gitAt(cwd, ['diff', '--name-only', '-z', 'HEAD'], { title: 'Revisar cambios', quiet: true })).output.split('\0').filter(Boolean);
  const untracked = (await gitAt(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { title: 'Revisar archivos nuevos', quiet: true })).output.split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked].map(normalizedRelative))].sort();
}

async function stagedPaths(cwd = REPO_ROOT) {
  return (await gitAt(cwd, ['diff', '--cached', '--name-only', '-z'], { title: 'Revisar archivos preparados', quiet: true })).output.split('\0').filter(Boolean).map(normalizedRelative).sort();
}

function validatePublishPaths(paths) {
  const blocked = paths.filter(isProtectedPath);
  if (blocked.length) throw new Error('The confirmed release contains protected paths.');
}

function sameStringSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

const SECRET_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:OPENAI|VERCEL|GITHUB|CODE_HOST|BLOB_READ_WRITE|PASSWORD|SECRET|TOKEN|API_KEY)_?[A-Z0-9_]*\s*[=:]\s*["']?[A-Za-z0-9_\-.]{20,}/i;

function scanDraftSecrets(workspace, paths) {
  for (const filename of paths) {
    if (isProtectedPath(filename)) throw new Error('Protected content cannot be reviewed or published.');
    const absolute = assertWorkspacePath(workspace, path.join(workspace, ...filename.split('/')), { allowMissing: true });
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size > 2 * 1024 * 1024) continue;
    const data = fs.readFileSync(absolute);
    if (!data.includes(0) && SECRET_PATTERN.test(data.toString('utf8'))) throw new Error(`A possible credential was found in ${filename}; publishing stopped.`);
  }
}

async function scanStagedSecrets(paths, cwd) {
  scanDraftSecrets(cwd, paths);
}

function rememberConversation(clientId, conversationId, userText, assistantText) {
  state.conversations ||= {};
  const key = `${clientId}:${conversationId}`;
  const record = state.conversations[key] && typeof state.conversations[key] === 'object' ? state.conversations[key] : { messages: [] };
  record.messages = Array.isArray(record.messages) ? record.messages : [];
  record.messages.push({ role: 'user', text: publicText(userText, 12000), at: new Date().toISOString() });
  record.messages.push({ role: 'assistant', text: publicText(assistantText, 12000), at: new Date().toISOString() });
  record.messages = record.messages.slice(-16);
  state.conversations[key] = record;
  for (const old of Object.keys(state.conversations).sort().slice(0, Math.max(0, Object.keys(state.conversations).length - 60))) delete state.conversations[old];
  saveState();
}

function git(args, options = {}) { return gitAt(REPO_ROOT, args, options); }
function gitAt(cwd, args, options = {}) { return runCommand(GIT, args, { cwd, ...options }); }

function runVercel(args, options = {}) {
  return runCommand(process.execPath, [NPX_CLI, '--yes', 'vercel@59.7.0', ...args], {
    cwd: options.cwd || REPO_ROOT,
    envExtra: { VERCEL_ORG_ID: EXPECTED_VERCEL_ORG_ID, VERCEL_PROJECT_ID: EXPECTED_VERCEL_PROJECT_ID },
    ...options
  });
}

async function runCommand(command, args, { title, timeoutMs = 120_000, quiet = false, cwd = REPO_ROOT, envExtra = {} } = {}) {
  throwIfCancelled();
  if (!commandExists(command)) throw new Error(`${title || 'Required command'} is not installed.`);
  const result = await runProcess(command, args, { cwd, timeoutMs, envExtra });
  if (result.code !== 0) throw processFailure(title || path.basename(command), result);
  if (!quiet) log(`${title || path.basename(command)} passed.`);
  return result;
}

function runProcess(command, args, { cwd = REPO_ROOT, input, timeoutMs = 120_000, onLine, envExtra = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (!commandExists(command)) return reject(new Error('Native command was not found.'));
    const child = spawn(command, args, { cwd, env: childEnv(envExtra), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    currentProcess = child;
    let output = '';
    const partial = { stdout: '', stderr: '' };
    const capture = (chunk, stream) => {
      const value = chunk.toString('utf8');
      output = `${output}${value}`.slice(-600_000);
      const lines = `${partial[stream]}${value}`.split(/\r?\n/);
      partial[stream] = lines.pop() || '';
      for (const line of lines) { try { onLine?.(publicText(line, 4000), stream); } catch {} }
    };
    child.stdout.on('data', chunk => capture(chunk, 'stdout'));
    child.stderr.on('data', chunk => capture(chunk, 'stderr'));
    child.stdin.on('error', error => { if (error?.code !== 'EPIPE') reject(error); });
    child.once('error', reject);
    const timer = setTimeout(() => terminateProcess(child), timeoutMs);
    timer.unref?.();
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (currentProcess === child) currentProcess = null;
      if (cancelRequested) return reject(new CancelledError());
      if (signal && code == null) return reject(new Error('Process stopped before completion.'));
      resolve({ code: Number.isInteger(code) ? code : 1, output: publicText(output, 600_000) });
    });
    child.stdin.end(input == null ? undefined : String(input));
  });
}

function terminateProcess(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
  else { try { child.kill('SIGTERM'); } catch {} }
}

function processFailure(name, result) {
  const tail = publicText(result.output, 12000).trim().split(/\r?\n/).slice(-16).join('\n');
  return new Error(`${name} exited with code ${result.code}${tail ? `\n${tail}` : ''}`);
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

async function verifyUrl(url) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s]*)?$/.test(String(url))) throw new Error('Deployment URL is invalid.');
  let lastError;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      if (response.ok && /text\/html/i.test(response.headers.get('content-type') || '')) return true;
      lastError = new Error(`Deployment health check returned ${response.status}.`);
    } catch (error) { lastError = error; }
    await delay(2500);
  }
  throw lastError || new Error('Deployment did not pass its health check.');
}

async function verifyLiveSite(url = BASE_URL) { return verifyUrl(url); }

function makeWritableTree(root) {
  if (!fs.existsSync(root)) return;
  for (const filename of listFiles(root)) {
    try { fs.chmodSync(path.join(root, ...filename.split('/')), 0o600); } catch {}
  }
}

function cleanupWorkspaceAttachments(workspace, jobId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(jobId)) || !fs.existsSync(workspace)) return;
  const root = path.join(workspace, '.codex-attachments');
  const target = path.join(root, String(jobId).toLowerCase());
  if (!fs.existsSync(target)) return;
  try {
    assertWorkspacePath(workspace, target);
    makeWritableTree(target);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    if (fs.existsSync(root) && fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  } catch (error) { log(`Attachment cleanup failed: ${safeError(error)}`); }
}
