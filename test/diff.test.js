import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/diff.js';
import { applyEdit } from '../src/tools/files.js';

test('diffLines reports no changes for identical text', () => {
  const diff = diffLines('one\ntwo\nthree', 'one\ntwo\nthree');
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
  assert.equal(diff.hunks.length, 0);
});

test('diffLines tracks additions and removals', () => {
  const diff = diffLines('one\ntwo\nthree', 'one\nTWO\nthree\nfour');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  const lines = diff.hunks.flatMap((hunk) => hunk.lines);
  assert.ok(lines.some((line) => line.type === 'del' && line.text === 'two'));
  assert.ok(lines.some((line) => line.type === 'add' && line.text === 'TWO'));
  assert.ok(lines.some((line) => line.type === 'add' && line.text === 'four'));
});

test('applyEdit tolerates LF edit strings against CRLF files', () => {
  const original = 'alpha\r\nbeta\r\ngamma\r\n';
  const result = applyEdit(original, 'alpha\nbeta\n', 'alpha\nBETA\n');
  assert.equal(result.error, undefined);
  assert.equal(result.content, 'alpha\r\nBETA\r\ngamma\r\n');
});

test('applyEdit requires unique matches unless replaceAll is set', () => {
  const original = 'x\nx\n';
  const single = applyEdit(original, 'x', 'y');
  assert.match(single.error, /occurs 2 times/);
  const all = applyEdit(original, 'x', 'y', true);
  assert.equal(all.count, 2);
  assert.equal(all.content, 'y\ny\n');
});

test('applyEdit fails clearly when the text is missing', () => {
  const result = applyEdit('hello\n', 'nope', 'yes');
  assert.match(result.error, /not found/);
});
