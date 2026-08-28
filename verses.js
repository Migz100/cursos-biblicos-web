/* Referencias bíblicas: detección y texto Reina-Valera 1960.
   Se usa en el lector (navegador), en las pruebas y en la auditoría (Node). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BibleVerses = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const BOOKS = [
    { id: '01-genesis', name: 'Génesis', aliases: ['génesis', 'genesis', 'gén', 'gen', 'gn'] },
    { id: '02-exodo', name: 'Éxodo', aliases: ['éxodo', 'exodo', 'éxo', 'exo', 'éx', 'ex'] },
    { id: '03-levitico', name: 'Levítico', aliases: ['levítico', 'levitico', 'lv', 'lev'] },
    { id: '04-numeros', name: 'Números', aliases: ['números', 'numeros', 'núm', 'num', 'nm'] },
    { id: '05-deuteronomio', name: 'Deuteronomio', aliases: ['deuteronomio', 'dt', 'deut'] },
    { id: '06-josue', name: 'Josué', aliases: ['josué', 'josue', 'jos'] },
    { id: '07-jueces', name: 'Jueces', aliases: ['jueces', 'juec', 'jue'] },
    { id: '08-rut', name: 'Rut', aliases: ['rut'] },
    { id: '09-1-samuel', name: '1 Samuel', aliases: ['1 samuel', '1 sam', '1 s', '1sa', '1 sám'] },
    { id: '10-2-samuel', name: '2 Samuel', aliases: ['2 samuel', '2 sam', '2 s', '2sa', '2 sám'] },
    { id: '11-1-reyes', name: '1 Reyes', aliases: ['1 reyes', '1 rey', '1 r', '1re', '1 re'] },
    { id: '12-2-reyes', name: '2 Reyes', aliases: ['2 reyes', '2 rey', '2 r', '2re', '2 re'] },
    { id: '13-1-cronicas', name: '1 Crónicas', aliases: ['1 crónicas', '1 cronicas', '1 crón', '1 cron', '1 cr'] },
    { id: '14-2-cronicas', name: '2 Crónicas', aliases: ['2 crónicas', '2 cronicas', '2 crón', '2 cron', '2 cr'] },
    { id: '15-esdras', name: 'Esdras', aliases: ['esdras', 'esd'] },
    { id: '16-nehemias', name: 'Nehemías', aliases: ['nehemías', 'nehemias', 'neh'] },
    { id: '17-ester', name: 'Ester', aliases: ['ester', 'est'] },
    { id: '18-job', name: 'Job', aliases: ['job'] },
    { id: '19-salmos', name: 'Salmos', aliases: ['salmos', 'salmo', 'sal', 'slm', 'sl'] },
    { id: '20-proverbios', name: 'Proverbios', aliases: ['proverbios', 'prov', 'pr', 'pro'] },
    { id: '21-eclesiastes', name: 'Eclesiastés', aliases: ['eclesiastés', 'eclesiastes', 'ecl', 'ec'] },
    { id: '22-cantares', name: 'Cantares', aliases: ['cantares', 'cantar de los cantares', 'cant', 'cnt'] },
    { id: '23-isaias', name: 'Isaías', aliases: ['isaías', 'isaias', 'isa', 'is'] },
    { id: '24-jeremias', name: 'Jeremías', aliases: ['jeremías', 'jeremias', 'jer'] },
    { id: '25-lamentaciones', name: 'Lamentaciones', aliases: ['lamentaciones', 'lam', 'lm'] },
    { id: '26-ezequiel', name: 'Ezequiel', aliases: ['ezequiel', 'ezeq', 'eze', 'ez', 'ezq'] },
    { id: '27-daniel', name: 'Daniel', aliases: ['daniel', 'dan', 'dn'] },
    { id: '28-oseas', name: 'Oseas', aliases: ['oseas'] },
    { id: '29-joel', name: 'Joel', aliases: ['joel'] },
    { id: '30-amos', name: 'Amós', aliases: ['amós', 'amos'] },
    { id: '31-obdias', name: 'Abdías', aliases: ['abdías', 'abdias', 'abd'] },
    { id: '32-jonas', name: 'Jonás', aliases: ['jonás', 'jonas', 'jon'] },
    { id: '33-miqueas', name: 'Miqueas', aliases: ['miqueas', 'miq'] },
    { id: '34-nahum', name: 'Nahúm', aliases: ['nahúm', 'nahum', 'nah'] },
    { id: '35-habacuc', name: 'Habacuc', aliases: ['habacuc', 'hab'] },
    { id: '36-sofonias', name: 'Sofonías', aliases: ['sofonías', 'sofonias', 'sof'] },
    { id: '37-hageo', name: 'Hageo', aliases: ['hageo', 'hag'] },
    { id: '38-zacarias', name: 'Zacarías', aliases: ['zacarías', 'zacarias', 'zac'] },
    { id: '39-malaquias', name: 'Malaquías', aliases: ['malaquías', 'malaquias', 'mal'] },
    { id: '40-mateo', name: 'Mateo', aliases: ['mateo', 'mt', 'mat', 's mateo', 'san mateo'] },
    { id: '41-marcos', name: 'Marcos', aliases: ['marcos', 'mr', 'mc', 'mrk', 's marcos', 'san marcos'] },
    { id: '42-lucas', name: 'Lucas', aliases: ['lucas', 'luc', 'lc', 'lu', 's lucas', 'san lucas'] },
    { id: '43-juan', name: 'Juan', aliases: ['juan', 'jn', 's juan', 'san juan'] },
    { id: '44-hechos', name: 'Hechos', aliases: ['hechos', 'hch', 'hech'] },
    { id: '45-romanos', name: 'Romanos', aliases: ['romanos', 'rom', 'ro', 'rm'] },
    { id: '46-1-corintios', name: '1 Corintios', aliases: ['1 corintios', '1 cor', '1 co'] },
    { id: '47-2-corintios', name: '2 Corintios', aliases: ['2 corintios', '2 cor', '2 co'] },
    { id: '48-galatas', name: 'Gálatas', aliases: ['gálatas', 'galatas', 'gál', 'gal'] },
    { id: '49-efesios', name: 'Efesios', aliases: ['efesios', 'ef', 'efe'] },
    { id: '50-filipenses', name: 'Filipenses', aliases: ['filipenses', 'fil', 'flp', 'filp'] },
    { id: '51-colosenses', name: 'Colosenses', aliases: ['colosenses', 'col'] },
    { id: '52-1-tesalonicenses', name: '1 Tesalonicenses', aliases: ['1 tesalonicenses', '1 tes', '1 ts'] },
    { id: '53-2-tesalonicenses', name: '2 Tesalonicenses', aliases: ['2 tesalonicenses', '2 tes', '2 ts'] },
    { id: '54-1-timoteo', name: '1 Timoteo', aliases: ['1 timoteo', '1 tim', '1 ti'] },
    { id: '55-2-timoteo', name: '2 Timoteo', aliases: ['2 timoteo', '2 tim', '2 ti'] },
    { id: '56-tito', name: 'Tito', aliases: ['tito', 'tit'] },
    { id: '57-filemon', name: 'Filemón', aliases: ['filemón', 'filemon', 'flm', 'filem'] },
    { id: '58-hebreos', name: 'Hebreos', aliases: ['hebreos', 'heb', 'hb'] },
    { id: '59-santiago', name: 'Santiago', aliases: ['santiago', 'stg', 'sant'] },
    { id: '60-1-pedro', name: '1 Pedro', aliases: ['1 pedro', '1 ped', '1 p'] },
    { id: '61-2-pedro', name: '2 Pedro', aliases: ['2 pedro', '2 ped', '2 p'] },
    { id: '62-1-juan', name: '1 Juan', aliases: ['1 juan', '1 jn', '1 j'] },
    { id: '63-2-juan', name: '2 Juan', aliases: ['2 juan', '2 jn', '2 j'] },
    { id: '64-3-juan', name: '3 Juan', aliases: ['3 juan', '3 jn', '3 j'] },
    { id: '65-judas', name: 'Judas', aliases: ['judas', 'jud'] },
    { id: '66-apocalipsis', name: 'Apocalipsis', aliases: ['apocalipsis', 'apoc', 'ap'] }
  ];

  const byId = new Map(BOOKS.map(book => [book.id, book]));

  // Longest alias first so "1 Juan" beats "Juan".
  const aliasPattern = BOOKS
    .flatMap(book => book.aliases.map(alias => ({ alias, book })))
    .sort((a, b) => b.alias.length - a.alias.length)
    .map(entry => entry.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'))
    .join('|');

  // "2 Timoteo 3:16", "Juan14:1-3", "Apoc. 14:6-12", "Salmos 34", "1 Juan 5:11-13"
  const REFERENCE_RE = new RegExp(
    `(?<![A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ])(${aliasPattern})(?![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])\\.?\\s*(\\d{1,3})(?:\\s*[:.]\\s*(\\d{1,3}(?:\\s*[-–—]\\s*\\d{1,3})?(?:\\s*,\\s*\\d{1,3}(?:\\s*[-–—]\\s*\\d{1,3})?)*))?`,
    'gi'
  );
  // Same-book continuation: "1 Pedro 2:2; 5:7" captures "; 5:7".
  const CONTINUATION_RE = /^\s*;\s*(\d{1,3})\s*[:.]\s*(\d{1,3}(?:\s*[-–—]\s*\d{1,3})?(?:\s*,\s*\d{1,3}(?:\s*[-–—]\s*\d{1,3})?)*)/;
  // Bare "18:4" style citations inherit the last book seen (reader passes it per page).
  const BARE_RE = /(?<![A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ(:])\(?\s*(\d{1,3})\s*:\s*(\d{1,3}(?:\s*[-–—]\s*\d{1,3})?(?:\s*,\s*\d{1,3}(?:\s*[-–—]\s*\d{1,3})?)*)/g;

  // Books with a single chapter: "Judas 9" means chapter 1, verse 9.
  const SINGLE_CHAPTER = new Set(['31-obdias', '57-filemon', '63-2-juan', '64-3-juan', '65-judas']);

  const BOOK_BY_ALIAS = new Map();
  BOOKS.forEach(book => book.aliases.forEach(alias => BOOK_BY_ALIAS.set(alias.replace(/\s+/g, ''), book)));

  function bookFromAlias(text) {
    return BOOK_BY_ALIAS.get(String(text || '').toLowerCase().replace(/\s+/g, '').trim()) || null;
  }

  function expandVerseSpec(spec) {
    const verses = new Set();
    String(spec || '').split(/\s*[,;]\s*/).forEach(part => {
      const range = part.match(/^(\d{1,3})\s*[-–—]\s*(\d{1,3})$/);
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), start + 30);
        for (let verse = start; verse <= end; verse += 1) verses.add(verse);
      } else if (/^\d{1,3}$/.test(part.trim())) verses.add(Number(part.trim()));
    });
    return [...verses].sort((a, b) => a - b);
  }

  // Returns [{ raw, index, bookId, bookName, parts: [{ chapter, verses }] }].
  // fallbackBookId: bare "18:4" citations resolve against that book.
  function findReferences(text, fallbackBookId = '') {
    const found = [];
    const source = String(text || '');
    REFERENCE_RE.lastIndex = 0;
    let match;
    while ((match = REFERENCE_RE.exec(source))) {
      const book = bookFromAlias(match[1]);
      if (!book) continue;
      let chapter = Number(match[2]);
      let verses = expandVerseSpec(match[3] || '');
      if (SINGLE_CHAPTER.has(book.id) && !match[3]) {
        verses = [chapter];
        chapter = 1;
      }
      const parts = [{ chapter, verses }];
      let end = match.index + match[0].length;
      let continuation;
      while ((continuation = CONTINUATION_RE.exec(source.slice(end)))) {
        parts.push({ chapter: Number(continuation[1]), verses: expandVerseSpec(continuation[2]) });
        end += continuation[0].length;
      }
      found.push({
        raw: source.slice(match.index, end),
        index: match.index,
        end,
        bookId: book.id,
        bookName: book.name,
        parts
      });
      REFERENCE_RE.lastIndex = end;
    }
    const fallback = byId.get(fallbackBookId);
    if (fallback) {
      BARE_RE.lastIndex = 0;
      let bare;
      while ((bare = BARE_RE.exec(source))) {
        const start = bare.index;
        const end = bare.index + bare[0].length;
        if (found.some(ref => start < ref.end && ref.index < end)) continue;
        found.push({
          raw: source.slice(start, end),
          index: start,
          end,
          bookId: fallback.id,
          bookName: fallback.name,
          parts: [{ chapter: Number(bare[1]), verses: expandVerseSpec(bare[2]) }]
        });
      }
      found.sort((a, b) => a.index - b.index);
    }
    return found;
  }

  // Joins words split by a line-break hyphen ("Apocalip- sis" -> "Apocalipsis"),
  // returning { text, map } where map[i] is the raw index of normalized char i.
  function normalizeExtracted(raw) {
    const source = String(raw || '');
    let text = '';
    const map = [];
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if ((char === '-' || char === '–') && i > 0 && /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(source[i - 1])) {
        let j = i + 1;
        while (j < source.length && /\s/.test(source[j])) j += 1;
        if (j < source.length && /[a-záéíóúüñ]/.test(source[j])) {
          i = j - 1;
          continue;
        }
      }
      map.push(i);
      text += char;
    }
    map.push(source.length);
    return { text, map };
  }

  function formatReference(ref) {
    return ref.parts
      .map(part => `${part.chapter}${part.verses.length ? `:${part.verses.join(',')}` : ''}`)
      .join('; ')
      .replace(/^/, `${ref.bookName} `);
  }

  const bookCache = new Map();

  async function fetchBook(bookId, basePath = 'assets/bible/rvr1960/') {
    if (!bookCache.has(bookId)) {
      bookCache.set(bookId, fetch(`${basePath}${bookId}.json`, { cache: 'force-cache' })
        .then(response => (response.ok ? response.json() : null))
        .catch(() => null));
    }
    return bookCache.get(bookId);
  }

  // Resolves a reference to displayable blocks: [{ heading, lines: [{ verse, text }] }].
  async function resolveReference(ref, basePath) {
    const data = await fetchBook(ref.bookId, basePath);
    const chapters = data?.chapters || {};
    return ref.parts.map(part => {
      const chapterText = chapters[String(part.chapter)] || {};
      const wanted = part.verses.length ? part.verses : Object.keys(chapterText).map(Number).sort((a, b) => a - b);
      return {
        heading: `${ref.bookName} ${part.chapter}${part.verses.length ? `:${part.verses.join(', ')}` : ''}`,
        lines: wanted.map(verse => ({ verse, text: chapterText[String(verse)] || '' }))
      };
    });
  }

  // True when every part of the reference exists in the bundled book data.
  function referenceIsValid(ref, data) {
    const chapters = data?.chapters;
    if (!chapters) return false;
    return ref.parts.every(part => {
      const chapterText = chapters[String(part.chapter)];
      if (!chapterText) return false;
      return part.verses.every(verse => Boolean(chapterText[String(verse)]));
    });
  }

  return { BOOKS, byId, findReferences, expandVerseSpec, formatReference, resolveReference, fetchBook, normalizeExtracted, referenceIsValid };
});
