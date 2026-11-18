import {
  PROVIDERS,
  SETUP_PROVIDER_ORDER,
  providerPreset,
  providerOverride,
  resolveProvider,
  saveConfig,
  setActiveProvider,
  setProviderKey,
  configPath,
  describeProvider,
} from './config.js';
import { createProvider } from './providers/index.js';
import { GithubClient } from './github.js';
import { theme } from './theme.js';
import { truncateEnd } from './util.js';

export async function runSetup({ config, prompter }) {
  const out = prompter.output;
  out.write('\n');
  out.write(`  ${theme.heading('Hasty setup')}\n`);
  out.write(`  ${theme.dim('Bring your own model key. Keys are stored locally in')} ${theme.dim(configPath())}\n`);
  out.write(`  ${theme.dim('(or use provider environment variables).')}\n\n`);

  const providerName = await chooseProvider({ config, prompter });
  if (!providerName) return null;
  const preset = providerPreset(providerName);
  const existing = providerOverride(config, providerName);

  let baseUrl = existing.baseUrl || preset.baseUrl || '';
  if (providerName === 'custom') {
    const answer = await prompter.ask(
      `  ${theme.text('Base URL')} ${theme.dim('(OpenAI-compatible, e.g. https://host/v1)')}: `,
      {
        defaultValue: baseUrl,
        validate: (value) => /^https?:\/\/.+/i.test(value) || 'Enter a valid http(s) URL.',
        onInterrupt: null,
      },
    );
    if (answer == null) return null;
    baseUrl = answer.replace(/\/+$/, '');
  }

  // API key
  let apiKey = existing.apiKey || '';
  let usingEnv = false;
  if (!preset.keyless) {
    const runtime = resolveProvider(config, providerName);
    const envName = preset.env?.find((name) => process.env[name]);
    if (envName) {
      out.write(`  ${theme.success('✓')} Found ${theme.bright(envName)} in the environment.\n`);
      const choice = await prompter.ask(
        `  ${theme.text('Use this environment variable?')} ${theme.dim('[Y/n]')} `,
        { defaultValue: 'y', onInterrupt: 'n' },
      );
      if (choice == null) return null;
      usingEnv = choice.toLowerCase() !== 'n';
      if (usingEnv && apiKey) {
        // Saved keys take precedence over provider environment variables.
        // Choosing the environment here means clearing the stored key.
        setProviderKey(config, providerName, '');
        apiKey = '';
      }
    }
    if (!usingEnv) {
      if (apiKey) out.write(`  ${theme.dim('Saved key:')} ${theme.muted(mask(apiKey))}\n`);
      const entry = await prompter.secret(
        `  ${theme.text(`${preset.label} API key`)}${apiKey ? ` ${theme.dim('(enter to keep)')}` : ''}: `,
      );
      if (entry == null && !apiKey) return null;
      if (entry) apiKey = entry;
      if (!apiKey) {
        out.write(`  ${theme.warn('No key entered. You can set it later with /setup or an environment variable.')}\n`);
      }
      setProviderKey(config, providerName, apiKey);
      if (entry === null) usingEnv = true;
    }
  }

  // Model
  let model = providerName === config.provider
    ? (config.model || preset.defaultModel)
    : (existing.defaultModel || preset.defaultModel);
  model = await prompter.ask(
    `  ${theme.text('Model')} ${theme.dim(`(default ${model || 'none'})`)}: `,
    { defaultValue: model, onInterrupt: null },
  );
  if (model == null) return null;
  if (!model && !preset.keyless) {
    out.write(`  ${theme.warn('A model name is required.')}\n`);
    return null;
  }

  setActiveProvider(config, providerName, model, baseUrl !== preset.baseUrl ? baseUrl : null);
  if (existing.baseUrl && providerName === 'custom') {
    config.providers[providerName].baseUrl = baseUrl;
  }

  // Test
  out.write('\n');
  out.write(`  ${theme.dim('Testing the connection (listing models)…')}\n`);
  let models = [];
  let testError = null;
  try {
    const provider = createProvider(config, { name: providerName, model });
    models = await provider.listModels();
    out.write(`  ${theme.success('✓')} Connected${models.length ? ` — ${models.length} models available` : ''}.\n`);
    if (models.length) {
      const preview = models.slice(0, 12).join(', ');
      out.write(`  ${theme.dim(truncateEnd(preview, 300, 'models'))}\n`);
    }
  } catch (error) {
    testError = error;
    out.write(`  ${theme.warn('!')} Could not verify: ${theme.dim(truncateEnd(error.message, 240, 'error'))}\n`);
    out.write(`  ${theme.dim('This can happen with custom gateways that do not expose /models. You can still save and try.')}\n`);
  }

  if (testError) {
    const proceed = await prompter.ask(`  ${theme.text('Save anyway?')} ${theme.dim('[y/N]')} `, {
      defaultValue: 'n',
      onInterrupt: 'n',
    });
    if (proceed == null || proceed.toLowerCase() !== 'y') {
      out.write(`  ${theme.dim('Setup cancelled. Nothing was saved.')}\n`);
      return null;
    }
  }

  // GitHub (optional)
  out.write('\n');
  const currentGithub = config.github?.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  out.write(`  ${theme.text('GitHub')} ${theme.dim('(optional — powers issues, PRs, repo tools)')}\n`);
  if (currentGithub) {
    out.write(`  ${theme.dim('A GitHub token is already configured.')} ${theme.dim(mask(currentGithub))}\n`);
  }
  const gh = await prompter.secret(
    `  ${theme.text('GitHub token')} ${theme.dim('(enter to skip)')}: `,
  );
  if (gh) {
    const client = new GithubClient({ token: gh, apiUrl: config.github?.apiUrl || 'https://api.github.com' });
    try {
      const user = await client.getUser();
      config.github = { ...(config.github || {}), token: gh };
      out.write(`  ${theme.success('✓')} GitHub connected as @${user.login}.\n`);
    } catch (error) {
      out.write(`  ${theme.warn('!')} GitHub token check failed: ${theme.dim(truncateEnd(error.message, 200, 'error'))}\n`);
      const keep = await prompter.ask(`  ${theme.text('Save the token anyway?')} ${theme.dim('[y/N]')} `, {
        defaultValue: 'n',
        onInterrupt: 'n',
      });
      if (keep?.toLowerCase() === 'y') config.github = { ...(config.github || {}), token: gh };
    }
  }
  if (gh === null) return null;

  // Approvals
  out.write('\n');
  out.write(`  ${theme.text('Approval mode')}\n`);
  out.write(`  ${theme.primary('1)')} ask   ${theme.dim('approve writes, shell, network, plugins (recommended)')}\n`);
  out.write(`  ${theme.primary('2)')} auto  ${theme.dim('auto-approve workspace writes and shell; still ask for network/plugins')}\n`);
  out.write(`  ${theme.primary('3)')} yolo  ${theme.dim('approve almost everything — only for trusted/disposable work')}\n`);
  const modeAnswer = await prompter.ask(`  ${theme.text('Choose')} ${theme.dim('[1]')}: `, {
    defaultValue: '1',
    onInterrupt: '1',
  });
  if (modeAnswer == null) return null;
  const mode = modeAnswer === '2' ? 'auto' : modeAnswer === '3' ? 'yolo' : 'ask';
  config.approvalMode = mode;

  await saveConfig(config);
  out.write('\n');
  out.write(`  ${theme.success('✓')} Configuration saved to ${theme.bright(configPath())}\n`);
  out.write(`  ${theme.dim('Start Hasty with')} ${theme.bright('hasty')} ${theme.dim('in any project.')}\n\n`);
  const info = describeProvider(config);
  out.write(`  ${theme.dim('Active:')} ${theme.bright(`${info.label} / ${info.model}`)}${info.keySource && info.keySource !== 'none' ? ` ${theme.dim(`(${info.keySource})`)}` : ''}\n\n`);
  return config;
}

async function chooseProvider({ config, prompter }) {
  const out = prompter.output;
  out.write(`  ${theme.text('Model provider')}\n`);
  SETUP_PROVIDER_ORDER.forEach((name, index) => {
    const preset = PROVIDERS[name];
    const current = config.provider === name ? theme.success(' (current)') : '';
    out.write(`  ${theme.primary(`${index + 1})`.padEnd(4))} ${theme.bright(preset.label.padEnd(18))}${current}\n`);
    out.write(`      ${theme.dim(preset.hint)}\n`);
  });
  out.write('\n');
  while (true) {
    const answer = await prompter.ask(
      `  ${theme.text('Choose provider')} ${theme.dim(`[1-${SETUP_PROVIDER_ORDER.length}]`)}: `,
      { defaultValue: String(Math.max(1, SETUP_PROVIDER_ORDER.indexOf(config.provider) + 1)), onInterrupt: null },
    );
    if (answer == null) return null;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < SETUP_PROVIDER_ORDER.length) {
      return SETUP_PROVIDER_ORDER[index];
    }
    if (SETUP_PROVIDER_ORDER.includes(answer)) return answer;
    out.write(`  ${theme.warn('Pick a number from the list.')}\n`);
  }
}

function mask(value) {
  const text = String(value || '');
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export async function runGithubLogin({ config, prompter }) {
  const out = prompter.output;
  out.write('\n');
  out.write(`  ${theme.heading('GitHub login')}\n`);
  out.write(`  ${theme.dim('Create a fine-grained or classic token with repo access (and workflow for Actions).')}\n`);
  out.write(`  ${theme.dim('Classic: repo, read:org, workflow. Fine-grained: contents, issues, pull requests, actions.')}\n\n`);
  const current = config.github?.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (process.env.GITHUB_TOKEN) {
    out.write(`  ${theme.success('✓')} GITHUB_TOKEN is set; environment variables take priority over config.\n`);
  } else if (current) {
    out.write(`  ${theme.dim('Current token:')} ${theme.muted(mask(current))}\n`);
  }
  const token = await prompter.secret(`  ${theme.text('GitHub token')} ${theme.dim('(enter to keep/skip)')}: `);
  if (token == null) return false;
  if (!token) {
    out.write(`  ${theme.dim('No change.')}\n`);
    return false;
  }
  try {
    const client = new GithubClient({ token, apiUrl: config.github?.apiUrl || 'https://api.github.com' });
    const user = await client.getUser();
    config.github = { ...(config.github || {}), token };
    await saveConfig(config);
    out.write(`  ${theme.success('✓')} Connected as @${user.login}. Token saved.\n\n`);
    return true;
  } catch (error) {
    out.write(`  ${theme.error('✖')} ${error.message}\n\n`);
    return false;
  }
}

export function githubStatus(config) {
  const runtime = resolveProvider(config);
  void runtime;
  const token = config.github?.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  return {
    configured: Boolean(token),
    source: process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : process.env.GH_TOKEN ? 'GH_TOKEN' : token ? 'config' : 'none',
    preview: token ? mask(token) : '',
  };
}
