const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIBRARY_URL = pathToFileURL(path.resolve(__dirname, '../scripts/code-host-lib.mjs')).href;
const BASE_COMMIT = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);
const OTHER_FINGERPRINT = 'c'.repeat(64);

let libraryPromise;

function library() {
  libraryPromise ||= import(LIBRARY_URL);
  return libraryPromise;
}

function evidence(overrides = {}) {
  return {
    baseCommit: BASE_COMMIT,
    fingerprint: FINGERPRINT,
    paths: ['edit/edit.js', 'edit/index.html'],
    diff: {
      sha256: FINGERPRINT,
      files: ['edit/edit.js', 'edit/index.html'],
      count: 2,
      totalBytes: 2048,
      summary: '2 files changed',
      preview: '- texto anterior\n+ texto nuevo'
    },
    tests: {
      test: { ok: true },
      check: { ok: true },
      diffCheck: { ok: true }
    },
    previewUrl: 'https://cursos-preview.example.test',
    ...overrides
  };
}

async function gateFixture({ ttlMs = 60_000 } = {}) {
  const { ReleaseGate } = await library();
  const state = {};
  const saves = [];
  let now = 1_700_000_000_000;
  let nonce = 0;
  const gate = new ReleaseGate({
    state,
    ttlMs,
    now: () => now,
    randomBytes: size => Buffer.alloc(size, ++nonce),
    saveState: async () => saves.push(JSON.parse(JSON.stringify(state.releaseGate)))
  });
  return { gate, state, saves, advance: milliseconds => { now += milliseconds; } };
}

function rejectsCode(promise, code) {
  return assert.rejects(promise, error => error?.code === code);
}

test('release requires passing test, check, diff check, a bound diff, and HTTPS preview', async () => {
  const { HOST_ERROR_CODES } = await library();
  const cases = [
    evidence({ tests: { test: { ok: false }, check: { ok: true }, diffCheck: { ok: true } } }),
    evidence({ tests: { test: { ok: true }, check: { ok: false }, diffCheck: { ok: true } } }),
    evidence({ tests: { test: { ok: true }, check: { ok: true }, diffCheck: { ok: false } } }),
    evidence({ tests: {} }),
    evidence({ diff: {} }),
    evidence({ diff: { ...evidence().diff, sha256: OTHER_FINGERPRINT } }),
    evidence({ previewUrl: null }),
    evidence({ previewUrl: 'http://insecure.example.test' })
  ];

  for (const input of cases) {
    const { gate, state } = await gateFixture();
    await rejectsCode(gate.prepare(input), HOST_ERROR_CODES.RELEASE_PREPARE_REQUIRED);
    assert.equal(state.releaseGate, undefined);
  }
});

test('release uses two distinct explicit confirmations bound to the same diff fingerprint', async () => {
  const { gate, state, saves } = await gateFixture();
  const prepared = await gate.prepare(evidence());
  assert.equal(prepared.stage, 'prepared');
  assert.equal(prepared.diff.sha256, FINGERPRINT);
  assert.equal(prepared.diff.preview, '- texto anterior\n+ texto nuevo');
  assert.equal(prepared.tests.test.ok, true);
  assert.equal(prepared.tests.check.ok, true);
  assert.equal(prepared.tests.diffCheck.ok, true);
  assert.match(prepared.previewUrl, /^https:\/\//);
  assert.equal(typeof prepared.confirmationToken, 'string');
  assert.equal(prepared.confirmationToken.length >= 32, true);

  const confirmed = await gate.confirm({
    releaseId: prepared.releaseId,
    confirmationToken: prepared.confirmationToken,
    confirmation: 'REVISADO',
    fingerprint: FINGERPRINT
  });
  assert.equal(confirmed.stage, 'confirmed');
  assert.equal(typeof confirmed.publishToken, 'string');
  assert.notEqual(confirmed.publishToken, prepared.confirmationToken);

  const consumed = await gate.consume({
    releaseId: prepared.releaseId,
    publishToken: confirmed.publishToken,
    confirmation: 'PUBLICAR',
    fingerprint: FINGERPRINT
  });
  assert.equal(consumed.stage, 'consumed');
  assert.equal(consumed.fingerprint, FINGERPRINT);
  assert.equal(consumed.diff.sha256, FINGERPRINT);
  assert.equal(state.releaseGate.stage, 'consumed');
  assert.deepEqual(saves.map(item => item.stage), ['prepared', 'confirmed', 'consumed']);
});

test('chat text saying PUBLICAR cannot count as either release confirmation', async () => {
  const { HOST_ERROR_CODES } = await library();
  const { gate, state } = await gateFixture();
  const prepared = await gate.prepare(evidence());

  await rejectsCode(gate.confirm({
    releaseId: prepared.releaseId,
    confirmationToken: prepared.confirmationToken,
    confirmation: 'PUBLICAR',
    fingerprint: FINGERPRINT,
    source: 'chat'
  }), HOST_ERROR_CODES.RELEASE_CONFIRMATION_INVALID);
  assert.equal(state.releaseGate.stage, 'prepared');

  await rejectsCode(gate.consume({
    releaseId: prepared.releaseId,
    publishToken: 'PUBLICAR escrito en el chat',
    confirmation: 'PUBLICAR',
    fingerprint: FINGERPRINT
  }), HOST_ERROR_CODES.RELEASE_CONFIRMATION_INVALID);
  assert.equal(state.releaseGate.stage, 'prepared');
});

test('wrong nonce, phrase, release ID, or changed diff fingerprint never advances state', async () => {
  const { HOST_ERROR_CODES } = await library();
  const { gate, state } = await gateFixture();
  const prepared = await gate.prepare(evidence());
  const invalidFirst = [
    { releaseId: prepared.releaseId, confirmationToken: 'wrong', confirmation: 'REVISADO', fingerprint: FINGERPRINT },
    { releaseId: prepared.releaseId, confirmationToken: prepared.confirmationToken, confirmation: 'Revisado', fingerprint: FINGERPRINT },
    { releaseId: 'different-release', confirmationToken: prepared.confirmationToken, confirmation: 'REVISADO', fingerprint: FINGERPRINT },
    { releaseId: prepared.releaseId, confirmationToken: prepared.confirmationToken, confirmation: 'REVISADO', fingerprint: OTHER_FINGERPRINT }
  ];
  for (const input of invalidFirst) {
    await rejectsCode(gate.confirm(input), HOST_ERROR_CODES.RELEASE_CONFIRMATION_INVALID);
    assert.equal(state.releaseGate.stage, 'prepared');
  }

  const confirmed = await gate.confirm({
    releaseId: prepared.releaseId,
    confirmationToken: prepared.confirmationToken,
    confirmation: 'REVISADO',
    fingerprint: FINGERPRINT
  });
  const invalidFinal = [
    { releaseId: prepared.releaseId, publishToken: 'wrong', confirmation: 'PUBLICAR', fingerprint: FINGERPRINT },
    { releaseId: prepared.releaseId, publishToken: confirmed.publishToken, confirmation: 'publicar', fingerprint: FINGERPRINT },
    { releaseId: prepared.releaseId, publishToken: confirmed.publishToken, confirmation: 'PUBLICAR', fingerprint: OTHER_FINGERPRINT }
  ];
  for (const input of invalidFinal) {
    await rejectsCode(gate.consume(input), HOST_ERROR_CODES.RELEASE_CONFIRMATION_INVALID);
    assert.equal(state.releaseGate.stage, 'confirmed');
  }
});

test('both confirmation stages expire and a consumed token is single-use', async () => {
  const { HOST_ERROR_CODES } = await library();

  const first = await gateFixture({ ttlMs: 100 });
  const firstPrepared = await first.gate.prepare(evidence());
  first.advance(101);
  await rejectsCode(first.gate.confirm({
    releaseId: firstPrepared.releaseId,
    confirmationToken: firstPrepared.confirmationToken,
    confirmation: 'REVISADO',
    fingerprint: FINGERPRINT
  }), HOST_ERROR_CODES.RELEASE_CONFIRMATION_EXPIRED);

  const second = await gateFixture({ ttlMs: 100 });
  const secondPrepared = await second.gate.prepare(evidence());
  const secondConfirmed = await second.gate.confirm({
    releaseId: secondPrepared.releaseId,
    confirmationToken: secondPrepared.confirmationToken,
    confirmation: 'REVISADO',
    fingerprint: FINGERPRINT
  });
  second.advance(101);
  await rejectsCode(second.gate.consume({
    releaseId: secondPrepared.releaseId,
    publishToken: secondConfirmed.publishToken,
    confirmation: 'PUBLICAR',
    fingerprint: FINGERPRINT
  }), HOST_ERROR_CODES.RELEASE_CONFIRMATION_EXPIRED);

  const third = await gateFixture();
  const thirdPrepared = await third.gate.prepare(evidence());
  const thirdConfirmed = await third.gate.confirm({
    releaseId: thirdPrepared.releaseId,
    confirmationToken: thirdPrepared.confirmationToken,
    confirmation: 'REVISADO',
    fingerprint: FINGERPRINT
  });
  const finalInput = {
    releaseId: thirdPrepared.releaseId,
    publishToken: thirdConfirmed.publishToken,
    confirmation: 'PUBLICAR',
    fingerprint: FINGERPRINT
  };
  await third.gate.consume(finalInput);
  await rejectsCode(third.gate.consume(finalInput), HOST_ERROR_CODES.RELEASE_ALREADY_USED);
});
