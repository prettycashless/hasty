import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configPath,
  defaultConfig,
  describeProvider,
  loadConfig,
  needsSetup,
  normalizeConfig,
  redactedConfig,
  resolveProvider,
  saveConfig,
  setActiveProvider,
  setProviderKey,
} from '../src/config.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hasty-config-'));
process.env.HASTY_HOME = home;

const ENV_KEYS = [
  'HASTY_API_KEY',
  'HASTY_PROVIDER',
  'HASTY_MODEL',
  'HASTY_BASE_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
];
const savedEnv = new Map();
for (const key of ENV_KEYS) {
  savedEnv.set(key, process.env[key]);
  delete process.env[key];
}

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('defaultConfig has safe approval defaults', () => {
  const config = defaultConfig();
  assert.equal(config.approvalMode, 'ask');
  assert.equal(config.shell, 'auto');
  assert.equal(config.plugins.enabled, true);
  assert.equal(config.privacy.protectCredentials, true);
});

test('normalizeConfig clamps invalid values', () => {
  const config = normalizeConfig({
    approvalMode: 'bogus',
    contextWindow: 1,
    maxSteps: 0,
    maxToolOutput: 1,
  });
  assert.equal(config.approvalMode, 'ask');
  assert.equal(config.contextWindow, 4096);
  assert.equal(config.maxSteps, 1);
  assert.equal(config.maxToolOutput, 1000);
});

test('saveConfig and loadConfig round-trip and redact secrets', async () => {
  const config = defaultConfig();
  setActiveProvider(config, 'custom', 'test-model', 'http://localhost:9999/v1');
  setProviderKey(config, 'custom', 'sk-abcdefghijkl');
  config.github.token = 'ghp-abcdefghijkl';
  await saveConfig(config);

  assert.ok(fs.existsSync(configPath()));
  const loaded = await loadConfig();
  assert.equal(loaded.provider, 'custom');
  assert.equal(loaded.model, 'test-model');
  assert.equal(loaded.providers.custom.baseUrl, 'http://localhost:9999/v1');
  assert.equal(loaded.providers.custom.apiKey, 'sk-abcdefghijkl');

  const redacted = redactedConfig(loaded);
  assert.equal(redacted.providers.custom.apiKey, 'sk-a…ijkl');
  assert.equal(redacted.github.token, 'ghp-…ijkl');
});

test('resolveProvider reports the key source with config and env precedence', () => {
  const config = defaultConfig();
  config.provider = 'openai';
  config.model = 'gpt-test';
  config.providers.openai = { apiKey: 'config-key-123456' };

  try {
    let runtime = resolveProvider(config);
    assert.equal(runtime.apiKey, 'config-key-123456');
    assert.equal(runtime.keySource, 'config');

    process.env.HASTY_API_KEY = 'global-key-123456';
    runtime = resolveProvider(config);
    assert.equal(runtime.apiKey, 'global-key-123456');
    assert.equal(runtime.keySource, 'HASTY_API_KEY');
    delete process.env.HASTY_API_KEY;

    // A key saved through setup wins over the provider's generic env variable.
    process.env.OPENAI_API_KEY = 'env-key-123456';
    runtime = resolveProvider(config);
    assert.equal(runtime.apiKey, 'config-key-123456');
    assert.equal(runtime.keySource, 'config');

    // Without a saved key, the provider env variable is used.
    config.providers.openai = {};
    runtime = resolveProvider(config);
    assert.equal(runtime.apiKey, 'env-key-123456');
    assert.equal(runtime.keySource, 'OPENAI_API_KEY');
  } finally {
    delete process.env.HASTY_API_KEY;
    delete process.env.OPENAI_API_KEY;
  }

  config.providers.openai = { apiKey: 'config-key-123456' };
  const info = describeProvider(config);
  assert.equal(info.hasKey, true);
  assert.equal(info.keyPreview, 'conf…3456');
});

test('needsSetup understands keyless local providers', () => {
  try {
    const config = defaultConfig();
    config.provider = 'ollama';
    config.model = 'qwen2.5-coder:7b';
    assert.equal(needsSetup(config), false);

    config.provider = 'openai';
    config.model = '';
    assert.equal(needsSetup(config), true);
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.HASTY_API_KEY;
  }
});

test('setActiveProvider selects the default model when switching', () => {
  const config = defaultConfig();
  setActiveProvider(config, 'anthropic', '');
  assert.equal(config.provider, 'anthropic');
  assert.equal(config.model, 'claude-sonnet-4-5');
});
