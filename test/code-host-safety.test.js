const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIBRARY_URL = pathToFileURL(path.resolve(__dirname, '../scripts/code-host-lib.mjs')).href;
let libraryPromise;

function library() {
  libraryPromise ||= import(LIBRARY_URL);
  return libraryPromise;
}

function tempArea(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cursos-code-safety-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function upload(name, mime, data, extra = {}) {
  return {
    name,
    mime,
    data: data.toString('base64'),
    declaredSize: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    ...extra
  };
}

function expectCode(assertion, code) {
  assert.throws(assertion, error => error?.code === code);
}

test('validated image and PDF uploads preserve exact bytes and trusted metadata', async () => {
  const { validateUpload } = await library();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'ascii');

  const image = validateUpload(upload('portada.png', 'image/png', png));
  assert.equal(image.name, 'portada.png');
  assert.equal(image.mime, 'image/png');
  assert.equal(image.extension, '.png');
  assert.equal(image.size, png.length);
  assert.deepEqual(image.data, png);

  const document = validateUpload(upload('leccion.pdf', 'application/pdf', pdf));
  assert.equal(document.mime, 'application/pdf');
  assert.equal(document.extension, '.pdf');
  assert.deepEqual(document.data, pdf);

  const maximum = Buffer.alloc(3 * 1024 * 1024);
  maximum.write('%PDF-1.7\n', 0, 'ascii');
  assert.equal(validateUpload(upload('limite.pdf', 'application/pdf', maximum)).size, 3 * 1024 * 1024);
});

test('uploads reject traversal, oversize, executables, MIME spoofing, and checksum mismatch', async () => {
  const { HOST_ERROR_CODES, validateUpload } = await library();
  const pdf = Buffer.from('%PDF-1.7\n%%EOF\n', 'ascii');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const executable = Buffer.from('4d5a90000300000004000000ffff0000', 'hex');

  for (const name of ['../leccion.pdf', '..\\leccion.pdf', '/tmp/leccion.pdf', 'C:\\temp\\leccion.pdf']) {
    expectCode(
      () => validateUpload(upload(name, 'application/pdf', pdf)),
      HOST_ERROR_CODES.UPLOAD_NAME_INVALID
    );
  }
  expectCode(
    () => {
      const tooLarge = Buffer.alloc(3 * 1024 * 1024 + 1);
      tooLarge.write('%PDF-1.7\n', 0, 'ascii');
      validateUpload(upload('grande.pdf', 'application/pdf', tooLarge));
    },
    HOST_ERROR_CODES.UPLOAD_TOO_LARGE
  );
  expectCode(
    () => validateUpload(upload('programa.exe', 'application/pdf', executable)),
    HOST_ERROR_CODES.UPLOAD_NAME_INVALID
  );
  expectCode(
    () => validateUpload(upload('disfraz.pdf', 'application/pdf', executable)),
    HOST_ERROR_CODES.UPLOAD_SIGNATURE_INVALID
  );
  expectCode(
    () => validateUpload(upload('disfraz.pdf', 'application/pdf', png)),
    HOST_ERROR_CODES.UPLOAD_SIGNATURE_INVALID
  );
  expectCode(
    () => validateUpload(upload('disfraz.png', 'image/png', pdf)),
    HOST_ERROR_CODES.UPLOAD_SIGNATURE_INVALID
  );
  expectCode(
    () => validateUpload(upload('leccion.pdf', 'application/pdf', pdf, { sha256: '0'.repeat(64) })),
    HOST_ERROR_CODES.UPLOAD_HASH_MISMATCH
  );
  expectCode(
    () => validateUpload({ name: 'leccion.pdf', mime: 'application/pdf', data: 'not base64!' }),
    HOST_ERROR_CODES.UPLOAD_INVALID
  );
  expectCode(
    () => validateUpload([upload('uno.pdf', 'application/pdf', pdf), upload('dos.pdf', 'application/pdf', pdf)]),
    HOST_ERROR_CODES.UPLOAD_INVALID
  );
});

test('attachment budget accumulates separate calls up to four files and 12 MiB per turn', async () => {
  const { AttachmentBudget, HOST_ERROR_CODES } = await library();
  const oneMiB = 1024 * 1024;
  const budget = new AttachmentBudget();
  const ids = [
    '01900000-0000-7000-8000-000000000020',
    '01900000-0000-7000-8000-000000000021',
    '01900000-0000-7000-8000-000000000022',
    '01900000-0000-7000-8000-000000000023',
    '01900000-0000-7000-8000-000000000024'
  ];

  for (let index = 0; index < 4; index++) {
    assert.deepEqual(budget.add({ id: ids[index], size: 3 * oneMiB }), {
      count: index + 1,
      totalBytes: (index + 1) * 3 * oneMiB
    });
  }
  assert.deepEqual(budget.add({ id: ids[0], size: 3 * oneMiB }), { count: 4, totalBytes: 12 * oneMiB });
  expectCode(
    () => budget.add({ id: ids[4], size: 1 }),
    HOST_ERROR_CODES.UPLOAD_TOO_LARGE
  );

  const byteLimited = new AttachmentBudget({ maxFiles: 10 });
  byteLimited.add({ id: ids[0], size: 12 * oneMiB });
  expectCode(
    () => byteLimited.add({ id: ids[1], size: 1 }),
    HOST_ERROR_CODES.UPLOAD_TOO_LARGE
  );
});

test('staging is confined, exclusive, integrity checked, and cannot overwrite', async t => {
  const { stageAttachment, validateUpload } = await library();
  const root = path.join(tempArea(t), 'attachments');
  const pdf = Buffer.from('%PDF-1.7\n%%EOF\n', 'ascii');
  const validated = validateUpload(upload('leccion.pdf', 'application/pdf', pdf));
  const id = '01900000-0000-7000-8000-000000000010';

  const staged = stageAttachment(root, validated, { id });
  assert.equal(path.dirname(staged.path), path.resolve(root));
  assert.equal(staged.id, id);
  assert.deepEqual(fs.readFileSync(staged.path), pdf);
  assert.equal(staged.sha256, validated.sha256);

  assert.throws(() => stageAttachment(root, validated, { id }));
  assert.deepEqual(fs.readFileSync(staged.path), pdf);
});

test('workspace path checks reject escapes, missing paths, and symlink or reparse traversal', async t => {
  const { HOST_ERROR_CODES, assertWorkspacePath } = await library();
  const area = tempArea(t);
  const root = path.join(area, 'workspace');
  const sibling = path.join(area, 'workspace-escape');
  const nested = path.join(root, 'safe', 'file.txt');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(nested, 'safe\n');
  fs.writeFileSync(path.join(sibling, 'outside.txt'), 'outside\n');

  assert.equal(assertWorkspacePath(root, nested), path.resolve(nested));
  assert.equal(
    assertWorkspacePath(root, path.join(root, 'new', 'attachment.pdf'), { allowMissing: true }),
    path.resolve(root, 'new', 'attachment.pdf')
  );
  expectCode(
    () => assertWorkspacePath(root, path.join(sibling, 'outside.txt')),
    HOST_ERROR_CODES.PATH_OUTSIDE_WORKSPACE
  );
  expectCode(
    () => assertWorkspacePath(root, path.join(root, 'missing.txt')),
    HOST_ERROR_CODES.PATH_NOT_FOUND
  );

  const link = path.join(root, 'linked-outside');
  try {
    fs.symlinkSync(sibling, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`This OS did not permit a test reparse point: ${error.code}`);
      return;
    }
    throw error;
  }
  expectCode(
    () => assertWorkspacePath(root, path.join(link, 'outside.txt')),
    HOST_ERROR_CODES.PATH_REPARSE_POINT
  );
});

test('a staged target that is already a symlink or reparse point is never followed', async t => {
  const { HOST_ERROR_CODES, stageAttachment, validateUpload } = await library();
  const area = tempArea(t);
  const root = path.join(area, 'attachments');
  const outside = path.join(area, 'outside.pdf');
  const pdf = Buffer.from('%PDF-1.7\n%%EOF\n', 'ascii');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(outside, 'do not overwrite\n');
  const id = '01900000-0000-7000-8000-000000000011';
  const target = path.join(root, `${id}-leccion.pdf`);
  try {
    fs.symlinkSync(outside, target, 'file');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`This OS did not permit a test symlink: ${error.code}`);
      return;
    }
    throw error;
  }

  expectCode(
    () => stageAttachment(root, validateUpload(upload('leccion.pdf', 'application/pdf', pdf)), { id }),
    HOST_ERROR_CODES.PATH_REPARSE_POINT
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do not overwrite\n');
});
