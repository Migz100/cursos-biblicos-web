const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');

function load(storage, search = '', browser = {}) {
  const events = [];
  const handlers = {};
  // Minimal DOM for UI state transitions. Real browser checks cover layout and animation.
  class Element {
    constructor(tag) {
      this.tagName = tag.toLowerCase();
      this.children = [];
      this.attributes = {};
      this.listeners = {};
      this.hidden = this.disabled = this.open = false;
      this.style = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (['class', 'id', 'value'].includes(name)) this[name === 'class' ? 'className' : name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    removeAttribute(name) { delete this.attributes[name]; }
    get isConnected() { return this.tagName === 'document' || Boolean(this.parentElement?.isConnected); }
    matches(selector) {
      return selector.split(',').some(part => {
        part = part.trim();
        if (part.startsWith('.')) return (this.className || '').split(' ').includes(part.slice(1));
        if (part.startsWith('#')) return this.id === part.slice(1);
        const match = part.match(/^([\w-]+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
        return Boolean(match && (!match[1] || this.tagName === match[1]) && (!match[2] || (this.hasAttribute(match[2]) && (match[3] === undefined || this.getAttribute(match[2]) === match[3]))));
      });
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    async emit(type, detail = {}) { for (const handler of this.listeners[type] || []) await handler({ target: this, currentTarget: this, preventDefault() {}, ...detail }); }
    async click() {
      if (this.disabled) return;
      for (let current = this; current; current = current.parentElement) await current.emit('click', { target: this });
    }
    focus() { document.activeElement = this; }
    select() { this.selected = true; }
    showModal() { this.open = true; }
    close() { this.open = false; return this.emit('close'); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 400, bottom: 800 }; }
    set textContent(value) { this.children = []; this.text = String(value); }
    get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
    set innerHTML(html) {
      this.children = [];
      this.text = '';
      const stack = [this];
      for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
        if (token.startsWith('</')) { stack.pop(); continue; }
        if (token.startsWith('<')) {
          const tag = token.match(/^<([\w-]+)/)?.[1];
          if (!tag) continue;
          const element = new Element(tag);
          const attrs = token.slice(tag.length + 1, -1);
          for (const [, name, quoted, single, bare] of attrs.matchAll(/([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) element.setAttribute(name, quoted ?? single ?? bare ?? '');
          stack.at(-1).appendChild(element);
          if (!/^(input|img|br|hr|meta|link)$/.test(tag) && !token.endsWith('/>')) stack.push(element);
        } else {
          const text = new Element('#text');
          text.text = token;
          stack.at(-1).appendChild(text);
        }
      }
    }
  }
  const document = new Element('document');
  document.documentElement = new Element('html');
  document.body = new Element('body');
  document.appendChild(document.documentElement);
  document.documentElement.appendChild(document.body);
  document.createElement = tag => new Element(tag);
  const manifest = document.body.appendChild(new Element('link'));
  manifest.setAttribute('rel', 'manifest');
  const button = document.body.appendChild(new Element('button'));
  button.setAttribute('data-ui-install', '');
  button.setAttribute('data-ui-install-home', '');
  const window = {
    localStorage: storage, location: { search, href: `https://cursosbiblicos.app/index.html${search}` },
    navigator: browser.navigator || {}, matchMedia: () => ({ matches: Boolean(browser.standalone) }),
    dispatchEvent: event => events.push(event), addEventListener: (name, handler) => { handlers[name] = handler; },
    requestAnimationFrame: callback => callback()
  };
  const context = vm.createContext({ window, document, URLSearchParams, CustomEvent: class {
    constructor(type, options) { this.type = type; this.detail = options.detail; }
  } });
  vm.runInContext(source, context);
  return { ui: window.CourseUI, window, document, events, handlers, manifest, button };
}

test('interface language starts in Spanish even after an older English preference', () => {
  const stored = new Map();
  const storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const first = load(storage);
  assert.equal(first.ui.language, 'es');
  assert.equal(first.document.documentElement.lang, 'es');
  first.ui.setLanguage('en');
  assert.equal(first.ui.language, 'en');
  assert.equal(first.document.documentElement.lang, 'en');
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, 'course-language-change');
  assert.equal(first.events[0].detail.language, 'en');
  const nextPage = load(storage);
  assert.equal(nextPage.ui.language, 'es');
  assert.equal(nextPage.document.documentElement.lang, 'es');
});

test('blocked browser storage does not stop language changes', () => {
  const { ui, document, events } = load({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  assert.equal(ui.language, 'es');
  assert.doesNotThrow(() => ui.setLanguage('en'));
  assert.equal(ui.t('Compartir', 'Share'), 'Share');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(events.length, 1);
});

test('invalid preferences and repeated language choices are ignored', () => {
  let writes = 0;
  const { ui, events } = load({ getItem: () => 'invalid', setItem: () => writes++ });
  for (const value of ['fr', '', null, {}, 'es']) ui.setLanguage(value);
  assert.equal(ui.language, 'es');
  assert.equal(events.length, 0);
  assert.equal(writes, 0);
  ui.setLanguage('en');
  ui.setLanguage('en');
  assert.equal(events.length, 1);
  assert.equal(writes, 1);
});

test('interface translations retain literal content and interpolate supplied values', () => {
  const { ui } = load({ getItem: () => 'en' });
  ui.setLanguage('en');
  assert.equal(ui.t('{count} lecciones', '{count} lessons', { count: 3 }), '3 lessons');
  assert.equal(ui.t('Abrir {title}', 'Open {title}', { title: '<b>La Biblia</b>' }), 'Open <b>La Biblia</b>');
  assert.equal(ui.t('{missing}', '{missing}'), '{missing}');
});

test('installed shortcuts preserve collection scope and reject duplicate scopes', () => {
  const storage = { getItem: () => null };
  assert.equal(load(storage).manifest.href, '/api/manifest');
  assert.equal(load(storage, '?s=chosen&c=course').manifest.href, '/api/manifest?s=chosen');
  assert.equal(load(storage, '?s=').manifest.href, '/api/manifest?s=');
  assert.equal(load(storage, '?s=chosen&s=other').manifest.href, '/api/manifest?s=');
});

test('install uses the browser prompt and installed state hides the home button', async () => {
  const { handlers, button } = load({ getItem: () => null });
  let prompted = 0;
  let prevented = 0;
  handlers.beforeinstallprompt({
    preventDefault: () => prevented++, prompt: async () => prompted++, userChoice: Promise.resolve({ outcome: 'accepted' })
  });
  assert.equal(prevented, 1);
  await button.click();
  assert.equal(prompted, 1);
  assert.equal(button.disabled, true);
  handlers.appinstalled();
  assert.equal(button.hidden, true);
  assert.equal(button.textContent, 'App añadida');
  await button.click();
  assert.equal(prompted, 1);
});

const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 };
const ipad = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 };
const macSafari = { ...ipad, maxTouchPoints: 0 };
const android = { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', maxTouchPoints: 5 };

test('iPhone install opens a dedicated five-step guide, and closing it never claims installation', async () => {
  const { button, document } = load({ getItem: () => null }, '', { navigator: iphone });
  button.focus();
  await button.click();
  const guide = document.querySelector('.uiInstallGuide');
  assert.equal(guide.open, true);
  assert.equal(guide.getAttribute('data-platform'), 'ios-phone');
  assert.equal(guide.querySelectorAll('.uiInstallGuideStep').length, 5);
  assert.equal(document.querySelector('.uiOptionsDialog'), null);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  await guide.querySelector('.uiInstallGuideClose').click();
  assert.equal(guide.open, false);
  assert.ok(document.activeElement === button, 'closing the guide returns focus to the install button');
  await button.click();
  assert.equal(guide.open, true);
  assert.equal(document.querySelectorAll('.uiInstallGuide').length, 1);
  await guide.querySelector('.uiInstallGuideDone').click();
  assert.equal(guide.open, false);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Añadir a inicio (instrucciones)');
});

test('iPad desktop user-agent receives the tablet guide rather than desktop installation steps', async () => {
  const { button, document } = load({ getItem: () => null }, '', { navigator: ipad });
  await button.click();
  const guide = document.querySelector('.uiInstallGuide');
  assert.equal(guide.open, true);
  assert.equal(guide.getAttribute('data-platform'), 'ios-tablet');
  assert.equal(guide.querySelectorAll('.uiInstallGuideStep').length, 4);
});

test('every installation fallback contains complete visual steps with readable instructions', async () => {
  const browsers = [
    ['ios-phone', iphone],
    ['ios-tablet', ipad],
    ['ios-browser', { ...iphone, userAgent: `${iphone.userAgent} CriOS/140` }],
    ['ios-in-app', { ...iphone, userAgent: `${iphone.userAgent} Instagram 400.0` }],
    ['mac-safari', macSafari],
    ['android', android],
    ['desktop', {}]
  ];
  for (const [platform, navigator] of browsers) {
    const { button, document } = load({ getItem: () => null }, '', { navigator });
    await button.click();
    const guide = document.querySelector('.uiInstallGuide');
    assert.equal(guide.getAttribute('data-platform'), platform);
    const steps = guide.querySelectorAll('.uiInstallGuideStep');
    assert.equal(steps.length, platform === 'ios-phone' ? 5 : platform === 'ios-tablet' ? 4 : 3, platform);
    for (const [index, step] of steps.entries()) {
      const example = step.querySelector('.uiInstallExample');
      const photo = step.querySelector('.uiInstallPhoto');
      assert.ok(example || photo, `${platform} step ${index + 1} has an illustration or actual screenshot`);
      if (example) assert.match(example.textContent, /Ejemplo/, `${platform} labels its illustration as an example`);
      for (const screenshot of step.querySelectorAll('.uiInstallPhoto')) {
        assert.ok(screenshot.querySelector('figcaption').textContent.trim(), `${platform} explains the screenshot`);
        const source = screenshot.querySelector('img').getAttribute('src');
        assert.ok(fs.existsSync(path.join(__dirname, '..', source)), `${platform} screenshot asset exists`);
      }
      assert.ok(step.querySelector('h3').textContent.trim(), `${platform} has readable instructions beyond the illustration`);
    }
    if (platform === 'ios-phone' || platform === 'ios-tablet') assert.equal(guide.querySelector('[data-ui-install-platform]'), null, 'Safari on iOS opens only its own instructions');
  }
});

test('Safari guides show More as a visible numbered step before the home-screen choice', async () => {
  for (const navigator of [iphone, ipad]) {
    for (const nativeLanguage of ['es', 'en']) {
      const { button, document } = load({ getItem: () => null }, '', { navigator: { ...navigator, language: `${nativeLanguage}-US` } });
      await button.click();
      const guide = document.querySelector('.uiInstallGuide');
      const steps = guide.querySelectorAll('.uiInstallGuideStep');
      const tablet = guide.getAttribute('data-platform') === 'ios-tablet';
      assert.deepEqual(steps.map(step => step.querySelector('.uiInstallStepNumber').textContent.trim()), tablet ? ['1', '2', '3', '4'] : ['1', '2', '3', '4', '5']);
      assert.equal(Boolean(steps[0].querySelector('img[src="/assets/install-guide/safari-classic-toolbar.png"]')), !tablet);
      if (!tablet) {
        const toolbar = steps[0].querySelector('img[src="/assets/install-guide/safari-modern-toolbar.png"]');
        assert.ok(toolbar, 'the opening Safari menu step has its actual toolbar screenshot');
        assert.ok(!toolbar.closest('details') || toolbar.closest('details').hasAttribute('open'), 'the menu step is visible without expanding extra instructions');
      }
      const more = steps[tablet ? 1 : 2];
      const addHome = steps[tablet ? 2 : 3];
      assert.ok(addHome.querySelector(`img[src="/assets/install-guide/safari-menu-home-${nativeLanguage}.png"]`));
      const moreSource = tablet ? `safari-menu-more-${nativeLanguage}.png` : 'safari-phone-more-en.png';
      const screenshot = more.querySelector(`img[src="/assets/install-guide/${moreSource}"]`);
      assert.ok(screenshot, 'the More step uses the correct device screenshot');
      assert.equal(screenshot.closest('details'), null, 'the required More action is never collapsed');
      assert.equal(more.querySelector('.uiInstallStepNumber').textContent.trim(), tablet ? '2' : '3');
      assert.match(more.querySelector('h3').textContent, nativeLanguage === 'es' ? /Ver más/ : /View More/);
      assert.match(more.querySelector('p').textContent, nativeLanguage === 'es' ? /Más/ : /More/, 'the alternate native button label remains explained');
      assert.match(more.querySelector('p').textContent, nativeLanguage === 'es' ? /Agregar a Inicio/ : /Add to Home Screen/);
      assert.match(more.querySelector('p').textContent, tablet ? /paso 3/ : /paso 4/, 'users who already see Add to Home Screen skip to its actual step');
      if (!tablet) {
        const caption = screenshot.closest('figure').querySelector('figcaption').textContent;
        assert.match(caption, /View More/);
        if (nativeLanguage === 'es') assert.match(caption, /Ver más/);
        assert.equal(guide.querySelector('img[src="/assets/install-guide/safari-phone-more-es.png"]'), null, 'the authentic iPhone screenshot remains in its original language');
      }
      assert.match(addHome.querySelector('h3').textContent, nativeLanguage === 'es' ? /Toca Agregar a Inicio/ : /Toca Add to Home Screen/);
    }
  }
});

test('iPhone guides show the Safari menu, Share, View More, home-screen choice and confirmation in order', async () => {
  for (const nativeLanguage of ['es', 'en']) {
    const { button, document } = load({ getItem: () => null }, '', { navigator: { ...iphone, language: `${nativeLanguage}-US` } });
    await button.click();
    const guide = document.querySelector('.uiInstallGuide');
    const steps = guide.querySelectorAll('.uiInstallGuideStep');
    assert.deepEqual(steps.map(step => step.querySelector('.uiInstallStepNumber').textContent.trim()), ['1', '2', '3', '4', '5']);
    assert.match(steps[0].querySelector('h3').textContent, /menú.*Safari/i);
    assert.equal(steps[1].querySelector('h3').textContent, nativeLanguage === 'es' ? 'Toca Compartir en el menú' : 'Toca Share en el menú');
    assert.match(steps[2].querySelector('h3').textContent, nativeLanguage === 'es' ? /Ver más/ : /View More/);
    assert.equal(steps[3].querySelector('h3').textContent, nativeLanguage === 'es' ? 'Toca Agregar a Inicio' : 'Toca Add to Home Screen');
    assert.equal(steps[4].querySelector('h3').textContent, nativeLanguage === 'es' ? 'Toca Agregar' : 'Toca Add');
    assert.match(steps[1].querySelector('p').textContent, /paso 3/, 'classic Safari users can skip a menu they already passed');
    const screenshot = steps[1].querySelector('img[src="/assets/install-guide/safari-share-action-en.png"]');
    assert.ok(screenshot, 'the previously missing Share action uses the actual supplied screenshot');
    assert.ok(!screenshot.closest('details') || screenshot.closest('details').hasAttribute('open'), 'the Share action is visible without another expansion');
    const caption = screenshot.closest('figure').querySelector('figcaption').textContent;
    assert.match(caption, /Share/);
    if (nativeLanguage === 'es') assert.match(caption, /Compartir/, 'the authentic English screenshot is explained for Spanish device labels');
    assert.equal(guide.querySelector('img[src="/assets/install-guide/safari-share-action-es.png"]'), null, 'there is no fabricated translated screenshot');
  }
});

test('Safari screenshots load eagerly with intrinsic dimensions and a compact transfer budget', async () => {
  const assets = new Map();
  for (const navigator of [iphone, ipad]) {
    for (const language of ['es-US', 'en-US']) {
      const { button, document } = load({ getItem: () => null }, '', { navigator: { ...navigator, language } });
      await button.click();
      const screenshots = document.querySelector('.uiInstallGuide').querySelectorAll('img')
        .filter(image => image.getAttribute('src').startsWith('/assets/install-guide/'));
      assert.ok(screenshots.length >= 2, 'each Safari guide includes actual menu screenshots');
      for (const image of screenshots) {
        const source = image.getAttribute('src');
        assert.equal(image.getAttribute('loading'), 'eager', `${source} cannot depend on offscreen lazy-load detection`);
        const width = Number(image.getAttribute('width'));
        const height = Number(image.getAttribute('height'));
        assert.ok(Number.isInteger(width) && width > 0, `${source} reserves a positive width`);
        assert.ok(Number.isInteger(height) && height > 0, `${source} reserves a positive height`);
        const file = fs.readFileSync(path.join(__dirname, '..', source));
        assert.equal(file.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${source} is a PNG`);
        assert.equal(file.subarray(12, 16).toString('ascii'), 'IHDR');
        assert.equal(file.readUInt32BE(16), width, `${source} markup matches its actual crop width`);
        assert.equal(file.readUInt32BE(20), height, `${source} markup matches its actual crop height`);
        assert.ok(file.length < 60_000, `${source} stays below 60 KB for older phones`);
        assets.set(path.basename(source), file.length);
      }
    }
  }
  assert.deepEqual([...assets.keys()].sort(), [
    'safari-classic-toolbar.png', 'safari-modern-toolbar.png',
    'safari-menu-home-es.png', 'safari-menu-home-en.png',
    'safari-menu-more-es.png', 'safari-menu-more-en.png', 'safari-share-action-en.png', 'safari-phone-more-en.png'
  ].sort(), 'both native-language variants and both Safari toolbars remain available');
  assert.ok([...assets.values()].reduce((total, bytes) => total + bytes, 0) < 180_000,
    'all guide screenshots together stay below 180 KB');
});

test('desktop visitors can inspect phone and tablet guides and return to their actual device', async () => {
  for (const [platform, navigator] of [['desktop', {}], ['mac-safari', macSafari], ['android', android]]) {
    const { button, document } = load({ getItem: () => null }, '', { navigator });
    await button.click();
    const guide = document.querySelector('.uiInstallGuide');
    const choices = () => guide.querySelectorAll('[data-ui-install-platform]');
    assert.deepEqual(choices().map(choice => choice.getAttribute('data-ui-install-platform')).sort(), [platform, 'ios-phone', 'ios-tablet'].sort());
    for (const selected of ['ios-phone', 'ios-tablet', platform]) {
      await guide.querySelector(`[data-ui-install-platform="${selected}"]`).click();
      assert.equal(guide.getAttribute('data-platform'), selected);
      assert.equal(guide.querySelectorAll('.uiInstallGuideStep').length, selected === 'ios-phone' ? 5 : selected === 'ios-tablet' ? 4 : 3);
      assert.equal(guide.open, true);
      for (const choice of choices()) assert.equal(choice.getAttribute('aria-pressed'), String(choice.getAttribute('data-ui-install-platform') === selected));
      assert.equal(button.hidden, false);
      assert.equal(button.disabled, false);
    }
  }
});

test('native button language persists across guide switches without changing the Spanish interface', async () => {
  const { button, document, ui } = load({ getItem: () => 'en' }, '', { navigator: { language: 'en-US' } });
  await button.click();
  const guide = document.querySelector('.uiInstallGuide');
  await guide.querySelector('[data-ui-install-platform="ios-phone"]').click();
  assert.match(guide.textContent, /Toca Share/);
  const nativeLanguage = guide.querySelector('[data-ui-native-language]');
  nativeLanguage.value = 'es';
  await guide.emit('change', { target: nativeLanguage });
  assert.match(guide.textContent, /Toca Compartir/);
  for (const selected of ['ios-tablet', 'desktop', 'ios-phone']) {
    await guide.querySelector(`[data-ui-install-platform="${selected}"]`).click();
    assert.equal(guide.getAttribute('data-platform'), selected);
    assert.equal(ui.language, 'es');
    if (selected.startsWith('ios-')) {
      assert.match(guide.textContent, /Toca Compartir/);
      assert.doesNotMatch(guide.textContent, /Toca Share/);
    }
  }
});

test('viewing an iPhone guide on desktop preserves a later real browser installation prompt', async () => {
  const { button, document, handlers } = load({ getItem: () => null });
  await button.click();
  const guide = document.querySelector('.uiInstallGuide');
  await guide.querySelector('[data-ui-install-platform="ios-phone"]').click();
  await guide.querySelector('.uiInstallGuideDone').click();
  let prompts = 0;
  handlers.beforeinstallprompt({ preventDefault() {}, prompt: async () => prompts++, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  await button.click();
  assert.equal(prompts, 1);
  assert.equal(guide.open, false);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
});

test('iOS browsers other than Safari explain how to carry the current link into Safari', async () => {
  for (const browserName of ['CriOS/140', 'FxiOS/142', 'EdgiOS/140', 'OPiOS/1', 'DuckDuckGo/7']) {
    const { button, document } = load({ getItem: () => null }, `?s=${'cd'.repeat(32)}`, { navigator: { ...iphone, userAgent: `${iphone.userAgent} ${browserName}` } });
    await button.click();
    const guide = document.querySelector('.uiInstallGuide');
    assert.equal(guide.getAttribute('data-platform'), 'ios-browser');
    assert.match(guide.textContent, /Safari/);
    assert.ok(guide.querySelector('[data-ui-copy-install-link]'));
    assert.match(guide.querySelector('[data-ui-install-link]').value, /\?s=cd/);
  }
});

test('Spanish website instructions match an English iPhone and can change native labels independently', async () => {
  const { button, document, ui } = load({ getItem: () => null }, '', { navigator: { ...iphone, language: 'en-US' } });
  await button.click();
  const guide = document.querySelector('.uiInstallGuide');
  assert.equal(ui.language, 'es');
  assert.match(guide.textContent, /Toca Share/);
  assert.match(guide.textContent, /Toca Add to Home Screen/);
  assert.ok(guide.querySelector('img[src="/assets/install-guide/safari-share-action-en.png"]'));
  assert.ok(guide.querySelector('img[src="/assets/install-guide/safari-menu-home-en.png"]'));
  assert.ok(guide.querySelector('img[src="/assets/install-guide/safari-phone-more-en.png"]'));
  const deviceLanguage = guide.querySelector('[data-ui-native-language]');
  deviceLanguage.value = 'es';
  await guide.emit('change', { target: deviceLanguage });
  assert.equal(ui.language, 'es');
  assert.match(guide.textContent, /Toca Compartir/);
  assert.ok(guide.querySelector('img[src="/assets/install-guide/safari-menu-home-es.png"]'));
  assert.ok(guide.querySelector('img[src="/assets/install-guide/safari-phone-more-en.png"]'));
  assert.equal(guide.querySelector('img[src="/assets/install-guide/safari-menu-home-en.png"]'), null);
  assert.equal(guide.querySelector('.uiInstallGuideHelp').open, true);
  assert.ok(document.activeElement === guide.querySelector('[data-ui-native-language]'));
});

test('switching interface language updates an open install guide without installing or closing it', async () => {
  const { ui, button, document } = load({ getItem: () => null }, '', { navigator: iphone });
  await button.click();
  const guide = document.querySelector('.uiInstallGuide');
  const spanish = guide.textContent;
  assert.match(spanish, /Compartir/);
  ui.setLanguage('en');
  assert.equal(guide.open, true);
  assert.notEqual(guide.textContent, spanish);
  assert.match(guide.textContent, /Share/);
  assert.equal(button.textContent, 'Add to home screen (instructions)');
  ui.setLanguage('es');
  assert.match(guide.textContent, /Compartir/);
  assert.equal(button.disabled, false);
});

test('a dismissed native prompt stays retryable and a later click opens the guide', async () => {
  const { handlers, button, document } = load({ getItem: () => null });
  let prompted = 0;
  handlers.beforeinstallprompt({ preventDefault() {}, prompt: async () => prompted++, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  await button.click();
  assert.equal(prompted, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.hidden, false);
  assert.equal(document.querySelector('.uiInstallGuide'), null);
  await button.click();
  assert.equal(prompted, 1);
  assert.equal(document.querySelector('.uiInstallGuide').open, true);
});

test('native prompt failure opens useful instructions and does not leave a disabled install button', async () => {
  const { handlers, button, document } = load({ getItem: () => null });
  handlers.beforeinstallprompt({ preventDefault() {}, prompt: async () => { throw new Error('prompt unavailable'); } });
  await button.click();
  assert.equal(document.querySelector('.uiInstallGuide').open, true);
  assert.equal(button.disabled, false);
  assert.equal(button.hidden, false);
});

test('a native prompt in progress cannot be launched twice', async () => {
  const { handlers, button } = load({ getItem: () => null });
  let finishPrompt;
  let prompted = 0;
  handlers.beforeinstallprompt({
    preventDefault() {}, prompt: () => { prompted++; return new Promise(resolve => { finishPrompt = resolve; }); },
    userChoice: Promise.resolve({ outcome: 'dismissed' })
  });
  const pending = button.click();
  assert.equal(button.disabled, true);
  await button.click();
  assert.equal(prompted, 1);
  finishPrompt();
  await pending;
  assert.equal(button.disabled, false);
});

test('in-app browser copy guidance preserves the exact restricted lesson URL', async () => {
  const copied = [];
  const search = `?c=1&l=1-03&solo=1&s=${'ab'.repeat(32)}`;
  const { button, document, window } = load({ getItem: () => null }, search, {
    navigator: { ...iphone, userAgent: `${iphone.userAgent} Instagram 400.0`, clipboard: { async writeText(value) { copied.push(value); } } }
  });
  window.location.href = `https://cursosbiblicos.app/leer.html${search}#page=2`;
  await button.click();
  const guide = document.querySelector('.uiInstallGuide');
  assert.equal(guide.getAttribute('data-platform'), 'ios-in-app');
  assert.equal(guide.querySelector('[data-ui-install-link]').value, window.location.href);
  await guide.querySelector('[data-ui-copy-install-link]').click();
  assert.deepEqual(copied, [window.location.href]);
  assert.equal(window.location.search, search);
  assert.ok(guide.querySelector('[data-ui-copy-status]').textContent.trim());
});

test('previewing Safari steps and returning keeps the scoped copy action functional', async () => {
  for (const [platform, suffix] of [['ios-in-app', 'Instagram 400.0'], ['ios-browser', 'CriOS/140']]) {
    const copied = [];
    const search = `?c=1&l=1-03&solo=1&s=${'ef'.repeat(32)}`;
    const { button, document, window } = load({ getItem: () => null }, search, {
      navigator: { ...iphone, userAgent: `${iphone.userAgent} ${suffix}`, clipboard: { async writeText(value) { copied.push(value); } } }
    });
    window.location.href = `https://cursosbiblicos.app/leer.html${search}#page=2`;
    await button.click();
    const guide = document.querySelector('.uiInstallGuide');
    for (const selected of ['ios-phone', 'ios-tablet', platform]) {
      await guide.querySelector(`[data-ui-install-platform="${selected}"]`).click();
      assert.equal(guide.getAttribute('data-platform'), selected);
    }
    assert.equal(guide.querySelector('[data-ui-install-link]').value, window.location.href);
    await guide.querySelector('[data-ui-copy-install-link]').click();
    assert.deepEqual(copied, [window.location.href]);
    assert.match(guide.querySelector('[data-ui-copy-status]').textContent, /Enlace copiado/);
    assert.equal(button.disabled, false);
    assert.equal(window.location.search, search);
  }
});

test('blocked clipboard gives manual copy instructions without claiming the link was copied', async () => {
  const { button, document, ui } = load({ getItem: () => null }, '', {
    navigator: { ...iphone, userAgent: `${iphone.userAgent} Instagram 400.0`, clipboard: { async writeText() { throw new Error('clipboard blocked'); } } }
  });
  document.execCommand = () => false;
  await button.click();
  const guide = document.querySelector('.uiInstallGuide');
  await guide.querySelector('[data-ui-copy-install-link]').click();
  assert.equal(guide.querySelector('[data-ui-install-link]').selected, true);
  const status = guide.querySelector('[data-ui-copy-status]');
  assert.match(status.textContent, /Mantén pulsado/);
  assert.doesNotMatch(status.textContent, /Enlace copiado/);
  ui.setLanguage('en');
  assert.match(status.textContent, /Touch and hold/);
});
