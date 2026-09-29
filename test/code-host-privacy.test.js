const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIBRARY_URL = pathToFileURL(path.resolve(__dirname, '../scripts/code-host-lib.mjs')).href;
const THREAD_ID = '01900000-0000-7000-8000-000000000001';
const CONVERSATION_ID = '01900000-0000-7000-8000-000000000002';
const OTHER_CONVERSATION_ID = '01900000-0000-7000-8000-000000000005';
const CLIENT_A = '01900000-0000-7000-8000-000000000006';
const CLIENT_B = '01900000-0000-7000-8000-000000000007';

let libraryPromise;

function library() {
  libraryPromise ||= import(LIBRARY_URL);
  return libraryPromise;
}

function tempArea(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursos-code-privacy-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function commandRequest(workspaceRoot, overrides = {}) {
  return {
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: THREAD_ID,
      turnId: '01900000-0000-7000-8000-000000000003',
      itemId: '01900000-0000-7000-8000-000000000004',
      startedAtMs: 1_700_000_000_000,
      approvalId: null,
      environmentId: null,
      reason: null,
      networkApprovalContext: null,
      command: 'read lesson',
      cwd: workspaceRoot,
      commandActions: [{ type: 'read', command: 'read lesson', name: 'lesson', path: path.join(workspaceRoot, 'lesson.txt') }],
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
      ...overrides
    }
  };
}

test('thread registry isolates every list, read, resume, and turn lookup by opaque browser scope', async t => {
  const { HOST_ERROR_CODES, ThreadRegistry } = await library();
  const area = tempArea(t);
  const root = path.join(area, 'allowed');
  const workspace = path.join(root, 'draft');
  const outside = path.join(area, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const state = {
    threads: {
      'legacy-unscoped': {
        threadId: 'legacy-unscoped', conversationId: CONVERSATION_ID, workspace,
        name: 'Registro anterior sin navegador', status: 'idle'
      }
    }
  };
  const registry = new ThreadRegistry({ state, workspaceRoot: root });
  const registered = registry.register({
    threadId: THREAD_ID,
    conversationId: CONVERSATION_ID,
    clientId: CLIENT_A,
    workspace,
    name: 'Cambio de portada',
    status: 'idle'
  });
  assert.deepEqual(Object.keys(registered).sort(), ['conversationId', 'createdAt', 'id', 'name', 'status', 'updatedAt']);
  assert.equal(registered.id, THREAD_ID);

  const listed = registry.list(CLIENT_A);
  const read = registry.public(THREAD_ID, CLIENT_A, CONVERSATION_ID);
  assert.deepEqual(listed.map(item => item.id), [THREAD_ID]);
  for (const publicRecord of [...listed, read]) {
    const serialized = JSON.stringify(publicRecord);
    assert.equal(serialized.includes(workspace), false);
    assert.equal(serialized.includes(CLIENT_A), false);
    assert.equal(/"(?:clientId|cwd|path|workspace)"\s*:/.test(serialized), false);
  }

  assert.deepEqual(registry.list(CLIENT_B), []);
  for (const lookup of [
    () => registry.require(THREAD_ID, CLIENT_B),
    () => registry.public(THREAD_ID, CLIENT_B),
    () => registry.require(THREAD_ID, CLIENT_A, OTHER_CONVERSATION_ID),
    () => registry.public('legacy-unscoped', CLIENT_A)
  ]) {
    assert.throws(lookup, error => error?.code === HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED);
  }
  assert.throws(
    () => registry.public('unregistered-thread', CLIENT_A),
    error => error?.code === HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED
  );
  assert.throws(
    () => registry.register({
      threadId: THREAD_ID,
      conversationId: CONVERSATION_ID,
      clientId: CLIENT_B,
      workspace
    }),
    error => error?.code === HOST_ERROR_CODES.PROTOCOL_METHOD_DENIED
  );
  assert.throws(
    () => registry.register({
      threadId: 'outside-thread',
      conversationId: CONVERSATION_ID,
      clientId: CLIENT_A,
      workspace: outside
    }),
    error => error?.code === HOST_ERROR_CODES.PATH_OUTSIDE_WORKSPACE
  );
  assert.throws(
    () => registry.register({
      threadId: 'invalid-client', conversationId: CONVERSATION_ID,
      clientId: 'browser-A', workspace
    }),
    error => error?.code === HOST_ERROR_CODES.PROTOCOL_INVALID_MESSAGE
  );
});

test('local path redaction removes Windows, macOS, Linux, and configured roots', async () => {
  const { redactLocalPaths } = await library();
  const configured = 'D:\\private\\Cursos\\draft';
  const source = [
    `Cambios en ${configured}\\edit\\edit.js`,
    'Le\u00ed C:\\Users\\miguel\\secret\\notes.txt',
    'Le\u00ed /Users/miguel/private/notes.txt',
    'Le\u00ed /home/miguel/private/notes.txt'
  ].join('\n');
  const redacted = redactLocalPaths(source, [configured]);

  assert.equal(redacted.includes(configured), false);
  assert.equal(redacted.includes('C:\\Users\\'), false);
  assert.equal(redacted.includes('/Users/'), false);
  assert.equal(redacted.includes('/home/'), false);
  assert.match(redacted, /\[local path\]/);
});

test('browser command approval is limited to read, list, and search inside one workspace', async t => {
  const { evaluateApprovalRequest } = await library();
  const area = tempArea(t);
  const workspace = path.join(area, 'draft');
  const outside = path.join(area, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'lesson.txt'), 'safe\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');

  const allowed = evaluateApprovalRequest(commandRequest(workspace), { workspaceRoot: workspace });
  assert.equal(allowed.browserMayAccept, true);
  assert.deepEqual(allowed.decisions, ['accept', 'decline', 'cancel']);
  assert.equal(allowed.decisions.includes('acceptForSession'), false);

  const denials = [
    commandRequest(workspace, { commandActions: [] }),
    commandRequest(workspace, { commandActions: [{ type: 'unknown', command: 'rm -rf .' }] }),
    commandRequest(workspace, {
      commandActions: [{ type: 'read', command: 'read secret', name: 'secret', path: path.join(outside, 'secret.txt') }]
    }),
    commandRequest(workspace, { cwd: outside }),
    commandRequest(workspace, { networkApprovalContext: { host: 'example.com' } }),
    commandRequest(workspace, { proposedExecpolicyAmendment: { command: 'anything' } }),
    commandRequest(workspace, { proposedNetworkPolicyAmendments: [{ host: 'example.com' }] })
  ];
  for (const request of denials) {
    assert.equal(evaluateApprovalRequest(request, { workspaceRoot: workspace }).browserMayAccept, false);
  }
});

test('browser file approval cannot grant roots and unsupported capabilities are always denied', async t => {
  const { evaluateApprovalRequest } = await library();
  const workspace = tempArea(t);
  const base = {
    id: 'approval-file',
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: THREAD_ID,
      turnId: '01900000-0000-7000-8000-000000000003',
      itemId: '01900000-0000-7000-8000-000000000004',
      startedAtMs: 1_700_000_000_000,
      reason: null,
      grantRoot: null
    }
  };
  assert.equal(evaluateApprovalRequest(base, { workspaceRoot: workspace }).browserMayAccept, true);
  assert.equal(evaluateApprovalRequest({
    ...base,
    params: { ...base.params, grantRoot: workspace }
  }, { workspaceRoot: workspace }).browserMayAccept, false);

  for (const method of ['item/permissions/requestApproval', 'execCommandApproval', 'unknown/request']) {
    const result = evaluateApprovalRequest({ method, id: 'unsupported', params: {} }, { workspaceRoot: workspace });
    assert.equal(result.browserMayAccept, false);
    assert.equal(result.decisions.includes('accept'), false);
  }
});
