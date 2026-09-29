#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getDocument, version as pdfjsVersion } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { strFromU8, unzipSync } from 'fflate';

const require = createRequire(import.meta.url);
const { extractPresentationAccessibility } = require('../api/_lib/cms/presentation-accessibility.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_ROOT = path.join(ROOT, 'work', 'evidence', 'presentation-pdf-v3');
const SOFFICE = 'C:\\Program Files\\LibreOffice\\program\\soffice.com';
const SOFFICE_EXE = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEFAULT_SITE = 'https://cursos-biblicos-web.vercel.app';
const SCHEMA_VERSION = 3;
const PRESENTATION_TYPES = new Set(['pptx', 'ppsx']);
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 180_000;
const PUBLIC_BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;

function parseArguments(argv) {
  const options = { mode: 'fixture', site: DEFAULT_SITE, outputRoot: EVIDENCE_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--mode') options.mode = argv[++index] || '';
    else if (value === '--site') options.site = argv[++index] || '';
    else if (value === '--output-root') options.outputRoot = path.resolve(argv[++index] || '');
    else if (value === '--no-browser') options.browser = false;
    else if (value === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!['fixture', 'corpus'].includes(options.mode)) throw new Error('Mode must be fixture or corpus.');
  if (options.browser !== false) options.browser = true;
  const site = new URL(options.site);
  if (site.protocol !== 'https:' && site.hostname !== '127.0.0.1') throw new Error('Site must use HTTPS.');
  options.site = site.origin;
  return options;
}

function usage() {
  return [
    'Usage: node scripts/presentation-pdf-pipeline-v3.mjs --mode fixture|corpus',
    '',
    'The pipeline is read-only with respect to source decks and production storage.',
    'All downloaded sources, PDFs, screenshots, and ledgers are written under work/evidence.'
  ].join('\n');
}

function safeSlug(value) {
  const normalized = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return normalized.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'presentation';
}

function runIdentifier(mode) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${mode}-${crypto.randomBytes(4).toString('hex')}`;
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function sha256File(file) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, file);
}

async function freshRunDirectory(root, id) {
  await fs.mkdir(root, { recursive: true });
  const directory = path.join(root, id);
  await fs.mkdir(directory, { recursive: false });
  const contents = await fs.readdir(directory);
  if (contents.length) throw new Error('Fresh run directory is not empty.');
  return directory;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('es')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokenCoverage(expectedText, actualText) {
  const expected = normalizeText(expectedText).split(/\s+/).filter(Boolean);
  const actual = normalizeText(actualText).split(/\s+/).filter(Boolean);
  if (!expected.length) return { ratio: 1, expectedTokens: 0, matchedTokens: 0, missingTokens: [] };
  const counts = new Map();
  for (const token of actual) counts.set(token, (counts.get(token) || 0) + 1);
  let matched = 0;
  const missing = [];
  for (const token of expected) {
    const count = counts.get(token) || 0;
    if (count > 0) {
      matched += 1;
      counts.set(token, count - 1);
    } else if (missing.length < 40) missing.push(token);
  }
  return {
    ratio: Number((matched / expected.length).toFixed(6)),
    expectedTokens: expected.length,
    matchedTokens: matched,
    missingTokens: missing
  };
}

function trustedSourceUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !PUBLIC_BLOB_HOST.test(url.hostname) || url.username || url.password) {
    throw new Error('UNTRUSTED_PRESENTATION_SOURCE');
  }
  return url.href;
}

async function fetchBuffer(url, maxBytes = 5 * 1024 * 1024) {
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('REMOTE_BODY_TOO_LARGE');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('REMOTE_BODY_TOO_LARGE');
  return Buffer.from(bytes);
}

async function downloadSource(url, target) {
  const trusted = trustedSourceUrl(url);
  const response = await fetch(trusted, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
  trustedSourceUrl(response.url);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SOURCE_BYTES) throw new Error('SOURCE_TOO_LARGE');
  if (!response.body) throw new Error('SOURCE_BODY_MISSING');
  const temporary = `${target}.download`;
  const handle = await fs.open(temporary, 'wx');
  let bytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) {
        await reader.cancel('SOURCE_TOO_LARGE');
        throw new Error('SOURCE_TOO_LARGE');
      }
      await handle.write(value);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await fs.rename(temporary, target);
  return { bytes, contentType: response.headers.get('content-type') || '' };
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)));
}

function sourceDetails(bytes) {
  const accessibility = extractPresentationAccessibility(new Uint8Array(bytes));
  const archive = unzipSync(new Uint8Array(bytes), {
    filter(file) {
      return /^ppt\/(slides|slideLayouts|slideMasters|theme)\//i.test(file.name) || /^ppt\/presentation\.xml$/i.test(file.name);
    }
  });
  const fonts = new Set();
  for (const [name, data] of Object.entries(archive)) {
    if (!name.toLowerCase().endsWith('.xml')) continue;
    const xml = strFromU8(data);
    for (const match of xml.matchAll(/\btypeface\s*=\s*(["'])(.*?)\1/gi)) {
      const face = decodeXml(match[2]).trim();
      if (face && !face.startsWith('+') && !face.startsWith('-')) fonts.add(face);
    }
  }
  const slides = accessibility.slides.map(slide => {
    const relationName = slide.sourcePart.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels';
    const relationships = archive[relationName] ? strFromU8(archive[relationName]) : '';
    const mediaRelationships = [...relationships.matchAll(/<Relationship\b[^>]*\bTarget\s*=\s*(["'])(.*?)\1[^>]*>/gi)]
      .filter(match => /(?:^|\/)media\//i.test(match[2])).length;
    return {
      number: slide.number,
      sourcePart: slide.sourcePart,
      text: slide.text,
      textSha256: sha256Bytes(Buffer.from(normalizeText(slide.text), 'utf8')),
      expectedCharacters: normalizeText(slide.text).length,
      mediaRelationships
    };
  });
  return { slideCount: accessibility.slideCount, slides, fonts: [...fonts].sort((a, b) => a.localeCompare(b)) };
}

function powershellJson(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`POWERSHELL_FAILED: ${(result.stderr || result.stdout).trim()}`);
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : [];
}

function processSnapshot(names) {
  const escaped = names.map(name => `'${name.replaceAll("'", "''")}'`).join(',');
  const script = `$names=@(${escaped}); @(Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate) | ConvertTo-Json -Compress`;
  const value = powershellJson(script);
  return Array.isArray(value) ? value : value ? [value] : [];
}

function processKey(item) {
  return Number(item.ProcessId);
}

async function waitForNoOwnedProcesses(names, baseline, marker, timeoutMs = 15_000) {
  const baselineIds = new Set(baseline.map(processKey));
  const deadline = Date.now() + timeoutMs;
  let owned = [];
  while (Date.now() < deadline) {
    const current = processSnapshot(names);
    owned = current.filter(item => !baselineIds.has(processKey(item)) && String(item.CommandLine || '').toLowerCase().includes(marker.toLowerCase()));
    if (!owned.length) return { clean: true, detached: [] };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { clean: false, detached: owned };
}

function pathToFileUri(directory) {
  return pathToFileURL(`${path.resolve(directory)}${path.sep}`).href.replace(/\/$/, '');
}

async function runProcess(executable, args, options = {}) {
  const startedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs || 120_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ pid: child.pid, code, signal, timedOut, startedAt, finishedAt: new Date().toISOString(), stdout, stderr });
    });
  });
}

async function engineDetails() {
  for (const executable of [SOFFICE, SOFFICE_EXE]) {
    const stats = await fs.stat(executable).catch(() => null);
    if (!stats?.isFile()) throw new Error(`LibreOffice executable is missing: ${executable}`);
  }
  const version = spawnSync(SOFFICE, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (version.status !== 0) throw new Error(`LibreOffice version check failed: ${version.stderr}`);
  const signature = powershellJson(`$s=Get-AuthenticodeSignature -LiteralPath '${SOFFICE_EXE.replaceAll("'", "''")}'; [pscustomobject]@{Status=[string]$s.Status;Subject=$s.SignerCertificate.Subject;Thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress`);
  if (signature.Status !== 'Valid') throw new Error(`LibreOffice signature is not valid: ${signature.Status}`);
  return {
    product: 'LibreOffice Impress',
    version: version.stdout.trim(),
    executable: SOFFICE,
    signedExecutable: SOFFICE_EXE,
    signature
  };
}

async function installedFontNames() {
  const script = [
    "$paths=@('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts','HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')",
    '$names=@()',
    'foreach($path in $paths){if(Test-Path -LiteralPath $path){$names += (Get-ItemProperty -LiteralPath $path).PSObject.Properties | Where-Object {$_.MemberType -eq \'NoteProperty\'} | ForEach-Object {$_.Name}}}',
    '@($names | Sort-Object -Unique) | ConvertTo-Json -Compress'
  ].join(';');
  const value = powershellJson(script);
  const names = Array.isArray(value) ? value : value ? [value] : [];
  return names.map(name => String(name).replace(/\s*\([^)]*\)\s*$/, '').trim());
}

function fontAvailability(sourceFonts, installedFonts) {
  const installed = installedFonts.map(normalizeText);
  return sourceFonts.map(font => {
    const normalized = normalizeText(font);
    const available = installed.some(candidate => candidate === normalized || candidate.startsWith(`${normalized} `));
    return { font, available };
  });
}

async function convertWithLibreOffice(source, outputDirectory) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursos-lo-v3-'));
  const profileDirectory = path.join(stagingDirectory, 'profile');
  const stagingOutput = path.join(stagingDirectory, 'output');
  const stagingSource = path.join(stagingDirectory, `source${path.extname(source).toLowerCase()}`);
  await fs.mkdir(profileDirectory, { recursive: false });
  await fs.mkdir(stagingOutput, { recursive: false });
  await fs.copyFile(source, stagingSource, fsSync.constants.COPYFILE_EXCL);
  const sourceSha256 = await sha256File(source);
  const stagedSourceSha256 = await sha256File(stagingSource);
  if (sourceSha256 !== stagedSourceSha256) throw new Error('LIBREOFFICE_STAGING_CHECKSUM_MISMATCH');
  const baseline = processSnapshot(['soffice.exe', 'soffice.bin']);
  const profileUri = pathToFileUri(profileDirectory);
  const args = [
    '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--nolockcheck',
    `-env:UserInstallation=${profileUri}`,
    '--convert-to', 'pdf:impress_pdf_Export', '--outdir', stagingOutput, stagingSource
  ];
  const execution = await runProcess(SOFFICE, args, { timeoutMs: CONVERSION_TIMEOUT_MS });
  const cleanup = await waitForNoOwnedProcesses(['soffice.exe', 'soffice.bin'], baseline, profileUri);
  const stagingPdf = path.join(stagingOutput, 'source.pdf');
  const stagingStats = await fs.stat(stagingPdf).catch(() => null);
  if (execution.timedOut) throw Object.assign(new Error('LIBREOFFICE_TIMEOUT'), { execution, cleanup, stagingDirectory });
  if (execution.code !== 0 || !stagingStats?.isFile() || stagingStats.size < 100) {
    if (cleanup.clean) await fs.rm(stagingDirectory, { recursive: true, force: true });
    throw Object.assign(new Error('LIBREOFFICE_CONVERSION_FAILED'), { execution, cleanup, stagingDirectory });
  }
  if (!cleanup.clean) throw Object.assign(new Error('LIBREOFFICE_DETACHED_PROCESS'), { execution, cleanup, stagingDirectory });
  const stem = path.basename(source, path.extname(source));
  const pdf = path.join(outputDirectory, `${stem}.pdf`);
  const temporaryPdf = `${pdf}.copying`;
  await fs.copyFile(stagingPdf, temporaryPdf, fsSync.constants.COPYFILE_EXCL);
  if (await sha256File(temporaryPdf) !== await sha256File(stagingPdf)) throw new Error('LIBREOFFICE_OUTPUT_COPY_CHECKSUM_MISMATCH');
  await fs.rename(temporaryPdf, pdf);
  await fs.rm(stagingDirectory, { recursive: true, force: true });
  return { pdf, bytes: stagingStats.size, execution, processCleanup: cleanup, temporaryStagingRemoved: true };
}

async function inspectPdf(pdf) {
  const data = new Uint8Array(await fs.readFile(pdf));
  const loading = getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  const document = await loading.promise;
  const pages = [];
  try {
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => String(item.str || '')).join(' ').replace(/\s+/g, ' ').trim();
      const outputFonts = [...new Set(Object.values(textContent.styles || {}).map(style => style?.fontFamily).filter(Boolean))].sort();
      pages.push({ number, text, normalizedTextSha256: sha256Bytes(Buffer.from(normalizeText(text), 'utf8')), outputFonts });
      page.cleanup();
    }
  } finally {
    await loading.destroy();
  }
  return { pageCount: pages.length, pages };
}

function presentationInventory(catalog) {
  const items = [];
  for (const course of catalog.courses || []) {
    for (const lesson of course.lessons || []) {
      const type = String(lesson.type || '').toLowerCase();
      if (!PRESENTATION_TYPES.has(type)) continue;
      items.push({
        ordinal: items.length + 1,
        courseId: course.id,
        courseName: course.name,
        lessonId: lesson.id,
        title: lesson.title,
        type,
        originalName: lesson.originalName || `${lesson.title}.${type}`,
        downloadUrl: lesson.downloadUrl || lesson.url,
        pathname: lesson.pathname || ''
      });
    }
  }
  return items;
}

function fixtureCapturePages(deckIndex, source) {
  if (deckIndex === 0) return [
    { number: 1, reason: 'required-deck-1-slide-1' },
    { number: 15, reason: 'required-deck-1-slide-15' }
  ];
  const rankedText = [...source.slides].sort((a, b) => b.expectedCharacters - a.expectedCharacters || a.number - b.number);
  const textHeavy = rankedText[0];
  const rankedMedia = [...source.slides].sort((a, b) => b.mediaRelationships - a.mediaRelationships || b.expectedCharacters - a.expectedCharacters || a.number - b.number);
  const imageHeavy = rankedMedia.find(slide => slide.number !== textHeavy.number) || rankedMedia[0];
  return [
    { number: textHeavy.number, reason: 'deck-2-text-heavy' },
    { number: imageHeavy.number, reason: 'deck-2-image-heavy' }
  ];
}

function browserAuditHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<title>Presentation PDF pixel audit v3</title>
<style>html,body{margin:0;background:#111;overflow:hidden}canvas{display:block;margin:0;background:#fff}</style>
<canvas id="page"></canvas>
<script type="module">
import * as pdfjsLib from '/vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
const canvas = document.getElementById('page');
const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false });

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/\\p{M}+/gu, '').toLocaleLowerCase('es').replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim();
}

async function pixelDigest(data) {
  const digest = await crypto.subtle.digest('SHA-256', data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function pixelMetrics(image, textBoxes) {
  const data = image.data;
  const width = image.width;
  const height = image.height;
  const corners = [[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y]) => {
    const at = (y * width + x) * 4;
    return [data[at],data[at+1],data[at+2]];
  });
  const background = corners.reduce((sum, color) => sum.map((value, index) => value + color[index]), [0,0,0]).map(value => value / corners.length);
  let samples = 0;
  let sum = 0;
  let sumSquares = 0;
  let nonBackground = 0;
  const colors = new Set();
  const stride = Math.max(1, Math.floor(Math.sqrt(width * height / 220000)));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const at = (y * width + x) * 4;
      const r = data[at], g = data[at+1], b = data[at+2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luma;
      sumSquares += luma * luma;
      samples += 1;
      if (Math.hypot(r-background[0], g-background[1], b-background[2]) > 18) nonBackground += 1;
      if (colors.size < 4096) colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }
  let contrastBoxes = 0;
  let checkedBoxes = 0;
  for (const box of textBoxes.slice(0, 300)) {
    if (box.width < 2 || box.height < 2) continue;
    const left = Math.max(0, Math.floor(box.x));
    const top = Math.max(0, Math.floor(box.y));
    const right = Math.min(width - 1, Math.ceil(box.x + box.width));
    const bottom = Math.min(height - 1, Math.ceil(box.y + box.height));
    if (right <= left || bottom <= top) continue;
    let minimum = 255;
    let maximum = 0;
    const stepX = Math.max(1, Math.floor((right-left)/30));
    const stepY = Math.max(1, Math.floor((bottom-top)/12));
    for (let y = top; y <= bottom; y += stepY) for (let x = left; x <= right; x += stepX) {
      const at = (y * width + x) * 4;
      const luma = 0.2126*data[at]+0.7152*data[at+1]+0.0722*data[at+2];
      minimum = Math.min(minimum, luma);
      maximum = Math.max(maximum, luma);
    }
    checkedBoxes += 1;
    if (maximum - minimum >= 8) contrastBoxes += 1;
  }
  const mean = sum / Math.max(1, samples);
  const standardDeviation = Math.sqrt(Math.max(0, sumSquares / Math.max(1, samples) - mean * mean));
  return {
    width, height,
    meanLuma: Number(mean.toFixed(4)),
    standardDeviation: Number(standardDeviation.toFixed(4)),
    nonBackgroundRatio: Number((nonBackground / Math.max(1, samples)).toFixed(6)),
    quantizedColorCount: colors.size,
    checkedTextBoxes: checkedBoxes,
    contrastingTextBoxes: contrastBoxes,
    textBoxContrastRatio: Number((contrastBoxes / Math.max(1, checkedBoxes)).toFixed(6))
  };
}

async function openPdf(url) {
  const task = pdfjsLib.getDocument({ url, isEvalSupported: false, useSystemFonts: true });
  return { task, document: await task.promise };
}

async function renderPage(document, number, targetWidth) {
  const page = await document.getPage(number);
  const unit = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: targetWidth / unit.width });
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  canvas.style.width = canvas.width + 'px';
  canvas.style.height = canvas.height + 'px';
  await page.render({ canvasContext: context, viewport }).promise;
  const textContent = await page.getTextContent();
  const textBoxes = [];
  let totalCharacters = 0;
  let visibleCharacters = 0;
  let clippedCharacters = 0;
  for (const item of textContent.items) {
    const text = String(item.str || '');
    if (!text.trim()) continue;
    const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const height = Math.max(0, Math.hypot(transform[2], transform[3]));
    const width = Math.max(0, Number(item.width || 0) * viewport.scale);
    const x = transform[4];
    const y = transform[5] - height;
    const intersects = x + width > 0 && x < viewport.width && y + height > 0 && y < viewport.height && height >= 1 && width >= 0.5;
    const fullyInside = x >= -0.5 && y >= -0.5 && x + width <= viewport.width + 0.5 && y + height <= viewport.height + 0.5;
    totalCharacters += text.length;
    if (intersects) visibleCharacters += text.length;
    if (intersects && !fullyInside) clippedCharacters += text.length;
    if (intersects) textBoxes.push({ x, y, width, height });
  }
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = pixelMetrics(image, textBoxes);
  pixels.pixelSha256 = await pixelDigest(image.data);
  const text = textContent.items.map(item => String(item.str || '')).join(' ').replace(/\\s+/g, ' ').trim();
  page.cleanup();
  return {
    number,
    text,
    normalizedText: normalize(text),
    geometry: {
      totalCharacters,
      visibleCharacters,
      clippedCharacters,
      visibleCharacterRatio: Number((visibleCharacters / Math.max(1, totalCharacters)).toFixed(6)),
      clippedCharacterRatio: Number((clippedCharacters / Math.max(1, totalCharacters)).toFixed(6))
    },
    pixels
  };
}

window.auditPdf = async (url, targetWidth = 960) => {
  const { task, document } = await openPdf(url);
  const pages = [];
  try { for (let number = 1; number <= document.numPages; number += 1) pages.push(await renderPage(document, number, targetWidth)); }
  finally { await task.destroy(); }
  return { pageCount: pages.length, pages };
};

window.showPdfPage = async (url, number, targetWidth = 1440) => {
  const { task, document } = await openPdf(url);
  try { return await renderPage(document, number, targetWidth); }
  finally { await task.destroy(); }
};

document.documentElement.dataset.auditReady = 'true';
</script>`;
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed.'));
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function startProofServer(pdfMap) {
  const html = Buffer.from(browserAuditHtml());
  const vendor = new Map([
    ['/vendor/pdf.min.mjs', path.join(ROOT, 'vendor', 'pdf.min.mjs')],
    ['/vendor/pdf.worker.min.mjs', path.join(ROOT, 'vendor', 'pdf.worker.min.mjs')]
  ]);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/audit.html') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(html);
        return;
      }
      if (vendor.has(url.pathname)) {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        fsSync.createReadStream(vendor.get(url.pathname)).pipe(response);
        return;
      }
      if (url.pathname.startsWith('/pdf/')) {
        const key = decodeURIComponent(url.pathname.slice('/pdf/'.length));
        const file = pdfMap.get(key);
        if (!file) throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
        response.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
        fsSync.createReadStream(file).pipe(response);
        return;
      }
      throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
    } catch (error) {
      response.writeHead(error.statusCode || 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function waitForDevtools(child, timeoutMs = 20_000) {
  return await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`CHROME_DEVTOOLS_TIMEOUT: ${stderr}`)), timeoutMs);
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ browserWebSocketUrl: match[1], stderr });
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before DevTools was available (${code}): ${stderr}`));
    });
    child.once('error', reject);
  });
}

async function startChrome(profileDirectory) {
  const baseline = processSnapshot(['chrome.exe']);
  await fs.mkdir(profileDirectory, { recursive: false });
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDirectory}`,
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-extensions', '--disable-sync', '--metrics-recording-only', '--no-first-run',
    '--no-default-browser-check', '--password-store=basic', '--use-mock-keychain', 'about:blank'
  ];
  const child = spawn(CHROME, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const devtools = await waitForDevtools(child);
  const browser = new CdpClient(devtools.browserWebSocketUrl);
  await browser.ready;
  return { child, browser, baseline, profileDirectory, marker: profileDirectory.toLowerCase(), stderr: devtools.stderr };
}

async function stopChrome(chrome) {
  try { await chrome.browser.send('Browser.close'); } catch {}
  chrome.browser.close();
  if (chrome.child.exitCode === null) {
    await Promise.race([
      new Promise(resolve => chrome.child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 10_000))
    ]);
  }
  const cleanup = await waitForNoOwnedProcesses(['chrome.exe'], chrome.baseline, chrome.marker, 15_000);
  if (cleanup.clean) await fs.rm(chrome.profileDirectory, { recursive: true, force: true });
  return cleanup;
}

async function createAuditTab(chrome, url) {
  const endpoint = new URL(chrome.browserWebSocketUrl);
  const port = endpoint.port;
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`CHROME_TARGET_${response.status}`);
  const target = await response.json();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = await client.send('Runtime.evaluate', { expression: "document.documentElement.dataset.auditReady === 'true'", returnByValue: true });
    if (ready.result?.value === true) return client;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('PDF_AUDIT_PAGE_TIMEOUT');
}

async function evaluateValue(client, expression, timeoutMs = 180_000) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('CDP_EVALUATION_TIMEOUT')), timeoutMs));
  const evaluation = client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const result = await Promise.race([evaluation, timeout]);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'CDP_EVALUATION_FAILED');
  return result.result?.value;
}

async function browserAuditPdfs(records, runDirectory) {
  const pdfMap = new Map(records.map(record => [record.key, record.files.pdfAbsolute]));
  const proofServer = await startProofServer(pdfMap);
  const profile = path.join(runDirectory, 'chrome-profile');
  const chrome = await startChrome(profile);
  let tab;
  try {
    tab = await createAuditTab(chrome, `${proofServer.origin}/audit.html`);
    for (const record of records) {
      const pdfUrl = `${proofServer.origin}/pdf/${encodeURIComponent(record.key)}`;
      record.browser = await evaluateValue(tab, `window.auditPdf(${JSON.stringify(pdfUrl)}, 960)`, 300_000);
      for (const capture of record.capturePages) {
        const rendered = await evaluateValue(tab, `window.showPdfPage(${JSON.stringify(pdfUrl)}, ${capture.number}, 1440)`, 120_000);
        await tab.send('Emulation.setDeviceMetricsOverride', {
          width: rendered.pixels.width,
          height: rendered.pixels.height,
          deviceScaleFactor: 1,
          mobile: false
        });
        await evaluateValue(tab, `window.showPdfPage(${JSON.stringify(pdfUrl)}, ${capture.number}, 1440)`, 120_000);
        const screenshot = await tab.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
        const file = path.join(runDirectory, 'screenshots', `${record.key}-slide-${String(capture.number).padStart(3, '0')}.png`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
        capture.screenshot = path.relative(runDirectory, file).replaceAll(path.sep, '/');
        capture.pixelSha256 = rendered.pixels.pixelSha256;
      }
    }
  } finally {
    tab?.close();
    const cleanup = await stopChrome(chrome);
    await new Promise(resolve => proofServer.server.close(resolve));
    if (!cleanup.clean) throw Object.assign(new Error('CHROME_DETACHED_PROCESS'), { cleanup });
  }
}

function reconcileDeck(record) {
  const issues = [];
  if (record.source.slideCount !== record.pdf.pageCount) issues.push({ code: 'PAGE_COUNT_MISMATCH', expected: record.source.slideCount, actual: record.pdf.pageCount });
  if (record.browser && record.browser.pageCount !== record.pdf.pageCount) issues.push({ code: 'BROWSER_PAGE_COUNT_MISMATCH', expected: record.pdf.pageCount, actual: record.browser.pageCount });
  if (!record.conversion.processCleanup.clean) issues.push({ code: 'LIBREOFFICE_PROCESS_LEAK' });
  for (const font of record.fonts.filter(item => !item.available)) issues.push({ code: 'MISSING_SOURCE_FONT', font: font.font });
  const pages = [];
  for (const sourcePage of record.source.slides) {
    const pdfPage = record.pdf.pages[sourcePage.number - 1];
    const browserPage = record.browser?.pages?.[sourcePage.number - 1];
    const coverage = tokenCoverage(sourcePage.text, pdfPage?.text || '');
    const pageIssues = [];
    if (sourcePage.expectedCharacters > 0 && coverage.ratio < 0.98) pageIssues.push({ code: 'MISSING_EXPECTED_TEXT', coverage });
    if (browserPage) {
      if (browserPage.pixels.standardDeviation < 1.5 && browserPage.pixels.nonBackgroundRatio < 0.001) pageIssues.push({ code: 'BLANK_RENDERED_PAGE' });
      if (sourcePage.expectedCharacters > 0 && browserPage.geometry.visibleCharacterRatio < 0.98) pageIssues.push({ code: 'TEXT_OUTSIDE_PAGE', geometry: browserPage.geometry });
      if (sourcePage.expectedCharacters > 0 && browserPage.geometry.clippedCharacterRatio > 0.005) pageIssues.push({ code: 'CLIPPED_TEXT', geometry: browserPage.geometry });
      if (sourcePage.expectedCharacters > 0 && browserPage.pixels.checkedTextBoxes > 0 && browserPage.pixels.textBoxContrastRatio < 0.75) pageIssues.push({ code: 'LOW_TEXT_PIXEL_CONTRAST', pixels: browserPage.pixels });
    }
    pages.push({
      number: sourcePage.number,
      expectedText: sourcePage.text,
      renderedText: pdfPage?.text || '',
      coverage,
      pixelEvidence: browserPage ? browserPage.pixels : null,
      geometryEvidence: browserPage ? browserPage.geometry : null,
      issues: pageIssues
    });
    for (const issue of pageIssues) issues.push({ slide: sourcePage.number, ...issue });
  }
  if (record.ordinal === 1) {
    const slide1 = pages[0];
    const slide15 = pages[14];
    if (!normalizeText(slide1?.renderedText).includes(normalizeText('Las Sagradas Escrituras'))) issues.push({ code: 'REQUIRED_SLIDE_1_TEXT_MISSING' });
    if (!normalizeText(slide15?.renderedText).includes(normalizeText('Respuesta: Para siempre'))) issues.push({ code: 'REQUIRED_SLIDE_15_TEXT_MISSING' });
  }
  return { status: issues.length ? 'flagged' : 'passed', issues, pages };
}

function publicDeckResult(record, runDirectory) {
  return {
    schemaVersion: SCHEMA_VERSION,
    key: record.key,
    ordinal: record.ordinal,
    courseId: record.courseId,
    courseName: record.courseName,
    lessonId: record.lessonId,
    title: record.title,
    type: record.type,
    originalName: record.originalName,
    pathname: record.pathname,
    status: record.reconciliation.status,
    stages: record.stages,
    source: {
      bytes: record.source.bytes,
      sha256: record.source.sha256,
      slideCount: record.source.slideCount,
      fonts: record.source.fonts
    },
    engine: record.engine,
    rendered: {
      format: 'application/pdf',
      bytes: record.pdf.bytes,
      sha256: record.pdf.sha256,
      pageCount: record.pdf.pageCount,
      pdfjsVersion,
      relativePath: path.relative(runDirectory, record.files.pdfAbsolute).replaceAll(path.sep, '/')
    },
    conversion: record.conversion,
    fonts: record.fonts,
    capturePages: record.capturePages,
    reconciliation: record.reconciliation
  };
}

async function processDeck(item, context) {
  const key = `${String(item.ordinal).padStart(2, '0')}-${safeSlug(item.title)}`;
  const directory = path.join(context.runDirectory, 'decks', key);
  const sourceDirectory = path.join(directory, 'source');
  const outputDirectory = path.join(directory, 'rendered');
  await fs.mkdir(sourceDirectory, { recursive: true });
  const sourceFile = path.join(sourceDirectory, path.basename(item.originalName));
  const record = { ...item, key, engine: context.engine, stages: [], files: {} };
  const stage = (name, status, detail = {}) => record.stages.push({ name, status, at: new Date().toISOString(), ...detail });
  try {
    stage('download', 'started');
    const downloaded = await downloadSource(item.downloadUrl, sourceFile);
    stage('download', 'completed', downloaded);
    const bytes = await fs.readFile(sourceFile);
    const details = sourceDetails(bytes);
    record.source = { ...details, bytes: bytes.byteLength, sha256: sha256Bytes(bytes) };
    stage('source-inspection', 'completed', { slideCount: details.slideCount, sha256: record.source.sha256 });
    record.fonts = fontAvailability(details.fonts, context.installedFonts);
    stage('font-check', 'completed', { declared: record.fonts.length, missing: record.fonts.filter(font => !font.available).length });
    stage('conversion', 'started');
    const conversion = await convertWithLibreOffice(sourceFile, outputDirectory);
    record.files.pdfAbsolute = conversion.pdf;
    record.conversion = {
      status: 'completed',
      startedAt: conversion.execution.startedAt,
      finishedAt: conversion.execution.finishedAt,
      exitCode: conversion.execution.code,
      timedOut: conversion.execution.timedOut,
      stdout: conversion.execution.stdout.trim(),
      stderr: conversion.execution.stderr.trim(),
      processCleanup: conversion.processCleanup
    };
    stage('conversion', 'completed', { bytes: conversion.bytes });
    stage('pdf-inspection', 'started');
    const pdf = await inspectPdf(conversion.pdf);
    record.pdf = { ...pdf, bytes: conversion.bytes, sha256: await sha256File(conversion.pdf) };
    stage('pdf-inspection', 'completed', { pageCount: pdf.pageCount, sha256: record.pdf.sha256 });
    record.capturePages = context.mode === 'fixture' ? fixtureCapturePages(item.ordinal - 1, record.source) : [];
    return record;
  } catch (error) {
    stage(record.stages.at(-1)?.name || 'unknown', 'failed', { error: error.message });
    record.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
      execution: error.execution,
      cleanup: error.cleanup
    };
    const failure = {
      schemaVersion: SCHEMA_VERSION,
      key,
      ordinal: item.ordinal,
      title: item.title,
      status: 'failed',
      stages: record.stages,
      error: record.error
    };
    await atomicWriteJson(path.join(context.runDirectory, 'results', `${key}.json`), failure);
    throw Object.assign(error, { deckRecord: failure });
  }
}

async function finalProcessAudit(baseline, runDirectory) {
  const currentLibreOffice = processSnapshot(['soffice.exe', 'soffice.bin']);
  const currentChrome = processSnapshot(['chrome.exe']);
  const baselineLibreOffice = new Set(baseline.libreOffice.map(processKey));
  const baselineChrome = new Set(baseline.chrome.map(processKey));
  const marker = String(runDirectory || '').toLowerCase();
  return {
    libreOfficeDetached: currentLibreOffice.filter(item => !baselineLibreOffice.has(processKey(item))),
    chromeDetached: currentChrome.filter(item => !baselineChrome.has(processKey(item)) && String(item.CommandLine || '').toLowerCase().includes(marker))
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const id = runIdentifier(options.mode);
  const runDirectory = await freshRunDirectory(options.outputRoot, id);
  const baseline = {
    libreOffice: processSnapshot(['soffice.exe', 'soffice.bin']),
    chrome: processSnapshot(['chrome.exe'])
  };
  const engine = await engineDetails();
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    harness: 'presentation-pdf-pipeline-v3',
    runId: id,
    status: 'started',
    mode: options.mode,
    createdAt: new Date().toISOString(),
    site: options.site,
    runDirectory,
    freshDirectoryVerified: true,
    sourceMutationAllowed: false,
    productionUploadAllowed: false,
    engine,
    browser: { executable: CHROME, pdfjsVersion },
    processBaseline: {
      libreOffice: baseline.libreOffice.map(item => item.ProcessId),
      chrome: baseline.chrome.map(item => item.ProcessId)
    }
  };
  await atomicWriteJson(path.join(runDirectory, 'run-manifest.json'), manifest);
  process.stdout.write(`Run ${id}\nEvidence ${runDirectory}\n`);
  let completed = false;
  try {
    const catalogBody = await fetchBuffer(`${options.site}/api/catalog`, 10 * 1024 * 1024);
    const catalog = JSON.parse(catalogBody.toString('utf8'));
    const allItems = presentationInventory(catalog);
    if (allItems.length !== 30) throw new Error(`CATALOG_PRESENTATION_COUNT_${allItems.length}`);
    const items = options.mode === 'fixture' ? allItems.slice(0, 2) : allItems;
    const installedFonts = await installedFontNames();
    const context = { runDirectory, mode: options.mode, engine, installedFonts };
    const records = [];
    for (const item of items) {
      process.stdout.write(`[${item.ordinal}/${items.length}] ${item.title}: converting\n`);
      const record = await processDeck(item, context);
      records.push(record);
      process.stdout.write(`[${item.ordinal}/${items.length}] ${item.title}: ${record.source.slideCount} -> ${record.pdf.pageCount} pages\n`);
    }
    if (options.browser) {
      process.stdout.write(`Rendering ${records.reduce((sum, record) => sum + record.pdf.pageCount, 0)} pages in fresh Chrome\n`);
      await browserAuditPdfs(records, runDirectory);
    }
    for (const record of records) {
      record.reconciliation = reconcileDeck(record);
      await atomicWriteJson(path.join(runDirectory, 'results', `${record.key}.json`), publicDeckResult(record, runDirectory));
    }
    const processAudit = await finalProcessAudit(baseline, runDirectory);
    const sourceSlides = records.reduce((sum, record) => sum + record.source.slideCount, 0);
    const pdfPages = records.reduce((sum, record) => sum + record.pdf.pageCount, 0);
    const exactInventory = options.mode === 'fixture'
      ? records.length === 2
      : records.length === 30 && sourceSlides === 570 && pdfPages === 570;
    const allDecksPassed = records.every(record => record.reconciliation.status === 'passed');
    const cleanProcesses = processAudit.libreOfficeDetached.length === 0 && processAudit.chromeDetached.length === 0;
    const ledger = {
      schemaVersion: SCHEMA_VERSION,
      runId: id,
      mode: options.mode,
      status: allDecksPassed && exactInventory && cleanProcesses ? 'passed' : 'flagged',
      finishedAt: new Date().toISOString(),
      catalog: {
        revision: catalog.revision,
        sha256: sha256Bytes(catalogBody),
        totalPresentations: allItems.length,
        processedPresentations: records.length
      },
      reconciliation: {
        exactInventory,
        sourceSlides,
        pdfPages,
        flaggedDecks: records.filter(record => record.reconciliation.status !== 'passed').map(record => ({ key: record.key, title: record.title, issueCount: record.reconciliation.issues.length })),
        processAudit,
        cleanProcesses
      },
      decks: records.map(record => ({
        key: record.key,
        title: record.title,
        status: record.reconciliation.status,
        sourceSha256: record.source.sha256,
        renderedSha256: record.pdf.sha256,
        sourceSlides: record.source.slideCount,
        pdfPages: record.pdf.pageCount,
        issueCount: record.reconciliation.issues.length
      }))
    };
    await atomicWriteJson(path.join(runDirectory, 'final-ledger.json'), ledger);
    if (ledger.status === 'passed') {
      await atomicWriteJson(path.join(runDirectory, 'accepted-summary.json'), {
        schemaVersion: SCHEMA_VERSION,
        runId: id,
        acceptedAt: new Date().toISOString(),
        mode: options.mode,
        presentationCount: records.length,
        slideCount: pdfPages,
        exactReconciliation: true,
        cleanProcessTeardown: true,
        ledgerSha256: await sha256File(path.join(runDirectory, 'final-ledger.json'))
      });
    }
    completed = true;
    process.stdout.write(`${ledger.status.toUpperCase()}: ${records.length} presentations, ${sourceSlides} source slides, ${pdfPages} PDF pages\n`);
    process.stdout.write(`Ledger ${path.join(runDirectory, 'final-ledger.json')}\n`);
    if (ledger.status !== 'passed') process.exitCode = 2;
  } catch (error) {
    const processAudit = await finalProcessAudit(baseline, runDirectory).catch(auditError => ({ auditError: auditError.message }));
    await atomicWriteJson(path.join(runDirectory, 'run-failure.json'), {
      schemaVersion: SCHEMA_VERSION,
      runId: id,
      failedAt: new Date().toISOString(),
      error: { name: error.name, message: error.message, stack: error.stack },
      deck: error.deckRecord || null,
      processAudit,
      acceptedSummaryPublished: false
    });
    process.exitCode = 1;
    process.stderr.write(`FAILED: ${error.stack || error.message}\nEvidence ${runDirectory}\n`);
  } finally {
    if (!completed) {
      const accepted = path.join(runDirectory, 'accepted-summary.json');
      await fs.rm(accepted, { force: true }).catch(() => {});
    }
  }
}

export {
  browserAuditPdfs,
  fixtureCapturePages,
  fontAvailability,
  inspectPdf,
  normalizeText,
  parseArguments,
  presentationInventory,
  reconcileDeck,
  safeSlug,
  sourceDetails,
  tokenCoverage
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
