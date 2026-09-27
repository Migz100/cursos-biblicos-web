const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browser(mode = 'unavailable') {
  const calls = { enter: 0, exit: 0, requests: [], viewChanges: 0 };
  class Element {
    constructor(tagName = 'DIV') {
      this.listeners = {};
      this.listenerOptions = {};
      this.attributes = {};
      this.tagName = tagName;
      this.hidden = this.disabled = false;
      const classes = new Set();
      this.classList = {
        add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
        toggle(name, force) { const next = force === undefined ? !classes.has(name) : Boolean(force); if (next) classes.add(name); else classes.delete(name); return next; }
      };
    }
    addEventListener(type, handler, options) { (this.listeners[type] ||= []).push(handler); this.listenerOptions[type] = options; }
    dispatchEvent(event) { for (const handler of this.listeners[event.type] || []) handler(event); return !event.defaultPrevented; }
    async emit(type, detail = {}) {
      const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...detail };
      for (const handler of this.listeners[type] || []) await handler(event);
      return event;
    }
    click() { return this.disabled ? Promise.resolve() : this.emit('click'); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    focus(options) { document.activeElement = this; this.focusOptions = options; }
    closest() {
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(this.tagName) || this.isContentEditable || this.attributes.role === 'button' || this.attributes['data-answer-id'] || this.classList.contains('answerTapTarget')) return this;
      return this.parentElement?.closest() || null;
    }
  }
  const reader = new Element(), enter = new Element('BUTTON'), exit = new Element('BUTTON'), bar = new Element();
  const slideControls = new Element(), previousSlide = new Element('BUTTON'), nextSlide = new Element('BUTTON'), slideCount = new Element('SPAN');
  const pdfArea = Object.assign(new Element('MAIN'), { scrollTop: 740, scrollLeft: 18 }), pdfBox = { children: [{ page: 1, answer: 'Respuesta guardada' }] };
  const document = new Element();
  document.documentElement = new Element();
  document.body = new Element();
  document.activeElement = enter;
  document.fullscreenElement = null;
  document.openModal = null;
  document.fullscreenEnabled = !['unavailable', 'disabled'].includes(mode);
  bar.hidden = slideControls.hidden = true;
  const byId = { fullScreen: enter, exitFullScreen: exit, pdfArea, pdfBox, previousSlide, nextSlide, slideCount };
  document.getElementById = id => byId[id] || null;
  document.querySelector = selector => ({ '.reader': reader, '.readerFullScreenBar': bar, '.readerSlideControls': slideControls, '#fullScreen': enter, '#exitFullScreen': exit, '#pdfArea': pdfArea, '#pdfBox': pdfBox, 'dialog[open], .verseModal:not([hidden])': document.openModal })[selector] || null;
  reader.querySelector = document.querySelector;
  let completeNative;
  if (mode !== 'unavailable') {
    document.documentElement.requestFullscreen = async () => {
      calls.enter++;
      if (mode === 'rejected') throw new Error('Fullscreen permission denied');
      if (mode === 'pending') await new Promise(resolve => { completeNative = resolve; });
      document.fullscreenElement = document.documentElement;
      await document.emit('fullscreenchange');
    };
    document.exitFullscreen = async () => {
      calls.exit++;
      document.fullscreenElement = null;
      await document.emit('fullscreenchange');
    };
  }
  const window = new Element();
  window.document = document;
  window.visualViewport = { scale: 1 };
  window.requestAnimationFrame = callback => callback();
  window.addEventListener('reader-page-request', event => calls.requests.push(JSON.parse(JSON.stringify(event.detail))));
  window.addEventListener('reader-view-change', () => calls.viewChanges++);
  const source = fs.readFileSync(path.join(__dirname, '..', 'reader-fullscreen.js'), 'utf8');
  vm.runInNewContext(source, { document, window, Event, CustomEvent, requestAnimationFrame: window.requestAnimationFrame });
  return {
    reader, enter, exit, bar, slideControls, previousSlide, nextSlide, slideCount, document, window, calls, pdfArea, pdfBox, Element,
    finishNative() { completeNative(); },
    page(page, total = 5) { return window.emit('reader-page-change', { detail: { page, total, presentation: reader.classList.contains('is-fullscreen') } }); },
    key(key, detail = {}) { return document.emit('keydown', { key, ...detail }); },
    async swipe(dx, dy = 0, target = pdfArea) {
      await pdfArea.emit('touchstart', { target, touches: [{ identifier: 1, clientX: 150, clientY: 150 }] });
      return pdfArea.emit('touchend', { target, touches: [], changedTouches: [{ identifier: 1, clientX: 150 + dx, clientY: 150 + dy }] });
    },
    async escape() { await document.emit('keydown', { key: 'Escape' }); await window.emit('keydown', { key: 'Escape' }); }
  };
}

function assertActive(view) {
  assert.equal(view.reader.classList.contains('is-fullscreen'), true);
  assert.equal(view.bar.hidden, false);
  assert.equal(view.slideControls.hidden, false);
  assert.equal(view.enter.getAttribute('aria-pressed'), 'true');
  assert.ok(view.document.activeElement === view.pdfArea);
  assert.equal(view.pdfArea.focusOptions.preventScroll, true);
}

function assertInactive(view) {
  assert.equal(view.reader.classList.contains('is-fullscreen'), false);
  assert.equal(view.bar.hidden, true);
  assert.equal(view.slideControls.hidden, true);
  assert.equal(view.enter.getAttribute('aria-pressed'), 'false');
  assert.ok(view.document.activeElement === view.enter);
  assert.equal(view.enter.focusOptions.preventScroll, true);
}

test('native fullscreen enters on the document and exit restores the reader controls and focus', async () => {
  const view = browser('native');
  await view.enter.click();
  assert.equal(view.calls.enter, 1);
  assert.ok(view.document.fullscreenElement === view.document.documentElement);
  assertActive(view);
  await view.exit.click();
  assert.equal(view.calls.exit, 1);
  assert.equal(view.document.fullscreenElement, null);
  assertInactive(view);
});

test('unavailable or disabled native fullscreen uses the same accessible in-page reader mode', async () => {
  for (const mode of ['unavailable', 'disabled']) {
    const view = browser(mode);
    await view.enter.click();
    assert.equal(view.calls.enter, 0);
    assertActive(view);
    await view.exit.click();
    assert.equal(view.calls.exit, 0);
    assertInactive(view);
  }
});

test('a rejected native request still opens in-page fullscreen and can exit normally', async () => {
  const view = browser('rejected');
  await view.enter.click();
  assert.equal(view.calls.enter, 1);
  assertActive(view);
  await view.exit.click();
  assertInactive(view);
});

test('Escape exits fallback fullscreen without requiring native browser support', async () => {
  const view = browser();
  await view.enter.click();
  await view.escape();
  assertInactive(view);
});

test('Escape reserved by the Bible dialog does not close fullscreen', async () => {
  const view = browser();
  await view.enter.click();
  view.document.openModal = {};
  await view.escape();
  assertActive(view);
  view.document.openModal = null;
  await view.document.emit('keydown', { key: 'Escape', defaultPrevented: true });
  assertActive(view);
  await view.escape();
  assertInactive(view);
});

test('an external native fullscreen exit restores the normal reader state', async () => {
  const view = browser('native');
  await view.enter.click();
  view.document.fullscreenElement = null;
  await view.document.emit('fullscreenchange');
  assertInactive(view);
});

test('repeated clicks while native entry is pending request fullscreen only once', async () => {
  const view = browser('pending');
  const first = view.enter.click();
  assert.equal(view.calls.enter, 1);
  await view.enter.click();
  assert.equal(view.calls.enter, 1);
  view.finishNative();
  await first;
  assertActive(view);
});

test('fullscreen leaves existing PDF nodes, answers and scroll offsets intact', async () => {
  const view = browser();
  const page = view.pdfBox.children[0];
  await view.enter.click();
  await view.exit.click();
  assert.ok(view.document.getElementById('pdfArea') === view.pdfArea);
  assert.ok(view.pdfBox.children[0] === page);
  assert.equal(page.answer, 'Respuesta guardada');
  assert.equal(view.pdfArea.scrollTop, 740);
  assert.equal(view.pdfArea.scrollLeft, 18);
});

test('slide counter and arrow endpoints follow renderer state without changing lessons', async () => {
  const view = browser();
  await view.page(1, 3);
  await view.enter.click();
  assert.equal(view.slideCount.textContent, '1 de 3');
  assert.equal(view.previousSlide.disabled, true);
  assert.equal(view.nextSlide.disabled, false);
  await view.previousSlide.click();
  await view.nextSlide.click();
  assert.deepEqual(view.calls.requests, [{ delta: 1 }]);
  await view.page(3, 3);
  assert.equal(view.slideCount.textContent, '3 de 3');
  assert.equal(view.previousSlide.disabled, false);
  assert.equal(view.nextSlide.disabled, true);
  await view.nextSlide.click();
  await view.previousSlide.click();
  assert.deepEqual(view.calls.requests, [{ delta: 1 }, { delta: -1 }]);
  await view.exit.click();
  await view.previousSlide.click();
  assert.equal(view.calls.requests.length, 2);
  assert.equal(view.calls.viewChanges, 2);
  await view.enter.click();
  assert.equal(view.slideCount.textContent, '3 de 3');
});

test('single-page lessons disable both navigation arrows', async () => {
  const view = browser();
  await view.page(1, 1);
  await view.enter.click();
  await view.nextSlide.click();
  await view.previousSlide.click();
  await view.key('ArrowRight');
  await view.key('Home');
  assert.equal(view.previousSlide.disabled, true);
  assert.equal(view.nextSlide.disabled, true);
  assert.deepEqual(view.calls.requests, []);
});

test('fullscreen keyboard navigates slides with arrows, page keys, space, Home and End', async () => {
  const view = browser();
  await view.page(3, 7);
  await view.enter.click();
  const keys = ['ArrowLeft', 'PageUp', 'ArrowRight', 'PageDown', ' ', 'Home', 'End'];
  for (const key of keys) assert.equal((await view.key(key)).defaultPrevented, true);
  assert.deepEqual(view.calls.requests, [{ delta: -1 }, { delta: -1 }, { delta: 1 }, { delta: 1 }, { delta: 1 }, { page: 1 }, { page: 7 }]);
  await view.page(1, 7);
  await view.key('ArrowLeft');
  await view.page(7, 7);
  await view.key('ArrowRight');
  assert.equal(view.calls.requests.length, keys.length);
});

test('normal reading and modified or consumed keyboard events do not navigate slides', async () => {
  const view = browser();
  await view.page(2, 3);
  assert.equal((await view.key('ArrowRight')).defaultPrevented, false);
  await view.enter.click();
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    assert.equal((await view.key('ArrowRight', { [modifier]: true })).defaultPrevented, false);
  }
  await view.key('ArrowRight', { defaultPrevented: true });
  assert.equal((await view.key('Tab')).defaultPrevented, false);
  assert.deepEqual(view.calls.requests, []);
});

test('keyboard leaves form fields, links, buttons and editable answers alone', async () => {
  const view = browser();
  await view.page(2, 3);
  await view.enter.click();
  const editable = Object.assign(new view.Element(), { isContentEditable: true });
  const answer = new view.Element('LABEL');
  answer.classList.add('answerTapTarget');
  const targets = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].map(tag => new view.Element(tag)).concat([editable, answer]);
  for (const target of targets) {
    target.focus();
    assert.equal((await view.key('ArrowRight')).defaultPrevented, false);
    view.pdfArea.focus();
    const child = Object.assign(new view.Element('SPAN'), { parentElement: target });
    assert.equal((await view.key('ArrowRight', { target: child })).defaultPrevented, false);
  }
  assert.deepEqual(view.calls.requests, []);
});

test('an open dialog preserves Escape and ignores slide keys, buttons and swipes', async () => {
  const view = browser();
  await view.page(2, 3);
  await view.enter.click();
  view.document.openModal = {};
  await view.key('ArrowRight');
  await view.key('Escape');
  await view.nextSlide.click();
  await view.swipe(-90);
  assertActive(view);
  assert.deepEqual(view.calls.requests, []);
});

test('single-finger horizontal swipes navigate one slide and keep native touch handling', async () => {
  const view = browser();
  await view.page(2, 3);
  await view.enter.click();
  assert.equal((await view.swipe(-80, 10)).defaultPrevented, false);
  assert.equal((await view.swipe(80, -10)).defaultPrevented, false);
  assert.deepEqual(view.calls.requests, [{ delta: 1 }, { delta: -1 }]);
  for (const event of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) assert.equal(view.pdfArea.listenerOptions[event].passive, true);
});

test('short, vertical, diagonal and interactive swipes do not change slides', async () => {
  const view = browser();
  await view.page(2, 3);
  await view.enter.click();
  await view.swipe(-49);
  await view.swipe(-70, 90);
  await view.swipe(-70, 60);
  for (const tag of ['INPUT', 'TEXTAREA', 'BUTTON', 'A']) await view.swipe(-80, 0, new view.Element(tag));
  const answer = new view.Element('LABEL');
  answer.classList.add('answerTapTarget');
  await view.swipe(-80, 0, answer);
  await view.exit.click();
  await view.swipe(-80);
  assert.deepEqual(view.calls.requests, []);
});

test('pinch zoom, multiple touches and canceled touches never turn a slide', async () => {
  const view = browser();
  await view.page(2, 3);
  await view.enter.click();
  const first = { identifier: 1, clientX: 180, clientY: 80 };
  const second = { identifier: 2, clientX: 250, clientY: 80 };
  const finish = () => view.pdfArea.emit('touchend', { touches: [], changedTouches: [{ ...first, clientX: 60 }] });
  view.window.visualViewport.scale = 2;
  await view.swipe(-120);
  view.window.visualViewport.scale = 1;
  await view.pdfArea.emit('touchstart', { touches: [first, second] });
  await finish();
  await view.pdfArea.emit('touchstart', { touches: [first] });
  await view.pdfArea.emit('touchmove', { touches: [first, second] });
  await finish();
  await view.pdfArea.emit('touchstart', { touches: [first] });
  await view.pdfArea.emit('touchcancel');
  await finish();
  await view.pdfArea.emit('touchstart', { touches: [first] });
  view.window.visualViewport.scale = 1.5;
  await finish();
  assert.deepEqual(view.calls.requests, []);
});

test('leaving fullscreen cancels a gesture and renderer updates keep the retained page', async () => {
  const view = browser();
  await view.page(4, 5);
  await view.enter.click();
  await view.pdfArea.emit('touchstart', { touches: [{ identifier: 1, clientX: 180, clientY: 80 }] });
  await view.exit.click();
  await view.enter.click();
  await view.pdfArea.emit('touchend', { touches: [], changedTouches: [{ identifier: 1, clientX: 60, clientY: 80 }] });
  assert.deepEqual(view.calls.requests, []);
  assert.equal(view.slideCount.textContent, '4 de 5');
  assert.equal(view.calls.viewChanges, 3);
});
