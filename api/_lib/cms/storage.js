const crypto = require('node:crypto');
const { del, getDownloadUrl, head, issueSignedToken, list, presignUrl, put } = require('@vercel/blob');
const { CmsError, MAX_HISTORY, buildStarterManifest, manifestReferencesPath, migrateKnownLessonOrder, namespaceFromEnv } = require('./core');
const { clientKey, signEnvelope, verifyEnvelope } = require('./security');
const { extractZipEntry, validateMagic, zipEntries } = require('./validation');

function namespace() {
  return namespaceFromEnv();
}

function manifestPrefix() {
  return `${namespace()}/manifests/`;
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

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to read catalog state');
  return response.json();
}

async function manifestBlobs() {
  const blobs = await listAll({ prefix: manifestPrefix() });
  return blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
}

async function loadManifest(revision) {
  const blobs = await manifestBlobs();
  if (!blobs.length) {
    if (revision && revision !== 'starter-bundled-v1') throw new CmsError(404, 'REVISION_NOT_FOUND', 'Esa versión ya no está disponible.');
    return migrateKnownLessonOrder(buildStarterManifest());
  }
  let blob = blobs[0];
  if (revision) {
    blob = blobs.find(item => item.pathname.endsWith(`/${revision}.json`));
    if (!blob) throw new CmsError(404, 'REVISION_NOT_FOUND', 'Esa versión ya no está disponible.');
  }
  return migrateKnownLessonOrder(await fetchJson(blob.url));
}

function lockName(revision) {
  const digest = crypto.createHash('sha256').update(String(revision)).digest('hex').slice(0, 32);
  return `${namespace()}/locks/${digest}.lock`;
}

async function acquireLock(revision) {
  const pathname = lockName(revision);
  try {
    await put(pathname, String(Date.now()), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: 'text/plain',
      cacheControlMaxAge: 60
    });
    return;
  } catch (error) {
    let existing = null;
    try { existing = await head(pathname); } catch {}
    if (!existing) throw error;
    if (Date.now() - existing.uploadedAt.getTime() > 90000) {
      try { await del(pathname, { ifMatch: existing.etag }); } catch {}
      try {
        await put(pathname, String(Date.now()), {
          access: 'public',
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: 'text/plain',
          cacheControlMaxAge: 60
        });
        return;
      } catch {}
    }
    throw new CmsError(409, 'REVISION_CONFLICT', 'Otra persona cambió el catálogo. Recarga la página para continuar.');
  }
}

async function trimHistory() {
  try {
    const blobs = await manifestBlobs();
    const old = blobs.slice(MAX_HISTORY).map(item => item.pathname);
    if (old.length) await del(old);
  } catch {}
}

async function writeManifest(currentRevision, next, change) {
  await acquireLock(currentRevision);
  const now = new Date().toISOString();
  const revision = `manifest-${String(Date.now()).padStart(13, '0')}-${crypto.randomUUID()}`;
  const manifest = structuredClone(next);
  manifest.schemaVersion = 1;
  manifest.revision = revision;
  manifest.createdAt ||= now;
  manifest.updatedAt = now;
  manifest.change = change;
  await put(`${manifestPrefix()}${revision}.json`, JSON.stringify(manifest), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  await trimHistory();
  return manifest;
}

async function history(limit = 20) {
  const blobs = (await manifestBlobs()).slice(0, Math.min(limit, MAX_HISTORY));
  const entries = await Promise.all(blobs.map(async blob => {
    const manifest = await fetchJson(blob.url);
    return {
      revision: manifest.revision,
      updatedAt: manifest.updatedAt,
      label: manifest.change?.label || 'Cambio del catálogo'
    };
  }));
  if (entries.length < limit) {
    entries.push({ revision: 'starter-bundled-v1', updatedAt: null, label: 'Catálogo original' });
  }
  return entries.slice(0, limit);
}

async function backupManifest() {
  const manifest = await loadManifest();
  const record = {
    backedUpAt: new Date().toISOString(),
    namespace: namespace(),
    manifest
  };
  const body = JSON.stringify(record);
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const pathname = `${namespace()}/backups/backup-${Date.now()}-${crypto.randomUUID()}.json`;
  const blob = await put(pathname, body, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  const stored = await fetch(blob.url, { cache: 'no-store' });
  if (!stored.ok) throw new CmsError(500, 'BACKUP_FAILED', 'No se pudo verificar la copia de seguridad.');
  const storedDigest = crypto.createHash('sha256').update(Buffer.from(await stored.arrayBuffer())).digest('hex');
  if (storedDigest !== digest) throw new CmsError(500, 'BACKUP_FAILED', 'La copia de seguridad no coincide con el catálogo.');
  return {
    verified: true,
    pathname,
    revision: manifest.revision,
    courses: manifest.courses.length,
    lessons: manifest.courses.reduce((sum, course) => sum + course.lessons.length, 0),
    digest
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireEphemeralLock(pathname) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await put(pathname, String(Date.now()), {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: 'text/plain',
        cacheControlMaxAge: 60
      });
    } catch (error) {
      let existing = null;
      try { existing = await head(pathname); } catch {}
      if (existing && Date.now() - existing.uploadedAt.getTime() > 90000) {
        try { await del(pathname, { ifMatch: existing.etag }); } catch {}
      }
      if (attempt < 4) await wait(20 * (attempt + 1));
    }
  }
  throw new CmsError(429, 'RATE_BUSY', 'Hay muchos cambios al mismo tiempo. Intenta otra vez.');
}

async function releaseEphemeralLock(pathname, lock) {
  try { await del(pathname, { ifMatch: lock.etag }); } catch {}
}

function markerParts(pathname) {
  const name = pathname.split('/').pop() || '';
  const [timestamp, bytes] = name.split('-');
  return { timestamp: Number(timestamp), bytes: Number(bytes) };
}

async function enforceOneRate(prefix, lockPath, limits, addedBytes) {
  const lock = await acquireEphemeralLock(lockPath);
  try {
    const now = Date.now();
    const blobs = await listAll({ prefix });
    const recent = [];
    const expired = [];
    for (const blob of blobs) {
      const marker = markerParts(blob.pathname);
      if (Number.isFinite(marker.timestamp) && now - marker.timestamp < limits.windowMs) recent.push(marker);
      else expired.push(blob.pathname);
    }
    const usedBytes = recent.reduce((sum, marker) => sum + (Number.isFinite(marker.bytes) ? marker.bytes : 0), 0);
    if (recent.length + 1 > limits.count || usedBytes + addedBytes > limits.bytes) {
      throw new CmsError(429, 'RATE_LIMIT', 'Se alcanzó el límite temporal. Intenta de nuevo más tarde.');
    }
    const pathname = `${prefix}${now}-${addedBytes}-${crypto.randomUUID()}.rate`;
    await put(pathname, '1', {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: 'text/plain',
      cacheControlMaxAge: 60
    });
    if (expired.length) del(expired).catch(() => {});
  } finally {
    await releaseEphemeralLock(lockPath, lock);
  }
}

async function enforceRate(req, scope, addedBytes, personal, global) {
  const root = `${namespace()}/rate/${scope}/`;
  const key = clientKey(req, `${namespace()}:${scope}`);
  await enforceOneRate(`${root}visitors/${key}/`, `${root}locks/visitor-${key}.lock`, personal, addedBytes);
  await enforceOneRate(`${root}global/`, `${root}locks/global.lock`, global, addedBytes);
}

async function sweepPendingUploads() {
  const prefix = `${namespace()}/pending/`;
  const markers = (await listAll({ prefix })).filter(item => item.pathname.endsWith('.json'));
  const expired = markers.filter(item => {
    const match = item.pathname.match(/-(\d+)\.json$/);
    return match && Number(match[1]) < Date.now();
  });
  for (const marker of expired.slice(0, 20)) {
    try {
      const record = await fetchJson(marker.url);
      if (typeof record.pathname === 'string' && record.pathname.startsWith(`${namespace()}/assets/`)) {
        await del(record.pathname).catch(() => {});
      }
      await del(marker.pathname, { ifMatch: marker.etag }).catch(() => {});
    } catch {}
  }
}

async function prepareUpload(info) {
  await sweepPendingUploads();
  const id = crypto.randomUUID();
  const pathname = `${namespace()}/assets/${id}-${info.safeName}`;
  const validUntil = Date.now() + 5 * 60 * 1000;
  const pendingPath = `${namespace()}/pending/${id}-${validUntil + 5 * 60 * 1000}.json`;
  const signed = await issueSignedToken({
    pathname,
    operations: ['put'],
    validUntil,
    allowedContentTypes: [info.contentType],
    maximumSizeInBytes: info.size
  });
  const { presignedUrl } = await presignUrl(signed, {
    operation: 'put',
    access: 'public',
    pathname,
    validUntil,
    allowedContentTypes: [info.contentType],
    maximumSizeInBytes: info.size,
    allowOverwrite: false,
    addRandomSuffix: false,
    cacheControlMaxAge: 31536000
  });
  const receipt = signEnvelope('pending-upload', {
    namespace: namespace(),
    pathname,
    pendingPath,
    extension: info.extension,
    contentType: info.contentType,
    size: info.size,
    originalName: info.originalName,
    suggestedTitle: info.suggestedTitle,
    kind: info.kind
  }, 10 * 60 * 1000);
  await put(pendingPath, JSON.stringify({ pathname, expiresAt: validUntil + 5 * 60 * 1000 }), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  return { presignedUrl, receipt, contentType: info.contentType, suggestedTitle: info.suggestedTitle };
}

async function readRange(url, start, end) {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store' });
  if (!response.ok && response.status !== 206) throw new Error('Unable to inspect uploaded file');
  return Buffer.from(await response.arrayBuffer());
}

async function readWhole(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to inspect uploaded file');
  return Buffer.from(await response.arrayBuffer());
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function decodeXml(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function normalizedContent(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000_000);
}

async function textFromPdf(buffer) {
  let loadingTask;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableWorker: true,
      isEvalSupported: false,
      verbosity: 0
    });
    const document = await loadingTask.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str || '').join(' '));
    }
    return pages.join(' ');
  } catch {
    return '';
  } finally {
    try { await loadingTask?.destroy(); } catch {}
  }
}

function textFromPresentation(buffer) {
  const slides = zipEntries(buffer)
    .filter(entry => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => Number(a.name.match(/\d+/)?.[0]) - Number(b.name.match(/\d+/)?.[0]));
  const text = [];
  for (const slide of slides) {
    const xml = extractZipEntry(buffer, slide.name, 8 * 1024 * 1024);
    if (xml) text.push(decodeXml(xml.toString('utf8')));
  }
  return text.join(' ');
}

async function contentFingerprint(type, buffer) {
  let text = '';
  if (type === 'pdf') text = await textFromPdf(buffer);
  if (type === 'pptx' || type === 'ppsx') text = textFromPresentation(buffer);
  const normalized = normalizedContent(text);
  if (normalized.length < 80) return { contentHash: null, contentCharacters: normalized.length };
  return {
    contentHash: crypto.createHash('sha256').update(normalized).digest('hex'),
    contentCharacters: normalized.length
  };
}

function embeddedPagesPdf(buffer) {
  const candidates = ['QuickLook/Preview.pdf', 'Preview.pdf', 'preview.pdf'];
  for (const name of candidates) {
    const preview = extractZipEntry(buffer, name, 40 * 1024 * 1024);
    if (!preview) continue;
    try {
      validateMagic('pdf', preview.subarray(0, Math.min(preview.length, 262144)), preview.subarray(Math.max(0, preview.length - 4 * 1024 * 1024)));
      return preview;
    } catch {}
  }
  return null;
}

async function finalizeUpload(receipt) {
  const pending = verifyEnvelope(receipt, 'pending-upload');
  if (
    pending.namespace !== namespace() ||
    !pending.pathname.startsWith(`${namespace()}/assets/`) ||
    !pending.pendingPath?.startsWith(`${namespace()}/pending/`) ||
    !pending.pendingPath.endsWith('.json')
  ) {
    throw new CmsError(400, 'INVALID_RECEIPT', 'El comprobante no es válido.');
  }
  const finalizeLockPath = `${pending.pendingPath}.lock`;
  const finalizeLock = await acquireEphemeralLock(finalizeLockPath);
  try {
    try { await head(pending.pendingPath); } catch { throw new CmsError(409, 'UPLOAD_ALREADY_FINALIZED', 'Este archivo ya fue procesado.'); }
    let metadata;
    try { metadata = await head(pending.pathname); } catch {
      await del(pending.pendingPath).catch(() => {});
      throw new CmsError(400, 'UPLOAD_MISSING', 'No se encontró el archivo subido.');
    }
    if (metadata.size < 1 || metadata.size > pending.size || metadata.contentType !== pending.contentType) {
      await del([pending.pathname, pending.pendingPath]).catch(() => {});
      throw new CmsError(400, 'INVALID_FILE_SIZE', 'El archivo subido no coincide con lo esperado.');
    }
    const whole = await readWhole(metadata.url);
    const headBytes = whole.subarray(0, Math.min(whole.length, 262143));
    const tailBytes = whole.subarray(Math.max(0, whole.length - 4 * 1024 * 1024));
    try {
      validateMagic(pending.extension, headBytes, tailBytes);
    } catch (error) {
      await del([pending.pathname, pending.pendingPath]).catch(() => {});
      throw error;
    }
    const sourceSha256 = sha256(whole);
    let mainType = pending.extension;
    let mainUrl = metadata.url;
    let mainPathname = pending.pathname;
    let mainSize = metadata.size;
    let mainOriginalName = pending.originalName;
    let source = null;
    let conversionStatus = null;
    let fingerprintBuffer = whole;
    if (pending.extension === 'pages') {
      const preview = embeddedPagesPdf(whole);
      if (preview) {
        const derivedPathname = pending.pathname.replace(/\.pages$/i, '') + '-pages-preview.pdf';
        const derived = await put(derivedPathname, preview, {
          access: 'public',
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: 'application/pdf',
          cacheControlMaxAge: 31536000
        });
        mainType = 'pdf';
        mainUrl = derived.url;
        mainPathname = derived.pathname;
        mainSize = preview.length;
        mainOriginalName = pending.originalName.replace(/\.pages$/i, '.pdf');
        fingerprintBuffer = preview;
        conversionStatus = 'embedded-pdf';
        source = {
          sourceType: 'pages',
          sourceUrl: metadata.url,
          sourceDownloadUrl: getDownloadUrl(metadata.url),
          sourceOriginalName: pending.originalName,
          sourcePathname: pending.pathname,
          sourceSize: metadata.size,
          sourceSha256
        };
      } else {
        conversionStatus = 'needs-pdf';
      }
    }
    const fingerprint = await contentFingerprint(mainType, fingerprintBuffer);
    await del(pending.pendingPath).catch(() => {});
    const asset = {
      validated: true,
      type: mainType,
      url: mainUrl,
      downloadUrl: getDownloadUrl(mainUrl),
      originalName: mainOriginalName,
      pathname: mainPathname,
      size: mainSize,
      sha256: sha256(fingerprintBuffer),
      ...fingerprint,
      ...(conversionStatus ? { conversionStatus } : {}),
      ...(source || {})
    };
    return {
      assetToken: signEnvelope('validated-asset', asset, 30 * 60 * 1000),
      suggestedTitle: pending.suggestedTitle,
      originalName: pending.originalName,
      type: asset.type,
      conversionStatus: asset.conversionStatus || null
    };
  } finally {
    await releaseEphemeralLock(finalizeLockPath, finalizeLock);
  }
}

function validatedAsset(token) {
  const asset = verifyEnvelope(token, 'validated-asset');
  if (!asset.pathname?.startsWith(`${namespace()}/assets/`)) {
    throw new CmsError(400, 'INVALID_ASSET', 'El archivo no pertenece a este catálogo.');
  }
  return asset;
}

async function discardUpload(token) {
  const asset = validatedAsset(token);
  const manifest = await loadManifest();
  const paths = [asset.pathname, asset.sourcePathname].filter(Boolean);
  if (paths.some(pathname => manifestReferencesPath(manifest, pathname))) {
    throw new CmsError(409, 'ASSET_IN_USE', 'El archivo ya pertenece al catálogo y no se puede descartar.');
  }
  await del(paths);
  for (const pathname of paths) {
    let exists = true;
    try { await head(pathname); } catch { exists = false; }
    if (exists) throw new CmsError(500, 'DISCARD_FAILED', 'No se pudo descartar el archivo sin usar.');
  }
  return { discarded: true };
}

module.exports = {
  backupManifest,
  enforceRate,
  discardUpload,
  finalizeUpload,
  history,
  loadManifest,
  manifestBlobs,
  namespace,
  prepareUpload,
  validatedAsset,
  writeManifest
};
