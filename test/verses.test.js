const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BibleVerses = require('../verses.js');

test('detects common Spanish reference shapes', () => {
  const cases = [
    ['(2 Timoteo 3:16)', '55-2-timoteo', 3, [16]],
    ['Juan 3:16, 17', '43-juan', 3, [16, 17]],
    ['Apoc. 14:6-12', '66-apocalipsis', 14, [6, 7, 8, 9, 10, 11, 12]],
    ['Salmos 34:4, 5', '19-salmos', 34, [4, 5]],
    ['Hechos 17:11', '44-hechos', 17, [11]],
    ['lee Éxodo 20:8-11 y compara', '02-exodo', 20, [8, 9, 10, 11]],
    ['Génesis 1:1', '01-genesis', 1, [1]],
    ['San Juan 14:6', '43-juan', 14, [6]]
  ];
  for (const [text, bookId, chapter, verses] of cases) {
    const [ref] = BibleVerses.findReferences(text);
    assert.ok(ref, `sin referencia en: ${text}`);
    assert.equal(ref.bookId, bookId, text);
    assert.equal(ref.parts[0].chapter, chapter, text);
    assert.deepEqual(ref.parts[0].verses, verses, text);
  }
});

test('same-book continuation keeps chapters separate', () => {
  const [ref] = BibleVerses.findReferences('(1 Juan 5:11-13; 1:9)');
  assert.equal(ref.bookId, '62-1-juan');
  assert.deepEqual(ref.parts, [
    { chapter: 5, verses: [11, 12, 13] },
    { chapter: 1, verses: [9] }
  ]);
  const [pedro] = BibleVerses.findReferences('1 Pedro 2:2; 5:7');
  assert.deepEqual(pedro.parts, [{ chapter: 2, verses: [2] }, { chapter: 5, verses: [7] }]);
});

test('supports chapter ranges, numbered-book variants, and mixed lists', () => {
  const [chapters] = BibleVerses.findReferences('Lee Génesis 1-3 antes de la próxima lección.');
  assert.deepEqual(chapters.parts, [
    { chapter: 1, verses: [] },
    { chapter: 2, verses: [] },
    { chapter: 3, verses: [] }
  ]);

  const [roman] = BibleVerses.findReferences('II Corintios 5:17; 6:1-2');
  assert.equal(roman.bookId, '47-2-corintios');
  assert.deepEqual(roman.parts, [
    { chapter: 5, verses: [17] },
    { chapter: 6, verses: [1, 2] }
  ]);

  const [ordinal] = BibleVerses.findReferences('1ª de Juan 5:11-13; 1:9');
  assert.equal(ordinal.bookId, '62-1-juan');
  assert.deepEqual(ordinal.parts, [
    { chapter: 5, verses: [11, 12, 13] },
    { chapter: 1, verses: [9] }
  ]);

  const [sameChapterList] = BibleVerses.findReferences('Juan 3:16; 18-20');
  assert.deepEqual(sameChapterList.parts, [
    { chapter: 3, verses: [16] },
    { chapter: 3, verses: [18, 19, 20] }
  ]);
});

test('recognizes the numbered San Pedro and Deuteronomio spellings used in the actual slides', () => {
  const references = BibleVerses.findReferences('2 S. Pedro 3:7,10; 1 S. Pedro 2:24; DeuteronÃ³mio 16:17');
  assert.deepEqual(references.map(item => item.bookId), ['61-2-pedro', '60-1-pedro', '05-deuteronomio']);
  assert.equal(BibleVerses.findReferences('2.300 tardes y maÃ±anas').length, 0);
});

test('chapter-only references resolve to whole chapter', () => {
  const [ref] = BibleVerses.findReferences('estudia Daniel 2 esta semana');
  assert.equal(ref.bookId, '27-daniel');
  assert.equal(ref.parts[0].chapter, 2);
  assert.deepEqual(ref.parts[0].verses, []);
});

test('no false positives on plain text', () => {
  assert.equal(BibleVerses.findReferences('Bienvenido al curso de la semana 3').length, 0);
  assert.equal(BibleVerses.findReferences('ARCHIVO 14 FE 3 USO 20').length, 0);
  assert.equal(BibleVerses.findReferences('https://ejemplo.test/Juan3:16').length, 0);
  assert.equal(BibleVerses.findReferences('').length, 0);
});

test('handles PDF extraction quirks', () => {
  const [noSpace] = BibleVerses.findReferences('( 1Juan 3:1)');
  assert.equal(noSpace.bookId, '62-1-juan');
  assert.equal(BibleVerses.findReferences('( Juan14:1-3)')[0].parts[0].verses.join(','), '1,2,3');
  const normalized = BibleVerses.normalizeExtracted('(Mala- quías 3:10)');
  const [mal] = BibleVerses.findReferences(normalized.text);
  assert.equal(mal.bookId, '39-malaquias');
  const [eze] = BibleVerses.findReferences('(Eze. 43:2)');
  assert.equal(eze.bookId, '26-ezequiel');
  const [rey] = BibleVerses.findReferences('(1 Rey. 16:31)');
  assert.equal(rey.bookId, '11-1-reyes');
});

test('single-chapter books treat the number as a verse', () => {
  const [judas] = BibleVerses.findReferences('Judas 9');
  assert.deepEqual(judas.parts, [{ chapter: 1, verses: [9] }]);
  const [juan3] = BibleVerses.findReferences('3 Juan 2');
  assert.deepEqual(juan3.parts, [{ chapter: 1, verses: [2] }]);
});

test('bare citations inherit the fallback book', () => {
  const refs = BibleVerses.findReferences('como dice Ezequiel 18:20 y después (18:4)', '26-ezequiel');
  assert.equal(refs.length, 2);
  assert.equal(refs[1].bookId, '26-ezequiel');
  assert.equal(refs[1].parts[0].chapter, 18);
  assert.deepEqual(refs[1].parts[0].verses, [4]);
  assert.equal(BibleVerses.findReferences('(18:4)').length, 0);
});

test('referenceIsValid rejects impossible chapters and verses', () => {
  const apoc = { chapters: { '22': { '1': 'x' } } };
  const valid = { bookId: '66-apocalipsis', parts: [{ chapter: 22, verses: [1] }] };
  const badChapter = { bookId: '66-apocalipsis', parts: [{ chapter: 25, verses: [5] }] };
  const badVerse = { bookId: '66-apocalipsis', parts: [{ chapter: 22, verses: [2] }] };
  assert.equal(BibleVerses.referenceIsValid(valid, apoc), true);
  assert.equal(BibleVerses.referenceIsValid(badChapter, apoc), false);
  assert.equal(BibleVerses.referenceIsValid(badVerse, apoc), false);
});

test('every bundled book file parses and matches the parser index', () => {
  const dir = path.join(__dirname, '..', 'assets', 'bible', 'rvr1960');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.books.length, 66);
  assert.deepEqual(BibleVerses.BOOKS.map(book => book.id), index.books.map(book => book.id));
  for (const book of index.books) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${book.id}.json`), 'utf8'));
    const chapters = Object.keys(data.chapters).map(Number);
    assert.equal(chapters.length, book.chapters, book.id);
    assert.deepEqual(chapters, Array.from({ length: book.chapters }, (_, i) => i + 1), book.id);
  }
  assert.equal(index.books[0].name, 'Génesis');
  assert.equal(index.books[65].name, 'Apocalipsis');
});

test('bundled RVR1960 spot verses are authentic', () => {
  const dir = path.join(__dirname, '..', 'assets', 'bible', 'rvr1960');
  const read = (id, c, v) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).chapters[c][v];
  assert.match(read('43-juan', '3', '16'), /^Porque de tal manera amó Dios al mundo/);
  assert.match(read('55-2-timoteo', '3', '16'), /^Toda la Escritura es inspirada por Dios/);
  assert.match(read('01-genesis', '1', '1'), /^En el principio creó Dios los cielos y la tierra/);
  assert.match(read('66-apocalipsis', '14', '7'), /juicio ha llegado/);
});

test('deterministic corpus validates every current OCR reference against bundled RVR1960', t => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'verse-fields.json'), 'utf8'));
  let references = 0;
  let pageCount = 0;
  const documents = Object.entries(catalog.documents || {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [documentId, document] of documents) {
    const pageEntries = Object.entries(document.pages || {}).sort(([a], [b]) => Number(a) - Number(b));
    for (const [pageNumber, entries] of pageEntries) {
      pageCount += 1;
      for (const entry of entries) {
        references += 1;
        const expected = { bookId: entry.bookId, bookName: entry.bookName, parts: entry.parts };
        const book = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'bible', 'rvr1960', `${expected.bookId}.json`), 'utf8'));
        assert.equal(BibleVerses.referenceIsValid(expected, book), true, `${documentId} página ${pageNumber}: ${BibleVerses.formatReference(expected)}`);
        for (const key of ['x', 'y', 'w', 'h']) {
          assert.equal(Number.isFinite(entry[key]) && entry[key] >= 0 && entry[key] <= 1, true, `${documentId} página ${pageNumber}: ${key}`);
        }
        const canonical = BibleVerses.formatReference(expected);
        const [actual] = BibleVerses.findReferences(canonical);
        assert.ok(actual, `${documentId} página ${pageNumber}: ${canonical}`);
        assert.equal(actual.bookId, expected.bookId, `${documentId} página ${pageNumber}: ${canonical}`);
        assert.deepEqual(actual.parts, expected.parts, `${documentId} página ${pageNumber}: ${canonical}`);
      }
    }
  }
  assert.ok(documents.length > 0);
  assert.ok(pageCount > 0);
  assert.ok(references > 0);
  t.diagnostic(`${documents.length} documentos, ${pageCount} páginas con referencias, ${references} referencias validadas`);
});
