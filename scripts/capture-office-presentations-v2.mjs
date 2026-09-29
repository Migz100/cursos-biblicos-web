#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SITE = 'https://cursos-biblicos-web.vercel.app';
const DEFAULT_AUDIT_DIR = path.resolve('work/tmp/presentation-audit-v2');
const DEFAULT_SESSION = 'cursos-presentation-audit-v2';
const VIEWPORT = { width: 1600, height: 1000 };
const COUNTER_PATTERN = /SLIDE\s+(\d+)\s+OF\s+(\d+)/i;

function parseArgs(argv) {
  const options = {
    auditDir: DEFAULT_AUDIT_DIR,
    site: DEFAULT_SITE,
    session: DEFAULT_SESSION,
    probe: false,
    startDeck: 1,
    endDeck: 30,
    retries: 3
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--audit-dir') options.auditDir = path.resolve(argv[++index]);
    else if (arg === '--site') options.site = argv[++index];
    else if (arg === '--session') options.session = argv[++index];
    else if (arg === '--start-deck') options.startDeck = Number(argv[++index]);
    else if (arg === '--end-deck') options.endDeck = Number(argv[++index]);
    else if (arg === '--retries') options.retries = Number(argv[++index]);
    else if (arg === '--probe') options.probe = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^https:\/\//.test(options.site)) throw new Error('--site must be HTTPS');
  if (!Number.isInteger(options.startDeck) || !Number.isInteger(options.endDeck) || options.startDeck < 1 || options.endDeck > 30 || options.startDeck > options.endDeck) {
    throw new Error('--start-deck and --end-deck must select an ordered subset of 1..30');
  }
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizeText(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokenReconciliation(expected, actual) {
  const expectedTokens = new Set(normalizeText(expected).split(' ').filter(token => token.length >= 3));
  const actualTokens = new Set(normalizeText(actual).split(' ').filter(token => token.length >= 3));
  if (!expectedTokens.size) return { expectedTokenCount: 0, matchedTokenCount: 0, overlap: 1 };
  let matched = 0;
  for (const token of expectedTokens) if (actualTokens.has(token)) matched += 1;
  return { expectedTokenCount: expectedTokens.size, matchedTokenCount: matched, overlap: matched / expectedTokens.size };
}

function runAgentBrowser(session, args, { timeoutMs = 120000, allowFailure = false } = {}) {
  const executable = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'agent-browser', 'bin', 'agent-browser-win32-x64.exe')
    : 'agent-browser';
  const commandArgs = ['--session', session, '--idle-timeout', '0', ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, commandArgs, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      if (process.env.PRESENTATION_AUDIT_DEBUG === '1') {
        process.stderr.write(`[agent-browser ${args.join(' ')}] code=${code} stdout=${JSON.stringify(stdout.trim())} stderr=${JSON.stringify(stderr.trim())}\n`);
      }
      if (code !== 0 && !allowFailure) reject(new Error(`agent-browser ${args[0]} failed (${code}): ${stderr || stdout}`));
      else resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
    return this;
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
    return result.result.value;
  }

  close() {
    this.socket?.close();
  }
}

async function targets(baseUrl) {
  const response = await fetch(`${baseUrl}/json/list`);
  if (!response.ok) throw new Error(`CDP target list returned ${response.status}`);
  return response.json();
}

function cdpBase(cdpUrl) {
  const parsed = new URL(cdpUrl);
  return `http://${parsed.hostname}:${parsed.port}`;
}

async function waitForTargets(baseUrl, expectedAppUrl, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await targets(baseUrl);
    const top = current.find(item => item.type === 'page' && item.url === expectedAppUrl);
    const outer = top && current.find(item => item.type === 'iframe' && item.parentId === top.id && item.url.includes('view.officeapps.live.com/op/embed.aspx'));
    const office = outer && current.find(item => item.type === 'iframe' && item.parentId === outer.id && item.url.includes('PowerPointFrame.aspx'));
    if (top && outer && office) return { top, outer, office };
    await delay(500);
  }
  throw new Error('Timed out waiting for the nested Office viewer targets');
}

async function officeState(connection) {
  return connection.evaluate(`(() => {
    const bodyText = document.body ? document.body.innerText : '';
    const counterMatch = bodyText.match(/SLIDE\\s+(\\d+)\\s+OF\\s+(\\d+)/i);
    const visible = [...document.querySelectorAll('*')].filter(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    const counterElement = visible
      .filter(element => /SLIDE\\s+\\d+\\s+OF\\s+\\d+/i.test((element.innerText || '').trim()))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0] || null;
    const counterRect = counterElement ? counterElement.getBoundingClientRect() : null;
    const errors = visible
      .map(element => (element.innerText || '').trim())
      .filter(text => /couldn.t load|can.t display|sorry|error|content blocked|file wasn.t found/i.test(text));
    return {
      bodyText,
      counterText: counterMatch ? counterMatch[0] : '',
      displayedSlide: counterMatch ? Number(counterMatch[1]) : null,
      displayedTotal: counterMatch ? Number(counterMatch[2]) : null,
      counterRect: counterRect ? { x: counterRect.x, y: counterRect.y, width: counterRect.width, height: counterRect.height } : null,
      title: document.title,
      errors
    };
  })()`);
}

async function waitForOfficeSlide(connection, expectedSlide, expectedTotal, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await officeState(connection);
    if (last.displayedSlide === expectedSlide && last.displayedTotal === expectedTotal && !last.errors.length) {
      await delay(250);
      const stable = await officeState(connection);
      if (stable.displayedSlide === expectedSlide && stable.displayedTotal === expectedTotal && stable.bodyText === last.bodyText) return stable;
    }
    await delay(250);
  }
  throw new Error(`Office counter did not reach ${expectedSlide} of ${expectedTotal}; last was ${last?.counterText || '(unreadable)'}`);
}

async function advanceOfficeSlide(browser) {
  const connection = browser.officeConnection;
  const before = await officeState(connection);
  const target = await connection.evaluate(`(() => {
    const candidates = [...document.querySelectorAll('button,[role="button"],a,[aria-label],[title]')]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    const score = element => {
      const text = [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText, element.id, element.className]
        .filter(Boolean).join(' ').toLowerCase();
      if (/next slide|next|siguiente|forward/.test(text)) return 10;
      const rect = element.getBoundingClientRect();
      if (rect.bottom > innerHeight - 80 && rect.left > innerWidth / 2 && rect.width < 100) return 2;
      return 0;
    };
    const target = candidates.map(element => ({ element, score: score(element) })).sort((a, b) => b.score - a.score)[0];
    if (!target || target.score <= 0) return null;
    const rect = target.element.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    target.element.focus();
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      target.element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: type === 'mousedown' ? 1 : 0,
        clientX: x,
        clientY: y
      }));
    }
    return { x, y };
  })()`);
  if (target) {
    const syntheticDeadline = Date.now() + 2000;
    while (Date.now() < syntheticDeadline && !connection.closed) {
      const state = await officeState(connection);
      if (state.displayedSlide !== before.displayedSlide) return;
      await delay(100);
    }
    const frameOffset = await browser.topConnection.evaluate(`(() => {
      const frame = document.getElementById('presentationFrame');
      const rect = frame ? frame.getBoundingClientRect() : { x: 0, y: 0 };
      return { x: rect.x, y: rect.y };
    })()`);
    const x = frameOffset.x + target.x;
    const y = frameOffset.y + target.y;
    try {
      await browser.topConnection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await browser.topConnection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await browser.topConnection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    } catch (error) {
      if (!/CDP socket closed|WebSocket|socket/i.test(error.message)) throw error;
    }
  } else {
    await browser.topConnection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
    await browser.topConnection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
  }
}

async function captureTopPage(connection) {
  const result = await connection.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: false
  });
  return Buffer.from(result.data, 'base64');
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error('Screenshot is not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function probeExpression() {
  return `JSON.stringify([...document.querySelectorAll('*')]
    .filter(element => element.matches('button,[role="button"],input,a') || element.getAttribute('aria-label') || element.title)
    .map(element => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        id: element.id,
        className: typeof element.className === 'string' ? element.className : '',
        role: element.getAttribute('role'),
        ariaLabel: element.getAttribute('aria-label'),
        title: element.title,
        text: (element.innerText || element.value || '').trim(),
        outerHTML: element.outerHTML,
        onclickType: typeof element.onclick,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
    })
    .filter(item => item.rect.width > 0 && item.rect.height > 0), null, 2)`;
}

async function openDeck(options, record, structural) {
  const appUrl = new URL('/presentacion.html', options.site);
  appUrl.searchParams.set('c', record.courseId);
  appUrl.searchParams.set('l', record.lessonId);
  let openError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await runAgentBrowser(options.session, ['open', appUrl.href], { timeoutMs: 120000 });
      openError = null;
      break;
    } catch (error) {
      openError = error;
      await delay(500 * attempt);
    }
  }
  if (openError) throw openError;
  const cdp = await runAgentBrowser(options.session, ['get', 'cdp-url']);
  const baseUrl = cdpBase(cdp.stdout.trim());
  const targetSet = await waitForTargets(baseUrl, appUrl.href);
  const topConnection = await new CdpConnection(targetSet.top.webSocketDebuggerUrl).connect();
  const officeConnection = await new CdpConnection(targetSet.office.webSocketDebuggerUrl).connect();
  const state = await waitForOfficeSlide(officeConnection, 1, structural.slideCount, 90000);
  return { appUrl: appUrl.href, baseUrl, targetSet, topConnection, officeConnection, initialState: state };
}

async function reconnectOffice(browser, expectedSlide, expectedTotal, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  browser.officeConnection?.close();
  while (Date.now() < deadline) {
    try {
      const targetSet = await waitForTargets(browser.baseUrl, browser.appUrl, 5000);
      const connection = await new CdpConnection(targetSet.office.webSocketDebuggerUrl).connect();
      try {
        const state = await waitForOfficeSlide(connection, expectedSlide, expectedTotal, 5000);
        browser.targetSet = targetSet;
        browser.officeConnection = connection;
        return state;
      } catch (error) {
        lastError = error;
        connection.close();
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Could not reconnect to Office at slide ${expectedSlide}: ${lastError?.message || 'unknown error'}`);
}

async function waitForBrowserOfficeSlide(browser, expectedSlide, expectedTotal, timeoutMs = 30000) {
  try {
    return await waitForOfficeSlide(browser.officeConnection, expectedSlide, expectedTotal, timeoutMs);
  } catch (error) {
    if (!browser.officeConnection?.closed && !/CDP socket closed|WebSocket|socket/i.test(error.message)) throw error;
    return reconnectOffice(browser, expectedSlide, expectedTotal, timeoutMs);
  }
}

async function captureDeck(options, record) {
  const structuralPath = path.join(options.auditDir, record.structuralPath);
  const structural = JSON.parse(await readFile(structuralPath, 'utf8'));
  const deckPrefix = String(record.ordinal).padStart(2, '0');
  const screenshotDir = path.join(options.auditDir, 'office-screenshots', deckPrefix);
  const metadataDir = path.join(options.auditDir, 'office-metadata');
  await Promise.all([mkdir(screenshotDir, { recursive: true }), mkdir(metadataDir, { recursive: true })]);

  let browser;
  try {
    browser = await openDeck(options, record, structural);
    if (options.probe) {
      const probe = await browser.officeConnection.evaluate(probeExpression());
      const remote = await browser.officeConnection.send('Runtime.evaluate', {
        expression: 'document.getElementById("ButtonFastFwd-Small14")',
        returnByValue: false
      });
      const listeners = remote.result.objectId
        ? await browser.officeConnection.send('DOMDebugger.getEventListeners', { objectId: remote.result.objectId })
        : { listeners: [] };
      process.stdout.write(`${JSON.stringify(browser.initialState, null, 2)}\n${probe}\n${JSON.stringify({ listeners: listeners.listeners.map(listener => ({ type: listener.type, useCapture: listener.useCapture, passive: listener.passive, once: listener.once, handler: listener.handler?.description || '' })) }, null, 2)}\n`);
      return { probe: true };
    }

    const slides = [];
    const seenHashes = new Map();
    for (const expected of structural.slides) {
      let accepted = null;
      let lastError = null;
      for (let attempt = 1; attempt <= options.retries && !accepted; attempt += 1) {
        try {
          const before = await waitForBrowserOfficeSlide(browser, expected.slideNumber, structural.slideCount);
          if (!before.counterRect || before.counterRect.width <= 0 || before.counterRect.height <= 0) {
            throw new Error('Visible Office counter element could not be located');
          }
          const screenshot = await captureTopPage(browser.topConnection);
          const after = await officeState(browser.officeConnection);
          if (after.displayedSlide !== expected.slideNumber || after.displayedTotal !== structural.slideCount || before.counterText !== after.counterText) {
            throw new Error(`Counter changed during capture: ${before.counterText} -> ${after.counterText}`);
          }
          const dimensions = pngDimensions(screenshot);
          if (dimensions.width !== VIEWPORT.width || dimensions.height !== VIEWPORT.height) {
            throw new Error(`Unexpected screenshot size ${dimensions.width}x${dimensions.height}`);
          }
          const screenshotHash = sha256(screenshot);
          if (seenHashes.has(screenshotHash)) {
            throw new Error(`Duplicate screenshot content with slide ${seenHashes.get(screenshotHash)}`);
          }
          const reconciliation = tokenReconciliation(expected.normalizedText, before.bodyText);
          if (reconciliation.expectedTokenCount >= 3 && reconciliation.overlap < 0.8) {
            throw new Error(`Office/OOXML token overlap ${reconciliation.overlap.toFixed(3)} is below 0.8`);
          }
          const filename = `slide-${String(expected.slideNumber).padStart(3, '0')}.png`;
          const screenshotPath = path.join(screenshotDir, filename);
          await writeFile(screenshotPath, screenshot);
          seenHashes.set(screenshotHash, expected.slideNumber);
          accepted = {
            slideNumber: expected.slideNumber,
            expectedSlide: expected.slideNumber,
            displayedSlide: before.displayedSlide,
            displayedTotal: before.displayedTotal,
            counterText: before.counterText,
            counterRect: before.counterRect,
            screenshotPath: path.relative(options.auditDir, screenshotPath).replace(/\\/g, '/'),
            screenshotSha256: screenshotHash,
            screenshotBytes: screenshot.length,
            screenshotDimensions: dimensions,
            expectedTitle: expected.expectedTitle,
            expectedTextSha256: expected.expectedTextSha256,
            expectedTextExcerpt: expected.expectedText.slice(0, 8),
            officeAccessibleTextSha256: sha256(normalizeText(before.bodyText)),
            officeAccessibleTextExcerpt: before.bodyText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 14),
            tokenReconciliation: reconciliation,
            officeErrors: before.errors,
            attempt,
            captureStatus: 'accepted'
          };
        } catch (error) {
          lastError = error;
          await delay(500 * attempt);
        }
      }
      if (!accepted) throw new Error(`${deckPrefix} slide ${expected.slideNumber}: ${lastError?.message || 'capture rejected'}`);
      slides.push(accepted);
      if (expected.slideNumber < structural.slideCount) {
        await advanceOfficeSlide(browser);
        await waitForBrowserOfficeSlide(browser, expected.slideNumber + 1, structural.slideCount);
      }
    }

    const deckEvidence = {
      schemaVersion: 2,
      capturedAt: new Date().toISOString(),
      ordinal: record.ordinal,
      courseId: record.courseId,
      lessonId: record.lessonId,
      title: record.title,
      type: record.type,
      appUrl: browser.appUrl,
      viewerUrl: record.presentationApi.payload.viewerUrl,
      expectedSlideCount: structural.slideCount,
      capturedSlideCount: slides.length,
      everyCounterMachineRead: slides.every(slide => slide.expectedSlide === slide.displayedSlide && slide.displayedTotal === structural.slideCount),
      everyScreenshotUnique: new Set(slides.map(slide => slide.screenshotSha256)).size === slides.length,
      everyOoxmlTextReconciled: slides.every(slide => slide.tokenReconciliation.overlap >= 0.8 || slide.tokenReconciliation.expectedTokenCount < 3),
      slides
    };
    const evidencePath = path.join(metadataDir, `${deckPrefix}-office-captures.json`);
    await writeFile(evidencePath, JSON.stringify(deckEvidence, null, 2));
    process.stdout.write(`${deckPrefix}/30 ${record.title}: accepted ${slides.length}/${structural.slideCount} Office-numbered screenshots\n`);
    return deckEvidence;
  } finally {
    browser?.topConnection?.close();
    browser?.officeConnection?.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const index = JSON.parse(await readFile(path.join(options.auditDir, 'structural-index.json'), 'utf8'));
  if (index.presentationCount !== 30 || index.slideCount !== 570) throw new Error('Structural index must contain exactly 30 presentations and 570 slides');
  await runAgentBrowser(options.session, ['set', 'viewport', String(VIEWPORT.width), String(VIEWPORT.height)]);
  const selected = index.records.filter(record => record.ordinal >= options.startDeck && record.ordinal <= options.endDeck);
  const results = [];
  try {
    for (const record of selected) {
      results.push(await captureDeck(options, record));
      if (options.probe) break;
    }
  } finally {
    if (!options.probe) await runAgentBrowser(options.session, ['close'], { allowFailure: true, timeoutMs: 30000 });
  }
  if (!options.probe) {
    const summary = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      range: { startDeck: options.startDeck, endDeck: options.endDeck },
      presentationCount: results.length,
      slideCount: results.reduce((sum, deck) => sum + deck.slides.length, 0),
      allCountersMachineRead: results.every(deck => deck.everyCounterMachineRead),
      allScreenshotsUniqueWithinDeck: results.every(deck => deck.everyScreenshotUnique),
      allOoxmlTextReconciled: results.every(deck => deck.everyOoxmlTextReconciled),
      decks: results.map(deck => ({
        ordinal: deck.ordinal,
        title: deck.title,
        expectedSlideCount: deck.expectedSlideCount,
        capturedSlideCount: deck.capturedSlideCount,
        everyCounterMachineRead: deck.everyCounterMachineRead,
        everyScreenshotUnique: deck.everyScreenshotUnique,
        everyOoxmlTextReconciled: deck.everyOoxmlTextReconciled
      }))
    };
    await writeFile(path.join(options.auditDir, 'office-capture-summary.json'), JSON.stringify(summary, null, 2));
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
