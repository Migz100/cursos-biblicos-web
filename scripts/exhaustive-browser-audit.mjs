#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_JSON = path.join(ROOT, 'work', 'agent-browser-audit-v2.json');
const OUTPUT_MD = path.join(ROOT, 'work', 'agent-browser-audit-v2.md');
// The audit server binds IPv4 only. Chrome 152 can resolve `localhost` to ::1
// first and leave a navigation waiting after ERR_ABORTED, so use the bound
// address explicitly for every browser navigation as well as API fetches.
const LOCAL_ORIGIN = 'http://127.0.0.1:4173';
const STARTED_AT = new Date().toISOString();
const SESSION = `cursos-exhaustive-${process.pid}-${Date.now().toString(36)}`;
const FRESH = process.argv.includes('--fresh');
const SMOKE = process.argv.includes('--smoke');
const argLimit = process.argv.find(value => value.startsWith('--limit='));
const LIMIT = argLimit ? Math.max(1, Number(argLimit.split('=')[1]) || 1) : Infinity;
let transportSequence = 0;

function executablePath() {
  if (process.platform !== 'win32') return 'agent-browser';
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA no está disponible para localizar agent-browser.');
  return path.join(appData, 'npm', 'node_modules', 'agent-browser', 'bin', 'agent-browser-win32-x64.exe');
}

const AGENT_BROWSER = executablePath();

function runAgent(args, { input, timeout = 360_000, allowFailure = false } = {}) {
  const fullArgs = ['--session', SESSION, ...args];
  const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
  const encodedInput = input ? Buffer.from(input, 'utf8').toString('base64') : '';
  // On Windows, spawning the native CLI directly can leave its background
  // browser daemon holding the inherited stdout pipe. Node's spawnSync then
  // waits forever even though the CLI command already finished. PowerShell
  // mediates the native pipe correctly and exits as soon as the CLI does.
  const usePowerShell = process.platform === 'win32';
  const executable = usePowerShell ? 'powershell.exe' : AGENT_BROWSER;
  const windowsQuote = value => {
    const text = String(value);
    return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  };
  let transportFiles = [];
  let executableArgs = fullArgs;
  if (usePowerShell) {
    const transportDir = path.join(ROOT, 'work', 'tmp', 'browser-transport');
    fsSync.mkdirSync(transportDir, { recursive: true });
    const stem = `${SESSION}-${process.pid}-${++transportSequence}`;
    const outputPath = path.join(transportDir, `${stem}.stdout`);
    const errorPath = path.join(transportDir, `${stem}.stderr`);
    const inputPath = path.join(transportDir, `${stem}.stdin`);
    transportFiles = [outputPath, errorPath, ...(input ? [inputPath] : [])];
    const argumentLine = fullArgs.map(windowsQuote).join(' ');
    const inputSetup = input
      ? `[IO.File]::WriteAllBytes(${psQuote(inputPath)},[Convert]::FromBase64String($env:CURSOS_AUDIT_AGENT_INPUT_B64));$redirect=@{RedirectStandardInput=${psQuote(inputPath)}}`
      : '$redirect=@{}';
    const script = [
      `$exe=${psQuote(AGENT_BROWSER)}`,
      `$argumentLine=${psQuote(argumentLine)}`,
      inputSetup,
      `$proc=Start-Process -FilePath $exe -ArgumentList $argumentLine -WindowStyle Hidden -PassThru -RedirectStandardOutput ${psQuote(outputPath)} -RedirectStandardError ${psQuote(errorPath)} @redirect`,
      '$proc.WaitForExit()',
      '$exitCode=$proc.ExitCode',
      `[Console]::Out.Write([IO.File]::ReadAllText(${psQuote(outputPath)},[Text.Encoding]::UTF8))`,
      `[Console]::Error.Write([IO.File]::ReadAllText(${psQuote(errorPath)},[Text.Encoding]::UTF8))`,
      'exit $exitCode'
    ].join(';');
    executableArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  }
  const result = spawnSync(
    executable,
    executableArgs,
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout,
      env: {
        ...process.env,
        AGENT_BROWSER_DEFAULT_TIMEOUT: '900000',
        CURSOS_AUDIT_AGENT_INPUT_B64: encodedInput
      },
      windowsHide: true
    }
  );
  for (const filename of transportFiles) {
    try { fsSync.unlinkSync(filename); } catch {}
  }
  if (result.error && !allowFailure) throw result.error;
  const stdout = String(result.stdout || '').trim();
  let parsed = null;
  if (stdout) {
    try { parsed = JSON.parse(stdout); }
    catch (error) {
      if (!allowFailure) throw new Error(`agent-browser devolvió JSON inválido: ${error.message}\n${stdout.slice(0, 500)}`);
    }
  }
  if (!allowFailure && (result.status !== 0 || parsed?.success === false)) {
    throw new Error(`agent-browser falló (${result.status}): ${parsed?.error || result.stderr || stdout}`);
  }
  return { status: result.status, stdout, stderr: String(result.stderr || ''), parsed };
}

function batch(commands, { bail = true, timeout } = {}) {
  const args = ['batch', '--json'];
  if (bail) args.push('--bail');
  const result = runAgent(args, { input: JSON.stringify(commands), timeout });
  if (!Array.isArray(result.parsed)) throw new Error('La respuesta batch de agent-browser no fue una lista.');
  return result.parsed;
}

function commandData(item) {
  return item?.result || item?.data || null;
}

function evalData(item) {
  const raw = commandData(item)?.result;
  if (typeof raw !== 'string') return raw ?? null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function evaluate(script, { timeout = 600_000 } = {}) {
  // Complex JavaScript passed as a normal CLI argument is reparsed by the
  // Windows command layer (quotes inside CSS selectors are lost). `--stdin`
  // preserves the script byte-for-byte and also avoids the apparent batch
  // hang that originally blocked this audit at the catalog.
  const result = runAgent(['eval', '--stdin', '--json'], { input: script, timeout });
  const raw = result.parsed?.data?.result;
  if (typeof raw !== 'string') return raw ?? null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function sanitizeText(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .slice(0, 500);
}

function simplifyConsole(data) {
  const messages = data?.messages || [];
  return messages.map(item => ({ type: item.type || 'log', text: sanitizeText(item.text) })).slice(0, 30);
}

function simplifyErrors(data) {
  return (data?.errors || []).map(item => sanitizeText(item.message || item.text || item)).slice(0, 30);
}

function simplifyAxe(data) {
  if (!data) return { ran: false, counts: null, violations: [], incomplete: [] };
  const summary = list => (list || []).map(item => ({
    id: item.id,
    impact: item.impact || null,
    nodeCount: item.nodeCount ?? item.nodes?.length ?? 0
  }));
  return {
    ran: true,
    axeVersion: data.axeVersion || null,
    counts: data.counts || null,
    violations: summary(data.violations),
    incomplete: summary(data.incomplete)
  };
}

const browserHelpers = String.raw`
  const visible = element => {
    if (!element || element.hidden) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  };
  const label = element => String(
    element.getAttribute('aria-label') || element.innerText || element.value ||
    element.getAttribute('title') || element.id || element.tagName
  ).trim().replace(/\s+/g, ' ').slice(0, 100);
  const descriptor = element => {
    const classes = [...element.classList].slice(0, 3).join('.');
    return element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + (classes ? '.' + classes : '');
  };
  const actionSelector = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[tabindex]:not([tabindex="-1"])';
  const actions = [...document.querySelectorAll(actionSelector)].filter(visible);
  const small = actions.map(element => {
    const rect = element.getBoundingClientRect();
    const overlay = Boolean(element.closest('.answerLayer,.verseLayer,.pdfLinkLayer') || element.matches('.answerField,.verseLink,.pdfLink'));
    return { element, rect, overlay };
  }).filter(item => item.rect.width < 43.5 || item.rect.height < 43.5);
  const touchDetails = items => items.slice(0, 30).map(({ element, rect }) => ({
    selector: descriptor(element), label: label(element), width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10
  }));
  const clipped = [...document.querySelectorAll('h1,h2,h3,p,a,button,label,span,strong,summary')]
    .filter(element => visible(element) && element.textContent.trim())
    .filter(element => {
      const style = getComputedStyle(element);
      const constrained = ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY);
      return constrained && (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2);
    });
  const navigation = performance.getEntriesByType('navigation').at(-1);
  const failedResources = performance.getEntriesByType('resource')
    .filter(item => Number(item.responseStatus) >= 400)
    .map(item => ({ name: new URL(item.name).pathname, status: Number(item.responseStatus) }))
    .slice(0, 30);
  const computed = element => element ? getComputedStyle(element) : null;
  const bodyStyle = computed(document.body);
  const mainText = document.querySelector('main p,.hero p,.welcome p,.adminIntro p,.presentationFallback span');
  const mainTextStyle = computed(mainText);
  const common = {
    urlPath: location.pathname + location.search,
    title: document.title,
    lang: document.documentElement.lang,
    readyState: document.readyState,
    httpStatus: Number(navigation?.responseStatus || 0) || null,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    globalOverflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    bodyFontPx: parseFloat(bodyStyle?.fontSize || '0'),
    bodyLineHeightPx: parseFloat(bodyStyle?.lineHeight || '0'),
    mainTextFontPx: parseFloat(mainTextStyle?.fontSize || '0') || null,
    mainTextLineHeightPx: parseFloat(mainTextStyle?.lineHeight || '0') || null,
    focusableCount: actions.length,
    touchIssueCount: small.filter(item => !item.overlay).length,
    touchIssues: touchDetails(small.filter(item => !item.overlay)),
    overlayTouchExceptionCount: small.filter(item => item.overlay).length,
    overlayTouchExceptions: touchDetails(small.filter(item => item.overlay)),
    clippedTextCount: clipped.length,
    clippedText: clipped.slice(0, 20).map(element => ({ selector: descriptor(element), label: label(element) })),
    visibleErrorText: [...document.querySelectorAll('[role="alert"],.error,.emptyMsg')].filter(visible).map(label).slice(0, 10),
    failedResources
  };
`;

function commonScan(extra = 'return {};') {
  return `(async () => {${browserHelpers}\n${extra}\n})()`;
}

const genericExtra = String.raw`
  return JSON.stringify({ ...common });
`;

function courseExtra(expectedLessons) {
  return String.raw`
    return JSON.stringify({
      ...common,
      expectedLessons: ${expectedLessons},
      lessonRows: document.querySelectorAll('.row').length,
      lessonOpenLinks: document.querySelectorAll('.rowMain').length,
      downloadControls: document.querySelectorAll('.dlRow:not(.shareRow)').length,
      shareControls: document.querySelectorAll('.shareRow').length,
      loadingVisible: visible(document.getElementById('courseStatus')),
      courseTitle: document.getElementById('courseTitle')?.textContent.trim() || ''
    });
  `;
}

const catalogExtra = String.raw`
  return JSON.stringify({
    ...common,
    cards: document.querySelectorAll('.card').length,
    sections: document.querySelectorAll('#sections section').length,
    loadingVisible: visible(document.getElementById('catalogStatus')),
    searchLabelled: document.getElementById('search')?.labels?.length > 0,
    emptyVisible: visible(document.getElementById('empty'))
  });
`;

const pdfDesktopExtra = String.raw`
  const area = document.getElementById('pdfArea');
  const pages = [...document.querySelectorAll('.pg')];
  const evidence = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const sampleCanvas = canvas => {
    try {
      const probe = document.createElement('canvas');
      probe.width = 48;
      probe.height = 48;
      const context = probe.getContext('2d', { willReadFrequently: true });
      context.drawImage(canvas, 0, 0, 48, 48);
      const pixels = context.getImageData(0, 0, 48, 48).data;
      let nonWhite = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 3] > 8 && (pixels[offset] < 246 || pixels[offset + 1] < 246 || pixels[offset + 2] < 246)) nonWhite += 1;
      }
      return Math.round((nonWhite / (pixels.length / 4)) * 100000) / 100000;
    } catch { return null; }
  };
  const answerSource = control => {
    const id = String(control?.dataset?.answerId || '');
    if (id.includes(':widget-')) return 'native';
    if (/:field-[^:]+$/.test(id)) return 'catalog';
    return 'canvas';
  };
  for (const page of pages) {
    page.scrollIntoView({ block: 'center', inline: 'nearest' });
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const canvas = page.querySelector('canvas.pdfCanvas');
      if (page.dataset.rendered === 'true' && canvas?.width > 0 && canvas?.height > 0) break;
      await wait(80);
    }
    const canvas = page.querySelector('canvas.pdfCanvas');
    const accessible = page.querySelector('[id^="accessible-page-"]');
    const fields = [...page.querySelectorAll('.answerField[data-answer-id]')];
    const checks = [...page.querySelectorAll('.answerCheck[data-answer-id]')];
    const sourceCount = (controls, source) => controls.filter(control => answerSource(control) === source).length;
    const hasExtractableText = page.dataset.hasAccessibleText === 'true';
    const describedBy = canvas?.getAttribute('aria-describedby') || null;
    const pageErrors = [...page.querySelectorAll('[role="alert"],.error,.pageError')]
      .filter(visible)
      .map(label);
    evidence.push({
      page: Number(page.dataset.pageNumber),
      rendered: page.dataset.rendered === 'true' && Boolean(canvas?.width && canvas?.height),
      rendering: page.dataset.rendering === 'true',
      renderError: page.dataset.rendered === 'true' ? null : 'render-timeout-or-cancelled',
      canvasWidth: canvas?.width || 0,
      canvasHeight: canvas?.height || 0,
      canvasAriaLabel: canvas?.getAttribute('aria-label') || null,
      nonWhiteRatio: canvas ? sampleCanvas(canvas) : null,
      hasExtractableText,
      accessibleTextLength: accessible?.textContent.trim().length || 0,
      accessibleDescription: describedBy,
      accessibleDescriptionExists: Boolean(describedBy && document.getElementById(describedBy)),
      verseLinks: page.querySelectorAll('.verseLink').length,
      answerFields: fields.length,
      answerChecks: checks.length,
      nativeAnswerFields: sourceCount(fields, 'native'),
      nativeAnswerChecks: sourceCount(checks, 'native'),
      catalogAnswerFields: sourceCount(fields, 'catalog'),
      catalogAnswerChecks: sourceCount(checks, 'catalog'),
      canvasAnswerFields: sourceCount(fields, 'canvas'),
      canvasAnswerChecks: sourceCount(checks, 'canvas'),
      unsafeNoTextCanvasGuesses: hasExtractableText ? 0 : sourceCount(fields, 'canvas') + sourceCount(checks, 'canvas'),
      pdfLinks: page.querySelectorAll('.pdfLink').length,
      declaredFieldCount: Number(page.dataset.fieldCount || 0),
      errors: pageErrors
    });
  }
  pages[0]?.scrollIntoView({ block: 'start' });
  const allRenderedOnce = evidence.length === pages.length && evidence.every(item => item.rendered);
  return JSON.stringify({
    ...common,
    viewer: 'pdfjs',
    pageCount: pages.length,
    allPagesScrolled: evidence.length === pages.length,
    allPagesRenderedOnce: allRenderedOnce,
    renderedPageEvidence: evidence,
    verseReferenceCount: evidence.reduce((sum, item) => sum + item.verseLinks, 0),
    answerFieldCount: evidence.reduce((sum, item) => sum + item.answerFields, 0),
    answerCheckCount: evidence.reduce((sum, item) => sum + item.answerChecks, 0),
    pdfLinkCount: evidence.reduce((sum, item) => sum + item.pdfLinks, 0),
    extractableTextPages: evidence.filter(item => item.hasExtractableText).length,
    accessibleDescriptionPages: evidence.filter(item => item.accessibleDescriptionExists).length,
    nativeAnswerFieldCount: evidence.reduce((sum, item) => sum + item.nativeAnswerFields, 0),
    nativeAnswerCheckCount: evidence.reduce((sum, item) => sum + item.nativeAnswerChecks, 0),
    catalogAnswerFieldCount: evidence.reduce((sum, item) => sum + item.catalogAnswerFields, 0),
    catalogAnswerCheckCount: evidence.reduce((sum, item) => sum + item.catalogAnswerChecks, 0),
    canvasAnswerFieldCount: evidence.reduce((sum, item) => sum + item.canvasAnswerFields, 0),
    canvasAnswerCheckCount: evidence.reduce((sum, item) => sum + item.canvasAnswerChecks, 0),
    unsafeNoTextCanvasGuessCount: evidence.reduce((sum, item) => sum + item.unsafeNoTextCanvasGuesses, 0),
    perPageErrorCount: evidence.reduce((sum, item) => sum + item.errors.length + (item.renderError ? 1 : 0), 0),
    canvasNonWhitePages: evidence.filter(item => item.nonWhiteRatio === null || item.nonWhiteRatio > 0).length,
    area: { clientWidth: area?.clientWidth || 0, scrollWidth: area?.scrollWidth || 0, clientHeight: area?.clientHeight || 0 },
    zoomLabel: document.getElementById('zoomValue')?.textContent.trim() || '',
    originalDownloadVisible: visible(document.getElementById('downloadOriginal')),
    pageNavigationVisible: visible(document.querySelector('.pdfNav'))
  });
`;

const pdfMobileExtra = String.raw`
  const area = document.getElementById('pdfArea');
  const pages = [...document.querySelectorAll('.pg')];
  const indexes = [...new Set([0, Math.max(0, pages.length - 1)])];
  const evidence = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const index of indexes) {
    const page = pages[index];
    if (!page) continue;
    page.scrollIntoView({ block: 'center', inline: 'nearest' });
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const canvas = page.querySelector('canvas.pdfCanvas');
      if (page.dataset.rendered === 'true' && canvas?.width > 0 && canvas?.height > 0) break;
      await wait(80);
    }
    const canvas = page.querySelector('canvas.pdfCanvas');
    evidence.push({ page: Number(page.dataset.pageNumber), rendered: page.dataset.rendered === 'true' && Boolean(canvas?.width && canvas?.height) });
  }
  pages[0]?.scrollIntoView({ block: 'start' });
  return JSON.stringify({
    ...common,
    viewer: 'pdfjs',
    pageCount: pages.length,
    edgePagesRendered: evidence,
    area: { clientWidth: area?.clientWidth || 0, scrollWidth: area?.scrollWidth || 0, clientHeight: area?.clientHeight || 0 },
    intentionalReaderPanPx: Math.max(0, (area?.scrollWidth || 0) - (area?.clientWidth || 0)),
    zoomLabel: document.getElementById('zoomValue')?.textContent.trim() || '',
    originalDownloadVisible: visible(document.getElementById('downloadOriginal')),
    pageNavigationVisible: visible(document.querySelector('.pdfNav'))
  });
`;

const presentationExtra = String.raw`
  const frame = document.getElementById('presentationFrame');
  const open = document.getElementById('openViewer');
  const download = document.getElementById('download');
  const fallback = document.getElementById('fallback');
  const status = document.getElementById('status');
  const transcriptButton = document.getElementById('openTranscript');
  const transcript = document.getElementById('presentationTranscript');
  let frameOrigin = null;
  let openOrigin = null;
  try { frameOrigin = frame?.src ? new URL(frame.src).origin : null; } catch {}
  try { openOrigin = open?.href ? new URL(open.href).origin : null; } catch {}
  return JSON.stringify({
    ...common,
    viewer: 'office-web-iframe',
    iframeCount: document.querySelectorAll('#presentationFrame').length,
    iframeHasSource: Boolean(frame?.src),
    iframeUrl: frame?.src || null,
    iframeOrigin: frameOrigin,
    iframeVisible: visible(frame),
    iframeDimensions: frame ? { width: Math.round(frame.getBoundingClientRect().width), height: Math.round(frame.getBoundingClientRect().height) } : null,
    openViewerVisible: visible(open),
    openViewerUrl: open?.href || null,
    openViewerOrigin: openOrigin,
    openViewerMatchesIframe: Boolean(frame?.src && open?.href && frame.src === open.href),
    downloadVisible: visible(download),
    downloadEnabled: Boolean(download && !download.disabled),
    downloadControlType: download?.tagName.toLowerCase() || null,
    downloadLabel: download?.textContent.trim() || '',
    transcriptButtonVisible: visible(transcriptButton),
    transcriptButtonExpanded: transcriptButton?.getAttribute('aria-expanded') || null,
    transcriptPanelHidden: Boolean(transcript?.hidden),
    transcriptSlideRows: document.querySelectorAll('.slideTranscript').length,
    transcriptCitationButtons: document.querySelectorAll('.slideVerseButton').length,
    transcriptSummary: document.getElementById('transcriptSummary')?.textContent.trim() || '',
    fallbackVisible: visible(fallback),
    fallbackText: visible(fallback) ? fallback.innerText.trim().replace(/\s+/g, ' ').slice(0, 200) : '',
    loadingStatusVisible: visible(status),
    loadingStatusText: status?.textContent.trim() || ''
  });
`;

const presentationTranscriptExtra = String.raw`
  document.querySelectorAll('.slideTranscript').forEach(details => { details.open = true; });
  const transcript = document.getElementById('presentationTranscript');
  const slides = [...document.querySelectorAll('.slideTranscript')].map((details, index) => {
    const summary = details.querySelector('summary');
    const text = details.querySelector('.slideTranscriptText');
    const citations = [...details.querySelectorAll('.slideVerseButton')];
    return {
      number: Number(summary?.textContent.match(/\d+/)?.[0] || index + 1),
      summary: summary?.textContent.trim() || '',
      open: details.open,
      text: text?.textContent.trim().slice(0, 800) || '',
      textLength: text?.textContent.trim().length || 0,
      emptyPlaceholder: text?.classList.contains('slideTranscriptEmpty') || false,
      citationCount: citations.length,
      citationLabels: citations.map(button => button.textContent.trim()),
      citationAccessibleNames: citations.map(button => button.getAttribute('aria-label') || '')
    };
  });
  return JSON.stringify({
    ...common,
    panelVisible: visible(transcript),
    role: transcript?.getAttribute('role') || null,
    ariaModal: transcript?.getAttribute('aria-modal') || null,
    labelledBy: transcript?.getAttribute('aria-labelledby') || null,
    labelledByExists: Boolean(document.getElementById(transcript?.getAttribute('aria-labelledby') || '')),
    closeFocused: document.activeElement?.id === 'closeTranscript',
    triggerExpanded: document.getElementById('openTranscript')?.getAttribute('aria-expanded') || null,
    slideCount: slides.length,
    citationButtonCount: slides.reduce((sum, slide) => sum + slide.citationCount, 0),
    emptySlideCount: slides.filter(slide => slide.emptyPlaceholder).length,
    slides
  });
`;

function viewportCommands(url, readyExpression, scanScript, viewport, { reload = true, axe = true, clearZoom = false } = {}) {
  const commands = [
    ['console', '--clear'],
    ['errors', '--clear'],
    ['set', 'viewport', String(viewport.width), String(viewport.height)]
  ];
  if (clearZoom) commands.push(['eval', "localStorage.removeItem('cursosBiblicosReaderZoom_v1'); true"]);
  if (reload) commands.push(['open', url]);
  else commands.push(['eval', "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))"]);
  if (readyExpression) commands.push(['wait', '--fn', readyExpression]);
  commands.push(['eval', scanScript]);
  if (axe) commands.push(['a11y', '--tags', 'wcag2a,wcag2aa']);
  commands.push(['console'], ['errors'], ['console', '--clear'], ['errors', '--clear']);
  return commands;
}

function parseViewportBatch(items, { axe = true } = {}) {
  const failed = items.filter(item => item.success === false).map(item => sanitizeText(item.error));
  const evalItems = items.filter(item => item.command?.[0] === 'eval');
  const scanItem = evalItems.at(-1);
  const axeItem = items.find(item => item.command?.[0] === 'a11y');
  const consoleItem = items.findLast(item => item.command?.[0] === 'console' && !item.command.includes('--clear'));
  const errorsItem = items.findLast(item => item.command?.[0] === 'errors' && !item.command.includes('--clear'));
  const openItem = items.find(item => item.command?.[0] === 'open');
  return {
    commandFailures: failed,
    open: openItem ? {
      success: openItem.success,
      title: commandData(openItem)?.title || null,
      urlPath: (() => {
        try { const url = new URL(commandData(openItem)?.url); return `${url.pathname}${url.search}`; } catch { return null; }
      })()
    } : null,
    metrics: evalData(scanItem),
    axe: axe ? simplifyAxe(commandData(axeItem)) : { ran: false, counts: null, violations: [], incomplete: [] },
    console: simplifyConsole(commandData(consoleItem)),
    pageErrors: simplifyErrors(commandData(errorsItem))
  };
}

function routeStatus(result, kind) {
  const viewports = [result.desktop, result.mobile];
  const hardFailure = viewports.some(viewport =>
    viewport.commandFailures.length || !viewport.metrics || viewport.pageErrors.length ||
    viewport.metrics.globalOverflowPx > 2 || viewport.metrics.visibleErrorText?.length ||
    viewport.metrics.failedResources?.length || viewport.axe.violations.length
  );
  if (hardFailure) return 'defect';
  if (kind === 'catalog' && viewports.some(viewport => viewport.metrics.cards !== 14 || !viewport.metrics.searchLabelled)) return 'defect';
  if (kind === 'course' && viewports.some(viewport =>
    viewport.metrics.lessonRows !== viewport.metrics.expectedLessons ||
    viewport.metrics.lessonOpenLinks !== viewport.metrics.expectedLessons || viewport.metrics.loadingVisible
  )) return 'defect';
  if (kind === 'pdf') {
    const metrics = result.desktop.metrics;
    if (!metrics.allPagesRenderedOnce || metrics.perPageErrorCount > 0 || metrics.unsafeNoTextCanvasGuessCount > 0) return 'defect';
    if (metrics.accessibleDescriptionPages !== metrics.pageCount) return 'defect';
    if (!result.mobile.metrics.edgePagesRendered?.length || result.mobile.metrics.edgePagesRendered.some(page => !page.rendered)) return 'defect';
    if (viewports.some(viewport => !viewport.metrics.originalDownloadVisible || !viewport.metrics.pageNavigationVisible)) return 'defect';
  }
  if (kind === 'presentation') {
    if (viewports.some(viewport => {
      const metrics = viewport.metrics;
      return !metrics.iframeHasSource || !metrics.iframeVisible || !metrics.openViewerVisible ||
        !metrics.openViewerMatchesIframe || !metrics.downloadVisible || !metrics.downloadEnabled ||
        !metrics.transcriptButtonVisible || metrics.transcriptSlideRows < 1;
    })) return 'defect';
  }
  if (kind === 'admin' && viewports.some(viewport =>
    viewport.metrics.courseCards !== 14 || viewport.metrics.lessonRows !== 215 || viewport.metrics.statusError
  )) return 'defect';
  if (kind === 'edit' && viewports.some(viewport =>
    !viewport.metrics.appShellVisible || viewport.metrics.accessGateVisible || !viewport.metrics.promptLabel
  )) return 'defect';
  return 'pass';
}

async function fetchCatalog() {
  const response = await fetch(`${LOCAL_ORIGIN}/api/catalog`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`No se pudo cargar el catálogo local (${response.status}).`);
  return response.json();
}

function stableLessonRoute(course, lesson) {
  if (lesson.type === 'pdf') {
    return `/leer.html?c=${encodeURIComponent(course.id)}&l=${encodeURIComponent(lesson.legacyNumber || lesson.id)}`;
  }
  return `/presentacion.html?c=${encodeURIComponent(course.id)}&l=${encodeURIComponent(lesson.id)}`;
}

function cleanUrlPath(value) {
  try { return new URL(value, LOCAL_ORIGIN).pathname; }
  catch { return String(value || '').split('?')[0]; }
}

function answerCatalogMetadata(answerCatalog, course, lesson) {
  const document = answerCatalog.documents?.[`${course.id}|${lesson.id}`] ||
    answerCatalog.documents?.[`${course.id}|${lesson.legacyNumber}`] || null;
  return {
    documentPresent: Boolean(document),
    urlMatches: Boolean(document && (!document.url || cleanUrlPath(document.url) === cleanUrlPath(lesson.url))),
    catalogPageCount: document ? Object.keys(document.pages || {}).length : 0
  };
}

async function checkpoint(audit) {
  if (SMOKE) return;
  await fs.mkdir(path.dirname(OUTPUT_JSON), { recursive: true });
  audit.updatedAt = new Date().toISOString();
  await fs.writeFile(OUTPUT_JSON, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
}

function auditViewport({ url, readyExpression, scanScript, viewport, reload, clearZoom }) {
  const setupCommands = [
    ['console', '--clear'],
    ['errors', '--clear'],
    ['set', 'viewport', String(viewport.width), String(viewport.height)]
  ];
  if (reload) setupCommands.push(['open', url]);
  if (readyExpression) setupCommands.push(['wait', '--fn', readyExpression]);
  console.log(`    preparando ${viewport.width}px`);
  let setupItems = batch(setupCommands, { timeout: 360_000 });
  console.log(`    DOM listo ${viewport.width}px`);

  if (clearZoom) {
    const hadStoredZoom = evaluate("localStorage.getItem('cursosBiblicosReaderZoom_v1') !== null");
    evaluate("localStorage.removeItem('cursosBiblicosReaderZoom_v1'); true");
    if (hadStoredZoom) {
      const reloadItems = batch([
        ['open', url],
        ['wait', '--fn', readyExpression]
      ], { timeout: 360_000 });
      setupItems = [...setupItems, ...reloadItems];
    }
  }

  console.log(`    inspeccionando ${viewport.width}px`);
  const metrics = evaluate(scanScript, { timeout: 900_000 });
  console.log(`    inspección lista ${viewport.width}px`);
  const tailItems = batch([
    ['a11y', '--tags', 'wcag2a,wcag2aa'],
    ['console'],
    ['errors'],
    ['console', '--clear'],
    ['errors', '--clear']
  ], { timeout: 360_000 });
  console.log(`    axe listo ${viewport.width}px`);
  const items = [...setupItems, ...tailItems];
  const openItem = setupItems.findLast(item => item.command?.[0] === 'open');
  const axeItem = tailItems.find(item => item.command?.[0] === 'a11y');
  const consoleItem = tailItems.find(item => item.command?.[0] === 'console' && !item.command.includes('--clear'));
  const errorsItem = tailItems.find(item => item.command?.[0] === 'errors' && !item.command.includes('--clear'));
  return {
    commandFailures: items.filter(item => item.success === false).map(item => sanitizeText(item.error)),
    open: openItem ? {
      success: openItem.success,
      title: commandData(openItem)?.title || null,
      urlPath: (() => {
        try { const opened = new URL(commandData(openItem)?.url); return `${opened.pathname}${opened.search}`; }
        catch { return null; }
      })()
    } : null,
    metrics,
    axe: simplifyAxe(commandData(axeItem)),
    console: simplifyConsole(commandData(consoleItem)),
    pageErrors: simplifyErrors(commandData(errorsItem))
  };
}

async function auditTwoViewports({ url, readyExpression, desktopScript, mobileScript = desktopScript, reloadMobile = false, clearZoom = false }) {
  console.log(`  [browser 1440] ${new URL(url).pathname}`);
  const desktopItems = auditViewport({
    url,
    readyExpression,
    scanScript: desktopScript,
    viewport: { width: 1440, height: 1000 },
    reload: true,
    clearZoom
  });
  console.log(`  [browser 1440 listo] ${new URL(url).pathname}`);
  console.log(`  [browser 390] ${new URL(url).pathname}`);
  const mobileItems = auditViewport({
    url,
    readyExpression,
    scanScript: mobileScript,
    viewport: { width: 390, height: 844 },
    reload: reloadMobile,
    clearZoom
  });
  console.log(`  [browser 390 listo] ${new URL(url).pathname}`);
  return { desktop: desktopItems, mobile: mobileItems };
}

function auditCatalogSearchViewport(viewport) {
  const scan = "JSON.stringify({query:document.getElementById('search').value,cards:document.querySelectorAll('.card').length,sections:document.querySelectorAll('#sections section').length,empty:!document.getElementById('empty').hidden,emptyText:document.getElementById('empty').textContent.trim(),overflowPx:Math.max(0,document.documentElement.scrollWidth-innerWidth)})";
  const items = batch([
    ['set', 'viewport', String(viewport.width), String(viewport.height)],
    ['fill', '#search', 'Jesus'],
    ['eval', scan],
    ['a11y', '--tags', 'wcag2a,wcag2aa'],
    ['fill', '#search', 'curso-inexistente-auditoria'],
    ['eval', scan],
    ['a11y', '--tags', 'wcag2a,wcag2aa'],
    ['fill', '#search', ''],
    ['eval', scan]
  ], { timeout: 120_000 });
  const evals = items.filter(item => item.command?.[0] === 'eval').map(evalData);
  const axeRuns = items.filter(item => item.command?.[0] === 'a11y').map(item => simplifyAxe(commandData(item)));
  return {
    viewport,
    accentInsensitiveSearch: evals[0] || null,
    emptySearchState: evals[1] || null,
    restoredCatalog: evals[2] || null,
    axe: { filtered: axeRuns[0] || null, empty: axeRuns[1] || null },
    commandFailures: items.filter(item => item.success === false).map(item => sanitizeText(item.error))
  };
}

async function auditCatalog() {
  const url = `${LOCAL_ORIGIN}/`;
  const result = await auditTwoViewports({
    url,
    readyExpression: "document.querySelectorAll('.card').length > 0 && document.getElementById('catalogStatus').hidden",
    desktopScript: commonScan(catalogExtra)
  });

  result.interactions = {
    desktop: auditCatalogSearchViewport({ width: 1440, height: 1000 }),
    mobile: auditCatalogSearchViewport({ width: 390, height: 844 })
  };
  const interactionDefect = ['desktop', 'mobile'].some(name => {
    const view = result.interactions[name];
    return view.commandFailures.length || !view.accentInsensitiveSearch?.cards || view.accentInsensitiveSearch?.empty ||
      view.emptySearchState?.cards !== 0 || !view.emptySearchState?.empty ||
      view.restoredCatalog?.cards !== 14 || view.restoredCatalog?.empty ||
      view.accentInsensitiveSearch?.overflowPx > 2 || view.emptySearchState?.overflowPx > 2 ||
      view.axe.filtered?.violations?.length || view.axe.empty?.violations?.length;
  });
  result.finalStatus = routeStatus(result, 'catalog') === 'pass' && !interactionDefect ? 'pass' : 'defect';
  return result;
}

async function auditCourse(course) {
  const route = `/curso.html?c=${encodeURIComponent(course.id)}`;
  const result = await auditTwoViewports({
    url: `${LOCAL_ORIGIN}${route}`,
    readyExpression: `document.querySelectorAll('.row').length === ${course.lessons.length}`,
    desktopScript: commonScan(courseExtra(course.lessons.length))
  });
  return {
    courseId: course.id,
    courseName: course.name,
    route,
    expectedLessons: course.lessons.length,
    ...result,
    finalStatus: routeStatus(result, 'course')
  };
}

async function auditPdf(course, lesson, catalogMetadata) {
  const route = stableLessonRoute(course, lesson);
  const result = await auditTwoViewports({
    url: `${LOCAL_ORIGIN}${route}`,
    readyExpression: "document.querySelectorAll('.pg').length > 0",
    desktopScript: commonScan(pdfDesktopExtra),
    mobileScript: commonScan(pdfMobileExtra),
    reloadMobile: true,
    clearZoom: true
  });
  const actualPageCount = Number(result.desktop?.metrics?.pageCount || 0);
  const pageCountMismatch = Boolean(catalogMetadata.documentPresent && catalogMetadata.urlMatches &&
    catalogMetadata.catalogPageCount && actualPageCount && catalogMetadata.catalogPageCount !== actualPageCount);
  const catalogControlsRendered = Number(result.desktop?.metrics?.catalogAnswerFieldCount || 0) +
    Number(result.desktop?.metrics?.catalogAnswerCheckCount || 0);
  const nativeFieldsRendered = Number(result.desktop?.metrics?.nativeAnswerFieldCount || 0);
  const nativeCheckboxesRendered = Number(result.desktop?.metrics?.nativeAnswerCheckCount || 0);
  const noTextPages = (result.desktop?.metrics?.renderedPageEvidence || [])
    .filter(page => !page.hasExtractableText).length;
  const answerCatalogGuard = {
    ...catalogMetadata,
    actualPageCount,
    pageCountMismatch,
    catalogControlsRendered,
    staleCatalogRejected: pageCountMismatch ? catalogControlsRendered === 0 : null,
    nativeFieldsRendered,
    nativeCheckboxesRendered,
    nativeCheckboxesPreservedWhileStale: pageCountMismatch && nativeCheckboxesRendered > 0,
    noTextPages,
    unsafeNoTextCanvasGuessCount: Number(result.desktop?.metrics?.unsafeNoTextCanvasGuessCount || 0),
    unsafeNoTextCanvasGuessesDisabled: noTextPages > 0
      ? Number(result.desktop?.metrics?.unsafeNoTextCanvasGuessCount || 0) === 0
      : null
  };
  const item = {
    courseId: course.id,
    courseName: course.name,
    lessonId: lesson.id,
    lessonLegacyNumber: lesson.legacyNumber || null,
    lessonTitle: lesson.title,
    type: lesson.type,
    route,
    answerCatalogGuard,
    ...result
  };
  item.finalStatus = routeStatus(result, 'pdf') === 'pass' &&
    (!pageCountMismatch || answerCatalogGuard.staleCatalogRejected) ? 'pass' : 'defect';
  return item;
}

async function fetchPresentationDescriptor(course, lesson) {
  const url = `${LOCAL_ORIGIN}/api/presentation?c=${encodeURIComponent(course.id)}&l=${encodeURIComponent(lesson.id)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`No se pudo cargar el descriptor local de presentación (${response.status}).`);
  return response.json();
}

function auditPresentationTranscriptViewport(viewport, { exerciseVerseModal = false } = {}) {
  const openItems = batch([
    ['console', '--clear'],
    ['errors', '--clear'],
    ['set', 'viewport', String(viewport.width), String(viewport.height)],
    ['click', '#openTranscript'],
    ['wait', '#presentationTranscript:not([hidden])'],
    ['eval', commonScan(presentationTranscriptExtra)],
    ['a11y', '--tags', 'wcag2a,wcag2aa']
  ], { timeout: 180_000 });
  const metrics = evalData(openItems.findLast(item => item.command?.[0] === 'eval'));
  const axe = simplifyAxe(commandData(openItems.find(item => item.command?.[0] === 'a11y')));
  const commandFailures = openItems.filter(item => item.success === false).map(item => sanitizeText(item.error));
  let modal = null;

  if (exerciseVerseModal && Number(metrics?.citationButtonCount || 0) > 0) {
    const modalItems = batch([
      ['eval', "(() => { const button=document.querySelector('.slideVerseButton'); button?.focus(); return JSON.stringify({triggerFocused:document.activeElement===button,triggerLabel:button?.textContent.trim()||''}); })()"],
      ['click', '.slideVerseButton'],
      ['wait', '.verseModal:not([hidden])'],
      ['wait', '--fn', "document.getElementById('presentationVerseText')?.textContent.trim() !== 'Buscando el texto...'"],
      ['eval', "JSON.stringify({visible:!document.querySelector('.verseModal')?.hidden,role:document.querySelector('.verseCard')?.getAttribute('role')||null,ariaModal:document.querySelector('.verseCard')?.getAttribute('aria-modal')||null,title:document.getElementById('presentationVerseTitle')?.textContent.trim()||'',verseParagraphs:document.querySelectorAll('#presentationVerseText p').length,closeFocused:document.activeElement?.textContent.trim()==='Cerrar'})"],
      ['press', 'Tab'],
      ['eval', "JSON.stringify({tabStayedInside:Boolean(document.activeElement?.closest('.verseModal')),activeLabel:document.activeElement?.textContent.trim()||''})"],
      ['press', 'Shift+Tab'],
      ['eval', "JSON.stringify({shiftTabStayedInside:Boolean(document.activeElement?.closest('.verseModal')),activeLabel:document.activeElement?.textContent.trim()||''})"],
      ['press', 'Escape'],
      ['eval', "JSON.stringify({closed:Boolean(document.querySelector('.verseModal')?.hidden),focusReturnedToTrigger:document.activeElement?.classList.contains('slideVerseButton')||false})"]
    ], { bail: false, timeout: 180_000 });
    const evals = modalItems.filter(item => item.command?.[0] === 'eval').map(evalData);
    modal = {
      trigger: evals[0] || null,
      opened: evals[1] || null,
      tabForward: evals[2] || null,
      tabBackward: evals[3] || null,
      closed: evals[4] || null,
      commandFailures: modalItems.filter(item => item.success === false).map(item => sanitizeText(item.error))
    };
  }

  const closeItems = batch([
    ['press', 'Escape'],
    ['eval', "JSON.stringify({closed:document.getElementById('presentationTranscript').hidden,triggerExpanded:document.getElementById('openTranscript').getAttribute('aria-expanded'),focusReturnedToTrigger:document.activeElement?.id==='openTranscript'})"],
    ['console'],
    ['errors'],
    ['console', '--clear'],
    ['errors', '--clear']
  ], { bail: false, timeout: 120_000 });
  return {
    viewport,
    metrics,
    axe,
    modal,
    close: evalData(closeItems.find(item => item.command?.[0] === 'eval')),
    commandFailures: [
      ...commandFailures,
      ...closeItems.filter(item => item.success === false).map(item => sanitizeText(item.error))
    ],
    console: simplifyConsole(commandData(closeItems.find(item => item.command?.[0] === 'console' && !item.command.includes('--clear')))),
    pageErrors: simplifyErrors(commandData(closeItems.find(item => item.command?.[0] === 'errors' && !item.command.includes('--clear'))))
  };
}

async function auditPresentation(course, lesson) {
  const route = stableLessonRoute(course, lesson);
  const descriptor = await fetchPresentationDescriptor(course, lesson);
  const ready = "!document.getElementById('openViewer').hidden && Boolean(document.getElementById('presentationFrame').src) && !document.getElementById('openTranscript').hidden";
  const result = await auditTwoViewports({
    url: `${LOCAL_ORIGIN}${route}`,
    readyExpression: ready,
    desktopScript: commonScan(presentationExtra)
  });
  const transcript = {
    expectedStatus: descriptor.accessibility?.status || null,
    expectedSlideCount: Number(descriptor.accessibility?.slideCount || descriptor.accessibility?.slides?.length || 0),
    expectedReferenceCount: Number(descriptor.accessibility?.referenceCount || 0),
    desktop: auditPresentationTranscriptViewport({ width: 1440, height: 1000 }, { exerciseVerseModal: true }),
    mobile: auditPresentationTranscriptViewport({ width: 390, height: 844 })
  };
  const modalDefect = transcript.expectedReferenceCount > 0 && (
    !transcript.desktop.modal?.opened?.visible || !transcript.desktop.modal?.closed?.closed ||
    !transcript.desktop.modal?.closed?.focusReturnedToTrigger ||
    !transcript.desktop.modal?.tabForward?.tabStayedInside || !transcript.desktop.modal?.tabBackward?.shiftTabStayedInside
  );
  const transcriptDefect = ['desktop', 'mobile'].some(name => {
    const view = transcript[name];
    return view.commandFailures.length || view.pageErrors.length || view.axe.violations.length ||
      !view.metrics?.panelVisible || view.metrics?.slideCount !== transcript.expectedSlideCount ||
      view.metrics?.citationButtonCount !== transcript.expectedReferenceCount ||
      !view.close?.closed || !view.close?.focusReturnedToTrigger;
  }) || modalDefect;
  const item = {
    courseId: course.id,
    courseName: course.name,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    type: lesson.type,
    route,
    transcript,
    ...result,
  };
  item.finalStatus = routeStatus(result, 'presentation') === 'pass' && !transcriptDefect ? 'pass' : 'defect';
  return item;
}

async function auditAdmin() {
  const route = '/admin/';
  const result = await auditTwoViewports({
    url: `${LOCAL_ORIGIN}${route}`,
    readyExpression: "document.querySelectorAll('.manageCourse').length > 0 || document.getElementById('status').classList.contains('error')",
    desktopScript: commonScan(String.raw`
      return JSON.stringify({
        ...common,
        courseCards: document.querySelectorAll('.manageCourse').length,
        lessonRows: document.querySelectorAll('.lessonLine').length,
        status: document.getElementById('status')?.textContent.trim() || '',
        statusError: document.getElementById('status')?.classList.contains('error') || false
      });
    `)
  });

  const interactions = [];
  const safeButtons = [
    ['add-course-dialog', '#addCourse', '#courseDialog[open]', '[data-close="courseDialog"]'],
    ['trash-dialog', '#openTrash', '#listDialog[open]', '[data-close="listDialog"]'],
    ['history-dialog', '#openHistory', '#listDialog[open]', '[data-close="listDialog"]'],
    ['audit-dialog', '#openAudit', '#listDialog[open]', '[data-close="listDialog"]']
  ];
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    for (const [name, buttonSelector, dialogSelector, closeSelector] of safeButtons) {
      const commands = [
        ['set', 'viewport', String(viewport.width), String(viewport.height)],
        ['click', buttonSelector],
        ['wait', dialogSelector]
      ];
      if (name === 'audit-dialog') {
        commands.push(['wait', '--fn', "document.querySelector('#listDialog[open]') && !document.getElementById('listDialogBody').textContent.includes('Revisando archivos')"]);
      }
      commands.push(
        ['eval', `JSON.stringify((()=>{const dialog=document.querySelector(${JSON.stringify(dialogSelector)});const rect=dialog?.getBoundingClientRect();return{name:${JSON.stringify(name)},viewport:${JSON.stringify(viewport.name)},open:Boolean(dialog),title:dialog?.querySelector('h2')?.textContent.trim()||'',rows:dialog?.querySelectorAll('.restoreLine,.auditSection,.auditIssue,input,select').length||0,bodyText:dialog?.innerText.trim().replace(/\\s+/g,' ').slice(0,500)||'',overflowPx:dialog?Math.max(0,dialog.scrollWidth-dialog.clientWidth):0,rect:rect?{width:Math.round(rect.width),height:Math.round(rect.height)}:null}}})())`],
        ['a11y', '--tags', 'wcag2a,wcag2aa'],
        ['click', closeSelector]
      );
      const items = batch(commands, { bail: false, timeout: 180_000 });
      interactions.push({
        name,
        viewport: viewport.name,
        commandFailures: items.filter(item => item.success === false).map(item => sanitizeText(item.error)),
        result: evalData(items.find(item => item.command?.[0] === 'eval')),
        axe: simplifyAxe(commandData(items.find(item => item.command?.[0] === 'a11y')))
      });
    }
  }
  result.safeReadOnlyInteractions = interactions;
  const interactionDefect = interactions.some(item => item.commandFailures.length || !item.result?.open ||
    item.result?.overflowPx > 2 || item.axe.violations.length);
  result.finalStatus = routeStatus(result, 'admin') === 'pass' && !interactionDefect ? 'pass' : 'defect';
  return result;
}

async function auditEdit() {
  const route = '/edit/';
  const routePattern = '**/api/code/status';
  runAgent(['network', 'route', routePattern, '--body', JSON.stringify({ online: false, busy: false, providers: [], lastSeen: null }), '--json']);
  try {
    const result = await auditTwoViewports({
      url: `${LOCAL_ORIGIN}${route}`,
      readyExpression: "!document.getElementById('appShell').hidden",
      desktopScript: commonScan(String.raw`
        return JSON.stringify({
          ...common,
          appShellVisible: visible(document.getElementById('appShell')),
          accessGateVisible: visible(document.getElementById('accessGate')),
          promptLabel: document.getElementById('prompt')?.getAttribute('aria-label') || '',
          suggestions: document.querySelectorAll('[data-suggestion]').length,
          quickActions: document.querySelectorAll('[data-action]').length,
          hostStatus: document.getElementById('hostStatusText')?.textContent.trim() || ''
        });
      `)
    });
    const interactions = [];
    for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
      const items = batch([
        ['set', 'viewport', String(viewport.width), String(viewport.height)],
        ['eval', "if (!document.getElementById('computerPanel').hidden) document.getElementById('hostStatus').click(); true"],
        ['click', '[data-suggestion]'],
        ['eval', "JSON.stringify({suggestionFilled:Boolean(document.getElementById('prompt').value),sendEnabled:!document.getElementById('sendButton').disabled,promptLabel:document.getElementById('prompt').getAttribute('aria-label')||'',overflowPx:Math.max(0,document.documentElement.scrollWidth-innerWidth)})"],
        ['fill', '#prompt', ''],
        ['click', '#hostStatus'],
        ['eval', "JSON.stringify({panelVisible:!document.getElementById('computerPanel').hidden,status:document.getElementById('hostStatusText').textContent,sendDisabled:document.getElementById('sendButton').disabled})"],
        ['a11y', '--tags', 'wcag2a,wcag2aa']
      ], { bail: false, timeout: 120_000 });
      const evals = items.filter(item => item.command?.[0] === 'eval').map(evalData);
      interactions.push({
        viewport: viewport.name,
        suggestion: evals[1] || null,
        statusPanel: evals[2] || null,
        axe: simplifyAxe(commandData(items.find(item => item.command?.[0] === 'a11y'))),
        commandFailures: items.filter(item => item.success === false).map(item => sanitizeText(item.error))
      });
    }
    result.safeReadOnlyInteractions = interactions;
    const interactionDefect = interactions.some(item => item.commandFailures.length ||
      !item.suggestion?.suggestionFilled || !item.suggestion?.sendEnabled || item.suggestion?.overflowPx > 2 ||
      !item.statusPanel?.panelVisible || !item.statusPanel?.sendDisabled || item.axe.violations.length);
    result.finalStatus = routeStatus(result, 'edit') === 'pass' && !interactionDefect ? 'pass' : 'defect';
    return result;
  } finally {
    runAgent(['network', 'unroute', routePattern, '--json'], { allowFailure: true });
  }
}

function makeSummary(audit) {
  const allRoutes = [audit.catalog, ...audit.courses, ...audit.pdfs, ...audit.presentations, audit.admin, audit.edit].filter(Boolean);
  const viewports = allRoutes.flatMap(route => [route.desktop, route.mobile]).filter(Boolean);
  const statusCounts = Object.groupBy ? Object.fromEntries(Object.entries(Object.groupBy(allRoutes, item => item.finalStatus)).map(([key, value]) => [key, value.length])) : allRoutes.reduce((acc, item) => { acc[item.finalStatus] = (acc[item.finalStatus] || 0) + 1; return acc; }, {});
  return {
    routeCount: allRoutes.length,
    artifactCount: audit.pdfs.length + audit.presentations.length,
    courseRouteCount: audit.courses.length,
    pdfCount: audit.pdfs.length,
    pdfPageCount: audit.pdfs.reduce((sum, item) => sum + Number(item.desktop?.metrics?.pageCount || 0), 0),
    pdfPagesRenderedOnce: audit.pdfs.reduce((sum, item) => sum + (item.desktop?.metrics?.renderedPageEvidence || []).filter(page => page.rendered).length, 0),
    pdfPagesWithAccessibleDescriptions: audit.pdfs.reduce((sum, item) => sum + Number(item.desktop?.metrics?.accessibleDescriptionPages || 0), 0),
    pdfPagesWithExtractableText: audit.pdfs.reduce((sum, item) => sum + Number(item.desktop?.metrics?.extractableTextPages || 0), 0),
    pdfNoTextPages: audit.pdfs.reduce((sum, item) => sum + Number(item.answerCatalogGuard?.noTextPages || 0), 0),
    pdfUnsafeNoTextCanvasGuessCount: audit.pdfs.reduce((sum, item) => sum + Number(item.answerCatalogGuard?.unsafeNoTextCanvasGuessCount || 0), 0),
    nativeAnswerCheckboxesRendered: audit.pdfs.reduce((sum, item) => sum + Number(item.answerCatalogGuard?.nativeCheckboxesRendered || 0), 0),
    staleFieldCatalogDocuments: audit.pdfs.filter(item => item.answerCatalogGuard?.pageCountMismatch).length,
    staleFieldCatalogDocumentsRejected: audit.pdfs.filter(item => item.answerCatalogGuard?.staleCatalogRejected).length,
    staleFieldCatalogDocumentsPreservingNativeCheckboxes: audit.pdfs.filter(item => item.answerCatalogGuard?.nativeCheckboxesPreservedWhileStale).length,
    presentationCount: audit.presentations.length,
    presentationAffordancePassCount: audit.presentations.filter(item => item.finalStatus === 'pass').length,
    statusCounts,
    viewportAuditCount: viewports.length,
    axeRuns: viewports.filter(item => item.axe?.ran).length,
    axeViolationRouteViewports: viewports.filter(item => item.axe?.violations?.length).length,
    pageErrorRouteViewports: viewports.filter(item => item.pageErrors?.length).length,
    consoleMessageRouteViewports: viewports.filter(item => item.console?.length).length,
    globalOverflowRouteViewports: viewports.filter(item => Number(item.metrics?.globalOverflowPx || 0) > 2).length,
    touchIssueRouteViewports: viewports.filter(item => Number(item.metrics?.touchIssueCount || 0) > 0).length
  };
}

function markdownReport(audit) {
  const summary = audit.summary;
  const defects = [audit.catalog, ...audit.courses, ...audit.pdfs, ...audit.presentations, audit.admin, audit.edit]
    .filter(item => item?.finalStatus !== 'pass');
  const lines = [
    '# Auditoría real de navegador — Cursos Bíblicos',
    '',
    `- Sesión aislada: \`${audit.browser.session}\``,
    `- Inicio: ${audit.startedAt}`,
    `- Fin: ${audit.completedAt}`,
    `- Catálogo: ${audit.inventory.courseCount} cursos, ${audit.inventory.lessonCount} lecciones`,
    `- Rutas verificadas en 1440 px y 390 px: ${summary.routeCount} (${summary.viewportAuditCount} comprobaciones de viewport)`,
    `- PDF: ${summary.pdfCount} archivos, ${summary.pdfPageCount} páginas; ${summary.pdfPagesRenderedOnce} páginas desplazadas y renderizadas al menos una vez en Chrome`,
    `- Accesibilidad PDF por página: ${summary.pdfPagesWithAccessibleDescriptions}/${summary.pdfPageCount} lienzos descritos; ${summary.pdfPagesWithExtractableText} páginas con texto extraíble`,
    `- Catálogos de campos obsoletos: ${summary.staleFieldCatalogDocumentsRejected}/${summary.staleFieldCatalogDocuments} rechazados; ${summary.nativeAnswerCheckboxesRendered} casillas Btn nativas conservadas en total`,
    `- Páginas sin texto seleccionable: ${summary.pdfNoTextPages}; controles inseguros adivinados desde lienzo: ${summary.pdfUnsafeNoTextCanvasGuessCount}`,
    `- Presentaciones: ${summary.presentationCount} rutas con descriptor, iframe, apertura aparte y descarga comprobados`,
    `- Axe: ${summary.axeRuns} ejecuciones; ${summary.axeViolationRouteViewports} viewports con violaciones`,
    `- Estado por ruta: ${Object.entries(summary.statusCounts).map(([key, value]) => `${key}=${value}`).join(', ')}`,
    '',
    '## Cobertura',
    '',
    'El JSON compañero contiene evidencia por curso, lección, ruta, viewport y —para PDF— por página. Las presentaciones se comprueban aquí hasta el límite seguro del iframe web de Office; la inspección visual de cada diapositiva pertenece al auditor especializado de presentaciones.',
    '',
    '## Rutas con defectos o bloqueos',
    ''
  ];
  if (!defects.length) lines.push('Ninguna en esta ejecución.');
  else {
    for (const item of defects) {
      const label = item.lessonTitle || item.courseName || item.route || 'catálogo';
      const reasons = [];
      for (const viewportName of ['desktop', 'mobile']) {
        const view = item[viewportName];
        if (!view) continue;
        if (view.commandFailures?.length) reasons.push(`${viewportName}: comando fallido`);
        if (view.pageErrors?.length) reasons.push(`${viewportName}: error de página`);
        if (view.metrics?.globalOverflowPx > 2) reasons.push(`${viewportName}: desbordamiento global ${view.metrics.globalOverflowPx}px`);
        if (view.axe?.violations?.length) reasons.push(`${viewportName}: axe ${view.axe.violations.map(v => v.id).join(', ')}`);
        if (view.metrics?.visibleErrorText?.length) reasons.push(`${viewportName}: mensaje de error visible`);
      }
      if (item.type === 'pdf' && !item.desktop?.metrics?.allPagesRenderedOnce) reasons.push('no todas las páginas PDF se renderizaron');
      lines.push(`- ${label} (\`${item.route || '/'}\`): ${reasons.join('; ') || 'revisión necesaria'}`);
    }
  }
  lines.push('', '## Límites honestos', '', '- El contenido dentro del iframe de Office es de otro origen y no permite inspección DOM desde la página local. Se comprobó el contenedor real, la carga del iframe y las alternativas de apertura/descarga; la auditoría de todas las diapositivas se registra por separado.', '- El servidor local bloqueó cualquier escritura. La pantalla Editar usó únicamente una respuesta local simulada y de solo lectura para `/api/code/status`; no se envió ningún pedido ni publicación.', '');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const catalog = await fetchCatalog();
  const answerCatalog = JSON.parse(await fs.readFile(path.join(ROOT, 'assets', 'answer-fields.json'), 'utf8'));
  const lessons = catalog.courses.flatMap(course => course.lessons.map(lesson => ({ course, lesson })));
  const pdfInventory = lessons.filter(({ lesson }) => lesson.type === 'pdf');
  const presentationInventory = lessons.filter(({ lesson }) => ['ppt', 'pptx', 'ppsx'].includes(lesson.type));
  let audit = {
    schemaVersion: 2,
    auditKind: 'agent-browser-exhaustive-route-pdf-page-and-presentation-transcript-audit',
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    completedAt: null,
    localOrigin: LOCAL_ORIGIN,
    browser: {
      tool: 'agent-browser',
      session: SESSION,
      desktopViewport: { width: 1440, height: 1000 },
      mobileViewport: { width: 390, height: 844 },
      realBrowser: true
    },
    safety: {
      serverReadOnly: true,
      productionWrites: 0,
      editStatusMockedLocally: true,
      editSubmissions: 0,
      downloadsTriggered: 0
    },
    catalogRevision: catalog.revision || null,
    inventory: {
      courseCount: catalog.courses.length,
      lessonCount: lessons.length,
      pdfCount: pdfInventory.length,
      presentationCount: presentationInventory.length
    },
    catalog: null,
    courses: [],
    pdfs: [],
    presentations: [],
    admin: null,
    edit: null,
    summary: null
  };

  if (!FRESH && !SMOKE) {
    try {
      const saved = JSON.parse(await fs.readFile(OUTPUT_JSON, 'utf8'));
      if (!saved.completedAt && saved.catalogRevision === audit.catalogRevision) {
        audit = { ...audit, ...saved, browser: audit.browser, startedAt: saved.startedAt || STARTED_AT };
      }
    } catch {}
  }

  console.log(`Sesión: ${SESSION}`);
  console.log(`Inventario: ${audit.inventory.courseCount} cursos, ${audit.inventory.pdfCount} PDF, ${audit.inventory.presentationCount} presentaciones.`);

  if (!audit.catalog) {
    console.log('[catálogo] verificando');
    audit.catalog = await auditCatalog();
    await checkpoint(audit);
  }

  const doneCourseIds = new Set(audit.courses.map(item => item.courseId));
  for (const course of catalog.courses.slice(0, LIMIT)) {
    if (doneCourseIds.has(course.id)) continue;
    console.log(`[curso ${audit.courses.length + 1}/${catalog.courses.length}] ${course.name}`);
    audit.courses.push(await auditCourse(course));
    await checkpoint(audit);
    if (SMOKE) break;
  }

  if (!SMOKE) {
    const donePdf = new Set(audit.pdfs.map(item => `${item.courseId}|${item.lessonId}`));
    let pdfIndex = 0;
    for (const { course, lesson } of pdfInventory.slice(0, LIMIT)) {
      pdfIndex += 1;
      if (donePdf.has(`${course.id}|${lesson.id}`)) continue;
      console.log(`[PDF ${pdfIndex}/${pdfInventory.length}] ${course.name} — ${lesson.title}`);
      try { audit.pdfs.push(await auditPdf(course, lesson, answerCatalogMetadata(answerCatalog, course, lesson))); }
      catch (error) {
        audit.pdfs.push({ courseId: course.id, courseName: course.name, lessonId: lesson.id, lessonTitle: lesson.title, type: lesson.type, route: stableLessonRoute(course, lesson), finalStatus: 'blocked', blocker: sanitizeText(error.stack || error.message) });
      }
      await checkpoint(audit);
    }

    const donePresentation = new Set(audit.presentations.map(item => `${item.courseId}|${item.lessonId}`));
    let presentationIndex = 0;
    for (const { course, lesson } of presentationInventory.slice(0, LIMIT)) {
      presentationIndex += 1;
      if (donePresentation.has(`${course.id}|${lesson.id}`)) continue;
      console.log(`[PPT ${presentationIndex}/${presentationInventory.length}] ${course.name} — ${lesson.title}`);
      try { audit.presentations.push(await auditPresentation(course, lesson)); }
      catch (error) {
        audit.presentations.push({ courseId: course.id, courseName: course.name, lessonId: lesson.id, lessonTitle: lesson.title, type: lesson.type, route: stableLessonRoute(course, lesson), finalStatus: 'blocked', blocker: sanitizeText(error.stack || error.message) });
      }
      await checkpoint(audit);
    }

    if (!audit.admin) {
      console.log('[admin] verificando superficies de solo lectura');
      try { audit.admin = await auditAdmin(); }
      catch (error) { audit.admin = { route: '/admin/', finalStatus: 'blocked', blocker: sanitizeText(error.stack || error.message) }; }
      await checkpoint(audit);
    }
    if (!audit.edit) {
      console.log('[edit] verificando con estado local simulado de solo lectura');
      try { audit.edit = await auditEdit(); }
      catch (error) { audit.edit = { route: '/edit/', finalStatus: 'blocked', blocker: sanitizeText(error.stack || error.message) }; }
      await checkpoint(audit);
    }
  }

  audit.completedAt = new Date().toISOString();
  audit.summary = makeSummary(audit);
  if (!SMOKE) {
    await checkpoint(audit);
    await fs.writeFile(OUTPUT_MD, markdownReport(audit), 'utf8');
  }
  console.log(JSON.stringify(audit.summary, null, 2));
}

if (process.argv.includes('--dump-catalog-scan')) {
  console.log(commonScan(catalogExtra));
} else {
  try {
    await main();
  } finally {
    runAgent(['close', '--json'], { allowFailure: true, timeout: 30_000 });
  }
}
