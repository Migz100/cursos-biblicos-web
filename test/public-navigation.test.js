const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const course = fs.readFileSync(path.join(__dirname, '..', 'course.js'), 'utf8').replace(/\r\n/g, '\n');

test('course files opened in a new tab cannot control the course page', () => {
  assert.match(course, /open\.target = '_blank';\s+open\.rel = 'noopener noreferrer';/);
});
