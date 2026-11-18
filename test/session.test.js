import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  latestSession,
  listSessions,
  loadSession,
  newSession,
  saveSession,
  snapshotFile,
  undoLast,
} from '../src/session.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hasty-session-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hasty-project-'));
process.env.HASTY_HOME = home;

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('sessions save, list, and load', async () => {
  const session = newSession({ cwd, provider: 'openai', model: 'gpt-test' });
  session.title = 'Test session';
  session.messages.push({ role: 'user', content: 'hello' });
  await saveSession(session);

  const summaries = await listSessions({ cwd });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, session.id);
  assert.equal(summaries[0].title, 'Test session');

  const latest = await latestSession(cwd);
  assert.equal(latest.id, session.id);

  const loaded = await loadSession(session.id);
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].content, 'hello');
});

test('snapshotFile and undoLast restore an existing file', async () => {
  const session = newSession({ cwd, provider: 'openai', model: 'gpt-test' });
  const file = path.join(cwd, 'restore.txt');
  fs.writeFileSync(file, 'old contents\n');

  await snapshotFile(session, file, 'old contents\n');
  fs.writeFileSync(file, 'new contents\n');

  const result = await undoLast(session);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old contents\n');
  assert.equal(session.backups.length, 0);
});

test('undoLast removes a file that did not exist before', async () => {
  const session = newSession({ cwd, provider: 'openai', model: 'gpt-test' });
  const file = path.join(cwd, 'new-file.txt');

  await snapshotFile(session, file, null);
  fs.writeFileSync(file, 'created\n');

  const result = await undoLast(session);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(file), false);
});

test('undoLast is safe with nothing to undo', async () => {
  const session = newSession({ cwd, provider: 'openai', model: 'gpt-test' });
  const result = await undoLast(session);
  assert.equal(result.ok, false);
  assert.match(result.message, /Nothing to undo/);
});
