const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActionAssets } = require('../api/_lib/cms/action-assets');

test('raw client assets are discarded in favor of validated receipts', () => {
  const forged = { validated: true, url: 'https://attacker.invalid/file.pdf' };
  const safe = resolveActionAssets({
    type: 'lesson.add',
    asset: forged,
    assetToken: 'signed-token'
  }, token => ({ validated: true, url: `https://trusted.invalid/${token}` }));

  assert.notEqual(safe.asset, forged);
  assert.equal(safe.asset.url, 'https://trusted.invalid/signed-token');
});

test('whole-course imports resolve each receipt and discard nested raw assets', () => {
  const safe = resolveActionAssets({
    type: 'course.add',
    lessons: [
      { title: 'Uno', assetToken: 'one', asset: { url: 'https://attacker.invalid/one' } },
      { title: 'Dos', assetToken: 'two', asset: { url: 'https://attacker.invalid/two' } }
    ]
  }, token => ({ validated: true, pathname: `cms/assets/${token}` }));

  assert.deepEqual(safe.lessons, [
    { title: 'Uno', asset: { validated: true, pathname: 'cms/assets/one' } },
    { title: 'Dos', asset: { validated: true, pathname: 'cms/assets/two' } }
  ]);
});

test('whole-course replacements resolve every asset from a signed token', () => {
  const safe = resolveActionAssets({
    type: 'course.replaceLessons',
    lessons: [
      { title: 'Uno', assetToken: 'one', asset: { url: 'https://attacker.invalid/one' } },
      { title: 'Dos', assetToken: 'two', asset: { url: 'https://attacker.invalid/two' } }
    ]
  }, token => ({ validated: true, pathname: `cms/assets/${token}` }));
  assert.deepEqual(safe.lessons, [
    { title: 'Uno', asset: { validated: true, pathname: 'cms/assets/one' } },
    { title: 'Dos', asset: { validated: true, pathname: 'cms/assets/two' } }
  ]);
});
