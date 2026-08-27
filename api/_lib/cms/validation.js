const { CmsError } = require('./core');
const zlib = require('node:zlib');

function startsWith(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function zipEntryNames(buffer) {
  let end = -1;
  for (let index = buffer.length - 22; index >= 0; index--) {
    if (buffer.readUInt32LE(index) === 0x06054B50) { end = index; break; }
  }
  if (end < 0) return [];
  const directorySize = buffer.readUInt32LE(end + 12);
  const start = end - directorySize;
  if (start < 0) return [];
  const names = [];
  let offset = start;
  while (offset + 46 <= end && buffer.readUInt32LE(offset) === 0x02014B50) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) return [];
    names.push(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset = next;
  }
  return offset === end ? names : [];
}

function zipEntries(buffer) {
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65558); index--) {
    if (buffer.readUInt32LE(index) === 0x06054B50) { end = index; break; }
  }
  if (end < 0) return [];
  const directorySize = buffer.readUInt32LE(end + 12);
  const start = end - directorySize;
  if (start < 0) return [];
  const entries = [];
  let offset = start;
  while (offset + 46 <= end && buffer.readUInt32LE(offset) === 0x02014B50) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) return [];
    entries.push({
      name: buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      method,
      compressedSize,
      uncompressedSize,
      localOffset
    });
    offset = next;
  }
  return offset === end ? entries : [];
}

function extractZipEntry(buffer, wantedName, maximumSize = 40 * 1024 * 1024) {
  const entry = zipEntries(buffer).find(item => item.name.toLowerCase() === String(wantedName).toLowerCase());
  if (!entry || entry.uncompressedSize > maximumSize || entry.localOffset + 30 > buffer.length) return null;
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034B50) return null;
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start < 0 || end > buffer.length) return null;
  const compressed = buffer.subarray(start, end);
  let output;
  if (entry.method === 0) output = Buffer.from(compressed);
  else if (entry.method === 8) output = zlib.inflateRawSync(compressed, { maxOutputLength: maximumSize });
  else return null;
  if (output.length !== entry.uncompressedSize) return null;
  return output;
}

function validateMagic(type, head, tail = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(head) || head.length < 8) {
    throw new CmsError(400, 'INVALID_FILE_CONTENT', 'El archivo está vacío o dañado.');
  }
  if (type === 'pdf') {
    if (head.subarray(0, 5).toString('ascii') !== '%PDF-' || !tail.toString('latin1').includes('%%EOF')) {
      throw new CmsError(400, 'INVALID_FILE_CONTENT', 'El archivo no es un PDF válido.');
    }
    return true;
  }
  if (type === 'ppt') {
    const combined = Buffer.concat([head, tail]);
    const hasPowerPointStream = combined.includes(Buffer.from('PowerPoint Document', 'utf16le')) ||
      combined.includes(Buffer.from('Current User', 'utf16le'));
    if (!startsWith(head, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) || !hasPowerPointStream) {
      throw new CmsError(400, 'INVALID_FILE_CONTENT', 'El archivo no es una presentación PPT válida.');
    }
    return true;
  }
  if (type === 'pptx' || type === 'ppsx') {
    if (!startsWith(head, [0x50, 0x4B])) {
      throw new CmsError(400, 'INVALID_FILE_CONTENT', 'El archivo no es una presentación válida.');
    }
    const entries = new Set(zipEntryNames(tail));
    if (
      !entries.has('[Content_Types].xml') ||
      !entries.has('_rels/.rels') ||
      !entries.has('ppt/presentation.xml') ||
      !entries.has('ppt/_rels/presentation.xml.rels')
    ) {
      throw new CmsError(400, 'INVALID_FILE_CONTENT', 'El archivo no contiene una presentación de PowerPoint.');
    }
    return true;
  }
  if (type === 'pages') {
    if (!startsWith(head, [0x50, 0x4B])) {
      throw new CmsError(400, 'INVALID_FILE_CONTENT', 'El archivo no es un documento de Pages válido.');
    }
    const entries = new Set(zipEntryNames(tail));
    const hasPagesDocument = [...entries].some(name =>
      name === 'index.xml' || name === 'Index/Document.iwa' || name === 'Index/DocumentStylesheet.iwa'
    );
    if (!hasPagesDocument) {
      throw new CmsError(400, 'INVALID_FILE_CONTENT', 'El archivo no contiene un documento de Apple Pages.');
    }
    return true;
  }
  if (type === 'jpg' || type === 'jpeg') {
    if (!startsWith(head, [0xFF, 0xD8, 0xFF])) throw new CmsError(400, 'INVALID_FILE_CONTENT', 'La imagen JPG no es válida.');
    return true;
  }
  if (type === 'png') {
    if (!startsWith(head, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
      throw new CmsError(400, 'INVALID_FILE_CONTENT', 'La imagen PNG no es válida.');
    }
    return true;
  }
  if (type === 'webp') {
    if (head.subarray(0, 4).toString('ascii') !== 'RIFF' || head.subarray(8, 12).toString('ascii') !== 'WEBP') {
      throw new CmsError(400, 'INVALID_FILE_CONTENT', 'La imagen WebP no es válida.');
    }
    return true;
  }
  throw new CmsError(400, 'INVALID_FILE_TYPE', 'El tipo de archivo no es válido.');
}

module.exports = { extractZipEntry, validateMagic, zipEntries, zipEntryNames };
