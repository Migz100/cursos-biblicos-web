#!/usr/bin/env node
/* Auditoría de referencias bíblicas en los PDF del catálogo en producción.
   Descarga cada lección tipo pdf, extrae el texto con pdfjs-dist, corre el
   detector de verses.js y valida cada referencia contra el texto RVR1960
   empacado en assets/bible/rvr1960/. También busca citas con forma bíblica
   que el parser no capturó (omisiones, solo advertencias).
   Uso: node scripts/audit-verses.mjs
   Salida: código 0 salvo que haya referencias sin resolver. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BibleVerses = require(path.join(ROOT, 'verses.js'));

const CATALOG_URL = 'https://cursos-biblicos-web.vercel.app/api/catalog';
const CONCURRENCY = 6;
const MAX_MISS_EXAMPLES = 30;
const SNIPPET_MAX = 160;
const FONT_DIR = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep;

// Texto RVR1960 local, cacheado por libro.
const bibleCache = new Map();
function bibleChapters(bookId) {
  if (!bibleCache.has(bookId)) {
    const file = path.join(ROOT, 'assets', 'bible', 'rvr1960', `${bookId}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      bibleCache.set(bookId, data.chapters || {});
    } catch {
      bibleCache.set(bookId, null);
    }
  }
  return bibleCache.get(bookId);
}

// Un ref queda sin resolver si el capítulo no existe o algún versículo falta.
function validateRef(ref) {
  const chapters = bibleChapters(ref.bookId);
  if (!chapters) return [{ chapter: null, detail: 'libro sin JSON local' }];
  const problems = [];
  for (const part of ref.parts) {
    const chapterText = chapters[String(part.chapter)];
    if (!chapterText) {
      problems.push({ chapter: part.chapter, detail: 'capítulo inexistente' });
      continue;
    }
    const missing = part.verses.filter(verse => !chapterText[String(verse)]);
    if (missing.length) {
      problems.push({ chapter: part.chapter, detail: `versículos inexistentes: ${missing.join(', ')}` });
    }
  }
  return problems;
}

// Búsqueda de omisiones: paréntesis con "n:n" y nombres de libro seguidos de
// "n:n", en regiones donde findReferences no detectó nada.
const LETTER = 'A-Za-zÁÉÍÓÚÜÑáéíóúüñ';
const scanAliases = (() => {
  const names = new Set();
  for (const book of BibleVerses.BOOKS) {
    for (const alias of book.aliases) if (alias.length >= 3) names.add(alias);
    names.add(book.name.toLowerCase());
    const stripped = book.name.toLowerCase().replace(/^\d\s*/, '');
    if (stripped.length >= 3) names.add(stripped);
  }
  const pattern = [...names]
    .sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|');
  return new RegExp(`(?<![${LETTER}])${pattern}(?![${LETTER}])`, 'gi');
})();
const PAREN_RE = /\([^()]*\d{1,3}\s*:\s*\d{1,3}[^()]*\)/g;
const COLON_NEAR_RE = /\d{1,3}\s*:\s*\d{1,3}/;
const ALIAS_LOOKAHEAD = 45;

function regionOverlaps(ranges, start, end) {
  return ranges.some(([a, b]) => start < b && a < end);
}

function findMisses(text, refs) {
  const refRanges = refs.map(ref => [ref.index, ref.end]);
  const misses = [];
  const accept = (start, end) => {
    if (regionOverlaps(refRanges, start, end)) return;
    if (misses.some(miss => start < miss.end && miss.start < end)) return;
    let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (snippet.length > SNIPPET_MAX) snippet = `${snippet.slice(0, SNIPPET_MAX)}...`;
    misses.push({ start, end, snippet });
  };
  for (const match of text.matchAll(PAREN_RE)) {
    accept(match.index, match.index + match[0].length);
  }
  scanAliases.lastIndex = 0;
  let aliasMatch;
  while ((aliasMatch = scanAliases.exec(text))) {
    const window = text.slice(aliasMatch.index, aliasMatch.index + ALIAS_LOOKAHEAD);
    const cite = COLON_NEAR_RE.exec(window);
    if (cite && cite.index + cite[0].length > aliasMatch[0].length) {
      accept(aliasMatch.index, aliasMatch.index + cite.index + cite[0].length);
    }
  }
  return misses;
}

async function fetchPdf(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.arrayBuffer();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function auditLesson(lesson) {
  const result = { pages: 0, emptyPages: 0, refs: 0, unresolved: [], misses: [], error: null };
  let buffer;
  try {
    buffer = await fetchPdf(lesson.url);
  } catch (error) {
    result.error = `descarga: ${error.message}`;
    return result;
  }
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      standardFontDataUrl: FONT_DIR,
      verbosity: 0
    });
    const doc = await task.promise;
    result.pages = doc.numPages;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const { text } = BibleVerses.normalizeExtracted(content.items.map(item => item.str).join(' '));
      if (!text.trim()) result.emptyPages += 1;
      const refs = BibleVerses.findReferences(text);
      result.refs += refs.length;
      for (const ref of refs) {
        const problems = validateRef(ref);
        if (problems.length) {
          result.unresolved.push({ page: pageNumber, raw: ref.raw, bookName: ref.bookName, problems });
        }
      }
      for (const miss of findMisses(text, refs)) {
        result.misses.push({ page: pageNumber, snippet: miss.snippet });
      }
    }
    await task.destroy();
  } catch (error) {
    result.error = `pdfjs: ${error.message}`;
  }
  return result;
}

async function main() {
  console.error(`Catálogo: ${CATALOG_URL}`);
  const catalog = await (await fetch(CATALOG_URL)).json();
  const queue = [];
  for (const course of catalog.courses || []) {
    for (const lesson of course.lessons || []) {
      if (lesson.type === 'pdf') queue.push({ course, lesson });
    }
  }
  const totalLessons = queue.length;
  console.error(`Lecciones pdf a auditar: ${totalLessons} (concurrencia ${CONCURRENCY})`);

  const perCourse = new Map();
  const courseStats = name => {
    if (!perCourse.has(name)) {
      perCourse.set(name, { lessons: 0, pages: 0, refs: 0, unresolved: 0, misses: 0 });
    }
    return perCourse.get(name);
  };
  const missExamples = [];
  const seenSnippets = new Set();
  const unresolvedDetails = [];
  const errors = [];
  let totals = { pages: 0, emptyPages: 0, refs: 0, unresolved: 0, misses: 0 };

  let done = 0;
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      const { course, lesson } = item;
      const result = await auditLesson(lesson);
      done += 1;
      if (done % 10 === 0 || done === arguments.length) {
        console.error(`progreso: ${done} lecciones procesadas`);
      }
      const stats = courseStats(course.name);
      if (result.error) {
        errors.push({ course: course.name, lesson: lesson.title, id: lesson.id, error: result.error });
        console.error(`error en ${course.name} / ${lesson.title}: ${result.error}`);
        continue;
      }
      stats.lessons += 1;
      stats.pages += result.pages;
      stats.refs += result.refs;
      stats.unresolved += result.unresolved.length;
      stats.misses += result.misses.length;
      totals.pages += result.pages;
      totals.emptyPages += result.emptyPages;
      totals.refs += result.refs;
      totals.unresolved += result.unresolved.length;
      totals.misses += result.misses.length;
      for (const entry of result.unresolved) {
        unresolvedDetails.push({ course: course.name, lesson: lesson.title, id: lesson.id, ...entry });
      }
      for (const miss of result.misses) {
        if (missExamples.length < MAX_MISS_EXAMPLES && !seenSnippets.has(miss.snippet)) {
          seenSnippets.add(miss.snippet);
          missExamples.push({ course: course.name, lesson: lesson.title, id: lesson.id, page: miss.page, snippet: miss.snippet });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const pad = (value, width) => String(value).padStart(width);
  console.log('');
  console.log('REFERENCIAS BÍBLICAS EN PDFS DEL CATÁLOGO (producción)');
  console.log('');
  const header = `${'Curso'.padEnd(38)} ${'PDFs'.padStart(5)} ${'Páginas'.padStart(8)} ${'Refs'.padStart(6)} ${'SinResolver'.padStart(12)} ${'Omisiones'.padStart(10)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const [name, stats] of perCourse) {
    console.log(
      `${name.slice(0, 37).padEnd(38)} ${pad(stats.lessons, 5)} ${pad(stats.pages, 8)} ${pad(stats.refs, 6)} ${pad(stats.unresolved, 12)} ${pad(stats.misses, 10)}`
    );
  }
  console.log('-'.repeat(header.length));
  console.log(
    `${'TOTAL'.padEnd(38)} ${pad([...perCourse.values()].reduce((n, s) => n + s.lessons, 0), 5)} ${pad(totals.pages, 8)} ${pad(totals.refs, 6)} ${pad(totals.unresolved, 12)} ${pad(totals.misses, 10)}`
  );
  console.log('');
  console.log(`Cursos: ${perCourse.size} | PDFs auditados: ${[...perCourse.values()].reduce((n, s) => n + s.lessons, 0)} | errores de descarga/lectura: ${errors.length}`);
  console.log(`Páginas: ${totals.pages} (sin texto extraíble: ${totals.emptyPages})`);
  console.log(`Referencias detectadas: ${totals.refs} | sin resolver: ${totals.unresolved} | posibles omisiones: ${totals.misses}`);

  if (errors.length) {
    console.log('');
    console.log('ERRORES (lecciones no auditadas):');
    for (const entry of errors) console.log(`  [${entry.course} / ${entry.lesson} (${entry.id})] ${entry.error}`);
  }
  if (unresolvedDetails.length) {
    console.log('');
    console.log('REFERENCIAS SIN RESOLVER:');
    for (const entry of unresolvedDetails) {
      const detail = entry.problems.map(p => `cap ${p.chapter}: ${p.detail}`).join(' | ');
      console.log(`  [${entry.course} / ${entry.lesson} (${entry.id}) pág ${entry.page}] "${entry.raw}" (${entry.bookName}) -> ${detail}`);
    }
  }
  if (missExamples.length) {
    console.log('');
    console.log(`EJEMPLOS DE POSIBLES OMISIONES (máx ${MAX_MISS_EXAMPLES}, distintos):`);
    missExamples.forEach((entry, index) => {
      console.log(`  ${index + 1}. [${entry.course} / ${entry.lesson} (${entry.id}) pág ${entry.page}] "${entry.snippet}"`);
    });
  }

  process.exitCode = totals.unresolved > 0 ? 1 : 0;
}

main().catch(error => {
  console.error(`falla fatal: ${error.stack || error.message}`);
  process.exitCode = 2;
});
