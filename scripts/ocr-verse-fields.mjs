#!/usr/bin/env node
/* Genera assets/verse-fields.json: referencias bíblicas localizadas por OCR
   para lecciones cuyo PDF no tiene texto extraíble (imágenes o fuentes rotas).
   Requiere: tesseract con idioma spa (`brew install tesseract tesseract-lang`)
   y puppeteer global (NODE_PATH=$(npm root -g)).
   Uso: NODE_PATH=$(npm root -g) node scripts/ocr-verse-fields.mjs */
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BibleVerses = require(path.join(ROOT, 'verses.js'));
const puppeteer = (() => {
  try { return require('puppeteer'); } catch {}
  return require('/Users/miguelperez/.npm-global/lib/node_modules/puppeteer');
})();
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const run = promisify(execFile);

async function fetchWithTimeout(url, ms = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const CATALOG_URL = process.argv[2] || 'https://cursos-biblicos-web.vercel.app/api/catalog';
const HTTP_PORT = 8791;
const TMP = '/tmp/ocr-verse-fields';
fs.mkdirSync(TMP, { recursive: true });

const STOPWORDS = new Set(['el', 'la', 'de', 'que', 'en', 'y', 'los', 'las', 'dios', 'jesús', 'jesus', 'para', 'con', 'una', 'del', 'es', 'al', 'por', 'su', 'se', 'no', 'un', 'lo', 'le', 'mi', 'tu']);

// Texto sin capa útil: pocas palabras o español irreconocible (fuente rota).
async function pageNeedsOcr(page) {
  const content = await page.getTextContent();
  const text = content.items.map(item => item.str).join(' ').trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 12) return true;
  const hits = words.filter(word => STOPWORDS.has(word.toLowerCase().replace(/[.,;:()¿?¡!]/g, ''))).length;
  return hits / words.length < 0.03;
}

// OCR nativo de macOS (Vision) vía scripts/ocr-image.swift compilado.
// Tesseract/leptonica de Homebrew no lee imágenes en esta máquina; Vision es mejor y gratis.
const OCR_BIN = '/tmp/ocr-image';

async function ensureOcrBin() {
  if (fs.existsSync(OCR_BIN)) return;
  await run('swiftc', [path.join(ROOT, 'scripts/ocr-image.swift'), '-o', OCR_BIN, '-O'], { maxBuffer: 64 * 1024 * 1024 });
}

function ocr(imagePath) {
  return run(OCR_BIN, [imagePath], { maxBuffer: 64 * 1024 * 1024 });
}

// JSON de Vision -> líneas de palabras ordenadas (agrupa por proximidad vertical).
function parseOcr(jsonText) {
  const { words } = JSON.parse(jsonText);
  const clean = (words || []).filter(w => w.conf >= 0.3 && w.text && w.text.trim());
  clean.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines = [];
  for (const word of clean) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(word.y - line[0].y) <= Math.max(4, word.h * 0.55)) line.push(word);
    else lines.push([word]);
  }
  return lines.map(wordsInLine => wordsInLine.sort((a, b) => a.x - b.x));
}

// Encuentra referencias en las líneas OCR y devuelve rectángulos en fracciones de página.
function lineRefs(lines, pageW, pageH) {
  const out = [];
  let lastBookId = '';
  for (const words of lines) {
    let text = '';
    const spans = [];
    for (const word of words) {
      if (spans.length && !text.endsWith(' ') && !word.text.startsWith(' ')) text += ' ';
      spans.push({ ...word, start: text.length });
      text += word.text;
    }
    const normalized = BibleVerses.normalizeExtracted(text);
    for (const match of BibleVerses.findReferences(normalized.text, lastBookId)) {
      lastBookId = match.bookId;
      const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/bible/rvr1960', `${match.bookId}.json`), 'utf8'));
      match.parts = match.parts.filter(part => BibleVerses.referenceIsValid({ ...match, parts: [part] }, data));
      if (!match.parts.length) continue;
      const rawStart = normalized.map[match.index];
      const rawEnd = normalized.map[Math.min(match.end, normalized.map.length - 1)];
      const hit = spans.filter(span => span.start < rawEnd && span.start + span.text.length > rawStart);
      if (!hit.length) continue;
      const x0 = Math.min(...hit.map(span => span.x));
      const y0 = Math.min(...hit.map(span => span.y));
      const x1 = Math.max(...hit.map(span => span.x + span.w));
      const y1 = Math.max(...hit.map(span => span.y + span.h));
      const padX = (y1 - y0) * 0.15;
      out.push({
        x: Math.max(0, (x0 - padX) / pageW),
        y: Math.max(0, (y0 - padX) / pageH),
        w: Math.min(1, (x1 - x0 + 2 * padX) / pageW),
        h: Math.min(1, (y1 - y0 + 2 * padX) / pageH),
        bookId: match.bookId,
        bookName: match.bookName,
        parts: match.parts,
        raw: match.raw
      });
    }
  }
  return out;
}

async function main() {
  // Static server so the renderer page can load vendor/pdf.js over http.
  const { spawn } = await import('node:child_process');
  const server = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  process.on('exit', () => server.kill());
  await new Promise(resolve => setTimeout(resolve, 800));
  const catalog = await (await fetchWithTimeout(CATALOG_URL)).json();
  await ensureOcrBin();
  const browser = await puppeteer.launch({ headless: true });
  const documents = {};
  let ocrLessons = 0;
  let ocrPages = 0;
  for (const course of catalog.courses) {
    const pdfs = (course.lessons || []).filter(lesson => lesson.type === 'pdf');
    for (const lesson of pdfs) {
      const tag = `${course.name} · ${lesson.title}`;
      let doc;
      try {
        const buf = await (await fetchWithTimeout(lesson.url)).arrayBuffer();
        const task = pdfjs.getDocument({
          data: new Uint8Array(buf),
          isEvalSupported: false,
          standardFontDataUrl: path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts') + path.sep
        });
        doc = await task.promise;
        const needs = [];
        for (let p = 1; p <= doc.numPages; p += 1) {
          if (await pageNeedsOcr(await doc.getPage(p))) needs.push(p);
        }
        if (!needs.length) continue;
        console.log(`OCR ${tag}: páginas ${needs.join(',')}`);
        ocrLessons += 1;
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${HTTP_PORT}/scripts/ocr-render.html?url=${encodeURIComponent(lesson.url)}`, { timeout: 90000 });
        await page.waitForFunction(() => document.title === 'ready' || document.title === 'error', { timeout: 90000 });
        const pages = {};
        for (const p of needs) {
          const canvas = await page.$(`canvas[data-page="${p}"]`);
          if (!canvas) continue;
          const png = path.join(TMP, `c${course.id}-${lesson.id}-p${p}.png`);
          await canvas.screenshot({ path: png });
          const box = await canvas.boundingBox();
          const { stdout } = await ocr(png);
          const refs = lineRefs(parseOcr(stdout), box.width, box.height);
          ocrPages += 1;
          if (refs.length) {
            pages[String(p)] = refs.map(({ raw, ...rest }) => rest);
            console.log(`  p${p}: ${refs.length} refs (${refs.slice(0, 3).map(r => r.bookName).join(', ')})`);
          }
        }
        await page.close();
        if (Object.keys(pages).length) {
          const entry = { url: lesson.url, pages };
          documents[`${course.id}|${lesson.id}`] = entry;
          if (lesson.legacyNumber && lesson.legacyNumber !== lesson.id) {
            documents[`${course.id}|${lesson.legacyNumber}`] = entry;
          }
        }
      } catch (error) {
        console.log(`ERR ${tag}: ${error.message}`);
      }
    }
  }
  await browser.close();
  const output = { generatedAt: new Date().toISOString(), source: 'ocr-tesseract-spa', documents };
  const file = path.join(ROOT, 'assets/verse-fields.json');
  fs.writeFileSync(file, JSON.stringify(output));
  const totalRefs = Object.values(documents).reduce((n, d) => n + Object.values(d.pages).reduce((m, p) => m + p.length, 0), 0);
  console.log(`\nListo: ${ocrLessons} lecciones, ${ocrPages} páginas OCR, ${totalRefs} referencias -> ${file}`);
}

main().catch(error => { console.error('FATAL', error); process.exitCode = 1; });
