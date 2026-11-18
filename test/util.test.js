import test from 'node:test';
import assert from 'node:assert/strict';
import {
  globToRegExp,
  isSubPath,
  maskSecret,
  sanitizeText,
  splitArgs,
  stripAnsi,
  truncateEnd,
  truncateMiddle,
} from '../src/util.js';

test('stripAnsi removes color and OSC sequences', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripAnsi('\u001b]0;title\u0007text'), 'text');
});

test('sanitizeText removes control characters and bidi overrides but keeps tabs', () => {
  assert.equal(sanitizeText('a\u0000b\tc\u202ed'), 'ab\tcd');
  assert.equal(sanitizeText('line\r\nnext'), 'line\nnext');
});

test('globToRegExp handles stars, globstars, braces, and classes', () => {
  assert.equal(globToRegExp('*.js').test('index.js'), true);
  assert.equal(globToRegExp('*.js').test('src/index.js'), false);
  assert.equal(globToRegExp('**/*.js').test('src/deep/index.js'), true);
  assert.equal(globToRegExp('src/**/*.{ts,tsx}').test('src/a/b.tsx'), true);
  assert.equal(globToRegExp('src/**/*.{ts,tsx}').test('src/a/b.js'), false);
  assert.equal(globToRegExp('file[0-9].txt').test('file3.txt'), true);
});

test('splitArgs respects quotes and escapes', () => {
  assert.deepEqual(splitArgs('one "two three" \'four five\''), ['one', 'two three', 'four five']);
  assert.deepEqual(splitArgs('a\\ b c'), ['a b', 'c']);
  assert.deepEqual(splitArgs(''), []);
});

test('isSubPath is boundary-safe', () => {
  assert.equal(isSubPath('/workspace', '/workspace/src/a.js'), true);
  assert.equal(isSubPath('/workspace', '/workspace-evil/a.js'), false);
  assert.equal(isSubPath('/workspace', '/workspace'), true);
});

test('secret masking keeps a short preview only for long values', () => {
  assert.equal(maskSecret('short'), '••••');
  assert.equal(maskSecret('sk-1234567890'), 'sk-1…7890');
});

test('truncation helpers label what was removed', () => {
  assert.match(truncateEnd('abcdef', 3, 'file'), /abc/);
  assert.match(truncateEnd('abcdef', 3, 'file'), /3 chars of file truncated/);
  assert.match(truncateMiddle('abcdefghij', 5, 'output'), /output truncated/);
});
