import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const bin = path.join(root, 'bin', 'hasty.js');
const homes = [];
const home = freshHome('hasty-cli-');

function freshHome(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  homes.push(dir);
  return dir;
}

const ENV_KEYS = [
  'HASTY_API_KEY',
  'HASTY_PROVIDER',
  'HASTY_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
];
const env = { ...process.env, HASTY_HOME: home };
for (const key of ENV_KEYS) delete env[key];

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

after(() => {
  for (const dir of homes) fs.rmSync(dir, { recursive: true, force: true });
});

test('--version prints the package version', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^hasty \d+\.\d+\.\d+/);
});

test('--help prints commands and options', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage/);
  assert.match(result.stdout, /setup/);
  assert.match(result.stdout, /--json/);
});

test('unknown options fail with a usage message', () => {
  const result = run(['--wat']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option/);
});

test('config set and get persist values', () => {
  const set = run(['config', 'set', 'approvalMode', 'auto']);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /approvalMode/);

  const get = run(['config', 'get', 'approvalMode']);
  assert.equal(get.status, 0);
  assert.equal(get.stdout.trim(), 'auto');

  const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(raw.approvalMode, 'auto');
});

test('config show redacts API keys', () => {
  const set = run(['config', 'set', 'providers.openai.apiKey', 'sk-secret-value']);
  assert.equal(set.status, 0, set.stderr);

  const show = run(['config', 'show']);
  assert.equal(show.status, 0);
  assert.doesNotMatch(show.stdout, /sk-secret-value/);
  assert.match(show.stdout, /sk-s…alue/);
});

test('plugins path reports the plugin directory', () => {
  const result = run(['plugins', 'path']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), path.join(home, 'plugins'));
});

test('sessions shows an empty state for a fresh directory', () => {
  const result = run(['sessions']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No saved sessions/);
});

test('doctor reports missing credentials without crashing', () => {
  const result = run(['doctor'], { env: { HASTY_HOME: freshHome('hasty-cli-doctor-') } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Hasty doctor/);
  assert.match(result.stdout, /missing for OpenAI/);
});

test('print mode refuses to run without a configured provider', () => {
  const result = run(['-p', 'hello'], { env: { HASTY_HOME: freshHome('hasty-cli-print-') } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No model provider is configured/);
});
