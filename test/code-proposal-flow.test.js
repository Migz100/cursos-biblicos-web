const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIBRARY_URL = pathToFileURL(path.resolve(__dirname, '../scripts/code-host-lib.mjs')).href;

function tempArea(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursos-proposal-flow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function snapshot(root) {
  const result = new Map();
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) {
        const data = fs.readFileSync(absolute);
        result.set(relative, {
          type: 'file',
          hash: crypto.createHash('sha256').update(data).digest('hex'),
          size: data.length
        });
      }
    }
  };
  walk(root);
  return result;
}

function changesBetween(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].sort().filter(name => {
    const left = before.get(name);
    const right = after.get(name);
    return !left || !right || left.type !== right.type || left.hash !== right.hash;
  }).map(filename => ({ filename, before: before.get(filename) || null, after: after.get(filename) || null }));
}

test('one-file proposal stays isolated, rejects safely, applies once, and never changes the canonical project', async t => {
  const { HOST_ERROR_CODES, OneFileProposalGate, applyWorkspaceChanges } = await import(LIBRARY_URL);
  const root = tempArea(t);
  const canonical = path.join(root, 'canonical');
  const persistent = path.join(root, 'persistent');
  const proposal = path.join(root, 'proposal');
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, 'lesson.css'), '.lesson { font-size: 16px; }\n');
  fs.writeFileSync(path.join(canonical, 'unchanged.txt'), 'keep\n');
  copyTree(canonical, persistent);
  copyTree(persistent, proposal);
  fs.writeFileSync(path.join(proposal, 'lesson.css'), '.lesson { font-size: 20px; }\n');

  const canonicalBefore = snapshot(canonical);
  const persistentBefore = snapshot(persistent);
  const proposedAfter = snapshot(proposal);
  const changes = changesBetween(persistentBefore, proposedAfter);
  assert.deepEqual(changes.map(item => item.filename), ['lesson.css']);

  const rejected = new OneFileProposalGate({
    approvalId: crypto.randomUUID(),
    changes,
    persistentBefore,
    proposedAfter,
    snapshotPersistent: () => snapshot(persistent),
    apply: approved => applyWorkspaceChanges(persistent, proposal, approved)
  });
  assert.equal(fs.readFileSync(path.join(persistent, 'lesson.css'), 'utf8').includes('16px'), true);
  assert.deepEqual(await rejected.resolve('decline'), {
    approvalId: rejected.approvalId,
    decision: 'decline',
    applied: false,
    filename: 'lesson.css'
  });
  assert.deepEqual(snapshot(persistent), persistentBefore);
  await assert.rejects(
    rejected.resolve('accept'),
    error => error.code === HOST_ERROR_CODES.APPROVAL_ALREADY_RESOLVED
  );

  const accepted = new OneFileProposalGate({
    approvalId: crypto.randomUUID(),
    changes,
    persistentBefore,
    proposedAfter,
    snapshotPersistent: () => snapshot(persistent),
    apply: approved => applyWorkspaceChanges(persistent, proposal, approved)
  });
  const result = await accepted.resolve('accept');
  assert.equal(result.applied, true);
  assert.equal(result.filename, 'lesson.css');
  assert.deepEqual(snapshot(persistent), proposedAfter);
  assert.deepEqual(snapshot(canonical), canonicalBefore);
  assert.equal(fs.readFileSync(path.join(persistent, 'unchanged.txt'), 'utf8'), 'keep\n');
  assert.equal('published' in result, false);
  await assert.rejects(
    accepted.resolve('accept'),
    error => error.code === HOST_ERROR_CODES.APPROVAL_ALREADY_RESOLVED
  );
});

test('a proposal that changes a second file is rejected before any apply callback runs', async t => {
  const { HOST_ERROR_CODES, OneFileProposalGate } = await import(LIBRARY_URL);
  const root = tempArea(t);
  const persistent = path.join(root, 'persistent');
  const proposal = path.join(root, 'proposal');
  fs.mkdirSync(persistent, { recursive: true });
  fs.writeFileSync(path.join(persistent, 'lesson.css'), '16px\n');
  fs.writeFileSync(path.join(persistent, 'other.txt'), 'original\n');
  copyTree(persistent, proposal);
  fs.writeFileSync(path.join(proposal, 'lesson.css'), '20px\n');
  fs.writeFileSync(path.join(proposal, 'other.txt'), 'changed\n');
  const persistentBefore = snapshot(persistent);
  const proposedAfter = snapshot(proposal);
  let applyCalls = 0;

  assert.throws(() => new OneFileProposalGate({
    approvalId: crypto.randomUUID(),
    changes: changesBetween(persistentBefore, proposedAfter),
    persistentBefore,
    proposedAfter,
    snapshotPersistent: () => snapshot(persistent),
    apply: () => { applyCalls += 1; }
  }), error => error.code === HOST_ERROR_CODES.PROPOSAL_FILE_COUNT);
  assert.equal(applyCalls, 0);
  assert.deepEqual(snapshot(persistent), persistentBefore);
});
