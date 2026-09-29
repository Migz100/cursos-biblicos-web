const { del, head, list, put } = require('@vercel/blob');
const crypto = require('node:crypto');
const { CmsError, namespaceFromEnv } = require('../cms/core');
const { open, seal } = require('./security');

const CLAIM_LEASE_MS = 150 * 60 * 1000;
const MAX_PENDING_JOBS = 20;
const MAX_PENDING_JOBS_PER_CLIENT = 1;
const ATTACHMENT_RETENTION_MS = 2 * 60 * 60 * 1000;
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SWEEP_DELETES = 100;
const MAX_TURN_ATTACHMENTS = 4;
const MAX_TURN_ATTACHMENT_BYTES = 12 * 1024 * 1024;

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

function attachmentPath(attachmentId) {
  return `${root()}attachments/staged/${attachmentId}.json`;
}

async function pendingJob(jobId) {
  const matches = (await listAll({ prefix: `${root()}jobs/pending/` }))
    .filter(blob => blob.pathname.endsWith(`-${jobId}.json`));
  for (const blob of matches) {
    try { return await readEncrypted(blob, `job:${jobId}`); } catch {}
  }
  return null;
}

function uploadedAtMs(blob) {
  const value = blob?.uploadedAt instanceof Date ? blob.uploadedAt.getTime() : Date.parse(blob?.uploadedAt);
  return Number.isFinite(value) ? value : Date.now();
}

async function sweepPrefix(prefix, maxAgeMs, now = Date.now()) {
  const stale = (await listAll({ prefix })).filter(blob => now - uploadedAtMs(blob) > maxAgeMs).slice(0, MAX_SWEEP_DELETES);
  await Promise.all(stale.map(async blob => { try { await del(blob.pathname); } catch {} }));
  return stale.length;
}

async function sweepAttachments() {
  return sweepPrefix(`${root()}attachments/staged/`, ATTACHMENT_RETENTION_MS);
}

async function sweepRetainedState() {
  await sweepAttachments();
  await sweepPrefix(`${root()}jobs/done/`, RESULT_RETENTION_MS);
  await sweepPrefix(`${root()}events/`, RESULT_RETENTION_MS);
}

async function storeAttachment(record) {
  await sweepAttachments();
  await putEncrypted(attachmentPath(record.id), record, `attachment:${record.id}`);
  return {
    attachmentId: record.id,
    conversationId: record.conversationId,
    name: record.name,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
    expiresAt: record.expiresAt
  };
}

async function readAttachment(attachmentId) {
  const blob = await exists(attachmentPath(attachmentId));
  if (!blob) throw new CmsError(404, 'UPLOAD_NOT_FOUND', 'El archivo adjunto ya no está disponible.');
  let record;
  try { record = await readEncrypted(blob, `attachment:${attachmentId}`); }
  catch { throw new CmsError(409, 'UPLOAD_INVALID', 'No se pudo verificar el archivo adjunto.'); }
  if (Date.parse(record.expiresAt) <= Date.now()) {
    try { await del(attachmentPath(attachmentId)); } catch {}
    throw new CmsError(410, 'UPLOAD_EXPIRED', 'El archivo adjunto expiró.');
  }
  return record;
}

async function bindJobAttachments(job) {
  if (!Array.isArray(job.attachmentIds) || !job.attachmentIds.length) return { ...job, attachments: [] };
  if (job.attachmentIds.length > MAX_TURN_ATTACHMENTS) throw new CmsError(400, 'UPLOAD_TOO_MANY', 'Hay demasiados archivos adjuntos.');
  const attachments = [];
  let totalBytes = 0;
  for (const id of job.attachmentIds) {
    const record = await readAttachment(id);
    if (record.clientId !== job.clientId || record.conversationId !== job.conversationId) throw new CmsError(409, 'UPLOAD_CONVERSATION_MISMATCH', 'El archivo adjunto pertenece a otro navegador o chat.');
    totalBytes += Number(record.size) || 0;
    if (totalBytes > MAX_TURN_ATTACHMENT_BYTES) throw new CmsError(413, 'UPLOAD_TOO_LARGE', 'Los archivos adjuntos superan 12 MB en total.');
    attachments.push({ id: record.id, name: record.name, mime: record.mime, size: record.size, sha256: record.sha256 });
  }
  return { ...job, attachmentIds: undefined, attachments };
}

async function enqueueJob(job) {
  await sweepAttachments();
  const pending = (await listAll({ prefix: `${root()}jobs/pending/` }))
    .sort((left, right) => uploadedAtMs(left) - uploadedAtMs(right));
  if (pending.length >= MAX_PENDING_JOBS) throw new CmsError(503, 'CODE_QUEUE_FULL', 'La cola de edición está llena. Intenta otra vez más tarde.');
  let clientPending = 0;
  for (const blob of pending) {
    const match = blob.pathname.match(/-([0-9a-f-]{36})\.json$/i);
    if (!match) continue;
    try {
      const queued = await readEncrypted(blob, `job:${match[1].toLowerCase()}`);
      if (queued.clientId === job.clientId) clientPending++;
    } catch {}
  }
  if (clientPending >= MAX_PENDING_JOBS_PER_CLIENT) {
    throw new CmsError(409, 'CODE_CLIENT_BUSY', 'Este navegador ya tiene un trabajo pendiente. Espera a que termine.');
  }
  const prepared = await bindJobAttachments(job);
  await putEncrypted(jobPath(prepared), prepared, `job:${prepared.id}`);
  return prepared;
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
    if (!previous) return null;
    let current = null;
    try { current = await readEncrypted(previous, `claim:${jobId}`); } catch {}
    const expiresAt = current ? Date.parse(current.expiresAt) : previous.uploadedAt.getTime() + CLAIM_LEASE_MS;
    if (current?.hostId === hostId && Number.isFinite(expiresAt) && expiresAt > Date.now()) return current;
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return null;
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
  const pendingBlobs = (await listAll({ prefix: `${root()}jobs/pending/` }))
    .filter(blob => blob.pathname.endsWith(`-${jobId}.json`));
  const attachmentIds = [];
  for (const blob of pendingBlobs) {
    try {
      const job = await readEncrypted(blob, `job:${jobId}`);
      for (const attachment of job.attachments || []) attachmentIds.push(attachment.id);
    } catch {}
  }
  const approvalPaths = (await listAll({ prefix: `${root()}approvals/${jobId}/` })).map(blob => blob.pathname);
  const controlPaths = (await listAll({ prefix: `${root()}controls/${jobId}/` })).map(blob => blob.pathname);
  const paths = [
    ...pendingBlobs.map(blob => blob.pathname),
    ...attachmentIds.map(attachmentPath),
    ...approvalPaths,
    ...controlPaths,
    `${root()}jobs/claims/${jobId}.lock`,
    `${root()}jobs/cancel/${jobId}.json`
  ];
  await Promise.all(paths.map(async pathname => {
    try { await del(pathname); } catch {}
  }));
}

async function claimNextJob(hostId) {
  await sweepRetainedState();
  const pending = (await listAll({ prefix: `${root()}jobs/pending/` }))
    .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime());
  for (const blob of pending) {
    const match = blob.pathname.match(/-([0-9a-f-]{36})\.json$/i);
    if (!match) continue;
    const jobId = match[1].toLowerCase();
    if (Date.now() - uploadedAtMs(blob) > JOB_RETENTION_MS) {
      await completeJob(jobId, { status: 'failed', error: 'El trabajo expiró antes de comenzar.' });
      continue;
    }
    if (await exists(`${root()}jobs/done/${jobId}.json`)) {
      await cleanupJob(jobId);
      continue;
    }
    const claim = await acquireClaim(jobId, hostId);
    if (!claim) continue;
    try {
      return {
        ...(await readEncrypted(blob, `job:${jobId}`)),
        leaseToken: claim.leaseToken,
        leaseExpiresAt: claim.expiresAt,
        eventSequence: await latestEventSequence(jobId)
      };
    } catch {
      await completeJob(jobId, { status: 'failed', error: 'No se pudo leer la instrucción cifrada.' });
    }
  }
  return null;
}

async function latestEventSequence(jobId) {
  const blobs = await listAll({ prefix: `${root()}events/${jobId}/` });
  return blobs.reduce((latest, blob) => {
    const sequence = Number((blob.pathname.match(/\/(\d+)\.json$/) || [])[1]);
    return Number.isSafeInteger(sequence) ? Math.max(latest, sequence) : latest;
  }, 0);
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
  const job = await pendingJob(jobId);
  const record = {
    jobId,
    clientId: job?.clientId || null,
    conversationId: job?.conversationId || null,
    ...result,
    completedAt: new Date().toISOString()
  };
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

async function requestCancellation(jobId, clientId, conversationId) {
  const job = await pendingJob(jobId);
  if (!job || job.clientId !== clientId || job.conversationId !== conversationId) {
    throw new CmsError(404, 'CANCEL_NOT_FOUND', 'No hay un trabajo activo para este navegador y chat.');
  }
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

async function submitApproval(record) {
  const claim = await exists(`${root()}jobs/claims/${record.jobId}.lock`);
  if (!claim) throw new CmsError(404, 'APPROVAL_NOT_FOUND', 'La aprobación ya no está pendiente.');
  const job = await pendingJob(record.jobId);
  if (!job || job.clientId !== record.clientId || job.conversationId !== record.conversationId) throw new CmsError(404, 'APPROVAL_NOT_FOUND', 'La aprobación ya no está pendiente.');
  const pathname = `${root()}approvals/${record.jobId}/${record.approvalId}.json`;
  if (await exists(pathname)) throw new CmsError(409, 'APPROVAL_ALREADY_RESOLVED', 'Esta aprobación ya fue respondida.');
  try { await putEncrypted(pathname, record, `approval:${record.jobId}:${record.approvalId}`); }
  catch {
    if (await exists(pathname)) throw new CmsError(409, 'APPROVAL_ALREADY_RESOLVED', 'Esta aprobación ya fue respondida.');
    throw new Error('Unable to store approval response');
  }
  return { accepted: true, approvalId: record.approvalId, decision: record.decision };
}

async function approvalDecision(jobId, hostId, leaseToken, approvalId) {
  await requireClaim(jobId, hostId, leaseToken);
  const blob = await exists(`${root()}approvals/${jobId}/${approvalId}.json`);
  if (!blob) return null;
  try { return await readEncrypted(blob, `approval:${jobId}:${approvalId}`); }
  catch { throw new CmsError(409, 'APPROVAL_INVALID', 'No se pudo verificar la aprobación.'); }
}

async function submitControl(control) {
  if (await completion(control.jobId)) throw new CmsError(409, 'CONTROL_TOO_LATE', 'El turno ya terminó.');
  const claim = await exists(`${root()}jobs/claims/${control.jobId}.lock`);
  if (!claim) throw new CmsError(404, 'CONTROL_NOT_FOUND', 'No hay un turno activo para esta instrucción.');
  const job = await pendingJob(control.jobId);
  if (!job || job.clientId !== control.clientId || job.conversationId !== control.conversationId) {
    throw new CmsError(404, 'CONTROL_NOT_FOUND', 'No hay un turno activo para este navegador y chat.');
  }
  const order = `${String(Date.now()).padStart(13, '0')}-${control.id}`;
  await putEncrypted(`${root()}controls/${control.jobId}/${order}.json`, control, `control:${control.jobId}:${control.id}`);
  return { accepted: true, controlId: control.id, operation: control.operation };
}

async function readControls(jobId, hostId, leaseToken, after = '') {
  await requireClaim(jobId, hostId, leaseToken);
  const blobs = (await listAll({ prefix: `${root()}controls/${jobId}/` }))
    .filter(blob => (blob.pathname.split('/').pop() || '') > after)
    .sort((left, right) => left.pathname.localeCompare(right.pathname))
    .slice(0, 20);
  const controls = [];
  let cursor = after;
  for (const blob of blobs) {
    const filename = blob.pathname.split('/').pop() || '';
    const match = filename.match(/^[0-9]{13}-([0-9a-f-]{36})\.json$/i);
    if (!match) continue;
    try {
      controls.push(await readEncrypted(blob, `control:${jobId}:${match[1].toLowerCase()}`));
      cursor = filename;
    } catch {}
  }
  return { controls, cursor };
}

async function readClaimedAttachment(jobId, hostId, leaseToken, attachmentId) {
  await requireClaim(jobId, hostId, leaseToken);
  const job = await pendingJob(jobId);
  if (!job || !(job.attachments || []).some(item => item.id === attachmentId)) {
    throw new CmsError(404, 'UPLOAD_NOT_FOUND', 'El archivo adjunto no pertenece a este trabajo.');
  }
  const record = await readAttachment(attachmentId);
  const metadata = job.attachments.find(item => item.id === attachmentId);
  if (metadata.size !== record.size || metadata.sha256 !== record.sha256 || metadata.name !== record.name || metadata.mime !== record.mime) {
    throw new CmsError(409, 'UPLOAD_HASH_MISMATCH', 'El archivo adjunto cambió durante la transferencia.');
  }
  return record;
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
    providers: host?.providers || [],
    connection: host?.online ? String(host?.connection || 'ready').slice(0, 30) : 'offline',
    appServer: host?.appServer ? {
      ready: Boolean(host.appServer.ready),
      model: String(host.appServer.model || '').slice(0, 60) || null,
      effort: String(host.appServer.effort || '').slice(0, 30) || null,
      serviceTier: String(host.appServer.serviceTier || '').slice(0, 30) || null
    } : null
  };
}

async function jobState(jobId, after, clientId, conversationId) {
  const [job, done] = await Promise.all([pendingJob(jobId), completion(jobId)]);
  const owner = job || done;
  if (!owner || owner.clientId !== clientId || owner.conversationId !== conversationId) {
    throw new CmsError(404, 'JOB_NOT_FOUND', 'No se encontró este trabajo para el navegador y chat.');
  }
  const events = await readEvents(jobId, after);
  return { events, done };
}

module.exports = {
  appendEvents,
  approvalDecision,
  bindJobAttachments,
  cancellationRequested,
  claimNextJob,
  completeClaimedJob,
  completeJob,
  editorStatus,
  enqueueJob,
  heartbeat,
  jobState,
  readClaimedAttachment,
  readControls,
  requestCancellation,
  requireClaim,
  root,
  storeAttachment,
  submitApproval,
  submitControl
};
