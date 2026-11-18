import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PROVIDERS,
  configPath,
  describeProvider,
  hastyHome,
  historyPath,
  loadConfig,
  needsSetup,
  pluginsDir,
  redactedConfig,
  resolveProvider,
  saveConfig,
  setActiveProvider,
  sessionsDir,
} from './config.js';
import { createProvider, friendlyProviderError } from './providers/index.js';
import { resolveShell, runShell } from './shell.js';
import { isProtectedPath, loadIgnoreRules } from './tools/helpers.js';
import { createBuiltinTools, ToolRegistry } from './tools/index.js';
import { PluginManager } from './plugins.js';
import { McpManager } from './mcp.js';
import { GithubConnection, ghCliToken } from './github.js';
import {
  ApprovalManager,
  catastrophicReason,
  dangerousCommandReason,
} from './approvals.js';
import { Agent } from './agent.js';
import {
  latestSession,
  listSessions,
  loadSession,
  newSession,
  saveSession,
} from './session.js';
import { approvalModeHelp, loadProjectInstructions } from './prompts.js';
import { JsonUI, PlainUI, Renderer } from './ui/renderer.js';
import { Prompter } from './ui/prompt.js';
import { COMMANDS, COMMAND_NAMES, handleCommand } from './commands.js';
import { runGithubLogin, runSetup } from './setup.js';
import { SYMBOLS, setColorEnabled, theme } from './theme.js';
import {
  atomicWrite,
  commandExists,
  ensureDir,
  ensureDirSync,
  firstLine,
  formatDuration,
  formatNumber,
  gitInfo,
  isBinaryBuffer,
  readStdin,
  truncateEnd,
} from './util.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const MIN_NODE = '20.11.0';
const MAX_ATTACH_BYTES = 200_000;
const MAX_ATTACH_TOTAL = 400_000;
const HISTORY_LIMIT = 500;

const COMMAND_SET = new Set([
  'setup',
  'doctor',
  'models',
  'config',
  'plugins',
  'mcp',
  'github',
  'sessions',
  'resume',
  'help',
  'version',
]);

const VALUE_FLAGS = new Map([
  ['-p', 'print'],
  ['--print', 'print'],
  ['-m', 'model'],
  ['--model', 'model'],
  ['--provider', 'provider'],
  ['--mode', 'mode'],
  ['--approvals', 'mode'],
  ['-r', 'resume'],
  ['--resume', 'resume'],
  ['--cwd', 'cwd'],
  ['--temperature', 'temperature'],
  ['--max-steps', 'maxSteps'],
]);

const BOOLEAN_FLAGS = new Map([
  ['-y', 'yes'],
  ['--yes', 'yes'],
  ['-c', 'continue'],
  ['--continue', 'continue'],
  ['--json', 'json'],
  ['--no-mcp', 'noMcp'],
  ['--no-plugins', 'noPlugins'],
  ['-q', 'quiet'],
  ['--quiet', 'quiet'],
  ['--no-banner', 'noBanner'],
  ['--no-color', 'noColor'],
  ['--color', 'color'],
  ['-h', 'help'],
  ['--help', 'help'],
  ['-v', 'version'],
  ['--version', 'version'],
]);

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    reportUsageError(error.message);
    return;
  }

  if (args.flags.version || args.command === 'version') {
    process.stdout.write(`hasty ${VERSION}\n`);
    return;
  }
  if (args.command === 'help' || (args.flags.help && !args.command)) {
    printHelp();
    return;
  }
  if (args.flags.help) {
    printHelp();
    return;
  }

  try {
    switch (args.command) {
      case 'setup':
        await commandSetup(args);
        break;
      case 'doctor':
        await commandDoctor(args);
        break;
      case 'models':
        await commandModels(args);
        break;
      case 'config':
        await commandConfig(args);
        break;
      case 'plugins':
        await commandPlugins(args);
        break;
      case 'mcp':
        await commandMcp(args);
        break;
      case 'github':
        await commandGithub(args);
        break;
      case 'sessions':
        await commandSessions(args);
        break;
      case 'resume':
        await commandResume(args);
        break;
      default:
        await runCli(args);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      reportUsageError(error.message);
      return;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let command = null;

  const addBare = (value) => {
    if (!command && positionals.length === 0 && COMMAND_SET.has(value)) {
      command = value;
      return;
    }
    positionals.push(value);
  };

  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    if (arg === '--') {
      for (const rest of argv.slice(index + 1)) addBare(rest);
      break;
    }
    if (arg.startsWith('--') && arg.includes('=')) {
      const equals = arg.indexOf('=');
      const name = arg.slice(0, equals);
      const value = arg.slice(equals + 1);
      if (VALUE_FLAGS.has(name)) {
        flags[VALUE_FLAGS.get(name)] = value;
        continue;
      }
      if (BOOLEAN_FLAGS.has(name)) {
        flags[BOOLEAN_FLAGS.get(name)] = value !== 'false' && value !== '0';
        continue;
      }
      throw new UsageError(`Unknown option: ${name}`);
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value.`);
      flags[VALUE_FLAGS.get(arg)] = value;
      index += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      flags[BOOLEAN_FLAGS.get(arg)] = true;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      throw new UsageError(`Unknown option: ${arg}. Try \`hasty --help\`.`);
    }
    addBare(arg);
  }

  return { flags, positionals, command };
}

function reportUsageError(message) {
  process.stderr.write(`\n  ${theme.error('hasty:')} ${message}\n`);
  process.stderr.write(`  ${theme.dim('Run `hasty --help` for usage.')}\n\n`);
  process.exitCode = 2;
}

function resolveCwd(value) {
  let raw = String(value || process.cwd());
  if (raw === '~') raw = os.homedir();
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) raw = path.join(os.homedir(), raw.slice(2));
  const cwd = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new UsageError(`Working directory does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) throw new UsageError(`Not a directory: ${cwd}`);
  return cwd;
}

function applyConfigFlags(config, flags) {
  if (flags.provider) {
    const name = String(flags.provider).toLowerCase();
    if (!PROVIDERS[name]) {
      throw new UsageError(`Unknown provider "${flags.provider}". Choose: ${Object.keys(PROVIDERS).join(', ')}.`);
    }
    if (name !== config.provider) setActiveProvider(config, name, flags.model || '');
    else config.provider = name;
  }
  if (flags.model) config.model = String(flags.model);
  if (flags.mode) {
    const mode = String(flags.mode).toLowerCase();
    if (!['ask', 'auto', 'yolo'].includes(mode)) {
      throw new UsageError('Approval mode must be ask, auto, or yolo.');
    }
    config.approvalMode = mode;
  }
  if (flags.yes) config.approvalMode = 'yolo';
  if (flags.temperature != null) {
    const value = Number(flags.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2) {
      throw new UsageError('--temperature must be between 0 and 2.');
    }
    config.temperature = value;
  }
  if (flags.maxSteps != null) {
    const value = Number(flags.maxSteps);
    if (!Number.isInteger(value) || value < 1 || value > 200) {
      throw new UsageError('--max-steps must be an integer between 1 and 200.');
    }
    config.maxSteps = value;
  }
  if (flags.noBanner) config.ui.showBanner = false;
  if (flags.noPlugins) config.plugins.enabled = false;
  if (flags.noColor) setColorEnabled(false);
  if (flags.color) setColorEnabled(true);
  return config;
}

async function loadBase(args) {
  const cwd = resolveCwd(args.flags.cwd);
  const config = applyConfigFlags(await loadConfig(), args.flags);
  return { cwd, config };
}

// ---------------------------------------------------------------------------
// Interactive / one-shot agent
// ---------------------------------------------------------------------------

async function runCli(args) {
  const cwd = resolveCwd(args.flags.cwd);
  process.chdir(cwd);

  let config = applyConfigFlags(await loadConfig(), args.flags);
  const wantsJson = Boolean(args.flags.json);
  const quiet = Boolean(args.flags.quiet);

  let promptText = Object.prototype.hasOwnProperty.call(args.flags, 'print')
    ? String(args.flags.print ?? '')
    : '';
  if (!promptText) promptText = args.positionals.join(' ').trim();

  if (!process.stdin.isTTY) {
    const piped = (await readStdin()).trim();
    if (piped) {
      promptText = promptText
        ? `${promptText}\n\n<stdin>\n${truncateEnd(piped, 200_000, 'stdin')}\n</stdin>`
        : piped;
    }
  }

  if (promptText) promptText = await attachFiles(promptText, cwd);

  const oneShot = Boolean(promptText) || wantsJson || !process.stdin.isTTY;
  if (!oneShot && !process.stdin.isTTY) {
    throw new UsageError('No prompt provided. Pass a prompt, pipe input, or use `hasty -p "..."`.');
  }
  if ((wantsJson || oneShot) && !promptText) {
    throw new UsageError('No prompt provided. Pass a prompt or pipe input on stdin.');
  }

  const interactive = !oneShot && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let prompter = null;
  if (interactive) {
    const history = await loadHistory();
    prompter = new Prompter({ history, completer: makeCompleter(cwd) });
  }

  const ui = wantsJson
    ? new JsonUI()
    : interactive
      ? new Renderer({ config })
      : new PlainUI({ config, quiet });

  if (needsSetup(config)) {
    if (!interactive || !prompter) {
      throw new UsageError(
        'No model provider is configured. Run `hasty setup` in a terminal, set an API key environment variable, '
        + 'or pass --provider/--model.',
      );
    }
    const updated = await runSetup({ config, prompter });
    if (!updated) {
      prompter.close();
      return;
    }
    config = updated;
  }

  const shell = resolveShell(config);
  const approvals = new ApprovalManager({
    config,
    renderer: ui,
    prompter,
    interactive,
    mode: config.approvalMode,
  });

  let session = null;
  let resumed = false;
  if (args.flags.resume) {
    try {
      session = await loadSession(String(args.flags.resume));
      delete session._file;
      resumed = true;
    } catch (error) {
      if (prompter) prompter.close();
      throw new UsageError(`Could not resume session: ${error.message}`);
    }
  } else if (args.flags.continue) {
    const latest = await latestSession(cwd);
    if (latest) {
      session = await loadSession(latest.id);
      delete session._file;
      resumed = true;
    } else if (interactive) {
      ui.info('No previous session for this directory; starting fresh.');
    }
  }
  if (!session) {
    session = newSession({
      cwd,
      provider: config.provider,
      model: resolveProvider(config).model,
    });
  }

  const githubConnection = new GithubConnection(config);

  let pluginManager = null;
  if (config.plugins?.enabled !== false) {
    const reservedProbe = createBuiltinTools({
      shell,
      config,
      githubConnection,
      pluginManager: null,
      mcpManager: null,
    }).map((tool) => tool.name);
    reservedProbe.push('create_plugin', 'list_connections');
    pluginManager = new PluginManager({
      config,
      ui,
      reservedNames: reservedProbe,
    });
    await pluginManager.loadAll();
  }

  let mcpManager = null;
  if (!args.flags.noMcp) {
    mcpManager = new McpManager({ config, ui });
    if (mcpManager.configured > 0) {
      ui.info?.(`Connecting ${mcpManager.configured} MCP server(s)…`);
      await mcpManager.connectAll();
    }
  }

  const runtime = {
    config,
    cwd,
    shell,
    session,
    ui,
    prompter,
    approvals,
    githubConnection,
    pluginManager,
    mcpManager,
    registry: null,
    agent: null,
    activeController: null,
    activeTurn: false,
    interactive,
    json: wantsJson,
    sessionChoices: [],
    async reloadTools() {
      const registry = new ToolRegistry(createBuiltinTools({
        shell: runtime.shell,
        config: runtime.config,
        githubConnection: runtime.githubConnection,
        pluginManager: runtime.pluginManager,
        mcpManager: runtime.mcpManager,
      }));
      runtime.registry = registry;
      if (runtime.agent) runtime.agent.registry = registry;
      return registry;
    },
    async rebuildAgent() {
      const provider = createProvider(runtime.config);
      await runtime.reloadTools();
      const instructions = await loadProjectInstructions(runtime.cwd);
      runtime.projectInstructions = instructions.content;
      runtime.projectInstructionsFiles = instructions.files;
      runtime.ignoreRules = await loadIgnoreRules(runtime.cwd);
      runtime.agent = new Agent({
        config: runtime.config,
        provider,
        session: runtime.session,
        cwd: runtime.cwd,
        registry: runtime.registry,
        ui: runtime.ui,
        approvals: runtime.approvals,
        prompter: runtime.prompter,
        askUser: makeAskUser(runtime),
        shell: runtime.shell,
        ignoreRules: runtime.ignoreRules,
        projectInstructions: runtime.projectInstructions,
        interactive: runtime.interactive,
      });
      return runtime.agent;
    },
    async newSession() {
      const fresh = newSession({
        cwd: runtime.cwd,
        provider: runtime.config.provider,
        model: runtime.agent?.model || resolveProvider(runtime.config).model,
      });
      runtime.session = fresh;
      if (runtime.agent) runtime.agent.session = fresh;
      await saveSession(fresh);
      return fresh;
    },
    async resumeSession(id) {
      const loaded = await loadSession(id);
      delete loaded._file;
      runtime.session = loaded;
      if (runtime.agent) runtime.agent.session = loaded;
      else await runtime.rebuildAgent();
      return loaded;
    },
    async doctor() {
      await printDoctor(runtime);
    },
  };

  try {
    await runtime.rebuildAgent();
  } catch (error) {
    if (prompter) prompter.close();
    if (mcpManager) mcpManager.closeAll();
    throw new UsageError(friendlyProviderError(error, resolveProvider(config)));
  }

  if (interactive) {
    prompter.onSigint = () => {
      if (runtime.activeController && !runtime.activeController.signal.aborted) {
        runtime.ui.warn('Cancelling…');
        runtime.activeController.abort();
        return true;
      }
      return false;
    };

    const info = describeProvider(config);
    ui.banner({
      version: VERSION,
      provider: info,
      model: runtime.agent.model || info.model,
      cwd,
      branch: gitInfo(cwd)?.branch,
      approvalMode: approvals.mode,
      resumed,
    });
    if (resumed && session.provider && session.provider !== config.provider) {
      ui.warn(`This session was created with ${session.provider}/${session.model || 'unknown model'}.`);
    }
    if (args.flags.yes) {
      ui.warn('yolo approvals are active for this run. Catastrophic disk/OS commands are still blocked.');
    }
  }

  const processSigint = () => {
    runtime.activeController?.abort();
  };

  try {
    if (interactive) {
      await interactiveLoop(runtime);
      return;
    }

    process.on('SIGINT', processSigint);
    const result = await runAgentTurn(runtime, promptText);
    if (wantsJson) {
      runtime.ui.emit('result', {
        ok: Boolean(result?.ok),
        text: result?.text || '',
        error: result?.error || null,
        session: runtime.session.id,
      });
    }
    process.exitCode = result?.ok ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', processSigint);
    if (prompter) {
      prompter.close();
      await saveHistory(prompter.getHistory());
    }
    if (mcpManager) mcpManager.closeAll();
  }
}

async function interactiveLoop(runtime) {
  let running = true;
  while (running) {
    const raw = await readPrompt(runtime);
    if (raw == null) break;
    const input = raw.trim();
    if (!input) continue;

    if (input === '/paste' || input.startsWith('/paste ')) {
      const pasted = await readPaste(runtime);
      if (pasted.trim()) await runAgentTurn(runtime, pasted);
      continue;
    }

    if (input.startsWith('/')) {
      let result = {};
      try {
        result = await handleCommand(input, runtime);
      } catch (error) {
        runtime.ui.error(error.message);
      }
      if (result?.exit) {
        running = false;
        break;
      }
      if (result?.runPrompt) {
        await runAgentTurn(runtime, result.runPrompt, result.title);
      }
      continue;
    }

    if (input.startsWith('!') && !input.startsWith('!=')) {
      await runDirectShell(runtime, input.slice(1).trim());
      continue;
    }

    const expanded = await attachFiles(input, runtime.cwd);
    await runAgentTurn(runtime, expanded);
  }
}

async function readPrompt(runtime) {
  const prompter = runtime.prompter;
  const first = await prompter.ask(`\n  ${theme.userPrompt('❯')} `, { onInterrupt: '' });
  if (first == null) return null;
  if (!first.trim() && prompter.lastInterrupted) return '';
  const lines = [first];
  while (hasContinuation(lines[lines.length - 1])) {
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
    const next = await prompter.ask(`  ${theme.dim('…')} `, { onInterrupt: '' });
    if (next == null) break;
    lines.push(next);
  }
  return lines.join('\n');
}

function hasContinuation(line) {
  const match = String(line).match(/\\+$/);
  return Boolean(match && match[0].length % 2 === 1);
}

async function readPaste(runtime) {
  runtime.ui.info('Paste text, then finish with a line containing only a dot.');
  const lines = [];
  for (;;) {
    const line = await runtime.prompter.question(`  ${theme.dim('…')} `);
    if (line == null) break;
    if (line.trim() === '.') break;
    lines.push(line);
  }
  return lines.join('\n');
}

async function runAgentTurn(runtime, text, title = null) {
  if (runtime.activeTurn) {
    runtime.ui.warn('A request is already running. Wait for it to finish or press Ctrl+C.');
    return null;
  }
  try {
    const instructions = await loadProjectInstructions(runtime.cwd);
    runtime.agent.projectInstructions = instructions.content;
    runtime.projectInstructionsFiles = instructions.files;
    runtime.agent.ignoreRules = await loadIgnoreRules(runtime.cwd);
    runtime.agent.git = gitInfo(runtime.cwd);
  } catch {
    // Context refresh is best effort.
  }

  const controller = new AbortController();
  runtime.activeController = controller;
  runtime.activeTurn = true;
  try {
    return await runtime.agent.runTurn(text, { signal: controller.signal, title });
  } catch (error) {
    runtime.ui.error(`Unexpected error: ${error.message}`);
    return { ok: false, text: '', error: { message: error.message } };
  } finally {
    runtime.activeTurn = false;
    runtime.activeController = null;
  }
}

async function runDirectShell(runtime, command) {
  if (!command) {
    runtime.ui.info('Usage: !command (for example, !git status)');
    return;
  }
  const blocked = catastrophicReason(command);
  if (blocked) {
    runtime.ui.error(blocked);
    return;
  }
  const danger = dangerousCommandReason(command);
  const decision = await runtime.approvals.request({
    category: 'shell',
    tool: 'run_command',
    title: `run · ${firstLine(command, 60)}`,
    detail: `${runtime.shell.label} in ${runtime.cwd}\n$ ${command}`,
    danger: Boolean(danger),
    alwaysKey: 'shell',
  });
  if (!decision.allowed) return;

  const controller = new AbortController();
  runtime.activeController = controller;
  runtime.ui.line();
  runtime.ui.line(`  ${theme.dim('$')} ${theme.text(command)}`);
  try {
    const result = await runShell(command, {
      cwd: runtime.cwd,
      shell: runtime.shell,
      timeoutMs: 120_000,
      maxOutput: runtime.config.maxToolOutput,
      signal: controller.signal,
    });
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (combined) await runtime.ui.preview(combined, { error: result.code !== 0 });
    if (result.timedOut) runtime.ui.warn('Command timed out.');
    if (result.aborted) runtime.ui.warn('Command cancelled.');
    const ok = result.code === 0 && !result.timedOut && !result.aborted;
    runtime.ui.line(
      `  ${ok ? theme.success(SYMBOLS.check) : theme.error(SYMBOLS.cross)} `
      + `${theme.dim(`exit ${result.code ?? '?'} · ${formatDuration(result.durationMs)}`)}`,
    );
  } finally {
    runtime.activeController = null;
  }
}

function makeAskUser(runtime) {
  return async (question, options = []) => {
    if (!runtime.interactive || !runtime.prompter) return null;
    runtime.ui.line();
    runtime.ui.line(`  ${theme.warn('?')} ${theme.text(question)}`);
    options.slice(0, 8).forEach((option, index) => {
      runtime.ui.line(`    ${theme.primary(`${index + 1})`)} ${option}`);
    });
    const answer = await runtime.prompter.ask(`  ${theme.text('Answer')}: `, { onInterrupt: null });
    if (!answer || !answer.trim()) return null;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) return options[index];
    return answer.trim();
  };
}

// ---------------------------------------------------------------------------
// @file attachments
// ---------------------------------------------------------------------------

const ATTACH_RE = /(^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;

async function attachFiles(text, cwd) {
  const candidates = [];
  for (const match of text.matchAll(ATTACH_RE)) {
    const raw = match[2] || match[3] || match[4] || '';
    if (!raw || raw.includes('://')) continue;
    const cleaned = raw.replace(/[),.;:]+$/, '');
    candidates.push(cleaned, raw);
  }
  if (candidates.length === 0) return text;

  const seen = new Set();
  const blocks = [];
  const notes = [];
  let total = 0;

  for (const candidate of candidates) {
    const resolved = resolveAttachment(cwd, candidate);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    if (isProtectedPath(resolved)) {
      notes.push(`${displayRelative(cwd, resolved)} is protected and was not attached.`);
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (total >= MAX_ATTACH_TOTAL) {
      notes.push('Attachment limit reached; remaining files were skipped.');
      break;
    }
    let buffer;
    try {
      buffer = await fsp.readFile(resolved);
    } catch (error) {
      notes.push(`${displayRelative(cwd, resolved)}: ${error.message}`);
      continue;
    }
    if (isBinaryBuffer(buffer)) {
      notes.push(`${displayRelative(cwd, resolved)} looks binary and was not attached.`);
      continue;
    }
    let content = buffer.toString('utf8');
    let truncated = false;
    const allowance = Math.min(MAX_ATTACH_BYTES, MAX_ATTACH_TOTAL - total);
    if (content.length > allowance) {
      content = truncateEnd(content, allowance, 'file content');
      truncated = true;
    }
    total += content.length;
    const fence = fenceFor(content);
    blocks.push(
      `<file path="${displayRelative(cwd, resolved)}">\n`
      + `${fence}${languageFor(resolved)}\n${content}\n${fence}\n`
      + `${truncated ? '[file truncated by Hasty]\n' : ''}</file>`,
    );
  }

  if (blocks.length === 0 && notes.length === 0) return text;
  const sections = [text, ''];
  if (blocks.length) {
    sections.push('<attached_files>', blocks.join('\n\n'), '</attached_files>');
  }
  if (notes.length) {
    sections.push('<attachment_notes>', ...notes.map((note) => `- ${note}`), '</attachment_notes>');
  }
  return sections.join('\n');
}

function resolveAttachment(cwd, raw) {
  let value = String(raw);
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2));
  const resolved = path.resolve(cwd, value);
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function displayRelative(cwd, file) {
  const relative = path.relative(cwd, file);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, '/');
  }
  return file;
}

function fenceFor(content) {
  const runs = String(content).match(/`{3,}/g) || [];
  const length = Math.max(3, ...runs.map((run) => run.length + 1));
  return '`'.repeat(length);
}

function languageFor(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    '.js': 'js',
    '.mjs': 'js',
    '.cjs': 'js',
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.jsx': 'jsx',
    '.json': 'json',
    '.md': 'md',
    '.css': 'css',
    '.html': 'html',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.sh': 'bash',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.toml': 'toml',
    '.sql': 'sql',
    '.xml': 'xml',
  };
  return map[ext] || '';
}

// ---------------------------------------------------------------------------
// Prompt history and completion
// ---------------------------------------------------------------------------

async function loadHistory() {
  try {
    const text = await fsp.readFile(historyPath(), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

async function saveHistory(entries) {
  const filtered = (entries || [])
    .map((entry) => String(entry).replace(/[\r\n]+/g, ' ').trim())
    .filter((entry) => entry && !/^(?:y|n|a|yes|no|always)$/i.test(entry))
    .slice(-HISTORY_LIMIT);
  if (filtered.length === 0) return;
  try {
    await ensureDir(hastyHome());
    await atomicWrite(historyPath(), `${filtered.join('\n')}\n`, 0o600);
  } catch {
    // History is a convenience; never block exit on it.
  }
}

function makeCompleter(cwd) {
  return (line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('/') && !/\s/.test(trimmed)) {
      const hits = COMMAND_NAMES.filter((name) => name.startsWith(trimmed));
      return [hits.length ? hits : COMMAND_NAMES, line];
    }

    const match = line.match(/(?:^|\s)@([^\s]*)$/);
    if (!match) return [[], line];
    const fragment = match[1];
    const sep = Math.max(fragment.lastIndexOf('/'), fragment.lastIndexOf('\\'));
    const dirTyped = sep >= 0 ? fragment.slice(0, sep + 1) : '';
    const base = sep >= 0 ? fragment.slice(sep + 1) : fragment;
    let entries;
    try {
      entries = fs.readdirSync(path.resolve(cwd, dirTyped || '.'), { withFileTypes: true });
    } catch {
      return [[], line];
    }
    const hits = entries
      .filter((entry) => entry.name.startsWith(base))
      .filter((entry) => !entry.name.startsWith('.') || base.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 60)
      .map((entry) => `@${dirTyped}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    return [hits, line];
  };
}

// ---------------------------------------------------------------------------
// Setup, doctor, and one-shot commands
// ---------------------------------------------------------------------------

async function commandSetup(args) {
  const { config } = await loadBase(args);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError('`hasty setup` needs an interactive terminal. Set keys with environment variables or edit config.json.');
  }
  const history = await loadHistory();
  const prompter = new Prompter({ history });
  try {
    const updated = await runSetup({ config, prompter });
    if (!updated) {
      process.stdout.write(`  ${theme.dim('Setup cancelled.')}\n\n`);
      process.exitCode = 1;
    }
  } finally {
    prompter.close();
    await saveHistory(prompter.getHistory());
  }
}

async function commandDoctor(args) {
  const { config, cwd } = await loadBase(args);
  const githubConnection = new GithubConnection(config);
  const pluginManager = new PluginManager({ config });
  await pluginManager.loadAll();
  const mcpManager = new McpManager({ config });
  try {
    await printDoctor({ config, cwd, githubConnection, pluginManager, mcpManager });
  } finally {
    mcpManager.closeAll();
  }
}

async function commandModels(args) {
  const { config } = await loadBase(args);
  const requested = args.positionals[0] || args.flags.provider || null;
  const name = requested ? String(requested).toLowerCase() : null;
  if (name && !PROVIDERS[name]) {
    throw new UsageError(`Unknown provider "${requested}". Choose: ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  const runtime = resolveProvider(config, name);
  if (!runtime.keyless && !runtime.apiKey) {
    throw new UsageError(`${runtime.label} has no API key. Run \`hasty setup\` or set ${PROVIDERS[runtime.name]?.env?.join(' / ') || 'HASTY_API_KEY'}.`);
  }
  if (!runtime.baseUrl) {
    throw new UsageError(`${runtime.label} has no base URL. Run \`hasty setup\`.`);
  }

  let models;
  try {
    const provider = createProvider(config, { name });
    models = await provider.listModels();
  } catch (error) {
    throw new UsageError(friendlyProviderError(error, runtime));
  }

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ provider: runtime.name, model: runtime.model, models }, null, 2)}\n`);
    return;
  }

  process.stdout.write('\n');
  process.stdout.write(`  ${theme.heading('Models')} ${theme.dim(`· ${runtime.label}`)}\n`);
  if (models.length === 0) {
    process.stdout.write(`  ${theme.dim('The provider returned no models.')}\n\n`);
    return;
  }
  for (const model of models) {
    const current = model === runtime.model ? theme.success(' ← current') : '';
    process.stdout.write(`  ${theme.primary(model)}${current}\n`);
  }
  process.stdout.write(`\n  ${theme.dim(`${models.length} model(s)`)}\n\n`);
}

async function commandConfig(args) {
  const { config } = await loadBase(args);
  const sub = (args.positionals[0] || 'show').toLowerCase();
  const key = args.positionals[1];

  if (sub === 'path') {
    process.stdout.write(`${configPath()}\n`);
    return;
  }
  if (sub === 'show' || sub === 'list') {
    if (key) return printConfigValue(config, key);
    process.stdout.write(`${JSON.stringify(redactedConfig(config), null, 2)}\n`);
    return;
  }
  if (sub === 'get') {
    if (!key) throw new UsageError('Usage: hasty config get <dotted.key>');
    return printConfigValue(config, key);
  }
  if (sub === 'set') {
    if (!key) throw new UsageError('Usage: hasty config set <dotted.key> <value>');
    const raw = args.positionals.slice(2).join(' ');
    if (raw === '' && args.positionals.length < 3) {
      throw new UsageError('Usage: hasty config set <dotted.key> <value>');
    }
    const value = parseConfigValue(key, raw);
    setConfigValue(config, key, value);
    const saved = await saveConfig(config);
    process.stdout.write(`  ${theme.success('✔')} Set ${theme.bright(key)} in ${configPath()}\n`);
    if (!process.stdout.isTTY) void saved;
    return;
  }
  throw new UsageError('Usage: hasty config [show|path|get <key>|set <key> <value>]');
}

function printConfigValue(config, key) {
  const value = getConfigValue(config, key);
  if (value === undefined) {
    process.stderr.write(`  ${theme.warn('!')} No such config key: ${key}\n`);
    process.exitCode = 1;
    return;
  }
  if (value && typeof value === 'object') {
    const redacted = redactSubtree(key, value);
    process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
  } else {
    process.stdout.write(`${redactScalar(key, value)}\n`);
  }
}

function getConfigValue(config, key) {
  return String(key).split('.').reduce((value, part) => {
    if (value == null || typeof value !== 'object') return undefined;
    return value[part];
  }, config);
}

function setConfigValue(config, key, value) {
  const parts = String(key).split('.');
  if (parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))) {
    throw new UsageError('Invalid config key.');
  }
  let target = config;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object') target[part] = {};
    target = target[part];
  }
  target[parts[parts.length - 1]] = value;
}

function parseConfigValue(key, raw) {
  if (/api.?key|token|secret|password/i.test(key)) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function redactSubtree(key, value) {
  if (/api.?key|token|secret|password/i.test(key)) return '••••';
  if (Array.isArray(value)) return value.map((entry) => redactSubtree('', entry));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      copy[childKey] = redactSubtree(childKey, childValue);
    }
    return copy;
  }
  return value;
}

function redactScalar(key, value) {
  if (/api.?key|token|secret|password/i.test(key) && value) return '••••';
  return String(value);
}

async function commandPlugins(args) {
  const { config } = await loadBase(args);
  const sub = (args.positionals[0] || 'list').toLowerCase();
  if (sub === 'path') {
    process.stdout.write(`${pluginsDir()}\n`);
    return;
  }
  if (!['list', 'reload'].includes(sub)) {
    throw new UsageError('Usage: hasty plugins [list|path]');
  }
  const manager = new PluginManager({ config });
  await manager.loadAll();

  process.stdout.write('\n');
  process.stdout.write(`  ${theme.heading('Plugins')} ${theme.dim(`(${manager.plugins.length})`)}\n`);
  if (manager.plugins.length === 0) {
    process.stdout.write(`  ${theme.dim('No plugins installed.')}\n`);
  }
  for (const plugin of manager.plugins) {
    process.stdout.write(`  ${theme.bright(plugin.name)} ${theme.dim(`— ${plugin.description || 'no description'}`)}\n`);
    process.stdout.write(`    ${theme.dim(plugin.file)}\n`);
    process.stdout.write(`    ${theme.dim(plugin.tools.map((tool) => tool.name).join(', '))}\n`);
  }
  if (manager.errors.length) {
    process.stdout.write('\n');
    for (const error of manager.errors) {
      process.stdout.write(`  ${theme.warn('!')} ${path.basename(error.file)}: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
  process.stdout.write(`\n  ${theme.dim('Directory:')} ${pluginsDir()}\n\n`);
}

async function commandMcp(args) {
  const { config } = await loadBase(args);
  const sub = (args.positionals[0] || 'status').toLowerCase();
  if (!['status', 'list', 'connect', 'reconnect'].includes(sub)) {
    throw new UsageError('Usage: hasty mcp [status|connect]');
  }
  const manager = new McpManager({ config });
  try {
    if (manager.configured === 0) {
      process.stdout.write(`  ${theme.dim('No MCP servers configured. Add them under mcpServers in')} ${configPath()}\n`);
      return;
    }
    if (sub === 'connect' || sub === 'reconnect') {
      process.stdout.write(`  ${theme.dim('Connecting MCP servers…')}\n`);
      await manager.connectAll();
    }
    process.stdout.write('\n');
    process.stdout.write(`  ${theme.heading('MCP servers')}\n`);
    for (const server of manager.serversInfo()) {
      const color = server.status === 'connected' ? theme.success : server.status === 'error' ? theme.error : theme.warn;
      process.stdout.write(
        `  ${color(server.status.padEnd(12))} ${theme.bright(server.name)} `
        + `${theme.dim(`· ${server.toolCount} tools`)}${server.error ? theme.dim(` — ${server.error}`) : ''}\n`,
      );
    }
    process.stdout.write(`\n  ${theme.dim('Config:')} ${configPath()}\n\n`);
  } finally {
    manager.closeAll();
  }
}

async function commandGithub(args) {
  const { config } = await loadBase(args);
  const sub = (args.positionals[0] || 'status').toLowerCase();

  if (sub === 'login') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new UsageError('`hasty github login` needs an interactive terminal. Set GITHUB_TOKEN, or save a token with `hasty config set github.token <token>`.');
    }
    const history = await loadHistory();
    const prompter = new Prompter({ history });
    try {
      const ok = await runGithubLogin({ config, prompter });
      if (!ok) process.exitCode = 1;
    } finally {
      prompter.close();
      await saveHistory(prompter.getHistory());
    }
    return;
  }

  if (sub === 'logout') {
    if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
      process.stdout.write(`  ${theme.warn('!')} GITHUB_TOKEN or GH_TOKEN is set in the environment and will keep GitHub connected.\n`);
    }
    config.github = { ...(config.github || {}), token: '' };
    await saveConfig(config);
    process.stdout.write(`  ${theme.success('✔')} Removed the stored GitHub token.\n`);
    if (ghCliToken()) {
      process.stdout.write(`  ${theme.dim('The gh CLI is still authenticated; run `gh auth logout` to remove that token too.')}\n`);
    }
    return;
  }

  if (sub !== 'status') throw new UsageError('Usage: hasty github [status|login|logout]');

  const connection = new GithubConnection(config);
  process.stdout.write('\n');
  if (!connection.connected) {
    process.stdout.write(`  ${theme.warn('GitHub: not connected')}\n`);
    process.stdout.write(`  ${theme.dim('Run `hasty github login`, set GITHUB_TOKEN, or install/auth the gh CLI.')}\n\n`);
    return;
  }
  process.stdout.write(`  ${theme.dim('GitHub: connected')} ${theme.dim(`via ${connection.auth.source}`)}\n`);
  const user = await connection.whoami();
  if (user) {
    process.stdout.write(`  ${theme.dim('account:')} @${user.login}${user.name ? ` (${user.name})` : ''}\n`);
    if (user.public_repos != null) process.stdout.write(`  ${theme.dim('repos:')} ${user.public_repos} public\n`);
  } else {
    process.stdout.write(`  ${theme.warn('Token is configured but the API check failed:')} ${connection.lastError || 'unknown error'}\n`);
    process.exitCode = 1;
  }
  process.stdout.write('\n');
}

async function commandSessions(args) {
  const { cwd } = await loadBase(args);
  const sessions = await listSessions({ cwd, limit: 50 });
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ cwd, sessions }, null, 2)}\n`);
    return;
  }
  process.stdout.write('\n');
  if (sessions.length === 0) {
    process.stdout.write(`  ${theme.dim('No saved sessions for this directory.')}\n\n`);
    return;
  }
  process.stdout.write(`  ${theme.heading('Recent sessions')} ${theme.dim(`(${cwd})`)}\n`);
  sessions.forEach((session, index) => {
    const when = new Date(session.updatedAt).toLocaleString();
    process.stdout.write(`  ${theme.primary(`${index + 1})`.padEnd(4))} ${theme.bright(session.id)}\n`);
    process.stdout.write(
      `      ${theme.text(session.title)} ${theme.dim(`· ${session.messageCount} msgs · ${when}`)}\n`,
    );
  });
  process.stdout.write(`\n  ${theme.dim('Resume with:')} hasty resume <id>\n\n`);
}

async function commandResume(args) {
  const id = args.positionals[0];
  if (!id) throw new UsageError('Usage: hasty resume <session-id> [prompt]');
  args.flags.resume = id;
  args.positionals = args.positionals.slice(1);
  args.command = null;
  await runCli(args);
}

async function printDoctor(state) {
  const write = (line = '') => process.stdout.write(`${line}\n`);
  const row = (symbol, label, detail, color = theme.text) => {
    write(`  ${color(symbol)} ${theme.text(label.padEnd(22))}${theme.dim(detail)}`);
  };
  let failures = 0;
  const ok = (label, detail) => row(SYMBOLS.check, label, detail, theme.success);
  const warn = (label, detail) => row('!', label, detail, theme.warn);
  const bad = (label, detail) => {
    failures += 1;
    row(SYMBOLS.cross, label, detail, theme.error);
  };

  write();
  write(`  ${theme.heading('Hasty doctor')}`);
  write();

  if (versionAtLeast(process.versions.node, MIN_NODE)) ok('node', `${process.versions.node} (need >= ${MIN_NODE})`);
  else bad('node', `${process.versions.node} is too old; need >= ${MIN_NODE}`);
  row(SYMBOLS.dot, 'platform', `${process.platform} ${process.arch} · ${os.type()} ${os.release()}`);
  row(SYMBOLS.dot, 'terminal', process.stdout.isTTY ? `interactive · ${process.stdout.columns || 80} cols` : 'piped / non-interactive');
  row(SYMBOLS.dot, 'hasty home', hastyHome());

  try {
    ensureDirSync(hastyHome(), 0o700);
    fs.accessSync(hastyHome(), fs.constants.W_OK);
    ok('config directory', 'writable');
  } catch (error) {
    bad('config directory', error.message);
  }
  if (fs.existsSync(configPath())) ok('config file', configPath());
  else warn('config file', `${configPath()} not created yet (using defaults)`);

  const info = describeProvider(state.config);
  if (!info.baseUrl) bad('provider', `${info.label}: no base URL; run \`hasty setup\``);
  else if (!info.model) bad('model', `${info.label}: no model selected`);
  else row(SYMBOLS.dot, 'provider', `${info.label} · ${info.model} · ${info.type}`);
  if (info.keyless) {
    ok('api key', 'local / keyless');
  } else if (info.apiKey) {
    ok('api key', `${info.keySource} · ${info.keyPreview}`);
  } else {
    bad('api key', `missing for ${info.label}`);
  }

  const shell = resolveShell(state.config);
  const shellExists = path.isAbsolute(shell.binary)
    ? fs.existsSync(shell.binary)
    : commandExists(shell.binary);
  if (shellExists) ok('shell', `${shell.label} · ${shell.binary}`);
  else bad('shell', `${shell.label} not found at ${shell.binary}`);

  const git = gitInfo(state.cwd);
  if (git) row(SYMBOLS.dot, 'git', `${git.branch || 'detached'}${git.changed ? ` · ${git.changed} changed` : ' · clean'}`);
  else warn('git', 'not a repository (optional)');

  const github = state.githubConnection || new GithubConnection(state.config);
  if (!github.connected) {
    warn('github', 'not connected (optional)');
  } else {
    const user = await github.whoami();
    if (user) ok('github', `@${user.login} via ${github.auth.source}`);
    else warn('github', `token found via ${github.auth.source}, but the API check failed: ${github.lastError || 'unknown'}`);
  }

  const plugins = state.pluginManager;
  if (!plugins) {
    warn('plugins', 'disabled for this run');
  } else if (plugins.errors.length > 0) {
    bad('plugins', `${plugins.plugins.length} loaded, ${plugins.errors.length} failed to load`);
  } else {
    ok('plugins', `${plugins.plugins.length} loaded · ${plugins.tools.length} tools`);
  }

  const mcp = state.mcpManager;
  if (!mcp) {
    warn('mcp', 'disabled for this run');
  } else if (mcp.configured === 0) {
    row(SYMBOLS.dot, 'mcp', 'none configured');
  } else {
    const connected = mcp.serversInfo().filter((server) => server.status === 'connected').length;
    row(SYMBOLS.dot, 'mcp', `${mcp.configured} configured · ${connected} connected · ${mcp.getTools().length} tools`);
  }

  try {
    ensureDirSync(sessionsDir(), 0o700);
    fs.accessSync(sessionsDir(), fs.constants.W_OK);
    ok('sessions directory', 'writable');
  } catch (error) {
    bad('sessions directory', error.message);
  }

  write();
  if (failures > 0) {
    write(`  ${theme.error(`${failures} check${failures === 1 ? '' : 's'} failed.`)}`);
  } else {
    write(`  ${theme.success('Core checks passed.')}`);
  }
  write(`  ${theme.dim('Tip: run `hasty models` to verify provider connectivity.')}`);
  write();
  if (failures > 0) process.exitCode = 1;
}

function versionAtLeast(current, required) {
  const a = String(current).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(required).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] || 0;
    const right = b[index] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  const write = (line = '') => process.stdout.write(`${line}\n`);
  write();
  write(`  ${theme.brand('Hasty')} ${theme.dim('— terminal coding agent · bring your own key')}`);
  write();
  write(`  ${theme.heading('Usage')}`);
  write(`    ${theme.bright('hasty')} ${theme.dim('[options] [prompt]')}`);
  write(`    ${theme.bright('hasty')} ${theme.dim('-p "prompt"')}`);
  write(`    ${theme.bright('hasty')} ${theme.dim('<command> [args]')}`);
  write();
  write(`  ${theme.heading('Commands')}`);
  const commands = [
    ['setup', 'Configure provider, API key, model, GitHub, approvals'],
    ['doctor', 'Environment and configuration diagnostics'],
    ['models [provider]', 'List models available to your key'],
    ['config [show|path|get|set]', 'Inspect or change configuration'],
    ['plugins [list|path]', 'List installed plugins'],
    ['mcp [status|connect]', 'Show or connect MCP servers'],
    ['github [status|login|logout]', 'GitHub connection'],
    ['sessions', 'List saved sessions for this directory'],
    ['resume <id>', 'Resume a saved session'],
  ];
  const width = Math.max(...commands.map(([name]) => name.length)) + 3;
  for (const [name, description] of commands) {
    write(`    ${theme.primary(name.padEnd(width))}${theme.dim(description)}`);
  }
  write();
  write(`  ${theme.heading('Options')}`);
  const options = [
    ['-p, --print <text>', 'One-shot: print the final response and exit'],
    ['--json', 'One-shot JSONL event stream'],
    ['-m, --model <name>', 'Override the model for this run'],
    ['--provider <name>', `Override the provider (${Object.keys(PROVIDERS).join(', ')})`],
    ['--mode <mode>', 'Approval mode: ask, auto, or yolo'],
    ['-y, --yes', 'Approve everything for this run (yolo)'],
    ['-c, --continue', 'Resume the latest session in this directory'],
    ['-r, --resume <id>', 'Resume a session by id'],
    ['--cwd <dir>', 'Work in another directory'],
    ['--temperature <n>', 'Override temperature (0-2)'],
    ['--max-steps <n>', 'Maximum model/tool steps per turn (1-200)'],
    ['--no-mcp', 'Do not start configured MCP servers'],
    ['--no-plugins', 'Do not load plugins'],
    ['-q, --quiet', 'Less activity output in print mode'],
    ['--no-color', 'Disable color'],
    ['--no-banner', 'Hide the startup banner'],
    ['-h, --help', 'Show this help'],
    ['-v, --version', 'Print the version'],
  ];
  const optionWidth = Math.max(...options.map(([name]) => name.length)) + 3;
  for (const [name, description] of options) {
    write(`    ${theme.accent(name.padEnd(optionWidth))}${theme.dim(description)}`);
  }
  write();
  write(`  ${theme.heading('In the REPL')}`);
  write(`    ${theme.primary('/help'.padEnd(optionWidth))}${theme.dim('Commands and shortcuts')}`);
  write(`    ${theme.primary('@file'.padEnd(optionWidth))}${theme.dim('Attach a file to your message')}`);
  write(`    ${theme.primary('!command'.padEnd(optionWidth))}${theme.dim('Run a shell command directly')}`);
  write(`    ${theme.primary('Ctrl+C'.padEnd(optionWidth))}${theme.dim('Cancel the current request')}`);
  write();
  write(`  ${theme.dim(`v${VERSION} · configuration: ${configPath()}`)}`);
  write();
}

// Keep the imported help table reachable for tests and future command pickers.
export { COMMANDS, VERSION, parseArgs };
