#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://127.0.0.1:4173';
const REPORT_PATH = path.join(ROOT, 'work', 'agent-reader-browser-audit.json');
const EVIDENCE_DIR = path.join(ROOT, 'work', 'evidence', 'reader');
const LIMIT_ARGUMENT = process.argv.find(value => value.startsWith('--limit='));
const LIMIT = LIMIT_ARGUMENT ? Math.max(1, Number(LIMIT_ARGUMENT.split('=')[1]) || 1) : Infinity;
const SMOKE = process.argv.includes('--smoke');

function chromeExecutable() {
  if (process.env.CURSOS_AUDIT_CHROME) return process.env.CURSOS_AUDIT_CHROME;
  const browserRoot = path.join(os.homedir(), '.agent-browser', 'browsers');
  const versions = fsSync.readdirSync(browserRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('chrome-'))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(browserRoot, version, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
    if (fsSync.existsSync(candidate)) return candidate;
  }
  throw new Error('No se encontró Chrome for Testing. Instala agent-browser o define CURSOS_AUDIT_CHROME.');
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  close() {
    this.socket?.close();
  }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForJson(url, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return response.json();
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw lastError || new Error(`Tiempo agotado esperando ${url}`);
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Error evaluando JavaScript en Chrome');
  }
  return result.result?.value;
}

async function waitForExpression(client, expression, timeout = 35_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(client, `Boolean(${expression})`)) return;
    await delay(100);
  }
  throw new Error(`Tiempo agotado esperando: ${expression}`);
}

async function navigate(client, url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const navigation = await client.send('Page.navigate', { url });
    // Chrome 152 occasionally reports ERR_ABORTED while the requested local
    // document still commits successfully. Give that commit a short chance,
    // then retry the exact read-only navigation if it remained about:blank.
    if (navigation.errorText && navigation.errorText !== 'net::ERR_ABORTED') {
      throw new Error(`Chrome no pudo navegar: ${navigation.errorText}`);
    }
    try {
      await waitForExpression(
        client,
        `location.href === ${JSON.stringify(url)} && document.querySelectorAll('.pg').length > 0`,
        navigation.errorText ? 3_000 : 35_000
      );
      return;
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  const state = await evaluate(client, `JSON.stringify({ href: location.href, title: document.title, readyState: document.readyState, pages: document.querySelectorAll('.pg').length, body: document.body?.innerText.slice(0, 300) || '' })`);
  throw new Error(`${lastError?.message || 'No se pudo abrir la lección'}; estado=${state}`);
}

const SCAN_SCRIPT = String.raw`
(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = element => {
    if (!element || element.hidden) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const sampleCanvas = canvas => {
    try {
      const probe = document.createElement('canvas');
      probe.width = 64;
      probe.height = 64;
      const context = probe.getContext('2d', { willReadFrequently: true });
      context.drawImage(canvas, 0, 0, 64, 64);
      const pixels = context.getImageData(0, 0, 64, 64).data;
      let nonWhite = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 8 && (pixels[index] < 248 || pixels[index + 1] < 248 || pixels[index + 2] < 248)) nonWhite += 1;
      }
      return nonWhite / (pixels.length / 4);
    } catch { return null; }
  };
  await wait(450);
  const pages = [...document.querySelectorAll('.pg')];
  const evidence = [];
  for (const page of pages) {
    page.scrollIntoView({ block: 'center', inline: 'nearest' });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (page.dataset.rendered === 'true' && page.querySelector('canvas.pdfCanvas')) break;
      await wait(75);
    }
    const canvas = page.querySelector('canvas.pdfCanvas');
    const controls = [...page.querySelectorAll('button,a[href],textarea,input,select')].filter(visible);
    const targetIssues = controls.map(element => {
      const rect = element.getBoundingClientRect();
      return { label: element.getAttribute('aria-label') || element.textContent.trim(), width: rect.width, height: rect.height };
    }).filter(item => item.width < 43.5 || item.height < 43.5);
    const descriptionId = canvas?.getAttribute('aria-describedby') || '';
    evidence.push({
      page: Number(page.dataset.pageNumber),
      rendered: page.dataset.rendered === 'true' && Boolean(canvas?.width && canvas?.height),
      nonWhiteRatio: canvas ? sampleCanvas(canvas) : null,
      accessibleDescription: Boolean(descriptionId && document.getElementById(descriptionId)),
      hasExtractableText: page.dataset.hasAccessibleText === 'true',
      invalidVerseCount: Number(page.dataset.invalidVerseCount || 0),
      verseLinks: page.querySelectorAll('.verseRef').length,
      answerControls: page.querySelectorAll('.answerField,.answerCheck').length,
      targetIssues
    });
  }
  document.querySelector('.pg')?.scrollIntoView({ block: 'start', inline: 'nearest' });
  await wait(100);
  const area = document.getElementById('pdfArea');
  const clippedText = [...document.querySelectorAll('h1,h2,p,a,button,span')].filter(element => {
    if (!visible(element) || !element.textContent.trim()) return false;
    const style = getComputedStyle(element);
    const constrained = ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY);
    return constrained && (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2);
  }).map(element => element.id || element.className || element.tagName).slice(0, 20);
  const topControls = [...document.querySelectorAll('.readerNav button,.answerTools button,.answerTools a,.pdfNav button')].filter(visible);
  const topTargetIssues = topControls.map(element => {
    const rect = element.getBoundingClientRect();
    return { id: element.id, width: rect.width, height: rect.height };
  }).filter(item => item.width < 43.5 || item.height < 43.5);
  return JSON.stringify({
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    pageCount: pages.length,
    pagesVisited: evidence.length,
    pagesRendered: evidence.filter(item => item.rendered).length,
    blankPages: evidence.filter(item => item.nonWhiteRatio !== null && item.nonWhiteRatio <= 0).map(item => item.page),
    missingDescriptions: evidence.filter(item => !item.accessibleDescription).map(item => item.page),
    noTextPages: evidence.filter(item => !item.hasExtractableText).map(item => item.page),
    invalidVerseLinksRejected: evidence.reduce((sum, item) => sum + item.invalidVerseCount, 0),
    verseLinks: evidence.reduce((sum, item) => sum + item.verseLinks, 0),
    answerControls: evidence.reduce((sum, item) => sum + item.answerControls, 0),
    pageTargetIssues: evidence.flatMap(item => item.targetIssues.map(issue => ({ page: item.page, ...issue }))).slice(0, 30),
    topTargetIssues,
    globalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    readerOverflowPx: Math.max(0, area.scrollWidth - area.offsetWidth),
    clippedText,
    headings: document.querySelectorAll('h1').length,
    mainLandmarks: document.querySelectorAll('main').length,
    navigationLandmarks: document.querySelectorAll('nav').length,
    zoomLabel: document.getElementById('zoomValue')?.textContent.trim() || '',
    pageEvidence: evidence
  });
})()
`;

function viewPassed(metrics, violations, runtimeErrors) {
  return metrics.pageCount === metrics.pagesVisited &&
    metrics.pageCount === metrics.pagesRendered &&
    metrics.blankPages.length === 0 &&
    metrics.missingDescriptions.length === 0 &&
    metrics.invalidVerseLinksRejected === 0 &&
    metrics.pageTargetIssues.length === 0 &&
    metrics.topTargetIssues.length === 0 &&
    metrics.globalOverflowPx <= 2 &&
    metrics.readerOverflowPx <= 2 &&
    metrics.clippedText.length === 0 &&
    metrics.headings === 1 &&
    metrics.mainLandmarks === 1 &&
    metrics.navigationLandmarks >= 2 &&
    violations.length === 0 && runtimeErrors.length === 0;
}

async function auditViewport(client, axeSource, view, capture, runtimeErrors) {
  runtimeErrors.length = 0;
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: view.layoutWidth,
    height: view.layoutHeight,
    screenWidth: view.screenWidth,
    screenHeight: view.screenHeight,
    deviceScaleFactor: view.deviceScaleFactor,
    mobile: false
  });
  const metrics = JSON.parse(await evaluate(client, SCAN_SCRIPT));
  if (!await evaluate(client, `typeof axe === 'object' && typeof axe.run === 'function'`)) {
    await evaluate(client, axeSource);
  }
  const axe = JSON.parse(await evaluate(client, String.raw`axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }).then(result => JSON.stringify({
    testEngine: result.testEngine,
    violations: result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length })),
    incomplete: result.incomplete.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length })),
    passes: result.passes.length
  }))`));
  if (capture) {
    await fs.mkdir(EVIDENCE_DIR, { recursive: true });
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    await fs.writeFile(path.join(EVIDENCE_DIR, `${view.name}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  const errors = runtimeErrors.splice(0).map(error => String(error).slice(0, 500));
  return {
    name: view.name,
    requestedViewport: {
      width: view.screenWidth,
      height: view.screenHeight,
      browserZoomPercent: view.browserZoomPercent
    },
    metrics,
    axe,
    runtimeErrors: errors,
    passed: viewPassed(metrics, axe.violations, errors)
  };
}

async function pressKey(client, key, code, virtualKeyCode, modifiers = 0, text = '') {
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
  if (text) {
    await client.send('Input.dispatchKeyEvent', { type: 'char', key, code, text, unmodifiedText: text, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers });
  }
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers });
}

async function representativeInteractions(client) {
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate(client, `document.getElementById('back').focus()`);
  const tabOrder = [];
  for (let index = 0; index < 12; index += 1) {
    await pressKey(client, 'Tab', 'Tab', 9);
    tabOrder.push(JSON.parse(await evaluate(client, `JSON.stringify({
      id: document.activeElement?.id || '',
      className: document.activeElement?.className || '',
      outline: getComputedStyle(document.activeElement).outlineStyle
    })`)));
  }

  await evaluate(client, `document.querySelector('.verseRef').focus()`);
  await pressKey(client, 'Enter', 'Enter', 13, 0, '\r');
  await waitForExpression(client, `!document.querySelector('.verseModal')?.hidden && document.querySelectorAll('#verseText p').length > 0`);
  const opened = JSON.parse(await evaluate(client, `JSON.stringify({
    visible: !document.querySelector('.verseModal')?.hidden,
    title: document.getElementById('verseTitle')?.textContent.trim() || '',
    paragraphs: document.querySelectorAll('#verseText p').length,
    focus: document.activeElement?.id || ''
  })`));
  await pressKey(client, 'Tab', 'Tab', 9);
  const tabInside = await evaluate(client, `Boolean(document.activeElement?.closest('.verseModal'))`);
  await pressKey(client, 'Tab', 'Tab', 9, 8);
  const shiftTabInside = await evaluate(client, `Boolean(document.activeElement?.closest('.verseModal'))`);
  await pressKey(client, 'Escape', 'Escape', 27);
  const closed = JSON.parse(await evaluate(client, `JSON.stringify({
    hidden: document.querySelector('.verseModal')?.hidden === true,
    focusReturned: document.activeElement?.classList.contains('verseRef') === true
  })`));

  const testValue = 'Respuesta local de accesibilidad';
  await evaluate(client, `(() => {
    const field = document.querySelector('.answerField');
    field.value = ${JSON.stringify(testValue)};
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(testValue)} }));
  })()`);
  await client.send('Page.reload', { ignoreCache: true });
  await waitForExpression(client, `document.querySelector('.answerField')?.value === ${JSON.stringify(testValue)}`);
  const persistedAfterReload = await evaluate(client, `document.querySelector('.answerField')?.value === ${JSON.stringify(testValue)}`);
  await evaluate(client, `document.getElementById('clearAnswers').click()`);
  const cleared = JSON.parse(await evaluate(client, `JSON.stringify({
    empty: [...document.querySelectorAll('.answerField')].every(field => !field.value),
    label: document.getElementById('clearAnswers').textContent.trim()
  })`));
  await evaluate(client, `document.getElementById('clearAnswers').click()`);
  const restored = await evaluate(client, `document.querySelector('.answerField')?.value === ${JSON.stringify(testValue)}`);

  return {
    keyboard: {
      tabOrder,
      visibleFocus: tabOrder.every(item => item.outline !== 'none'),
      uniqueStops: new Set(tabOrder.map(item => `${item.id}|${item.className}`)).size
    },
    verseDialog: { opened, tabInside, shiftTabInside, closed },
    answers: { persistedAfterReload, cleared, restored }
  };
}

async function main() {
  const catalogResponse = await fetch(`${ORIGIN}/api/catalog`, { cache: 'no-store' });
  if (!catalogResponse.ok) throw new Error(`El servidor local no respondió (${catalogResponse.status}). Ejecuta npm run audit:serve.`);
  const catalog = await catalogResponse.json();
  const allLessons = catalog.courses.flatMap(course => course.lessons.map(lesson => ({ course, lesson })));
  const allPdfs = allLessons.filter(({ lesson }) => lesson.type === 'pdf');
  const pdfs = allPdfs.slice(0, SMOKE ? 1 : LIMIT);
  const views = [
    { name: '390x844', screenWidth: 390, screenHeight: 844, layoutWidth: 390, layoutHeight: 844, deviceScaleFactor: 1, browserZoomPercent: 100 },
    { name: '834x1194', screenWidth: 834, screenHeight: 1194, layoutWidth: 834, layoutHeight: 1194, deviceScaleFactor: 1, browserZoomPercent: 100 },
    { name: '1440x1000', screenWidth: 1440, screenHeight: 1000, layoutWidth: 1440, layoutHeight: 1000, deviceScaleFactor: 1, browserZoomPercent: 100 },
    { name: '1440x1000-zoom-200', screenWidth: 1440, screenHeight: 1000, layoutWidth: 720, layoutHeight: 500, deviceScaleFactor: 2, browserZoomPercent: 200 }
  ];
  const axeSource = await fs.readFile(path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
  const port = 9223 + Math.floor(Math.random() * 500);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cursos-reader-chrome-'));
  const chrome = spawn(chromeExecutable(), [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  const runtimeErrors = [];
  let client;
  let cleanupWarning = null;
  const report = {
    startedAt: new Date().toISOString(),
    catalogRevision: catalog.revision || null,
    inventory: {
      courses: catalog.courses.length,
      lessons: allLessons.length,
      pdfLessons: allPdfs.length,
      auditedPdfLessons: pdfs.length
    },
    browser: { name: 'Chrome for Testing', realBrowser: true, axe: true },
    views,
    interactions: null,
    lessons: [],
    errors: []
  };

  try {
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    let pageTarget = targets.find(target => target.type === 'page');
    if (!pageTarget) {
      const created = await fetch(`http://127.0.0.1:${port}/json/new?about%3Ablank`, { method: 'PUT' });
      if (created.ok) pageTarget = await created.json();
    }
    if (!pageTarget?.webSocketDebuggerUrl) throw new Error('Chrome no expuso una página CDP.');
    client = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await client.connect();
    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Network.enable')
    ]);
    client.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || 'Runtime.exceptionThrown'));
    client.on('Network.loadingFailed', event => {
      if (!event.canceled && event.type !== 'Image') runtimeErrors.push(`Network.loadingFailed: ${event.errorText}`);
    });

    for (const [index, { course, lesson }] of pdfs.entries()) {
      const lessonNumber = lesson.legacyNumber || lesson.id;
      const route = `/leer.html?c=${encodeURIComponent(course.id)}&l=${encodeURIComponent(lessonNumber)}`;
      console.log(`[${index + 1}/${pdfs.length}] ${course.name} - ${lesson.title}`);
      try {
        await navigate(client, `${ORIGIN}${route}`);
        const auditedViews = [];
        for (const view of views) {
          auditedViews.push(await auditViewport(client, axeSource, view, index === 0, runtimeErrors));
        }
        report.lessons.push({
          courseId: course.id,
          courseName: course.name,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          route,
          views: auditedViews,
          passed: auditedViews.every(view => view.passed)
        });
        if (index === 0) report.interactions = await representativeInteractions(client);
      } catch (error) {
        report.errors.push({ courseId: course.id, lessonId: lesson.id, route, error: String(error.stack || error.message).slice(0, 2000) });
      }
      await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
      await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  } finally {
    try { await client?.send('Browser.close'); } catch {}
    client?.close();
    if (chrome.exitCode === null) chrome.kill();
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)]);
    const resolvedProfile = path.resolve(profile);
    const resolvedTemp = path.resolve(os.tmpdir());
    if (resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`) && path.basename(resolvedProfile).startsWith('cursos-reader-chrome-')) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await fs.rm(resolvedProfile, { recursive: true, force: true });
          cleanupWarning = null;
          break;
        } catch (error) {
          cleanupWarning = `${error.code || error.name}: ${error.message}`;
          await delay(500);
        }
      }
    }
  }

  const allViews = report.lessons.flatMap(lesson => lesson.views);
  const sourceBlankPages = report.lessons.flatMap(lesson =>
    (lesson.views[0]?.metrics?.blankPages || []).map(page => ({
      courseId: lesson.courseId,
      courseName: lesson.courseName,
      lessonId: lesson.lessonId,
      lessonTitle: lesson.lessonTitle,
      page
    }))
  );
  const interactionsPassed = Boolean(
    report.interactions?.keyboard?.visibleFocus &&
    report.interactions?.keyboard?.uniqueStops >= 8 &&
    report.interactions?.verseDialog?.opened?.visible &&
    report.interactions?.verseDialog?.opened?.paragraphs > 0 &&
    report.interactions?.verseDialog?.tabInside &&
    report.interactions?.verseDialog?.shiftTabInside &&
    report.interactions?.verseDialog?.closed?.hidden &&
    report.interactions?.verseDialog?.closed?.focusReturned &&
    report.interactions?.answers?.persistedAfterReload &&
    report.interactions?.answers?.cleared?.empty &&
    report.interactions?.answers?.restored
  );
  report.completedAt = new Date().toISOString();
  report.cleanupWarning = cleanupWarning;
  report.sourceBlankPages = sourceBlankPages;
  report.summary = {
    pdfLessons: report.lessons.length,
    pdfPages: report.lessons.reduce((sum, lesson) => sum + Number(lesson.views[0]?.metrics?.pageCount || 0), 0),
    pageViewportVisits: allViews.reduce((sum, view) => sum + Number(view.metrics?.pagesVisited || 0), 0),
    axeRuns: allViews.length,
    axeViolationViews: allViews.filter(view => view.axe?.violations?.length).length,
    noTextSourcePages: report.lessons.reduce((sum, lesson) => sum + Number(lesson.views[0]?.metrics?.noTextPages?.length || 0), 0),
    sourceBlankPages: sourceBlankPages.length,
    verseLinks: report.lessons.reduce((sum, lesson) => sum + Number(lesson.views[0]?.metrics?.verseLinks || 0), 0),
    answerControls: report.lessons.reduce((sum, lesson) => sum + Number(lesson.views[0]?.metrics?.answerControls || 0), 0),
    interactionsPassed,
    failedViews: allViews.filter(view => !view.passed).length,
    errors: report.errors.length,
    passed: report.errors.length === 0 && allViews.length === pdfs.length * views.length && allViews.every(view => view.passed) && interactionsPassed
  };
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report.summary, null, 2));
  if (!report.summary.passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 2;
});
