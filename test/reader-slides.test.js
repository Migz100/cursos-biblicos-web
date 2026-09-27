const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'reader.js'), 'utf8');
function sourceBetween(first, next) {
  const start = source.indexOf(first);
  const end = source.indexOf(next, start);
  assert.ok(start >= 0 && end > start, `missing reader functions: ${first}`);
  return source.slice(start, end);
}

const renderer = sourceBetween('function loadingElement(', 'function cancelRenderTasks(')
  + sourceBetween('function isPresentation(', 'async function loadPdf(');

function reader({ width = 390, height = 600, dimensions = [[600, 900], [1600, 900], [600, 900], [600, 900]], presentation = false } = {}) {
  const padding = { paddingLeft: '12px', paddingRight: '12px', paddingTop: '12px', paddingBottom: '24px' };
  const classes = new Set(presentation ? ['is-fullscreen'] : []);
  const events = [], frames = new Map(), observers = [];
  const calls = { scroll: [], render: 0, trim: 0 };
  let nextFrame = 0, deferred;
  const area = {
    clientWidth: width, clientHeight: height, scrollTop: 0, scrollLeft: 0, dataset: {},
    getBoundingClientRect() { return { top: 100, bottom: 100 + this.clientHeight, height: this.clientHeight }; },
    scrollTo(options) { calls.scroll.push(options); this.scrollTop = options.top; this.scrollLeft = options.left; }
  };
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.hidden = false; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    replaceChildren(fragment) { this.children = fragment.tag === 'fragment' ? [...fragment.children] : [fragment]; }
    querySelectorAll(selector) { return selector === '.pg' ? this.children.filter(child => child.className === 'pg') : []; }
    getBoundingClientRect() {
      if (this.hidden) return { top: 0, bottom: 0, width: 0, height: 0 };
      const height = parseFloat(this.style.height), width = parseFloat(this.style.width);
      const visible = box.children.filter(child => !child.hidden);
      const before = visible.slice(0, visible.indexOf(this));
      const offset = classes.has('is-fullscreen')
        ? Math.max(0, (area.clientHeight - 36 - height) / 2)
        : before.reduce((total, child) => total + parseFloat(child.style.height) + 18, 0);
      const top = area.getBoundingClientRect().top + 12 + offset - area.scrollTop;
      return { top, bottom: top + height, width, height };
    }
  }
  const box = new Element('div'), hint = new Element('p');
  Object.defineProperty(area, 'scrollHeight', {
    get: () => box.children.filter(child => !child.hidden).reduce((total, child) => total + parseFloat(child.style.height) + 18, 36)
  });
  const document = {
    createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    getElementById: id => ({ pdfArea: area, pdfBox: box, scrollHint: hint })[id],
    querySelectorAll: selector => box.querySelectorAll(selector),
    querySelector(selector) {
      if (selector === '.reader') return { classList: { contains: name => classes.has(name) } };
      if (selector === '.pg') return box.children[0] || null;
      if (selector === '.pg:last-child') return box.children.at(-1) || null;
      const number = selector.match(/^\.pg\[data-page-number="(\d+)"\]$/)?.[1];
      return box.children.find(page => page.dataset.pageNumber === number) || null;
    }
  };
  const pdfPages = dimensions.map(([width, height]) => ({
    rotate: 0,
    getViewport({ scale, rotation }) { return rotation % 180 ? { width: height * scale, height: width * scale } : { width: width * scale, height: height * scale }; }
  }));
  const context = vm.createContext({
    document, window: { dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    getComputedStyle: () => padding,
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
      observe(element) { this.targets.push(element); }
      disconnect() { this.disconnected = true; }
    },
    pdfDoc: {
      numPages: dimensions.length,
      getPage(number) {
        if (deferred?.remaining > 0) {
          deferred.remaining--;
          return new Promise(resolve => deferred.releases.push(() => resolve(pdfPages[number - 1])));
        }
        return Promise.resolve(pdfPages[number - 1]);
      }
    },
    pageNum: 1, pageRotations: {}, pageMetrics: [], renderSequence: 0, renderObserver: null,
    buildingStack: false, scrollFrame: null, lastAreaWidth: 0, lastAreaHeight: 0,
    setReaderLabel(element, es, _en, attribute = 'textContent') {
      if (attribute === 'textContent') element.textContent = es;
      else element.setAttribute(attribute, es);
    },
    cancelRenderTasks() {}, updateAnswerHint() {},
    trimDistantPages() { calls.trim++; }, renderNearbyPages() { calls.render++; },
    renderPageElement: async () => {}
  });
  vm.runInContext(renderer, context);
  return {
    context, area, box, events, frames, observers, calls, hint,
    setPresentation(value) { if (value) classes.add('is-fullscreen'); else classes.delete('is-fullscreen'); },
    visiblePages() { return box.children.filter(page => !page.hidden).map(page => Number(page.dataset.pageNumber)); },
    flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
    deferBuild() {
      const pending = { remaining: dimensions.length, releases: [] };
      deferred = pending;
      return () => pending.releases.splice(0).forEach(release => release());
    }
  };
}

test('presentation shows one chosen page and clamps page or internal-link destinations', async () => {
  const view = reader({ presentation: true });
  view.context.pageNum = 3;
  await view.context.buildPageStack();
  assert.equal(view.context.isPresentation(), true);
  assert.deepEqual(view.visiblePages(), [3]);
  assert.equal(view.hint.hidden, true);
  for (const [destination, expected] of [[0, 1], [99, 4], [2, 2]]) {
    view.context.scrollToPage(destination);
    assert.equal(view.context.pageNum, expected);
    assert.deepEqual(view.visiblePages(), [expected]);
    assert.equal(view.events.at(-1).detail.page, expected);
  }
  assert.equal(view.calls.scroll.length, 0, 'slide destinations do not start continuous scrolling');
  assert.ok(view.calls.render > 0 && view.calls.trim > 0, 'page changes retain lazy-render maintenance');
});

test('a queued reader scroll cannot move the chosen slide back to page one', async () => {
  const view = reader();
  await view.context.buildPageStack();
  assert.equal(view.frames.size, 1);
  view.context.pageNum = 3;
  view.setPresentation(true);
  view.context.showPresentationPage();
  view.flushFrames();
  assert.equal(view.context.pageNum, 3);
  assert.deepEqual(view.visiblePages(), [3]);
  view.context.scheduleCurrentPageUpdate();
  assert.equal(view.frames.size, 0);
});

test('portrait pages and landscape slides fit both dimensions in either phone orientation', async () => {
  for (const [width, height] of [[390, 600], [844, 300]]) {
    const view = reader({ width, height, presentation: true });
    await view.context.buildPageStack();
    for (const metric of view.context.pageMetrics) {
      assert.ok(metric.width <= width - 24 + 1e-8);
      assert.ok(metric.height <= height - 36 + 1e-8);
      assert.ok(Math.abs(metric.width - (width - 24)) < 1e-8 || Math.abs(metric.height - (height - 36)) < 1e-8,
        'the page uses all of one available dimension without cropping the other');
      const element = view.box.children[metric.number - 1];
      assert.equal(parseFloat(element.style.width), metric.width);
      assert.equal(parseFloat(element.style.height), metric.height);
    }
  }
});

test('navigation during a deferred PDF rebuild keeps the latest requested slide', async () => {
  const view = reader({ presentation: true });
  await view.context.buildPageStack();
  const release = view.deferBuild();
  const pending = view.context.buildPageStack({ preservePage: true });
  view.context.scrollToPage(3);
  release();
  await pending;
  assert.equal(view.context.pageNum, 3);
  assert.deepEqual(view.visiblePages(), [3]);
  assert.equal(view.events.at(-1).detail.page, 3);
  assert.equal(view.context.buildingStack, false);
});

test('an old presentation rebuild cannot overwrite a newer continuous-reader rebuild', async () => {
  const view = reader({ presentation: true });
  view.context.pageNum = 3;
  await view.context.buildPageStack();
  const release = view.deferBuild();
  const stale = view.context.buildPageStack({ preservePage: true });
  view.setPresentation(false);
  await view.context.buildPageStack({ preservePage: true, preserveOffset: false });
  const currentPages = [...view.box.children], currentMetrics = view.context.pageMetrics;
  release();
  await stale;
  assert.deepEqual(view.box.children, currentPages);
  assert.equal(view.context.pageMetrics, currentMetrics);
  assert.deepEqual(view.visiblePages(), [1, 2, 3, 4]);
  assert.equal(view.context.pageNum, 3);
  assert.equal(view.context.buildingStack, false);
  assert.equal(view.events.at(-1).detail.presentation, false);
});

test('exiting presentation restores all pages and anchors continuous reading at the chosen page', async () => {
  const view = reader({ presentation: true });
  await view.context.buildPageStack();
  view.context.scrollToPage(3);
  view.setPresentation(false);
  await view.context.buildPageStack({ preservePage: true, preserveOffset: false });
  assert.deepEqual(view.visiblePages(), [1, 2, 3, 4]);
  const page = view.box.children[2];
  assert.equal(page.getBoundingClientRect().top - view.area.getBoundingClientRect().top, 8);
  assert.equal(parseFloat(page.style.width), view.area.clientWidth - 24);
  assert.equal(view.hint.hidden, false);
  assert.equal(view.observers.at(-1).targets.length, 4);
  view.flushFrames();
  assert.equal(view.context.pageNum, 3);
});
