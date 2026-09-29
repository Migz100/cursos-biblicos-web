const crypto = require('node:crypto');
const path = require('node:path');
const { CmsError } = require('../cms/core');
const { requireUuid } = require('./security');

const ACTIONS = new Set(['prompt', 'checks', 'preview']);
const MODES = new Set(['edit', 'plan']);
const PROVIDERS = new Set(['auto', 'codex']);
const THREAD_OPERATIONS = new Set(['start', 'resume', 'read', 'list']);
const TURN_OPERATIONS = new Set(['start', 'steer', 'interrupt']);
const APPROVAL_DECISIONS = new Set(['accept', 'decline', 'cancel']);
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const MAX_TURN_ATTACHMENTS = 4;
const MAX_TURN_ATTACHMENT_BYTES = 12 * 1024 * 1024;
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

function cleanPrompt(value, required) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new CmsError(400, 'INVALID_PROMPT', 'La instrucción no es válida.');
  const prompt = value
    .normalize('NFC')
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if ((required && !prompt) || prompt.length > 12000) {
    throw new CmsError(400, 'INVALID_PROMPT', 'Escribe una instrucción de hasta 12,000 caracteres.');
  }
  return prompt;
}

function requireObject(input, code = 'INVALID_JOB') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CmsError(400, code, 'La solicitud no es válida.');
  }
  return input;
}

function cleanOpaqueId(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
    throw new CmsError(400, 'INVALID_ID', `El identificador de ${label} no es válido.`);
  }
  return text;
}

function cleanAttachmentIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_TURN_ATTACHMENTS) {
    throw new CmsError(400, 'UPLOAD_TOO_MANY', `Puedes adjuntar hasta ${MAX_TURN_ATTACHMENTS} archivos.`);
  }
  return [...new Set(value.map(item => requireUuid(item, 'archivo')))];
}

function cleanBrowserText(value, limit = 30000) {
  return String(value || '')
    .normalize('NFC')
    .replace(/\u0000/g, '')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\/|\/tmp\/)[^\s"')\]}]+/g, '[ruta local]')
    .slice(0, limit);
}

function cleanRelativePublicPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('../') || normalized.startsWith('/') || /^\/\//.test(normalized) || /^[A-Za-z]:\//.test(normalized) || path.isAbsolute(normalized)) return null;
  return normalized;
}

function baseJob(action, input) {
  return {
    id: crypto.randomUUID(),
    clientId: requireUuid(input.clientId, 'navegador'),
    conversationId: input.conversationId ? requireUuid(input.conversationId, 'chat') : crypto.randomUUID(),
    action,
    createdAt: new Date().toISOString()
  };
}

function validateJobInput(input) {
  requireObject(input);
  const action = String(input.action || 'prompt');
  if (action === 'publish') {
    throw new CmsError(409, 'RELEASE_PREPARE_REQUIRED', 'Publicar requiere preparar, revisar y confirmar la versión fuera del chat.');
  }
  const mode = String(input.mode || 'edit');
  const provider = String(input.provider || 'auto');
  if (!ACTIONS.has(action)) throw new CmsError(400, 'INVALID_ACTION', 'La acción no es válida.');
  if (!MODES.has(mode)) throw new CmsError(400, 'INVALID_MODE', 'El modo no es válido.');
  if (!PROVIDERS.has(provider)) throw new CmsError(400, 'INVALID_PROVIDER', 'El proveedor no es válido.');
  return {
    ...baseJob(action, input),
    mode: action === 'prompt' ? mode : 'edit',
    provider,
    prompt: cleanPrompt(input.prompt, action === 'prompt'),
    threadId: input.threadId ? cleanOpaqueId(input.threadId, 'hilo') : null,
    attachmentIds: cleanAttachmentIds(input.attachmentIds)
  };
}

function validateThreadRequest(input) {
  requireObject(input, 'INVALID_THREAD_REQUEST');
  const operation = String(input.operation || 'list');
  if (!THREAD_OPERATIONS.has(operation)) throw new CmsError(400, 'INVALID_THREAD_OPERATION', 'La operación del chat no es válida.');
  const job = baseJob(`thread.${operation}`, input);
  if (operation === 'resume' || operation === 'read') {
    job.threadId = cleanOpaqueId(input.threadId, 'hilo');
    job.conversationId = requireUuid(input.conversationId, 'chat');
  }
  if (operation === 'list') {
    job.limit = Math.max(1, Math.min(50, Number(input.limit) || 20));
    job.cursor = input.cursor == null ? null : cleanOpaqueId(input.cursor, 'página');
  }
  return job;
}

function validateTurnRequest(input) {
  requireObject(input, 'INVALID_TURN_REQUEST');
  const operation = String(input.operation || 'start');
  if (!TURN_OPERATIONS.has(operation)) throw new CmsError(400, 'INVALID_TURN_OPERATION', 'La operación del turno no es válida.');
  if (operation === 'start') {
    const mode = String(input.mode || 'edit');
    if (!MODES.has(mode)) throw new CmsError(400, 'INVALID_MODE', 'El modo no es válido.');
    return {
      ...baseJob('turn.start', input),
      conversationId: requireUuid(input.conversationId, 'chat'),
      threadId: input.threadId ? cleanOpaqueId(input.threadId, 'hilo') : null,
      mode,
      prompt: cleanPrompt(input.prompt, true),
      attachmentIds: cleanAttachmentIds(input.attachmentIds)
    };
  }
  const control = {
    id: crypto.randomUUID(),
    clientId: requireUuid(input.clientId, 'navegador'),
    conversationId: requireUuid(input.conversationId, 'chat'),
    jobId: requireUuid(input.jobId, 'trabajo'),
    operation,
    threadId: cleanOpaqueId(input.threadId, 'hilo'),
    turnId: cleanOpaqueId(input.turnId, 'turno'),
    createdAt: new Date().toISOString()
  };
  if (operation === 'steer') control.prompt = cleanPrompt(input.prompt, true);
  return control;
}

function validateApprovalInput(input) {
  requireObject(input, 'APPROVAL_INVALID');
  const decision = String(input.decision || '');
  if (!APPROVAL_DECISIONS.has(decision)) throw new CmsError(400, 'APPROVAL_INVALID', 'La decisión no es válida.');
  return {
    clientId: requireUuid(input.clientId, 'navegador'),
    conversationId: requireUuid(input.conversationId, 'chat'),
    jobId: requireUuid(input.jobId, 'trabajo'),
    approvalId: requireUuid(input.approvalId, 'aprobación'),
    decision,
    createdAt: new Date().toISOString()
  };
}

function cleanReleaseToken(value, label) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(text)) throw new CmsError(400, 'RELEASE_CONFIRMATION_INVALID', `${label} no es válida.`);
  return text;
}

function cleanFingerprint(value) {
  const text = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new CmsError(400, 'RELEASE_STATE_CHANGED', 'La versión preparada no coincide.');
  return text;
}

function validateReleaseRequest(stage, input) {
  requireObject(input, 'INVALID_RELEASE_REQUEST');
  if (stage === 'prepare') {
    return { ...baseJob('release.prepare', input), conversationId: requireUuid(input.conversationId, 'chat') };
  }
  const common = {
    ...baseJob(`release.${stage}`, input),
    conversationId: requireUuid(input.conversationId, 'chat'),
    releaseId: requireUuid(input.releaseId, 'versión'),
    fingerprint: cleanFingerprint(input.fingerprint)
  };
  if (stage === 'confirm') {
    if (input.confirmation !== 'REVISADO') throw new CmsError(400, 'RELEASE_CONFIRMATION_INVALID', 'Confirma primero que revisaste la vista previa.');
    return { ...common, confirmation: 'REVISADO', confirmationToken: cleanReleaseToken(input.confirmationToken, 'La confirmación') };
  }
  if (stage === 'publish') {
    if (input.confirmation !== 'PUBLICAR') throw new CmsError(400, 'RELEASE_CONFIRMATION_INVALID', 'Escribe PUBLICAR para la confirmación final.');
    return { ...common, confirmation: 'PUBLICAR', publishToken: cleanReleaseToken(input.publishToken, 'La confirmación final') };
  }
  throw new CmsError(400, 'INVALID_RELEASE_REQUEST', 'La etapa de publicación no es válida.');
}

function validateAttachmentInput(input) {
  requireObject(input, 'UPLOAD_INVALID');
  const clientId = requireUuid(input.clientId, 'navegador');
  const conversationId = input.conversationId ? requireUuid(input.conversationId, 'chat') : crypto.randomUUID();
  const name = typeof input.name === 'string' ? input.name.normalize('NFC').trim() : '';
  if (!name || name.length > 120 || name !== path.basename(name) || /[\\/\u0000-\u001F\u007F]/.test(name) || /^\.+$/.test(name) ||
      /^(?:\.env|\.git|\.vercel|\.code-host)(?:\.|$)/i.test(name) || /[.](?:exe|com|bat|cmd|ps1|msi|scr|js|mjs|cjs|vbs|jar|pptm)$/i.test(name)) {
    throw new CmsError(400, 'UPLOAD_NAME_INVALID', 'El nombre del archivo no es seguro.');
  }
  const mime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : '';
  const extension = path.extname(name).toLowerCase();
  if (!ALLOWED_UPLOADS.get(mime)?.has(extension)) throw new CmsError(415, 'UPLOAD_TYPE_DENIED', 'Ese tipo de archivo no se puede adjuntar.');
  if (typeof input.data !== 'string' || !input.data || input.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) {
    throw new CmsError(400, 'UPLOAD_INVALID', 'El archivo adjunto no es válido.');
  }
  const data = Buffer.from(input.data, 'base64');
  if (!data.length || data.length > MAX_ATTACHMENT_BYTES) throw new CmsError(413, 'UPLOAD_TOO_LARGE', 'El archivo adjunto supera 3 MB.');
  if (data.toString('base64').replace(/=+$/, '') !== input.data.replace(/=+$/, '')) throw new CmsError(400, 'UPLOAD_INVALID', 'El archivo adjunto no es válido.');
  if (!validUploadSignature(mime, data)) throw new CmsError(415, 'UPLOAD_SIGNATURE_INVALID', 'El contenido no coincide con el tipo de archivo.');
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  return {
    id: crypto.randomUUID(), clientId, conversationId, name, mime, size: data.length, sha256,
    data: data.toString('base64'), createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  };
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

function cleanEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CmsError(400, 'INVALID_EVENT', 'El avance no es válido.');
  const type = String(input.type || 'status');
  if (!['status', 'assistant', 'log', 'result', 'error'].includes(type)) throw new CmsError(400, 'INVALID_EVENT', 'El tipo de avance no es válido.');
  const seq = Number(input.seq);
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 999999999) throw new CmsError(400, 'INVALID_EVENT', 'El orden del avance no es válido.');
  const text = cleanBrowserText(input.text, 30000);
  if (!text) throw new CmsError(400, 'INVALID_EVENT', 'El avance está vacío.');
  return { seq, type, text, at: new Date().toISOString(), meta: cleanMeta(input.meta) };
}

function cleanMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof item)) {
      result[key] = typeof item === 'string' ? cleanBrowserText(item, 500) : item;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function cleanPublicThread(value) {
  if (!value || typeof value !== 'object') return null;
  try {
    return {
      id: cleanOpaqueId(value.id || value.threadId, 'hilo'),
      conversationId: value.conversationId ? requireUuid(value.conversationId, 'chat') : null,
      name: typeof value.name === 'string' ? value.name.normalize('NFC').slice(0, 120) : null,
      status: typeof value.status === 'string' ? value.status.slice(0, 30) : null,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt.slice(0, 40) : null,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt.slice(0, 40) : null
    };
  } catch { return null; }
}

function cleanCompletionData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  const thread = cleanPublicThread(value.thread);
  if (thread) result.thread = thread;
  if (Array.isArray(value.threads)) result.threads = value.threads.slice(0, 50).map(cleanPublicThread).filter(Boolean);
  if (value.turn && typeof value.turn === 'object') {
    try { result.turn = { id: cleanOpaqueId(value.turn.id, 'turno'), status: String(value.turn.status || '').slice(0, 30) }; } catch {}
  }
  if (Array.isArray(value.history)) result.history = value.history.slice(0, 100).map(item => {
    if (!item || typeof item !== 'object' || !['user', 'assistant'].includes(item.role)) return null;
    const record = { role: item.role, text: cleanBrowserText(item.text, 30000) };
    try { if (item.turnId) record.turnId = cleanOpaqueId(item.turnId, 'turno'); } catch {}
    return record.text ? record : null;
  }).filter(Boolean);
  if (value.review && typeof value.review === 'object') {
    const release = cleanReleaseResult({ releaseId: crypto.randomUUID(), stage: 'prepared', diff: value.review.diff, tests: value.review.tests });
    if (release?.diff && release?.tests) result.review = { diff: release.diff, tests: release.tests, applied: value.review.applied === true };
  }
  if (value.tests && typeof value.tests === 'object') result.tests = {
    test: { ok: value.tests.test?.ok === true },
    check: { ok: value.tests.check?.ok === true },
    diffCheck: { ok: value.tests.diffCheck?.ok === true }
  };
  if (typeof value.previewUrl === 'string' && /^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s]*)?$/.test(value.previewUrl)) result.previewUrl = value.previewUrl;
  return Object.keys(result).length ? result : null;
}

function cleanReleaseResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  try { result.releaseId = requireUuid(value.releaseId, 'versión'); } catch { return null; }
  result.stage = ['prepared', 'confirmed', 'consumed', 'published'].includes(value.stage) ? value.stage : 'prepared';
  if (/^[a-f0-9]{64}$/i.test(String(value.fingerprint || ''))) result.fingerprint = String(value.fingerprint).toLowerCase();
  for (const key of ['confirmationToken', 'publishToken']) if (/^[A-Za-z0-9_-]{40,100}$/.test(String(value[key] || ''))) result[key] = String(value[key]);
  if (typeof value.expiresAt === 'string') result.expiresAt = value.expiresAt.slice(0, 40);
  if (typeof value.previewUrl === 'string' && /^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s]*)?$/.test(value.previewUrl)) result.previewUrl = value.previewUrl;
  if (Array.isArray(value.paths)) result.paths = value.paths.slice(0, 80).map(cleanRelativePublicPath).filter(Boolean);
  if (value.diff && typeof value.diff === 'object') result.diff = {
    sha256: /^[a-f0-9]{64}$/i.test(String(value.diff.sha256 || '')) ? String(value.diff.sha256).toLowerCase() : null,
    count: Math.max(0, Math.min(80, Number(value.diff.count) || 0)),
    totalBytes: Math.max(0, Math.min(100 * 1024 * 1024, Number(value.diff.totalBytes) || 0)),
    summary: cleanBrowserText(value.diff.summary, 4000),
    preview: cleanBrowserText(value.diff.preview, 20000)
  };
  if (value.tests && typeof value.tests === 'object') result.tests = {
    test: { ok: value.tests.test?.ok === true }, check: { ok: value.tests.check?.ok === true }, diffCheck: { ok: value.tests.diffCheck?.ok === true }
  };
  return result;
}

module.exports = {
  ACTIONS, APPROVAL_DECISIONS, MAX_ATTACHMENT_BYTES, MAX_TURN_ATTACHMENTS, MAX_TURN_ATTACHMENT_BYTES,
  MODES, PROVIDERS, THREAD_OPERATIONS, TURN_OPERATIONS, cleanCompletionData, cleanEvent, cleanMeta,
  cleanBrowserText, cleanReleaseResult, validateApprovalInput, validateAttachmentInput, validateJobInput, validateReleaseRequest,
  validateThreadRequest, validateTurnRequest
};
