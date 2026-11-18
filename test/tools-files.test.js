import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileTools } from '../src/tools/files.js';
import { newSession } from '../src/session.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hasty-files-'));
const home = path.join(cwd, '.hasty-home');
process.env.HASTY_HOME = home;

after(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

const tools = new Map(createFileTools().map((tool) => [tool.name, tool]));

function context(overrides = {}) {
  const session = newSession({ cwd, provider: 'openai', model: 'test' });
  const snapshots = [];
  return {
    cwd,
    config: {},
    session,
    ignoreRules: [],
    maxOutput: 60_000,
    maxReadBytes: 4_000_000,
    snapshots,
    async approve() {
      return { allowed: true, reason: 'test' };
    },
    async snapshot(file, oldContent) {
      snapshots.push({ file, oldContent });
    },
    ...overrides,
  };
}

test('write_file creates, then read_file returns numbered lines', async () => {
  const ctx = context();
  const write = await tools.get('write_file').run({
    path: 'hello.txt',
    content: 'one\ntwo\nthree\n',
  }, ctx);
  assert.equal(write.isError, undefined);
  assert.match(write.content, /Created hello\.txt/);
  assert.equal(ctx.snapshots.length, 1);
  assert.equal(ctx.snapshots[0].oldContent, null);

  const read = await tools.get('read_file').run({ path: 'hello.txt' }, ctx);
  assert.match(read.content, /hello\.txt — lines 1-4 of 4/);
  assert.match(read.content, /1  one/);
  assert.match(read.content, /3  three/);
});

test('edit_file updates text and preserves CRLF line endings', async () => {
  const ctx = context();
  fs.writeFileSync(path.join(cwd, 'windows.txt'), 'alpha\r\nbeta\r\ngamma\r\n');

  const edit = await tools.get('edit_file').run({
    path: 'windows.txt',
    old_string: 'alpha\nbeta\n',
    new_string: 'alpha\nBETA\n',
  }, ctx);

  assert.equal(edit.isError, undefined);
  assert.match(edit.content, /1 replacement/);
  assert.equal(fs.readFileSync(path.join(cwd, 'windows.txt'), 'utf8'), 'alpha\r\nBETA\r\ngamma\r\n');
});

test('edit_file rejects ambiguous matches', async () => {
  const ctx = context();
  fs.writeFileSync(path.join(cwd, 'dupes.txt'), 'same\nsame\n');
  const edit = await tools.get('edit_file').run({
    path: 'dupes.txt',
    old_string: 'same',
    new_string: 'different',
  }, ctx);
  assert.equal(edit.isError, true);
  assert.match(edit.content, /occurs 2 times/);
});

test('grep_search and glob_search find files and content', async () => {
  const ctx = context();
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'app.js'), 'const secret = "needle";\n');
  fs.writeFileSync(path.join(cwd, 'src', 'other.ts'), 'export const other = 1;\n');

  const grep = await tools.get('grep_search').run({ pattern: 'needle' }, ctx);
  assert.match(grep.content, /app\.js:1: const secret/);

  const glob = await tools.get('glob_search').run({ pattern: '**/*.ts' }, ctx);
  assert.match(glob.content, /src\/other\.ts/);
  assert.doesNotMatch(glob.content, /app\.js/);
});

test('list_dir and delete_file work end to end', async () => {
  const ctx = context();
  fs.mkdirSync(path.join(cwd, 'folder'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'folder', 'note.txt'), 'bye\n');

  const listing = await tools.get('list_dir').run({ path: 'folder' }, ctx);
  assert.match(listing.content, /note\.txt/);

  const deleted = await tools.get('delete_file').run({ path: 'folder/note.txt' }, ctx);
  assert.equal(deleted.isError, undefined);
  assert.equal(fs.existsSync(path.join(cwd, 'folder', 'note.txt')), false);
});

test('write_file refuses protected credential paths', async () => {
  const ctx = context();
  const target = path.join(home, 'config.json');
  const result = await tools.get('write_file').run({ path: target, content: '{}' }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content, /protects credential/i);
});
