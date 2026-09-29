const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { finished } = require('node:stream/promises');
const { CmsError } = require('./core');
const { trustedBlobUrl } = require('./presentation');

const DEFAULT_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_CONVERSION_TIMEOUT_MS = 90_000;
const WINDOWS_TEMP_ROOT = 'C:\\CB';
const WINDOWS_SOFFICE = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';

function conversionError(status, code, message) {
  return new CmsError(status, code, message);
}

function shortTempRoot(platform = process.platform) {
  if (platform === 'win32') return WINDOWS_TEMP_ROOT;
  return path.join(require('node:os').tmpdir(), 'cb');
}

function libreOfficePath(platform = process.platform) {
  if (platform === 'win32') return WINDOWS_SOFFICE;
  return 'soffice';
}

function redirectLocation(response, currentUrl) {
  const location = response.headers.get('location');
  if (!location) {
    throw conversionError(502, 'INVALID_PRESENTATION_REDIRECT', 'La descarga de la presentación envió una redirección inválida.');
  }
  const next = new URL(location, currentUrl).href;
  return trustedBlobUrl(next);
}

async function closeResponseBody(response) {
  try { await response.body?.cancel(); } catch {}
}

async function streamDownload(url, destination, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const maxBytes = options.maxBytes || DEFAULT_MAX_SOURCE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = trustedBlobUrl(url);

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetchImpl(currentUrl, {
      cache: 'no-store',
      redirect: 'manual',
      signal: options.signal
    });
    const returnedUrl = response.url || currentUrl;
    trustedBlobUrl(returnedUrl);

    if (response.status >= 300 && response.status < 400) {
      if (redirect === maxRedirects) {
        await closeResponseBody(response);
        throw conversionError(502, 'TOO_MANY_PRESENTATION_REDIRECTS', 'La descarga de la presentación tuvo demasiadas redirecciones.');
      }
      const nextUrl = redirectLocation(response, currentUrl);
      await closeResponseBody(response);
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok || !response.body) {
      await closeResponseBody(response);
      throw conversionError(502, 'PRESENTATION_DOWNLOAD_FAILED', 'No se pudo descargar la presentación.');
    }

    const declaredBytes = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await closeResponseBody(response);
      throw conversionError(413, 'PRESENTATION_TOO_LARGE', 'La presentación supera el límite permitido.');
    }

    const output = fs.createWriteStream(destination, { flags: 'wx' });
    let receivedBytes = 0;
    try {
      for await (const chunk of response.body) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > maxBytes) {
          throw conversionError(413, 'PRESENTATION_TOO_LARGE', 'La presentación supera el límite permitido.');
        }
        if (!output.write(chunk)) await once(output, 'drain');
      }
      output.end();
      await finished(output);
    } catch (error) {
      output.destroy();
      await closeResponseBody(response);
      await fs.promises.rm(destination, { force: true }).catch(() => {});
      throw error;
    }
    return { bytes: receivedBytes, finalUrl: trustedBlobUrl(returnedUrl) };
  }
  throw conversionError(502, 'PRESENTATION_DOWNLOAD_FAILED', 'No se pudo descargar la presentación.');
}

function fileUrl(directory) {
  const normalized = path.resolve(directory).replace(/\\/g, '/');
  return `file:///${encodeURI(normalized)}`;
}

async function runLibreOffice(sourcePath, outputDirectory, options = {}) {
  const executable = options.executable || libreOfficePath();
  const profileDirectory = options.profileDirectory || path.join(path.dirname(outputDirectory), 'u');
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs || DEFAULT_CONVERSION_TIMEOUT_MS;
  await fs.promises.mkdir(profileDirectory, { recursive: true });
  const child = spawnImpl(executable, [
    `-env:UserInstallation=${fileUrl(profileDirectory)}`,
    '--headless',
    '--convert-to', 'pdf',
    '--outdir', outputDirectory,
    sourcePath
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  timer.unref?.();
  let exitCode;
  try {
    [exitCode] = await once(child, 'exit');
  } catch {
    child.kill('SIGKILL');
    throw conversionError(500, 'PRESENTATION_CONVERSION_FAILED', 'LibreOffice no pudo iniciar la conversión.');
  } finally {
    clearTimeout(timer);
  }
  if (exitCode !== 0) {
    throw conversionError(500, 'PRESENTATION_CONVERSION_FAILED', `LibreOffice no pudo convertir la presentación${stderr ? `: ${stderr.trim().slice(0, 500)}` : '.'}`);
  }
}

async function verifyPdf(pdfPath) {
  const handle = await fs.promises.open(pdfPath, 'r').catch(() => null);
  if (!handle) throw conversionError(500, 'PRESENTATION_PDF_MISSING', 'LibreOffice no produjo el PDF esperado.');
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const stats = await handle.stat();
    if (bytesRead !== 5 || header.toString('ascii') !== '%PDF-' || stats.size < 1000) {
      throw conversionError(500, 'PRESENTATION_PDF_INVALID', 'LibreOffice produjo un PDF inválido.');
    }
    return stats.size;
  } finally {
    await handle.close();
  }
}

async function preparePresentationPdf(sourceUrl, options = {}) {
  const root = options.tempRoot || shortTempRoot();
  await fs.promises.mkdir(root, { recursive: true });
  const directory = path.join(root, `p-${randomUUID().slice(0, 8)}`);
  const outputDirectory = path.join(directory, 'o');
  const sourcePath = path.join(directory, 'in.pptx');
  const pdfPath = path.join(outputDirectory, 'in.pdf');
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fs.promises.rm(directory, { recursive: true, force: true });
  };
  try {
    const download = await streamDownload(sourceUrl, sourcePath, options);
    if (options.expectedBytes && download.bytes !== options.expectedBytes) {
      throw conversionError(502, 'PRESENTATION_SIZE_MISMATCH', 'La presentación descargada no coincide con el catálogo.');
    }
    await runLibreOffice(sourcePath, outputDirectory, {
      executable: options.executable,
      spawnImpl: options.spawnImpl,
      timeoutMs: options.timeoutMs,
      profileDirectory: path.join(directory, 'u')
    });
    const pdfBytes = await verifyPdf(pdfPath);
    return { cleanup, directory, download, pdfBytes, pdfPath, sourcePath };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = {
  DEFAULT_MAX_SOURCE_BYTES,
  libreOfficePath,
  preparePresentationPdf,
  runLibreOffice,
  shortTempRoot,
  streamDownload,
  verifyPdf
};
