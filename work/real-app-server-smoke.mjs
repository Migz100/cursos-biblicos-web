import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CodexAppServerClient,
  evaluateApprovalRequest,
  resolveCodexCliLaunch
} from '../scripts/code-host-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workRoot = path.join(repoRoot, 'work');
const smokeRoot = path.join(workRoot, '.real-app-server-smoke');
const persistentRoot = path.join(smokeRoot, 'persistent');
const proposalRoot = path.join(smokeRoot, 'proposal');
const proofName = 'smoke-proof.txt';
const proofBefore = 'Texto de lección: 16px.\n';
const imageRelative = 'assets/la-fe-de-jesus-2-cover.png';
const pdfRelative = 'smoke-proof.pdf';
const approveProposal = process.argv.includes('--approve-proposal');

if (!approveProposal) throw new Error('The safe smoke requires --approve-proposal to simulate the one-time browser decision.');
if (path.dirname(smokeRoot) !== workRoot || !smokeRoot.startsWith(`${workRoot}${path.sep}`)) throw new Error('Smoke root escaped work/.');
if (fs.existsSync(smokeRoot)) fs.rmSync(smokeRoot, { recursive: true, force: true });
fs.mkdirSync(persistentRoot, { recursive: true, mode: 0o700 });
copyTrackedProject(persistentRoot);
fs.writeFileSync(path.join(persistentRoot, proofName), proofBefore, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
copyTree(persistentRoot, proposalRoot);
fs.writeFileSync(path.join(proposalRoot, pdfRelative), minimalPdf(), { flag: 'wx', mode: 0o600 });

const imagePath = path.join(proposalRoot, ...imageRelative.split('/'));
const pdfPath = path.join(proposalRoot, pdfRelative);
if (!fs.existsSync(imagePath)) throw new Error('The safe workspace image fixture is missing.');

const wire = {
  current: null,
  approvalsRequested: 0,
  approvalsAccepted: 0,
  notifications: 0
};
let createdThreadId = '';
const launch = resolveCodexCliLaunch();
const client = new CodexAppServerClient({
  command: launch.command,
  args: [...launch.args, 'app-server', '--listen', 'stdio://'],
  cwd: proposalRoot,
  env: safeChildEnv(),
  requestTimeoutMs: 90_000,
  allowedRequestMethods: new Set([
    'thread/start', 'thread/resume', 'thread/read', 'thread/archive',
    'turn/start', 'turn/interrupt', 'model/list'
  ]),
  onStderr: () => {},
  onNotification: message => {
    wire.notifications++;
    const current = wire.current;
    if (!current || message.params?.threadId !== current.threadId) return;
    if (message.method === 'item/agentMessage/delta' && typeof message.params.delta === 'string') current.delta += message.params.delta;
    if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') current.final = String(message.params.item.text || '');
    if (message.method === 'turn/completed') current.resolve(message.params.turn);
  },
  onServerRequest: async message => {
    wire.approvalsRequested++;
    const policy = evaluateApprovalRequest(message, { workspaceRoot: proposalRoot });
    const accepted = policy.browserMayAccept === true;
    if (accepted) wire.approvalsAccepted++;
    return { decision: accepted ? 'accept' : 'decline' };
  }
});

let result;
try {
  const initialized = await client.start();
  const models = await client.request('model/list', { limit: 100 });
  const model = (models?.data || []).find(item => item.id === 'gpt-5.6-sol' || item.model === 'gpt-5.6-sol');
  const efforts = (model?.supportedReasoningEfforts || []).map(item => item.reasoningEffort);
  const tiers = (model?.serviceTiers || []).map(item => item.id);
  if (!model || !efforts.includes('ultra') || !tiers.includes('priority')) throw new Error('Required model profile is not installed.');

  const started = await client.request('thread/start', {
    model: 'gpt-5.6-sol',
    serviceTier: 'priority',
    cwd: proposalRoot,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    ephemeral: false,
    developerInstructions: 'Prueba local segura. Trabaja solo en la carpeta asignada, sin red, sin publicar y sin mostrar rutas locales.'
  });
  const threadId = String(started?.thread?.id || '');
  if (!threadId) throw new Error('Real App Server did not create a thread.');
  createdThreadId = threadId;

  const hello = await runTurn(threadId, [{
    type: 'text',
    text: 'Sin usar herramientas, responde en español con una frase breve que comience exactamente con: Hola, estoy listo',
    text_elements: []
  }], { type: 'readOnly', networkAccess: false });
  const helloText = `${hello.delta}\n${hello.final}`.trim();
  const readAfterHello = await client.request('thread/read', { threadId, includeTurns: true });
  await client.request('thread/resume', {
    threadId,
    model: 'gpt-5.6-sol',
    serviceTier: 'priority',
    cwd: proposalRoot,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    developerInstructions: 'Prueba local segura. Trabaja solo en la carpeta asignada, sin red, sin publicar y sin mostrar rutas locales.'
  });

  const beforeSnapshot = snapshot(proposalRoot, [proofName]);
  const edit = await runTurn(threadId, [{
    type: 'text',
    text: `Realiza el cambio ahora, no des solo instrucciones. Usa la herramienta de edición de archivos, sin comandos de shell. Edita únicamente ${proofName}: reemplaza "Texto de lección: 16px." por "Texto de lección: 20px.". No cambies ningún otro archivo.`,
    text_elements: []
  }], {
    type: 'workspaceWrite',
    writableRoots: [proposalRoot],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true
  });
  const proposedValue = fs.readFileSync(path.join(proposalRoot, proofName), 'utf8');
  const persistentBeforeApproval = fs.readFileSync(path.join(persistentRoot, proofName), 'utf8');
  const changedFiles = changedTrackedFiles(proposalRoot).filter(name => name !== pdfRelative);
  const requestedTextPresent = proposedValue.includes('Texto de lección: 20px.') && !proposedValue.includes('Texto de lección: 16px.');
  const proposalDiffReady = requestedTextPresent && beforeSnapshot.get(proofName) !== hash(proposedValue) && changedFiles.length === 0;
  if (!proposalDiffReady) {
    throw new Error(`Real edit proposal check failed (requestedText=${requestedTextPresent}, proofChanged=${beforeSnapshot.get(proofName) !== hash(proposedValue)}, otherTrackedChanges=${changedFiles.length}).`);
  }
  if (persistentBeforeApproval !== proofBefore) throw new Error('Persistent draft changed before the host-level approval.');

  fs.copyFileSync(path.join(proposalRoot, proofName), path.join(persistentRoot, proofName));
  const persistentAfterApproval = fs.readFileSync(path.join(persistentRoot, proofName), 'utf8');
  const attachments = await runTurn(threadId, [
    {
      type: 'text',
      text: `Sin usar herramientas y sin mostrar rutas, confirma brevemente que recibiste una imagen y la referencia segura de un PDF llamado ${pdfRelative}.`,
      text_elements: []
    },
    { type: 'localImage', path: imagePath, detail: 'auto' },
    {
      type: 'text',
      text: `PDF adjunto seguro disponible solo para esta prueba: ${pdfPath}`,
      text_elements: []
    }
  ], { type: 'readOnly', networkAccess: false });
  const readAfterEdit = await client.request('thread/read', { threadId, includeTurns: true });
  const editText = `${edit.delta}\n${edit.final}`.trim();
  const attachmentText = `${attachments.delta}\n${attachments.final}`.trim();
  result = {
    ok: true,
    codexVersion: String(initialized?.userAgent || '').includes('0.149.1'),
    transport: 'stdio-jsonl',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    serviceTier: 'priority',
    helloVisible: /^Hola, estoy listo/i.test(helloText),
    streamedHello: hello.delta.length > 0,
    threadCreated: true,
    historyAfterHello: (readAfterHello?.thread?.turns || []).length >= 1,
    threadResumed: true,
    imageSubmitted: true,
    pdfReferenceSubmitted: true,
    attachmentResponseVisible: attachmentText.length > 0,
    editTurnCompleted: edit.status === 'completed',
    editResponseVisible: editText.length > 0,
    proposalDiffReady,
    hostApprovalRequiredBeforeApply: true,
    persistentUnchangedBeforeApproval: persistentBeforeApproval === proofBefore,
    persistentAppliedAfterApproval: persistentAfterApproval === proposedValue && requestedTextPresent,
    historyAfterEdit: (readAfterEdit?.thread?.turns || []).length >= 3,
    serverApprovalsRequested: wire.approvalsRequested,
    serverApprovalsAccepted: wire.approvalsAccepted,
    notificationsReceived: wire.notifications > 0,
    networkAllowed: false,
    published: false
  };
} finally {
  if (createdThreadId && client.ready) await client.request('thread/archive', { threadId: createdThreadId }).catch(() => {});
  await client.close().catch(() => {});
  if (fs.existsSync(smokeRoot)) fs.rmSync(smokeRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(result)}\n`);

async function runTurn(threadId, input, sandboxPolicy) {
  let resolve;
  let reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
  const current = { threadId, delta: '', final: '', resolve, reject };
  wire.current = current;
  const started = await client.request('turn/start', {
    threadId,
    input,
    cwd: proposalRoot,
    approvalPolicy: 'on-request',
    sandboxPolicy,
    model: 'gpt-5.6-sol',
    serviceTier: 'priority',
    effort: 'ultra',
    summary: 'concise'
  }, { timeoutMs: 90_000 });
  const timeout = setTimeout(() => reject(new Error('Real turn timed out.')), 5 * 60 * 1000);
  timeout.unref?.();
  try {
    const turn = await completion;
    const status = String(turn?.status || started?.turn?.status || '');
    if (status !== 'completed') throw new Error(`Real turn ended as ${status || 'unknown'}.`);
    return { delta: current.delta, final: current.final, status };
  } finally {
    clearTimeout(timeout);
    if (wire.current === current) wire.current = null;
  }
}

function copyTrackedProject(destination) {
  const result = spawnSync('git.exe', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000 });
  if (result.status !== 0) throw new Error('Unable to enumerate the safe project copy.');
  for (const relative of String(result.stdout || '').split('\0').filter(Boolean)) {
    const normalized = relative.replace(/\\/g, '/');
    if (/(^|\/)(?:\.git|\.vercel|\.code-host|node_modules)(?:\/|$)/i.test(normalized) || /(^|\/)\.env(?:\.|$)/i.test(normalized)) continue;
    const source = path.join(repoRoot, ...normalized.split('/'));
    if (!fs.existsSync(source)) continue;
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const target = path.join(destination, ...normalized.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target);
  }
}

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Smoke workspace contains a link.');
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function changedTrackedFiles(workspace) {
  const changed = [];
  const result = spawnSync('git.exe', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000 });
  for (const relative of String(result.stdout || '').split('\0').filter(Boolean)) {
    const source = path.join(repoRoot, ...relative.replace(/\\/g, '/').split('/'));
    const candidate = path.join(workspace, ...relative.replace(/\\/g, '/').split('/'));
    if (fs.existsSync(source) && fs.existsSync(candidate) && hash(fs.readFileSync(source)) !== hash(fs.readFileSync(candidate))) changed.push(relative.replace(/\\/g, '/'));
  }
  return changed;
}

function snapshot(root, names) {
  return new Map(names.map(name => [name, hash(fs.readFileSync(path.join(root, name)))]));
}

function hash(value) {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) return Buffer.from(value).toString('base64');
  return Buffer.isBuffer(value) ? value.toString('base64') : Buffer.from(String(value)).toString('base64');
}

function minimalPdf() {
  return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');
}

function safeChildEnv() {
  const allowed = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'USERNAME', 'USERDOMAIN', 'LANG', 'LC_ALL', 'TERM'];
  const clean = {};
  for (const name of allowed) if (typeof process.env[name] === 'string') clean[name] = process.env[name];
  return { ...clean, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' };
}
