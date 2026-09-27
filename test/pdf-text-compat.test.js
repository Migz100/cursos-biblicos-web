const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'reader.js'), 'utf8');
const start = source.indexOf('async function readPageTextContent(');
const end = source.indexOf('\nasync function renderCanonicalFieldCanvas(', start);
assert.ok(start >= 0 && end > start, 'missing compatible PDF text reader');
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const readPageTextContent = context.readPageTextContent;

test('PDF text remains complete when ReadableStream has no async iterator', async () => {
  const first = { str: '¿Qué orden recibieron?', transform: [1, 0, 0, 1, 20, 30], width: 100 };
  const second = { str: 'Apocalipsis 1:10 y 11', transform: [1, 0, 0, 1, 20, 60], width: 90 };
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ items: [first], styles: { f1: { fontFamily: 'serif' } }, lang: null });
      controller.enqueue({ items: [second], styles: { f2: { fontFamily: 'sans-serif' } }, lang: 'es' });
      controller.close();
    }
  });
  Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
  const text = await readPageTextContent({
    streamTextContent: () => stream,
    getTextContent() { throw new Error('unsupported async stream iteration'); }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(text)), {
    items: [first, second],
    styles: { f1: { fontFamily: 'serif' }, f2: { fontFamily: 'sans-serif' } },
    lang: 'es'
  });
  assert.equal(stream.locked, false);
});

test('PDF text extraction failures are preserved and release the stream reader', async () => {
  const failure = new Error('PDF text extraction failed');
  const stream = new ReadableStream({ start(controller) { controller.error(failure); } });
  await assert.rejects(readPageTextContent({ streamTextContent: () => stream }), error => error === failure);
  assert.equal(stream.locked, false);
});

test('pure XFA documents keep their original PDF.js text extraction', async () => {
  const expected = { items: [{ str: 'Contenido XFA' }], styles: {}, lang: 'es' };
  const actual = await readPageTextContent({
    isPureXfa: true,
    getTextContent: async () => expected,
    streamTextContent() { throw new Error('XFA must keep its native extraction'); }
  });
  assert.equal(actual, expected);
});
