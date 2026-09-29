const { strFromU8, unzipSync } = require('fflate');
const BibleVerses = require('../../../verses.js');

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_XML_BYTES = 12 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_SLIDES = 500;
const PUBLIC_BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/i;
const cache = new Map();

function decodeXml(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, entity => {
    const token = entity.slice(1, -1).toLowerCase();
    if (token === 'amp') return '&';
    if (token === 'lt') return '<';
    if (token === 'gt') return '>';
    if (token === 'quot') return '"';
    if (token === 'apos') return "'";
    const codePoint = token.startsWith('#x') ? Number.parseInt(token.slice(2), 16) : Number.parseInt(token.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
  });
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeXml(match[2]) : '';
}

function normalizePart(basePart, target) {
  const parts = String(basePart || '').replace(/\\/g, '/').split('/');
  parts.pop();
  for (const segment of String(target || '').replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return '';
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

function wantedXml(name) {
  return name === 'ppt/presentation.xml' ||
    name === 'ppt/_rels/presentation.xml.rels' ||
    /^ppt\/slides\/slide\d+\.xml$/i.test(name);
}

function extractZipXml(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('INVALID_PRESENTATION_SIZE');
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('INVALID_PRESENTATION_ZIP');
  let inflatedBytes = 0;
  const entries = unzipSync(bytes, {
    filter(file) {
      if (!wantedXml(file.name)) return false;
      if (file.originalSize > MAX_XML_ENTRY_BYTES) throw new Error('PRESENTATION_XML_TOO_LARGE');
      inflatedBytes += file.originalSize;
      if (inflatedBytes > MAX_XML_BYTES) throw new Error('PRESENTATION_XML_TOO_LARGE');
      return true;
    }
  });
  return Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, strFromU8(data)]));
}

function orderedSlideParts(xml) {
  const presentation = xml['ppt/presentation.xml'];
  const relationships = xml['ppt/_rels/presentation.xml.rels'];
  if (!presentation || !relationships) throw new Error('PRESENTATION_STRUCTURE_MISSING');
  const targets = new Map();
  for (const match of relationships.matchAll(/<Relationship\b[^>]*>/gi)) {
    const id = attribute(match[0], 'Id');
    const target = attribute(match[0], 'Target');
    const type = attribute(match[0], 'Type');
    if (id && target && /\/slide$/i.test(type)) targets.set(id, normalizePart('ppt/presentation.xml', target));
  }
  const parts = [];
  for (const match of presentation.matchAll(/<p:sldId\b[^>]*>/gi)) {
    const id = attribute(match[0], 'r:id');
    const part = targets.get(id);
    if (part && xml[part]) parts.push(part);
  }
  if (!parts.length) throw new Error('PRESENTATION_SLIDES_MISSING');
  if (parts.length > MAX_SLIDES) throw new Error('PRESENTATION_TOO_MANY_SLIDES');
  return parts;
}

function extractSlideText(xml) {
  const paragraphs = [];
  for (const paragraph of String(xml || '').matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi)) {
    const runs = [...paragraph[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)].map(match => decodeXml(match[1]));
    const text = runs.join('').replace(/[ \t]+/g, ' ').trim();
    if (text) paragraphs.push(text);
  }
  if (!paragraphs.length) {
    const runs = [...String(xml || '').matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)].map(match => decodeXml(match[1]));
    const text = runs.join(' ').replace(/\s+/g, ' ').trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs.join('\n').slice(0, 20000);
}

function publicReference(reference, sourceText) {
  return {
    source: sourceText.slice(reference.index, reference.end),
    label: BibleVerses.formatReference(reference),
    bookId: reference.bookId,
    bookName: reference.bookName,
    parts: reference.parts.map(part => ({ chapter: part.chapter, verses: [...part.verses] }))
  };
}

function extractPresentationAccessibility(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const xml = extractZipXml(bytes);
  const parts = orderedSlideParts(xml);
  const slides = parts.map((part, index) => {
    const text = extractSlideText(xml[part]);
    const references = BibleVerses.findReferences(text).map(reference => publicReference(reference, text));
    return { number: index + 1, sourcePart: part, text, references };
  });
  return {
    status: 'available',
    slideCount: slides.length,
    referenceCount: slides.reduce((sum, slide) => sum + slide.references.length, 0),
    slides
  };
}

function trustedDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !PUBLIC_BLOB_HOST.test(url.hostname) || url.username || url.password) {
    throw new Error('UNTRUSTED_PRESENTATION_URL');
  }
  return url.href;
}

async function fetchPresentationAccessibility(downloadUrl, type) {
  if (!['pptx', 'ppsx'].includes(String(type || '').toLowerCase())) {
    return { status: 'unavailable', reason: 'legacy-binary-presentation', slideCount: null, referenceCount: 0, slides: [] };
  }
  const url = trustedDownloadUrl(downloadUrl);
  if (cache.has(url)) return cache.get(url);
  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: controller.signal });
      if (!response.ok) throw new Error('PRESENTATION_DOWNLOAD_FAILED');
      trustedDownloadUrl(response.url);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_ARCHIVE_BYTES) throw new Error('INVALID_PRESENTATION_SIZE');
      const bytes = new Uint8Array(await response.arrayBuffer());
      return extractPresentationAccessibility(bytes);
    } finally {
      clearTimeout(timer);
    }
  })().catch(() => ({ status: 'unavailable', reason: 'extraction-failed', slideCount: null, referenceCount: 0, slides: [] }));
  cache.set(url, task);
  return task;
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  extractPresentationAccessibility,
  extractSlideText,
  fetchPresentationAccessibility,
  orderedSlideParts
};
