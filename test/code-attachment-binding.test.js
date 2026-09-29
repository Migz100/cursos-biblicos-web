const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const {
  validateApprovalInput,
  validateAttachmentInput,
  validateTurnRequest
} = require('../api/_lib/code/validation');

const CLIENT_A = '01900000-0000-7000-8000-000000000011';
const CLIENT_B = '01900000-0000-7000-8000-000000000012';
const CONVERSATION_A = '01900000-0000-7000-8000-000000000013';
const CONVERSATION_B = '01900000-0000-7000-8000-000000000014';
const THREAD_ID = '01900000-0000-7000-8000-000000000015';
const TURN_ID = '01900000-0000-7000-8000-000000000016';
const APPROVAL_ID = '01900000-0000-7000-8000-000000000017';

function pdfBase64() {
  return Buffer.from('%PDF-1.7\nattachment contract\n%%EOF\n').toString('base64');
}

function memoryStorageHarness(t) {
  const records = new Map();
  const byUrl = new Map();
  const storagePath = require.resolve('../api/_lib/code/storage');
  const originalLoad = Module._load;
  const originalFetch = global.fetch;

  const metadata = pathname => ({
    pathname,
    url: `memory://blob/${encodeURIComponent(pathname)}`,
    etag: `etag-${records.size}`,
    uploadedAt: new Date('2026-08-29T00:00:00.000Z')
  });
  const blobApi = {
    async put(pathname, body) {
      const blob = metadata(pathname);
      records.set(pathname, String(body));
      byUrl.set(blob.url, String(body));
      return blob;
    },
    async head(pathname) {
      if (!records.has(pathname)) throw new Error('not found');
      return metadata(pathname);
    },
    async list({ prefix = '' } = {}) {
      return {
        blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(metadata),
        hasMore: false,
        cursor: undefined
      };
    },
    async del(pathname) {
      const blob = metadata(pathname);
      records.delete(pathname);
      byUrl.delete(blob.url);
    }
  };
  const security = {
    seal(value, purpose) {
      return JSON.stringify({ purpose, value });
    },
    open(value, purpose) {
      const envelope = JSON.parse(value);
      if (envelope.purpose !== purpose) throw new Error('purpose mismatch');
      return envelope.value;
    }
  };

  Module._load = function loadWithMemoryBlob(request, parent, isMain) {
    if (request === '@vercel/blob') return blobApi;
    if (request === './security' && parent?.filename === storagePath) return security;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[storagePath];
  let storage;
  try {
    storage = require(storagePath);
  } finally {
    Module._load = originalLoad;
  }

  global.fetch = async input => {
    const url = String(input).split('?')[0];
    return {
      ok: byUrl.has(url),
      async text() { return byUrl.get(url) || ''; }
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
    delete require.cache[storagePath];
  });
  return storage;
}

test('an upload and turn bind only when browser and conversation scopes are identical', async t => {
  const { bindJobAttachments, storeAttachment } = memoryStorageHarness(t);
  const attachment = validateAttachmentInput({
    clientId: CLIENT_A,
    conversationId: CONVERSATION_A,
    name: 'leccion.pdf',
    mime: 'application/pdf',
    data: pdfBase64()
  });
  const stored = await storeAttachment(attachment);
  assert.equal(stored.conversationId, CONVERSATION_A);

  const turn = validateTurnRequest({
    operation: 'start',
    clientId: CLIENT_A,
    conversationId: CONVERSATION_A,
    prompt: 'Usa este archivo',
    attachmentIds: [stored.attachmentId]
  });
  const bound = await bindJobAttachments(turn);
  assert.equal(bound.clientId, CLIENT_A);
  assert.equal(bound.conversationId, CONVERSATION_A);
  assert.equal(bound.attachmentIds, undefined);
  assert.deepEqual(bound.attachments.map(item => item.id), [stored.attachmentId]);

  await assert.rejects(
    bindJobAttachments(validateTurnRequest({
      operation: 'start', clientId: CLIENT_B, conversationId: CONVERSATION_A,
      prompt: 'No debe cruzar navegadores', attachmentIds: [stored.attachmentId]
    })),
    error => /^UPLOAD_(?:CLIENT|SCOPE|CONVERSATION)_MISMATCH$/.test(String(error?.code || ''))
  );
  await assert.rejects(
    bindJobAttachments(validateTurnRequest({
      operation: 'start', clientId: CLIENT_A, conversationId: CONVERSATION_B,
      prompt: 'No debe cruzar chats', attachmentIds: [stored.attachmentId]
    })),
    error => error?.code === 'UPLOAD_CONVERSATION_MISMATCH'
  );
});

test('the encrypted queue rejects the 21st global pending job before it is stored', async t => {
  const { enqueueJob } = memoryStorageHarness(t);
  for (let index = 0; index < 20; index += 1) {
    await enqueueJob(validateTurnRequest({
      operation: 'start',
      clientId: `01900000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`,
      conversationId: CONVERSATION_A,
      prompt: `trabajo pendiente ${index}`
    }));
  }

  await assert.rejects(
    enqueueJob(validateTurnRequest({
      operation: 'start',
      clientId: '01900000-0000-7000-8000-000000000999',
      conversationId: CONVERSATION_A,
      prompt: 'este trabajo debe esperar'
    })),
    error => error?.status === 503 && error?.code === 'CODE_QUEUE_FULL'
  );
});

test('one browser cannot hold more than one active or pending expensive job', async t => {
  const { enqueueJob } = memoryStorageHarness(t);
  await enqueueJob(validateTurnRequest({
    operation: 'start', clientId: CLIENT_A, conversationId: CONVERSATION_A, prompt: 'primero'
  }));
  await assert.rejects(
    enqueueJob(validateTurnRequest({
      operation: 'start', clientId: CLIENT_A, conversationId: CONVERSATION_B, prompt: 'segundo'
    })),
    error => error?.status === 409 && error?.code === 'CODE_CLIENT_BUSY'
  );
  await enqueueJob(validateTurnRequest({
    operation: 'start', clientId: CLIENT_B, conversationId: CONVERSATION_B, prompt: 'otro navegador'
  }));
});

test('leaked IDs cannot let browser B approve, control, or cancel browser A jobs', async t => {
  const {
    approvalDecision,
    cancellationRequested,
    claimNextJob,
    enqueueJob,
    readControls,
    requestCancellation,
    submitApproval,
    submitControl
  } = memoryStorageHarness(t);
  const queued = await enqueueJob(validateTurnRequest({
    operation: 'start',
    clientId: CLIENT_A,
    conversationId: CONVERSATION_A,
    prompt: 'trabajo privado del navegador A'
  }));
  const claimed = await claimNextJob('host-scope-test');
  assert.equal(claimed.id, queued.id);

  const approvalFor = clientId => validateApprovalInput({
    clientId,
    conversationId: CONVERSATION_A,
    jobId: queued.id,
    approvalId: APPROVAL_ID,
    decision: 'accept'
  });
  await assert.rejects(submitApproval(approvalFor(CLIENT_B)), error => error?.status === 404);
  await submitApproval(approvalFor(CLIENT_A));
  await assert.rejects(
    submitApproval(approvalFor(CLIENT_A)),
    error => error?.status === 409 && error?.code === 'APPROVAL_ALREADY_RESOLVED'
  );
  const hostApproval = await approvalDecision(queued.id, 'host-scope-test', claimed.leaseToken, APPROVAL_ID);
  assert.equal(hostApproval.clientId, CLIENT_A);
  assert.equal(hostApproval.conversationId, CONVERSATION_A);

  const controlFor = clientId => validateTurnRequest({
    operation: 'interrupt',
    clientId,
    conversationId: CONVERSATION_A,
    jobId: queued.id,
    threadId: THREAD_ID,
    turnId: TURN_ID
  });
  await assert.rejects(submitControl(controlFor(CLIENT_B)), error => error?.status === 404);
  await submitControl(controlFor(CLIENT_A));
  const hostControls = await readControls(queued.id, 'host-scope-test', claimed.leaseToken);
  assert.equal(hostControls.controls.length, 1);
  assert.equal(hostControls.controls[0].clientId, CLIENT_A);
  assert.equal(hostControls.controls[0].conversationId, CONVERSATION_A);

  await assert.rejects(
    requestCancellation(queued.id, CLIENT_B, CONVERSATION_A),
    error => error?.status === 404
  );
  assert.equal(await cancellationRequested(queued.id, 'host-scope-test', claimed.leaseToken), false);
  await requestCancellation(queued.id, CLIENT_A, CONVERSATION_A);
  assert.equal(await cancellationRequested(queued.id, 'host-scope-test', claimed.leaseToken), true);
});

test('event polling stays scoped after completion removes the pending queue record', async t => {
  const {
    appendEvents,
    claimNextJob,
    completeClaimedJob,
    enqueueJob,
    jobState
  } = memoryStorageHarness(t);
  const queued = await enqueueJob(validateTurnRequest({
    operation: 'start',
    clientId: CLIENT_A,
    conversationId: CONVERSATION_A,
    prompt: 'evento privado del navegador A'
  }));
  const claimed = await claimNextJob('host-events-test');
  await appendEvents(queued.id, 'host-events-test', claimed.leaseToken, [{
    seq: 1,
    type: 'status',
    text: 'trabajando'
  }]);

  await assert.rejects(
    jobState(queued.id, 0, CLIENT_B, CONVERSATION_A),
    error => error?.status === 404 && error?.code === 'JOB_NOT_FOUND'
  );
  await assert.rejects(
    jobState(queued.id, 0, CLIENT_A, CONVERSATION_B),
    error => error?.status === 404 && error?.code === 'JOB_NOT_FOUND'
  );
  assert.deepEqual((await jobState(queued.id, 0, CLIENT_A, CONVERSATION_A)).events, [{
    seq: 1,
    type: 'status',
    text: 'trabajando'
  }]);

  await completeClaimedJob(queued.id, 'host-events-test', claimed.leaseToken, {
    status: 'completed',
    data: { message: 'listo' }
  });
  await assert.rejects(
    jobState(queued.id, 0, CLIENT_B, CONVERSATION_A),
    error => error?.status === 404 && error?.code === 'JOB_NOT_FOUND'
  );
  const completed = await jobState(queued.id, 0, CLIENT_A, CONVERSATION_A);
  assert.equal(completed.done.status, 'completed');
  assert.equal(completed.done.clientId, CLIENT_A);
  assert.equal(completed.done.conversationId, CONVERSATION_A);
  assert.equal(JSON.stringify(completed).includes(CLIENT_B), false);
});
