const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.ANSWER_TEST_ROOT || path.join(__dirname, '..');
const reader = fs.readFileSync(path.join(root, 'reader.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

function sourceFunction(name) {
  const start = reader.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing reader function ${name}`);
  const open = reader.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < reader.length; index += 1) {
    if (reader[index] === '{') depth += 1;
    else if (reader[index] === '}' && --depth === 0) return reader.slice(start, index + 1);
  }
  throw new Error(`unclosed reader function ${name}`);
}

function element(tagName) {
  const classes = new Set();
  return {
    tagName, style: {}, dataset: {}, attributes: {}, children: [], listeners: {},
    classList: {
      add(name) { classes.add(name); },
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); },
    addEventListener(name, listener) { this.listeners[name] = listener; }
  };
}

function harness(storedAnswers = { values: {}, fields: {} }) {
  const storage = new Map([['existing-lesson-key', JSON.stringify(storedAnswers)]]);
  const context = {
    document: { createElement: element },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); }
    },
    answerKey: () => 'existing-lesson-key',
    answerState: { values: {}, fields: {} },
    pageNum: 1,
    updateAnswerHint() {}
  };
  vm.createContext(context);
  vm.runInContext([
    'rotateGeometry', 'restoreAlignedAnswer', 'minimumTargetGeometry', 'fieldId', 'mergeFields', 'loadAnswers', 'saveAnswers', 'createAnswerLayer'
  ].map(sourceFunction).join('\n'), context);
  context.loadAnswers();
  return { context, storage };
}

const fields = [
  { id: 'printed-line', x: 0.12, y: 0.35, w: 0.54, h: 0.02, kind: 'line' },
  { id: 'native-short', x: 0.72, y: 0.35, w: 0.025, h: 0.012, kind: 'widget', native: true },
  { id: 'answer-box', x: 0.15, y: 0.7, w: 0.6, h: 0.08, kind: 'box' }
];

for (const viewport of [{ width: 350, height: 500 }, { width: 840, height: 1200 }]) {
  test(`answer geometry stays on the printed space at ${viewport.width}px page width`, () => {
    const { context } = harness();
    const page = element('div');
    context.createAnswerLayer(page, fields, viewport, 1);
    const inputs = page.children[0].children;
    assert.equal(inputs.length, fields.length);
    for (const [index, field] of fields.entries()) {
      const input = inputs[index];
      assert.equal(input.tagName, 'textarea');
      for (const [css, coordinate] of [['left', 'x'], ['top', 'y'], ['width', 'w'], ['height', 'h']]) {
        assert.equal(input.style[css], `${field[coordinate] * 100}%`, `${field.id} ${css}`);
      }
      assert.ok(parseFloat(input.style.fontSize) <= viewport.height * field.h,
        `${field.id} font must fit its printed height`);
    }
    assert.equal(page.dataset.fieldCount, String(fields.length));
  });
}

test('typing saves under the existing answer ID and survives reconstruction without removing other answers', () => {
  const previous = { values: { '1:printed-line': 'Mi respuesta anterior', '4:unrendered': 'Conservar' }, fields: {} };
  const { context, storage } = harness(previous);
  const page = element('div');
  context.createAnswerLayer(page, fields, { width: 350, height: 500 }, 1);
  const input = page.children[0].children[0];
  assert.equal(input.value, 'Mi respuesta anterior');
  input.value = 'Mi nueva respuesta: Jesús es mi esperanza.';
  input.listeners.input();
  const persisted = JSON.parse(storage.get('existing-lesson-key'));
  assert.equal(persisted.values['1:printed-line'], input.value);
  assert.equal(persisted.values['4:unrendered'], 'Conservar');
  const reloaded = harness(persisted).context;
  const desktop = element('div');
  reloaded.createAnswerLayer(desktop, fields, { width: 840, height: 1200 }, 1);
  assert.equal(desktop.children[0].children[0].value, input.value);
});

test('native PDF blanks keep their original small dimensions when fields are normalized', () => {
  const { context } = harness();
  const original = fields[1];
  const normalized = context.mergeFields([original])[0];
  for (const key of ['id', 'x', 'y', 'w', 'h', 'kind', 'native']) {
    assert.equal(normalized[key], original[key], key);
  }
});

test('native fields crossing the PDF crop keep their original visible position', () => {
  const { context } = harness();
  const pageWidth = 608.9140014648438;
  const original = { id: 'widget-210R', kind: 'widget', native: true,
    x: 605.5369873046875 / pageWidth, y: 0.6877982463730238,
    w: (609.8569946289062 - 605.5369873046875) / pageWidth, h: 0.088564732 }
  const normalized = context.mergeFields([original])[0];
  assert.equal(normalized.x, original.x);
  assert.equal(normalized.y, original.y);
  assert.equal(normalized.w, 1 - original.x);
  assert.equal(normalized.h, original.h);
});

test('verified crop intersections do not expand tiny fields or move outside fields onto the page', () => {
  const { context } = harness();
  const inside = context.mergeFields([{ id: 'tiny', x: 0.5, y: 0.5, w: 0.0005, h: 0.0004, verified: true }])[0];
  assert.equal(inside.w, 0.0005);
  assert.equal(inside.h, 0.0004);
  const clipped = context.mergeFields([{ x: -0.02, y: -0.01, w: 0.1, h: 0.04, rotated: true }])[0];
  assert.equal(clipped.x, 0);
  assert.equal(clipped.y, 0);
  assert.equal(clipped.w, 0.08);
  assert.equal(clipped.h, 0.03);
  assert.equal(context.mergeFields([{ x: 1.1, y: 0.1, w: 0.05, h: 0.04, native: true }]).length, 0);
});

test('answer CSS cannot enlarge printed spaces through desktop, phone, or focus minimum sizes', () => {
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => /\.answerField\b/.test(selectors));
  assert.ok(rules.length > 0);
  for (const [, selectors, declarations] of rules) {
    for (const [, property, value] of declarations.matchAll(/\b(min-width|min-height)\s*:\s*([^;]+)/g)) {
      assert.match(value.trim(), /^0(?:px|rem|em|%)?$/, `${selectors.trim()} ${property} expands the printed space`);
    }
  }
});

test('native tap labels activate the existing controls without changing their printed geometry', () => {
  const { context } = harness();
  const page = element('div');
  const choice = { id: 'small-check', x: 0.3, y: 0.6, w: 0.015, h: 0.015, kind: 'check' };
  context.createAnswerLayer(page, [fields[0], choice], { width: 350, height: 500 }, 1);
  const [controls, targets] = page.children;
  assert.equal(targets.className, 'answerTapLayer');
  assert.equal(targets.children.length, 2);
  targets.children.forEach((label, index) => {
    assert.equal(label.tagName, 'label');
    assert.equal(label.htmlFor, controls.children[index].id);
    assert.deepEqual(Object.keys(label.listeners), [], 'native labels must not double-trigger a choice');
  });
  assert.equal(parseFloat(targets.children[0].style.height), fields[0].h * 500 + 6);
  assert.ok(parseFloat(targets.children[1].style.width) >= 24);
  assert.ok(parseFloat(targets.children[1].style.height) >= 24);
  assert.equal(controls.children[1].style.width, `${choice.w * 100}%`);
  assert.equal(controls.children[1].style.height, `${choice.h * 100}%`);
});
