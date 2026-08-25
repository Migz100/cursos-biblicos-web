const { CmsError } = require('./core');

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
  throw new CmsError(400, 'INVALID_FILE_TYPE', 'El tipo de archivo no es válido.');
}

module.exports = { validateMagic, zipEntryNames };
