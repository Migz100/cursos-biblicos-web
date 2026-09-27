const test = require('node:test');
const assert = require('node:assert/strict');
const { url, selectionBody, selectionUrl } = require('../share');
const qrcode = require('../vendor/qrcode');
const scope = 'a1'.repeat(32);

test('public catalog and course links use the canonical origin and discard private state', () => {
  assert.equal(url('https://preview.example/index.html?token=private#saved'), 'https://cursosbiblicos.app/');
  assert.equal(url('/?edit=private&answers=secret'), 'https://cursosbiblicos.app/');
  assert.equal(url('/curso.html'), 'https://cursosbiblicos.app/curso.html?c=1');
  assert.equal(url('http://user:secret@localhost:3000/curso.html?c=course-custom&token=private&l=ignored#answers'),
    'https://cursosbiblicos.app/curso.html?c=course-custom');
});

test('reader and presentation links retain exact IDs and open only the requested lesson', () => {
  for (const path of ['/leer.html', '/presentacion.html']) {
    const input = new URL(path, 'https://preview.example');
    input.searchParams.set('c', 'curso/á + 2');
    input.searchParams.set('l', 'lesson-custom_01');
    input.searchParams.set('solo', '0');
    input.searchParams.set('answers', '{"name":"privado"}');
    input.searchParams.set('token', 'private');
    input.hash = '#answer=private';
    const result = new URL(url(input));
    assert.equal(result.origin, 'https://cursosbiblicos.app');
    assert.equal(result.pathname, path);
    assert.deepEqual([...result.searchParams], [['c', 'curso/á + 2'], ['l', 'lesson-custom_01'], ['solo', '1']]);
    assert.equal(result.hash, '');
  }
  assert.equal(url('/leer.html?c=1&l=1-01'), 'https://cursosbiblicos.app/leer.html?c=1&l=1-01&solo=1');
});

test('private routes, unsupported protocols, and incomplete lesson links cannot be shared', () => {
  for (const input of ['/admin/?token=private', '/edit/', '/api/code/pair', '/leer.html?c=1', '/presentacion.html?l=one', 'javascript:alert(1)', 'data:text/plain,secret']) {
    assert.throws(() => url(input), TypeError);
  }
});

test('collection links keep exactly one valid scope and allow scoped lesson navigation', () => {
  assert.equal(url(`https://preview.example/index.html?s=${scope}&token=secret#answers`), `https://cursosbiblicos.app/index.html?s=${scope}`);
  assert.equal(url(`/?s=${scope}&c=discard`), `https://cursosbiblicos.app/?s=${scope}`);
  assert.equal(url(`/curso.html?c=course-custom&s=${scope}&solo=1`), `https://cursosbiblicos.app/curso.html?c=course-custom&s=${scope}`);
  for (const path of ['/leer.html', '/presentacion.html']) {
    assert.equal(url(`${path}?c=course-custom&l=canonical-id&solo=1&s=${scope}`),
      `https://cursosbiblicos.app${path}?c=course-custom&l=canonical-id&s=${scope}`);
  }
  for (const input of ['/?s=', '/?s=wrong', `/?s=${scope}&s=${scope}`, `/curso.html?s=${scope}`, `/leer.html?c=1&l=1&s=${scope.toUpperCase()}`]) {
    assert.throws(() => url(input), TypeError);
  }
});

test('selection requests contain only chosen canonical IDs and the parent collection', () => {
  const selection = [{ courseId: 'course-custom', lessonIds: ['canonical-02'], answers: 'private', url: '/admin/' }];
  assert.deepEqual(selectionBody(selection, `?s=${scope}&token=secret`), {
    selection: [{ courseId: 'course-custom', lessonIds: ['canonical-02'] }], parentToken: scope
  });
  const body = selectionBody(selection);
  assert.deepEqual(body, { selection: [{ courseId: 'course-custom', lessonIds: ['canonical-02'] }] });
  body.selection[0].lessonIds.push('another');
  assert.deepEqual(selection[0].lessonIds, ['canonical-02']);
});

test('empty or duplicate scope remains explicit so the server cannot widen the selection', () => {
  const selection = [{ courseId: '1', lessonIds: ['canonical-01'] }];
  assert.equal(selectionBody(selection, '?s=').parentToken, '');
  assert.equal(selectionBody(selection, `?s=${scope}&s=${scope}`).parentToken, '');
  assert.equal(selectionBody(selection, '?s=malformed').parentToken, 'malformed');
  for (const invalid of [[], null, [{ courseId: '1', lessonIds: [] }], [{ courseId: '1', lessonIds: ['one', 'one'] }],
    [{ courseId: '1', lessonIds: ['one'] }, { courseId: '1', lessonIds: ['two'] }], [{ courseId: '', lessonIds: ['one'] }]]) {
    assert.throws(() => selectionBody(invalid), TypeError);
  }
});

test('the result must match the saved collection URL and exact selection counts', () => {
  const selection = [{ courseId: '1', lessonIds: ['one', 'two'] }];
  const record = { id: scope, url: `https://cursosbiblicos.app/index.html?s=${scope}`, lessonCount: 2, courseCount: 1 };
  assert.equal(selectionUrl(record, selection), record.url);
  for (const changed of [
    { ...record, url: 'https://cursosbiblicos.app/' },
    { ...record, url: `https://preview.example/index.html?s=${scope}` },
    { ...record, url: `${record.url}&answers=private` },
    { ...record, id: 'wrong' },
    { ...record, id: [scope] },
    { ...record, lessonCount: 3 },
    { ...record, courseCount: 2 }
  ]) assert.throws(() => selectionUrl(changed, selection), TypeError);
});

test('the local QR encoder generates a real matrix for a canonical lesson URL', () => {
  const qr = qrcode(0, 'M');
  qr.addData(url(`/index.html?s=${scope}`), 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  assert.ok(count >= 21 && count <= 177);
  assert.equal((count - 21) % 4, 0);
  for (const [top, left] of [[0, 0], [0, count - 7], [count - 7, 0]]) {
    assert.equal(qr.isDark(top, left), true);
    assert.equal(qr.isDark(top + 1, left + 1), false);
    assert.equal(qr.isDark(top + 3, left + 3), true);
  }
  assert.match(qr.createDataURL(4, 16), /^data:image\/gif;base64,R0lGODdh/);
});

function pickerBrowser() {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const nodes = [];
  const events = {};
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.listeners = {};
      this.style = { getPropertyValue: () => '', getPropertyPriority: () => '', setProperty() {}, removeProperty() {} };
      this.classList = { toggle: () => {} };
      this.hidden = this.checked = this.disabled = false;
      this.scrollLeft = this.scrollTop = 0;
      this.clientWidth = 500;
      this.scrollWidth = 1000;
      this.isConnected = true;
      nodes.push(this);
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(key, handler) { (this.listeners[key] ||= []).push(handler); }
    emit(key, detail = {}) { return Promise.all((this.listeners[key] || []).map(handler => handler({ target: this, preventDefault() {}, ...detail }))); }
    focus() { root.document.activeElement = this; }
    select() {}
    showModal() { this.open = true; }
    close() { this.open = false; return this.emit('close'); }
    scrollBy({ left }) { this.scrollLeft += left; return this.emit('scroll'); }
    scrollTo({ left }) { this.scrollLeft = left; return this.emit('scroll'); }
    getContext() { return { fillRect() {} }; }
    getBoundingClientRect() { return { left: 0, right: 500, top: 0, bottom: 700 }; }
  }
  let language = 'es';
  const calls = [];
  const qrValues = [];
  let resolveRequest;
  const root = {
    document: { createElement: tag => new Element(tag), body: new Element('body'), documentElement: new Element('html'), title: 'Cursos Bíblicos' },
    location: { href: 'https://cursosbiblicos.app/', search: '' }, scrollX: 0, scrollY: 0, innerWidth: 500,
    getComputedStyle: () => ({ paddingRight: '0' }), scrollTo() {}, requestAnimationFrame: handler => handler(),
    navigator: { clipboard: { async writeText(value) { calls.push({ copied: value }); } } },
    qrcode(...args) {
      const qr = qrcode(...args);
      const addData = qr.addData;
      qr.addData = (value, mode) => { qrValues.push(value); return addData(value, mode); };
      return qr;
    },
    addEventListener: (event, handler) => { (events[event] ||= []).push(handler); },
    matchMedia: () => ({ matches: true }),
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Promise(resolve => { resolveRequest = resolve; });
    },
    CourseUI: {
      t: (es, en, vars = {}) => (language === 'es' ? es : en).replace(/\{(\w+)\}/g, (_, key) => vars[key])
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../share'), 'utf8'), { window: root, URL, URLSearchParams });
  return {
    api: root.CourseShare, root, calls, qrValues,
    byId: id => nodes.find(node => node.id === id),
    byClass: name => nodes.filter(node => node.className?.split(' ').includes(name)),
    language(next) { language = next; for (const handler of events['course-language-change'] || []) handler(); },
    resolve(selection) { resolveRequest({ ok: true, json: async () => ({ id: scope, url: `https://cursosbiblicos.app/index.html?s=${scope}`, courseCount: selection.length, lessonCount: selection.reduce((sum, course) => sum + course.lessonIds.length, 0) }) }); }
  };
}

const pickerCourses = [
  { id: 'one', name: 'Fe de Jesús', section: 'cursos', lessons: [{ id: 'one-a', title: 'La Biblia' }, { id: 'one-b', title: 'La Oración' }] },
  { id: 'two', name: 'Daniel', section: 'cursos', lessons: [{ id: 'two-a', title: 'Daniel 1' }] },
  { id: 'three', name: 'La Fe de Jesús 2', section: 'lafe', lessons: [{ id: 'three-a', title: 'El Milenio' }] }
];

test('the sharing picker starts fully collapsed in section rows and expands lessons below each row', async () => {
  const browser = pickerBrowser();
  assert.equal(browser.api.select({ courses: pickerCourses }), true);
  const rows = browser.byClass('courseShareCourseRow');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children.length, 2);
  assert.equal(rows[1].children.length, 1);
  const lessons = browser.byClass('courseShareLessons');
  assert.ok(lessons.every(list => list.hidden));
  assert.ok(browser.byClass('courseShareExpand').every(button => button.getAttribute('aria-expanded') === 'false'));
  assert.deepEqual(lessons[0].children.slice(1).map(label => label.children[1].textContent), ['Lección 1', 'Lección 2']);
  assert.ok(browser.byClass('courseShareCreate')[0].disabled);
  await browser.byClass('courseShareExpand')[0].emit('click');
  assert.equal(lessons[0].hidden, false);
  assert.equal(rows[0].children.some(card => card.children.includes(lessons[0])), false);
  await browser.byClass('courseShareExpand')[1].emit('click');
  assert.equal(lessons[0].hidden, true);
  assert.equal(lessons[1].hidden, false);
});

test('sharing opens directly to selection and preserves choices through result and language changes', async () => {
  const browser = pickerBrowser();
  browser.root.location.search = `?s=${scope}`;
  browser.api.select({ courses: pickerCourses });
  assert.equal(browser.byClass('courseShareTabs').length, 0);
  assert.equal(browser.byClass('courseShareOptions').length, 0);
  assert.equal(browser.byClass('courseShareFooter')[0].hidden, false);
  const firstLesson = browser.byClass('courseShareLessons')[0].children[1].children[0];
  firstLesson.checked = true;
  await firstLesson.emit('change');
  const courseCheck = browser.byClass('courseShareCourseCheck')[0].children[0];
  assert.equal(courseCheck.indeterminate, true);
  browser.language('en');
  assert.equal(browser.byId('courseShareCount').textContent, '1 lesson selected in 1 course');
  assert.equal(firstLesson.checked, true);
  assert.equal(browser.byClass('courseShareLessons')[0].children[1].children[1].textContent, 'Lecture 1');
  assert.equal(courseCheck.indeterminate, true);
  assert.equal(browser.byClass('courseShareFooter')[0].hidden, false);
  const request = browser.byClass('courseShareCreate')[0].emit('click');
  const selection = [{ courseId: 'one', lessonIds: ['one-a'] }];
  assert.deepEqual(browser.calls[0].body, { selection, parentToken: scope });
  browser.language('es');
  assert.equal(browser.byClass('courseShareCreate')[0].textContent, 'Creando enlace...');
  assert.equal(firstLesson.disabled, true);
  browser.resolve(selection);
  await request;
  assert.equal(browser.qrValues.at(-1), `https://cursosbiblicos.app/index.html?s=${scope}`);
  browser.language('en');
  assert.equal(browser.byClass('courseShareNative')[0].textContent, 'Share');
  assert.equal(browser.byClass('courseShareNative')[0].disabled, false);
  assert.equal(browser.byClass('courseShareResult')[0].hidden, false);
  assert.equal(browser.byClass('courseShareFooter')[0].hidden, true);
  assert.equal(firstLesson.checked, true);
  assert.equal(browser.byClass('courseShareChange').length, 0);
});

test('reshared lessons retain original course numbers across language changes', async () => {
  const browser = pickerBrowser();
  browser.api.select({ courses: [{ id: 'course', name: 'Curso', lessons: [
    { id: 'uuid-two', title: 'La Biblia', lessonNumber: 2 },
    { id: 'uuid-five', title: 'La Oración', lessonNumber: 5 }
  ] }] });
  const rows = browser.byClass('courseShareLessons')[0].children.slice(1);
  assert.deepEqual(rows.map(label => label.children[1].textContent), ['Lección 2', 'Lección 5']);
  rows[1].children[0].checked = true;
  await rows[1].children[0].emit('change');
  browser.language('en');
  assert.deepEqual(rows.map(label => label.children[1].textContent), ['Lecture 2', 'Lecture 5']);
  assert.equal(rows[1].children[0].checked, true);
  const request = browser.byClass('courseShareCreate')[0].emit('click');
  const selection = [{ courseId: 'course', lessonIds: ['uuid-five'] }];
  assert.deepEqual(browser.calls[0].body, { selection });
  browser.resolve(selection);
  await request;
});

test('switching collections ignores a late request and preserves the new collapsed picker', async () => {
  const browser = pickerBrowser();
  browser.api.select({ courses: pickerCourses });
  const checkbox = browser.byClass('courseShareCourseCheck')[0].children[0];
  checkbox.checked = true;
  await checkbox.emit('change');
  const request = browser.byClass('courseShareCreate')[0].emit('click');
  browser.api.select({ courses: [pickerCourses[2]] });
  browser.resolve([{ courseId: 'one', lessonIds: ['one-a', 'one-b'] }]);
  await request;
  assert.equal(browser.byClass('courseShareResult')[0].hidden, true);
  assert.equal(browser.byId('courseShareCount').textContent, '0 lecciones seleccionadas');
  assert.deepEqual(browser.qrValues, []);
  assert.equal(browser.byClass('courseShareQr')[0].children[0].width, 0);
});

test('homepage share-all immediately shows and copies the canonical public URL without a POST', async () => {
  const browser = pickerBrowser();
  browser.root.location.href = 'https://preview.example/index.html?token=private#answers';
  browser.root.location.search = '?token=private';
  assert.equal(browser.api.select({ courses: pickerCourses, sharePage: true }), true);
  const all = browser.byClass('courseShareAll')[0];
  assert.equal(all.hidden, false);
  assert.equal(all.disabled, false);
  assert.equal(all.textContent, 'Compartir todos los cursos');
  await all.emit('click');
  assert.equal(browser.qrValues.at(-1), 'https://cursosbiblicos.app/');
  assert.equal(browser.byClass('courseSharePicker')[0].hidden, true);
  assert.equal(browser.byClass('courseShareResult')[0].hidden, false);
  assert.equal(browser.byClass('courseShareQr')[0].hidden, false);
  assert.deepEqual(browser.calls, []);
  await browser.byClass('courseShareNative')[0].emit('click');
  assert.deepEqual(browser.calls, [{ copied: 'https://cursosbiblicos.app/' }]);
  assert.equal(browser.byClass('courseShareStatus')[0].textContent, 'Enlace copiado. Pégalo en tu mensaje.');
});

test('shared homepage shortcut keeps the exact collection scope and never requests a broader selection', async () => {
  const browser = pickerBrowser();
  browser.root.location.search = `?s=${scope}&token=private&c=unrelated`;
  browser.root.location.href = `https://preview.example/index.html${browser.root.location.search}#answers`;
  assert.equal(browser.api.select({ courses: [pickerCourses[0]], sharePage: true }), true);
  const all = browser.byClass('courseShareAll')[0];
  assert.equal(all.textContent, 'Compartir esta selección');
  await all.emit('click');
  assert.equal(browser.qrValues.at(-1), `https://cursosbiblicos.app/index.html?s=${scope}`);
  assert.deepEqual(browser.calls, []);
  await browser.byClass('courseShareNative')[0].emit('click');
  assert.deepEqual(browser.calls, [{ copied: `https://cursosbiblicos.app/index.html?s=${scope}` }]);
});

test('invalid, empty and duplicate scopes never expose a share-all shortcut or a public fallback URL', async () => {
  for (const search of ['?s=', '?s=invalid', `?s=${scope}&s=${scope}`]) {
    const browser = pickerBrowser();
    browser.api.select({ courses: pickerCourses, sharePage: true });
    await browser.byClass('courseShareAll')[0].emit('click');
    assert.equal(browser.qrValues.at(-1), 'https://cursosbiblicos.app/');
    browser.root.location.search = search;
    browser.root.location.href = `https://cursosbiblicos.app/index.html${search}`;
    assert.equal(browser.api.select({ courses: pickerCourses, sharePage: true }), false);
    const all = browser.byClass('courseShareAll')[0];
    assert.ok(all.hidden || all.disabled);
    assert.equal(browser.byClass('courseShareResult')[0].hidden, true);
    assert.equal(browser.byClass('courseShareQr')[0].children[0].width, 0);
    await browser.byClass('courseShareNative')[0].emit('click');
    assert.deepEqual(browser.calls, []);
  }
});

test('share-all leaves chosen lesson checkboxes intact and shows only the result action', async () => {
  const browser = pickerBrowser();
  browser.api.select({ courses: pickerCourses, sharePage: true });
  const lessons = browser.byClass('courseShareLessons')[0];
  const first = lessons.children[1].children[0];
  const second = lessons.children[2].children[0];
  second.checked = true;
  await second.emit('change');
  await browser.byClass('courseShareAll')[0].emit('click');
  assert.equal(browser.byClass('courseShareResult')[0].hidden, false);
  assert.equal(browser.byClass('courseSharePicker')[0].hidden, true);
  assert.equal(browser.byClass('courseShareChange').length, 0);
  assert.equal(first.checked, false);
  assert.equal(second.checked, true);
  assert.equal(browser.byId('courseShareCount').textContent, '1 lección seleccionada en 1 curso');
  assert.deepEqual(browser.calls, []);
});

test('share-all is hidden for course pickers and disabled while a selected link is being created', async () => {
  const coursePicker = pickerBrowser();
  coursePicker.api.select({ courses: pickerCourses });
  assert.equal(coursePicker.byClass('courseShareAll')[0].hidden, true);
  const browser = pickerBrowser();
  browser.api.select({ courses: pickerCourses, sharePage: true });
  const first = browser.byClass('courseShareCourseCheck')[0].children[0];
  first.checked = true;
  await first.emit('change');
  const request = browser.byClass('courseShareCreate')[0].emit('click');
  assert.equal(browser.byClass('courseShareAll')[0].disabled, true);
  const duplicate = browser.byClass('courseShareCreate')[0].emit('click');
  assert.equal(browser.calls.length, 1);
  await duplicate;
  await browser.byClass('courseShareAll')[0].emit('click');
  assert.deepEqual(browser.qrValues, []);
  assert.equal(browser.calls.length, 1);
  const selection = [{ courseId: 'one', lessonIds: ['one-a', 'one-b'] }];
  browser.resolve(selection);
  await request;
  assert.equal(browser.byClass('courseShareAll')[0].disabled, false);
});

function assertSimpleResult(browser) {
  const action = browser.byClass('courseShareNative')[0];
  assert.equal(action.textContent, 'Compartir');
  assert.ok(action.className.split(' ').includes('primary'));
  assert.equal(action.hidden, false);
  assert.deepEqual(browser.byClass('courseShareActions')[0].children, [action]);
  assert.equal(browser.byClass('courseShareResult')[0].children.length, 2);
  assert.equal(browser.byClass('courseShareQr')[0].hidden, false);
  assert.equal(browser.byClass('courseShareLink').length, 0);
  assert.equal(browser.byClass('courseShareChange').length, 0);
  assert.equal(browser.byId('courseShareUrl'), undefined);
  return action;
}

test('a direct lesson result contains only QR and one primary share action with the exact canonical payload', async () => {
  const browser = pickerBrowser();
  browser.root.navigator.share = async value => browser.calls.push({ shared: JSON.parse(JSON.stringify(value)) });
  const canonical = `https://cursosbiblicos.app/leer.html?c=one&l=one-b&s=${scope}`;
  assert.equal(browser.api.open({
    url: `https://preview.example/leer.html?c=one&l=one-b&s=${scope}&answers=private#saved`,
    title: 'Lección 2', text: 'Una lección para ti'
  }), true);
  assert.equal(browser.qrValues.at(-1), canonical);
  await assertSimpleResult(browser).emit('click');
  assert.deepEqual(browser.calls, [{ shared: { url: canonical, title: 'Lección 2', text: 'Una lección para ti' } }]);
});

test('a course selection shares only the verified saved collection and retains its title and text', async () => {
  const browser = pickerBrowser();
  browser.root.location.search = `?s=${scope}`;
  browser.root.navigator.share = async value => browser.calls.push({ shared: JSON.parse(JSON.stringify(value)) });
  const selection = [{ courseId: 'one', lessonIds: ['one-b'] }];
  const request = browser.api.shareSelection({ selection, title: 'Fe de Jesús', text: 'Lección 2' });
  assert.deepEqual(browser.calls, [{ url: '/api/share', body: { selection, parentToken: scope } }]);
  browser.resolve(selection);
  assert.equal(await request, true);
  const canonical = `https://cursosbiblicos.app/index.html?s=${scope}`;
  assert.equal(browser.qrValues.at(-1), canonical);
  await assertSimpleResult(browser).emit('click');
  assert.deepEqual(browser.calls[1], { shared: { url: canonical, title: 'Fe de Jesús', text: 'Lección 2' } });
});

test('unsupported native sharing uses the same primary button to copy the QR destination', async () => {
  const browser = pickerBrowser();
  browser.api.open({ url: '/curso.html?c=one&token=private', title: 'Fe de Jesús' });
  const action = assertSimpleResult(browser);
  await action.emit('click');
  assert.deepEqual(browser.calls, [{ copied: browser.qrValues.at(-1) }]);
  assert.equal(browser.byClass('courseShareStatus')[0].textContent, 'Enlace copiado. Pégalo en tu mensaje.');
  assert.equal(action.disabled, false);
});

test('missing or rejected clipboard access keeps the QR visible and gives simple scan guidance', async () => {
  for (const mode of ['missing', 'rejected']) {
    const browser = pickerBrowser();
    browser.root.navigator.clipboard = mode === 'missing' ? undefined : { writeText: async () => { throw new Error('Permission denied'); } };
    browser.api.open({ url: '/curso.html?c=one' });
    const action = assertSimpleResult(browser);
    await action.emit('click');
    assert.equal(browser.byClass('courseShareStatus')[0].textContent, 'Escanea el código QR para abrir y compartir desde otro dispositivo.');
    assert.equal(browser.byClass('courseShareQr')[0].hidden, false);
    assert.equal(action.disabled, false);
    assert.deepEqual(browser.calls, []);
  }
});

test('failed QR generation and sharing show reload guidance instead of asking to scan an invisible code', async () => {
  const browser = pickerBrowser();
  browser.root.qrcode = () => { throw new Error('QR encoder unavailable'); };
  browser.root.navigator.clipboard = undefined;
  browser.root.navigator.share = async () => { throw new Error('Native sharing unavailable'); };
  assert.equal(browser.api.open({ url: '/curso.html?c=one' }), true);
  const action = browser.byClass('courseShareNative')[0];
  assert.equal(browser.byClass('courseShareQr')[0].hidden, true);
  assert.equal(action.hidden, false);
  assert.equal(action.textContent, 'Compartir');
  assert.deepEqual(browser.byClass('courseShareActions')[0].children, [action]);
  await action.emit('click');
  assert.equal(browser.byClass('courseShareStatus')[0].textContent, 'No se pudo compartir. Recarga la página e inténtalo de nuevo.');
  assert.equal(action.disabled, false);
  assert.deepEqual(browser.calls, []);
});

test('dismissing native sharing stays quiet and does not copy anything', async () => {
  const browser = pickerBrowser();
  let nativeCalls = 0;
  browser.root.navigator.share = async () => { nativeCalls++; throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); };
  browser.api.open({ url: '/' });
  const action = assertSimpleResult(browser);
  await action.emit('click');
  assert.equal(nativeCalls, 1);
  assert.deepEqual(browser.calls, []);
  assert.equal(browser.byClass('courseShareStatus')[0].textContent, '');
  assert.equal(action.disabled, false);
});

test('a native share error falls back to copying the same scoped URL', async () => {
  const browser = pickerBrowser();
  browser.root.navigator.share = async value => {
    browser.calls.push({ shared: JSON.parse(JSON.stringify(value)) });
    throw Object.assign(new Error('Not allowed'), { name: 'NotAllowedError' });
  };
  const canonical = `https://cursosbiblicos.app/index.html?s=${scope}`;
  browser.api.open({ url: canonical, title: 'Mi selección' });
  await assertSimpleResult(browser).emit('click');
  assert.deepEqual(browser.calls, [{ shared: { url: canonical, title: 'Mi selección' } }, { copied: canonical }]);
  assert.equal(browser.byClass('courseShareStatus')[0].textContent, 'Enlace copiado. Pégalo en tu mensaje.');
});

test('pending native sharing ignores repeated clicks and a stale failure cannot copy or change the next result', async () => {
  const browser = pickerBrowser();
  let rejectNative;
  browser.root.navigator.share = value => {
    browser.calls.push({ shared: JSON.parse(JSON.stringify(value)) });
    return new Promise((resolve, reject) => { rejectNative = reject; });
  };
  browser.api.open({ url: '/curso.html?c=one', title: 'Primero' });
  const action = assertSimpleResult(browser);
  const pending = action.emit('click');
  assert.equal(action.disabled, true);
  const duplicate = action.emit('click');
  assert.equal(browser.calls.length, 1);
  await duplicate;
  browser.api.open({ url: '/curso.html?c=two', title: 'Segundo' });
  rejectNative(new Error('Old request failed'));
  await pending;
  assert.equal(browser.calls.length, 1);
  assert.equal(browser.qrValues.at(-1), 'https://cursosbiblicos.app/curso.html?c=two');
  assert.equal(browser.byClass('courseShareStatus')[0].textContent, '');
  assert.equal(action.disabled, false);
});

test('an old clipboard completion cannot report success or unlock a newer pending share', async () => {
  const browser = pickerBrowser();
  const complete = [];
  browser.root.navigator.clipboard.writeText = value => {
    browser.calls.push({ copied: value });
    return new Promise(resolve => complete.push(resolve));
  };
  browser.api.open({ url: '/curso.html?c=one' });
  const action = assertSimpleResult(browser);
  const first = action.emit('click');
  browser.api.open({ url: '/curso.html?c=two' });
  const second = action.emit('click');
  complete[0]();
  await first;
  assert.equal(browser.byClass('courseShareStatus')[0].textContent, '');
  assert.equal(action.disabled, true);
  complete[1]();
  await second;
  assert.equal(action.disabled, false);
  assert.equal(browser.byClass('courseShareStatus')[0].textContent, 'Enlace copiado. Pégalo en tu mensaje.');
  assert.deepEqual(browser.calls, [{ copied: 'https://cursosbiblicos.app/curso.html?c=one' }, { copied: 'https://cursosbiblicos.app/curso.html?c=two' }]);
});
