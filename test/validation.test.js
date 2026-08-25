const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMagic } = require('../api/_lib/cms/validation');

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
