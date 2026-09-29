const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function source(relative) {
  return fs.readFileSync(path.join(repoRoot, ...relative.split('/')), 'utf8');
}

function functionBlock(text, name, length = 1800) {
  const index = text.indexOf(`function ${name}(`);
  assert.notEqual(index, -1, `missing ${name}`);
  return text.slice(index, index + length);
}

test('every job-producing browser endpoint consumes the shared code-jobs rate scope', () => {
  const routes = [
    'api/code/message.js',
    'api/code/threads.js',
    'api/code/turns.js',
    'api/code/release/prepare.js',
    'api/code/release/confirm.js',
    'api/code/release/publish.js'
  ];

  for (const route of routes) {
    const text = source(route);
    assert.match(text, /require\(['"](?:\.\.\/)+_lib\/cms\/storage['"]\)/, `${route} does not import rate enforcement`);
    assert.match(text, /require\(['"](?:\.\.\/)+_lib\/code\/limits['"]\)/, `${route} bypasses the shared job limits`);
    assert.match(text, /\benforceRate\s*\(/, `${route} does not call enforceRate`);
    assert.match(
      text,
      /enforceRate\(req,\s*['"]code-jobs['"],[\s\S]{0,200}CODE_JOB_VISITOR_LIMIT,\s*CODE_JOB_GLOBAL_LIMIT\)/,
      `${route} uses a bypass rate scope or limit`
    );
    const rateIndex = text.indexOf('enforceRate(');
    const enqueueIndex = text.indexOf('enqueueJob(');
    assert.ok(rateIndex >= 0 && enqueueIndex >= 0 && rateIndex < enqueueIndex, `${route} enqueues before rate enforcement`);
  }

  const limits = source('api/_lib/code/limits.js');
  assert.match(limits, /CODE_JOB_VISITOR_LIMIT\s*=\s*Object\.freeze\(\{[^}]*count:\s*30\b[^}]*windowMs:\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000[^}]*\}\)/);
  assert.match(limits, /CODE_JOB_GLOBAL_LIMIT\s*=\s*Object\.freeze\(\{[^}]*count:\s*80\b[^}]*windowMs:\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000[^}]*\}\)/);
});

test('the encrypted pending queue has a finite fail-closed backlog cap before writing', () => {
  const storage = source('api/_lib/code/storage.js');
  const enqueue = functionBlock(storage, 'enqueueJob');
  assert.match(storage, /const MAX_PENDING_JOBS\s*=\s*20\b/);
  assert.match(storage, /const MAX_PENDING_JOBS_PER_CLIENT\s*=\s*1\b/);
  assert.match(enqueue, /listAll\(\{\s*prefix:\s*`\$\{root\(\)\}jobs\/pending\/`\s*\}\)/);
  assert.match(enqueue, /pending\w*\.length\s*>=\s*MAX_PENDING_JOBS/);
  assert.match(enqueue, /CODE_QUEUE_FULL/);
  assert.match(enqueue, /CODE_CLIENT_BUSY/);
  assert.ok(enqueue.indexOf('CODE_QUEUE_FULL') < enqueue.indexOf('putEncrypted('), 'queue write happens before backlog rejection');
});
