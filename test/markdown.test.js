import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownStream } from '../src/ui/markdown.js';

function render(input) {
  const chunks = [];
  const stream = new MarkdownStream({ out: { write: (chunk) => chunks.push(chunk) } });
  stream.push(input);
  stream.end();
  return chunks.join('');
}

test('markdown renders headings and inline code', () => {
  const output = render('# Title\n\nUse `npm test` here.\n');
  assert.match(output, /Title/);
  assert.match(output, /npm test/);
});

test('markdown renders fenced code blocks with a gutter', () => {
  const output = render('```js\nconst x = 1;\n```\n');
  assert.match(output, /js/);
  assert.match(output, /const x = 1;/);
});

test('markdown sanitizes terminal escape sequences from model output', () => {
  const output = render('hello \u001b[31mred\u001b[0m\n');
  assert.doesNotMatch(output, /\u001b\[31m/);
  assert.match(output, /hello red/);
});
