const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_ATTACHMENT_BYTES,
  MAX_TURN_ATTACHMENTS,
  cleanCompletionData,
  cleanReleaseResult,
  validateApprovalInput,
  validateAttachmentInput,
  validateJobInput,
  validateReleaseRequest,
  validateThreadRequest,
  validateTurnRequest
} = require('../api/_lib/code/validation');

const THREAD_ID = '01900000-0000-7000-8000-000000000001';
const TURN_ID = '01900000-0000-7000-8000-000000000002';
const JOB_ID = '01900000-0000-7000-8000-000000000003';
const CONVERSATION_ID = '01900000-0000-7000-8000-000000000004';
const APPROVAL_ID = '01900000-0000-7000-8000-000000000005';
const RELEASE_ID = '01900000-0000-7000-8000-000000000006';
const CLIENT_ID = '01900000-0000-7000-8000-000000000007';
const FINGERPRINT = 'a'.repeat(64);
const TOKEN = 'x'.repeat(43);

function encodedPdf(size = 32) {
  const data = Buffer.alloc(size);
  data.write('%PDF-1.7\n', 0, 'ascii');
  return data.toString('base64');
}

test('PUBLICAR in ordinary chat remains prompt text and cannot select the publish action', () => {
  const prompt = validateJobInput({
    action: 'prompt',
    prompt: 'PUBLICAR este cambio por favor',
    clientId: CLIENT_ID,
    conversationId: CONVERSATION_ID
  });
  assert.equal(prompt.action, 'prompt');
  assert.equal(prompt.prompt, 'PUBLICAR este cambio por favor');
  assert.equal('releaseId' in prompt, false);
  assert.throws(
    () => validateJobInput({ action: 'publish', prompt: 'PUBLICAR', clientId: CLIENT_ID, conversationId: CONVERSATION_ID }),
    error => error?.code === 'RELEASE_PREPARE_REQUIRED'
  );
});

test('the first hola turn is valid without a threadId and preserves the browser scope', () => {
  const turn = validateTurnRequest({
    operation: 'start',
    clientId: CLIENT_ID,
    conversationId: CONVERSATION_ID,
    prompt: 'hola',
    mode: 'edit'
  });

  assert.equal(turn.action, 'turn.start');
  assert.equal(turn.threadId, null);
  assert.equal(turn.clientId, CLIENT_ID);
  assert.equal(turn.conversationId, CONVERSATION_ID);
  assert.equal(turn.prompt, 'hola');
});

test('thread and turn request validation keeps browser scope, IDs, and attachment count bounded', () => {
  const read = validateThreadRequest({
    operation: 'read', threadId: THREAD_ID, clientId: CLIENT_ID, conversationId: CONVERSATION_ID
  });
  assert.equal(read.threadId, THREAD_ID);
  assert.equal(read.clientId, CLIENT_ID);
  assert.equal(read.conversationId, CONVERSATION_ID);
  assert.equal(validateThreadRequest({ operation: 'list', clientId: CLIENT_ID, limit: 999 }).limit, 50);
  assert.throws(
    () => validateThreadRequest({ operation: 'resume', threadId: '../other-thread', clientId: CLIENT_ID }),
    error => error?.code === 'INVALID_ID'
  );

  const attachmentIds = Array.from({ length: MAX_TURN_ATTACHMENTS }, (_, index) => `01900000-0000-7000-8000-${String(index + 10).padStart(12, '0')}`);
  const turn = validateTurnRequest({
    operation: 'start',
    threadId: THREAD_ID,
    clientId: CLIENT_ID,
    prompt: 'Usa los archivos',
    attachmentIds,
    conversationId: CONVERSATION_ID
  });
  assert.deepEqual(turn.attachmentIds, attachmentIds);
  assert.throws(
    () => validateTurnRequest({
      operation: 'start',
      threadId: THREAD_ID,
      clientId: CLIENT_ID,
      conversationId: CONVERSATION_ID,
      prompt: 'Demasiados',
      attachmentIds: [...attachmentIds, APPROVAL_ID]
    }),
    error => error?.code === 'UPLOAD_TOO_MANY'
  );
  assert.equal(validateTurnRequest({
    operation: 'interrupt', threadId: THREAD_ID, turnId: TURN_ID, jobId: JOB_ID, clientId: CLIENT_ID,
    conversationId: CONVERSATION_ID
  }).operation, 'interrupt');

  assert.throws(
    () => validateTurnRequest({
      operation: 'start', clientId: 'not-a-browser-uuid', conversationId: CONVERSATION_ID, prompt: 'hola'
    }),
    error => error?.code === 'INVALID_ID'
  );
});

test('browser attachment API accepts one real PDF at 3 MiB and rejects larger or spoofed bodies', () => {
  const maximum = encodedPdf(MAX_ATTACHMENT_BYTES);
  const accepted = validateAttachmentInput({
    clientId: CLIENT_ID,
    conversationId: CONVERSATION_ID,
    name: 'leccion.pdf',
    mime: 'application/pdf',
    data: maximum
  });
  assert.equal(accepted.size, 3 * 1024 * 1024);
  assert.equal(accepted.clientId, CLIENT_ID);
  assert.match(accepted.sha256, /^[a-f0-9]{64}$/);

  assert.throws(
    () => validateAttachmentInput({
      clientId: CLIENT_ID, conversationId: CONVERSATION_ID,
      name: 'grande.pdf', mime: 'application/pdf', data: encodedPdf(MAX_ATTACHMENT_BYTES + 1)
    }),
    error => error?.code === 'UPLOAD_INVALID' || error?.code === 'UPLOAD_TOO_LARGE'
  );
  assert.throws(
    () => validateAttachmentInput({
      clientId: CLIENT_ID, conversationId: CONVERSATION_ID,
      name: 'falso.pdf', mime: 'application/pdf', data: Buffer.from('MZ executable').toString('base64')
    }),
    error => error?.code === 'UPLOAD_SIGNATURE_INVALID'
  );
  assert.throws(
    () => validateAttachmentInput([
      { name: 'uno.pdf', mime: 'application/pdf', data: encodedPdf() },
      { name: 'dos.pdf', mime: 'application/pdf', data: encodedPdf() }
    ]),
    error => error?.code === 'UPLOAD_INVALID'
  );
});

test('browser approval payload cannot add session, network, command, or root capability', () => {
  const cleaned = validateApprovalInput({
    clientId: CLIENT_ID,
    conversationId: CONVERSATION_ID,
    jobId: JOB_ID,
    approvalId: APPROVAL_ID,
    decision: 'accept',
    grantRoot: 'C:\\outside',
    networkApprovalContext: { host: 'example.com' },
    proposedExecpolicyAmendment: { command: '*' },
    proposedNetworkPolicyAmendments: [{ host: '*' }],
    acceptForSession: true
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ['approvalId', 'clientId', 'conversationId', 'createdAt', 'decision', 'jobId']);
  assert.equal(cleaned.decision, 'accept');
  assert.throws(
    () => validateApprovalInput({
      clientId: CLIENT_ID, conversationId: CONVERSATION_ID,
      jobId: JOB_ID, approvalId: APPROVAL_ID, decision: 'acceptForSession'
    }),
    error => error?.code === 'APPROVAL_INVALID'
  );
});

test('legacy cancel route forwards browser and conversation scope instead of trusting a job ID', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../api/code/cancel.js'), 'utf8');
  assert.match(source, /\bclientId\b/);
  assert.match(source, /\bconversationId\b/);
  assert.doesNotMatch(source, /requestCancellation\(jobId\)/);
  assert.match(source, /requestCancellation\(jobId,\s*clientId,\s*conversationId\)/);
});

test('event polling requires browser and conversation scope and forwards both to storage', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../api/code/events.js'), 'utf8');
  assert.match(source, /requireUuid\(req\.query\.clientId,\s*['"]navegador['"]\)/);
  assert.match(source, /requireUuid\(req\.query\.conversationId,\s*['"]chat['"]\)/);
  assert.match(source, /jobState\(jobId,\s*after,\s*clientId,\s*conversationId\)/);
  assert.doesNotMatch(source, /jobState\(jobId,\s*after\s*\)/);
});

test('release HTTP validation enforces two exact phrases, nonces, and diff fingerprint', () => {
  const confirmed = validateReleaseRequest('confirm', {
    clientId: CLIENT_ID,
    conversationId: CONVERSATION_ID,
    releaseId: RELEASE_ID,
    fingerprint: FINGERPRINT,
    confirmationToken: TOKEN,
    confirmation: 'REVISADO'
  });
  assert.equal(confirmed.confirmation, 'REVISADO');
  assert.equal(confirmed.fingerprint, FINGERPRINT);

  const publish = validateReleaseRequest('publish', {
    clientId: CLIENT_ID,
    conversationId: CONVERSATION_ID,
    releaseId: RELEASE_ID,
    fingerprint: FINGERPRINT,
    publishToken: TOKEN,
    confirmation: 'PUBLICAR'
  });
  assert.equal(publish.confirmation, 'PUBLICAR');
  assert.equal(publish.publishToken, TOKEN);

  assert.throws(
    () => validateReleaseRequest('confirm', {
      clientId: CLIENT_ID, conversationId: CONVERSATION_ID,
      releaseId: RELEASE_ID, fingerprint: FINGERPRINT, confirmationToken: TOKEN, confirmation: 'PUBLICAR'
    }),
    error => error?.code === 'RELEASE_CONFIRMATION_INVALID'
  );
  assert.throws(
    () => validateReleaseRequest('publish', {
      clientId: CLIENT_ID, conversationId: CONVERSATION_ID,
      releaseId: RELEASE_ID, fingerprint: 'b'.repeat(64), publishToken: 'short', confirmation: 'PUBLICAR'
    }),
    error => error?.code === 'RELEASE_CONFIRMATION_INVALID'
  );
});

test('completion data strips cwd, rollout paths, local files, and full turn history', () => {
  const cleaned = cleanCompletionData({
    thread: {
      id: THREAD_ID,
      conversationId: CONVERSATION_ID,
      name: 'Cambio',
      status: 'idle',
      clientId: CLIENT_ID,
      cwd: 'C:\\private\\draft',
      path: 'C:\\private\\rollout.jsonl',
      turns: [{ id: TURN_ID, items: [{ path: 'C:\\private\\secret.txt' }] }]
    },
    turn: {
      id: TURN_ID,
      status: 'completed',
      items: [{ type: 'agentMessage', text: 'done', path: '/home/private/file' }]
    },
    history: [
      { role: 'user', text: 'hola', turnId: TURN_ID, cwd: 'C:\\private\\draft' },
      { role: 'assistant', text: 'Listo', path: '/home/private/file' }
    ]
  });
  assert.deepEqual(Object.keys(cleaned.thread).sort(), ['conversationId', 'createdAt', 'id', 'name', 'status', 'updatedAt']);
  assert.deepEqual(cleaned.turn, { id: TURN_ID, status: 'completed' });
  assert.deepEqual(cleaned.history, [
    { role: 'user', text: 'hola', turnId: TURN_ID },
    { role: 'assistant', text: 'Listo' }
  ]);
  const serialized = JSON.stringify(cleaned);
  assert.equal(serialized.includes('C:\\private'), false);
  assert.equal(serialized.includes('/home/'), false);
  assert.equal(serialized.includes(CLIENT_ID), false);
});

test('release result shares a safe readable diff and all three independent gate results', () => {
  const cleaned = cleanReleaseResult({
    releaseId: RELEASE_ID,
    stage: 'prepared',
    fingerprint: FINGERPRINT,
    confirmationToken: TOKEN,
    previewUrl: 'https://preview.example.test/release',
    diff: {
      sha256: FINGERPRINT,
      count: 2,
      totalBytes: 321,
      summary: '2 archivos cambiados',
      preview: '- texto anterior\n+ texto nuevo'
    },
    tests: {
      test: { ok: true },
      check: { ok: true },
      diffCheck: { ok: true }
    }
  });

  assert.deepEqual(cleaned.diff, {
    sha256: FINGERPRINT,
    count: 2,
    totalBytes: 321,
    summary: '2 archivos cambiados',
    preview: '- texto anterior\n+ texto nuevo'
  });
  assert.deepEqual(cleaned.tests, {
    test: { ok: true },
    check: { ok: true },
    diffCheck: { ok: true }
  });
  assert.equal(JSON.stringify(cleaned).includes('[object Object]'), false);

  const failed = cleanReleaseResult({
    releaseId: RELEASE_ID,
    diff: { sha256: FINGERPRINT, count: 1, summary: '1 archivo', preview: '+ cambio' },
    tests: { test: { ok: true }, check: { ok: true }, diffCheck: { ok: false } }
  });
  assert.equal(failed.tests.diffCheck.ok, false);
  assert.equal(failed.tests.test.ok && failed.tests.check.ok && failed.tests.diffCheck.ok, false);
});

test('ordinary edit completion preserves a sanitized review before release preparation', () => {
  const cleaned = cleanCompletionData({
    thread: { id: THREAD_ID, conversationId: CONVERSATION_ID, name: 'Cambio', status: 'idle' },
    turn: { id: TURN_ID, status: 'completed' },
    review: {
      diff: {
        sha256: FINGERPRINT,
        count: 1,
        totalBytes: 24,
        summary: 'M edit/edit.js',
        preview: '+ cambio seguro\nC:\\private\\draft\\secret.txt'
      },
      tests: {
        test: { ok: true },
        check: { ok: true },
        diffCheck: { ok: true }
      }
    }
  });

  assert.equal(cleaned.review.diff.sha256, FINGERPRINT);
  assert.equal(cleaned.review.diff.count, 1);
  assert.equal(cleaned.review.diff.summary, 'M edit/edit.js');
  assert.match(cleaned.review.diff.preview, /cambio seguro/);
  assert.equal(cleaned.review.diff.preview.includes('C:\\private'), false);
  assert.deepEqual(cleaned.review.tests, {
    test: { ok: true }, check: { ok: true }, diffCheck: { ok: true }
  });
  assert.equal('releaseId' in cleaned.review, false);
});
