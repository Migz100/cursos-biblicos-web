const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.resolve(__dirname, '..');
const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-codex-app-server.mjs');
const LIBRARY_URL = pathToFileURL(path.resolve(__dirname, '../scripts/code-host-lib.mjs')).href;

const THREAD_ID = '01900000-0000-7000-8000-000000000001';
const TURN_ID = '01900000-0000-7000-8000-000000000003';

let libraryPromise;

function library() {
  libraryPromise ||= import(LIBRARY_URL);
  return libraryPromise;
}

function callbackMessage(args) {
  if (args[0] && typeof args[0] === 'object' && typeof args[0].method === 'string') return args[0];
  return { method: args[0], params: args[1], id: args[2] };
}

function safeChildEnv() {
  return Object.fromEntries([
    'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP'
  ].filter(name => process.env[name]).map(name => [name, process.env[name]]));
}

async function makeClient(t, { fakeArgs = [], onNotification, onServerRequest, requestTimeoutMs = 1000 } = {}) {
  const { CodexAppServerClient } = await library();
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [FAKE_SERVER, ...fakeArgs],
    cwd: REPO_ROOT,
    env: safeChildEnv(),
    onNotification,
    onServerRequest,
    requestTimeoutMs
  });
  t.after(async () => {
    try { await client.close(); } catch {}
  });
  return client;
}

function tempArea(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursos-code-protocol-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function readJsonLines(filename) {
  return fs.readFileSync(filename, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('App Server initialization is initialize response then initialized notification', async t => {
  const directory = tempArea(t);
  const log = path.join(directory, 'wire.jsonl');
  const client = await makeClient(t, { fakeArgs: [`--log=${log}`] });

  const result = await client.start();
  assert.equal(result.userAgent, 'codex-app-server/0.149.1');
  await waitFor(
    () => fs.existsSync(log) && readJsonLines(log).length >= 2,
    'initialized notification did not reach the child transport'
  );
  const childPid = client.child.pid;
  await client.close();

  const wire = readJsonLines(log);
  assert.equal(wire[0].method, 'initialize');
  assert.equal(typeof wire[0].id === 'string' || Number.isSafeInteger(wire[0].id), true);
  assert.equal(typeof wire[0].params.clientInfo.name, 'string');
  assert.equal(typeof wire[0].params.clientInfo.version, 'string');
  assert.equal(
    wire[0].params.capabilities === null || (
      typeof wire[0].params.capabilities.experimentalApi === 'boolean'
      && typeof wire[0].params.capabilities.requestAttestation === 'boolean'
    ),
    true
  );
  assert.deepEqual(wire[1], { method: 'initialized' });
  assert.equal(processExists(childPid), false);
});

test('thread start, resume, list, and read use the 0.149.1 method and field contract', async t => {
  const directory = tempArea(t);
  const log = path.join(directory, 'wire.jsonl');
  const client = await makeClient(t, { fakeArgs: [`--log=${log}`] });
  await client.start();

  const started = await client.request('thread/start', {
    cwd: REPO_ROOT,
    model: 'gpt-5.6-sol',
    serviceTier: 'priority',
    approvalPolicy: 'on-request'
  });
  const resumed = await client.request('thread/resume', { threadId: THREAD_ID });
  const listed = await client.request('thread/list', { limit: 20, cwd: REPO_ROOT });
  const read = await client.request('thread/read', { threadId: THREAD_ID, includeTurns: true });

  assert.equal(started.thread.id, THREAD_ID);
  assert.equal(resumed.thread.id, THREAD_ID);
  assert.equal(resumed.thread.turns.length, 0);
  assert.deepEqual(listed.data.map(item => item.id), [THREAD_ID]);
  assert.equal(listed.nextCursor, null);
  assert.equal(read.thread.id, THREAD_ID);
  assert.equal(read.thread.turns.length, 0);

  await client.close();
  const calls = readJsonLines(log).filter(message => Object.hasOwn(message, 'id') && message.method);
  assert.deepEqual(calls.map(message => message.method), [
    'initialize', 'thread/start', 'thread/resume', 'thread/list', 'thread/read'
  ]);
  assert.equal(calls[1].params.serviceTier, 'priority');
  assert.deepEqual(calls[2].params, { threadId: THREAD_ID });
  assert.deepEqual(calls[4].params, { threadId: THREAD_ID, includeTurns: true });
});

test('greeting history and real image/PDF bytes use native App Server inputs', async t => {
  const directory = tempArea(t);
  const log = path.join(directory, 'native-attachments.jsonl');
  const notifications = [];
  const client = await makeClient(t, {
    fakeArgs: [`--log=${log}`],
    onNotification: (...args) => notifications.push(callbackMessage(args))
  });
  const { attachmentUserInput, extractThreadHistory, stageAttachment, validateUpload } = await library();
  const image = stageAttachment(directory, validateUpload({
    name: 'referencia.png',
    mime: 'image/png',
    data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64').toString('base64')
  }), { id: crypto.randomUUID() });
  const pdf = stageAttachment(directory, validateUpload({
    name: 'leccion.pdf',
    mime: 'application/pdf',
    data: Buffer.from('%PDF-1.7\nattachment product boundary\n%%EOF\n').toString('base64')
  }), { id: crypto.randomUUID() });
  const inputs = [
    { type: 'text', text: 'Hola, usa los dos archivos reales.', text_elements: [] },
    attachmentUserInput(image),
    attachmentUserInput(pdf)
  ];

  await client.start();
  await client.request('thread/start', { cwd: directory });
  await client.request('turn/start', { threadId: THREAD_ID, input: inputs });
  await waitFor(() => notifications.find(item => item.method === 'turn/completed'), 'greeting turn did not complete');
  const read = await client.request('thread/read', { threadId: THREAD_ID, includeTurns: true });
  const history = extractThreadHistory(read.thread);

  assert.deepEqual(inputs.map(item => item.type), ['text', 'localImage', 'mention']);
  assert.equal(inputs.some(item => item.type === 'text' && item.text.includes(pdf.path)), false);
  assert.equal(history.some(item => item.role === 'user' && item.text.includes('Hola')), true);
  assert.equal(history.some(item => item.role === 'assistant' && item.text === 'Cambio terminado.'), true);
  const turnStart = readJsonLines(log).find(item => item.method === 'turn/start');
  assert.deepEqual(turnStart.params.input.map(item => item.type), ['text', 'localImage', 'mention']);
  assert.equal(turnStart.params.input[2].name, 'leccion.pdf');
});

test('turn start streams typed notifications and interrupt stops a held turn', async t => {
  const notifications = [];
  const client = await makeClient(t, {
    fakeArgs: ['--hold-turn'],
    onNotification: (...args) => notifications.push(callbackMessage(args))
  });
  await client.start();

  const started = await client.request('turn/start', {
    threadId: THREAD_ID,
    input: [{ type: 'text', text: 'Cambia el t\u00edtulo', text_elements: [] }]
  });
  assert.equal(started.turn.id, TURN_ID);
  await waitFor(() => notifications.find(item => item.method === 'turn/started'), 'turn/started was not delivered');

  assert.deepEqual(await client.request('turn/interrupt', { threadId: THREAD_ID, turnId: TURN_ID }), {});
  const completed = await waitFor(
    () => notifications.find(item => item.method === 'turn/completed'),
    'interrupted turn/completed was not delivered'
  );
  assert.equal(completed.params.threadId, THREAD_ID);
  assert.equal(completed.params.turn.status, 'interrupted');
});

test('turn deltas, diff, failure, and reconnect remain tied to thread and turn IDs', async t => {
  const directory = tempArea(t);
  const marker = path.join(directory, 'disconnect.marker');
  const firstNotifications = [];
  const first = await makeClient(t, {
    fakeArgs: [`--disconnect-marker=${marker}`],
    onNotification: (...args) => firstNotifications.push(callbackMessage(args))
  });
  await first.start();
  await first.request('turn/start', {
    threadId: THREAD_ID,
    input: [{ type: 'text', text: 'Primera conexi\u00f3n', text_elements: [] }]
  });
  const delta = await waitFor(
    () => firstNotifications.find(item => item.method === 'item/agentMessage/delta'),
    'stream delta was not delivered before disconnect'
  );
  assert.equal(delta.params.threadId, THREAD_ID);
  assert.equal(delta.params.turnId, TURN_ID);
  assert.equal(delta.params.delta, 'Cambio terminado.');
  assert.equal((await waitFor(
    () => firstNotifications.find(item => item.method === 'turn/diff/updated'),
    'turn diff was not delivered before disconnect'
  )).params.diff.startsWith('diff --git '), true);
  await first.close();

  const resumedNotifications = [];
  const second = await makeClient(t, {
    fakeArgs: [`--disconnect-marker=${marker}`],
    onNotification: (...args) => resumedNotifications.push(callbackMessage(args))
  });
  await second.start();
  const resumed = await second.request('thread/resume', { threadId: THREAD_ID });
  const history = await second.request('thread/read', { threadId: THREAD_ID, includeTurns: true });
  assert.equal(resumed.thread.id, THREAD_ID);
  assert.equal(history.thread.turns[0].id, TURN_ID);

  const failedNotifications = [];
  const failing = await makeClient(t, {
    fakeArgs: ['--fail-turn'],
    onNotification: (...args) => failedNotifications.push(callbackMessage(args))
  });
  await failing.start();
  await failing.request('turn/start', {
    threadId: THREAD_ID,
    input: [{ type: 'text', text: 'Falla controlada', text_elements: [] }]
  });
  const error = await waitFor(() => failedNotifications.find(item => item.method === 'error'), 'error notification was not delivered');
  assert.equal(error.params.willRetry, false);
  const failed = await waitFor(
    () => failedNotifications.find(item => item.method === 'turn/completed'),
    'failed turn/completed was not delivered'
  );
  assert.equal(failed.params.turn.status, 'failed');
});

test('server approval requests fail closed unless the user explicitly accepts', async t => {
  const directory = tempArea(t);
  const deniedLog = path.join(directory, 'denied.jsonl');
  const deniedRequests = [];
  const deniedNotifications = [];
  const denied = await makeClient(t, {
    fakeArgs: ['--approval=command', `--log=${deniedLog}`],
    onNotification: (...args) => deniedNotifications.push(callbackMessage(args)),
    onServerRequest: async (...args) => {
      deniedRequests.push(callbackMessage(args));
      throw new Error('UI disconnected');
    }
  });
  await denied.start();
  await denied.request('turn/start', {
    threadId: THREAD_ID,
    input: [{ type: 'text', text: 'Prueba aprobaci\u00f3n', text_elements: [] }]
  });
  await waitFor(() => deniedNotifications.find(item => item.method === 'turn/completed'), 'closed approval did not finish');
  assert.equal(deniedRequests[0].method, 'item/commandExecution/requestApproval');
  await denied.close();
  const deniedRecord = readJsonLines(deniedLog).find(item => item.approvalResponse || item.approvalError);
  assert.equal(Boolean(deniedRecord), true);
  assert.equal(
    ['decline', 'cancel'].includes(deniedRecord.approvalResponse?.decision) || Number.isInteger(deniedRecord.approvalError?.code),
    true
  );

  const acceptedLog = path.join(directory, 'accepted.jsonl');
  const acceptedNotifications = [];
  const accepted = await makeClient(t, {
    fakeArgs: ['--approval=file', `--log=${acceptedLog}`],
    onNotification: (...args) => acceptedNotifications.push(callbackMessage(args)),
    onServerRequest: async (...args) => {
      const request = callbackMessage(args);
      assert.equal(request.method, 'item/fileChange/requestApproval');
      return { decision: 'accept' };
    }
  });
  await accepted.start();
  await accepted.request('turn/start', {
    threadId: THREAD_ID,
    input: [{ type: 'text', text: 'Cambio aprobado', text_elements: [] }]
  });
  const completed = await waitFor(
    () => acceptedNotifications.find(item => item.method === 'turn/completed'),
    'accepted approval did not resume the turn'
  );
  assert.equal(completed.params.turn.status, 'completed');
  await accepted.close();
  assert.equal(readJsonLines(acceptedLog).find(item => item.approvalResponse).approvalResponse.decision, 'accept');
});

test('protocol lifecycle, malformed output, errors, timeouts, and denied methods are explicit', async t => {
  const { HOST_ERROR_CODES } = await library();
  const client = await makeClient(t);
  await assert.rejects(
    client.request('thread/list', {}),
    error => error.code === HOST_ERROR_CODES.PROTOCOL_NOT_STARTED
  );
  await client.start();
  await assert.rejects(client.start(), error => error.code === HOST_ERROR_CODES.PROTOCOL_ALREADY_STARTED);

  const remoteError = await makeClient(t, { fakeArgs: ['--error=thread/read'] });
  await remoteError.start();
  await assert.rejects(
    remoteError.request('thread/read', { threadId: THREAD_ID }),
    error => error.code === HOST_ERROR_CODES.PROTOCOL_REQUEST_FAILED && error.details?.rpcCode === -32050
  );

  const timeout = await makeClient(t, { fakeArgs: ['--ignore=thread/read'] });
  await timeout.start();
  await assert.rejects(
    timeout.request('thread/read', { threadId: THREAD_ID }, { timeoutMs: 40 }),
    error => error.code === HOST_ERROR_CODES.PROTOCOL_TIMEOUT
  );

  const malformed = await makeClient(t, { fakeArgs: ['--invalid-json'] });
  await assert.rejects(malformed.start(), error => error.code === HOST_ERROR_CODES.PROTOCOL_INVALID_JSON);

  const closing = await makeClient(t, { fakeArgs: ['--ignore=thread/read'] });
  await closing.start();
  const pending = assert.rejects(
    closing.request('thread/read', { threadId: THREAD_ID }, { timeoutMs: 1000 }),
    error => error.code === HOST_ERROR_CODES.PROTOCOL_CLOSED
  );
  await closing.close();
  await pending;

  const deniedLog = path.join(tempArea(t), 'unknown-server-request.jsonl');
  const denied = await makeClient(t, { fakeArgs: ['--server-request=unknown', `--log=${deniedLog}`] });
  await denied.start();
  await denied.request('turn/start', {
    threadId: THREAD_ID,
    input: [{ type: 'text', text: 'Solicitud desconocida', text_elements: [] }]
  });
  await waitFor(
    () => fs.existsSync(deniedLog) && readJsonLines(deniedLog).some(item => item.approvalError),
    'unknown server request was not denied'
  );
  await denied.close();
  const protocolDenial = readJsonLines(deniedLog).find(item => item.approvalError).approvalError;
  assert.equal(protocolDenial.code, -32601);
});
