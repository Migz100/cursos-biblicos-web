const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { extractZipEntry, validateMagic } = require('../api/_lib/cms/validation');

function oneFileZip(name, contents, method = 8) {
  const encodedName = Buffer.from(name);
  const raw = Buffer.from(contents);
  const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30 + encodedName.length + compressed.length);
  local.writeUInt32LE(0x04034B50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  encodedName.copy(local, 30);
  compressed.copy(local, 30 + encodedName.length);
  const directory = Buffer.alloc(46 + encodedName.length);
  directory.writeUInt32LE(0x02014B50, 0);
  directory.writeUInt16LE(method, 10);
  directory.writeUInt32LE(compressed.length, 20);
  directory.writeUInt32LE(raw.length, 24);
  directory.writeUInt16LE(encodedName.length, 28);
  encodedName.copy(directory, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, directory, end]);
}

test('validates PDF and legacy PPT signatures', () => {
  assert.equal(validateMagic('pdf', Buffer.from('%PDF-1.7\nexample'), Buffer.from('trailer\n%%EOF')), true);
  const ppt = Buffer.concat([
    Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
    Buffer.from('PowerPoint Document', 'utf16le')
  ]);
  assert.equal(validateMagic('ppt', ppt), true);
  assert.throws(() => validateMagic('pdf', Buffer.from('%PDF-1.7\nexample'), Buffer.from('no trailer')));
  assert.throws(() => validateMagic('ppt', Buffer.from('not a ppt')));
});

test('validates PowerPoint Open XML structure, not just a zip extension', () => {
  const names = ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels'];
  const records = names.map(name => {
    const encoded = Buffer.from(name);
    const record = Buffer.alloc(46 + encoded.length);
    record.writeUInt32LE(0x02014B50, 0);
    record.writeUInt16LE(encoded.length, 28);
    encoded.copy(record, 46);
    return record;
  });
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  const head = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(12)]);
  const tail = Buffer.concat([directory, end]);
  assert.equal(validateMagic('pptx', head, tail), true);
  assert.equal(validateMagic('ppsx', head, tail), true);
  assert.throws(() => validateMagic('pptx', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(20)]), Buffer.from('ordinary zip')));
});

test('validates Pages packages and supported course cover images', () => {
  const name = Buffer.from('Index/Document.iwa');
  const directory = Buffer.alloc(46 + name.length);
  directory.writeUInt32LE(0x02014B50, 0);
  directory.writeUInt16LE(name.length, 28);
  name.copy(directory, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  const head = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(12)]);
  assert.equal(validateMagic('pages', head, Buffer.concat([directory, end])), true);
  assert.equal(validateMagic('jpg', Buffer.from([0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0])), true);
  assert.equal(validateMagic('png', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), true);
  assert.equal(validateMagic('webp', Buffer.from('RIFF0000WEBP')), true);
  assert.throws(() => validateMagic('pages', head, Buffer.from('ordinary zip')));
});

test('extracts an embedded PDF preview from a Pages-compatible ZIP', () => {
  const preview = Buffer.from('%PDF-1.7\nPages preview\n%%EOF');
  for (const method of [0, 8]) {
    const archive = oneFileZip('QuickLook/Preview.pdf', preview, method);
    assert.deepEqual(extractZipEntry(archive, 'quicklook/preview.pdf'), preview);
  }
  assert.equal(extractZipEntry(oneFileZip('Index/Document.iwa', 'iwa'), 'QuickLook/Preview.pdf'), null);
});
