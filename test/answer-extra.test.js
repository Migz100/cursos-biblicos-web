const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.ANSWER_TEST_ROOT || path.join(__dirname, '..');
const reader = fs.readFileSync(path.join(root, 'reader.js'), 'utf8');

function sourceFunction(name) {
  const start = reader.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  let depth = 0;
  for (let i = reader.indexOf('{', start); i < reader.length; i += 1) {
    if (reader[i] === '{') depth += 1;
    else if (reader[i] === '}' && --depth === 0) return reader.slice(start, i + 1);
  }
  throw new Error(`unclosed ${name}`);
}

function harness(saved = { values: {}, fields: {} }) {
  const elements = [];
  function element(tagName) {
    const classes = new Set();
    const item = {
      tagName, style: {}, dataset: {}, attributes: {}, children: [], listeners: {},
      classList: {
        add(name) { classes.add(name); },
        contains(name) { return classes.has(name); },
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { this.children.push(child); },
      addEventListener(name, listener) { this.listeners[name] = listener; }
    };
    elements.push(item);
    return item;
  }
  let stored = JSON.stringify(saved);
  const context = {
    document: {
      createElement: element,
      querySelectorAll(selector) {
        const className = selector.match(/^\.([\w]+)/)[1];
        return elements.filter(item => item.className?.split(' ').includes(className) && item.dataset.answerId);
      }
    },
    localStorage: { getItem() { return stored; }, setItem(key, value) { stored = value; } },
    answerKey: () => 'lesson-key', answerState: {}, pageNum: 1, updateAnswerHint() {},
    pdfjsLib: { Util: { applyTransform(point, matrix) {
      const [x, y] = point;
      point[0] = matrix[0] * x + matrix[2] * y + matrix[4];
      point[1] = matrix[1] * x + matrix[3] * y + matrix[5];
    } } }
  };
  vm.createContext(context);
  vm.runInContext([
    'rotateGeometry', 'fieldId', 'restoreAlignedAnswer', 'mergeFields', 'overlapsPrintedText', 'filterAndRotateFields',
    'annotationRectangle', 'annotationFields', 'loadAnswers', 'saveAnswers', 'createAnswerLayer', 'syncVisibleAnswers'
  ].map(sourceFunction).join('\n'), context);
  context.loadAnswers();
  return { context, element, persisted: () => JSON.parse(stored) };
}

function radio(id, group, x) {
  return { id, group, x, y: 0.3, w: 0.02, h: 0.02, kind: 'radio', native: true };
}
const viewport = { width: 350, height: 500 };

test('radio choices exclude only their own group, including saved choices on unrendered pages', () => {
  const saved = {
    values: { '4:old-choice': '1', '1:other-group': '1', '2:written': 'Conservar respuesta' },
    fields: { '4:old-choice': { ...radio('old-choice', 'decision', 0.1), page: 4 } }
  };
  const { context, element, persisted } = harness(saved);
  const page = element('div');
  context.createAnswerLayer(page, [radio('yes', 'decision', 0.1), radio('no', 'decision', 0.3), radio('other-group', 'other', 0.5)], viewport, 1);
  const [yes, no, other] = page.children[0].children;
  yes.listeners.click();
  assert.equal(persisted().values['4:old-choice'], undefined);
  assert.equal(persisted().values['1:yes'], '1');
  assert.equal(other.attributes['aria-pressed'], 'true');
  no.listeners.click();
  assert.equal(persisted().values['1:yes'], undefined);
  assert.equal(persisted().values['1:no'], '1');
  assert.equal(yes.attributes['aria-pressed'], 'false');
  assert.equal(yes.classList.contains('on'), false);
  assert.equal(no.attributes['aria-pressed'], 'true');
  assert.equal(persisted().values['2:written'], 'Conservar respuesta');
  no.listeners.click();
  assert.equal(persisted().values['1:no'], '1', 'clicking selected radio must retain its selection');
  const next = harness(persisted());
  const reloadedPage = next.element('div');
  next.context.createAnswerLayer(reloadedPage, [radio('yes', 'decision', 0.1), radio('no', 'decision', 0.3)], viewport, 1);
  assert.equal(reloadedPage.children[0].children[0].attributes['aria-pressed'], 'false');
  assert.equal(reloadedPage.children[0].children[1].attributes['aria-pressed'], 'true');
});

test('PDF radio annotations retain their group and dimensions after normalization', () => {
  const { context } = harness();
  const annotations = [
    { id: 'yes', fieldName: 'acceptance', fieldType: 'Btn', radioButton: true, rect: [20, 30, 23, 34] },
    { id: 'check', fieldType: 'Btn', checkBox: true, rect: [40, 30, 43, 34] },
    { id: 'submit', fieldType: 'Btn', pushButton: true, rect: [60, 30, 70, 40] }
  ];
  const fields = context.mergeFields(context.annotationFields(annotations, { width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] }));
  assert.equal(fields.length, 2);
  const choice = fields.find(field => field.id === 'widget-yes');
  assert.equal(choice.kind, 'radio');
  assert.equal(choice.group, 'acceptance');
  assert.equal(choice.w, 0.03);
  assert.equal(choice.h, 0.04);
  assert.equal(fields.find(field => field.id === 'widget-check').kind, 'check');
});

test('fallback answer IDs match legacy unrotated keys and remain stable through every rotation', () => {
  const { context } = harness();
  const field = { x: 0.1, y: 0.2, w: 0.5, h: 0.02, kind: 'line' };
  const legacyId = context.fieldId(1, field);
  for (const rotation of [0, 90, 180, 270]) {
    const transformed = context.filterAndRotateFields([field], [], rotation)[0];
    assert.equal(context.fieldId(1, transformed), legacyId, `rotation ${rotation}`);
  }
});

test('a saved fallback answer stays visible after rotation and reload', () => {
  const initial = harness();
  const field = { x: 0.1, y: 0.2, w: 0.5, h: 0.02, kind: 'line' };
  const page = initial.element('div');
  initial.context.createAnswerLayer(page, initial.context.filterAndRotateFields([field], [], 0), viewport, 1);
  const input = page.children[0].children[0];
  input.value = 'Esperanza';
  input.listeners.input();
  const next = harness(initial.persisted());
  const rotated = next.element('div');
  next.context.createAnswerLayer(rotated, next.context.filterAndRotateFields([field], [], 90), { width: 500, height: 350 }, 1);
  assert.equal(rotated.children[0].children[0].value, 'Esperanza');
  assert.deepEqual(Object.keys(next.persisted().values), [input.dataset.answerId]);
});

test('rotating a thin printed answer preserves the exact rotated rectangle', () => {
  const { context } = harness();
  const field = { id: 'line', x: 0.1, y: 0.2, w: 0.5, h: 0.02, kind: 'line' };
  for (const rotation of [0, 90, 180, 270]) {
    const expected = context.rotateGeometry(field, rotation);
    const actual = context.filterAndRotateFields([field], [], rotation)[0];
    for (const key of ['x', 'y', 'w', 'h']) assert.equal(actual[key], expected[key], `rotation ${rotation}: ${key}`);
  }
});

test('answers saved with the previous rotated minimum width return to the corrected field', () => {
  // These are the actual rectangle and key emitted by the previous reader for
  // { x: .1, y: .2, w: .5, h: .02 } at 90 degrees: its width was enlarged to .04.
  const oldId = '1:0.7800:0.1000:0.0400:0.5000';
  const previous = {
    values: { [oldId]: 'Respuesta guardada antes de corregir las líneas' },
    fields: { [oldId]: { page: 1, x: 0.78, y: 0.1, w: 0.04, h: 0.5, kind: 'line', rotated: true } }
  };
  const { context, element, persisted } = harness(previous);
  const field = { x: 0.1, y: 0.2, w: 0.5, h: 0.02, kind: 'line' };
  const page = element('div');
  context.createAnswerLayer(page, context.filterAndRotateFields([field], [], 90), { width: 500, height: 350 }, 1);
  assert.equal(page.children[0].children[0].value, previous.values[oldId]);
  assert.equal(persisted().values[oldId], previous.values[oldId], 'keep the original saved answer while migrating');
});

test('an unanswered printed field never borrows the answer of another current field with rotational symmetry', () => {
  const first = { x: 0.1, y: 0.2, w: 0.5, h: 0.02, kind: 'line' };
  const second = { x: 0.4, y: 0.78, w: 0.5, h: 0.02, kind: 'line' };
  const secondId = '1:0.4000:0.7800:0.5000:0.0200';
  const previous = {
    values: { [secondId]: 'Solo corresponde a la segunda pregunta' },
    fields: { [secondId]: { page: 1, ...second } }
  };
  const { context, element, persisted } = harness(previous);
  const page = element('div');
  context.createAnswerLayer(page, [first, second], viewport, 1);
  assert.equal(page.children[0].children[0].value, '');
  assert.equal(page.children[0].children[1].value, previous.values[secondId]);
  assert.equal(persisted().fields[secondId].aliasFor, undefined);
});

test('ambiguous legacy matches preserve original answers without guessing their replacement', () => {
  const field = { id: 'replacement', x: 0.1, y: 0.2, w: 0.5, h: 0.02, kind: 'line' };
  const firstId = '1:0.1000:0.2000:0.5000:0.0200';
  const secondId = '1:0.7800:0.1000:0.0400:0.5000';
  const previous = {
    values: { [firstId]: 'Primera', [secondId]: 'Segunda' },
    fields: {
      [firstId]: { page: 1, x: 0.1, y: 0.2, w: 0.5, h: 0.02, kind: 'line' },
      [secondId]: { page: 1, x: 0.78, y: 0.1, w: 0.04, h: 0.5, kind: 'line', rotated: true }
    }
  };
  const { context, element, persisted } = harness(previous);
  const page = element('div');
  context.createAnswerLayer(page, [field], viewport, 1);
  assert.equal(page.children[0].children[0].value, '');
  assert.equal(persisted().values[firstId], 'Primera');
  assert.equal(persisted().values[secondId], 'Segunda');
});

test('an explicitly erased answer stays empty even when a legacy geometry match exists', () => {
  const oldId = '1:0.1000:0.2000:0.5000:0.0200';
  const field = { id: 'replacement', x: 0.1, y: 0.2, w: 0.5, h: 0.02, kind: 'line' };
  const previous = {
    values: { [oldId]: 'Texto anterior', '1:replacement': '' },
    fields: { [oldId]: { page: 1, x: 0.1, y: 0.2, w: 0.5, h: 0.02, kind: 'line' } }
  };
  const { context, element, persisted } = harness(previous);
  const page = element('div');
  context.createAnswerLayer(page, [field], viewport, 1);
  assert.equal(page.children[0].children[0].value, '');
  assert.equal(persisted().values['1:replacement'], '');
  assert.equal(persisted().fields[oldId].aliasFor, undefined);
});

test('a saved line answer survives a shorter field aligned to the same printed baseline', () => {
  const oldId = '1:0.1000:0.2000:0.5000:0.0320';
  const previous = {
    values: { [oldId]: 'Respuesta sobre el mismo renglón' },
    fields: { [oldId]: { page: 1, x: 0.1, y: 0.2, w: 0.5, h: 0.032, kind: 'line' } }
  };
  const { context, element, persisted } = harness(previous);
  const page = element('div');
  context.createAnswerLayer(page, [{ id: 'aligned-line', x: 0.1, y: 0.218, w: 0.5, h: 0.014, kind: 'line', verified: true }], viewport, 1);
  assert.equal(page.children[0].children[0].value, previous.values[oldId]);
  assert.equal(persisted().values[oldId], previous.values[oldId]);
});
