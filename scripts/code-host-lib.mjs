import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';

export const HOST_ERROR_CODES = Object.freeze({
  HOST_OS_ISOLATION_REQUIRED: 'HOST_OS_ISOLATION_REQUIRED',
  PROTOCOL_NOT_STARTED: 'PROTOCOL_NOT_STARTED',
  PROTOCOL_ALREADY_STARTED: 'PROTOCOL_ALREADY_STARTED',
  PROTOCOL_TIMEOUT: 'PROTOCOL_TIMEOUT',
  PROTOCOL_CLOSED: 'PROTOCOL_CLOSED',
  PROTOCOL_INVALID_JSON: 'PROTOCOL_INVALID_JSON',
  PROTOCOL_INVALID_MESSAGE: 'PROTOCOL_INVALID_MESSAGE',
  PROTOCOL_REQUEST_FAILED: 'PROTOCOL_REQUEST_FAILED',
  PROTOCOL_METHOD_DENIED: 'PROTOCOL_METHOD_DENIED',
  APPROVAL_INVALID: 'APPROVAL_INVALID',
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_ALREADY_RESOLVED: 'APPROVAL_ALREADY_RESOLVED',
  PROPOSAL_FILE_COUNT: 'PROPOSAL_FILE_COUNT',
  UPLOAD_INVALID: 'UPLOAD_INVALID',
  UPLOAD_NAME_INVALID: 'UPLOAD_NAME_INVALID',
  UPLOAD_TYPE_DENIED: 'UPLOAD_TYPE_DENIED',
  UPLOAD_SIGNATURE_INVALID: 'UPLOAD_SIGNATURE_INVALID',
  UPLOAD_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  UPLOAD_HASH_MISMATCH: 'UPLOAD_HASH_MISMATCH',
  PATH_OUTSIDE_WORKSPACE: 'PATH_OUTSIDE_WORKSPACE',
  PATH_REPARSE_POINT: 'PATH_REPARSE_POINT',
  PATH_NOT_FOUND: 'PATH_NOT_FOUND',
  RELEASE_PREPARE_REQUIRED: 'RELEASE_PREPARE_REQUIRED',
  RELEASE_CONFIRMATION_INVALID: 'RELEASE_CONFIRMATION_INVALID',
  RELEASE_CONFIRMATION_EXPIRED: 'RELEASE_CONFIRMATION_EXPIRED',
  RELEASE_STATE_CHANGED: 'RELEASE_STATE_CHANGED',
  RELEASE_ALREADY_USED: 'RELEASE_ALREADY_USED'
});

const MAX_PROTOCOL_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_UPLOAD_BYTES = 3 * 1024 * 1024;
const DEFAULT_ATTACHMENT_SET_BYTES = 12 * 1024 * 1024;
const DEFAULT_ATTACHMENT_SET_FILES = 4;
const DEFAULT_RELEASE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CLIENT_METHODS = new Set([
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/list',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'model/list',
  'windowsSandbox/readiness',
  'windowsSandbox/setupStart',
  'command/exec'
]);
const ALLOWED_UPLOADS = new Map([
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/png', new Set(['.png'])],
  ['image/webp', new Set(['.webp'])],
  ['image/gif', new Set(['.gif'])],
  ['application/pdf', new Set(['.pdf'])],
  ['application/vnd.ms-powerpoint', new Set(['.ppt'])],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', new Set(['.pptx'])],
  ['application/vnd.openxmlformats-officedocument.presentationml.slideshow', new Set(['.ppsx'])],
  ['text/plain', new Set(['.txt'])],
  ['text/markdown', new Set(['.md'])],
  ['text/csv', new Set(['.csv'])],
  ['application/json', new Set(['.json'])]
]);

export class HostProtocolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'HostProtocolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function protocolError(code, message, details) {
  return new HostProtocolError(code, message, details);
}

export function resolveCodexCliLaunch({ env = process.env, nodePath = process.execPath, exists = fs.existsSync } = {}) {
  const candidates = [
    env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    path.join(path.dirname(nodePath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  ].filter(Boolean);
  const entrypoint = candidates.find(candidate => exists(candidate));
  if (!entrypoint) throw protocolError(HOST_ERROR_CODES.PROTOCOL_NOT_STARTED, 'Pinned Codex CLI entrypoint was not found.');
  return { command: nodePath, args: [entrypoint] };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeProtocolMessage(value) {
  return String(value || 'App Server request failed')
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/(?:[A-Za-z]:\\|\/Users\/|\/home\/)[^\s"']+/g, '[local path]')
    .slice(0, 1000);
}

/**
 * Strict newline-delimited JSON client for `codex app-server`.
 * The production host supplies a native Node command plus the pinned Codex CLI
 * entrypoint; tests can inject a fake process through command/args/spawnImpl.
 */
export class CodexAppServerClient {
  constructor({
    command,
    args = [],
    cwd,
    env,
    spawnImpl = nodeSpawn,
    onNotification = async () => {},
    onServerRequest = async request => {
      throw protocolError(HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED, `Server request is not allowed: ${request.method}`);
    },
    onStderr = () => {},
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    allowedRequestMethods = DEFAULT_CLIENT_METHODS,
    clientInfo = { name: 'cursos_biblicos_editor', title: 'Cursos Biblicos Editor', version: '1.0.0' }
  } = {}) {
    if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(item => typeof item !== 'string')) {
      throw protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, 'A native App Server command and argument list are required.');
    }
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.onStderr = onStderr;
    this.requestTimeoutMs = requestTimeoutMs;
    this.allowedRequestMethods = new Set(allowedRequestMethods);
    this.clientInfo = clientInfo;
    this.child = null;
    this.reader = null;
    this.stderrReader = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.state = 'idle';
    this.closedError = null;
  }

  get ready() {
    return this.state === 'ready';
  }

  async start() {
    if (this.state !== 'idle' && this.state !== 'closed') {
      throw protocolError(HOST_ERROR_CODES.PROTOCOL_ALREADY_STARTED, 'Codex App Server is already starting or running.');
    }
    this.state = 'starting';
    this.closedError = null;
    let child;
    try {
      child = this.spawnImpl(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      this.state = 'closed';
      throw protocolError(HOST_ERROR_CODES.PROTOCOL_CLOSED, `Unable to start Codex App Server: ${safeProtocolMessage(error?.message)}`);
    }
    this.child = child;
    child.stdin.on('error', error => this.#failClosed(protocolError(
      HOST_ERROR_CODES.PROTOCOL_CLOSED,
      `Codex App Server input failed: ${safeProtocolMessage(error?.message)}`
    )));
    child.once('error', error => this.#failClosed(protocolError(
      HOST_ERROR_CODES.PROTOCOL_CLOSED,
      `Codex App Server process error: ${safeProtocolMessage(error?.message)}`
    )));
    child.once('exit', (code, signal) => this.#failClosed(protocolError(
      HOST_ERROR_CODES.PROTOCOL_CLOSED,
      `Codex App Server closed${code == null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}.`
    )));

    this.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', line => this.#acceptLine(line));
    this.stderrReader = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.stderrReader.on('line', line => {
      try { this.onStderr(safeProtocolMessage(line)); } catch {}
    });

    try {
      const result = await this.#requestDuringStart('initialize', {
        clientInfo: this.clientInfo,
        capabilities: {
          experimentalApi: false,
          requestAttestation: false
        }
      });
      if (!isRecord(result)) throw protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, 'App Server returned an invalid initialize response.');
      this.#write({ method: 'initialized' });
      this.state = 'ready';
      return result;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  request(method, params, { timeoutMs } = {}) {
    if (!this.ready) return Promise.reject(protocolError(HOST_ERROR_CODES.PROTOCOL_NOT_STARTED, 'Codex App Server is not ready.'));
    if (!this.allowedRequestMethods.has(method)) {
      return Promise.reject(protocolError(HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED, `App Server method is not allowed: ${method}`));
    }
    return this.#sendRequest(method, params, timeoutMs);
  }

  notify(method, params) {
    if (!this.ready) throw protocolError(HOST_ERROR_CODES.PROTOCOL_NOT_STARTED, 'Codex App Server is not ready.');
    this.#write({ method, params });
  }

  async close() {
    if (!this.child) {
      this.state = 'closed';
      return;
    }
    const child = this.child;
    this.child = null;
    this.state = 'closing';
    this.#failPending(protocolError(HOST_ERROR_CODES.PROTOCOL_CLOSED, 'Codex App Server was closed.'));
    try { child.stdin.end(); } catch {}
    let exited = await waitForChildClose(child, 500);
    if (!exited) {
      terminateChildTree(child);
      exited = await waitForChildClose(child, 1500);
    }
    if (!exited) {
      try { child.kill('SIGKILL'); } catch {}
      await waitForChildClose(child, 500);
    }
    this.reader?.close();
    this.stderrReader?.close();
    try { child.stdin.destroy(); } catch {}
    try { child.stdout.destroy(); } catch {}
    try { child.stderr.destroy(); } catch {}
    this.state = 'closed';
  }

  #requestDuringStart(method, params) {
    return this.#sendRequest(method, params, this.requestTimeoutMs);
  }

  #sendRequest(method, params, timeoutMs = this.requestTimeoutMs) {
    if (typeof method !== 'string' || !method || !Number.isFinite(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, 'Invalid App Server request.'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(protocolError(HOST_ERROR_CODES.PROTOCOL_TIMEOUT, `App Server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(String(id), { method, resolve, reject, timer });
      try { this.#write({ method, id, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw this.closedError || protocolError(HOST_ERROR_CODES.PROTOCOL_CLOSED, 'Codex App Server input is closed.');
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      throw protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, 'App Server message exceeds the safe size limit.');
    }
    this.child.stdin.write(`${line}\n`, 'utf8');
  }

  #acceptLine(line) {
    if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      this.#failClosed(protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, 'App Server emitted an oversized message.'));
      return;
    }
    let message;
    try { message = JSON.parse(line); }
    catch {
      this.#failClosed(protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_JSON, 'App Server emitted invalid JSONL.'));
      return;
    }
    if (!isRecord(message)) {
      this.#failClosed(protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, 'App Server emitted a non-object message.'));
      return;
    }
    if ('id' in message && !('method' in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (isRecord(message.error)) {
        pending.reject(protocolError(
          HOST_ERROR_CODES.PROTOCOL_REQUEST_FAILED,
          safeProtocolMessage(message.error.message),
          { method: pending.method, rpcCode: message.error.code }
        ));
      } else if ('result' in message) pending.resolve(message.result);
      else pending.reject(protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, 'App Server response has neither result nor error.'));
      return;
    }
    if (typeof message.method !== 'string' || !isRecord(message.params)) {
      this.#failClosed(protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, 'App Server notification or request is malformed.'));
      return;
    }
    if ('id' in message) {
      Promise.resolve()
        .then(() => this.onServerRequest(message))
        .then(result => this.#write({ id: message.id, result: result ?? {} }))
        .catch(error => {
          try {
            this.#write({
              id: message.id,
              error: {
                code: error?.code === HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED ? -32601 : -32000,
                message: safeProtocolMessage(error?.message)
              }
            });
          } catch {}
        });
      return;
    }
    Promise.resolve(this.onNotification(message)).catch(() => {});
  }

  #failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #failClosed(error) {
    if (this.state === 'closed') return;
    const closing = this.state === 'closing';
    this.closedError = error;
    this.state = 'closed';
    this.#failPending(error);
    if (!closing) terminateChildTree(this.child);
  }
}

function waitForChildClose(child, timeoutMs) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
}

function terminateChildTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
      timeout: 10_000
    });
    return;
  }
  try { child.kill('SIGKILL'); } catch {}
}

export function validateUpload(input, { maxBytes = DEFAULT_UPLOAD_BYTES } = {}) {
  if (!isRecord(input) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw protocolError(HOST_ERROR_CODES.UPLOAD_INVALID, 'Invalid attachment upload.');
  }
  const rawName = typeof input.name === 'string' ? input.name.normalize('NFC').trim() : '';
  if (!rawName || rawName.length > 120 || rawName !== path.basename(rawName) || /[\\/\u0000-\u001F\u007F]/.test(rawName) || /^\.+$/.test(rawName)) {
    throw protocolError(HOST_ERROR_CODES.UPLOAD_NAME_INVALID, 'Attachment name is not safe.');
  }
  if (/^(?:\.env|\.git|\.vercel|\.code-host)(?:\.|$)/i.test(rawName) || /[.](?:exe|com|bat|cmd|ps1|msi|scr|js|mjs|cjs|vbs|jar|pptm)$/i.test(rawName)) {
    throw protocolError(HOST_ERROR_CODES.UPLOAD_NAME_INVALID, 'Attachment name is not allowed.');
  }
  const mime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : '';
  const extensions = ALLOWED_UPLOADS.get(mime);
  const extension = path.extname(rawName).toLowerCase();
  if (!extensions?.has(extension)) throw protocolError(HOST_ERROR_CODES.UPLOAD_TYPE_DENIED, 'Attachment type is not allowed.');
  if (typeof input.data !== 'string' || !input.data || input.data.length > Math.ceil(maxBytes / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) {
    throw protocolError(HOST_ERROR_CODES.UPLOAD_INVALID, 'Attachment data is not valid base64.');
  }
  let data;
  try { data = Buffer.from(input.data, 'base64'); }
  catch { throw protocolError(HOST_ERROR_CODES.UPLOAD_INVALID, 'Attachment data is not valid base64.'); }
  if (!data.length || data.length > maxBytes) throw protocolError(HOST_ERROR_CODES.UPLOAD_TOO_LARGE, 'Attachment exceeds the safe size limit.');
  const canonical = data.toString('base64').replace(/=+$/, '');
  if (canonical !== input.data.replace(/=+$/, '')) throw protocolError(HOST_ERROR_CODES.UPLOAD_INVALID, 'Attachment data is not canonical base64.');
  if (input.declaredSize != null && Number(input.declaredSize) !== data.length) {
    throw protocolError(HOST_ERROR_CODES.UPLOAD_INVALID, 'Attachment size does not match its contents.');
  }
  if (!validUploadSignature(mime, data)) {
    throw protocolError(HOST_ERROR_CODES.UPLOAD_SIGNATURE_INVALID, 'Attachment contents do not match the declared type.');
  }
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  if (input.sha256 != null && (!/^[a-f0-9]{64}$/i.test(String(input.sha256)) || String(input.sha256).toLowerCase() !== sha256)) {
    throw protocolError(HOST_ERROR_CODES.UPLOAD_HASH_MISMATCH, 'Attachment checksum does not match.');
  }
  return { name: rawName, mime, size: data.length, sha256, extension, data };
}

function validUploadSignature(mime, data) {
  const begins = bytes => data.length >= bytes.length && bytes.every((byte, index) => data[index] === byte);
  if (mime === 'image/jpeg') return begins([0xff, 0xd8, 0xff]);
  if (mime === 'image/png') return begins([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === 'image/gif') return /^(?:GIF87a|GIF89a)$/.test(data.subarray(0, 6).toString('ascii'));
  if (mime === 'image/webp') return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mime === 'application/pdf') return data.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mime === 'application/vnd.ms-powerpoint') return begins([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mime === 'application/vnd.openxmlformats-officedocument.presentationml.slideshow') {
    return begins([0x50, 0x4b, 0x03, 0x04]) && data.includes(Buffer.from('[Content_Types].xml')) && data.includes(Buffer.from('ppt/'));
  }
  if (mime === 'application/json') {
    try { JSON.parse(data.toString('utf8')); return !data.includes(0); } catch { return false; }
  }
  return mime.startsWith('text/') && !data.includes(0) && Buffer.from(data.toString('utf8'), 'utf8').equals(data);
}

function pathStartsWith(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertWorkspacePath(root, target, { allowMissing = false } = {}) {
  const requestedRoot = path.resolve(String(root || ''));
  if (!fs.existsSync(requestedRoot)) throw protocolError(HOST_ERROR_CODES.PATH_NOT_FOUND, 'Allowed workspace root does not exist.');
  if (fs.lstatSync(requestedRoot).isSymbolicLink()) throw protocolError(HOST_ERROR_CODES.PATH_REPARSE_POINT, 'Allowed workspace root cannot be a reparse point.');
  const realRoot = fs.realpathSync(requestedRoot);
  const resolved = path.resolve(String(target || ''));
  if (!pathStartsWith(resolved, requestedRoot)) throw protocolError(HOST_ERROR_CODES.PATH_OUTSIDE_WORKSPACE, 'Path escaped its allowed workspace.');

  const relative = path.relative(requestedRoot, resolved);
  let cursor = requestedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) {
      if (allowMissing) break;
      throw protocolError(HOST_ERROR_CODES.PATH_NOT_FOUND, 'Workspace path does not exist.');
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw protocolError(HOST_ERROR_CODES.PATH_REPARSE_POINT, 'Workspace path contains a reparse point.');
    const real = fs.realpathSync(cursor);
    if (!pathStartsWith(real, realRoot)) throw protocolError(HOST_ERROR_CODES.PATH_OUTSIDE_WORKSPACE, 'Resolved path escaped its allowed workspace.');
  }
  if (!allowMissing && !fs.existsSync(resolved)) throw protocolError(HOST_ERROR_CODES.PATH_NOT_FOUND, 'Workspace path does not exist.');
  return resolved;
}

export function stageAttachment(root, input, { id = crypto.randomUUID() } = {}) {
  const upload = Buffer.isBuffer(input?.data) && input.sha256 ? input : validateUpload(input);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id))) {
    throw protocolError(HOST_ERROR_CODES.UPLOAD_INVALID, 'Attachment identifier is not valid.');
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertWorkspacePath(root, root);
  const filename = `${String(id).toLowerCase()}-${upload.name}`;
  const target = assertWorkspacePath(root, path.join(root, filename), { allowMissing: true });
  fs.writeFileSync(target, upload.data, { flag: 'wx', mode: 0o600 });
  const written = fs.readFileSync(target);
  const sha256 = crypto.createHash('sha256').update(written).digest('hex');
  if (written.length !== upload.size || sha256 !== upload.sha256) {
    try { fs.rmSync(target, { force: true }); } catch {}
    throw protocolError(HOST_ERROR_CODES.UPLOAD_HASH_MISMATCH, 'Staged attachment failed integrity verification.');
  }
  fs.chmodSync(target, 0o400);
  return { id: String(id).toLowerCase(), name: upload.name, mime: upload.mime, size: upload.size, sha256, path: target };
}

/** Convert a verified staged upload into the native App Server input shape. */
export function attachmentUserInput(staged) {
  if (!isRecord(staged) || typeof staged.path !== 'string' || !path.isAbsolute(staged.path) ||
      typeof staged.name !== 'string' || !staged.name || typeof staged.mime !== 'string') {
    throw protocolError(HOST_ERROR_CODES.UPLOAD_INVALID, 'Staged attachment metadata is invalid.');
  }
  if (staged.mime.startsWith('image/')) {
    return { type: 'localImage', detail: 'auto', path: staged.path };
  }
  return { type: 'mention', name: staged.name, path: staged.path };
}

function snapshotRecordEqual(left, right) {
  return Boolean(left) && Boolean(right) && left.type === right.type && left.hash === right.hash && left.size === right.size;
}

export function assertSnapshotsEqual(expected, actual, message = 'The persistent draft changed outside the approved proposal.') {
  if (!(expected instanceof Map) || !(actual instanceof Map)) {
    throw protocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'Draft snapshots are invalid.');
  }
  const names = new Set([...expected.keys(), ...actual.keys()]);
  for (const filename of names) {
    if (!snapshotRecordEqual(expected.get(filename), actual.get(filename))) {
      throw protocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, message);
    }
  }
}

/**
 * One-shot boundary between a disposable Codex workspace and the persistent
 * draft. The only mutating callback runs after a matching browser decision.
 */
export class OneFileProposalGate {
  constructor({ approvalId, changes, persistentBefore, proposedAfter, snapshotPersistent, apply }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(approvalId)) ||
        !(persistentBefore instanceof Map) || !(proposedAfter instanceof Map) ||
        typeof snapshotPersistent !== 'function' || typeof apply !== 'function') {
      throw protocolError(HOST_ERROR_CODES.APPROVAL_INVALID, 'Proposal approval configuration is invalid.');
    }
    if (!Array.isArray(changes) || changes.length !== 1 || typeof changes[0]?.filename !== 'string' || !changes[0].filename) {
      throw protocolError(HOST_ERROR_CODES.PROPOSAL_FILE_COUNT, 'Each editor proposal must change exactly one file.');
    }
    this.approvalId = String(approvalId).toLowerCase();
    this.changes = changes.map(change => ({ ...change }));
    this.persistentBefore = persistentBefore;
    this.proposedAfter = proposedAfter;
    this.snapshotPersistent = snapshotPersistent;
    this.apply = apply;
    this.state = 'pending';
  }

  get filename() {
    return this.changes[0].filename;
  }

  async resolve(decision) {
    if (this.state !== 'pending') {
      throw protocolError(HOST_ERROR_CODES.APPROVAL_ALREADY_RESOLVED, 'This proposal approval has already been resolved.');
    }
    if (!['accept', 'decline', 'cancel'].includes(decision)) {
      throw protocolError(HOST_ERROR_CODES.APPROVAL_INVALID, 'Proposal approval decision is invalid.');
    }
    this.state = 'resolving';
    try {
      assertSnapshotsEqual(this.persistentBefore, await this.snapshotPersistent());
      if (decision === 'accept') {
        await this.apply(this.changes);
        assertSnapshotsEqual(this.proposedAfter, await this.snapshotPersistent(), 'The saved draft does not exactly match the approved proposal.');
      }
      this.state = 'resolved';
      return { approvalId: this.approvalId, decision, applied: decision === 'accept', filename: this.filename };
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }
}

export function applyWorkspaceChanges(targetRoot, sourceRoot, changes, { isPathDenied = () => false } = {}) {
  const targetBase = assertWorkspacePath(targetRoot, targetRoot);
  const sourceBase = assertWorkspacePath(sourceRoot, sourceRoot);
  if (!Array.isArray(changes) || typeof isPathDenied !== 'function') {
    throw protocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'Workspace apply input is invalid.');
  }
  for (const change of changes) {
    const filename = String(change?.filename || '').replace(/\\/g, '/');
    if (!filename || filename.startsWith('/') || filename.includes('../') || path.isAbsolute(filename) || isPathDenied(filename)) {
      throw protocolError(HOST_ERROR_CODES.PATH_OUTSIDE_WORKSPACE, 'A denied path reached the proposal apply boundary.');
    }
    const target = assertWorkspacePath(targetBase, path.join(targetBase, ...filename.split('/')), { allowMissing: true });
    if (!change.after) {
      if (fs.existsSync(target)) {
        if (!fs.lstatSync(target).isFile()) throw protocolError(HOST_ERROR_CODES.PATH_REPARSE_POINT, 'Proposal target is not a regular file.');
        fs.rmSync(target, { force: true });
      }
      continue;
    }
    const source = assertWorkspacePath(sourceBase, path.join(sourceBase, ...filename.split('/')));
    if (!fs.lstatSync(source).isFile()) throw protocolError(HOST_ERROR_CODES.PATH_REPARSE_POINT, 'Proposal source is not a regular file.');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = assertWorkspacePath(targetBase, `${target}.cb-proposal-${crypto.randomUUID()}.tmp`, { allowMissing: true });
    try {
      fs.copyFileSync(source, temporary);
      fs.renameSync(temporary, target);
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }
}

export function extractThreadHistory(thread, { maxTurns = 50, maxItems = 100, maxBytes = 120_000 } = {}) {
  const history = [];
  for (const turn of Array.isArray(thread?.turns) ? thread.turns.slice(-maxTurns) : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type === 'userMessage') {
        const parts = Array.isArray(item.content) ? item.content : [];
        const text = parts
          .filter(part => ['text', 'inputText', 'input_text'].includes(part?.type))
          .map(part => part.text)
          .filter(Boolean)
          .join('\n');
        if (text) history.push({ role: 'user', text: redactLocalPaths(text).slice(0, 8000), turnId: turn.id });
      }
      if (item?.type === 'agentMessage' && item.text) {
        history.push({ role: 'assistant', text: redactLocalPaths(item.text).slice(0, 8000), turnId: turn.id });
      }
    }
  }
  const selected = [];
  let bytes = 0;
  for (const item of history.slice(-maxItems).reverse()) {
    const itemBytes = Buffer.byteLength(item.text, 'utf8');
    if (selected.length && bytes + itemBytes > maxBytes) break;
    selected.unshift(item);
    bytes += itemBytes;
  }
  return selected;
}

export class AttachmentBudget {
  constructor({ maxFiles = DEFAULT_ATTACHMENT_SET_FILES, maxBytes = DEFAULT_ATTACHMENT_SET_BYTES } = {}) {
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw protocolError(HOST_ERROR_CODES.UPLOAD_INVALID, 'Attachment budget is invalid.');
    }
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
    this.items = new Map();
    this.totalBytes = 0;
  }

  add(attachment) {
    const id = String(attachment?.id || '');
    const size = Number(attachment?.size);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isSafeInteger(size) || size < 1) {
      throw protocolError(HOST_ERROR_CODES.UPLOAD_INVALID, 'Attachment metadata is invalid.');
    }
    if (this.items.has(id)) return this.summary();
    if (this.items.size + 1 > this.maxFiles) throw protocolError(HOST_ERROR_CODES.UPLOAD_TOO_LARGE, `A turn can include at most ${this.maxFiles} attachments.`);
    if (this.totalBytes + size > this.maxBytes) throw protocolError(HOST_ERROR_CODES.UPLOAD_TOO_LARGE, 'Combined attachments exceed the safe turn limit.');
    this.items.set(id.toLowerCase(), size);
    this.totalBytes += size;
    return this.summary();
  }

  summary() {
    return { count: this.items.size, totalBytes: this.totalBytes };
  }
}

export function redactLocalPaths(value, roots = []) {
  let output = String(value || '');
  for (const root of roots) {
    const text = String(root || '');
    if (text) output = output.split(text).join('[local path]');
  }
  return output
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/\/|\/Users\/|\/home\/|\/tmp\/)[^\s"')\]}]+/g, '[local path]')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .slice(0, 30_000);
}

function cleanPublicThread(record) {
  return {
    id: record.threadId,
    conversationId: record.conversationId,
    name: typeof record.name === 'string' ? record.name.slice(0, 120) : null,
    status: typeof record.status === 'string' ? record.status.slice(0, 30) : null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null
  };
}

/** State-backed allowlist. It never discovers or lists global Codex history. */
export class ThreadRegistry {
  constructor({ state, workspaceRoot }) {
    if (!isRecord(state) || typeof workspaceRoot !== 'string' || !workspaceRoot) {
      throw protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, 'Thread registry configuration is invalid.');
    }
    this.state = state;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.state.threads ||= {};
  }

  register({ threadId, conversationId, clientId, workspace, name = null, status = 'idle' }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(threadId)) ||
        !/^[0-9a-f-]{36}$/i.test(String(conversationId)) || !/^[0-9a-f-]{36}$/i.test(String(clientId))) {
      throw protocolError(HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE, 'Thread identity is invalid.');
    }
    const checkedWorkspace = assertWorkspacePath(this.workspaceRoot, workspace);
    const previous = this.state.threads[threadId];
    if (previous && (previous.clientId !== String(clientId).toLowerCase() || previous.conversationId !== String(conversationId).toLowerCase())) {
      throw protocolError(HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED, 'Thread registration cannot change browser or chat ownership.');
    }
    const now = new Date().toISOString();
    this.state.threads[threadId] = {
      threadId: String(threadId),
      conversationId: String(conversationId).toLowerCase(),
      clientId: String(clientId).toLowerCase(),
      workspace: checkedWorkspace,
      name: typeof name === 'string' ? name.slice(0, 120) : previous?.name || null,
      status: typeof status === 'string' ? status.slice(0, 30) : previous?.status || 'idle',
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };
    return cleanPublicThread(this.state.threads[threadId]);
  }

  require(threadId, clientId, conversationId = null) {
    const record = this.state.threads?.[threadId];
    if (!record) throw protocolError(HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED, 'Thread is not registered for this editor.');
    if (!/^[0-9a-f-]{36}$/i.test(String(clientId)) || record.clientId !== String(clientId).toLowerCase()) {
      throw protocolError(HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED, 'Thread is not available to this browser.');
    }
    if (conversationId != null && record.conversationId !== String(conversationId).toLowerCase()) {
      throw protocolError(HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED, 'Thread does not belong to this chat.');
    }
    assertWorkspacePath(this.workspaceRoot, record.workspace);
    return { ...record };
  }

  list(clientId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(clientId))) throw protocolError(HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED, 'Browser scope is invalid.');
    return Object.values(this.state.threads || {})
      .filter(record => record.clientId === String(clientId).toLowerCase())
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .map(cleanPublicThread);
  }

  public(threadId, clientId, conversationId = null) {
    return cleanPublicThread(this.require(threadId, clientId, conversationId));
  }
}

function actionPath(action) {
  return action?.path == null ? null : String(action.path);
}

function approvalPath(workspaceRoot, candidate) {
  return path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate);
}

/**
 * Browser approval is only advisory. The host independently checks that the
 * requested capability is a read/list/search inside the one draft root or a
 * file change that does not request a broader root.
 */
export function evaluateApprovalRequest(message, { workspaceRoot } = {}) {
  if (!isRecord(message) || !isRecord(message.params) || typeof workspaceRoot !== 'string') {
    throw protocolError(HOST_ERROR_CODES.APPROVAL_INVALID, 'Approval request is invalid.');
  }
  const { method, params } = message;
  if (method === 'item/fileChange/requestApproval') {
    return {
      browserMayAccept: params.grantRoot == null,
      type: 'fileChange',
      decisions: ['accept', 'decline', 'cancel'],
      reason: params.grantRoot == null ? 'workspace-file-change' : 'root-expansion-denied'
    };
  }
  if (method === 'item/commandExecution/requestApproval') {
    const actions = Array.isArray(params.commandActions) ? params.commandActions : [];
    let inside = true;
    try {
      if (params.cwd) assertWorkspacePath(workspaceRoot, approvalPath(workspaceRoot, String(params.cwd)));
      for (const action of actions) {
        if (!['read', 'listFiles', 'search'].includes(action?.type)) inside = false;
        const candidate = actionPath(action);
        if (candidate) assertWorkspacePath(workspaceRoot, approvalPath(workspaceRoot, candidate));
      }
    } catch { inside = false; }
    const noExpansion = !params.networkApprovalContext &&
      !params.proposedExecpolicyAmendment &&
      (!Array.isArray(params.proposedNetworkPolicyAmendments) || !params.proposedNetworkPolicyAmendments.length);
    const browserMayAccept = actions.length > 0 && inside && noExpansion;
    return {
      browserMayAccept,
      type: 'commandExecution',
      decisions: ['accept', 'decline', 'cancel'],
      reason: browserMayAccept ? 'workspace-read-only-command' : 'capability-expansion-denied'
    };
  }
  return {
    browserMayAccept: false,
    type: 'unsupported',
    decisions: ['decline', 'cancel'],
    reason: 'unsupported-approval-denied'
  };
}

function releaseDigest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function equalDigest(actual, expected) {
  if (!/^[a-f0-9]{64}$/i.test(String(actual)) || !/^[a-f0-9]{64}$/i.test(String(expected))) return false;
  return crypto.timingSafeEqual(Buffer.from(String(actual), 'hex'), Buffer.from(String(expected), 'hex'));
}

function cleanReleasePaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 80) throw protocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'Release file set is invalid.');
  const output = [...new Set(paths.map(item => String(item).replace(/\\/g, '/')))];
  if (output.some(item => !item || item.startsWith('/') || /^\/{2}/.test(item) || /^[A-Za-z]:\//.test(item) || item.includes('../') || path.isAbsolute(item))) {
    throw protocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'Release file set escaped the draft.');
  }
  return output.sort();
}

export class ReleaseGate {
  constructor({
    state,
    saveState = async () => {},
    now = () => Date.now(),
    randomBytes = crypto.randomBytes,
    ttlMs = DEFAULT_RELEASE_TTL_MS
  } = {}) {
    if (!isRecord(state) || typeof saveState !== 'function' || typeof now !== 'function' || typeof randomBytes !== 'function') {
      throw protocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'Release gate state is invalid.');
    }
    this.state = state;
    this.saveState = saveState;
    this.now = now;
    this.randomBytes = randomBytes;
    this.ttlMs = ttlMs;
  }

  async prepare({ baseCommit, fingerprint, paths, diff, tests, previewUrl = null }) {
    if (!/^[a-f0-9]{40,64}$/i.test(String(baseCommit)) || !/^[a-f0-9]{64}$/i.test(String(fingerprint))) {
      throw protocolError(HOST_ERROR_CODES.RELEASE_STATE_CHANGED, 'Release base or fingerprint is invalid.');
    }
    if (!isRecord(diff) || diff.sha256 !== String(fingerprint).toLowerCase() || !Array.isArray(diff.files) || !String(diff.preview || '').trim() ||
        !isRecord(tests) || tests.test?.ok !== true || tests.check?.ok !== true || tests.diffCheck?.ok !== true ||
        typeof previewUrl !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s]*)?$/.test(previewUrl)) {
      throw protocolError(HOST_ERROR_CODES.RELEASE_PREPARE_REQUIRED, 'Tests, checks, diff, and preview must all pass before confirmation.');
    }
    const releaseId = crypto.randomUUID();
    const confirmationToken = this.randomBytes(32).toString('base64url');
    const expiresAtMs = this.now() + this.ttlMs;
    const proposal = {
      releaseId,
      stage: 'prepared',
      baseCommit: String(baseCommit).toLowerCase(),
      fingerprint: String(fingerprint).toLowerCase(),
      paths: cleanReleasePaths(paths),
      diff,
      tests,
      previewUrl,
      confirmTokenHash: releaseDigest(confirmationToken),
      expiresAtMs,
      createdAt: new Date(this.now()).toISOString()
    };
    this.state.releaseGate = proposal;
    await this.saveState();
    return {
      releaseId,
      confirmationToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
      paths: [...proposal.paths],
      diff: proposal.diff,
      tests: proposal.tests,
      previewUrl: proposal.previewUrl,
      stage: 'prepared'
    };
  }

  async confirm({ releaseId, confirmationToken, confirmation, fingerprint }) {
    const proposal = this.#requireStage(releaseId, 'prepared');
    this.#requireFresh(proposal);
    if (confirmation !== 'REVISADO' || fingerprint !== proposal.fingerprint || !equalDigest(releaseDigest(confirmationToken), proposal.confirmTokenHash)) {
      throw protocolError(HOST_ERROR_CODES.RELEASE_CONFIRMATION_INVALID, 'First release confirmation is invalid.');
    }
    const publishToken = this.randomBytes(32).toString('base64url');
    proposal.stage = 'confirmed';
    proposal.publishTokenHash = releaseDigest(publishToken);
    proposal.confirmTokenHash = null;
    proposal.expiresAtMs = this.now() + this.ttlMs;
    proposal.confirmedAt = new Date(this.now()).toISOString();
    await this.saveState();
    return {
      releaseId: proposal.releaseId,
      publishToken,
      expiresAt: new Date(proposal.expiresAtMs).toISOString(),
      stage: 'confirmed'
    };
  }

  async consume({ releaseId, publishToken, confirmation, fingerprint }) {
    const proposal = this.#requireStage(releaseId, 'confirmed');
    this.#requireFresh(proposal);
    if (confirmation !== 'PUBLICAR' || fingerprint !== proposal.fingerprint || !equalDigest(releaseDigest(publishToken), proposal.publishTokenHash)) {
      throw protocolError(HOST_ERROR_CODES.RELEASE_CONFIRMATION_INVALID, 'Final release confirmation is invalid.');
    }
    proposal.stage = 'consumed';
    proposal.publishTokenHash = null;
    proposal.consumedAt = new Date(this.now()).toISOString();
    await this.saveState();
    return {
      releaseId: proposal.releaseId,
      stage: 'consumed',
      baseCommit: proposal.baseCommit,
      fingerprint: proposal.fingerprint,
      paths: [...proposal.paths],
      diff: proposal.diff,
      tests: proposal.tests,
      previewUrl: proposal.previewUrl
    };
  }

  #requireStage(releaseId, expected) {
    const proposal = this.state.releaseGate;
    if (!proposal) throw protocolError(HOST_ERROR_CODES.RELEASE_PREPARE_REQUIRED, 'Prepare the release before publishing.');
    if (proposal.releaseId !== releaseId) throw protocolError(HOST_ERROR_CODES.RELEASE_CONFIRMATION_INVALID, 'Release identifier does not match.');
    if (proposal.stage === 'consumed') throw protocolError(HOST_ERROR_CODES.RELEASE_ALREADY_USED, 'Release confirmation has already been used.');
    if (proposal.stage !== expected) throw protocolError(HOST_ERROR_CODES.RELEASE_CONFIRMATION_INVALID, 'Release confirmation is out of order.');
    return proposal;
  }

  #requireFresh(proposal) {
    if (!Number.isFinite(proposal.expiresAtMs) || this.now() > proposal.expiresAtMs) {
      throw protocolError(HOST_ERROR_CODES.RELEASE_CONFIRMATION_EXPIRED, 'Release confirmation expired.');
    }
  }
}
