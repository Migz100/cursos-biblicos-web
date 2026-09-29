#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const DEFAULT_SITE = 'https://cursos-biblicos-web.vercel.app';
const DEFAULT_AUDIT_DIR = path.resolve('work/tmp/presentation-audit-v2');
const PRESENTATION_TYPES = new Set(['ppt', 'pptx', 'ppsx']);
const OOXML_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/octet-stream'
]);

function parseArgs(argv) {
  const options = { site: DEFAULT_SITE, auditDir: DEFAULT_AUDIT_DIR, concurrency: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--site') options.site = argv[++index];
    else if (arg === '--audit-dir') options.auditDir = path.resolve(argv[++index]);
    else if (arg === '--concurrency') options.concurrency = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^https:\/\//.test(options.site)) throw new Error('--site must be an HTTPS origin');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error('--concurrency must be an integer from 1 through 8');
  }
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function slug(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70) || 'presentation';
}

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeText(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function xmlAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([\w:.-]+)=(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function extractText(xml) {
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
    .map(match => decodeXml(match[1]).trim())
    .filter(Boolean);
}

function parseRelationships(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].map(match => {
    const attrs = xmlAttributes(match[1]);
    return {
      id: attrs.Id || '',
      type: attrs.Type || '',
      target: attrs.Target || '',
      targetMode: attrs.TargetMode || ''
    };
  });
}

function resolveZipTarget(sourcePart, target) {
  const cleaned = target.replace(/\\/g, '/').replace(/^\//, '');
  if (target.startsWith('/')) return path.posix.normalize(cleaned);
  return path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), cleaned));
}

class ZipArchive {
  constructor(buffer) {
    this.buffer = buffer;
    this.entries = new Map();
    this.#readCentralDirectory();
  }

  #readCentralDirectory() {
    const buffer = this.buffer;
    let eocd = -1;
    const minimum = Math.max(0, buffer.length - 0x10000 - 22);
    for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
      if (buffer.readUInt32LE(offset) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) throw new Error('ZIP end-of-central-directory record is missing');
    const entryCount = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    for (let index = 0; index < entryCount; index += 1) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`Invalid ZIP central directory at ${offset}`);
      const flags = buffer.readUInt16LE(offset + 8);
      const compression = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const uncompressedSize = buffer.readUInt32LE(offset + 24);
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const localOffset = buffer.readUInt32LE(offset + 42);
      const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString((flags & 0x800) ? 'utf8' : 'utf8');
      this.entries.set(name.replace(/\\/g, '/'), {
        name: name.replace(/\\/g, '/'),
        compression,
        compressedSize,
        uncompressedSize,
        localOffset
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  has(name) {
    return this.entries.has(name);
  }

  names() {
    return [...this.entries.keys()];
  }

  read(name) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`ZIP part is missing: ${name}`);
    const offset = entry.localOffset;
    if (this.buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error(`Invalid ZIP local header for ${name}`);
    const nameLength = this.buffer.readUInt16LE(offset + 26);
    const extraLength = this.buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const compressed = this.buffer.subarray(start, start + entry.compressedSize);
    let output;
    if (entry.compression === 0) output = compressed;
    else if (entry.compression === 8) output = inflateRawSync(compressed);
    else throw new Error(`Unsupported ZIP compression ${entry.compression} for ${name}`);
    if (output.length !== entry.uncompressedSize) {
      throw new Error(`ZIP size mismatch for ${name}: ${output.length} != ${entry.uncompressedSize}`);
    }
    return output;
  }

  text(name) {
    return this.read(name).toString('utf8');
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

function responseHeaders(response) {
  return Object.fromEntries([...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function presentationInventory(catalog) {
  const rows = [];
  for (const course of catalog.courses || []) {
    for (const lesson of course.lessons || []) {
      const type = String(lesson.type || '').toLowerCase();
      if (!PRESENTATION_TYPES.has(type)) continue;
      rows.push({
        ordinal: rows.length + 1,
        courseId: course.id,
        courseName: course.name,
        lessonId: lesson.id,
        title: lesson.title,
        type,
        originalName: lesson.originalName || '',
        url: lesson.url,
        downloadUrl: lesson.downloadUrl || lesson.url,
        pathname: lesson.pathname || '',
        managed: lesson.managed === true
      });
    }
  }
  return rows;
}

function slideOrder(archive) {
  const presentationXml = archive.text('ppt/presentation.xml');
  const rels = parseRelationships(archive.text('ppt/_rels/presentation.xml.rels'));
  const byId = new Map(rels.map(item => [item.id, item]));
  const ordered = [];
  for (const match of presentationXml.matchAll(/<p:sldId\b([^>]*)\/?\s*>/g)) {
    const attrs = xmlAttributes(match[1]);
    const relationship = byId.get(attrs['r:id']);
    if (!relationship) throw new Error(`Slide relationship ${attrs['r:id']} is missing`);
    ordered.push(resolveZipTarget('ppt/presentation.xml', relationship.target));
  }
  return { presentationXml, ordered };
}

function titleFromSlide(xml, allText) {
  for (const match of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    const shape = match[0];
    if (!/<p:ph\b[^>]*\btype=(?:"(?:title|ctrTitle)"|'(?:title|ctrTitle)')/i.test(shape)) continue;
    const text = extractText(shape).join(' ').trim();
    if (text) return text;
  }
  return allText[0] || '';
}

function fontEvidence(xml) {
  const sizes = [...xml.matchAll(/<(?:a:rPr|a:defRPr|a:endParaRPr)\b[^>]*\bsz="(\d+)"/g)]
    .map(match => Number(match[1]) / 100)
    .filter(Number.isFinite);
  const families = [...xml.matchAll(/<a:(?:latin|ea|cs)\b[^>]*\btypeface="([^"]*)"/g)]
    .map(match => decodeXml(match[1]).trim())
    .filter(Boolean);
  return {
    explicitPointSizes: [...new Set(sizes)].sort((a, b) => a - b),
    minimumExplicitPointSize: sizes.length ? Math.min(...sizes) : null,
    fontFamilies: [...new Set(families)].sort()
  };
}

function shapeBoundsEvidence(xml, slideSize) {
  const outOfBounds = [];
  let checked = 0;
  for (const match of xml.matchAll(/<a:xfrm\b[\s\S]*?<\/a:xfrm>/g)) {
    const transform = match[0];
    const off = transform.match(/<a:off\b([^>]*)\/?\s*>/);
    const ext = transform.match(/<a:ext\b([^>]*)\/?\s*>/);
    if (!off || !ext) continue;
    const a = xmlAttributes(off[1]);
    const b = xmlAttributes(ext[1]);
    const x = Number(a.x);
    const y = Number(a.y);
    const cx = Number(b.cx);
    const cy = Number(b.cy);
    if (![x, y, cx, cy].every(Number.isFinite) || cx <= 0 || cy <= 0) continue;
    checked += 1;
    const toleranceX = slideSize.cx * 0.01;
    const toleranceY = slideSize.cy * 0.01;
    if (x < -toleranceX || y < -toleranceY || x + cx > slideSize.cx + toleranceX || y + cy > slideSize.cy + toleranceY) {
      outOfBounds.push({ x, y, cx, cy });
    }
  }
  return { transformsChecked: checked, potentialOutOfBounds: outOfBounds };
}

function slideRelationshipEvidence(archive, slidePart) {
  const relName = path.posix.join(path.posix.dirname(slidePart), '_rels', `${path.posix.basename(slidePart)}.rels`);
  if (!archive.has(relName)) return { externalLinks: [], missingInternalTargets: [] };
  const relationships = parseRelationships(archive.text(relName));
  const externalLinks = relationships
    .filter(item => item.targetMode.toLowerCase() === 'external')
    .map(item => ({ id: item.id, type: item.type, target: item.target }));
  const missingInternalTargets = relationships
    .filter(item => item.targetMode.toLowerCase() !== 'external')
    .map(item => ({ ...item, resolved: resolveZipTarget(slidePart, item.target) }))
    .filter(item => !archive.has(item.resolved));
  return { externalLinks, missingInternalTargets };
}

function analyzeOoxml(buffer) {
  const archive = new ZipArchive(buffer);
  const names = archive.names();
  if (!archive.has('[Content_Types].xml') || !archive.has('ppt/presentation.xml')) {
    throw new Error('The ZIP is not an OOXML presentation package');
  }
  const { presentationXml, ordered } = slideOrder(archive);
  const sizeMatch = presentationXml.match(/<p:sldSz\b([^>]*)\/?\s*>/);
  const sizeAttrs = sizeMatch ? xmlAttributes(sizeMatch[1]) : {};
  const slideSize = { cx: Number(sizeAttrs.cx) || 12192000, cy: Number(sizeAttrs.cy) || 6858000 };
  const slides = ordered.map((slidePart, zeroIndex) => {
    const xml = archive.text(slidePart);
    const allText = extractText(xml);
    const normalized = normalizeText(allText.join(' '));
    const placeholderShapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)]
      .map(match => match[0])
      .filter(shape => /<p:ph\b/i.test(shape));
    const placeholderEvidence = placeholderShapes.map(shape => ({
      type: xmlAttributes(shape.match(/<p:ph\b([^>]*)\/?\s*>/i)?.[1] || '').type || 'body',
      text: extractText(shape).join(' ').trim()
    }));
    const unresolvedPromptText = allText.filter(text => /click to add|haz clic para|slide number|footer|date|n[uú]mero de diapositiva/i.test(text));
    const relations = slideRelationshipEvidence(archive, slidePart);
    return {
      slideNumber: zeroIndex + 1,
      slidePart,
      hidden: /<p:sld\b[^>]*\bshow="(?:0|false)"/i.test(xml),
      expectedTitle: titleFromSlide(xml, allText),
      expectedText: allText,
      normalizedText: normalized,
      expectedTextSha256: sha256(normalized),
      textCharacterCount: allText.join(' ').length,
      placeholderEvidence,
      unresolvedPromptText,
      fontEvidence: fontEvidence(xml),
      boundsEvidence: shapeBoundsEvidence(xml, slideSize),
      externalLinks: relations.externalLinks,
      missingInternalTargets: relations.missingInternalTargets
    };
  });
  const media = names.filter(name => name.startsWith('ppt/media/') && !name.endsWith('/'));
  const externalLinks = slides.flatMap(slide => slide.externalLinks.map(link => ({ slideNumber: slide.slideNumber, ...link })));
  const missingInternalTargets = slides.flatMap(slide => slide.missingInternalTargets.map(link => ({ slideNumber: slide.slideNumber, ...link })));
  return {
    slideCount: slides.length,
    hiddenSlideCount: slides.filter(slide => slide.hidden).length,
    packagePartCount: names.length,
    mediaCount: media.length,
    mediaBytes: media.reduce((sum, name) => sum + archive.entries.get(name).uncompressedSize, 0),
    slideSize,
    externalLinks,
    missingInternalTargets,
    unresolvedPromptSlides: slides.filter(slide => slide.unresolvedPromptText.length).map(slide => slide.slideNumber),
    potentialOutOfBoundsSlides: slides.filter(slide => slide.boundsEvidence.potentialOutOfBounds.length).map(slide => slide.slideNumber),
    slides
  };
}

async function inspectUrl(url, accept = '*/*') {
  const response = await fetchWithTimeout(url, { headers: { accept } });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    ok: response.ok,
    finalUrl: response.url,
    headers: responseHeaders(response),
    body,
    bytes: body.length,
    sha256: sha256(body)
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const auditDir = options.auditDir;
  const decksDir = path.join(auditDir, 'decks');
  const structuralDir = path.join(auditDir, 'structural');
  const metadataDir = path.join(auditDir, 'downloads');
  await Promise.all([auditDir, decksDir, structuralDir, metadataDir].map(directory => mkdir(directory, { recursive: true })));

  const catalogUrl = new URL('/api/catalog', options.site).href;
  const catalogResponse = await fetchWithTimeout(catalogUrl, { headers: { accept: 'application/json' } });
  const catalogBody = Buffer.from(await catalogResponse.arrayBuffer());
  if (catalogResponse.status !== 200) throw new Error(`Catalog returned HTTP ${catalogResponse.status}`);
  const catalogMime = (catalogResponse.headers.get('content-type') || '').toLowerCase();
  if (!catalogMime.includes('application/json')) throw new Error(`Catalog MIME is ${catalogMime || '(missing)'}`);
  const catalog = JSON.parse(catalogBody.toString('utf8'));
  const inventory = presentationInventory(catalog);
  await writeFile(path.join(auditDir, 'catalog.json'), JSON.stringify(catalog, null, 2));
  await writeFile(path.join(auditDir, 'catalog-response.json'), JSON.stringify({
    url: catalogUrl,
    fetchedAt: new Date().toISOString(),
    status: catalogResponse.status,
    headers: responseHeaders(catalogResponse),
    bytes: catalogBody.length,
    sha256: sha256(catalogBody),
    revision: catalog.revision,
    presentationCount: inventory.length
  }, null, 2));
  if (inventory.length !== 30) throw new Error(`Expected 30 presentation artifacts; live catalog has ${inventory.length}`);

  const records = await mapLimit(inventory, options.concurrency, async item => {
    const prefix = String(item.ordinal).padStart(2, '0');
    const filename = `${prefix}-${slug(item.title)}.${item.type}`;
    const deckPath = path.join(decksDir, filename);
    const apiUrl = new URL('/api/presentation', options.site);
    apiUrl.searchParams.set('c', item.courseId);
    apiUrl.searchParams.set('l', item.lessonId);

    const [asset, download, api] = await Promise.all([
      inspectUrl(item.url),
      inspectUrl(item.downloadUrl),
      inspectUrl(apiUrl.href, 'application/json')
    ]);
    if (asset.status !== 200 || download.status !== 200 || api.status !== 200) {
      throw new Error(`${prefix} ${item.title}: asset/download/API statuses ${asset.status}/${download.status}/${api.status}`);
    }
    const assetMime = (asset.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const downloadMime = (download.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!OOXML_MIMES.has(assetMime) || !OOXML_MIMES.has(downloadMime)) {
      throw new Error(`${prefix} ${item.title}: unexpected MIME ${assetMime}/${downloadMime}`);
    }
    if (asset.sha256 !== download.sha256) {
      throw new Error(`${prefix} ${item.title}: viewer asset and download bytes differ`);
    }
    if (!(download.body[0] === 0x50 && download.body[1] === 0x4b)) {
      throw new Error(`${prefix} ${item.title}: download does not have ZIP/OOXML magic`);
    }
    await writeFile(deckPath, download.body);

    const apiMime = (api.headers['content-type'] || '').toLowerCase();
    if (!apiMime.includes('application/json')) throw new Error(`${prefix} ${item.title}: presentation API MIME is ${apiMime}`);
    const apiPayload = JSON.parse(api.body.toString('utf8'));
    if (apiPayload.lesson?.id !== item.lessonId || apiPayload.lesson?.downloadUrl !== item.downloadUrl) {
      throw new Error(`${prefix} ${item.title}: presentation API does not reconcile to the catalog lesson`);
    }
    if (!String(apiPayload.viewerUrl || '').startsWith('https://view.officeapps.live.com/op/embed.aspx?src=')) {
      throw new Error(`${prefix} ${item.title}: invalid Office viewer URL`);
    }
    const viewer = await inspectUrl(apiPayload.viewerUrl, 'text/html');
    const viewerHtml = viewer.body.toString('utf8');
    const viewerMime = (viewer.headers['content-type'] || '').toLowerCase();
    if (viewer.status !== 200 || !viewerMime.includes('text/html') || !viewerHtml.includes('PowerPointFrame.aspx')) {
      throw new Error(`${prefix} ${item.title}: Office viewer bootstrap did not validate`);
    }

    const structural = analyzeOoxml(download.body);
    const record = {
      ...item,
      filename,
      relativeDeckPath: path.relative(auditDir, deckPath).replace(/\\/g, '/'),
      asset: { ...asset, body: undefined },
      download: { ...download, body: undefined },
      presentationApi: {
        url: apiUrl.href,
        status: api.status,
        headers: api.headers,
        bytes: api.bytes,
        sha256: api.sha256,
        payload: apiPayload
      },
      officeViewerBootstrap: {
        url: apiPayload.viewerUrl,
        status: viewer.status,
        finalUrl: viewer.finalUrl,
        headers: viewer.headers,
        bytes: viewer.bytes,
        sha256: viewer.sha256,
        hasPowerPointFrame: true
      },
      structuralSummary: {
        slideCount: structural.slideCount,
        hiddenSlideCount: structural.hiddenSlideCount,
        packagePartCount: structural.packagePartCount,
        mediaCount: structural.mediaCount,
        mediaBytes: structural.mediaBytes,
        slideSize: structural.slideSize,
        externalLinks: structural.externalLinks,
        missingInternalTargets: structural.missingInternalTargets,
        unresolvedPromptSlides: structural.unresolvedPromptSlides,
        potentialOutOfBoundsSlides: structural.potentialOutOfBoundsSlides
      },
      structuralPath: `structural/${prefix}-${slug(item.title)}.json`
    };
    await Promise.all([
      writeFile(path.join(structuralDir, `${prefix}-${slug(item.title)}.json`), JSON.stringify({
        ordinal: item.ordinal,
        courseId: item.courseId,
        lessonId: item.lessonId,
        title: item.title,
        filename,
        fileSha256: download.sha256,
        ...structural
      }, null, 2)),
      writeFile(path.join(metadataDir, `${prefix}-${slug(item.title)}.json`), JSON.stringify(record, null, 2))
    ]);
    process.stdout.write(`${prefix}/30 ${item.title}: ${structural.slideCount} slides, ${download.bytes} bytes\n`);
    return record;
  });

  const totalSlides = records.reduce((sum, item) => sum + item.structuralSummary.slideCount, 0);
  const summary = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    site: options.site,
    catalogRevision: catalog.revision,
    catalogSha256: sha256(catalogBody),
    presentationCount: records.length,
    slideCount: totalSlides,
    typeCounts: Object.fromEntries([...PRESENTATION_TYPES].map(type => [type, records.filter(item => item.type === type).length])),
    allAssetHttp200: records.every(item => item.asset.status === 200),
    allDownloadHttp200: records.every(item => item.download.status === 200),
    allPresentationApiHttp200: records.every(item => item.presentationApi.status === 200),
    allOfficeBootstrapHttp200: records.every(item => item.officeViewerBootstrap.status === 200),
    allMimeValid: records.every(item => OOXML_MIMES.has((item.download.headers['content-type'] || '').split(';')[0].trim().toLowerCase())),
    allAssetAndDownloadHashesMatch: records.every(item => item.asset.sha256 === item.download.sha256),
    allManaged: records.every(item => item.managed),
    missingInternalTargetCount: records.reduce((sum, item) => sum + item.structuralSummary.missingInternalTargets.length, 0),
    unresolvedPromptSlideCount: records.reduce((sum, item) => sum + item.structuralSummary.unresolvedPromptSlides.length, 0),
    potentialOutOfBoundsSlideCount: records.reduce((sum, item) => sum + item.structuralSummary.potentialOutOfBoundsSlides.length, 0),
    records
  };
  await writeFile(path.join(auditDir, 'structural-index.json'), JSON.stringify(summary, null, 2));
  if (totalSlides !== 570) throw new Error(`Expected 570 slides; OOXML packages contain ${totalSlides}`);
  process.stdout.write(`Validated ${records.length} presentations and ${totalSlides} OOXML slides.\n`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
