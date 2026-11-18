import path from 'node:path';
import {
  PROVIDERS,
  SETUP_PROVIDER_ORDER,
  configPath,
  describeProvider,
  pluginsDir,
  providerPreset,
  resolveProvider,
  saveConfig,
  setActiveProvider,
  setProviderKey,
} from './config.js';
import { runGithubLogin, runSetup } from './setup.js';
import { undoLast, listSessions } from './session.js';
import { approvalModeHelp } from './prompts.js';
import { resolveShell } from './shell.js';
import { runShell } from './shell.js';
import { theme } from './theme.js';
import {
  formatBytes,
  formatNumber,
  formatTokens,
  gitInfo,
  truncateEnd,
} from './util.js';

export const COMMANDS = [
  { name: '/help', description: 'Show commands and shortcuts', usage: '/help' },
  { name: '/setup', description: 'Configure provider, API key, model, GitHub, approvals', usage: '/setup' },
  { name: '/model', description: 'Show, list, or switch models', usage: '/model [name]' },
  { name: '/provider', description: 'Switch model provider', usage: '/provider [name]' },
  { name: '/approvals', description: 'Set approval mode: ask, auto, or yolo', usage: '/approvals [mode]' },
  { name: '/shell', description: 'Show or change the command shell', usage: '/shell [auto|bash|pwsh|powershell|cmd]' },
  { name: '/init', description: 'Ask Hasty to write project instructions (HASTY.md)', usage: '/init' },
  { name: '/status', description: 'Provider, model, cwd, usage, and connection status', usage: '/status' },
  { name: '/usage', description: 'Token usage and context estimate', usage: '/usage' },
  { name: '/tools', description: 'List available tools', usage: '/tools' },
  { name: '/plugins', description: 'List, reload, or show the plugin directory', usage: '/plugins [reload|path]' },
  { name: '/mcp', description: 'Show or reconnect MCP servers', usage: '/mcp [reconnect]' },
  { name: '/github', description: 'GitHub status, login, or logout', usage: '/github [status|login|logout]' },
  { name: '/undo', description: 'Restore the file changed by the last write/edit/delete', usage: '/undo' },
  { name: '/diff', description: 'Show uncommitted git changes', usage: '/diff' },
  { name: '/sessions', description: 'List recent sessions for this project', usage: '/sessions' },
  { name: '/resume', description: 'Resume a session by number or id', usage: '/resume <number|id>' },
  { name: '/clear', description: 'Start a fresh conversation', usage: '/clear' },
  { name: '/compact', description: 'Summarize older conversation history', usage: '/compact' },
  { name: '/paste', description: 'Enter multi-line text ending with a line containing a single dot', usage: '/paste' },
  { name: '/doctor', description: 'Run environment and configuration diagnostics', usage: '/doctor' },
  { name: '/exit', description: 'Quit Hasty', usage: '/exit' },
];

export const COMMAND_NAMES = COMMANDS.map((command) => command.name);

export async function handleCommand(input, state) {
  const [command, ...rest] = String(input).trim().split(/\s+/);
  const arg = rest.join(' ');
  const ui = state.ui;

  switch (command.toLowerCase()) {
    case '/help':
    case '/?': {
      printHelp(ui);
      return {};
    }
    case '/exit':
    case '/quit': {
      return { exit: true };
    }
    case '/setup': {
      const updated = await runSetup({ config: state.config, prompter: state.prompter });
      if (updated) {
        state.config = updated;
        await state.rebuildAgent();
        const info = describeProvider(state.config);
        ui.success(`Now using ${info.label} / ${info.model}.`);
      }
      return {};
    }
    case '/model': {
      await changeModel(state, arg);
      return {};
    }
    case '/provider': {
      await changeProvider(state, arg);
      return {};
    }
    case '/approvals':
    case '/permissions': {
      if (!arg) {
        ui.line(`  ${theme.dim('Approval mode:')} ${theme.warn(state.approvals.mode)}`);
        ui.line(`  ${theme.dim(approvalModeHelp(state.approvals.mode))}`);
        ui.line(`  ${theme.dim('Change with /approvals ask|auto|yolo')}`);
        return {};
      }
      const mode = arg.toLowerCase();
      if (!['ask', 'auto', 'yolo'].includes(mode)) {
        ui.warn('Approval mode must be ask, auto, or yolo.');
        return {};
      }
      state.approvals.setMode(mode);
      state.config.approvalMode = mode;
      await saveConfig(state.config);
      ui.success(`Approval mode set to ${mode}.`);
      ui.line(`  ${theme.dim(approvalModeHelp(mode))}`);
      return {};
    }
    case '/shell': {
      await changeShell(state, arg);
      return {};
    }
    case '/init': {
      return {
        runPrompt: [
          'Analyze this repository and create or improve a HASTY.md file at the project root.',
          'Read the key manifests, README, config files, and source structure first.',
          'Document: project purpose, stack, important directories, exact install/dev/test/build commands,',
          'code conventions, environment/setup requirements, and non-obvious gotchas.',
          'Keep it under 120 lines, concrete, and specific to this repo. Do not invent scripts.',
          'If HASTY.md already exists, preserve correct content and improve it.',
        ].join(' '),
        title: 'Write project instructions',
      };
    }
    case '/status': {
      await printStatus(state);
      return {};
    }
    case '/usage':
    case '/cost': {
      printUsage(state);
      return {};
    }
    case '/tools': {
      printTools(state);
      return {};
    }
    case '/plugins': {
      await handlePlugins(state, arg);
      return {};
    }
    case '/mcp': {
      await handleMcp(state, arg);
      return {};
    }
    case '/github': {
      await handleGithub(state, arg);
      return {};
    }
    case '/undo': {
      const result = await undoLast(state.session);
      if (result.ok) ui.success(result.message);
      else ui.warn(result.message);
      return {};
    }
    case '/diff': {
      await showDiff(state);
      return {};
    }
    case '/sessions': {
      await showSessions(state);
      return {};
    }
    case '/resume': {
      await resumeSession(state, arg);
      return {};
    }
    case '/clear': {
      await state.newSession();
      ui.success(`Started a fresh session (${state.session.id}).`);
      return {};
    }
    case '/compact': {
      await state.agent.compact({ keep: 8, reason: 'manual' });
      return {};
    }
    case '/paste': {
      ui.info('Use /paste at the prompt, then paste text and finish with a line containing only a dot.');
      return {};
    }
    case '/doctor': {
      await state.doctor?.();
      return {};
    }
    default: {
      ui.warn(`Unknown command: ${command}. Try /help.`);
      return {};
    }
  }
}

function printHelp(ui) {
  ui.line();
  ui.line(`  ${theme.heading('Commands')}`);
  const width = Math.max(...COMMANDS.map((command) => command.usage.length)) + 2;
  for (const command of COMMANDS) {
    ui.line(`  ${theme.primary(command.usage.padEnd(width))}${theme.dim(command.description)}`);
  }
  ui.line();
  ui.line(`  ${theme.heading('Shortcuts')}`);
  ui.line(`  ${theme.primary('@path'.padEnd(width))}${theme.dim('Attach a file to your message (Tab completes paths)')}`);
  ui.line(`  ${theme.primary('!command'.padEnd(width))}${theme.dim('Run a shell command directly (approval still applies)')}`);
  ui.line(`  ${theme.primary('\\'.padEnd(width))}${theme.dim('End a line with \\ to continue on the next line')}`);
  ui.line(`  ${theme.primary('Ctrl+C'.padEnd(width))}${theme.dim('Cancel the current request or clear the input')}`);
  ui.line(`  ${theme.primary('Ctrl+D'.padEnd(width))}${theme.dim('Exit')}`);
  ui.line();
  ui.line(`  ${theme.dim('State lives in')} ${theme.bright(configPath())}`);
  ui.line(`  ${theme.dim('Plugins live in')} ${theme.bright(pluginsDir())}`);
  ui.line();
}

async function changeModel(state, arg) {
  const ui = state.ui;
  const runtime = state.agent.provider.runtime;
  let model = arg.trim();
  if (!model) {
    ui.line(`  ${theme.dim('Current model:')} ${theme.bright(runtime.model)} ${theme.dim(`(${runtime.label})`)}`);
    try {
      ui.info('Fetching available models…');
      const models = await state.agent.provider.listModels();
      if (models.length > 0) {
        const shown = models.slice(0, 40);
        shown.forEach((name, index) => {
          const current = name === runtime.model ? theme.success(' ← current') : '';
          ui.line(`  ${theme.primary(`${index + 1})`.padEnd(4))} ${name}${current}`);
        });
        if (models.length > shown.length) ui.line(`  ${theme.dim(`… ${models.length - shown.length} more (type a model name)`)}`);
        ui.line();
        const answer = await state.prompter.ask(`  ${theme.text('Model number or name')}: `, {
          defaultValue: runtime.model,
          onInterrupt: null,
        });
        if (answer == null) return;
        const index = Number(answer) - 1;
        model = Number.isInteger(index) && index >= 0 && index < shown.length ? shown[index] : answer;
      }
    } catch (error) {
      ui.warn(`Could not list models: ${truncateEnd(error.message, 180, 'error')}`);
    }
    if (!model) {
      model = await state.prompter.ask(`  ${theme.text('Model name')} ${theme.dim(`[${runtime.model}]`)}: `, {
        defaultValue: runtime.model,
        onInterrupt: null,
      });
    }
    if (!model) return;
  }
  if (model === runtime.model) {
    ui.info(`Already using ${model}.`);
    return;
  }
  state.config.model = model;
  await saveConfig(state.config);
  await state.rebuildAgent();
  ui.success(`Switched to ${model}.`);
}

async function changeProvider(state, arg) {
  const ui = state.ui;
  let name = arg.trim().toLowerCase();
  if (!name) {
    ui.line(`  ${theme.dim('Provider:')} ${theme.bright(state.config.provider)}`);
    SETUP_PROVIDER_ORDER.forEach((provider, index) => {
      const preset = PROVIDERS[provider];
      const current = provider === state.config.provider ? theme.success(' (current)') : '';
      ui.line(`  ${theme.primary(`${index + 1})`.padEnd(4))} ${preset.label}${current} ${theme.dim(`— ${preset.hint}`)}`);
    });
    const answer = await state.prompter.ask(`  ${theme.text('Provider number or name')}: `, {
      defaultValue: state.config.provider,
      onInterrupt: null,
    });
    if (answer == null) return;
    const index = Number(answer) - 1;
    name = Number.isInteger(index) && index >= 0 && index < SETUP_PROVIDER_ORDER.length
      ? SETUP_PROVIDER_ORDER[index]
      : answer.toLowerCase();
  }
  if (!PROVIDERS[name]) {
    ui.warn(`Unknown provider: ${name}. Use /setup for the full wizard.`);
    return;
  }
  const preset = providerPreset(name);
  const runtime = resolveProvider(state.config, name);
  if (!preset.keyless && !runtime.apiKey) {
    const key = await state.prompter.secret(`  ${theme.text(`${preset.label} API key`)}: `);
    if (key == null) return;
    if (key) {
      setProviderKey(state.config, name, key);
    } else if (preset.env?.length) {
      ui.warn(`No key entered. Set ${preset.env.join(' or ')} or run /setup later.`);
    }
  }
  setActiveProvider(state.config, name, preset.defaultModel);
  await saveConfig(state.config);
  await state.rebuildAgent();
  const info = describeProvider(state.config, name);
  ui.success(`Provider: ${info.label} · model: ${info.model}${info.hasKey ? '' : ' · no key yet'}`);
}

async function changeShell(state, arg) {
  const ui = state.ui;
  const current = state.shell;
  if (!arg) {
    ui.line(`  ${theme.dim('Shell:')} ${theme.bright(current.label)} ${theme.dim(`(${current.binary})`)}`);
    ui.line(`  ${theme.dim(current.syntax)}`);
    ui.line(`  ${theme.dim('Change with /shell auto|bash|pwsh|powershell|cmd')}`);
    return;
  }
  const value = arg.toLowerCase();
  if (!['auto', 'bash', 'git-bash', 'pwsh', 'powershell', 'cmd', 'sh', 'zsh'].includes(value)) {
    ui.warn('Shell must be auto, bash, pwsh, powershell, or cmd.');
    return;
  }
  state.config.shell = value;
  await saveConfig(state.config);
  state.shell = resolveShell(state.config);
  await state.rebuildAgent();
  ui.success(`Shell set to ${state.shell.label}.`);
  ui.line(`  ${theme.dim(state.shell.syntax)}`);
}

async function printStatus(state) {
  const ui = state.ui;
  const runtime = state.agent.provider.runtime;
  const info = describeProvider(state.config, runtime.name);
  const git = gitInfo(state.cwd);
  const contextPct = state.agent.contextPercent();
  ui.line();
  ui.line(`  ${theme.heading('Hasty status')}`);
  const rows = [
    ['provider', `${info.label} (${runtime.type})`],
    ['model', info.model],
    ['key', info.keyless ? 'local / keyless' : info.apiKey ? `${info.keySource} · ${info.keyPreview}` : 'missing'],
    ['cwd', state.cwd],
    ['shell', `${state.shell.label} · ${state.shell.binary}`],
    ['session', `${state.session.id} · ${state.session.title || 'untitled'}`],
    ['messages', `${formatNumber(state.session.messages.length)} · ${state.session.compactions} compactions`],
    ['usage', `${formatTokens(state.session.usage.total)} tokens (in ${formatTokens(state.session.usage.input)}, out ${formatTokens(state.session.usage.output)})`],
    ['context', `~${Math.round(contextPct)}% of ${formatTokens(state.config.contextWindow)}`],
    ['approvals', state.approvals.mode],
    ['instructions', state.projectInstructionsFiles?.length ? state.projectInstructionsFiles.join(', ') : 'none'],
    ['git', git ? `${git.branch || 'detached'}${git.changed ? ` · ${git.changed} changed` : ' · clean'}` : 'not a repository'],
    ['github', state.githubConnection?.connected ? `connected (${state.githubConnection.auth.source})` : 'not connected'],
    ['plugins', `${state.pluginManager?.plugins.length || 0} loaded${state.pluginManager?.errors.length ? ` · ${state.pluginManager.errors.length} errors` : ''}`],
    ['mcp', state.mcpManager?.configured ? `${state.mcpManager.configured} configured` : 'none'],
    ['config', configPath()],
  ];
  for (const [label, value] of rows) {
    ui.line(`  ${theme.dim(label.padEnd(10))} ${theme.text(value)}`);
  }
  ui.line();
}

function printUsage(state) {
  const ui = state.ui;
  const usage = state.session.usage;
  const pct = state.agent.contextPercent();
  ui.line();
  ui.line(`  ${theme.dim('input tokens')}   ${formatTokens(usage.input)}`);
  ui.line(`  ${theme.dim('output tokens')}  ${formatTokens(usage.output)}`);
  ui.line(`  ${theme.dim('total tokens')}   ${formatTokens(usage.total)}`);
  ui.line(`  ${theme.dim('context')}        ~${Math.round(pct)}% of ${formatTokens(state.config.contextWindow)}`);
  ui.line(`  ${theme.dim('compactions')}    ${state.session.compactions}`);
  ui.line(`  ${theme.dim('note')}           Token counts come from the provider; some local/self-hosted models report none.`);
  ui.line();
}

function printTools(state) {
  const ui = state.ui;
  const tools = state.agent.registry.list();
  const groups = [
    ['built-in', tools.filter((tool) => !tool.plugin && !tool.mcpServer)],
    ['plugins', tools.filter((tool) => tool.plugin)],
    ['mcp', tools.filter((tool) => tool.mcpServer)],
  ];
  ui.line();
  for (const [label, list] of groups) {
    if (list.length === 0) continue;
    ui.line(`  ${theme.heading(label)} ${theme.dim(`(${list.length})`)}`);
    for (const tool of list) {
      ui.line(`  ${theme.primary(tool.name.padEnd(26))}${theme.dim(tool.description.split('\n')[0].slice(0, 110))}`);
    }
    ui.line();
  }
}

async function handlePlugins(state, arg) {
  const ui = state.ui;
  const sub = arg.trim().toLowerCase();
  if (sub === 'reload') {
    if (!state.pluginManager) {
      ui.info('Plugins are disabled for this run (--no-plugins).');
      return;
    }
    await state.pluginManager.loadAll();
    await state.reloadTools();
    ui.success(`Reloaded ${state.pluginManager.plugins.length} plugin(s).`);
    if (state.pluginManager.errors.length) {
      for (const error of state.pluginManager.errors) ui.warn(`${path.basename(error.file)}: ${error.message}`);
    }
    return;
  }
  if (sub === 'path') {
    ui.line(`  ${theme.bright(pluginsDir())}`);
    return;
  }
  const manager = state.pluginManager;
  ui.line();
  if (!manager || manager.plugins.length === 0) {
    ui.line(`  ${theme.dim('No plugins installed. Ask Hasty to build a connection with create_plugin.')}`);
  } else {
    ui.line(`  ${theme.heading('Plugins')}`);
    for (const plugin of manager.plugins) {
      ui.line(`  ${theme.bright(plugin.name)} ${theme.dim(`— ${plugin.description || 'no description'}`)}`);
      ui.line(`    ${theme.dim(plugin.file)}`);
      ui.line(`    ${theme.dim(plugin.tools.map((tool) => tool.name).join(', '))}`);
    }
  }
  if (manager?.errors.length) {
    ui.line();
    for (const error of manager.errors) ui.warn(`${path.basename(error.file)}: ${error.message}`);
  }
  ui.line(`  ${theme.dim('Directory:')} ${pluginsDir()} ${theme.dim('· /plugins reload to reload')}`);
  ui.line();
}

async function handleMcp(state, arg) {
  const ui = state.ui;
  if (!state.mcpManager || state.mcpManager.configured === 0) {
    ui.info('No MCP servers configured. Add them under mcpServers in ~/.hasty/config.json.');
    return;
  }
  if (arg.trim().toLowerCase() === 'reconnect') {
    ui.info('Reconnecting MCP servers…');
    await state.mcpManager.connectAll();
    await state.reloadTools();
  }
  ui.line();
  ui.line(`  ${theme.heading('MCP servers')}`);
  for (const server of state.mcpManager.serversInfo()) {
    const color = server.status === 'connected' ? theme.success : theme.warn;
    ui.line(`  ${color(server.status.padEnd(10))} ${theme.bright(server.name)} ${theme.dim(`· ${server.toolCount} tools`)}${server.error ? theme.dim(` — ${server.error}`) : ''}`);
  }
  ui.line(`  ${theme.dim('Config: mcpServers in')} ${configPath()}`);
  ui.line();
}

async function handleGithub(state, arg) {
  const ui = state.ui;
  const sub = (arg.trim() || 'status').toLowerCase();
  if (sub === 'login') {
    const ok = await runGithubLogin({ config: state.config, prompter: state.prompter });
    if (ok) {
      state.githubConnection.refresh();
      await state.githubConnection.whoami();
      await state.reloadTools();
      ui.success('GitHub tools are now available.');
    }
    return;
  }
  if (sub === 'logout') {
    if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
      ui.warn('GITHUB_TOKEN or GH_TOKEN is set in the environment; unset it to fully disconnect.');
      return;
    }
    state.config.github = { ...(state.config.github || {}), token: '' };
    await saveConfig(state.config);
    state.githubConnection.refresh();
    await state.reloadTools();
    ui.success('GitHub token removed.');
    return;
  }
  if (sub !== 'status') {
    ui.info('Usage: /github [status|login|logout]');
    return;
  }
  const auth = state.githubConnection?.refresh();
  ui.line();
  if (!auth?.token) {
    ui.line(`  ${theme.warn('GitHub: not connected')}`);
    ui.line(`  ${theme.dim('/github login, or set GITHUB_TOKEN, or install and auth the gh CLI.')}`);
    ui.line();
    return;
  }
  ui.line(`  ${theme.dim('GitHub: connected')} ${theme.dim(`via ${auth.source}`)}`);
  const user = await state.githubConnection.whoami();
  if (user) {
    ui.line(`  ${theme.dim('account:')} @${user.login}${user.name ? ` (${user.name})` : ''}`);
    ui.line(`  ${theme.dim('scopes:')} ${user.public_repos != null ? `${user.public_repos} public repos` : 'unknown'}`);
  } else {
    ui.line(`  ${theme.warn('Token is saved but the API check failed:')} ${theme.dim(state.githubConnection.lastError || 'unknown error')}`);
  }
  ui.line();
}

async function showDiff(state) {
  const ui = state.ui;
  const git = gitInfo(state.cwd);
  if (!git) {
    ui.warn('This directory is not a git repository.');
    return;
  }
  const result = await runShell('git status --short; git --no-pager diff --color=never', {
    cwd: state.cwd,
    shell: state.shell,
    timeoutMs: 25_000,
    maxOutput: 30_000,
  });
  const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (!text) {
    ui.info('No uncommitted changes.');
    return;
  }
  ui.line();
  ui.line(`  ${theme.heading('Git changes')} ${theme.dim(`(${git.branch || 'detached'})`)}`);
  ui.preview(truncateEnd(text, 12_000, 'diff'), { maxLines: 60 });
  ui.line();
}

async function showSessions(state) {
  const ui = state.ui;
  const sessions = await listSessions({ cwd: state.cwd, limit: 15 });
  state.sessionChoices = sessions;
  ui.line();
  if (sessions.length === 0) {
    ui.line(`  ${theme.dim('No saved sessions for this directory.')}`);
    ui.line();
    return;
  }
  ui.line(`  ${theme.heading('Recent sessions')} ${theme.dim(`(${state.cwd})`)}`);
  sessions.forEach((session, index) => {
    const when = new Date(session.updatedAt).toLocaleString();
    const current = session.id === state.session.id ? theme.success(' ← current') : '';
    ui.line(`  ${theme.primary(`${index + 1})`.padEnd(4))} ${theme.bright(session.id)}${current}`);
    ui.line(`      ${theme.text(session.title)} ${theme.dim(`· ${session.messageCount} msgs · ${when}`)}`);
  });
  ui.line(`  ${theme.dim('Resume with /resume <number|id>')}`);
  ui.line();
}

async function resumeSession(state, arg) {
  const ui = state.ui;
  let id = arg.trim();
  if (!id) {
    await showSessions(state);
    id = await state.prompter.ask(`  ${theme.text('Session number or id')}: `, { onInterrupt: null });
    if (!id) return;
  }
  if (/^\d+$/.test(id)) {
    const index = Number(id) - 1;
    const choice = state.sessionChoices?.[index];
    if (!choice) {
      ui.warn('Run /sessions first, or pass a session id.');
      return;
    }
    id = choice.id;
  }
  try {
    await state.resumeSession(id);
    ui.success(`Resumed ${state.session.id} — ${state.session.title || 'untitled'}`);
    ui.line(`  ${theme.dim(`${state.session.messages.length} messages loaded.`) }`);
  } catch (error) {
    ui.error(`Could not resume: ${error.message}`);
  }
}

export function formatBytesLabel(bytes) {
  return formatBytes(bytes);
}
