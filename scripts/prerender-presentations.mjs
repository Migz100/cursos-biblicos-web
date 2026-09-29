import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import validation from '../api/_lib/cms/validation.js';

const { extractZipEntry, validateMagic, zipEntries } = validation;
const CATALOG_URL = 'https://cursos-biblicos-web.vercel.app/api/catalog';
const PUBLIC_BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;
const PRESENTATION_TYPES = new Set(['pptx', 'ppsx']);
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_PAGES = 500;
const CONVERSION_TIMEOUT_MS = 120_000;
const RASTER_SCALE = 4;
const MIN_OBJECT_PIXEL_RATIO = 0.01;
const MIN_OBJECT_LUMINANCE_STDDEV = 8;
const REVIEW_QUEUE_SCHEMA_VERSION = 1;
const REVIEW_LEDGER_SCHEMA_VERSION = 1;
const REQUIRED_VISUAL_CHECKS = Object.freeze([
  'exactTokenVisible',
  'fullyInsideCrop',
  'notClipped',
  'noVisualSubstitutionOrCorruption',
  'cropMatchesExpectedObject'
]);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_TEMP_ROOT = process.platform === 'win32' ? 'C:\\cbtmp' : path.join(process.cwd(), '.presentation-tmp');
const LIBREOFFICE_CANDIDATES = process.platform === 'win32'
  ? ['C:\\Program Files\\LibreOffice\\program\\soffice.com']
  : ['/usr/bin/libreoffice'];

function fail(message, code = 'VALIDATION_FAILED') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseArgs(values) {
  const options = { mode: 'prerender', catalogUrl: CATALOG_URL, tempRoot: DEFAULT_TEMP_ROOT, expectedPages: null, numbers: null, all: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--all') options.all = true;
    else if (value === '--finalize') options.mode = 'finalize';
    else if (value === '--package') options.package = values[++index];
    else if (value === '--review-ledger') options.reviewLedger = values[++index];
    else if (value === '--output') options.output = values[++index];
    else if (value === '--numbers') options.numbers = values[++index];
    else if (value === '--expected-pages') options.expectedPages = Number(values[++index]);
    else if (value === '--temp-root') options.tempRoot = values[++index];
    else if (value === '--catalog-url') options.catalogUrl = values[++index];
    else if (value === '--help') options.help = true;
    else fail(`Argumento no reconocido: ${value}`, 'INVALID_ARGUMENT');
  }
  if (options.help) return options;
  if (options.mode === 'finalize') {
    if (!options.package || !options.reviewLedger) fail('--finalize requiere --package y --review-ledger.', 'INVALID_ARGUMENT');
    if (options.output || options.numbers || options.all || options.expectedPages !== null) fail('--finalize no acepta opciones de conversión.', 'INVALID_ARGUMENT');
    return options;
  }
  if (!options.output) fail('Falta --output con un directorio nuevo.', 'INVALID_ARGUMENT');
  if (options.all === Boolean(options.numbers)) fail('Usa exactamente uno de --all o --numbers.', 'INVALID_ARGUMENT');
  if (options.catalogUrl !== CATALOG_URL) fail(`El catálogo permitido es únicamente ${CATALOG_URL}.`, 'UNTRUSTED_CATALOG');
  if (options.all && (!Number.isSafeInteger(options.expectedPages) || options.expectedPages < 1)) {
    fail('--all requiere --expected-pages.', 'INVALID_ARGUMENT');
  }
  return options;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/prerender-presentations.mjs --numbers 1,30 --output C:\\cbw\\evidencia-nueva',
    '  node scripts/prerender-presentations.mjs --all --expected-pages 570 --output C:\\cbw\\paquete-nuevo',
    '  node scripts/prerender-presentations.mjs --finalize --package C:\\cbw\\paquete --review-ledger C:\\cbw\\revision.json',
    '',
    'La herramienta sólo lee el catálogo y sus PPTX/PPSX administrados. No sube ni modifica nada.'
  ].join('\n');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<a:br\s*\/?\s*>/gi, ' ')
    .replace(/<a:tab\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeStem(value) {
  return String(value || 'presentacion')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'presentacion';
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function objectEquals(left, right) {
  return stableJson(left) === stableJson(right);
}

function trustedBlobAsset(value, expectedPathname) {
  let url;
  try { url = new URL(value); } catch { fail('La dirección del deck no es válida.', 'UNTRUSTED_SOURCE'); }
  if (url.protocol !== 'https:' || !PUBLIC_BLOB_HOST.test(url.hostname) || url.username || url.password) {
    fail(`Host de deck no permitido: ${url.hostname || 'desconocido'}`, 'UNTRUSTED_SOURCE');
  }
  const actualPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (expectedPathname && actualPath !== expectedPathname) {
    fail(`La ruta final no coincide con el activo administrado: ${actualPath}`, 'UNTRUSTED_SOURCE');
  }
  url.hash = '';
  return url;
}

function catalogNamespace(manifest, decks) {
  const namespaces = new Set(decks.map(({ lesson }) => String(lesson.pathname || '').match(/^(cms\/(?:production|preview\/[^/]+|development\/local))\/assets\//)?.[1]));
  if (namespaces.size !== 1 || namespaces.has(undefined)) fail('Los decks no comparten un namespace administrado válido.', 'UNTRUSTED_SOURCE');
  return [...namespaces][0];
}

async function fetchCatalog() {
  const response = await fetch(CATALOG_URL, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || new URL(response.url).origin !== new URL(CATALOG_URL).origin) fail(`No se pudo leer el catálogo (${response.status}).`, 'CATALOG_READ_FAILED');
  const manifest = await response.json();
  if (!Array.isArray(manifest?.courses) || typeof manifest.revision !== 'string') fail('El catálogo no tiene una forma válida.', 'CATALOG_READ_FAILED');
  return manifest;
}

function selectDecks(manifest, options) {
  const decks = manifest.courses.flatMap(course => (course.lessons || []).map((lesson, index) => ({ course, lesson, index })))
    .filter(({ lesson }) => PRESENTATION_TYPES.has(lesson.type));
  if (!decks.length) fail('El catálogo no contiene PPTX/PPSX.', 'NO_PRESENTATIONS');
  for (const { lesson } of decks) {
    if (!lesson.managed || typeof lesson.pathname !== 'string' || !lesson.pathname.includes('/assets/')) fail(`El deck ${lesson.id} no es un activo administrado.`, 'UNTRUSTED_SOURCE');
    trustedBlobAsset(lesson.url, lesson.pathname);
    if (Number(lesson.size) > MAX_SOURCE_BYTES) fail(`El deck ${lesson.id} supera el límite de 25 MB.`, 'SOURCE_TOO_LARGE');
  }
  if (options.all) return decks;
  const wanted = new Set(String(options.numbers).split(',').map(value => Number(value.trim())));
  if ([...wanted].some(number => !Number.isSafeInteger(number) || number < 1 || number > decks.length)) fail('--numbers contiene una posición inválida.', 'INVALID_ARGUMENT');
  const selected = decks.filter((_, index) => wanted.has(index + 1));
  if (selected.length !== wanted.size) fail('No se pudieron resolver todos los números solicitados.', 'INVALID_ARGUMENT');
  return selected;
}

async function streamTrustedDeck(lesson, destination) {
  let current = trustedBlobAsset(lesson.url, lesson.pathname);
  let response;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    response = await fetch(current, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    if (response.status >= 300 && response.status < 400) {
      if (redirects === MAX_REDIRECTS) fail('El deck excedió el máximo de redirecciones.', 'DOWNLOAD_FAILED');
      const location = response.headers.get('location');
      if (!location) fail('La redirección del deck no tiene destino.', 'DOWNLOAD_FAILED');
      current = trustedBlobAsset(new URL(location, current).href, lesson.pathname);
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body) fail(`No se pudo descargar ${lesson.originalName} (${response?.status || 'sin respuesta'}).`, 'DOWNLOAD_FAILED');
  trustedBlobAsset(response.url || current.href, lesson.pathname);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) fail(`${lesson.originalName} supera 25 MB.`, 'SOURCE_TOO_LARGE');
  const handle = await fs.open(destination, 'wx');
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_SOURCE_BYTES) fail(`${lesson.originalName} supera 25 MB.`, 'SOURCE_TOO_LARGE');
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  if (!total || (Number.isSafeInteger(Number(lesson.size)) && Number(lesson.size) > 0 && total !== Number(lesson.size))) {
    fail(`El tamaño descargado no coincide para ${lesson.originalName}.`, 'DOWNLOAD_FAILED');
  }
  return { bytes: total, finalUrl: response.url || current.href };
}

function themeFonts(buffer) {
  const themeEntry = zipEntries(buffer).find(entry => /^ppt\/theme\/theme\d+\.xml$/i.test(entry.name));
  if (!themeEntry) return {};
  const xml = extractZipEntry(buffer, themeEntry.name, 4 * 1024 * 1024)?.toString('utf8') || '';
  const family = section => {
    const body = xml.match(new RegExp(`<a:${section}Font\\b[\\s\\S]*?<\\/a:${section}Font>`, 'i'))?.[0] || '';
    return body.match(/<a:latin\b[^>]*\btypeface="([^"]+)"/i)?.[1] || null;
  };
  return { '+mj-lt': family('major'), '+mn-lt': family('minor') };
}

function fontFromXml(value) {
  const match = String(value || '').match(/<a:(?:latin|ea|cs)\b[^>]*\btypeface="([^"]+)"/i);
  return match?.[1] || null;
}

function xmlAttributes(value) {
  const attributes = {};
  for (const match of String(value || '').matchAll(/\b([A-Za-z_][\w:.-]*)="([^"]*)"/g)) attributes[match[1]] = decodeXml(match[2]);
  return attributes;
}

function elementBounds(xml) {
  const transform = String(xml || '').match(/<(?:a|p):xfrm\b[\s\S]*?<\/(?:a|p):xfrm>/i)?.[0];
  const transformAttributes = xmlAttributes(transform?.match(/<(?:a|p):xfrm\b[^>]*>/i)?.[0]);
  if ((transformAttributes.rot && Number(transformAttributes.rot) !== 0) || transformAttributes.flipH === '1' || transformAttributes.flipV === '1') return null;
  const offset = xmlAttributes(transform?.match(/<a:off\b[^>]*\/?\s*>/i)?.[0]);
  const extent = xmlAttributes(transform?.match(/<a:ext\b[^>]*\/?\s*>/i)?.[0]);
  const values = [offset.x, offset.y, extent.cx, extent.cy].map(value => Number(value));
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  return { x: values[0], y: values[1], cx: values[2], cy: values[3] };
}

const SOURCE_OBJECT_TYPES = [
  ['sp', 'shape'],
  ['pic', 'picture'],
  ['graphicFrame', 'graphicFrame'],
  ['cxnSp', 'connector']
];

function parseSlideObjects(xml) {
  if (/<p:grpSp\b/i.test(String(xml || ''))) fail('La diapositiva contiene un grupo de objetos cuya transformación no está resuelta.', 'UNRESOLVED_SOURCE_OBJECT');
  const objects = [];
  for (const [tag, objectType] of SOURCE_OBJECT_TYPES) {
    const elements = String(xml || '').match(new RegExp(`<p:${tag}\\b[\\s\\S]*?<\\/p:${tag}>`, 'gi')) || [];
    for (const element of elements) {
      const metadata = xmlAttributes(element.match(/<p:cNvPr\b[^>]*\/?\s*>/i)?.[0]);
      const text = decodeXml((element.match(/<a:t\b[^>]*>[\s\S]*?<\/a:t>/gi) || []).join(' '));
      const normalizedText = normalizeText(text);
      const body = element.match(/<a:bodyPr\b[^>]*\/?\s*>/i)?.[0] || '';
      const fromWordArt = xmlAttributes(body).fromWordArt === '1';
      objects.push({
        id: metadata.id || null,
        name: metadata.name || null,
        objectType,
        boundsEmu: elementBounds(element),
        text,
        normalizedText,
        tokens: normalizedText.split(' ').filter(Boolean),
        nonExtractableVectorText: Boolean(normalizedText && fromWordArt),
        vectorTextProof: normalizedText && fromWordArt ? 'a:bodyPr[fromWordArt="1"]' : null
      });
    }
  }
  return objects;
}

function presentationSlideSize(buffer) {
  const xml = extractZipEntry(buffer, 'ppt/presentation.xml', 8 * 1024 * 1024)?.toString('utf8') || '';
  const attributes = xmlAttributes(xml.match(/<p:sldSz\b[^>]*\/?\s*>/i)?.[0]);
  const cx = Number(attributes.cx);
  const cy = Number(attributes.cy);
  if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cy) || cx <= 0 || cy <= 0) fail('El deck no declara dimensiones de diapositiva válidas.', 'SOURCE_INVALID');
  return { cx, cy };
}

function masterTextFonts(buffer, theme) {
  const masterEntry = zipEntries(buffer).find(entry => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(entry.name));
  if (!masterEntry) return {};
  const xml = extractZipEntry(buffer, masterEntry.name, 8 * 1024 * 1024)?.toString('utf8') || '';
  const resolve = value => theme[value] || value || null;
  const sectionFont = name => {
    const section = xml.match(new RegExp(`<p:${name}Style\\b[\\s\\S]*?<\\/p:${name}Style>`, 'i'))?.[0] || '';
    const level = section.match(/<a:lvl1pPr\b[\s\S]*?<\/a:lvl1pPr>/i)?.[0] || section;
    return resolve(fontFromXml(level));
  };
  return { title: sectionFont('title'), body: sectionFont('body'), other: sectionFont('other') };
}

function inspectVisibleFonts(xml, theme, masterFonts) {
  const fonts = new Map();
  const ordinaryFonts = new Map();
  const vectorFonts = new Map();
  let unresolvedRuns = 0;
  const shapes = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/gi) || [];
  for (const shape of shapes) {
    const vectorText = xmlAttributes(shape.match(/<a:bodyPr\b[^>]*\/?\s*>/i)?.[0]).fromWordArt === '1';
    const placeholder = shape.match(/<p:ph\b[^>]*\btype="([^"]+)"/i)?.[1] || '';
    const inherited = /^(?:title|ctrTitle)$/i.test(placeholder)
      ? masterFonts.title
      : /^(?:body|subTitle|obj)$/i.test(placeholder)
        ? masterFonts.body
        : masterFonts.other;
    const shapeDefault = fontFromXml(shape.match(/<a:lstStyle\b[\s\S]*?<\/a:lstStyle>/i)?.[0]);
    const paragraphs = shape.match(/<a:p\b[\s\S]*?<\/a:p>/gi) || [];
    for (const paragraph of paragraphs) {
      const paragraphDefault = fontFromXml(paragraph.match(/<a:defRPr\b[\s\S]*?<\/a:defRPr>/i)?.[0]);
      const runs = paragraph.match(/<a:(?:r|fld)\b[\s\S]*?<\/a:(?:r|fld)>/gi) || [];
      for (const run of runs) {
        const text = decodeXml((run.match(/<a:t\b[^>]*>[\s\S]*?<\/a:t>/gi) || []).join(' '));
        if (!normalizeText(text)) continue;
        const direct = fontFromXml(run.match(/<a:rPr\b[\s\S]*?<\/a:rPr>/i)?.[0]);
        const raw = direct || paragraphDefault || shapeDefault || inherited;
        const resolved = theme[raw] || raw;
        if (!resolved || /^\+m[ij]-/.test(resolved)) unresolvedRuns += 1;
        else {
          fonts.set(resolved, (fonts.get(resolved) || 0) + 1);
          const modeFonts = vectorText ? vectorFonts : ordinaryFonts;
          modeFonts.set(resolved, (modeFonts.get(resolved) || 0) + 1);
        }
      }
    }
  }
  return { fonts, ordinaryFonts, vectorFonts, unresolvedRuns };
}

function inspectPresentation(buffer, type) {
  validateMagic(type, buffer.subarray(0, Math.min(buffer.length, 262144)), buffer);
  const entries = zipEntries(buffer);
  const slides = entries
    .filter(entry => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => Number(a.name.match(/\d+/)?.[0]) - Number(b.name.match(/\d+/)?.[0]));
  if (!slides.length || slides.length > MAX_PAGES) fail('El deck no tiene un número válido de diapositivas.', 'SOURCE_INVALID');
  const expectedNames = slides.map((_, index) => `ppt/slides/slide${index + 1}.xml`);
  if (slides.some((slide, index) => slide.name.toLowerCase() !== expectedNames[index].toLowerCase())) fail('La secuencia de diapositivas está incompleta.', 'SOURCE_INVALID');
  const theme = themeFonts(buffer);
  const masterFonts = masterTextFonts(buffer, theme);
  const slideSizeEmu = presentationSlideSize(buffer);
  const usedFonts = new Map();
  const ordinaryUsedFonts = new Map();
  const vectorUsedFonts = new Map();
  let unresolvedVisibleRuns = 0;
  const pages = slides.map((slide, index) => {
    const xml = extractZipEntry(buffer, slide.name, 8 * 1024 * 1024)?.toString('utf8');
    if (!xml) fail(`No se pudo leer la diapositiva ${index + 1}.`, 'SOURCE_INVALID');
    const text = decodeXml((xml.match(/<a:t\b[^>]*>[\s\S]*?<\/a:t>/gi) || []).join(' '));
    const objects = parseSlideObjects(xml);
    const parsedText = objects.map(object => object.text).filter(Boolean).join(' ');
    if (tokenCoverage(text, parsedText) !== 1 || tokenCoverage(parsedText, text) !== 1) {
      fail(`La diapositiva ${index + 1} contiene texto en un objeto OOXML no resuelto.`, 'UNRESOLVED_SOURCE_OBJECT');
    }
    for (const object of objects.filter(item => item.normalizedText)) {
      if (!object.id || !object.boundsEmu) fail(`La diapositiva ${index + 1} contiene un objeto de texto sin identidad o límites exactos.`, 'UNRESOLVED_SOURCE_OBJECT');
    }
    const visible = inspectVisibleFonts(xml, theme, masterFonts);
    for (const [font, count] of visible.fonts) usedFonts.set(font, (usedFonts.get(font) || 0) + count);
    for (const [font, count] of visible.ordinaryFonts) ordinaryUsedFonts.set(font, (ordinaryUsedFonts.get(font) || 0) + count);
    for (const [font, count] of visible.vectorFonts) vectorUsedFonts.set(font, (vectorUsedFonts.get(font) || 0) + count);
    unresolvedVisibleRuns += visible.unresolvedRuns;
    const ordinaryText = objects.filter(object => object.normalizedText && !object.nonExtractableVectorText).map(object => object.text).join(' ');
    const vectorTextObjects = objects.filter(object => object.nonExtractableVectorText);
    return {
      number: index + 1,
      text,
      normalizedText: normalizeText(text),
      ordinaryText,
      normalizedOrdinaryText: normalizeText(ordinaryText),
      objects,
      vectorTextObjects,
      sourceImages: (xml.match(/<a:blip\b/gi) || []).length,
      sourceShapes: (xml.match(/<p:(?:sp|pic|graphicFrame)\b/gi) || []).length
    };
  });
  return {
    slideCount: pages.length,
    slideSizeEmu,
    pages,
    usedFonts: [...usedFonts].map(([name, visibleRuns]) => ({
      name,
      visibleRuns,
      ordinaryVisibleRuns: ordinaryUsedFonts.get(name) || 0,
      vectorVisibleRuns: vectorUsedFonts.get(name) || 0
    })).sort((a, b) => a.name.localeCompare(b.name)),
    unresolvedVisibleRuns,
    theme,
    masterFonts
  };
}

function normalizedFont(value) {
  return String(value || '')
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/\((?:body|headings)\)/gi, '')
    .replace(/(?:-bold|-italic|-regular| ps mt| mt)$/gi, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

const FONT_STYLE_SUFFIXES = new Set(['bold', 'bolditalic', 'bolditalicmt', 'boldmt', 'italic', 'italicmt', 'mt', 'psmt', 'regular']);

function fontFamilyMatches(wanted, actual) {
  if (!wanted || !actual) return false;
  if (wanted === actual) return true;
  return actual.startsWith(wanted) && FONT_STYLE_SUFFIXES.has(actual.slice(wanted.length));
}

async function installedFontFamilies() {
  if (process.platform !== 'win32') return [];
  const command = '[System.Reflection.Assembly]::LoadWithPartialName("System.Drawing") | Out-Null; (New-Object System.Drawing.Text.InstalledFontCollection).Families.Name | Sort-Object -Unique';
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 20_000 });
  if (result.code !== 0) fail('No se pudieron consultar las fuentes instaladas.', 'FONT_CHECK_FAILED');
  return result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function checkSourceFonts(source, installed) {
  const installedNormalized = installed.map(name => ({ name, normalized: normalizedFont(name) }));
  const results = source.usedFonts.map(font => {
    const wanted = normalizedFont(font.name);
    const match = installedNormalized.find(item => fontFamilyMatches(wanted, item.normalized));
    return { ...font, installed: Boolean(match), installedFamily: match?.name || null };
  });
  const missing = results.filter(font => !font.installed);
  if (missing.length) fail(`Faltan fuentes usadas en texto visible: ${missing.map(font => font.name).join(', ')}.`, 'MISSING_VISIBLE_FONT');
  return results;
}

function matchRenderedFonts(sourceFonts, outputFonts) {
  if (!outputFonts.length) fail('El PDF no permitió identificar sus fuentes visibles.', 'OUTPUT_FONT_UNKNOWN');
  const rendered = outputFonts.map(name => ({ name, normalized: normalizedFont(name) }));
  const matches = sourceFonts.map(font => {
    const wanted = normalizedFont(font.name);
    const match = rendered.find(item => fontFamilyMatches(wanted, item.normalized));
    return { sourceFamily: font.name, pdfFamily: match?.name || null, matched: Boolean(match) };
  });
  const substituted = matches.filter(match => !match.matched);
  if (substituted.length) fail(`El PDF sustituyó fuentes visibles: ${substituted.map(match => match.sourceFamily).join(', ')}.`, 'OUTPUT_FONT_SUBSTITUTION');
  return matches;
}

function tokenCoverage(source, target) {
  const sourceTokens = normalizeText(source).split(' ').filter(Boolean);
  const targetCounts = new Map();
  for (const token of normalizeText(target).split(' ').filter(Boolean)) targetCounts.set(token, (targetCounts.get(token) || 0) + 1);
  let matched = 0;
  for (const token of sourceTokens) {
    const count = targetCounts.get(token) || 0;
    if (count > 0) {
      matched += 1;
      targetCounts.set(token, count - 1);
    }
  }
  return sourceTokens.length ? matched / sourceTokens.length : 1;
}

const SPANISH_FUNCTION_WORDS = new Set([
  'a', 'al', 'de', 'del', 'el', 'en', 'la', 'las', 'lo', 'los', 'o', 'para', 'por', 'que', 'un', 'una', 'y'
]);

function materialTokenCoverage(source, target) {
  const material = normalizeText(source).split(' ').filter(token => token && !SPANISH_FUNCTION_WORDS.has(token));
  if (!material.length) return tokenCoverage(source, target);
  return tokenCoverage(material.join(' '), target);
}

function validateOrdinaryTextCoverage(sourcePage, targetText) {
  const coverage = tokenCoverage(sourcePage.ordinaryText, targetText);
  if (coverage < 1) fail(`La página ${sourcePage.number} no conserva el 100% del texto ordinario (${(coverage * 100).toFixed(1)}%).`, 'TEXT_MISMATCH');
  return coverage;
}

function mapObjectBounds(bounds, slideSize, viewport) {
  if (!bounds || !slideSize || [bounds.x, bounds.y, bounds.cx, bounds.cy, slideSize.cx, slideSize.cy].some(value => !Number.isSafeInteger(value))) {
    fail('El objeto vectorial no tiene límites EMU válidos.', 'VECTOR_OBJECT_BOUNDS_INVALID');
  }
  if (bounds.cx <= 0 || bounds.cy <= 0 || slideSize.cx <= 0 || slideSize.cy <= 0) fail('El objeto vectorial tiene extensión vacía.', 'VECTOR_OBJECT_BOUNDS_INVALID');
  if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.cx > slideSize.cx || bounds.y + bounds.cy > slideSize.cy) {
    fail('El objeto vectorial cae fuera de la diapositiva.', 'VECTOR_OBJECT_OUTSIDE_PAGE');
  }
  if (bounds.x === 0 || bounds.y === 0 || bounds.x + bounds.cx === slideSize.cx || bounds.y + bounds.cy === slideSize.cy) {
    fail('El objeto vectorial toca un borde y puede estar recortado.', 'VECTOR_OBJECT_EDGE_CLIPPED');
  }
  const slideAspect = slideSize.cx / slideSize.cy;
  const pageAspect = viewport.width / viewport.height;
  if (Math.abs(slideAspect - pageAspect) > 1e-6) fail('La geometría del PDF no coincide con la diapositiva.', 'PAGE_GEOMETRY_MISMATCH');
  const exact = {
    x: bounds.x / slideSize.cx * viewport.width,
    y: bounds.y / slideSize.cy * viewport.height,
    width: bounds.cx / slideSize.cx * viewport.width,
    height: bounds.cy / slideSize.cy * viewport.height
  };
  const pixels = {
    x: Math.floor(exact.x),
    y: Math.floor(exact.y),
    width: Math.ceil(exact.x + exact.width) - Math.floor(exact.x),
    height: Math.ceil(exact.y + exact.height) - Math.floor(exact.y)
  };
  if (pixels.x < 0 || pixels.y < 0 || pixels.width < 1 || pixels.height < 1 || pixels.x + pixels.width > Math.ceil(viewport.width) || pixels.y + pixels.height > Math.ceil(viewport.height)) {
    fail('El recorte vectorial no cabe exactamente en la página renderizada.', 'VECTOR_OBJECT_CROP_INVALID');
  }
  return { exact, pixels };
}

async function renderPdfPage(page) {
  let canvasModule;
  try { canvasModule = await import('@napi-rs/canvas'); } catch { fail('No está disponible el rasterizador local requerido.', 'RASTER_RENDERER_UNAVAILABLE'); }
  const viewport = page.getViewport({ scale: RASTER_SCALE });
  const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context, viewport, background: '#FFFFFF' }).promise;
  return { canvas, context, viewport };
}

function rasterBytes(rendered) {
  const data = rendered.context.getImageData(0, 0, rendered.canvas.width, rendered.canvas.height).data;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

async function encodeCropPng(rendered, mapped) {
  const canvasModule = await import('@napi-rs/canvas');
  const { x, y, width, height } = mapped.pixels;
  const cropCanvas = canvasModule.createCanvas(width, height);
  cropCanvas.getContext('2d').drawImage(rendered.canvas, x, y, width, height, 0, 0, width, height);
  return { buffer: cropCanvas.toBuffer('image/png'), canvas: cropCanvas };
}

function inspectCropPixels(rendered, mapped) {
  const { x, y, width, height } = mapped.pixels;
  const pixels = rendered.context.getImageData(x, y, width, height).data;
  let sum = 0;
  let sumSquares = 0;
  let ink = 0;
  const count = pixels.length / 4;
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    sum += luminance;
    sumSquares += luminance * luminance;
    if (luminance < 245) ink += 1;
  }
  const mean = sum / count;
  const standardDeviation = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
  const inkPixelRatio = ink / count;
  if (inkPixelRatio < MIN_OBJECT_PIXEL_RATIO || standardDeviation < MIN_OBJECT_LUMINANCE_STDDEV) {
    fail('El recorte del objeto vectorial está vacío o casi vacío.', 'VECTOR_OBJECT_CROP_EMPTY');
  }
  return { inkPixelRatio: Number(inkPixelRatio.toFixed(6)), luminanceStandardDeviation: Number(standardDeviation.toFixed(4)) };
}

async function windowsOcr(pngPath) {
  if (process.platform !== 'win32') return { available: false, text: '', detail: 'Windows OCR no está disponible en esta plataforma.' };
  const escaped = path.resolve(pngPath).replace(/'/g, "''");
  const command = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
function Await-WinRt($operation,[Type]$resultType){$method=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1}|Select-Object -First 1;$task=$method.MakeGenericMethod($resultType).Invoke($null,@($operation));$task.GetAwaiter().GetResult()}
$file=Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${escaped}')) ([Windows.Storage.StorageFile])
$stream=Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder=Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap=Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if($null -eq $engine){throw 'No OCR engine'}
$result=Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Text
$stream.Dispose()
$bitmap.Dispose()`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 30_000 });
  return { available: result.code === 0, text: result.stdout.trim(), detail: (result.stderr || '').trim().slice(0, 2000) };
}

function queueItemBindingPayload(item) {
  return {
    sourceSha256: item.sourceSha256,
    pdfSha256: item.pdfSha256,
    assetPath: item.assetPath,
    deckPosition: item.deckPosition,
    courseId: item.courseId,
    courseName: item.courseName,
    lessonId: item.lessonId,
    lessonTitle: item.lessonTitle,
    originalName: item.originalName,
    pageNumber: item.pageNumber,
    objectId: item.objectId,
    objectName: item.objectName,
    objectType: item.objectType,
    expectedNormalizedText: item.expectedNormalizedText,
    vectorTextProof: item.vectorTextProof,
    boundsEmu: item.boundsEmu,
    cropPixels: item.cropPixels,
    cropExactPixels: item.cropExactPixels,
    fullPageRaster: item.fullPageRaster,
    objectRaster: item.objectRaster,
    cropSha256: item.cropSha256
  };
}

function buildReviewQueueItem(input) {
  const payload = queueItemBindingPayload(input);
  const bindingSha256 = sha256(Buffer.from(stableJson(payload), 'utf8'));
  const reviewId = `vr-${bindingSha256}`;
  const item = {
    reviewId,
    bindingSha256,
    ...payload,
    artifactPath: `evidence/visual-review-required/${reviewId}.png`,
    cropMetrics: input.cropMetrics,
    automatedOcr: input.automatedOcr
  };
  item.decisionBinding = reviewDecisionBinding(item);
  return item;
}

function reviewDecisionBinding(item) {
  return {
    reviewId: item.reviewId,
    bindingSha256: item.bindingSha256,
    ...queueItemBindingPayload(item),
    artifactPath: item.artifactPath
  };
}

function validateQueueItemBinding(item) {
  const hashes = [item.sourceSha256, item.pdfSha256, item.cropSha256, item.fullPageRaster?.generatedSha256, item.fullPageRaster?.directReferenceSha256, item.objectRaster?.generatedSha256, item.objectRaster?.directReferenceSha256];
  if (hashes.some(value => !/^[a-f0-9]{64}$/.test(String(value || '')))) fail('La cola contiene hashes inválidos.', 'REVIEW_QUEUE_INVALID');
  if (!Number.isSafeInteger(item.deckPosition) || item.deckPosition < 1 || !Number.isSafeInteger(item.pageNumber) || item.pageNumber < 1 || !item.courseId || !item.lessonId || !item.objectId || !item.expectedNormalizedText || normalizeText(item.expectedNormalizedText) !== item.expectedNormalizedText) {
    fail('La cola contiene una identidad de objeto inválida.', 'REVIEW_QUEUE_INVALID');
  }
  if (item.fullPageRaster.generatedSha256 !== item.fullPageRaster.directReferenceSha256 || item.objectRaster.generatedSha256 !== item.objectRaster.directReferenceSha256) {
    fail('La cola contiene un raster no corroborado.', 'REVIEW_QUEUE_INVALID');
  }
  packageRelativePath(path.resolve(process.cwd(), 'review-package-root'), item.assetPath);
  const expected = buildReviewQueueItem(item);
  if (item.reviewId !== expected.reviewId || item.bindingSha256 !== expected.bindingSha256 || item.artifactPath !== expected.artifactPath || !objectEquals(item.decisionBinding, reviewDecisionBinding(item))) {
    fail(`El elemento de revisión ${item.reviewId || 'sin id'} tiene un binding inválido.`, 'REVIEW_QUEUE_TAMPERED');
  }
  return true;
}

function validateReviewLedger(queue, ledger, queueSha256) {
  if (queue?.schemaVersion !== REVIEW_QUEUE_SCHEMA_VERSION || queue.reviewLedgerSchemaVersion !== REVIEW_LEDGER_SCHEMA_VERSION || !Array.isArray(queue.items) || queue.itemCount !== queue.items.length || !objectEquals(queue.requiredVisualChecks, [...REQUIRED_VISUAL_CHECKS])) {
    fail('La cola de revisión no tiene un esquema válido.', 'REVIEW_QUEUE_INVALID');
  }
  const queueIds = new Set();
  for (const item of queue.items) {
    validateQueueItemBinding(item);
    if (queueIds.has(item.reviewId)) fail('La cola contiene elementos duplicados.', 'REVIEW_QUEUE_INVALID');
    queueIds.add(item.reviewId);
  }
  if (ledger?.schemaVersion !== REVIEW_LEDGER_SCHEMA_VERSION || !Array.isArray(ledger.decisions)) fail('El ledger de revisión no tiene un esquema válido.', 'REVIEW_LEDGER_INVALID');
  if (ledger.queueSha256 !== queueSha256) fail('El ledger no está vinculado a esta cola exacta.', 'REVIEW_LEDGER_MISMATCH');
  if (typeof ledger.reviewer?.name !== 'string' || !ledger.reviewer.name.trim() || ledger.reviewer.freshEyes !== true || ledger.reviewer.independentFromGeneration !== true) {
    fail('El ledger no contiene una atestación válida de un verificador independiente.', 'REVIEW_LEDGER_INVALID');
  }
  if (typeof ledger.reviewedAt !== 'string' || !Number.isFinite(Date.parse(ledger.reviewedAt))) fail('El ledger no declara una fecha de revisión válida.', 'REVIEW_LEDGER_INVALID');
  const decisions = new Map();
  for (const decision of ledger.decisions) {
    if (typeof decision?.reviewId !== 'string' || decisions.has(decision.reviewId)) fail('El ledger contiene decisiones duplicadas o sin identidad.', 'REVIEW_LEDGER_INVALID');
    decisions.set(decision.reviewId, decision);
  }
  if (decisions.size !== queue.items.length) fail('El ledger debe contener exactamente una decisión por elemento de la cola.', 'REVIEW_LEDGER_INCOMPLETE');
  for (const item of queue.items) {
    const decision = decisions.get(item.reviewId);
    if (!decision) fail(`Falta la decisión para ${item.reviewId}.`, 'REVIEW_LEDGER_INCOMPLETE');
    if (!objectEquals(decision.binding, item.decisionBinding)) fail(`La decisión ${item.reviewId} no coincide con el binding exacto.`, 'REVIEW_LEDGER_MISMATCH');
    if (decision.decision === 'fail') fail(`El verificador rechazó ${item.reviewId}.`, 'VISUAL_REVIEW_FAILED');
    if (decision.decision !== 'pass') fail(`La decisión ${item.reviewId} no es pass ni fail.`, 'REVIEW_LEDGER_INVALID');
    for (const check of REQUIRED_VISUAL_CHECKS) {
      if (decision.checks?.[check] !== true) fail(`La decisión ${item.reviewId} no atestigua ${check}.`, 'REVIEW_LEDGER_INCOMPLETE');
    }
  }
  return queue.items.map(item => decisions.get(item.reviewId));
}

async function validateVectorObjectForQueue(object, source, rendered, referenceRendered, options) {
  const mapped = mapObjectBounds(object.boundsEmu, source.slideSizeEmu, rendered.viewport);
  const referenceMapped = mapObjectBounds(object.boundsEmu, source.slideSizeEmu, referenceRendered.viewport);
  const cropStats = inspectCropPixels(rendered, mapped);
  const actualPixels = rendered.context.getImageData(mapped.pixels.x, mapped.pixels.y, mapped.pixels.width, mapped.pixels.height).data;
  const referencePixels = referenceRendered.context.getImageData(referenceMapped.pixels.x, referenceMapped.pixels.y, referenceMapped.pixels.width, referenceMapped.pixels.height).data;
  const actualHash = sha256(Buffer.from(actualPixels.buffer, actualPixels.byteOffset, actualPixels.byteLength));
  const referenceHash = sha256(Buffer.from(referencePixels.buffer, referencePixels.byteOffset, referencePixels.byteLength));
  if (mapped.pixels.width !== referenceMapped.pixels.width || mapped.pixels.height !== referenceMapped.pixels.height || actualHash !== referenceHash) {
    fail(`El raster del objeto vectorial ${object.id} no coincide entre las rutas directa y ODP.`, 'RASTER_MISMATCH');
  }
  const png = await encodeCropPng(rendered, mapped);
  const temporaryCrop = path.join(options.workDir, `ocr-p${String(options.pageNumber).padStart(3, '0')}-o${object.id}.png`);
  await fs.writeFile(temporaryCrop, png.buffer, { flag: 'wx' });
  const ocr = await windowsOcr(temporaryCrop);
  const expected = object.normalizedText;
  const recognized = normalizeText(ocr.text);
  const commonGate = {
    objectId: object.id,
    objectName: object.name,
    objectType: object.objectType,
    expectedToken: expected,
    vectorTextProof: object.vectorTextProof,
    boundsEmu: object.boundsEmu,
    cropPixels: mapped.pixels,
    cropExactPixels: mapped.exact,
    ...cropStats,
    rasterSha256: actualHash,
    referenceRasterSha256: referenceHash,
    rasterMatch: true,
    ocrEngine: 'Windows.Media.Ocr',
    ocrText: ocr.text,
    ocrExactMatch: ocr.available && recognized === expected
  };
  if (!ocr.available || recognized !== expected) {
    const reviewItem = buildReviewQueueItem({
      sourceSha256: options.sourceSha256,
      pdfSha256: options.pdfSha256,
      assetPath: options.assetPath,
      deckPosition: options.deckPosition,
      courseId: options.courseId,
      courseName: options.courseName,
      lessonId: options.lessonId,
      lessonTitle: options.lessonTitle,
      originalName: options.originalName,
      pageNumber: options.pageNumber,
      objectId: object.id,
      objectName: object.name,
      objectType: object.objectType,
      expectedNormalizedText: expected,
      vectorTextProof: object.vectorTextProof,
      boundsEmu: object.boundsEmu,
      cropPixels: mapped.pixels,
      cropExactPixels: mapped.exact,
      fullPageRaster: options.fullPageRaster,
      objectRaster: { generatedSha256: actualHash, directReferenceSha256: referenceHash },
      cropSha256: sha256(png.buffer),
      cropMetrics: cropStats,
      automatedOcr: { engine: 'Windows.Media.Ocr', available: ocr.available, recognizedText: ocr.text, exactMatch: false, detail: ocr.detail }
    });
    await fs.mkdir(options.reviewDir, { recursive: true });
    await fs.writeFile(path.join(options.reviewDir, `${reviewItem.reviewId}.png`), png.buffer, { flag: 'wx' });
    return { ...commonGate, status: 'visual-review-required', artifactPath: reviewItem.artifactPath, reviewItem };
  }
  return { ...commonGate, status: 'passed', artifactPath: null, reviewItem: null };
}

async function validatePdf(pdfBuffer, source, options = {}) {
  validateMagic('pdf', pdfBuffer.subarray(0, Math.min(pdfBuffer.length, 262144)), pdfBuffer.subarray(Math.max(0, pdfBuffer.length - 4 * 1024 * 1024)));
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let loadingTask;
  let referenceLoadingTask;
  try {
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), disableWorker: true, isEvalSupported: false, enableXfa: false, verbosity: 0 });
    const document = await loadingTask.promise;
    if (document.numPages !== source.slideCount) fail(`El PDF tiene ${document.numPages} páginas y el deck ${source.slideCount} diapositivas.`, 'PAGE_COUNT_MISMATCH');
    const hasVectorText = source.pages.some(page => page.vectorTextObjects.length);
    let referenceDocument = null;
    if (hasVectorText) {
      if (!options.referencePdfBuffer) fail('Falta el PDF directo de referencia para validar texto vectorial.', 'RASTER_REFERENCE_MISSING');
      referenceLoadingTask = pdfjs.getDocument({ data: new Uint8Array(options.referencePdfBuffer), disableWorker: true, isEvalSupported: false, enableXfa: false, verbosity: 0 });
      referenceDocument = await referenceLoadingTask.promise;
      if (referenceDocument.numPages !== source.slideCount) fail('El PDF directo de referencia no conserva el conteo de páginas.', 'PAGE_COUNT_MISMATCH');
    }
    const outputFonts = new Set();
    const pages = [];
    const reviewItems = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const textContent = await page.getTextContent({ disableNormalization: false });
      const text = textContent.items.map(item => item.str || '').join(' ');
      const coverage = tokenCoverage(source.pages[number - 1].text, text);
      const materialCoverage = materialTokenCoverage(source.pages[number - 1].text, text);
      const ordinaryTextCoverage = validateOrdinaryTextCoverage(source.pages[number - 1], text);
      const operators = await page.getOperatorList();
      const imageOps = operators.fnArray.filter(operation => [
        pdfjs.OPS.paintImageXObject,
        pdfjs.OPS.paintInlineImageXObject,
        pdfjs.OPS.paintImageMaskXObject,
        pdfjs.OPS.paintSolidColorImageMask
      ].includes(operation)).length;
      for (const item of textContent.items) {
        const style = textContent.styles?.[item.fontName];
        if (style?.fontFamily && !/^(sans-serif|serif|monospace)$/i.test(style.fontFamily)) outputFonts.add(style.fontFamily);
        try {
          if (page.commonObjs.has(item.fontName)) {
            const font = page.commonObjs.get(item.fontName);
            if (font?.name) outputFonts.add(font.name);
          }
        } catch {}
      }
      const sourcePage = source.pages[number - 1];
      const materialOps = operators.fnArray.length;
      if (sourcePage.sourceImages > 0 && imageOps < 1) fail(`La página ${number} perdió imágenes del deck.`, 'IMAGE_MISMATCH');
      if (!normalizeText(text) && imageOps < 1 && materialOps < 8) fail(`La página ${number} parece estar en blanco.`, 'BLANK_PAGE');
      const vectorObjectGates = [];
      let pageRaster = null;
      if (sourcePage.vectorTextObjects.length) {
        const referencePage = await referenceDocument.getPage(number);
        const [rendered, referenceRendered] = await Promise.all([renderPdfPage(page), renderPdfPage(referencePage)]);
        const outputRasterHash = sha256(rasterBytes(rendered));
        const referenceRasterHash = sha256(rasterBytes(referenceRendered));
        if (rendered.canvas.width !== referenceRendered.canvas.width || rendered.canvas.height !== referenceRendered.canvas.height || outputRasterHash !== referenceRasterHash) {
          fail(`La página ${number} no coincide visualmente entre las rutas directa y ODP.`, 'RASTER_MISMATCH');
        }
        pageRaster = { width: rendered.canvas.width, height: rendered.canvas.height, sha256: outputRasterHash, referenceSha256: referenceRasterHash, exactMatch: true };
        const fullPageRaster = {
          width: rendered.canvas.width,
          height: rendered.canvas.height,
          generatedSha256: outputRasterHash,
          directReferenceSha256: referenceRasterHash
        };
        for (const object of sourcePage.vectorTextObjects) {
          const gate = await validateVectorObjectForQueue(object, source, rendered, referenceRendered, { ...options, pageNumber: number, fullPageRaster });
          if (gate.reviewItem) reviewItems.push(gate.reviewItem);
          const { reviewItem, ...gateEvidence } = gate;
          vectorObjectGates.push(gateEvidence);
        }
        referencePage.cleanup();
      }
      pages.push({
        number,
        sourceCharacters: sourcePage.normalizedText.length,
        pdfCharacters: normalizeText(text).length,
        textCoverage: Number(coverage.toFixed(4)),
        materialTextCoverage: Number(materialCoverage.toFixed(4)),
        ordinaryTextCoverage: Number(ordinaryTextCoverage.toFixed(4)),
        vectorTextObjectCount: sourcePage.vectorTextObjects.length,
        vectorObjectGates,
        pageRaster,
        sourceImages: sourcePage.sourceImages,
        pdfImageOperations: imageOps,
        pdfOperatorCount: materialOps
      });
      page.cleanup();
    }
    return { pageCount: document.numPages, pages, outputFonts: [...outputFonts].sort(), reviewItems };
  } finally {
    try { await loadingTask?.destroy(); } catch {}
    try { await referenceLoadingTask?.destroy(); } catch {}
  }
}

async function findLibreOffice() {
  for (const candidate of LIBREOFFICE_CANDIDATES) {
    try {
      await fs.access(candidate);
      const version = await runProcess(candidate, ['--version'], { timeout: 20_000 });
      if (version.code === 0 && /LibreOffice/i.test(version.stdout + version.stderr)) return { executable: candidate, version: (version.stdout || version.stderr).trim() };
    } catch {}
  }
  fail('No se encontró una instalación oficial de LibreOffice.', 'LIBREOFFICE_NOT_FOUND');
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
      settled = true;
      reject(Object.assign(new Error(`El proceso excedió ${options.timeout || CONVERSION_TIMEOUT_MS} ms.`), { code: 'PROCESS_TIMEOUT' }));
    }, options.timeout || CONVERSION_TIMEOUT_MS);
    child.stdout.on('data', chunk => { if (stdout.length < 200_000) stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { if (stderr.length < 200_000) stderr += chunk.toString(); });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function cleanupOwnedLibreOffice(profileUrl) {
  if (process.platform !== 'win32') return;
  const escaped = profileUrl.replace(/'/g, "''");
  const command = `$needle='${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$needle*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 20_000 }).catch(() => {});
}

function assertOwnedTemp(tempRoot, target) {
  const root = path.resolve(tempRoot);
  const resolved = path.resolve(target);
  if (resolved === root || !resolved.startsWith(root + path.sep)) fail(`Ruta temporal insegura: ${resolved}`, 'UNSAFE_TEMP_PATH');
}

async function convertWithLibreOffice(sourcePath, workDir, libreOffice, options = {}) {
  const documentDir = path.join(workDir, 'd');
  const outputDir = path.join(workDir, 'o');
  const referenceDir = path.join(workDir, 'r');
  const referenceProfileDir = path.join(workDir, 'p0');
  const importProfileDir = path.join(workDir, 'p1');
  const exportProfileDir = path.join(workDir, 'p2');
  await fs.mkdir(documentDir, { recursive: false });
  await fs.mkdir(outputDir, { recursive: false });
  if (options.directReference) {
    await fs.mkdir(referenceDir, { recursive: false });
    await fs.mkdir(referenceProfileDir, { recursive: false });
  }
  await fs.mkdir(importProfileDir, { recursive: false });
  await fs.mkdir(exportProfileDir, { recursive: false });
  const importProfileUrl = pathToFileURL(importProfileDir).href;
  const exportProfileUrl = pathToFileURL(exportProfileDir).href;
  const referenceProfileUrl = pathToFileURL(referenceProfileDir).href;
  try {
    let referenceOutputPath = null;
    let referenceLog = '';
    if (options.directReference) {
      const referenced = await runProcess(libreOffice.executable, [
        `-env:UserInstallation=${referenceProfileUrl}`,
        '--headless', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
        '--convert-to', 'pdf:impress_pdf_Export', '--outdir', referenceDir, sourcePath
      ], { cwd: workDir, timeout: CONVERSION_TIMEOUT_MS });
      if (referenced.code !== 0) fail(`LibreOffice no pudo producir el PDF directo de referencia: ${(referenced.stderr || referenced.stdout).trim() || `código ${referenced.code}`}`, 'CONVERSION_FAILED');
      referenceOutputPath = path.join(referenceDir, `${path.parse(sourcePath).name}.pdf`);
      await fs.access(referenceOutputPath).catch(() => fail('LibreOffice no produjo el PDF directo de referencia.', 'CONVERSION_FAILED'));
      referenceLog = ['PPTX/PPSX -> PDF directo', referenced.stdout, referenced.stderr].filter(Boolean).join('\n').trim();
    }
    const imported = await runProcess(libreOffice.executable, [
      `-env:UserInstallation=${importProfileUrl}`,
      '--headless', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
      '--convert-to', 'odp:impress8', '--outdir', documentDir, sourcePath
    ], { cwd: workDir, timeout: CONVERSION_TIMEOUT_MS });
    if (imported.code !== 0) fail(`LibreOffice no pudo normalizar el deck: ${(imported.stderr || imported.stdout).trim() || `código ${imported.code}`}`, 'CONVERSION_FAILED');
    const intermediatePath = path.join(documentDir, `${path.parse(sourcePath).name}.odp`);
    await fs.access(intermediatePath).catch(() => fail('LibreOffice no produjo el ODP temporal esperado.', 'CONVERSION_FAILED'));
    const exported = await runProcess(libreOffice.executable, [
      `-env:UserInstallation=${exportProfileUrl}`,
      '--headless', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
      '--convert-to', 'pdf:impress_pdf_Export', '--outdir', outputDir, intermediatePath
    ], { cwd: workDir, timeout: CONVERSION_TIMEOUT_MS });
    if (exported.code !== 0) fail(`LibreOffice no pudo exportar el PDF: ${(exported.stderr || exported.stdout).trim() || `código ${exported.code}`}`, 'CONVERSION_FAILED');
    const outputPath = path.join(outputDir, `${path.parse(sourcePath).name}.pdf`);
    await fs.access(outputPath).catch(() => fail('LibreOffice no produjo el PDF esperado.', 'CONVERSION_FAILED'));
    return {
      outputPath,
      referenceOutputPath,
      log: [referenceLog, `PPTX/PPSX -> ODP`, imported.stdout, imported.stderr, `ODP -> PDF`, exported.stdout, exported.stderr].filter(Boolean).join('\n').trim()
    };
  } finally {
    if (options.directReference) await cleanupOwnedLibreOffice(referenceProfileUrl);
    await cleanupOwnedLibreOffice(importProfileUrl);
    await cleanupOwnedLibreOffice(exportProfileUrl);
  }
}

async function writeJson(file, value) {
  const buffer = jsonBuffer(value);
  await fs.writeFile(file, buffer, { flag: 'wx' });
  return sha256(buffer);
}

async function processDeck(deck, position, context) {
  const { course, lesson } = deck;
  const runId = `${String(position).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex')}`;
  const workDir = path.join(context.tempRoot, runId);
  assertOwnedTemp(context.tempRoot, workDir);
  await fs.mkdir(workDir, { recursive: false });
  const sourcePath = path.join(workDir, `s.${lesson.type}`);
  try {
    const download = await streamTrustedDeck(lesson, sourcePath);
    const sourceBuffer = await fs.readFile(sourcePath);
    const sourceSha256 = sha256(sourceBuffer);
    const source = inspectPresentation(sourceBuffer, lesson.type);
    const sourceFonts = checkSourceFonts(source, context.installedFonts);
    const hasVectorText = source.pages.some(page => page.vectorTextObjects.length);
    const conversion = await convertWithLibreOffice(sourcePath, workDir, context.libreOffice, { directReference: hasVectorText });
    const pdfBuffer = await fs.readFile(conversion.outputPath);
    const pdfSha256 = sha256(pdfBuffer);
    const filename = `${String(position).padStart(2, '0')}-${safeStem(lesson.title)}-${pdfSha256.slice(0, 12)}.pdf`;
    const assetPath = `assets/${filename}`;
    const referencePdfBuffer = conversion.referenceOutputPath ? await fs.readFile(conversion.referenceOutputPath) : null;
    const pdf = await validatePdf(pdfBuffer, source, {
      referencePdfBuffer,
      workDir,
      reviewDir: context.reviewDir,
      sourceSha256,
      pdfSha256,
      assetPath,
      deckPosition: position,
      courseId: course.id,
      courseName: course.name,
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      originalName: lesson.originalName
    });
    const renderedFontMatches = matchRenderedFonts(sourceFonts.filter(font => font.ordinaryVisibleRuns > 0), pdf.outputFonts);
    const destination = path.join(context.assetsDir, filename);
    await fs.copyFile(conversion.outputPath, destination, fs.constants.COPYFILE_EXCL);
    const derivedPathname = lesson.pathname.replace(/\.(?:pptx|ppsx)$/i, `-derived-${pdfSha256.slice(0, 12)}.pdf`);
    const derivedUrl = new URL(`/${derivedPathname}`, lesson.url).href;
    const derivedPdf = {
      type: 'pdf',
      url: derivedUrl,
      downloadUrl: `${derivedUrl}?download=1`,
      originalName: String(lesson.originalName || `${lesson.title}.${lesson.type}`).replace(/\.(?:pptx|ppsx)$/i, '.pdf'),
      pathname: derivedPathname,
      size: pdfBuffer.length,
      sha256: pdfSha256,
      sourceSha256,
      sourceSlideCount: source.slideCount,
      pageCount: pdf.pageCount,
      validationStatus: pdf.reviewItems.length ? 'visual-review-required' : 'passed',
      generator: 'libreoffice-offline',
      generatedWith: context.libreOffice.version,
      managed: true
    };
    const evidence = {
      status: pdf.reviewItems.length ? 'visual-review-required' : 'passed',
      catalogRevision: context.catalog.revision,
      courseId: course.id,
      courseName: course.name,
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      originalName: lesson.originalName,
      sourceUrl: lesson.url,
      finalDownloadUrl: download.finalUrl,
      sourceBytes: sourceBuffer.length,
      sourceSha256,
      sourceSlideCount: source.slideCount,
      sourceSlideSizeEmu: source.slideSizeEmu,
      sourceObjectInventory: source.pages.map(page => ({
        page: page.number,
        objects: page.objects.map(object => ({
          id: object.id,
          name: object.name,
          objectType: object.objectType,
          boundsEmu: object.boundsEmu,
          normalizedText: object.normalizedText,
          tokens: object.tokens,
          nonExtractableVectorText: object.nonExtractableVectorText,
          vectorTextProof: object.vectorTextProof
        }))
      })),
      sourceUsedFonts: sourceFonts,
      unresolvedVisibleRuns: source.unresolvedVisibleRuns,
      pdfAssetFile: filename,
      pdfBytes: pdfBuffer.length,
      pdfSha256,
      pdfPageCount: pdf.pageCount,
      pdfFonts: pdf.outputFonts,
      renderedFontMatches,
      pages: pdf.pages,
      libreOffice: context.libreOffice.version,
      conversionLog: conversion.log,
      derivedPdf
    };
    await writeJson(path.join(context.deckEvidenceDir, `${String(position).padStart(2, '0')}-${safeStem(lesson.title)}.json`), evidence);
    return {
      evidence,
      reviewItems: pdf.reviewItems,
      operation: { courseId: course.id, lessonId: lesson.id, lessonTitle: lesson.title, sourceSha256, assetPath, evidencePath: `evidence/decks/${String(position).padStart(2, '0')}-${safeStem(lesson.title)}.json`, derivedPdf },
      assetFile: filename
    };
  } finally {
    await cleanupOwnedLibreOffice(pathToFileURL(path.join(workDir, 'p0')).href);
    await cleanupOwnedLibreOffice(pathToFileURL(path.join(workDir, 'p1')).href);
    await cleanupOwnedLibreOffice(pathToFileURL(path.join(workDir, 'p2')).href);
    assertOwnedTemp(context.tempRoot, workDir);
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function applyProposedOperations(manifest, operations) {
  const proposed = structuredClone(manifest);
  for (const operation of operations) {
    const course = proposed.courses.find(item => item.id === operation.courseId);
    const lesson = course?.lessons?.find(item => item.id === operation.lessonId);
    if (!lesson) fail(`No se pudo construir el parche para ${operation.lessonId}.`, 'PATCH_FAILED');
    lesson.sha256 = operation.sourceSha256;
    lesson.derivedPdf = operation.derivedPdf;
  }
  return proposed;
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function packageRelativePath(packageRoot, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('://') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    fail(`Ruta relativa de paquete inválida: ${String(relative)}`, 'PACKAGE_PATH_INVALID');
  }
  const resolved = path.resolve(packageRoot, ...relative.split('/'));
  if (!pathIsWithin(packageRoot, resolved)) fail(`Ruta fuera del paquete: ${relative}`, 'PACKAGE_PATH_INVALID');
  return resolved;
}

async function resolvePackageArtifact(packageRoot, relative) {
  const candidate = packageRelativePath(packageRoot, relative);
  const real = await fs.realpath(candidate).catch(() => fail(`Falta el artefacto del paquete: ${relative}`, 'PACKAGE_ARTIFACT_MISSING'));
  if (!pathIsWithin(packageRoot, real)) fail(`El artefacto sale del paquete: ${relative}`, 'PACKAGE_PATH_INVALID');
  return real;
}

async function readJsonBounded(file, maxBytes = 16 * 1024 * 1024) {
  const buffer = await fs.readFile(file);
  if (!buffer.length || buffer.length > maxBytes) fail(`JSON vacío o demasiado grande: ${file}`, 'PACKAGE_INVALID');
  try { return { buffer, value: JSON.parse(buffer.toString('utf8')) }; } catch { fail(`JSON inválido: ${file}`, 'PACKAGE_INVALID'); }
}

async function verifyPackageFile(packageRoot, relative, expectedSha256, type) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedSha256 || ''))) fail(`Hash inválido para ${relative}.`, 'PACKAGE_INVALID');
  const file = await resolvePackageArtifact(packageRoot, relative);
  const buffer = await fs.readFile(file);
  if (sha256(buffer) !== expectedSha256) fail(`El artefacto fue alterado: ${relative}`, 'PACKAGE_TAMPERED');
  if (type === 'pdf') validateMagic('pdf', buffer.subarray(0, Math.min(buffer.length, 262144)), buffer.subarray(Math.max(0, buffer.length - 4 * 1024 * 1024)));
  if (type === 'png' && !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) fail(`El recorte no es PNG válido: ${relative}`, 'PACKAGE_TAMPERED');
  return { file, buffer };
}

async function finalizePackage(options) {
  const packageRoot = await fs.realpath(path.resolve(options.package)).catch(() => fail('No existe el paquete solicitado.', 'PACKAGE_INVALID'));
  if (packageRoot === REPO_ROOT || pathIsWithin(REPO_ROOT, packageRoot)) fail('El paquete de revisión debe estar fuera del repositorio.', 'PACKAGE_INVALID');
  const reviewLedgerPath = await fs.realpath(path.resolve(options.reviewLedger)).catch(() => fail('No existe el ledger externo.', 'REVIEW_LEDGER_INVALID'));
  if (reviewLedgerPath === packageRoot || pathIsWithin(packageRoot, reviewLedgerPath)) fail('El ledger del verificador debe ser externo al paquete.', 'REVIEW_LEDGER_INVALID');

  const failedRecord = await readJsonBounded(packageRelativePath(packageRoot, 'FAILED.json'));
  const queueFile = await readJsonBounded(packageRelativePath(packageRoot, 'visual-review-queue.json'));
  const candidatesFile = await readJsonBounded(packageRelativePath(packageRoot, 'candidate.operations.json'));
  const catalogFile = await readJsonBounded(packageRelativePath(packageRoot, 'catalog.snapshot.json'));
  const reviewLedgerFile = await readJsonBounded(reviewLedgerPath, 2 * 1024 * 1024);
  const queueSha256 = sha256(queueFile.buffer);
  if (failedRecord.value?.code !== 'VISUAL_REVIEW_REQUIRED' || failedRecord.value?.details?.queuePath !== 'visual-review-queue.json' || failedRecord.value?.details?.queueSha256 !== queueSha256) {
    fail('El paquete no conserva un fallo de revisión visual válido.', 'PACKAGE_INVALID');
  }
  const queue = queueFile.value;
  const candidates = candidatesFile.value;
  if (queue.status !== 'visual-review-required' || !queue.items?.length) fail('El paquete no contiene una cola pendiente.', 'REVIEW_QUEUE_INVALID');
  if (queue.catalogSnapshotSha256 !== sha256(catalogFile.buffer) || queue.candidateOperationsSha256 !== sha256(candidatesFile.buffer)) fail('La cola no coincide con los archivos base del paquete.', 'PACKAGE_TAMPERED');
  if (candidates.schemaVersion !== 1 || !Array.isArray(candidates.operations) || candidates.catalogRevision !== queue.catalogRevision || candidates.namespace !== queue.namespace) {
    fail('Las operaciones candidatas no coinciden con la cola.', 'PACKAGE_INVALID');
  }
  validateReviewLedger(queue, reviewLedgerFile.value, queueSha256);

  const operationsByLesson = new Map();
  for (const operation of candidates.operations) {
    if (!operation?.courseId || !operation?.lessonId || operationsByLesson.has(`${operation.courseId}\0${operation.lessonId}`)) fail('Las operaciones candidatas tienen identidades inválidas.', 'PACKAGE_INVALID');
    operationsByLesson.set(`${operation.courseId}\0${operation.lessonId}`, operation);
    if (operation.assetPath !== `assets/${path.posix.basename(operation.assetPath || '')}` || !String(operation.assetPath).includes(operation.derivedPdf?.sha256?.slice(0, 12))) {
      fail(`El activo candidato de ${operation.lessonId} no está vinculado a su PDF.`, 'PACKAGE_INVALID');
    }
    const verified = await verifyPackageFile(packageRoot, operation.assetPath, operation.derivedPdf.sha256, 'pdf');
    if (verified.buffer.length !== operation.derivedPdf.size || operation.sourceSha256 !== operation.derivedPdf.sourceSha256) fail(`La metadata candidata no coincide para ${operation.lessonId}.`, 'PACKAGE_TAMPERED');
  }
  for (const item of queue.items) {
    const operation = operationsByLesson.get(`${item.courseId}\0${item.lessonId}`);
    if (!operation || operation.sourceSha256 !== item.sourceSha256 || operation.derivedPdf.sha256 !== item.pdfSha256 || operation.assetPath !== item.assetPath) {
      fail(`El elemento ${item.reviewId} no corresponde a su PDF candidato.`, 'PACKAGE_TAMPERED');
    }
    await verifyPackageFile(packageRoot, item.artifactPath, item.cropSha256, 'png');
  }

  const finalOperations = candidates.operations.map(operation => ({
    courseId: operation.courseId,
    lessonId: operation.lessonId,
    sourceSha256: operation.sourceSha256,
    derivedPdf: { ...operation.derivedPdf, validationStatus: 'passed' }
  }));
  const proposed = applyProposedOperations(catalogFile.value, finalOperations);
  const acceptedLedgerPath = 'evidence/review-ledger.accepted.json';
  await fs.writeFile(packageRelativePath(packageRoot, acceptedLedgerPath), reviewLedgerFile.buffer, { flag: 'wx' });
  const acceptedLedgerSha256 = sha256(reviewLedgerFile.buffer);
  const finalizedAt = new Date().toISOString();
  const ledger = {
    status: 'passed',
    startedAt: failedRecord.value.startedAt,
    completedAt: finalizedAt,
    catalogUrl: CATALOG_URL,
    catalogRevision: candidates.catalogRevision,
    namespace: candidates.namespace,
    libreOffice: candidates.libreOffice,
    mode: candidates.mode,
    deckCount: candidates.deckCount,
    pageCount: candidates.pageCount,
    expectedPageCount: candidates.expectedPageCount,
    noUploadPerformed: true,
    noCatalogMutationPerformed: true,
    priorFailureRecord: 'FAILED.json',
    visualReview: {
      finalized: true,
      queuePath: 'visual-review-queue.json',
      queueSha256,
      itemCount: queue.items.length,
      acceptedLedgerPath,
      acceptedLedgerSha256,
      reviewer: reviewLedgerFile.value.reviewer,
      reviewedAt: reviewLedgerFile.value.reviewedAt
    },
    assets: finalOperations.map(operation => {
      const candidate = operationsByLesson.get(`${operation.courseId}\0${operation.lessonId}`);
      return {
        courseId: operation.courseId,
        lessonId: operation.lessonId,
        title: candidate.lessonTitle,
        sourceSha256: operation.sourceSha256,
        sourceSlideCount: operation.derivedPdf.sourceSlideCount,
        pdfSha256: operation.derivedPdf.sha256,
        pdfPageCount: operation.derivedPdf.pageCount,
        assetFile: path.posix.basename(candidate.assetPath),
        status: 'passed'
      };
    })
  };
  await writeJson(packageRelativePath(packageRoot, 'catalog.proposed.json'), proposed);
  await writeJson(packageRelativePath(packageRoot, 'manifest.patch.json'), { baseRevision: candidates.catalogRevision, namespace: candidates.namespace, operations: finalOperations });
  await writeJson(packageRelativePath(packageRoot, 'ledger.json'), ledger);
  console.log(`PASS finalized reviews=${queue.items.length} package=${packageRoot}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.mode === 'finalize') {
    await finalizePackage(options);
    return;
  }
  const output = path.resolve(options.output);
  const tempRoot = path.resolve(options.tempRoot);
  await fs.access(output).then(() => fail(`El directorio de evidencia ya existe: ${output}`, 'OUTPUT_EXISTS'), () => {});
  await fs.mkdir(output, { recursive: false });
  const assetsDir = path.join(output, 'assets');
  const evidenceDir = path.join(output, 'evidence');
  const deckEvidenceDir = path.join(evidenceDir, 'decks');
  await fs.mkdir(assetsDir);
  await fs.mkdir(evidenceDir);
  await fs.mkdir(deckEvidenceDir);
  await fs.mkdir(tempRoot, { recursive: true });
  const startedAt = new Date().toISOString();
  try {
    const [catalog, libreOffice, installedFonts] = await Promise.all([fetchCatalog(), findLibreOffice(), installedFontFamilies()]);
    const allDecks = selectDecks(catalog, { all: true });
    const decks = selectDecks(catalog, options);
    const namespace = catalogNamespace(catalog, allDecks);
    const context = { catalog, libreOffice, installedFonts, tempRoot, assetsDir, deckEvidenceDir, reviewDir: path.join(evidenceDir, 'visual-review-required') };
    const results = [];
    for (const deck of decks) {
      const position = allDecks.findIndex(item => item.lesson.id === deck.lesson.id) + 1;
      console.log(`[${results.length + 1}/${decks.length}] ${deck.lesson.originalName}`);
      results.push(await processDeck(deck, position, context));
    }
    const totalPages = results.reduce((sum, result) => sum + result.evidence.pdfPageCount, 0);
    if (options.all && (decks.length !== 30 || totalPages !== options.expectedPages)) {
      fail(`El gate total esperaba 30 decks y ${options.expectedPages} páginas; obtuvo ${decks.length} y ${totalPages}.`, 'TOTAL_GATE_FAILED');
    }
    const operations = results.map(result => result.operation);
    const reviewItems = results.flatMap(result => result.reviewItems);
    const candidateOperations = {
      schemaVersion: 1,
      status: reviewItems.length ? 'visual-review-required' : 'automated-validation-passed',
      catalogRevision: catalog.revision,
      namespace,
      libreOffice: libreOffice.version,
      mode: options.all ? 'all' : 'gate',
      deckCount: results.length,
      pageCount: totalPages,
      expectedPageCount: options.expectedPages,
      noUploadPerformed: true,
      noCatalogMutationPerformed: true,
      operations
    };
    const catalogSnapshotSha256 = await writeJson(path.join(output, 'catalog.snapshot.json'), catalog);
    const candidateOperationsSha256 = await writeJson(path.join(output, 'candidate.operations.json'), candidateOperations);
    if (reviewItems.length) {
      const queue = {
        schemaVersion: REVIEW_QUEUE_SCHEMA_VERSION,
        reviewLedgerSchemaVersion: REVIEW_LEDGER_SCHEMA_VERSION,
        status: 'visual-review-required',
        catalogRevision: catalog.revision,
        namespace,
        catalogSnapshotSha256,
        candidateOperationsSha256,
        requiredVisualChecks: [...REQUIRED_VISUAL_CHECKS],
        itemCount: reviewItems.length,
        items: reviewItems
      };
      const queuePath = 'visual-review-queue.json';
      const queueSha256 = await writeJson(path.join(output, queuePath), queue);
      const failureRecord = {
        status: 'failed',
        startedAt,
        failedAt: new Date().toISOString(),
        code: 'VISUAL_REVIEW_REQUIRED',
        message: `${reviewItems.length} objeto(s) requieren revisión visual independiente.`,
        details: { state: 'visual-review-required', queuePath, queueSha256, itemCount: reviewItems.length }
      };
      await writeJson(path.join(output, 'FAILED.json'), failureRecord);
      const error = new Error(failureRecord.message);
      error.code = failureRecord.code;
      error.packageFailureRecorded = true;
      throw error;
    }
    const approvedOperations = operations.map(operation => ({ courseId: operation.courseId, lessonId: operation.lessonId, sourceSha256: operation.sourceSha256, derivedPdf: operation.derivedPdf }));
    const proposed = applyProposedOperations(catalog, approvedOperations);
    const ledger = {
      status: 'passed',
      startedAt,
      completedAt: new Date().toISOString(),
      catalogUrl: CATALOG_URL,
      catalogRevision: catalog.revision,
      namespace,
      libreOffice: libreOffice.version,
      mode: options.all ? 'all' : 'gate',
      deckCount: results.length,
      pageCount: totalPages,
      expectedPageCount: options.expectedPages,
      noUploadPerformed: true,
      noCatalogMutationPerformed: true,
      assets: results.map(result => ({
        courseId: result.evidence.courseId,
        lessonId: result.evidence.lessonId,
        title: result.evidence.lessonTitle,
        sourceSha256: result.evidence.sourceSha256,
        sourceSlideCount: result.evidence.sourceSlideCount,
        pdfSha256: result.evidence.pdfSha256,
        pdfPageCount: result.evidence.pdfPageCount,
        assetFile: result.assetFile,
        status: result.evidence.status
      }))
    };
    await writeJson(path.join(output, 'catalog.proposed.json'), proposed);
    await writeJson(path.join(output, 'manifest.patch.json'), { baseRevision: catalog.revision, namespace, operations: approvedOperations });
    await writeJson(path.join(output, 'ledger.json'), ledger);
    console.log(`PASS decks=${results.length} pages=${totalPages} output=${output}`);
  } catch (error) {
    if (!error.packageFailureRecorded) {
      await writeJson(path.join(output, 'FAILED.json'), { status: 'failed', startedAt, failedAt: new Date().toISOString(), code: error.code || 'ERROR', message: error.message, details: error.details || null }).catch(() => {});
    }
    throw error;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);
if (isMain) {
  main().catch(error => {
    console.error(`FAIL ${error.code || 'ERROR'}: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  buildReviewQueueItem,
  CATALOG_URL,
  MAX_SOURCE_BYTES,
  packageRelativePath,
  inspectPresentation,
  mapObjectBounds,
  normalizeText,
  parseArgs,
  parseSlideObjects,
  REQUIRED_VISUAL_CHECKS,
  reviewDecisionBinding,
  tokenCoverage,
  trustedBlobAsset,
  verifyPackageFile,
  validateQueueItemBinding,
  validateReviewLedger,
  validateOrdinaryTextCoverage
};
