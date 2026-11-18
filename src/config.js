import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJsonAtomic, ensureDirSync, maskSecret } from './util.js';

export const CONFIG_VERSION = 1;

export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1',
    env: ['OPENAI_API_KEY'],
    docs: 'https://platform.openai.com/api-keys',
    hint: 'GPT and o-series models. Standard OpenAI billing.',
  },
  anthropic: {
    label: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    env: ['ANTHROPIC_API_KEY'],
    docs: 'https://console.anthropic.com/settings/keys',
    hint: 'Claude models. Excellent at coding and tool use.',
  },
  google: {
    label: 'Google Gemini',
    type: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-pro',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    docs: 'https://aistudio.google.com/apikey',
    hint: 'Gemini models. Generous free tier available.',
  },
  openrouter: {
    label: 'OpenRouter',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    env: ['OPENROUTER_API_KEY'],
    docs: 'https://openrouter.ai/keys',
    hint: 'One key for hundreds of models from many providers.',
  },
  groq: {
    label: 'Groq',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    env: ['GROQ_API_KEY'],
    docs: 'https://console.groq.com/keys',
    hint: 'Very fast inference. Free tier with rate limits.',
  },
  deepseek: {
    label: 'DeepSeek',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    env: ['DEEPSEEK_API_KEY'],
    docs: 'https://platform.deepseek.com/api_keys',
    hint: 'Low-cost coding models.',
  },
  xai: {
    label: 'xAI Grok',
    type: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3',
    env: ['XAI_API_KEY'],
    docs: 'https://console.x.ai',
    hint: 'Grok models via the OpenAI-compatible API.',
  },
  mistral: {
    label: 'Mistral',
    type: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    env: ['MISTRAL_API_KEY'],
    docs: 'https://console.mistral.ai/api-keys',
    hint: 'Mistral and Codestral models.',
  },
  ollama: {
    label: 'Ollama (local)',
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
    env: [],
    keyless: true,
    docs: 'https://ollama.com/download',
    hint: 'Runs on your machine. No API key, no cloud bill.',
  },
  lmstudio: {
    label: 'LM Studio (local)',
    type: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    env: [],
    keyless: true,
    docs: 'https://lmstudio.ai',
    hint: 'Local OpenAI-compatible server from LM Studio.',
  },
  custom: {
    label: 'Custom endpoint',
    type: 'openai',
    baseUrl: '',
    defaultModel: '',
    env: ['HASTY_API_KEY'],
    docs: '',
    hint: 'Any OpenAI-compatible base URL: a proxy, gateway, or self-hosted model.',
  },
};

export const SETUP_PROVIDER_ORDER = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'groq',
  'deepseek',
  'xai',
  'mistral',
  'ollama',
  'lmstudio',
  'custom',
];

export function hastyHome() {
  const configured = process.env.HASTY_HOME;
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), '.hasty');
}

export function configPath() {
  return path.join(hastyHome(), 'config.json');
}

export function sessionsDir() {
  return path.join(hastyHome(), 'sessions');
}

export function backupsDir() {
  return path.join(hastyHome(), 'backups');
}

export function pluginsDir() {
  return path.join(hastyHome(), 'plugins');
}

export function historyPath() {
  return path.join(hastyHome(), 'history');
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    provider: 'openai',
    model: '',
    temperature: 0.2,
    maxTokens: 8192,
    contextWindow: 128000,
    maxSteps: 50,
    approvalMode: 'ask',
    shell: 'auto',
    providers: {},
    github: {
      token: '',
      apiUrl: 'https://api.github.com',
    },
    search: {
      braveApiKey: '',
      tavilyApiKey: '',
    },
    mcpServers: {},
    plugins: {
      enabled: true,
    },
    privacy: {
      protectCredentials: true,
    },
    ui: {
      showBanner: true,
      showUsage: true,
      showToolOutput: true,
    },
    maxToolOutput: 60000,
  };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, extra) {
  if (!isPlainObject(extra)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export function normalizeConfig(input) {
  const config = deepMerge(defaultConfig(), input || {});
  config.version = CONFIG_VERSION;
  config.provider = String(config.provider || 'openai');
  config.model = String(config.model || '');
  config.temperature = clampNumber(config.temperature, 0, 2, 0.2);
  config.maxTokens = clampInt(config.maxTokens, 256, 131072, 8192);
  config.contextWindow = clampInt(config.contextWindow, 4096, 2_000_000, 128000);
  config.maxSteps = clampInt(config.maxSteps, 1, 200, 50);
  config.maxToolOutput = clampInt(config.maxToolOutput, 1000, 500_000, 60000);
  config.approvalMode = ['ask', 'auto', 'yolo'].includes(config.approvalMode)
    ? config.approvalMode
    : 'ask';
  config.providers = isPlainObject(config.providers) ? config.providers : {};
  config.mcpServers = isPlainObject(config.mcpServers) ? config.mcpServers : {};
  if (!isPlainObject(config.github)) config.github = { token: '', apiUrl: 'https://api.github.com' };
  if (!isPlainObject(config.search)) config.search = { braveApiKey: '', tavilyApiKey: '' };
  if (!isPlainObject(config.plugins)) config.plugins = { enabled: true };
  if (!isPlainObject(config.privacy)) config.privacy = { protectCredentials: true };
  if (!isPlainObject(config.ui)) config.ui = { showBanner: true, showUsage: true, showToolOutput: true };
  return config;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.trunc(Math.min(max, Math.max(min, number)));
}

export async function loadConfig({ validate = true } = {}) {
  ensureDirSync(hastyHome(), 0o700);
  let fileConfig = {};
  try {
    fileConfig = await readJson(configPath(), {}) || {};
  } catch (error) {
    throw new Error(
      `${error.message}\nFix or delete ${configPath()} and run \`hasty setup\`.`,
    );
  }
  const config = normalizeConfig(fileConfig);
  if (validate && config.version !== fileConfig.version && fs.existsSync(configPath())) {
    // Newer defaults were merged in. Persist on the next save; no migration is needed yet.
  }
  return config;
}

export async function saveConfig(config) {
  const normalized = normalizeConfig(config);
  ensureDirSync(hastyHome(), 0o700);
  await writeJsonAtomic(configPath(), normalized, 0o600);
  return normalized;
}

export function providerPreset(name) {
  return PROVIDERS[name] || { ...PROVIDERS.custom, label: name };
}

export function providerOverride(config, name) {
  return config.providers?.[name] || {};
}

/** Resolve the runtime provider settings, including env var overrides. */
export function resolveProvider(config, name = null) {
  const activeName = name || process.env.HASTY_PROVIDER || config.provider || 'openai';
  const preset = providerPreset(activeName);
  const override = providerOverride(config, activeName);
  const type = override.type || preset.type || 'openai';
  const envNames = preset.env || [];
  let apiKey = '';
  let keySource = 'none';
  if (process.env.HASTY_API_KEY) {
    apiKey = process.env.HASTY_API_KEY;
    keySource = 'HASTY_API_KEY';
  } else if (override.apiKey) {
    apiKey = override.apiKey;
    keySource = 'config';
  } else {
    for (const envName of envNames) {
      if (process.env[envName]) {
        apiKey = process.env[envName];
        keySource = envName;
        break;
      }
    }
  }
  const baseUrl = String(
    process.env.HASTY_BASE_URL || override.baseUrl || preset.baseUrl || '',
  ).replace(/\/+$/, '');
  const sameProvider = activeName === config.provider;
  const configuredModel = sameProvider ? config.model : '';
  const model = process.env.HASTY_MODEL
    || (name && !sameProvider ? override.defaultModel : '')
    || configuredModel
    || override.defaultModel
    || preset.defaultModel
    || '';
  return {
    name: activeName,
    label: preset.label || activeName,
    type,
    baseUrl,
    apiKey,
    keySource,
    model,
    keyless: Boolean(preset.keyless),
    docs: preset.docs || '',
    hint: preset.hint || '',
    maxTokens: config.maxTokens,
    temperature: config.temperature,
  };
}

export function activeProviderName(config) {
  return process.env.HASTY_PROVIDER || config.provider;
}

export function needsSetup(config) {
  const runtime = resolveProvider(config);
  if (!runtime.baseUrl) return true;
  if (!runtime.model) return true;
  if (runtime.keyless) return false;
  return !runtime.apiKey;
}

export function setActiveProvider(config, name, model, baseUrl = null) {
  const preset = providerPreset(name);
  config.provider = name;
  config.model = model || preset.defaultModel || '';
  if (baseUrl) {
    config.providers[name] = { ...(config.providers[name] || {}), baseUrl };
  }
  return config;
}

export function setProviderKey(config, name, apiKey) {
  config.providers[name] = {
    ...(config.providers[name] || {}),
    apiKey: String(apiKey || '').trim(),
  };
  return config;
}

export function githubToken(config) {
  return process.env.GITHUB_TOKEN
    || process.env.GH_TOKEN
    || config.github?.token
    || '';
}

export function searchKeys(config) {
  return {
    brave: process.env.BRAVE_SEARCH_API_KEY || config.search?.braveApiKey || '',
    tavily: process.env.TAVILY_API_KEY || config.search?.tavilyApiKey || '',
  };
}

export function redactedConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const data of Object.values(copy.providers || {})) {
    if (data?.apiKey) data.apiKey = maskSecret(data.apiKey);
  }
  if (copy.github?.token) copy.github.token = maskSecret(copy.github.token);
  if (copy.search?.braveApiKey) copy.search.braveApiKey = maskSecret(copy.search.braveApiKey);
  if (copy.search?.tavilyApiKey) copy.search.tavilyApiKey = maskSecret(copy.search.tavilyApiKey);
  for (const server of Object.values(copy.mcpServers || {})) {
    if (server?.env) {
      for (const key of Object.keys(server.env)) {
        if (/key|token|secret|password|auth/i.test(key)) {
          server.env[key] = maskSecret(server.env[key]);
        }
      }
    }
  }
  return copy;
}

export function describeProvider(config, name = null) {
  const runtime = resolveProvider(config, name);
  return {
    ...runtime,
    hasKey: Boolean(runtime.apiKey) || runtime.keyless,
    keyPreview: runtime.apiKey ? maskSecret(runtime.apiKey) : '',
  };
}
