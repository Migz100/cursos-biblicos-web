const { del, head, list, put } = require('@vercel/blob');
const crypto = require('node:crypto');
const { CmsError, namespaceFromEnv } = require('../cms/core');
const { open, seal } = require('./security');

const CLAIM_LEASE_MS = 150 * 60 * 1000;

function root() {
  return `${namespaceFromEnv()}/code/v1/`;
}

async function listAll(options) {
  let cursor;
  const blobs = [];
  do {
    const page = await list({ ...options, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function fetchText(url, version = '') {
  const separator = url.includes('?') ? '&' : '?';
  const response = await fetch(`${url}${separator}relay=${encodeURIComponent(version || Date.now())}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to read relay state');
  return response.text();
}

async function readEncrypted(blob, purpose) {
  return open(await fetchText(blob.url, blob.etag || blob.uploadedAt?.getTime()), purpose);
}

async function putEncrypted(pathname, value, purpose, allowOverwrite = false) {
  return put(pathname, seal(value, purpose), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

async function exists(pathname) {
  try { return await head(pathname); } catch { return null; }
}

function jobPath(job) {
  return `${root()}jobs/pending/${Date.parse(job.createdAt)}-${job.id}.json`;
}

async function enqueueJob(job) {
  await putEncrypted(jobPath(job), job, `job:${job.id}`);
  return job;
}

async function acquireClaim(jobId, hostId) {
  const pathname = `${root()}jobs/claims/${jobId}.lock`;
  const nextClaim = () => ({
    jobId,
    hostId,
    leaseToken: crypto.randomBytes(32).toString('base64url'),
    claimedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + CLAIM_LEASE_MS).toISOString()
  });
  let value = nextClaim();
  try {
    await putEncrypted(pathname, value, `claim:${jobId}`);
    return value;
  } catch {
    const previous = await exists(pathname);
    if (!previous || Date.now() - previous.uploadedAt.getTime() <= CLAIM_LEASE_MS) return null;
    try { await del(pathname, { ifMatch: previous.etag }); } catch { return null; }
    value = nextClaim();
    try {
      await putEncrypted(pathname, value, `claim:${jobId}`);
      return value;
    } catch { return null; }
  }
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length > 31 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function requireClaim(jobId, hostId, leaseToken) {
  const blob = await exists(`${root()}jobs/claims/${jobId}.lock`);
  if (!blob) throw new CmsError(409, 'LEASE_DENIED', 'Este trabajo ya no pertenece a este equipo.');
  let claim;
  try { claim = await readEncrypted(blob, `claim:${jobId}`); } catch {
    throw new CmsError(409, 'LEASE_DENIED', 'No se pudo confirmar el permiso de este trabajo.');
  }
  if (claim.hostId !== hostId || !safeEqualText(claim.leaseToken, leaseToken) || Date.parse(claim.expiresAt) <= Date.now()) {
    throw new CmsError(409, 'LEASE_DENIED', 'Este trabajo ya no pertenece a este equipo.');
  }
  return claim;
}

async function cleanupJob(jobId) {
  const pending = (await listAll({ prefix: `${root()}jobs/pending/` }))
    .filter(blob => blob.pathname.endsWith(`-${jobId}.json`))
    .map(blob => blob.pathname);
  const paths = [...pending, `${root()}jobs/claims/${jobId}.lock`, `${root()}jobs/cancel/${jobId}.json`];
  await Promise.all(paths.map(async pathname => {
    try { await del(pathname); } catch {}
  }));
}

async function claimNextJob(hostId) {
  const pending = (await listAll({ prefix: `${root()}jobs/pending/` }))
    .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime());
  for (const blob of pending) {
    const match = blob.pathname.match(/-([0-9a-f-]{36})\.json$/i);
    if (!match) continue;
    const jobId = match[1].toLowerCase();
    if (await exists(`${root()}jobs/done/${jobId}.json`)) {
      await cleanupJob(jobId);
      continue;
    }
    const claim = await acquireClaim(jobId, hostId);
    if (!claim) continue;
    try {
      return { ...(await readEncrypted(blob, `job:${jobId}`)), leaseToken: claim.leaseToken, leaseExpiresAt: claim.expiresAt };
    } catch {
      await completeJob(jobId, { status: 'failed', error: 'No se pudo leer la instrucción cifrada.' });
    }
  }
  return null;
}

async function appendEvents(jobId, hostId, leaseToken, events) {
  await requireClaim(jobId, hostId, leaseToken);
  await Promise.all(events.map(async event => {
    const sequence = String(event.seq).padStart(9, '0');
    const pathname = `${root()}events/${jobId}/${sequence}.json`;
    try { return await putEncrypted(pathname, event, `event:${jobId}:${event.seq}`); } catch {
      if (!await exists(pathname)) throw new Error('Unable to save relay event');
      return null;
    }
  }));
}

async function readEvents(jobId, after = 0) {
  const blobs = (await listAll({ prefix: `${root()}events/${jobId}/` }))
    .filter(blob => {
      const sequence = Number((blob.pathname.match(/\/(\d+)\.json$/) || [])[1]);
      return Number.isSafeInteger(sequence) && sequence > after;
    })
    .sort((a, b) => a.pathname.localeCompare(b.pathname))
    .slice(0, 100);
  const events = [];
  for (const blob of blobs) {
    const sequence = Number((blob.pathname.match(/\/(\d+)\.json$/) || [])[1]);
    try { events.push(await readEncrypted(blob, `event:${jobId}:${sequence}`)); } catch {}
  }
  return events.sort((a, b) => a.seq - b.seq);
}

async function completeJob(jobId, result) {
  const record = { jobId, ...result, completedAt: new Date().toISOString() };
  const pathname = `${root()}jobs/done/${jobId}.json`;
  const current = await exists(pathname);
  if (!current) await putEncrypted(pathname, record, `done:${jobId}`);
  await cleanupJob(jobId);
  return record;
}

async function completeClaimedJob(jobId, hostId, leaseToken, result) {
  const existing = await completion(jobId);
  if (existing) return existing;
  await requireClaim(jobId, hostId, leaseToken);
  return completeJob(jobId, result);
}

async function completion(jobId) {
  const blob = await exists(`${root()}jobs/done/${jobId}.json`);
  return blob ? readEncrypted(blob, `done:${jobId}`) : null;
}

async function requestCancellation(jobId) {
  const pathname = `${root()}jobs/cancel/${jobId}.json`;
  if (!await exists(pathname)) {
    await putEncrypted(pathname, { jobId, requestedAt: new Date().toISOString() }, `cancel:${jobId}`);
  }
  return { cancelled: true };
}

async function cancellationRequested(jobId, hostId, leaseToken) {
  await requireClaim(jobId, hostId, leaseToken);
  return Boolean(await exists(`${root()}jobs/cancel/${jobId}.json`));
}

async function heartbeat(host) {
  const pathname = `${root()}hosts/${host.id}.json`;
  await putEncrypted(pathname, { ...host, at: new Date().toISOString() }, `host:${host.id}`, true);
}

async function latestHost() {
  const blobs = (await listAll({ prefix: `${root()}hosts/` }))
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  for (const blob of blobs.slice(0, 10)) {
    const hostId = (blob.pathname.split('/').pop() || '').replace(/\.json$/, '');
    try {
      const value = await readEncrypted(blob, `host:${hostId}`);
      return { ...value, online: Date.now() - Date.parse(value.at) < 60_000 };
    } catch {}
  }
  return null;
}

async function editorStatus() {
  const host = await latestHost();
  return {
    online: Boolean(host?.online),
    lastSeen: host?.at || null,
    busy: Boolean(host?.busy),
    currentJobId: host?.currentJobId || null,
    providers: host?.providers || []
  };
}

async function jobState(jobId, after) {
  const [events, done] = await Promise.all([readEvents(jobId, after), completion(jobId)]);
  return { events, done };
}

module.exports = {
  appendEvents,
  cancellationRequested,
  claimNextJob,
  completeClaimedJob,
  completeJob,
  editorStatus,
  enqueueJob,
  heartbeat,
  jobState,
  requestCancellation,
  requireClaim,
  root
};
