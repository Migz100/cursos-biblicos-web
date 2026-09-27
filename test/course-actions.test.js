const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Blob, File } = require('node:buffer');

const source = fs.readFileSync(path.join(__dirname, '..', 'course.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const scope = 'ab'.repeat(32);
const course = {
  id: '1', name: 'Fe de Jesús', zip: 'https://files.example/course-pdf.zip', zipKind: 'current',
  pptZip: 'https://files.example/course-powerpoint.zip', lessons: [
    { id: 'first', legacyNumber: '01', title: 'La Biblia', type: 'pdf', url: 'https://files.example/one.pdf' },
    { id: 'second', legacyNumber: '02', title: 'Dios', type: 'pdf', url: 'https://files.example/two.pdf' },
    { id: 'third', legacyNumber: '03', title: 'La oración', type: 'pdf', url: 'https://files.example/three.pdf' }
  ]
};

async function loadCourse(catalogCourse = course, search = '?c=1', ok = true) {
  const requests = [], shares = [], pickers = [], files = [];
  const element = tag => ({
    tag, children: [], dataset: {}, style: {}, attributes: {}, hidden: false, disabled: false,
    classList: { add() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; }
  });
  const ids = ['title', 'courseTitle', 'courseSummary', 'shareCourse', 'courseCover', 'dlCourse', 'courseArchiveNote', 'sharedNotice', 'list'];
  const elements = Object.fromEntries(ids.map(id => [id, element('div')]));
  for (const id of ['courseCover', 'dlCourse', 'courseArchiveNote', 'sharedNotice']) elements[id].hidden = true;
  elements.shareCourse.disabled = true;
  const back = element('a');
  const document = { body: element('body'), getElementById: id => elements[id], querySelector: () => back, createElement: element };
  const context = {
    document, location: { search }, URLSearchParams, URL, Blob, File,
    navigator: { canShare: () => true, share: async value => { files.push(value); } },
    window: { addEventListener() {}, CourseShare: { shareSelection: value => shares.push(plain(value)), select: value => pickers.push(plain(value)) } },
    fetch: async url => {
      requests.push(url);
      return url.startsWith('/api/catalog')
        ? { ok, json: async () => ({ courses: [catalogCourse, { id: 'other', name: 'Otro curso', lessons: [{ id: 'unrelated' }] }] }) }
        : { ok: true, blob: async () => new Blob(['archive fixture'], { type: 'application/zip' }) };
    }
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    elements, requests, shares, pickers, files,
    async click(target) {
      if (!target.disabled) target.onclick?.({ preventDefault() {}, stopPropagation() {} });
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test('course header directly shares every lesson in that course without reopening the picker', async () => {
  const browser = await loadCourse();
  await browser.click(browser.elements.shareCourse);
  assert.equal(browser.pickers.length, 0);
  assert.equal(browser.shares.length, 1);
  assert.deepEqual(browser.shares[0].selection, [{ courseId: '1', lessonIds: ['first', 'second', 'third'] }]);
  assert.equal(browser.shares[0].title, course.name);
  assert.equal(browser.shares[0].selection.some(item => item.courseId === 'other'), false);
});

test('a shared course header directly re-shares only its visible canonical lesson IDs', async () => {
  const selected = { ...course, lessons: [{ ...course.lessons[2], lessonNumber: 3 }] };
  const browser = await loadCourse(selected, `?c=1&s=${scope}`);
  assert.deepEqual(browser.requests, [`/api/catalog?s=${scope}`]);
  assert.equal(browser.elements.list.children.length, 1);
  await browser.click(browser.elements.shareCourse);
  assert.equal(browser.pickers.length, 0);
  assert.deepEqual(browser.shares[0].selection, [{ courseId: '1', lessonIds: ['third'] }]);
  assert.equal(browser.elements.shareCourse.textContent, 'Compartir selección');
});

test('individual lesson sharing still sends exactly that lesson after the whole course shortcut', async () => {
  const browser = await loadCourse();
  await browser.click(browser.elements.shareCourse);
  await browser.click(browser.elements.list.children[1].children.find(item => item.className === 'dlRow shareRow'));
  assert.equal(browser.shares.length, 2);
  assert.deepEqual(browser.shares[1].selection, [{ courseId: '1', lessonIds: ['second'] }]);
  assert.equal(browser.shares[1].title, course.lessons[1].title);
  assert.equal(browser.pickers.length, 0);
});

test('the single course download prefers the PowerPoint archive and executes its download handler', async () => {
  const browser = await loadCourse();
  const download = browser.elements.dlCourse;
  assert.equal(download.hidden, false);
  assert.equal(download.href, course.pptZip);
  assert.equal(download.textContent, 'Descargar curso (PowerPoint)');
  assert.equal(browser.elements.courseArchiveNote.hidden, false);
  await browser.click(download);
  assert.deepEqual(browser.requests, ['/api/catalog', course.pptZip]);
  assert.equal(browser.files.length, 1);
  assert.equal(browser.files[0].files[0].name, `${course.name}.zip`);
  assert.equal(download.dataset.busy, undefined);
});

test('the single course download falls back to the PDF ZIP when no PowerPoint archive exists', async () => {
  const browser = await loadCourse({ ...course, pptZip: undefined });
  const download = browser.elements.dlCourse;
  assert.equal(download.href, course.zip);
  assert.equal(download.textContent, 'Descargar curso (ZIP)');
  assert.equal(browser.elements.courseArchiveNote.hidden, true);
  await browser.click(download);
  assert.deepEqual(browser.requests, ['/api/catalog', course.zip]);
});

test('all shared scopes keep whole-course archives hidden even if the response contains archive URLs', async () => {
  for (const query of [`s=${scope}`, 's=', `s=${scope}&s=${scope}`]) {
    const browser = await loadCourse({ ...course, lessons: [course.lessons[2]] }, `?c=1&${query}`);
    assert.equal(browser.elements.dlCourse.hidden, true);
    assert.equal(browser.elements.dlCourse.href, undefined);
    assert.equal(browser.elements.dlCourse.onclick, undefined);
    assert.equal(browser.elements.courseArchiveNote.hidden, true);
  }
});

test('a failed catalog cannot enable either a course share or an archive download', async () => {
  const browser = await loadCourse(course, '?c=1', false);
  assert.equal(browser.elements.shareCourse.disabled, true);
  assert.equal(browser.elements.shareCourse.onclick, undefined);
  assert.equal(browser.elements.dlCourse.hidden, true);
  assert.equal(browser.elements.dlCourse.href, undefined);
});
